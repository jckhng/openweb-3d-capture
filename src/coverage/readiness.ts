import { isFiniteMatrix, poseTranslationDistance, rotationAngleDifference, translationOf } from "../shared/matrix";
import type {
  CaptureCoverageCell,
  CaptureCoverageLatitude,
  CaptureDecision,
  CaptureFrame,
  CaptureReadinessIssue,
  CaptureReadinessReport,
  CaptureReadinessSummary,
  Matrix4,
  VisualTrackingReport,
} from "../shared/types";

const AZIMUTH_BIN_COUNT = 12;
const MINIMUM_IMAGE_FRAMES = 50;
const MINIMUM_SHARPNESS = 0.38;
const MINIMUM_ADJACENT_EDGE_COVERAGE = 0.8;
const MINIMUM_ELEVATION_SPAN_DEGREES = 20;
const MINIMUM_FRAMES_FOR_VISUAL_CHECK = 12;
const MAXIMUM_LOOP_ROTATION_RADIANS = 25 * Math.PI / 180;
const MAXIMUM_CHECKPOINT_MOTION_SCORE = 0.55;
const CHECKPOINT_BURST_SAMPLES = 2;
export const MAXIMUM_SELECTED_FRAMES_PER_CELL = 10;

const COVERAGE_LATITUDE_BANDS: ReadonlyArray<{
  latitude: CaptureCoverageLatitude;
  minimumDegrees: number;
  maximumDegrees: number;
  requiredStride: number;
}> = [
  { latitude: "low", minimumDegrees: -20, maximumDegrees: 5, requiredStride: 2 },
  { latitude: "level", minimumDegrees: 5, maximumDegrees: 35, requiredStride: 1 },
  { latitude: "raised", minimumDegrees: 35, maximumDegrees: 60, requiredStride: 2 },
  { latitude: "high", minimumDegrees: 60, maximumDegrees: 90, requiredStride: 12 },
];

type ElevationBand = "low" | "level" | "high";

export interface CaptureReadinessInput {
  frames: readonly CaptureFrame[];
  decisions?: readonly CaptureDecision[];
  visualTracking?: VisualTrackingReport;
  targetEstimate?: [number, number, number];
}

export function analyzeCaptureReadiness(
  input: CaptureReadinessInput,
  generatedAt = new Date(),
): CaptureReadinessReport {
  const frames = input.frames.filter((frame) => isFiniteMatrix(frame.cameraToWorld));
  const imageFrames = frames.filter((frame) => Boolean(frame.imagePath));
  const synchronizedImageFrames = imageFrames.filter((frame) => frame.imageSynchronized === true);
  const sharpnessValues = acceptedSharpness(input.decisions ?? [], imageFrames);
  const targetEstimate = input.targetEstimate ?? estimateTarget(imageFrames);
  const coverage = analyzeCoverage(imageFrames, targetEstimate);
  const visual = analyzeVisualTracking(imageFrames, input.visualTracking);
  const physicalLoopClosed = isPhysicalLoopClosed(imageFrames, targetEstimate);
  const loopClosureDetected = visual.loopClosureDetected;
  const issues: CaptureReadinessIssue[] = [];
  const completedCheckpoints = coverage.cells.filter(
    (cell) => cell.required && cell.state === "captured",
  ).length;
  const requiredCheckpoints = coverage.cells.filter((cell) => cell.required).length;

  if (imageFrames.length < MINIMUM_IMAGE_FRAMES) {
    const remaining = MINIMUM_IMAGE_FRAMES - imageFrames.length;
    issues.push({
      code: "insufficient-frames",
      severity: "repair",
      message: imageFrames.length + " of " + MINIMUM_IMAGE_FRAMES + " recommended images captured.",
      action: "Continue the orbit and capture " + remaining + " more distinct views.",
    });
  }

  const missingImages = frames.length - imageFrames.length;
  if (missingImages > 0) {
    issues.push({
      code: "missing-images",
      severity: "risk",
      message: missingImages + " accepted frames have no reconstruction image.",
      action: "Continue capturing until every required viewpoint has a camera image.",
    });
  }

  if (synchronizedImageFrames.length < imageFrames.length) {
    const unsynchronized = imageFrames.length - synchronizedImageFrames.length;
    issues.push({
      code: "unsynchronized-images",
      severity: "risk",
      message: unsynchronized + " images are not synchronized to their WebXR poses.",
      action: "Use the XR camera stream for the capture, or rely on downstream SfM for all poses.",
    });
  }

  if (completedCheckpoints < requiredCheckpoints) {
    const missing = requiredCheckpoints - completedCheckpoints;
    issues.push({
      code: "missing-coverage-checkpoints",
      severity: "repair",
      message: `${missing} of ${requiredCheckpoints} required viewpoint cells still need a sharp stationary burst.`,
      action: "Move to the highlighted unlit cell, stop, and hold until it turns orange.",
    });
  }

  const p10AcceptedSharpness = percentile(sharpnessValues, 0.1);
  if (sharpnessValues.length >= 10 && p10AcceptedSharpness < MINIMUM_SHARPNESS) {
    issues.push({
      code: "soft-accepted-images",
      severity: "risk",
      message: "The softest accepted views fall below the calibrated sharpness floor.",
      action: "Hold steadier, stay beyond the focus floor, and recapture the affected angles.",
    });
  }

  if (coverage.azimuthBinsCovered < AZIMUTH_BIN_COUNT) {
    const missing = AZIMUTH_BIN_COUNT - coverage.azimuthBinsCovered;
    issues.push({
      code: "missing-azimuth",
      severity: "repair",
      message: missing + " of " + AZIMUTH_BIN_COUNT + " orbit sectors still need coverage.",
      action: targetEstimate
        ? "Continue around the object while keeping it centered; fill the open orbit segments."
        : "Keep the object centered so its position can be estimated, then continue the orbit.",
    });
  }

  const missingBands = (["low", "level", "high"] as ElevationBand[])
    .filter((band) => !coverage.elevationBandsCovered.includes(band));
  if (missingBands.length > 0 || coverage.elevationSpanDegrees < MINIMUM_ELEVATION_SPAN_DEGREES) {
    issues.push({
      code: "missing-elevation",
      severity: "repair",
      message: elevationMessage(missingBands, coverage.elevationSpanDegrees),
      action: elevationAction(missingBands),
    });
  }

  if (
    imageFrames.length >= MINIMUM_FRAMES_FOR_VISUAL_CHECK &&
    (!input.visualTracking || input.visualTracking.state === "unavailable")
  ) {
    issues.push({
      code: "visual-check-unavailable",
      severity: "risk",
      message: "Visual overlap could not be checked on this device.",
      action: "Keep generous overlap between views and run downstream SfM preflight before training.",
    });
  } else if (
    imageFrames.length >= MINIMUM_FRAMES_FOR_VISUAL_CHECK &&
    (visual.componentCount > 1 || visual.connectedFrameCount < imageFrames.length)
  ) {
    issues.push({
      code: "visual-disconnected",
      severity: "repair",
      message: visual.connectedFrameCount + " of " + imageFrames.length + " images are in the largest visual component.",
      action: "Go back to the last well-tracked view, then sweep forward slowly with more overlap.",
    });
  }

  if (
    imageFrames.length >= MINIMUM_FRAMES_FOR_VISUAL_CHECK &&
    input.visualTracking?.state !== "unavailable" &&
    visual.adjacentEdgeCoverage < MINIMUM_ADJACENT_EDGE_COVERAGE
  ) {
    issues.push({
      code: "weak-bridge",
      severity: "repair",
      message: Math.round(visual.adjacentEdgeCoverage * 100) + "% of neighboring views have verified overlap.",
      action: "Add intermediate views through the weakest part of the orbit.",
      frameRange: visual.weakFrameRange,
    });
  }

  if (
    imageFrames.length >= MINIMUM_FRAMES_FOR_VISUAL_CHECK &&
    !loopClosureDetected &&
    !physicalLoopClosed
  ) {
    issues.push({
      code: "loop-not-closed",
      severity: "repair",
      message: "The capture does not return to its starting viewpoint.",
      action: "Complete the orbit by returning to the starting view and hold there briefly.",
    });
  }

  const status = readinessStatus(issues);
  return {
    format: "open3dcapture-readiness",
    version: 1,
    status,
    primaryAction: primaryAction(status, issues),
    generatedAt: generatedAt.toISOString(),
    metrics: {
      acceptedFrames: frames.length,
      imageFrames: imageFrames.length,
      synchronizedImageFrames: synchronizedImageFrames.length,
      synchronizedImageRatio: imageFrames.length
        ? synchronizedImageFrames.length / imageFrames.length
        : 0,
      p10AcceptedSharpness,
      azimuthBinsCovered: coverage.azimuthBinsCovered,
      azimuthBinCount: AZIMUTH_BIN_COUNT,
      missingAzimuthBins: coverage.missingAzimuthBins,
      elevationBandsCovered: coverage.elevationBandsCovered,
      elevationSpanDegrees: coverage.elevationSpanDegrees,
      coverageCells: coverage.cells,
      coverageCheckpointsCompleted: completedCheckpoints,
      coverageCheckpointsRequired: requiredCheckpoints,
      currentCoverageCell: coverage.currentCell,
      targetEstimate,
      visualConnectedFrames: visual.connectedFrameCount,
      visualComponentCount: visual.componentCount,
      adjacentEdgeCoverage: visual.adjacentEdgeCoverage,
      loopClosureDetected,
      physicalLoopClosed,
    },
    issues,
  };
}

export function summarizeCaptureReadiness(
  report: CaptureReadinessReport,
): CaptureReadinessSummary {
  return {
    status: report.status,
    primaryAction: report.primaryAction,
    issueCodes: report.issues.map((issue) => issue.code),
  };
}

function readinessStatus(issues: readonly CaptureReadinessIssue[]): CaptureReadinessReport["status"] {
  if (issues.some((issue) => issue.severity === "risk")) return "capture-risk";
  return issues.length ? "add-views" : "ready";
}

function primaryAction(
  status: CaptureReadinessReport["status"],
  issues: readonly CaptureReadinessIssue[],
): string {
  if (status === "ready") {
    return "Coverage and overlap checks pass. Stop and export the images for SfM.";
  }
  const priority = status === "capture-risk"
    ? ["missing-images", "unsynchronized-images", "soft-accepted-images", "visual-check-unavailable"]
    : ["visual-disconnected", "weak-bridge", "missing-coverage-checkpoints", "missing-azimuth", "missing-elevation", "loop-not-closed", "insufficient-frames"];
  for (const code of priority) {
    const issue = issues.find((candidate) => candidate.code === code);
    if (issue) return issue.action;
  }
  return issues[0]?.action ?? "Continue capturing.";
}

function acceptedSharpness(
  decisions: readonly CaptureDecision[],
  frames: readonly CaptureFrame[],
): number[] {
  const fromDecisions = decisions
    .filter((decision) => decision.accepted && Number.isFinite(decision.sharpnessScore))
    .map((decision) => clamp01(decision.sharpnessScore));
  if (fromDecisions.length) return fromDecisions;
  return frames
    .map((frame) => 1 - frame.quality.blurScore)
    .filter(Number.isFinite)
    .map(clamp01);
}

function estimateTarget(frames: readonly CaptureFrame[]): [number, number, number] | undefined {
  const depthTargets = frames.flatMap((frame) => {
    const distance = frame.targetDistance;
    const forward = cameraForward(frame.cameraToWorld);
    if (!forward || !Number.isFinite(distance) || !(distance! > 0.1 && distance! < 10)) return [];
    const position = translationOf(frame.cameraToWorld);
    return [[
      position[0] + forward[0] * distance!,
      position[1] + forward[1] * distance!,
      position[2] + forward[2] * distance!,
    ] as [number, number, number]];
  });
  if (depthTargets.length >= 3) {
    return [
      percentile(depthTargets.map((point) => point[0]), 0.5),
      percentile(depthTargets.map((point) => point[1]), 0.5),
      percentile(depthTargets.map((point) => point[2]), 0.5),
    ];
  }

  const rays = frames.flatMap((frame) => {
    const direction = cameraForward(frame.cameraToWorld);
    return direction ? [{ origin: translationOf(frame.cameraToWorld), direction }] : [];
  });
  if (rays.length < 3) return undefined;

  const matrix = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const vector = [0, 0, 0];
  for (const ray of rays) {
    const d = ray.direction;
    const projection = [
      [1 - d[0] * d[0], -d[0] * d[1], -d[0] * d[2]],
      [-d[1] * d[0], 1 - d[1] * d[1], -d[1] * d[2]],
      [-d[2] * d[0], -d[2] * d[1], 1 - d[2] * d[2]],
    ];
    for (let row = 0; row < 3; row += 1) {
      for (let column = 0; column < 3; column += 1) matrix[row][column] += projection[row][column];
      vector[row] += projection[row][0] * ray.origin[0] +
        projection[row][1] * ray.origin[1] +
        projection[row][2] * ray.origin[2];
    }
  }
  const target = solve3x3(matrix, vector);
  if (!target) return undefined;
  const inFront = rays.filter((ray) => dot(subtract(target, ray.origin), ray.direction) > 0.1).length;
  if (inFront / rays.length < 0.75) return undefined;
  return target;
}

function analyzeCoverage(
  frames: readonly CaptureFrame[],
  target?: [number, number, number],
): {
  azimuthBinsCovered: number;
  missingAzimuthBins: number[];
  elevationBandsCovered: ElevationBand[];
  elevationSpanDegrees: number;
  cells: CaptureCoverageCell[];
  currentCell?: { azimuthBin: number; latitude: CaptureCoverageLatitude };
} {
  const cells = createCoverageCells();
  if (!target) {
    return {
      azimuthBinsCovered: 0,
      missingAzimuthBins: Array.from({ length: AZIMUTH_BIN_COUNT }, (_, index) => index),
      elevationBandsCovered: [],
      elevationSpanDegrees: 0,
      cells,
    };
  }
  const bins = new Set<number>();
  const bands = new Set<ElevationBand>();
  const elevations: number[] = [];
  const stableCandidates = new Map<string, CaptureFrame[]>();
  let currentCell: { azimuthBin: number; latitude: CaptureCoverageLatitude } | undefined;
  for (const frame of frames) {
    const coverageCell = locateCoverageCell(frame.cameraToWorld, target);
    if (!coverageCell) continue;
    const { azimuthBin, elevation, latitude } = coverageCell;
    bins.add(azimuthBin);
    elevations.push(elevation);
    bands.add(latitude === "low" ? "low" : latitude === "level" ? "level" : "high");
    currentCell = { azimuthBin, latitude };
    const cell = cells.find(
      (candidate) => candidate.azimuthBin === azimuthBin && candidate.latitude === latitude,
    );
    if (!cell) continue;
    const sharpness = frameSharpness(frame);
    cell.frameCount += 1;
    if (frame.quality.motionScore <= MAXIMUM_CHECKPOINT_MOTION_SCORE) {
      cell.stableFrameCount += 1;
      cell.bestSharpness = Math.max(cell.bestSharpness, sharpness);
      const key = `${cell.latitude}:${cell.azimuthBin}`;
      const candidates = stableCandidates.get(key) ?? [];
      candidates.push(frame);
      stableCandidates.set(key, candidates);
    }
  }
  for (const cell of cells) {
    cell.selectedFrameIds = [...(stableCandidates.get(`${cell.latitude}:${cell.azimuthBin}`) ?? [])]
      .sort((left, right) => frameSharpness(right) - frameSharpness(left))
      .filter((frame) => frameSharpness(frame) >= MINIMUM_SHARPNESS)
      .slice(0, MAXIMUM_SELECTED_FRAMES_PER_CELL)
      .map((frame) => frame.id);
    cell.state = cell.selectedFrameIds.length >= CHECKPOINT_BURST_SAMPLES
      ? "captured"
      : cell.frameCount > 0
        ? "sampled"
        : "empty";
  }
  return {
    azimuthBinsCovered: bins.size,
    missingAzimuthBins: Array.from({ length: AZIMUTH_BIN_COUNT }, (_, index) => index)
      .filter((index) => !bins.has(index)),
    elevationBandsCovered: (["low", "level", "high"] as ElevationBand[])
      .filter((band) => bands.has(band)),
    elevationSpanDegrees: elevations.length
      ? Math.max(...elevations) - Math.min(...elevations)
      : 0,
    cells,
    currentCell,
  };
}

export function locateCoverageCell(
  cameraToWorld: Matrix4,
  target: [number, number, number],
): { azimuthBin: number; latitude: CaptureCoverageLatitude; elevation: number } | undefined {
  const position = translationOf(cameraToWorld);
  const delta = subtract(position, target);
  const horizontal = Math.hypot(delta[0], delta[2]);
  if (horizontal < 0.05) return undefined;
  const azimuth = Math.atan2(delta[0], delta[2]);
  const normalized = (azimuth + Math.PI) / (2 * Math.PI);
  const elevation = Math.atan2(delta[1], horizontal) * 180 / Math.PI;
  const latitude = coverageLatitude(elevation);
  const azimuthBin = latitude === "high"
    ? 0
    : Math.min(AZIMUTH_BIN_COUNT - 1, Math.floor(normalized * AZIMUTH_BIN_COUNT));
  return { azimuthBin, latitude, elevation };
}

function createCoverageCells(): CaptureCoverageCell[] {
  return COVERAGE_LATITUDE_BANDS.flatMap((band) => (
    Array.from({ length: band.latitude === "high" ? 1 : AZIMUTH_BIN_COUNT }, (_, azimuthBin): CaptureCoverageCell => ({
      azimuthBin,
      latitude: band.latitude,
      required: azimuthBin % band.requiredStride === 0,
      frameCount: 0,
      stableFrameCount: 0,
      bestSharpness: 0,
      selectedFrameIds: [],
      state: "empty",
    }))
  ));
}

function coverageLatitude(elevationDegrees: number): CaptureCoverageLatitude {
  return COVERAGE_LATITUDE_BANDS.find(
    (band) => elevationDegrees >= band.minimumDegrees && elevationDegrees < band.maximumDegrees,
  )?.latitude ?? (elevationDegrees < COVERAGE_LATITUDE_BANDS[0].minimumDegrees ? "low" : "high");
}

function frameSharpness(frame: CaptureFrame): number {
  return clamp01(1 - frame.quality.blurScore);
}

function analyzeVisualTracking(
  frames: readonly CaptureFrame[],
  report?: VisualTrackingReport,
): {
  connectedFrameCount: number;
  componentCount: number;
  adjacentEdgeCoverage: number;
  loopClosureDetected: boolean;
  weakFrameRange?: [number, number];
} {
  if (!report || report.state === "unavailable") {
    return {
      connectedFrameCount: 0,
      componentCount: frames.length ? 0 : 0,
      adjacentEdgeCoverage: 0,
      loopClosureDetected: false,
    };
  }
  const ordered = [...frames].sort((a, b) => a.id - b.id);
  const acceptedPairs = new Set(
    report.edges
      .filter((edge) => edge.accepted)
      .map((edge) => pairKey(edge.frameA, edge.frameB)),
  );
  const missingPairs: Array<[number, number]> = [];
  let adjacentEdges = 0;
  for (let index = 1; index < ordered.length; index += 1) {
    const pair: [number, number] = [ordered[index - 1].id, ordered[index].id];
    if (acceptedPairs.has(pairKey(pair[0], pair[1]))) adjacentEdges += 1;
    else missingPairs.push(pair);
  }
  return {
    connectedFrameCount: Math.min(frames.length, report.connectedFrameCount),
    componentCount: report.componentCount,
    adjacentEdgeCoverage: ordered.length > 1 ? adjacentEdges / (ordered.length - 1) : 0,
    loopClosureDetected: report.loopClosures > 0 ||
      report.edges.some((edge) => edge.accepted && edge.kind === "loop"),
    weakFrameRange: longestMissingRange(missingPairs),
  };
}

function longestMissingRange(pairs: readonly [number, number][]): [number, number] | undefined {
  if (!pairs.length) return undefined;
  let best: [number, number] = [...pairs[0]];
  let current: [number, number] = [...pairs[0]];
  for (const pair of pairs.slice(1)) {
    if (pair[0] === current[1]) current[1] = pair[1];
    else {
      if (current[1] - current[0] > best[1] - best[0]) best = [...current];
      current = [...pair];
    }
  }
  if (current[1] - current[0] > best[1] - best[0]) best = current;
  return best;
}

function isPhysicalLoopClosed(
  frames: readonly CaptureFrame[],
  target?: [number, number, number],
): boolean {
  if (frames.length < MINIMUM_FRAMES_FOR_VISUAL_CHECK) return false;
  const first = frames[0];
  const last = frames[frames.length - 1];
  const radii = target
    ? frames.map((frame) => distance(translationOf(frame.cameraToWorld), target))
    : [];
  const typicalRadius = percentile(radii, 0.5);
  const translationThreshold = Math.max(0.2, Math.min(0.5, typicalRadius * 0.25 || 0.25));
  return poseTranslationDistance(first.cameraToWorld, last.cameraToWorld) <= translationThreshold &&
    rotationAngleDifference(first.cameraToWorld, last.cameraToWorld) <= MAXIMUM_LOOP_ROTATION_RADIANS;
}

function cameraForward(matrix: Matrix4): [number, number, number] | undefined {
  if (!isFiniteMatrix(matrix)) return undefined;
  const direction: [number, number, number] = [-matrix[0][2], -matrix[1][2], -matrix[2][2]];
  const length = Math.hypot(...direction);
  if (!(length > 0)) return undefined;
  return [direction[0] / length, direction[1] / length, direction[2] / length];
}

function solve3x3(matrix: number[][], vector: number[]): [number, number, number] | undefined {
  const rows = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < 3; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 3; row += 1) {
      if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
    }
    if (Math.abs(rows[pivot][column]) < 1e-8) return undefined;
    [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
    const divisor = rows[column][column];
    for (let index = column; index < 4; index += 1) rows[column][index] /= divisor;
    for (let row = 0; row < 3; row += 1) {
      if (row === column) continue;
      const factor = rows[row][column];
      for (let index = column; index < 4; index += 1) {
        rows[row][index] -= factor * rows[column][index];
      }
    }
  }
  const result: [number, number, number] = [rows[0][3], rows[1][3], rows[2][3]];
  return result.every(Number.isFinite) ? result : undefined;
}

function elevationMessage(missing: readonly ElevationBand[], span: number): string {
  const names = missing.length ? missing.join(", ") : "wider";
  return "Add " + names + " viewpoints; current elevation span is " + span.toFixed(1) + "°.";
}

function elevationAction(missing: readonly ElevationBand[]): string {
  if (missing.includes("low") && missing.includes("high")) {
    return "Add a lower pass and a higher pass while keeping the object centered.";
  }
  if (missing.includes("low")) return "Lower the phone and angle it slightly upward for several views.";
  if (missing.includes("high")) return "Raise the phone and angle it slightly downward for several views.";
  return "Widen the vertical range with several lower and higher views.";
}

function pairKey(a: number, b: number): string {
  return a < b ? a + ":" + b : b + ":" + a;
}

function subtract(
  a: readonly number[],
  b: readonly number[],
): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot(a: readonly number[], b: readonly number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function distance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function percentile(values: readonly number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * fraction)] ?? 0;
}
