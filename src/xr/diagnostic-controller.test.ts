import { describe, expect, it } from "vitest";
import type { Matrix4 } from "../shared/types";
import { lockTarget, projectTarget } from "./diagnostic-controller";

const cameraToWorld: Matrix4 = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
];

const projection = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, -1, -1,
  0, 0, -0.2, 0,
];

describe("projectTarget", () => {
  it("keeps a forward target centered", () => {
    expect(projectTarget([0, 0, -1], cameraToWorld, projection)).toEqual({
      ndc: [0, 0],
      inFront: true,
      centered: true,
    });
  });

  it("identifies an off-center or rear target", () => {
    expect(projectTarget([0.7, 0, -1], cameraToWorld, projection)).toMatchObject({
      ndc: [0.7, 0],
      inFront: true,
      centered: false,
    });
    expect(projectTarget([0, 0, 1], cameraToWorld, projection)).toMatchObject({
      inFront: false,
      centered: false,
    });
  });
});

describe("lockTarget", () => {
  it("uses the close-object fallback distance when XR depth is unavailable", () => {
    expect(lockTarget(cameraToWorld, undefined, "2026-09-03T00:00:00Z", 0.3)).toMatchObject({
      worldPoint: [0, 0, -0.3],
      distanceMeters: 0.3,
      source: "assumed-distance",
    });
  });

  it("prefers valid XR centre depth over the fallback", () => {
    expect(lockTarget(cameraToWorld, 0.22, "2026-09-03T00:00:00Z", 0.45)).toMatchObject({
      worldPoint: [0, 0, -0.22],
      distanceMeters: 0.22,
      source: "depth-center",
    });
  });
});
