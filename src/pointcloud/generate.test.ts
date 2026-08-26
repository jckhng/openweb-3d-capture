import { describe, expect, it } from "vitest";
import type { CaptureFrame, Matrix4 } from "../shared/types";
import { generateSeedPointCloud } from "./generate";

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

describe("seed point-cloud generation", () => {
  it("aggregates synchronized RGB-depth frames and reports finite bounds", async () => {
    const depth = new Uint8Array(8);
    const depthView = new DataView(depth.buffer);
    for (let index = 0; index < 4; index += 1) depthView.setUint16(index * 2, 1000, true);
    const image = {
      width: 2,
      height: 2,
      data: new Uint8Array(16).fill(127),
    };

    const result = await generateSeedPointCloud([{
      frame,
      loadDepth: async () => depth,
      loadImage: async () => image,
    }], {
      voxelSize: 0.01,
      maximumPoints: 100,
      minimumObservations: 1,
    });

    expect(result?.sampledPointCount).toBe(1);
    expect(result?.pointCount).toBe(1);
    expect(result?.bounds).toEqual({ minimum: [-0.25, 0.25, -1], maximum: [-0.25, 0.25, -1] });
    expect(new TextDecoder().decode(result?.data.slice(0, 80))).toContain("format binary_little_endian 1.0");
  });

  it("returns no cloud when no synchronized depth sources exist", async () => {
    await expect(generateSeedPointCloud([])).resolves.toBeUndefined();
  });
});
