import type { Intrinsics, LensDistortion, Matrix4, VisualTrackingReport } from "../shared/types";
import { scoreEpipolarConsistency, type PointMatch } from "./reprojection";

export interface CalibrationObservation {
  matches: PointMatch[];
  cameraToWorldA: Matrix4;
  cameraToWorldB: Matrix4;
  intrinsics: Intrinsics;
}

type CalibrationEstimate = NonNullable<VisualTrackingReport["calibrationEstimate"]>;

/** Bounded shared focal-scale/k1 grid search; pose correction remains a later stage. */
export function estimateSharedCalibration(
  observations: CalibrationObservation[],
): CalibrationEstimate | undefined {
  if (observations.length < 8) return undefined;
  const initial = observations[0].intrinsics;
  const initialResidual = evaluate(observations, initial, zeroDistortion());
  let best = { focalScale: 1, k1: 0, residual: initialResidual };

  for (let focalScale = 0.97; focalScale <= 1.0401; focalScale += 0.01) {
    for (let k1 = -0.08; k1 <= 0.0801; k1 += 0.04) {
      const residual = evaluate(observations, scaledIntrinsics(initial, focalScale), {
        ...zeroDistortion(),
        k1,
      });
      if (residual < best.residual) best = { focalScale, k1, residual };
    }
  }
  const coarse = best;
  for (let focalScale = coarse.focalScale - 0.01; focalScale <= coarse.focalScale + 0.0101; focalScale += 0.0025) {
    for (let k1 = coarse.k1 - 0.03; k1 <= coarse.k1 + 0.0301; k1 += 0.01) {
      const residual = evaluate(observations, scaledIntrinsics(initial, focalScale), {
        ...zeroDistortion(),
        k1,
      });
      if (residual < best.residual) best = { focalScale, k1, residual };
    }
  }

  return {
    model: "FOCAL_SCALE_K1",
    observationEdges: observations.length,
    observationMatches: observations.reduce((sum, observation) => sum + observation.matches.length, 0),
    focalScale: best.focalScale,
    intrinsics: scaledIntrinsics(initial, best.focalScale),
    distortion: { ...zeroDistortion(), k1: best.k1 },
    initialMedianResidualPixels: initialResidual,
    estimatedMedianResidualPixels: best.residual,
  };
}

function evaluate(
  observations: CalibrationObservation[],
  intrinsics: Intrinsics,
  distortion: LensDistortion,
): number {
  const residuals = observations.map((observation) => scoreEpipolarConsistency(
    observation.matches,
    observation.cameraToWorldA,
    observation.cameraToWorldB,
    intrinsics,
    distortion,
  ).medianPixels).sort((a, b) => a - b);
  return residuals[Math.floor(residuals.length / 2)];
}

function scaledIntrinsics(intrinsics: Intrinsics, scale: number): Intrinsics {
  return {
    fx: intrinsics.fx * scale,
    fy: intrinsics.fy * scale,
    cx: intrinsics.cx,
    cy: intrinsics.cy,
  };
}

function zeroDistortion(): LensDistortion {
  return { k1: 0, k2: 0, p1: 0, p2: 0 };
}
