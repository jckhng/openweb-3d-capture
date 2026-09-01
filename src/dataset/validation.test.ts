import { describe, expect, it } from "vitest";
import { encodeBinaryPointCloudPly } from "../pointcloud/ply";
import { validateCaptureDataset, type ValidationSource } from "./validation";

const encoder = new TextEncoder();
const pose = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
];

describe("capture dataset validation", () => {
  it("accepts a complete synchronized Nerfstudio export with depth and a seed cloud", async () => {
    const files = validFiles();
    const report = await validateCaptureDataset(memorySource(files));
    expect(report.valid).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.summary).toMatchObject({
      transformFrames: 1,
      telemetryFrames: 1,
      images: 1,
      synchronizedImages: 1,
      depthFrames: 1,
      imuSamples: 1,
      decisions: 1,
      pointCloudVertices: 1,
      trackingFrames: 1,
    });
  });

  it("reports unsafe synchronization, missing assets, invalid matrices, and readiness claims", async () => {
    const files = validFiles();
    files.delete("images/000000.jpg");
    const transforms = JSON.parse(text(files.get("transforms.json")!));
    transforms.frames[0].transform_matrix[3] = [0, 0, 1, 0];
    files.set("transforms.json", json(transforms));
    const frame = JSON.parse(text(files.get("telemetry/frames.jsonl")!).trim());
    frame.imageSource = "media-stream";
    frame.imageSynchronized = false;
    files.set("telemetry/frames.jsonl", jsonl(frame));
    const tracking = JSON.parse(text(files.get("refinement/tracking.json")!));
    tracking.directTrainReady = true;
    files.set("refinement/tracking.json", json(tracking));

    const report = await validateCaptureDataset(memorySource(files));
    expect(report.valid).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "matrix-homogeneous",
      "missing-image",
      "unsafe-readiness",
      "unsynchronized-frame",
    ]));
  });
});

function validFiles(): Map<string, Uint8Array> {
  const frame = {
    id: 0,
    timestamp: 1,
    imagePath: "images/000000.jpg",
    width: 3,
    height: 2,
    intrinsics: { fx: 2, fy: 2, cx: 1.5, cy: 1 },
    cameraToWorld: pose,
    trackingState: "tracked",
    imageSource: "xr-camera",
    imageSynchronized: true,
    quality: { blurScore: 0, motionScore: 0, noveltyScore: 1, coverageGain: 0 },
    depthPath: "depth/000000.bin",
    depthWidth: 2,
    depthHeight: 2,
    depthRawValueToMeters: 0.001,
    depthDataFormat: "luminance-alpha",
    normDepthBufferFromNormView: pose,
  };
  const decision = {
    candidateId: 0,
    acceptedFrameId: 0,
    timestamp: 1,
    accepted: true,
    reason: "accepted",
  };
  const tracking = {
    format: "open3dcapture-visual-tracking",
    version: 1,
    state: "collecting",
    frameCount: 1,
    connectedFrameCount: 1,
    componentCount: 1,
    loopClosures: 0,
    medianResidualPixels: 0,
    p90ResidualPixels: 0,
    readyForCalibration: false,
    readyForGlobalOptimization: false,
    directTrainReady: false,
    fallbackReason: "need more frames",
    targetRegion: {
      targetRegionFeatureFraction: 0.4,
      targetRegionInlierFraction: 0.3,
    },
    edges: [],
  };
  return new Map([
    ["transforms.json", json({
      camera_model: "OPENCV",
      fl_x: 2,
      fl_y: 2,
      cx: 1.5,
      cy: 1,
      w: 3,
      h: 2,
      ply_file_path: "pointcloud.ply",
      frames: [{ file_path: frame.imagePath, transform_matrix: pose }],
    })],
    ["capture.json", json({
      format: "open3dcapture",
      version: 1,
      captureId: "test",
      captureMode: "object",
      source: "webxr",
      units: "meters",
      frameCount: 1,
      hasDepth: true,
      hasImu: true,
      status: "complete",
    })],
    ["telemetry/frames.jsonl", jsonl(frame)],
    ["telemetry/imu.jsonl", jsonl({ timestamp: 1, gyro: [0, 0, 0] })],
    ["debug/session.jsonl", jsonl(decision)],
    ["refinement/tracking.json", json(tracking)],
    ["images/000000.jpg", jpeg(3, 2)],
    ["depth/000000.bin", new Uint8Array(8)],
    ["pointcloud.ply", encodeBinaryPointCloudPly([{
      x: 0,
      y: 0,
      z: -1,
      red: 1,
      green: 2,
      blue: 3,
    }])],
  ]);
}

function memorySource(files: Map<string, Uint8Array>): ValidationSource {
  return {
    paths: [...files.keys()],
    read: async (path) => {
      const value = files.get(path);
      if (!value) throw new Error(`missing ${path}`);
      return value;
    },
  };
}

function jpeg(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    height >> 8, height & 0xff,
    width >> 8, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    0xff, 0xd9,
  ]);
}

function json(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function jsonl(value: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(value)}\n`);
}

function text(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}
