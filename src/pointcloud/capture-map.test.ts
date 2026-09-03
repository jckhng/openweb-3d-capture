import { describe, expect, it } from "vitest";
import type { Matrix4 } from "../shared/types";
import { CaptureMapAccumulator } from "./capture-map";

const identity: Matrix4 = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
];

function depth16(...values: number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 2);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setUint16(index * 2, value, true));
  return bytes;
}

describe("CaptureMapAccumulator", () => {
  it("counts support once per accepted viewpoint and normalizes around the target", () => {
    const accumulator = new CaptureMapAccumulator([0, 0, -1], 1);
    const input = {
      cameraToWorld: identity,
      intrinsics: { fx: 4, fy: 4, cx: 2, cy: 2 },
      viewWidth: 4,
      viewHeight: 4,
      depthWidth: 4,
      depthHeight: 4,
      depthRawValueToMeters: 0.001,
      depthDataFormat: "luminance-alpha",
      normDepthBufferFromNormView: identity,
      depth: depth16(...Array(16).fill(1000)),
      targetNdc: [0, 0] as [number, number],
      targetDistance: 1,
    };

    expect(accumulator.ingest({ ...input, frameId: 0 })).toBeGreaterThan(0);
    expect(accumulator.snapshot().points.every((point) => point.support === 1)).toBe(true);
    expect(accumulator.ingest({ ...input, frameId: 0 })).toBe(0);
    expect(accumulator.snapshot().points.every((point) => point.support === 1)).toBe(true);
    accumulator.ingest({ ...input, frameId: 1 });
    const snapshot = accumulator.snapshot();
    expect(snapshot.observedViewCount).toBe(2);
    expect(snapshot.points.every((point) => point.support === 2)).toBe(true);
    expect(snapshot.points.every((point) => Math.hypot(point.x, point.y, point.z) <= 1)).toBe(true);
  });

  it("ignores depth far behind the locked target", () => {
    const accumulator = new CaptureMapAccumulator([0, 0, -1], 1);
    expect(accumulator.ingest({
      frameId: 0,
      cameraToWorld: identity,
      intrinsics: { fx: 2, fy: 2, cx: 1, cy: 1 },
      viewWidth: 2,
      viewHeight: 2,
      depthWidth: 2,
      depthHeight: 2,
      depthRawValueToMeters: 0.001,
      depthDataFormat: "luminance-alpha",
      normDepthBufferFromNormView: identity,
      depth: depth16(2000, 2000, 2000, 2000),
      targetDistance: 1,
    })).toBe(0);
  });
});
