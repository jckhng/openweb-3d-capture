import { describe, expect, it } from "vitest";
import type { Matrix4 } from "../shared/types";
import { estimateSharedCalibration, type CalibrationObservation } from "./calibration-estimator";

const trueIntrinsics = { fx: 500, fy: 500, cx: 320, cy: 240 };
const initialIntrinsics = { fx: 490, fy: 490, cx: 320, cy: 240 };
const identity: Matrix4 = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];

describe("shared calibration estimate", () => {
  it("recovers a small shared focal error from connected feature tracks", () => {
    const observations: CalibrationObservation[] = Array.from({ length: 10 }, (_, edge) => {
      const angle = 0.03 + edge * 0.005;
      const cosine = Math.cos(angle);
      const sine = Math.sin(angle);
      const second: Matrix4 = [
        [cosine, 0, sine, 0.15 + edge * 0.01],
        [0, 1, 0, 0.01 * edge],
        [-sine, 0, cosine, 0],
        [0, 0, 0, 1],
      ];
      const matches = Array.from({ length: 30 }, (_, index) => {
        const point: [number, number, number] = [
          -0.8 + (index % 6) * 0.3,
          -0.5 + Math.floor(index / 6) * 0.22,
          -3 - (index % 4) * 0.4,
        ];
        return { pointA: project(point, identity), pointB: project(point, second) };
      });
      return { matches, cameraToWorldA: identity, cameraToWorldB: second, intrinsics: initialIntrinsics };
    });
    const result = estimateSharedCalibration(observations)!;
    expect(result.focalScale).toBeCloseTo(trueIntrinsics.fx / initialIntrinsics.fx, 2);
    expect(result.estimatedMedianResidualPixels).toBeLessThan(result.initialMedianResidualPixels);
  });
});

function project(point: [number, number, number], cameraToWorld: Matrix4): [number, number] {
  const delta = [
    point[0] - cameraToWorld[0][3],
    point[1] - cameraToWorld[1][3],
    point[2] - cameraToWorld[2][3],
  ];
  const x = cameraToWorld[0][0] * delta[0] + cameraToWorld[1][0] * delta[1] + cameraToWorld[2][0] * delta[2];
  const y = cameraToWorld[0][1] * delta[0] + cameraToWorld[1][1] * delta[1] + cameraToWorld[2][1] * delta[2];
  const z = cameraToWorld[0][2] * delta[0] + cameraToWorld[1][2] * delta[1] + cameraToWorld[2][2] * delta[2];
  return [
    trueIntrinsics.cx + trueIntrinsics.fx * x / -z,
    trueIntrinsics.cy - trueIntrinsics.fy * y / -z,
  ];
}
