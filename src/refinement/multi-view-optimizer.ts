import type { Intrinsics, LensDistortion, Matrix4, VisualPoseConstraint } from "../shared/types";
import { poseTranslationDistance, rotationAngleDifference } from "../shared/matrix";

export interface MultiViewObservation {
  frameId: number;
  point: [number, number];
}

export interface MultiViewTrack {
  id: number;
  observations: MultiViewObservation[];
}

export interface LandmarkFrame {
  id: number;
  cameraToWorld: Matrix4;
}

export interface LandmarkOptimizerConfig {
  minimumTrackObservations: number;
  maximumTracks: number;
  minimumTriangulationAngleRadians: number;
  maximumInitialTrainingP90Pixels: number;
  translationStepsMeters: number[];
  rotationStepsRadians: number[];
  passesPerLevel: number;
  maximumTranslationCorrectionMeters: number;
  maximumRotationCorrectionRadians: number;
  maximumAdjacentTranslationDeltaMeters: number;
  maximumAdjacentRotationDeltaRadians: number;
  correctionPriorWeight: number;
  smoothnessWeight: number;
  huberDeltaPixels: number;
  optimizeTranslation: boolean;
}

export interface LandmarkResidualSummary {
  tracks: number;
  observations: number;
  medianPixels: number;
  p90Pixels: number;
  maximumPixels: number;
  robustCost: number;
}

export interface LandmarkOptimizationResult {
  poses: Array<{ id: number; cameraToWorld: Matrix4 }>;
  tracks: {
    joined: number;
    triangulated: number;
    trainingObservations: number;
    validationObservations: number;
    medianObservationsPerTrack: number;
    p90ObservationsPerTrack: number;
    maximumObservationsPerTrack: number;
    medianTemporalSpanFrames: number;
    p90TemporalSpanFrames: number;
    longRangeTracks: number;
  };
  initial: { training: LandmarkResidualSummary; validation: LandmarkResidualSummary };
  final: { training: LandmarkResidualSummary; validation: LandmarkResidualSummary };
  corrections: {
    medianTranslationMeters: number;
    maximumTranslationMeters: number;
    medianRotationRadians: number;
    maximumRotationRadians: number;
    maximumAdjacentTranslationDeltaMeters: number;
    maximumAdjacentRotationDeltaRadians: number;
  };
  frameDiagnostics: Array<{
    id: number;
    trainingObservations: number;
    initialRobustCost: number;
    finalRobustCost: number;
    translationCorrectionMeters: number;
    rotationCorrectionRadians: number;
  }>;
  internalValidationPassed: boolean;
  safeToExport: false;
  fallbackReason: string;
}

export const DEFAULT_LANDMARK_OPTIMIZER_CONFIG: Readonly<LandmarkOptimizerConfig> = {
  minimumTrackObservations: 3,
  maximumTracks: 1500,
  minimumTriangulationAngleRadians: Math.PI / 600,
  maximumInitialTrainingP90Pixels: 8,
  translationStepsMeters: [0.005, 0.0025, 0.00125, 0.000625],
  rotationStepsRadians: [Math.PI / 1440, Math.PI / 2880, Math.PI / 5760, Math.PI / 11520],
  passesPerLevel: 2,
  maximumTranslationCorrectionMeters: 0.05,
  maximumRotationCorrectionRadians: Math.PI / 90,
  maximumAdjacentTranslationDeltaMeters: 0.015,
  maximumAdjacentRotationDeltaRadians: Math.PI / 360,
  correctionPriorWeight: 0.2,
  smoothnessWeight: 0.35,
  huberDeltaPixels: 3,
  optimizeTranslation: true,
};

type Correction = [number, number, number, number, number, number];
type Point3 = [number, number, number];

interface SplitTrack {
  id: number;
  training: MultiViewObservation[];
  validation: MultiViewObservation[];
}

interface Landmark {
  track: SplitTrack;
  point: Point3;
}

/** Join verified pair matches into tracks using stable feature IDs or a pixel-coordinate fallback. */
export function buildMultiViewTracks(
  constraints: VisualPoseConstraint[],
  minimumObservations = 3,
  maximumTracks = 1500,
): MultiViewTrack[] {
  const observations: Array<MultiViewObservation & { key: string; count: number }> = [];
  const observationIds = new Map<string, number>();
  const parents: number[] = [];
  const node = (frameId: number, featureId: string | undefined, point: [number, number]): number => {
    const coordinateKey = `${Math.round(point[0] * 4)}:${Math.round(point[1] * 4)}`;
    const key = `${frameId}:${featureId ?? coordinateKey}`;
    const existing = observationIds.get(key);
    if (existing !== undefined) {
      const observation = observations[existing];
      observation.point = [
        (observation.point[0] * observation.count + point[0]) / (observation.count + 1),
        (observation.point[1] * observation.count + point[1]) / (observation.count + 1),
      ];
      observation.count += 1;
      return existing;
    }
    const id = observations.length;
    observations.push({ frameId, point: [...point], key, count: 1 });
    observationIds.set(key, id);
    parents.push(id);
    return id;
  };
  const root = (id: number): number => {
    while (parents[id] !== id) {
      parents[id] = parents[parents[id]];
      id = parents[id];
    }
    return id;
  };
  const join = (a: number, b: number): void => {
    const rootA = root(a);
    const rootB = root(b);
    if (rootA !== rootB) parents[rootB] = rootA;
  };

  for (const constraint of constraints) {
    for (const match of constraint.matches) {
      join(
        node(constraint.frameA, match.featureA, match.pointA),
        node(constraint.frameB, match.featureB, match.pointB),
      );
    }
  }

  const components = new Map<number, number[]>();
  for (let id = 0; id < observations.length; id += 1) append(components, root(id), id);
  const tracks: MultiViewTrack[] = [];
  for (const ids of components.values()) {
    const byFrame = new Map<number, MultiViewObservation[]>();
    for (const id of ids) append(byFrame, observations[id].frameId, observations[id]);
    let ambiguous = false;
    const trackObservations: MultiViewObservation[] = [];
    for (const [frameId, values] of byFrame) {
      const first = values[0].point;
      if (values.some((value) => Math.hypot(value.point[0] - first[0], value.point[1] - first[1]) > 2)) {
        ambiguous = true;
        break;
      }
      trackObservations.push({
        frameId,
        point: [mean(values.map((value) => value.point[0])), mean(values.map((value) => value.point[1]))],
      });
    }
    if (!ambiguous && trackObservations.length >= minimumObservations) {
      tracks.push({ id: tracks.length, observations: trackObservations.sort((a, b) => a.frameId - b.frameId) });
    }
  }
  return tracks
    .sort((a, b) => b.observations.length - a.observations.length || temporalSpan(b) - temporalSpan(a))
    .slice(0, maximumTracks)
    .map((track, id) => ({ ...track, id }));
}

/**
 * Experimental block-coordinate bundle refinement. Unlike pairwise epipolar
 * correction, every residual is tied to a landmark observed in 3+ frames.
 */
export function optimizeLandmarkBundle(
  frames: LandmarkFrame[],
  constraints: VisualPoseConstraint[],
  intrinsics: Intrinsics,
  distortion?: LensDistortion,
  config: LandmarkOptimizerConfig = DEFAULT_LANDMARK_OPTIMIZER_CONFIG,
): LandmarkOptimizationResult {
  validateInputs(frames, constraints, config);
  const ordered = [...frames].sort((a, b) => a.id - b.id);
  const raw = new Map(ordered.map((frame) => [frame.id, cloneMatrix(frame.cameraToWorld)]));
  const corrections = new Map<number, Correction>(ordered.map((frame) => [frame.id, zeroCorrection()]));
  const joined = buildMultiViewTracks(
    constraints,
    config.minimumTrackObservations,
    config.maximumTracks,
  );
  const split = joined.map(splitTrack);
  let poses = materialize(raw, corrections);
  let landmarks = triangulateLandmarks(split, poses, intrinsics, distortion, config)
    .filter((landmark) => summarizeLandmarks(
      [landmark], poses, intrinsics, distortion, "training", config.huberDeltaPixels,
    ).p90Pixels <= config.maximumInitialTrainingP90Pixels);
  if (landmarks.length < 12) throw new Error("Too few stable multi-view landmarks were triangulated");

  const initial = {
    training: summarizeLandmarks(landmarks, poses, intrinsics, distortion, "training", config.huberDeltaPixels),
    validation: summarizeLandmarks(landmarks, poses, intrinsics, distortion, "validation", config.huberDeltaPixels),
  };
  const initialFrameCosts = perFrameCosts(landmarks, poses, intrinsics, distortion, config.huberDeltaPixels);

  for (let level = 0; level < config.translationStepsMeters.length; level += 1) {
    const translationStep = config.translationStepsMeters[level];
    const rotationStep = config.rotationStepsRadians[Math.min(level, config.rotationStepsRadians.length - 1)];
    for (let pass = 0; pass < config.passesPerLevel; pass += 1) {
      const incident = incidentLandmarks(landmarks);
      for (let index = 1; index < ordered.length; index += 1) {
        const id = ordered[index].id;
        const correction = corrections.get(id)!;
        for (let dimension = config.optimizeTranslation ? 0 : 3; dimension < correction.length; dimension += 1) {
          const step = dimension < 3 ? translationStep : rotationStep;
          const original = correction[dimension];
          let best = original;
          let bestCost = localPoseCost(
            id, index, ordered, raw, corrections, incident.get(id) ?? [], intrinsics, distortion, config,
          );
          for (const direction of [-1, 1]) {
            correction[dimension] = original + direction * step;
            if (!withinBounds(correction, config) || !withinContinuityBounds(
              correction, index, ordered, corrections, config,
            )) {
              correction[dimension] = best;
              continue;
            }
            const candidateCost = localPoseCost(
              id, index, ordered, raw, corrections, incident.get(id) ?? [], intrinsics, distortion, config,
            );
            if (candidateCost < bestCost) {
              best = correction[dimension];
              bestCost = candidateCost;
            }
          }
          correction[dimension] = best;
        }
      }
      poses = materialize(raw, corrections);
      const retriangulated = triangulateLandmarks(
        landmarks.map((landmark) => landmark.track), poses, intrinsics, distortion, config,
      );
      const byTrack = new Map(retriangulated.map((landmark) => [landmark.track.id, landmark]));
      landmarks = landmarks.map((landmark) => byTrack.get(landmark.track.id) ?? landmark);
    }
  }

  poses = materialize(raw, corrections);
  const final = {
    training: summarizeLandmarks(landmarks, poses, intrinsics, distortion, "training", config.huberDeltaPixels),
    validation: summarizeLandmarks(landmarks, poses, intrinsics, distortion, "validation", config.huberDeltaPixels),
  };
  const correctionSummary = summarizeCorrections(ordered, poses, corrections);
  const finalFrameCosts = perFrameCosts(landmarks, poses, intrinsics, distortion, config.huberDeltaPixels);
  const validationImproved = final.validation.robustCost <= initial.validation.robustCost * 0.98;
  const validationTailClear = final.validation.p90Pixels <= initial.validation.p90Pixels * 1.02;
  const boundsClear =
    correctionSummary.maximumTranslationMeters < config.maximumTranslationCorrectionMeters * 0.99 &&
    correctionSummary.maximumRotationRadians < config.maximumRotationCorrectionRadians * 0.99;
  const continuityClear =
    correctionSummary.maximumAdjacentTranslationDeltaMeters <= config.maximumAdjacentTranslationDeltaMeters &&
    correctionSummary.maximumAdjacentRotationDeltaRadians <= config.maximumAdjacentRotationDeltaRadians;
  const coverageClear = landmarks.length >= Math.max(50, ordered.length / 2) && final.validation.observations >= 50;
  const internalValidationPassed =
    validationImproved && validationTailClear && boundsClear && continuityClear && coverageClear;
  const observationCounts = joined.map((track) => track.observations.length).sort((a, b) => a - b);
  const temporalSpans = joined.map(temporalSpan).sort((a, b) => a - b);
  return {
    poses: ordered.map((frame) => ({ id: frame.id, cameraToWorld: poses.get(frame.id)! })),
    tracks: {
      joined: joined.length,
      triangulated: landmarks.length,
      trainingObservations: final.training.observations,
      validationObservations: final.validation.observations,
      medianObservationsPerTrack: percentile(observationCounts, 0.5),
      p90ObservationsPerTrack: percentile(observationCounts, 0.9),
      maximumObservationsPerTrack: observationCounts.at(-1) ?? 0,
      medianTemporalSpanFrames: percentile(temporalSpans, 0.5),
      p90TemporalSpanFrames: percentile(temporalSpans, 0.9),
      longRangeTracks: joined.filter((track) => temporalSpan(track) >= 48).length,
    },
    initial,
    final,
    corrections: correctionSummary,
    frameDiagnostics: ordered.map((frame) => ({
      id: frame.id,
      trainingObservations: finalFrameCosts.get(frame.id)?.observations ?? 0,
      initialRobustCost: initialFrameCosts.get(frame.id)?.cost ?? 0,
      finalRobustCost: finalFrameCosts.get(frame.id)?.cost ?? 0,
      translationCorrectionMeters: poseTranslationDistance(frame.cameraToWorld, poses.get(frame.id)!),
      rotationCorrectionRadians: rotationAngleDifference(frame.cameraToWorld, poses.get(frame.id)!),
    })),
    internalValidationPassed,
    safeToExport: false,
    fallbackReason: internalValidationPassed
      ? "multi-view candidate requires independent COLMAP validation before phone export is enabled"
      : bundleFailureReason(validationImproved, validationTailClear, boundsClear, continuityClear, coverageClear),
  };
}

function splitTrack(track: MultiViewTrack): SplitTrack {
  const validationIndex = (track.id * 7 + 1) % track.observations.length;
  return {
    id: track.id,
    training: track.observations.filter((_, index) => index !== validationIndex),
    validation: [track.observations[validationIndex]],
  };
}

function triangulateLandmarks(
  tracks: SplitTrack[],
  poses: Map<number, Matrix4>,
  intrinsics: Intrinsics,
  distortion: LensDistortion | undefined,
  config: LandmarkOptimizerConfig,
): Landmark[] {
  const landmarks: Landmark[] = [];
  for (const track of tracks) {
    const rays = track.training.map((observation) => rayFor(
      observation.point, poses.get(observation.frameId)!, intrinsics, distortion,
    ));
    const point = intersectRays(rays);
    if (!point || maximumRayAngle(rays) < config.minimumTriangulationAngleRadians) continue;
    if (track.training.some((observation) => !projectPoint(
      point, poses.get(observation.frameId)!, intrinsics, distortion,
    ))) continue;
    landmarks.push({ track, point });
  }
  return landmarks;
}

function localPoseCost(
  id: number,
  index: number,
  ordered: LandmarkFrame[],
  raw: Map<number, Matrix4>,
  corrections: Map<number, Correction>,
  incident: Array<{ landmark: Landmark; observation: MultiViewObservation }>,
  intrinsics: Intrinsics,
  distortion: LensDistortion | undefined,
  config: LandmarkOptimizerConfig,
): number {
  const pose = applyCorrection(raw.get(id)!, corrections.get(id)!);
  let visualCost = 0;
  for (const { landmark, observation } of incident) {
    visualCost += robustObservationCost(
      observation, landmark.point, pose, intrinsics, distortion, config.huberDeltaPixels,
    );
  }
  visualCost /= Math.max(1, incident.length);
  const correction = corrections.get(id)!;
  const translation = Math.hypot(correction[0], correction[1], correction[2]);
  const rotation = Math.hypot(correction[3], correction[4], correction[5]);
  let regularization = config.correctionPriorWeight * (
    (translation / 0.02) ** 2 + (rotation / (Math.PI / 180)) ** 2
  );
  for (const neighbor of [ordered[index - 1], ordered[index + 1]]) {
    if (!neighbor) continue;
    const other = corrections.get(neighbor.id)!;
    regularization += config.smoothnessWeight * (
      (correctionDistance(correction, other, 0, 3) / 0.015) ** 2 +
      (correctionDistance(correction, other, 3, 6) / (Math.PI / 240)) ** 2
    );
  }
  return visualCost + regularization;
}

function incidentLandmarks(
  landmarks: Landmark[],
): Map<number, Array<{ landmark: Landmark; observation: MultiViewObservation }>> {
  const result = new Map<number, Array<{ landmark: Landmark; observation: MultiViewObservation }>>();
  for (const landmark of landmarks) {
    for (const observation of landmark.track.training) {
      append(result, observation.frameId, { landmark, observation });
    }
  }
  return result;
}

function perFrameCosts(
  landmarks: Landmark[],
  poses: Map<number, Matrix4>,
  intrinsics: Intrinsics,
  distortion: LensDistortion | undefined,
  huberDelta: number,
): Map<number, { observations: number; cost: number }> {
  const totals = new Map<number, { observations: number; cost: number }>();
  for (const landmark of landmarks) {
    for (const observation of landmark.track.training) {
      const value = totals.get(observation.frameId) ?? { observations: 0, cost: 0 };
      value.observations += 1;
      value.cost += robustObservationCost(
        observation,
        landmark.point,
        poses.get(observation.frameId)!,
        intrinsics,
        distortion,
        huberDelta,
      );
      totals.set(observation.frameId, value);
    }
  }
  for (const value of totals.values()) value.cost /= value.observations;
  return totals;
}

function summarizeLandmarks(
  landmarks: Landmark[],
  poses: Map<number, Matrix4>,
  intrinsics: Intrinsics,
  distortion: LensDistortion | undefined,
  split: "training" | "validation",
  huberDelta: number,
): LandmarkResidualSummary {
  const residuals: number[] = [];
  let robustCost = 0;
  for (const landmark of landmarks) {
    for (const observation of landmark.track[split]) {
      const projected = projectPoint(landmark.point, poses.get(observation.frameId)!, intrinsics, distortion);
      const residual = projected
        ? Math.hypot(projected[0] - observation.point[0], projected[1] - observation.point[1])
        : 50;
      residuals.push(residual);
      robustCost += huber(residual, huberDelta);
    }
  }
  residuals.sort((a, b) => a - b);
  return {
    tracks: landmarks.length,
    observations: residuals.length,
    medianPixels: percentile(residuals, 0.5),
    p90Pixels: percentile(residuals, 0.9),
    maximumPixels: residuals.at(-1) ?? 0,
    robustCost: robustCost / Math.max(1, residuals.length),
  };
}

function robustObservationCost(
  observation: MultiViewObservation,
  point: Point3,
  pose: Matrix4,
  intrinsics: Intrinsics,
  distortion: LensDistortion | undefined,
  huberDelta: number,
): number {
  const projected = projectPoint(point, pose, intrinsics, distortion);
  if (!projected) return huber(50, huberDelta);
  return huber(Math.hypot(projected[0] - observation.point[0], projected[1] - observation.point[1]), huberDelta);
}

function rayFor(
  pixel: [number, number],
  cameraToWorld: Matrix4,
  intrinsics: Intrinsics,
  distortion?: LensDistortion,
): { center: Point3; direction: Point3 } {
  const [x, y] = undistort(pixel, intrinsics, distortion);
  const cameraDirection: Point3 = normalize3([x, -y, -1]);
  const direction = normalize3([
    cameraToWorld[0][0] * cameraDirection[0] + cameraToWorld[0][1] * cameraDirection[1] + cameraToWorld[0][2] * cameraDirection[2],
    cameraToWorld[1][0] * cameraDirection[0] + cameraToWorld[1][1] * cameraDirection[1] + cameraToWorld[1][2] * cameraDirection[2],
    cameraToWorld[2][0] * cameraDirection[0] + cameraToWorld[2][1] * cameraDirection[1] + cameraToWorld[2][2] * cameraDirection[2],
  ]);
  return {
    center: [cameraToWorld[0][3], cameraToWorld[1][3], cameraToWorld[2][3]],
    direction,
  };
}

function intersectRays(rays: Array<{ center: Point3; direction: Point3 }>): Point3 | undefined {
  const a = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const b = [0, 0, 0];
  for (const ray of rays) {
    for (let row = 0; row < 3; row += 1) {
      for (let column = 0; column < 3; column += 1) {
        const value = (row === column ? 1 : 0) - ray.direction[row] * ray.direction[column];
        a[row][column] += value;
        b[row] += value * ray.center[column];
      }
    }
  }
  return solve3(a, b);
}

function projectPoint(
  point: Point3,
  cameraToWorld: Matrix4,
  intrinsics: Intrinsics,
  distortion?: LensDistortion,
): [number, number] | undefined {
  const delta = [
    point[0] - cameraToWorld[0][3],
    point[1] - cameraToWorld[1][3],
    point[2] - cameraToWorld[2][3],
  ];
  const camera = [0, 1, 2].map((column) =>
    cameraToWorld[0][column] * delta[0] +
    cameraToWorld[1][column] * delta[1] +
    cameraToWorld[2][column] * delta[2]
  );
  const depth = -camera[2];
  if (!(depth > 1e-4)) return undefined;
  const x = camera[0] / depth;
  const y = -camera[1] / depth;
  const radiusSquared = x * x + y * y;
  const radial = 1 + (distortion?.k1 ?? 0) * radiusSquared + (distortion?.k2 ?? 0) * radiusSquared ** 2;
  const distortedX = x * radial + 2 * (distortion?.p1 ?? 0) * x * y +
    (distortion?.p2 ?? 0) * (radiusSquared + 2 * x * x);
  const distortedY = y * radial + (distortion?.p1 ?? 0) * (radiusSquared + 2 * y * y) +
    2 * (distortion?.p2 ?? 0) * x * y;
  return [intrinsics.fx * distortedX + intrinsics.cx, intrinsics.fy * distortedY + intrinsics.cy];
}

function undistort(
  point: [number, number],
  intrinsics: Intrinsics,
  distortion?: LensDistortion,
): [number, number] {
  const distortedX = (point[0] - intrinsics.cx) / intrinsics.fx;
  const distortedY = (point[1] - intrinsics.cy) / intrinsics.fy;
  let x = distortedX;
  let y = distortedY;
  for (let iteration = 0; iteration < 6 && distortion; iteration += 1) {
    const radiusSquared = x * x + y * y;
    const radial = 1 + distortion.k1 * radiusSquared + distortion.k2 * radiusSquared ** 2;
    const tangentialX = 2 * distortion.p1 * x * y + distortion.p2 * (radiusSquared + 2 * x * x);
    const tangentialY = distortion.p1 * (radiusSquared + 2 * y * y) + 2 * distortion.p2 * x * y;
    x = (distortedX - tangentialX) / radial;
    y = (distortedY - tangentialY) / radial;
  }
  return [x, y];
}

function maximumRayAngle(rays: Array<{ direction: Point3 }>): number {
  let maximum = 0;
  for (let a = 0; a < rays.length; a += 1) {
    for (let b = a + 1; b < rays.length; b += 1) {
      const cosine = clamp(dot3(rays[a].direction, rays[b].direction), -1, 1);
      maximum = Math.max(maximum, Math.acos(cosine));
    }
  }
  return maximum;
}

function summarizeCorrections(
  ordered: LandmarkFrame[],
  poses: Map<number, Matrix4>,
  corrections: Map<number, Correction>,
) {
  const translations = ordered.map((frame) => poseTranslationDistance(frame.cameraToWorld, poses.get(frame.id)!));
  const rotations = ordered.map((frame) => rotationAngleDifference(frame.cameraToWorld, poses.get(frame.id)!));
  return {
    medianTranslationMeters: percentile([...translations].sort((a, b) => a - b), 0.5),
    maximumTranslationMeters: Math.max(...translations),
    medianRotationRadians: percentile([...rotations].sort((a, b) => a - b), 0.5),
    maximumRotationRadians: Math.max(...rotations),
    maximumAdjacentTranslationDeltaMeters: Math.max(0, ...ordered.slice(1).map((frame, index) =>
      correctionDistance(corrections.get(frame.id)!, corrections.get(ordered[index].id)!, 0, 3)
    )),
    maximumAdjacentRotationDeltaRadians: Math.max(0, ...ordered.slice(1).map((frame, index) =>
      correctionDistance(corrections.get(frame.id)!, corrections.get(ordered[index].id)!, 3, 6)
    )),
  };
}

function applyCorrection(pose: Matrix4, correction: Correction): Matrix4 {
  const delta = rodrigues(correction.slice(3) as Point3);
  const rotation = pose.slice(0, 3).map((row) => row.slice(0, 3));
  const corrected = multiply3(delta, rotation);
  return [
    [...corrected[0], pose[0][3] + correction[0]],
    [...corrected[1], pose[1][3] + correction[1]],
    [...corrected[2], pose[2][3] + correction[2]],
    [0, 0, 0, 1],
  ];
}

function materialize(raw: Map<number, Matrix4>, corrections: Map<number, Correction>): Map<number, Matrix4> {
  return new Map([...raw].map(([id, pose]) => [id, applyCorrection(pose, corrections.get(id)!)]));
}

function rodrigues(vector: Point3): number[][] {
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

function solve3(matrix: number[][], vector: number[]): Point3 | undefined {
  const augmented = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < 3; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 3; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    if (Math.abs(augmented[pivot][column]) < 1e-10) return undefined;
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const scale = augmented[column][column];
    for (let index = column; index < 4; index += 1) augmented[column][index] /= scale;
    for (let row = 0; row < 3; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let index = column; index < 4; index += 1) augmented[row][index] -= factor * augmented[column][index];
    }
  }
  const result: Point3 = [augmented[0][3], augmented[1][3], augmented[2][3]];
  return result.every(Number.isFinite) ? result : undefined;
}

function multiply3(a: number[][], b: number[][]): number[][] {
  return a.map((row) => b[0].map((_, column) => row.reduce(
    (sum, value, index) => sum + value * b[index][column], 0,
  )));
}

function withinBounds(correction: Correction, config: LandmarkOptimizerConfig): boolean {
  return Math.hypot(correction[0], correction[1], correction[2]) <= config.maximumTranslationCorrectionMeters &&
    Math.hypot(correction[3], correction[4], correction[5]) <= config.maximumRotationCorrectionRadians;
}

function withinContinuityBounds(
  correction: Correction,
  index: number,
  ordered: LandmarkFrame[],
  corrections: Map<number, Correction>,
  config: LandmarkOptimizerConfig,
): boolean {
  return [ordered[index - 1], ordered[index + 1]].every((neighbor) => !neighbor || (
    correctionDistance(correction, corrections.get(neighbor.id)!, 0, 3) <=
      config.maximumAdjacentTranslationDeltaMeters &&
    correctionDistance(correction, corrections.get(neighbor.id)!, 3, 6) <=
      config.maximumAdjacentRotationDeltaRadians
  ));
}

function validateInputs(
  frames: LandmarkFrame[],
  constraints: VisualPoseConstraint[],
  config: LandmarkOptimizerConfig,
): void {
  if (frames.length < 3) throw new Error("Landmark optimization requires at least three frames");
  if (!constraints.length) throw new Error("Landmark optimization requires visual constraints");
  const ids = new Set(frames.map((frame) => frame.id));
  if (ids.size !== frames.length) throw new Error("Landmark optimization frame IDs must be unique");
  if (constraints.some((constraint) => !ids.has(constraint.frameA) || !ids.has(constraint.frameB))) {
    throw new Error("Landmark constraint references an unknown frame");
  }
  if (config.minimumTrackObservations < 3) throw new Error("Multi-view tracks require at least three observations");
}

function bundleFailureReason(
  validation: boolean,
  tail: boolean,
  bounds: boolean,
  continuity: boolean,
  coverage: boolean,
): string {
  if (!coverage) return "insufficient stable multi-view landmark coverage";
  if (!validation) return "held-out multi-view reprojection cost did not improve by at least 2%";
  if (!tail) return "held-out multi-view p90 residual regressed by more than 2%";
  if (!bounds) return "one or more pose corrections reached the bundle safety bound";
  if (!continuity) return "adjacent bundle corrections exceed the continuity bound";
  return "multi-view bundle candidate did not pass its internal gate";
}

function huber(residual: number, delta: number): number {
  return residual <= delta ? residual * residual : 2 * delta * residual - delta * delta;
}

function temporalSpan(track: MultiViewTrack): number {
  return track.observations.at(-1)!.frameId - track.observations[0].frameId;
}

function zeroCorrection(): Correction {
  return [0, 0, 0, 0, 0, 0];
}

function correctionDistance(a: Correction, b: Correction, start: number, end: number): number {
  return Math.hypot(...a.slice(start, end).map((value, index) => value - b[start + index]));
}

function normalize3(vector: Point3): Point3 {
  const length = Math.hypot(...vector);
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function dot3(a: Point3, b: Point3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cloneMatrix(matrix: Matrix4): Matrix4 {
  return matrix.map((row) => [...row]);
}

function append<T>(map: Map<number, T[]>, key: number, value: T): void {
  const values = map.get(key) ?? [];
  values.push(value);
  map.set(key, values);
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(sorted: number[], fraction: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.floor((sorted.length - 1) * fraction)];
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
