import { describe, expect, it } from "vitest";
import type { Matrix4 } from "../shared/types";
import { scoreEpipolarConsistency, type PointMatch } from "./reprojection";

const identity: Matrix4 = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
];
const intrinsics = { fx: 500, fy: 500, cx: 320, cy: 240 };

function translatedCamera(y = 0): Matrix4 {
  return [
    [1, 0, 0, 0.2],
    [0, 1, 0, y],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ];
}

describe("pose reprojection scoring", () => {
  it("reports zero residual for tracks consistent with the supplied stereo poses", () => {
    const matches: PointMatch[] = Array.from({ length: 12 }, (_, index) => ({
      pointA: [260 + index * 8, 180 + index * 3],
      pointB: [230 + index * 8, 180 + index * 3],
    }));
    const score = scoreEpipolarConsistency(matches, identity, translatedCamera(), intrinsics);
    expect(score.count).toBe(12);
    expect(score.p90Pixels).toBeLessThan(1e-9);
  });

  it("exposes residual when the supplied pose disagrees with the tracks", () => {
    const matches: PointMatch[] = Array.from({ length: 12 }, (_, index) => ({
      pointA: [260 + index * 8, 180 + index * 3],
      pointB: [230 + index * 8, 180 + index * 3],
    }));
    const score = scoreEpipolarConsistency(matches, identity, translatedCamera(0.05), intrinsics);
    expect(score.medianPixels).toBeGreaterThan(5);
  });
});
