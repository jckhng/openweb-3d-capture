import { describe, expect, it } from "vitest";
import type { Intrinsics, Matrix4 } from "../shared/types";
import {
  optimizePoseGraph,
  type PoseGraphConstraint,
  type PoseGraphFrame,
} from "./pose-optimizer";

const intrinsics: Intrinsics = { fx: 500, fy: 500, cx: 320, cy: 240 };

describe("bounded pose optimization", () => {
  it("reduces held-out epipolar error without modifying the raw inputs", () => {
    const truth = [pose(0), pose(0.2), pose(0.4)];
    const raw = truth.map(clone);
    raw[2][1][3] = 0.12;
    const frames: PoseGraphFrame[] = raw.map((cameraToWorld, id) => ({ id, cameraToWorld }));
    const constraints: PoseGraphConstraint[] = [
      constraint(0, 1, "adjacent", truth),
      constraint(1, 2, "adjacent", truth),
      constraint(0, 2, "loop", truth),
    ];

    const result = optimizePoseGraph(frames, constraints, intrinsics);

    expect(result.final.validation.weightedCost).toBeLessThan(result.initial.validation.weightedCost);
    expect(result.final.validation.loopMedianPixels).toBeLessThan(result.initial.validation.loopMedianPixels);
    expect(result.corrections.maximumTranslationMeters).toBeLessThanOrEqual(0.15);
    expect(result.safeToExport).toBe(false);
    expect(result.fallbackReason).toBeTruthy();
    expect(frames[2].cameraToWorld[1][3]).toBe(0.12);
  });

  it("rejects constraints that reference missing frames", () => {
    expect(() => optimizePoseGraph(
      [{ id: 0, cameraToWorld: pose(0) }, { id: 1, cameraToWorld: pose(0.2) }, { id: 2, cameraToWorld: pose(0.4) }],
      [{ frameA: 0, frameB: 4, kind: "loop", matches: [] }],
      intrinsics,
    )).toThrow(/unknown frame/);
  });
});

function constraint(
  frameA: number,
  frameB: number,
  kind: PoseGraphConstraint["kind"],
  poses: Matrix4[],
): PoseGraphConstraint {
  const points = Array.from({ length: 30 }, (_, index) => [
    -0.7 + (index % 6) * 0.28,
    -0.45 + Math.floor(index / 6) * 0.2,
    -2.5 - (index % 4) * 0.25,
  ] as [number, number, number]);
  return {
    frameA,
    frameB,
    kind,
    matches: points.map((point) => ({
      pointA: project(point, poses[frameA]),
      pointB: project(point, poses[frameB]),
    })),
  };
}

function project(point: [number, number, number], cameraToWorld: Matrix4): [number, number] {
  const x = point[0] - cameraToWorld[0][3];
  const y = -(point[1] - cameraToWorld[1][3]);
  const z = -(point[2] - cameraToWorld[2][3]);
  return [intrinsics.fx * x / z + intrinsics.cx, intrinsics.fy * y / z + intrinsics.cy];
}

function pose(x: number): Matrix4 {
  return [[1, 0, 0, x], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
}

function clone(matrix: Matrix4): Matrix4 {
  return matrix.map((row) => [...row]);
}
