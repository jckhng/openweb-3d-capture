import { describe, expect, it } from "vitest";
import {
  deriveIntrinsics,
  fromWebXRTransform,
  poseTranslationDistance,
  rotationAngleDifference,
  toNerfstudioTransform,
  toWebXRMatrix,
} from "./matrix";

const identity = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
];

describe("matrix conversion", () => {
  it("converts a column-major WebXR matrix to row-major form and back", () => {
    const columnMajor = new Float32Array([
      1, 2, 3, 4,
      5, 6, 7, 8,
      9, 10, 11, 12,
      13, 14, 15, 16,
    ]);
    const rowMajor = fromWebXRTransform(columnMajor);

    expect(rowMajor).toEqual([
      [1, 5, 9, 13],
      [2, 6, 10, 14],
      [3, 7, 11, 15],
      [4, 8, 12, 16],
    ]);
    expect(Array.from(toWebXRMatrix(rowMajor))).toEqual(Array.from(columnMajor));
  });

  it("keeps the canonical camera-to-world transform explicit and immutable", () => {
    const exported = toNerfstudioTransform(identity);
    expect(exported).toEqual(identity);
    expect(exported).not.toBe(identity);
    expect(exported[0]).not.toBe(identity[0]);
  });
});

describe("camera geometry", () => {
  it("derives centered intrinsics from an OpenGL projection", () => {
    const projection = new Float32Array(16);
    projection[0] = 2;
    projection[5] = 3;

    expect(deriveIntrinsics(projection, 640, 480)).toEqual({
      fx: 640,
      fy: 720,
      cx: 320,
      cy: 240,
    });
  });

  it("uses the WebXR sign convention for asymmetric principal points", () => {
    const projection = new Float32Array(16);
    projection[0] = 2;
    projection[5] = 2;
    projection[8] = 0.25;
    projection[9] = -0.5;

    expect(deriveIntrinsics(projection, 800, 600)).toEqual({
      fx: 800,
      fy: 600,
      cx: 300,
      cy: 450,
    });
  });

  it("measures translation and rotation changes", () => {
    const translated = identity.map((row) => [...row]);
    translated[0][3] = 3;
    translated[1][3] = 4;
    expect(poseTranslationDistance(identity, translated)).toBe(5);

    const rotated = [
      [0, -1, 0, 0],
      [1, 0, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
    ];
    expect(rotationAngleDifference(identity, rotated)).toBeCloseTo(Math.PI / 2);
  });
});
