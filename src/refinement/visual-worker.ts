import { extractImageFeatures, matchImageFeatures, type GrayImage, type ImageFeature } from "./features";
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
let queue = Promise.resolve();

scope.onmessage = (event) => {
  queue = queue.then(async () => {
    if (event.data.type === "reset") {
      graph = new VisualConnectivityGraph();
      retained = [];
      calibrationObservations = [];
      scope.postMessage({ type: "update", report: graph.report() });
      return;
    }
    if (event.data.type === "track") {
      await trackFrame(event.data.frame);
      scope.postMessage({ type: "update", report: graph.report() });
      return;
    }
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
    const adjacent = matchEdge(previous, frame, "adjacent");
    graph.addEdge(adjacent);
    if (!adjacent.accepted) {
      for (const offset of [2, 4]) {
        const recovery = retained.at(-offset);
        if (recovery) graph.addEdge(matchEdge(recovery, frame, "recovery"));
      }
    }
  }

  if (input.id > 0 && input.id % 8 === 0) {
    for (const candidate of loopCandidates(frame, retained, 2)) {
      graph.addEdge(matchEdge(candidate, frame, "loop"));
    }
  }

  retained.push(frame);
  if (retained.length > MAXIMUM_RETAINED_FRAMES) retained.shift();
}

function matchEdge(a: TrackedFrame, b: TrackedFrame, kind: VisualTrackingEdge["kind"]): VisualTrackingEdge {
  const matches = matchImageFeatures(a.features, b.features);
  const pointMatches = matches.map((match) => ({
    pointA: sourcePoint(a.features[match.featureA], a),
    pointB: sourcePoint(b.features[match.featureB], b),
  }));
  const score = scoreEpipolarConsistency(
    pointMatches,
    a.cameraToWorld,
    b.cameraToWorld,
    a.intrinsics,
  );
  const geometry = verifyFeatureGeometry(pointMatches, a.sourceWidth, a.sourceHeight);
  if (geometry.accepted) {
    calibrationObservations.push({
      matches: boundedMatches(pointMatches, 64),
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
  return candidates
    .filter((candidate) => frame.id - candidate.id >= 16)
    .map((candidate) => ({ candidate, score: overlapCost(frame, candidate) }))
    .filter(({ score }) => Number.isFinite(score))
    .sort((a, b) => a.score - b.score)
    .slice(0, maximum)
    .map(({ candidate }) => candidate);
}

function overlapCost(a: TrackedFrame, b: TrackedFrame): number {
  const directionA = forward(a.cameraToWorld);
  const directionB = forward(b.cameraToWorld);
  const directionAgreement = dot(directionA, directionB);
  if (directionAgreement < 0.5) return Number.POSITIVE_INFINITY;
  const distance = Math.hypot(
    a.cameraToWorld[0][3] - b.cameraToWorld[0][3],
    a.cameraToWorld[1][3] - b.cameraToWorld[1][3],
    a.cameraToWorld[2][3] - b.cameraToWorld[2][3],
  );
  return distance + (1 - directionAgreement) * 0.5;
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
