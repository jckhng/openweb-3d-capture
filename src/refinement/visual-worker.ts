import {
  extractBriefFeatures,
  extractImageFeatures,
  matchImageFeatures,
  matchScaleInvariantFeatures,
  resizeGray,
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

const CAPTURE_MAXIMUM_DIMENSION = 480;
const DEFERRED_MAXIMUM_DIMENSION = 720;
const MAXIMUM_FEATURES = 450;
const MAXIMUM_DEFERRED_FEATURES = 600;
const DEFERRED_MATCH_RATIO = 0.84;
const MAXIMUM_RETAINED_FRAMES = 160;
const MINIMUM_LOOP_SEPARATION = 48;
const MAXIMUM_REPAIR_ATTEMPTS = 96;

interface TrackedFrame {
  id: number;
  sourceWidth: number;
  sourceHeight: number;
  intrinsics: Intrinsics;
  cameraToWorld: Matrix4;
  briefWidth: number;
  briefHeight: number;
  repairImage: GrayImage;
  briefFeatures: ImageFeature[];
  strongFeatures?: ImageFeature[];
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
let capturePhaseTotalMilliseconds = 0;
let capturePhaseMaximumFrameMilliseconds = 0;
let deferredRefinementMilliseconds = 0;
let processingPhase: "capture" | "deferred" | "complete" = "capture";
let deferredRepairAttempts = 0;

scope.onmessage = (event) => {
  queue = queue.then(async () => {
    if (event.data.type === "reset") {
      graph = new VisualConnectivityGraph();
      retained = [];
      calibrationObservations = [];
      attemptedPairs = new Set();
      capturePhaseTotalMilliseconds = 0;
      capturePhaseMaximumFrameMilliseconds = 0;
      deferredRefinementMilliseconds = 0;
      processingPhase = "capture";
      deferredRepairAttempts = 0;
      scope.postMessage({ type: "update", report: reportWithProcessing() });
      return;
    }
    if (event.data.type === "track") {
      await trackFrame(event.data.frame);
      scope.postMessage({ type: "update", report: reportWithProcessing() });
      return;
    }
    const deferredStarted = performance.now();
    processingPhase = "deferred";
    scope.postMessage({ type: "update", report: reportWithProcessing() });
    addDeferredLoopEdges();
    deferredRefinementMilliseconds = performance.now() - deferredStarted;
    scope.postMessage({ type: "update", report: reportWithProcessing() });
    repairDisconnectedGraph(deferredStarted);
    deferredRefinementMilliseconds = performance.now() - deferredStarted;
    processingPhase = "complete";
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
  const started = performance.now();
  graph.addFrame(input.id);
  const repairImage = await decodeGray(
    input.image,
    input.width,
    input.height,
    DEFERRED_MAXIMUM_DIMENSION,
  );
  const briefImage = resizeGray(repairImage, CAPTURE_MAXIMUM_DIMENSION);
  const frame: TrackedFrame = {
    id: input.id,
    sourceWidth: input.width,
    sourceHeight: input.height,
    intrinsics: input.intrinsics,
    cameraToWorld: input.cameraToWorld,
    briefWidth: briefImage.width,
    briefHeight: briefImage.height,
    repairImage,
    briefFeatures: extractBriefFeatures(briefImage, {
      maximumFeatures: MAXIMUM_FEATURES,
      fastThreshold: 18,
      cellSize: 12,
    }),
  };

  const previous = retained.at(-1);
  if (previous) {
    graph.addEdge(matchEdge(previous, frame, "adjacent", "brief"));
  }

  retained.push(frame);
  if (retained.length > MAXIMUM_RETAINED_FRAMES) retained.shift();
  const elapsed = performance.now() - started;
  capturePhaseTotalMilliseconds += elapsed;
  capturePhaseMaximumFrameMilliseconds = Math.max(capturePhaseMaximumFrameMilliseconds, elapsed);
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
  const featuresA = matcher === "gradient" ? strongFeatures(a) : a.briefFeatures;
  const featuresB = matcher === "gradient" ? strongFeatures(b) : b.briefFeatures;
  const matches = matcher === "gradient"
    ? matchScaleInvariantFeatures(featuresA, featuresB, DEFERRED_MATCH_RATIO)
    : matchImageFeatures(featuresA, featuresB);
  const pointMatches = matches.map((match) => ({
    pointA: sourcePoint(featuresA[match.featureA], a),
    pointB: sourcePoint(featuresB[match.featureB], b),
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
  const report = reportWithProcessing();
  if (report.readyForCalibration) {
    report.calibrationEstimate = estimateSharedCalibration(calibrationObservations);
  }
  return report;
}

function reportWithProcessing() {
  const report = graph.report();
  report.processing = {
    capturePhaseFrames: report.frameCount,
    capturePhaseTotalMilliseconds,
    capturePhaseMaximumFrameMilliseconds,
    deferredRefinementMilliseconds,
    retainedGrayBytes: retained.reduce((sum, frame) => sum + frame.repairImage.data.byteLength, 0),
    captureMaximumDimension: CAPTURE_MAXIMUM_DIMENSION,
    deferredMaximumDimension: DEFERRED_MAXIMUM_DIMENSION,
    deferredMaximumFeatures: MAXIMUM_DEFERRED_FEATURES,
    deferredMatchRatio: DEFERRED_MATCH_RATIO,
    phase: processingPhase,
    deferredRepairAttempts,
    deferredMaximumRepairAttempts: MAXIMUM_REPAIR_ATTEMPTS,
  };
  return report;
}

function strongFeatures(frame: TrackedFrame): ImageFeature[] {
  frame.strongFeatures ??= extractImageFeatures(frame.repairImage, {
    maximumFeatures: MAXIMUM_DEFERRED_FEATURES,
    fastThreshold: 18,
    cellSize: 12,
  });
  return frame.strongFeatures;
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

function addDeferredLoopEdges(): void {
  for (let index = 0; index < retained.length; index += 1) {
    const frame = retained[index];
    if (frame.id < MINIMUM_LOOP_SEPARATION || frame.id % 8 !== 0) continue;
    for (const candidate of loopCandidates(frame, retained.slice(0, index), 2)) {
      graph.addEdge(addStrongEdge(candidate, frame, "loop"));
    }
  }
}

function repairDisconnectedGraph(deferredStarted: number): void {
  if (graph.componentCount() <= 1) return;
  const distanceLimit = overlapDistanceLimit(retained);
  const candidates: Array<{ a: TrackedFrame; b: TrackedFrame; kind: VisualTrackingEdge["kind"]; score: number }> = [];
  for (let indexA = 0; indexA < retained.length; indexA += 1) {
    for (let indexB = indexA + 1; indexB < retained.length; indexB += 1) {
      const a = retained[indexA];
      const b = retained[indexB];
      if (attemptedPairs.has(pairKey(a.id, b.id))) continue;
      const separation = Math.abs(a.id - b.id);
      const isLoop = separation >= MINIMUM_LOOP_SEPARATION;
      const overlap = overlapCost(
        a,
        b,
        isLoop ? 0.65 : 0.35,
        isLoop ? distanceLimit : distanceLimit * 0.75,
      );
      if (Number.isFinite(overlap)) {
        candidates.push({
          a,
          b,
          kind: isLoop ? "loop" : "recovery",
          score: recoveryTier(separation) * 10 + overlap,
        });
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
    deferredRepairAttempts = attempts;
    if (attempts % 8 === 0) {
      deferredRefinementMilliseconds = performance.now() - deferredStarted;
      scope.postMessage({ type: "update", report: reportWithProcessing() });
    }
  }
}

function recoveryTier(separation: number): number {
  if (separation === 1) return 0;
  if (separation <= 8) return 1;
  if (separation < MINIMUM_LOOP_SEPARATION) return 2;
  return 3;
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
    feature.x * frame.sourceWidth / (feature.gradientDescriptor ? frame.repairImage.width : frame.briefWidth),
    feature.y * frame.sourceHeight / (feature.gradientDescriptor ? frame.repairImage.height : frame.briefHeight),
  ];
}

async function decodeGray(
  blob: Blob,
  sourceWidth: number,
  sourceHeight: number,
  maximumDimension: number,
): Promise<GrayImage> {
  const scale = Math.min(1, maximumDimension / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(17, Math.round(sourceWidth * scale));
  const height = Math.max(17, Math.round(sourceHeight * scale));
  const bitmap = await createImageBitmap(blob, {
    resizeWidth: width,
    resizeHeight: height,
    resizeQuality: "high",
  });
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
