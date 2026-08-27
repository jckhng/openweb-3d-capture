import { describe, expect, it } from "vitest";
import { verifyFeatureGeometry } from "./geometric-verification";

describe("pose-independent geometric verification", () => {
  it("accepts a coherent stereo correspondence set with outliers", () => {
    const matches = Array.from({ length: 30 }, (_, index) => ({
      pointA: [100 + index * 9, 150 + (index % 7) * 23] as [number, number],
      pointB: [76 + index * 9, 150 + (index % 7) * 23] as [number, number],
    }));
    matches.push(
      { pointA: [50, 50], pointB: [600, 400] },
      { pointA: [600, 80], pointB: [20, 420] },
      { pointA: [300, 400], pointB: [500, 30] },
    );
    expect(verifyFeatureGeometry(matches, 640, 480)).toMatchObject({
      matches: 33,
      accepted: true,
    });
  });

  it("rejects an insufficient match set", () => {
    const matches = Array.from({ length: 7 }, (_, index) => ({
      pointA: [index, index] as [number, number],
      pointB: [index + 2, index] as [number, number],
    }));
    expect(verifyFeatureGeometry(matches, 640, 480)).toEqual({
      matches: 7,
      inliers: 0,
      inlierRatio: 0,
      accepted: false,
    });
  });
});
