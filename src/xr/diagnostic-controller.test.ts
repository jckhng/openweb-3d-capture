import { describe, expect, it } from "vitest";
import type { Matrix4 } from "../shared/types";
import { projectTarget } from "./diagnostic-controller";

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
