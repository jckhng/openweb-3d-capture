import { describe, expect, it } from "vitest";
import type { Intrinsics, Matrix4, VisualPoseConstraint } from "../shared/types";
import { poseTranslationDistance } from "../shared/matrix";
import {
  buildMultiViewTracks,
  DEFAULT_LANDMARK_OPTIMIZER_CONFIG,
  optimizeLandmarkBundle,
} from "./multi-view-optimizer";

const intrinsics: Intrinsics = { fx: 600, fy: 600, cx: 320, cy: 240 };

describe("multi-view landmark optimization", () => {
  it("joins stable feature identities across pair constraints", () => {
    const constraints = syntheticConstraints([pose(0), pose(0.1), pose(0.2), pose(0.3)], 4);
    const tracks = buildMultiViewTracks(constraints);

    expect(tracks).toHaveLength(4);
    expect(tracks.every((track) => track.observations.length === 4)).toBe(true);
  });

  it("reduces synthetic pose error while retaining raw inputs", () => {
    const truth = Array.from({ length: 6 }, (_, index) => pose(index * 0.08));
    const raw = truth.map(clone);
    raw[2][1][3] += 0.02;
    raw[3][1][3] -= 0.018;
    raw[4][0][3] += 0.012;
    const original = raw.map(clone);
    const result = optimizeLandmarkBundle(
      raw.map((cameraToWorld, id) => ({ id, cameraToWorld })),
      syntheticConstraints(truth, 60),
      intrinsics,
      undefined,
      { ...DEFAULT_LANDMARK_OPTIMIZER_CONFIG, optimizeTranslation: true },
    );
    const before = raw.reduce((sum, matrix, index) => sum + poseTranslationDistance(matrix, truth[index]), 0);
    const after = result.poses.reduce(
      (sum, value, index) => sum + poseTranslationDistance(value.cameraToWorld, truth[index]),
      0,
    );

    expect(result.tracks.triangulated).toBeGreaterThanOrEqual(50);
    expect(result.final.validation.robustCost).toBeLessThan(result.initial.validation.robustCost);
    expect(after).toBeLessThan(before);
    expect(result.safeToExport).toBe(false);
    expect(raw).toEqual(original);
  });
});

function syntheticConstraints(poses: Matrix4[], pointCount: number): VisualPoseConstraint[] {
  const points = Array.from({ length: pointCount }, (_, index) => [
    -0.8 + (index % 10) * 0.16,
    -0.5 + (Math.floor(index / 10) % 6) * 0.18,
    -2.7 - (index % 5) * 0.2,
  ] as [number, number, number]);
  const pairs = poses.slice(1).map((_, index) => [index, index + 1] as const);
  pairs.push([0, poses.length - 1]);
  return pairs.map(([frameA, frameB], pairIndex) => ({
    frameA,
    frameB,
    kind: pairIndex === pairs.length - 1 ? "loop" : "adjacent",
    matches: points.map((point, feature) => ({
      pointA: project(point, poses[frameA]),
      pointB: project(point, poses[frameB]),
      featureA: `feature:${feature}`,
      featureB: `feature:${feature}`,
    })),
  }));
}

function project(point: [number, number, number], cameraToWorld: Matrix4): [number, number] {
  const x = point[0] - cameraToWorld[0][3];
  const y = point[1] - cameraToWorld[1][3];
  const depth = -(point[2] - cameraToWorld[2][3]);
  return [intrinsics.fx * x / depth + intrinsics.cx, intrinsics.cy - intrinsics.fy * y / depth];
}

function pose(x: number): Matrix4 {
  return [[1, 0, 0, x], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
}

function clone(matrix: Matrix4): Matrix4 {
  return matrix.map((row) => [...row]);
}
