import type { Intrinsics, LensDistortion, Matrix4 } from "../shared/types";
import { poseTranslationDistance, rotationAngleDifference } from "../shared/matrix";
import { scoreEpipolarConsistency, type PointMatch } from "./reprojection";

export interface PoseGraphFrame {
  id: number;
  cameraToWorld: Matrix4;
}

export interface PoseGraphConstraint {
  frameA: number;
  frameB: number;
  kind: "adjacent" | "recovery" | "loop";
  matches: PointMatch[];
}

export interface PoseOptimizerConfig {
  translationStepsMeters: number[];
  rotationStepsRadians: number[];
  passesPerLevel: number;
  maximumTranslationCorrectionMeters: number;
  maximumRotationCorrectionRadians: number;
  translationPriorWeight: number;
  rotationPriorWeight: number;
  smoothnessWeight: number;
}

export interface PoseResidualSummary {
  edges: number;
  medianPixels: number;
  p90Pixels: number;
  loopEdges: number;
  loopMedianPixels: number;
  loopP90Pixels: number;
  weightedCost: number;
}

export interface PoseOptimizationResult {
  poses: Array<{ id: number; cameraToWorld: Matrix4 }>;
  initial: { training: PoseResidualSummary; validation: PoseResidualSummary };
  final: { training: PoseResidualSummary; validation: PoseResidualSummary };
  corrections: {
    medianTranslationMeters: number;
    maximumTranslationMeters: number;
    medianRotationRadians: number;
    maximumRotationRadians: number;
    maximumAdjacentTranslationDeltaMeters: number;
    maximumAdjacentRotationDeltaRadians: number;
  };
  internalValidationPassed: boolean;
  safeToExport: boolean;
  fallbackReason?: string;
}

export const DEFAULT_POSE_OPTIMIZER_CONFIG: Readonly<PoseOptimizerConfig> = {
  translationStepsMeters: [0.04, 0.02, 0.01, 0.005],
  rotationStepsRadians: [Math.PI / 180, Math.PI / 360, Math.PI / 720, Math.PI / 1440],
  passesPerLevel: 2,
  maximumTranslationCorrectionMeters: 0.15,
  maximumRotationCorrectionRadians: Math.PI / 36,
  translationPriorWeight: 0.75,
  rotationPriorWeight: 0.75,
  smoothnessWeight: 5,
};

type Correction = [number, number, number, number, number, number];

/** Bounded coordinate-descent prototype over verified epipolar constraints. */
export function optimizePoseGraph(
  frames: PoseGraphFrame[],
  constraints: PoseGraphConstraint[],
  intrinsics: Intrinsics,
  distortion?: LensDistortion,
  config: PoseOptimizerConfig = DEFAULT_POSE_OPTIMIZER_CONFIG,
): PoseOptimizationResult {
  validateInputs(frames, constraints, config);
  const ordered = [...frames].sort((a, b) => a.id - b.id);
  const raw = new Map(ordered.map((frame) => [frame.id, cloneMatrix(frame.cameraToWorld)]));
  const corrections = new Map<number, Correction>(ordered.map((frame) => [frame.id, [0, 0, 0, 0, 0, 0]]));
  const incident = new Map<number, PoseGraphConstraint[]>();
  for (const constraint of constraints) {
    append(incident, constraint.frameA, constraint);
    append(incident, constraint.frameB, constraint);
  }
  const training = splitConstraints(constraints, 0);
  const validation = splitConstraints(constraints, 1);
  const initialPoses = materialize(raw, corrections);
  const initial = {
    training: summarize(training, initialPoses, intrinsics, distortion),
    validation: summarize(validation, initialPoses, intrinsics, distortion),
  };

  for (let level = 0; level < config.translationStepsMeters.length; level += 1) {
    const translationStep = config.translationStepsMeters[level];
    const rotationStep = config.rotationStepsRadians[Math.min(level, config.rotationStepsRadians.length - 1)];
    for (let pass = 0; pass < config.passesPerLevel; pass += 1) {
      for (let index = 1; index < ordered.length; index += 1) {
        const id = ordered[index].id;
        const current = corrections.get(id)!;
        for (let dimension = 0; dimension < 6; dimension += 1) {
          const step = dimension < 3 ? translationStep : rotationStep;
          const original = current[dimension];
          let best = original;
          let bestCost = localCost(id, ordered, raw, corrections, incident, training, intrinsics, distortion, config);
          for (const direction of [-1, 1]) {
            current[dimension] = original + direction * step;
            if (!withinBounds(current, config)) {
              current[dimension] = best;
              continue;
            }
            const candidateCost = localCost(
              id, ordered, raw, corrections, incident, training, intrinsics, distortion, config,
            );
            if (candidateCost < bestCost) {
              best = current[dimension];
              bestCost = candidateCost;
            }
          }
          current[dimension] = best;
        }
      }
    }
  }

  const refinedPoses = materialize(raw, corrections);
  const final = {
    training: summarize(training, refinedPoses, intrinsics, distortion),
    validation: summarize(validation, refinedPoses, intrinsics, distortion),
  };
  const translationCorrections = ordered.map((frame) => poseTranslationDistance(
    frame.cameraToWorld,
    refinedPoses.get(frame.id)!,
  ));
  const rotationCorrections = ordered.map((frame) => rotationAngleDifference(
    frame.cameraToWorld,
    refinedPoses.get(frame.id)!,
  ));
  const correctionSummary = {
    medianTranslationMeters: percentile(translationCorrections, 0.5),
    maximumTranslationMeters: Math.max(...translationCorrections),
    medianRotationRadians: percentile(rotationCorrections, 0.5),
    maximumRotationRadians: Math.max(...rotationCorrections),
    maximumAdjacentTranslationDeltaMeters: Math.max(0, ...ordered.slice(1).map((frame, index) =>
      correctionDistance(corrections.get(frame.id)!, corrections.get(ordered[index].id)!, 0, 3)
    )),
    maximumAdjacentRotationDeltaRadians: Math.max(0, ...ordered.slice(1).map((frame, index) =>
      correctionDistance(corrections.get(frame.id)!, corrections.get(ordered[index].id)!, 3, 6)
    )),
  };
  const validationImproved = final.validation.weightedCost <= initial.validation.weightedCost * 0.98;
  const tailDidNotRegress = final.validation.p90Pixels <= initial.validation.p90Pixels * 1.05;
  const correctionBoundClear =
    correctionSummary.maximumTranslationMeters < config.maximumTranslationCorrectionMeters * 0.99 &&
    correctionSummary.maximumRotationRadians < config.maximumRotationCorrectionRadians * 0.99;
  const correctionContinuityClear =
    correctionSummary.maximumAdjacentTranslationDeltaMeters <= 0.03 &&
    correctionSummary.maximumAdjacentRotationDeltaRadians <= Math.PI / 180;
  const internalValidationPassed =
    validationImproved && tailDidNotRegress && correctionBoundClear && correctionContinuityClear;
  return {
    poses: ordered.map((frame) => ({ id: frame.id, cameraToWorld: refinedPoses.get(frame.id)! })),
    initial,
    final,
    corrections: correctionSummary,
    internalValidationPassed,
    // Pairwise epipolar residuals do not uniquely identify the correct SE(3)
    // update. Keep this implementation diagnostic until a multi-view landmark
    // objective and an independent reference benchmark validate it.
    safeToExport: false,
    fallbackReason: internalValidationPassed
      ? "pairwise epipolar optimization is diagnostic only; multi-view landmark bundle adjustment is required"
      : failureReason(validationImproved, tailDidNotRegress, correctionBoundClear, correctionContinuityClear),
  };
}

function localCost(
  id: number,
  ordered: PoseGraphFrame[],
  raw: Map<number, Matrix4>,
  corrections: Map<number, Correction>,
  incident: Map<number, PoseGraphConstraint[]>,
  training: Map<PoseGraphConstraint, PointMatch[]>,
  intrinsics: Intrinsics,
  distortion: LensDistortion | undefined,
  config: PoseOptimizerConfig,
): number {
  const poses = new Map<number, Matrix4>();
  const poseFor = (frameId: number) => {
    let pose = poses.get(frameId);
    if (!pose) {
      pose = applyCorrection(raw.get(frameId)!, corrections.get(frameId)!);
      poses.set(frameId, pose);
    }
    return pose;
  };
  let cost = 0;
  for (const constraint of incident.get(id) ?? []) {
    const matches = training.get(constraint) ?? [];
    if (!matches.length) continue;
    cost += constraintWeight(constraint) * edgeCost(
      matches,
      poseFor(constraint.frameA),
      poseFor(constraint.frameB),
      intrinsics,
      distortion,
    );
  }
  const correction = corrections.get(id)!;
  cost += priorCost(correction, config);
  const index = ordered.findIndex((frame) => frame.id === id);
  for (const neighbor of [ordered[index - 1], ordered[index + 1]]) {
    if (neighbor) cost += smoothnessCost(correction, corrections.get(neighbor.id)!, config);
  }
  return cost;
}

function summarize(
  split: Map<PoseGraphConstraint, PointMatch[]>,
  poses: Map<number, Matrix4>,
  intrinsics: Intrinsics,
  distortion?: LensDistortion,
): PoseResidualSummary {
  const residuals: number[] = [];
  const loops: number[] = [];
  let weightedCost = 0;
  for (const [constraint, matches] of split) {
    if (!matches.length) continue;
    const score = scoreEpipolarConsistency(
      matches,
      poses.get(constraint.frameA)!,
      poses.get(constraint.frameB)!,
      intrinsics,
      distortion,
    );
    residuals.push(score.medianPixels);
    if (constraint.kind === "loop") loops.push(score.medianPixels);
    weightedCost += constraintWeight(constraint) * boundedScoreCost(score.medianPixels, score.p90Pixels);
  }
  return {
    edges: residuals.length,
    medianPixels: percentile(residuals, 0.5),
    p90Pixels: percentile(residuals, 0.9),
    loopEdges: loops.length,
    loopMedianPixels: percentile(loops, 0.5),
    loopP90Pixels: percentile(loops, 0.9),
    weightedCost,
  };
}

function edgeCost(
  matches: PointMatch[],
  poseA: Matrix4,
  poseB: Matrix4,
  intrinsics: Intrinsics,
  distortion?: LensDistortion,
): number {
  const score = scoreEpipolarConsistency(matches, poseA, poseB, intrinsics, distortion);
  return boundedScoreCost(score.medianPixels, score.p90Pixels);
}

function boundedScoreCost(median: number, p90: number): number {
  return Math.min(median, 12) ** 2 + 0.15 * Math.min(p90, 20) ** 2;
}

function constraintWeight(constraint: PoseGraphConstraint): number {
  return constraint.kind === "loop" ? 4 : constraint.kind === "recovery" ? 2 : 1;
}

function priorCost(correction: Correction, config: PoseOptimizerConfig): number {
  const translation = Math.hypot(correction[0], correction[1], correction[2]);
  const rotation = Math.hypot(correction[3], correction[4], correction[5]);
  return config.translationPriorWeight * (translation / config.maximumTranslationCorrectionMeters) ** 2 +
    config.rotationPriorWeight * (rotation / config.maximumRotationCorrectionRadians) ** 2;
}

function smoothnessCost(a: Correction, b: Correction, config: PoseOptimizerConfig): number {
  const translation = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const rotation = Math.hypot(a[3] - b[3], a[4] - b[4], a[5] - b[5]);
  return config.smoothnessWeight * (
    (translation / (config.maximumTranslationCorrectionMeters / 6)) ** 2 +
    (rotation / (config.maximumRotationCorrectionRadians / 6)) ** 2
  );
}

function materialize(raw: Map<number, Matrix4>, corrections: Map<number, Correction>): Map<number, Matrix4> {
  return new Map([...raw].map(([id, pose]) => [id, applyCorrection(pose, corrections.get(id)!)]));
}

function applyCorrection(pose: Matrix4, correction: Correction): Matrix4 {
  const delta = rodrigues(correction.slice(3) as [number, number, number]);
  const rotation = pose.slice(0, 3).map((row) => row.slice(0, 3));
  const correctedRotation = multiply3(delta, rotation);
  return [
    [...correctedRotation[0], pose[0][3] + correction[0]],
    [...correctedRotation[1], pose[1][3] + correction[1]],
    [...correctedRotation[2], pose[2][3] + correction[2]],
    [0, 0, 0, 1],
  ];
}

function rodrigues(vector: [number, number, number]): number[][] {
  const angle = Math.hypot(...vector);
  if (angle < 1e-12) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const [x, y, z] = vector.map((value) => value / angle);
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const oneMinusCosine = 1 - cosine;
  return [
    [cosine + x * x * oneMinusCosine, x * y * oneMinusCosine - z * sine, x * z * oneMinusCosine + y * sine],
    [y * x * oneMinusCosine + z * sine, cosine + y * y * oneMinusCosine, y * z * oneMinusCosine - x * sine],
    [z * x * oneMinusCosine - y * sine, z * y * oneMinusCosine + x * sine, cosine + z * z * oneMinusCosine],
  ];
}

function multiply3(a: number[][], b: number[][]): number[][] {
  return a.map((row) => b[0].map((_, column) => row.reduce(
    (sum, value, index) => sum + value * b[index][column],
    0,
  )));
}

function splitConstraints(constraints: PoseGraphConstraint[], parity: number): Map<PoseGraphConstraint, PointMatch[]> {
  return new Map(constraints.map((constraint) => [
    constraint,
    constraint.matches.filter((_, index) => index % 2 === parity),
  ]));
}

function withinBounds(correction: Correction, config: PoseOptimizerConfig): boolean {
  return Math.hypot(correction[0], correction[1], correction[2]) <= config.maximumTranslationCorrectionMeters &&
    Math.hypot(correction[3], correction[4], correction[5]) <= config.maximumRotationCorrectionRadians;
}

function validateInputs(
  frames: PoseGraphFrame[],
  constraints: PoseGraphConstraint[],
  config: PoseOptimizerConfig,
): void {
  if (frames.length < 3) throw new Error("Pose optimization requires at least three frames");
  const ids = new Set(frames.map((frame) => frame.id));
  if (ids.size !== frames.length) throw new Error("Pose optimization frame IDs must be unique");
  if (!constraints.length) throw new Error("Pose optimization requires visual constraints");
  if (constraints.some((constraint) => !ids.has(constraint.frameA) || !ids.has(constraint.frameB))) {
    throw new Error("Pose constraint references an unknown frame");
  }
  if (config.translationStepsMeters.some((value) => !(value > 0)) ||
      config.rotationStepsRadians.some((value) => !(value > 0))) {
    throw new Error("Pose optimizer steps must be positive");
  }
}

function failureReason(validation: boolean, tail: boolean, bounds: boolean, continuity: boolean): string {
  if (!validation) return "held-out visual cost did not improve by at least 2%";
  if (!tail) return "held-out p90 residual regressed by more than 5%";
  if (!bounds) return "one or more corrections reached the safety bound";
  if (!continuity) return "adjacent pose corrections exceed the continuity bound";
  return "bounded pose optimization did not pass its safety gate";
}

function correctionDistance(a: Correction, b: Correction, start: number, end: number): number {
  return Math.hypot(...a.slice(start, end).map((value, index) => value - b[start + index]));
}

function append<T>(map: Map<number, T[]>, key: number, value: T): void {
  const values = map.get(key) ?? [];
  values.push(value);
  map.set(key, values);
}

function cloneMatrix(matrix: Matrix4): Matrix4 {
  return matrix.map((row) => [...row]);
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * fraction)];
}
