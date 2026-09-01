import type { ImageFeature } from "./features";
import type { VisualTrackingEdge, VisualTrackingReport } from "../shared/types";

export const TARGET_REGION_LINEAR_FRACTION = 0.6;

export interface TargetRegionFeatureTotals {
  featureObservations: number;
  targetRegionFeatureObservations: number;
}

export function isPointInTargetRegion(
  point: readonly [number, number],
  width: number,
  height: number,
  fraction = TARGET_REGION_LINEAR_FRACTION,
): boolean {
  if (!(width > 0) || !(height > 0) || !(fraction > 0 && fraction <= 1)) return false;
  const marginX = width * (1 - fraction) / 2;
  const marginY = height * (1 - fraction) / 2;
  return point[0] >= marginX && point[0] <= width - marginX &&
    point[1] >= marginY && point[1] <= height - marginY;
}

export function countTargetRegionFeatures(
  features: ImageFeature[],
  width: number,
  height: number,
): TargetRegionFeatureTotals {
  return {
    featureObservations: features.length,
    targetRegionFeatureObservations: features.filter((feature) => (
      isPointInTargetRegion([feature.x, feature.y], width, height)
    )).length,
  };
}

export function summarizeTargetRegionSupport(
  totals: TargetRegionFeatureTotals,
  edges: VisualTrackingEdge[],
): NonNullable<VisualTrackingReport["targetRegion"]> {
  const accepted = edges.filter((edge) => edge.accepted);
  const geometricInliers = accepted.reduce((sum, edge) => sum + (edge.geometricInliers ?? 0), 0);
  const targetRegionInliers = accepted.reduce((sum, edge) => sum + (edge.targetRegionInliers ?? 0), 0);
  return {
    linearFraction: TARGET_REGION_LINEAR_FRACTION,
    featureObservations: totals.featureObservations,
    targetRegionFeatureObservations: totals.targetRegionFeatureObservations,
    targetRegionFeatureFraction: ratio(totals.targetRegionFeatureObservations, totals.featureObservations),
    acceptedEdges: accepted.length,
    edgesWithTargetRegionInliers: accepted.filter((edge) => (edge.targetRegionInliers ?? 0) > 0).length,
    geometricInliers,
    targetRegionInliers,
    targetRegionInlierFraction: ratio(targetRegionInliers, geometricInliers),
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}
