import { describe, expect, it } from "vitest";
import type { CaptureFrame, Matrix4 } from "../shared/types";
import { invertNormalizedDepthMapping, sampleDepthFrame, type ColoredPoint } from "./depth-points";

const identity: Matrix4 = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
];

const frame: CaptureFrame = {
  id: 0,
  timestamp: 0,
  imagePath: "images/000000.jpg",
  width: 100,
  height: 100,
  intrinsics: { fx: 100, fy: 100, cx: 50, cy: 50 },
  cameraToWorld: identity,
  trackingState: "tracked",
  quality: { blurScore: 0, motionScore: 0, noveltyScore: 1, coverageGain: 0 },
  depthPath: "depth/000000.bin",
  depthWidth: 2,
  depthHeight: 2,
  depthRawValueToMeters: 0.001,
  depthDataFormat: "luminance-alpha",
  normDepthBufferFromNormView: identity,
};

function depth16(...values: number[]) {
  const data = new Uint8Array(values.length * 2);
  const view = new DataView(data.buffer);
  values.forEach((value, index) => view.setUint16(index * 2, value, true));
  return data;
}

const image = {
  width: 2,
  height: 2,
  data: new Uint8ClampedArray([
    255, 0, 0, 255, 0, 255, 0, 255,
    0, 0, 255, 255, 255, 255, 255, 255,
  ]),
};

describe("depth point sampling", () => {
  it("back-projects z-depth into the canonical negative-Z camera space", () => {
    const points: ColoredPoint[] = [];
    const count = sampleDepthFrame(frame, depth16(1000, 1000, 1000, 1000), image, (point) => points.push(point), {
      stride: 1,
      minimumDepth: 0.1,
      maximumDepth: 2,
    });
    expect(count).toBe(4);
    expect(points[0]).toEqual({ x: -0.25, y: 0.25, z: -1, red: 255, green: 0, blue: 0 });
    expect(points[3]).toEqual({ x: 0.25, y: -0.25, z: -1, red: 255, green: 255, blue: 255 });
  });

  it("rejects zero and out-of-range depth", () => {
    const points: ColoredPoint[] = [];
    sampleDepthFrame(frame, depth16(0, 100, 1000, 3000), image, (point) => points.push(point), {
      stride: 1,
      minimumDepth: 0.2,
      maximumDepth: 2,
    });
    expect(points).toHaveLength(1);
    expect(points[0].blue).toBe(255);
  });

  it("inverts the target-phone rotated depth mapping", () => {
    const mapping = [
      [0, 1, 0, 0],
      [-0.8205128, 0, 0, 0.9102564],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
    ];
    const inverse = invertNormalizedDepthMapping(mapping);
    const view: [number, number] = [0.2, 0.7];
    const depthX = view[1];
    const depthY = -0.8205128 * view[0] + 0.9102564;
    expect(inverse(depthX, depthY)[0]).toBeCloseTo(view[0]);
    expect(inverse(depthX, depthY)[1]).toBeCloseTo(view[1]);
  });
});
