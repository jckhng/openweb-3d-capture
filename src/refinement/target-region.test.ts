import { describe, expect, it } from "vitest";
import type { ImageFeature } from "./features";
import { countTargetRegionFeatures, isPointInTargetRegion, summarizeTargetRegionSupport } from "./target-region";

function feature(x: number, y: number): ImageFeature {
  return { x, y, score: 1, scale: 1, orientation: 0, descriptor: new Uint32Array(8) };
}

describe("target-region support", () => {
  it("uses the centered sixty-percent region as an informational object proxy", () => {
    expect(isPointInTargetRegion([50, 50], 100, 100)).toBe(true);
    expect(isPointInTargetRegion([19, 50], 100, 100)).toBe(false);
    expect(isPointInTargetRegion([80, 80], 100, 100)).toBe(true);
    expect(countTargetRegionFeatures([
      feature(50, 50),
      feature(20, 20),
      feature(10, 90),
    ], 100, 100)).toEqual({
      featureObservations: 3,
      targetRegionFeatureObservations: 2,
    });
  });

  it("summarizes only accepted geometric edges without setting a readiness gate", () => {
    const result = summarizeTargetRegionSupport({
      featureObservations: 100,
      targetRegionFeatureObservations: 40,
    }, [{
      frameA: 0,
      frameB: 1,
      kind: "adjacent",
      matches: 30,
      geometricInliers: 20,
      targetRegionInliers: 8,
      medianResidualPixels: 1,
      p90ResidualPixels: 2,
      accepted: true,
    }, {
      frameA: 1,
      frameB: 2,
      kind: "adjacent",
      matches: 10,
      geometricInliers: 5,
      targetRegionInliers: 5,
      medianResidualPixels: 10,
      p90ResidualPixels: 20,
      accepted: false,
    }]);
    expect(result).toMatchObject({
      linearFraction: 0.6,
      targetRegionFeatureFraction: 0.4,
      acceptedEdges: 1,
      edgesWithTargetRegionInliers: 1,
      geometricInliers: 20,
      targetRegionInliers: 8,
      targetRegionInlierFraction: 0.4,
    });
  });
});
