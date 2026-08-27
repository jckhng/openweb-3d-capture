import {
  extractImageFeatures,
  matchImageFeatures,
  matchScaleInvariantFeatures,
  type GrayImage,
  type ImageFeature,
} from "./features";
import {
  estimateSharedCalibration,
  type CalibrationObservation,
} from "./calibration-estimator";
import { verifyFeatureGeometry } from "./geometric-verification";
import { scoreEpipolarConsistency } from "./reprojection";
import { VisualConnectivityGraph } from "./visual-graph";
import type {
  VisualTrackingFrameInput,
  VisualWorkerRequest,
  VisualWorkerResponse,
} from "./worker-protocol";
import type { Intrinsics, Matrix4, VisualTrackingEdge } from "../shared/types";

const MAXIMUM_DIMENSION = 480;
const MAXIMUM_FEATURES = 450;
const MAXIMUM_RETAINED_FRAMES = 160;
const MINIMUM_LOOP_SEPARATION = 48;
const MAXIMUM_REPAIR_ATTEMPTS = 48;

interface TrackedFrame {
  id: number;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  intrinsics: Intrinsics;
  cameraToWorld: Matrix4;
  features: ImageFeature[];
}

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<VisualWorkerRequest>) => void) | null;
  postMessage(message: VisualWorkerResponse): void;
};
let graph = new VisualConnectivityGraph();
let retained: TrackedFrame[] = [];
let calibrationObservations: CalibrationObservation[] = [];
let attemptedPairs = new Set<string>();
let queue = Promise.resolve();

scope.onmessage = (event) => {
  queue = queue.then(async () => {
    if (event.data.type === "reset") {
      graph = new VisualConnectivityGraph();
      retained = [];
      calibrationObservations = [];
      attemptedPairs = new Set();
      scope.postMessage({ type: "update", report: graph.report() });
      return;
    }
    if (event.data.type === "track") {
      await trackFrame(event.data.frame);
      scope.postMessage({ type: "update", report: graph.report() });
      return;
    }
    repairDisconnectedGraph();
    scope.postMessage({
      type: "finished",
      requestId: event.data.requestId,
      report: finalReport(),
    });
  }).catch((error: unknown) => {
    scope.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : "visual worker failed",
    });
  });
};

async function trackFrame(input: VisualTrackingFrameInput): Promise<void> {
  graph.addFrame(input.id);
  const image = await decodeGray(input.image, input.width, input.height);
  const frame: TrackedFrame = {
    id: input.id,
    width: image.width,
    height: image.height,
    sourceWidth: input.width,
    sourceHeight: input.height,
    intrinsics: input.intrinsics,
    cameraToWorld: input.cameraToWorld,
    features: extractImageFeatures(image, {
      maximumFeatures: MAXIMUM_FEATURES,
      fastThreshold: 18,
      cellSize: 12,
    }),
  };

  const previous = retained.at(-1);
  if (previous) {
    let adjacent = matchEdge(previous, frame, "adjacent", "brief");
    graph.addEdge(adjacent);
    if (!adjacent.accepted) {
      adjacent = addStrongEdge(previous, frame, "adjacent");
      graph.addEdge(adjacent);
      if (!adjacent.accepted) {
        for (const offset of [2, 4]) {
          const recovery = retained.at(-offset);
          if (recovery) graph.addEdge(addStrongEdge(recovery, frame, "recovery"));
        }
      }
    }
  }

  if (input.id >= MINIMUM_LOOP_SEPARATION && input.id % 8 === 0) {
    for (const candidate of loopCandidates(frame, retained, 2)) {
      graph.addEdge(addStrongEdge(candidate, frame, "loop"));
    }
  }

  retained.push(frame);
  if (retained.length > MAXIMUM_RETAINED_FRAMES) retained.shift();
}

function addStrongEdge(a: TrackedFrame, b: TrackedFrame, kind: VisualTrackingEdge["kind"]): VisualTrackingEdge {
  attemptedPairs.add(pairKey(a.id, b.id));
  return matchEdge(a, b, kind, "gradient");
}

function matchEdge(
  a: TrackedFrame,
  b: TrackedFrame,
  kind: VisualTrackingEdge["kind"],
  matcher: NonNullable<VisualTrackingEdge["matcher"]>,
): VisualTrackingEdge {
  const matches = matcher === "gradient"
    ? matchScaleInvariantFeatures(a.features, b.features)
    : matchImageFeatures(a.features, b.features);
  const pointMatches = matches.map((match) => ({
    pointA: sourcePoint(a.features[match.featureA], a),
    pointB: sourcePoint(b.features[match.featureB], b),
  }));
  const geometry = verifyFeatureGeometry(pointMatches, a.sourceWidth, a.sourceHeight);
  const inlierMatches = geometry.inlierIndices.map((index) => pointMatches[index]);
  const score = scoreEpipolarConsistency(
    inlierMatches.length ? inlierMatches : pointMatches,
    a.cameraToWorld,
    b.cameraToWorld,
    a.intrinsics,
  );
  if (geometry.accepted) {
    calibrationObservations.push({
      matches: boundedMatches(inlierMatches, 64),
      cameraToWorldA: a.cameraToWorld,
      cameraToWorldB: b.cameraToWorld,
      intrinsics: a.intrinsics,
    });
    if (calibrationObservations.length > 120) calibrationObservations.shift();
  }
  return {
    frameA: a.id,
    frameB: b.id,
    kind,
    matcher,
    matches: matches.length,
    geometricInliers: geometry.inliers,
    geometricInlierRatio: geometry.inlierRatio,
    medianResidualPixels: score.medianPixels,
    p90ResidualPixels: score.p90Pixels,
    accepted: geometry.accepted,
  };
}

function finalReport() {
  const report = graph.report();
  if (report.readyForCalibration) {
    report.calibrationEstimate = estimateSharedCalibration(calibrationObservations);
  }
  return report;
}

function boundedMatches<T>(values: T[], maximum: number): T[] {
  if (values.length <= maximum) return values;
  const stride = values.length / maximum;
  return Array.from({ length: maximum }, (_, index) => values[Math.floor(index * stride)]);
}

function loopCandidates(frame: TrackedFrame, candidates: TrackedFrame[], maximum: number): TrackedFrame[] {
  const maximumDistance = overlapDistanceLimit([...candidates, frame]);
  return candidates
    .filter((candidate) => frame.id - candidate.id >= MINIMUM_LOOP_SEPARATION)
    .filter((candidate) => !attemptedPairs.has(pairKey(candidate.id, frame.id)))
    .map((candidate) => ({ candidate, score: overlapCost(frame, candidate, 0.65, maximumDistance) }))
    .filter(({ score }) => Number.isFinite(score))
    .sort((a, b) => a.score - b.score)
    .slice(0, maximum)
    .map(({ candidate }) => candidate);
}

function repairDisconnectedGraph(): void {
  if (graph.componentCount() <= 1) return;
  const distanceLimit = overlapDistanceLimit(retained);
  const candidates: Array<{ a: TrackedFrame; b: TrackedFrame; kind: VisualTrackingEdge["kind"]; score: number }> = [];
  for (let indexA = 0; indexA < retained.length; indexA += 1) {
    for (let indexB = indexA + 1; indexB < retained.length; indexB += 1) {
      const a = retained[indexA];
      const b = retained[indexB];
      if (attemptedPairs.has(pairKey(a.id, b.id))) continue;
      const separation = Math.abs(a.id - b.id);
      const isRecovery = separation <= 8;
      const isLoop = separation >= MINIMUM_LOOP_SEPARATION;
      if (!isRecovery && !isLoop) continue;
      const score = overlapCost(
        a,
        b,
        isLoop ? 0.65 : 0.35,
        isLoop ? distanceLimit : distanceLimit * 0.75,
      );
      if (Number.isFinite(score)) {
        candidates.push({ a, b, kind: isLoop ? "loop" : "recovery", score });
      }
    }
  }
  candidates.sort((first, second) => first.score - second.score);
  let attempts = 0;
  for (const candidate of candidates) {
    if (graph.componentCount() <= 1 || attempts >= MAXIMUM_REPAIR_ATTEMPTS) break;
    if (graph.areConnected(candidate.a.id, candidate.b.id)) continue;
    graph.addEdge(addStrongEdge(candidate.a, candidate.b, candidate.kind));
    attempts += 1;
  }
}

function overlapCost(
  a: TrackedFrame,
  b: TrackedFrame,
  minimumDirectionAgreement: number,
  maximumDistance: number,
): number {
  const directionA = forward(a.cameraToWorld);
  const directionB = forward(b.cameraToWorld);
  const directionAgreement = dot(directionA, directionB);
  if (directionAgreement < minimumDirectionAgreement) return Number.POSITIVE_INFINITY;
  const distance = Math.hypot(
    a.cameraToWorld[0][3] - b.cameraToWorld[0][3],
    a.cameraToWorld[1][3] - b.cameraToWorld[1][3],
    a.cameraToWorld[2][3] - b.cameraToWorld[2][3],
  );
  if (distance > maximumDistance) return Number.POSITIVE_INFINITY;
  return distance + (1 - directionAgreement) * 0.5;
}

function overlapDistanceLimit(frames: TrackedFrame[]): number {
  const baselines: number[] = [];
  for (let index = 1; index < frames.length; index += 1) {
    const a = frames[index - 1].cameraToWorld;
    const b = frames[index].cameraToWorld;
    baselines.push(Math.hypot(
      a[0][3] - b[0][3],
      a[1][3] - b[1][3],
      a[2][3] - b[2][3],
    ));
  }
  baselines.sort((a, b) => a - b);
  const medianBaseline = baselines.length ? baselines[Math.floor(baselines.length / 2)] : 0;
  return Math.min(1, Math.max(0.2, medianBaseline * 12));
}

function pairKey(frameA: number, frameB: number): string {
  return frameA < frameB ? `${frameA}:${frameB}` : `${frameB}:${frameA}`;
}

function forward(matrix: Matrix4): [number, number, number] {
  return [-matrix[0][2], -matrix[1][2], -matrix[2][2]];
}

function dot(a: [number, number, number], b: [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function sourcePoint(feature: ImageFeature, frame: TrackedFrame): [number, number] {
  return [
    feature.x * frame.sourceWidth / frame.width,
    feature.y * frame.sourceHeight / frame.height,
  ];
}

async function decodeGray(blob: Blob, sourceWidth: number, sourceHeight: number): Promise<GrayImage> {
  const scale = Math.min(1, MAXIMUM_DIMENSION / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(17, Math.round(sourceWidth * scale));
  const height = Math.max(17, Math.round(sourceHeight * scale));
  const bitmap = await createImageBitmap(blob, { resizeWidth: width, resizeHeight: height });
  try {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("2D OffscreenCanvas is unavailable");
    context.drawImage(bitmap, 0, 0, width, height);
    const rgba = context.getImageData(0, 0, width, height).data;
    const data = new Uint8Array(width * height);
    for (let pixel = 0, offset = 0; pixel < data.length; pixel += 1, offset += 4) {
      data[pixel] = Math.round(0.2126 * rgba[offset] + 0.7152 * rgba[offset + 1] + 0.0722 * rgba[offset + 2]);
    }
    return { width, height, data };
  } finally {
    bitmap.close();
  }
}
