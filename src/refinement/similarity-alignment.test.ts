import { describe, expect, it } from "vitest";
import type { Matrix4 } from "../shared/types";
import { poseTranslationDistance, rotationAngleDifference } from "../shared/matrix";
import { applyPoseSimilarity, estimatePoseSimilarity } from "./similarity-alignment";

describe("pose similarity alignment", () => {
  it("recovers scale, rotation, and translation without changing relative camera rotations", () => {
    const source = [pose(0, 0, 0), pose(1, 0, 0.2), pose(0.4, 1, -0.1), pose(-0.3, 0.5, 0.4)];
    const expected = {
      scale: 1.7,
      rotation: rotationZ(0.35),
      translation: [0.4, -0.8, 1.2] as [number, number, number],
    };
    const target = source.map((value) => applyPoseSimilarity(value, expected));
    const estimated = estimatePoseSimilarity(source, target);
    const aligned = source.map((value) => applyPoseSimilarity(value, estimated));

    expect(estimated.scale).toBeCloseTo(expected.scale, 8);
    expect(Math.max(...aligned.map((value, index) => poseTranslationDistance(value, target[index])))).toBeLessThan(1e-8);
    expect(Math.max(...aligned.map((value, index) => rotationAngleDifference(value, target[index])))).toBeLessThan(1e-7);
  });
});

function pose(x: number, y: number, z: number): Matrix4 {
  return [[1, 0, 0, x], [0, 1, 0, y], [0, 0, 1, z], [0, 0, 0, 1]];
}

function rotationZ(angle: number): number[][] {
  return [
    [Math.cos(angle), -Math.sin(angle), 0],
    [Math.sin(angle), Math.cos(angle), 0],
    [0, 0, 1],
  ];
}
