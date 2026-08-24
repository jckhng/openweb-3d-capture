import { describe, expect, it } from "vitest";
import type { CaptureDataset, CaptureFrame } from "../shared/types";
import { buildDatasetFiles, buildNerfstudioTransforms } from "./serialization";

const frame: CaptureFrame = {
  id: 0,
  timestamp: 12.5,
  imagePath: "images/000000.jpg",
  width: 1920,
  height: 1080,
  intrinsics: { fx: 1000, fy: 1001, cx: 960, cy: 540 },
  cameraToWorld: [
    [1, 0, 0, 1],
    [0, 1, 0, 2],
    [0, 0, 1, 3],
    [0, 0, 0, 1],
  ],
  trackingState: "tracked",
  quality: { blurScore: 0, motionScore: 0, noveltyScore: 0, coverageGain: 0 },
};

describe("Nerfstudio serialization", () => {
  it("emits standard camera fields and only image-bearing frames", () => {
    const poseOnly = { ...frame, id: 1, imagePath: undefined };
    const result = buildNerfstudioTransforms([frame, poseOnly]);

    expect(result).toEqual({
      camera_model: "OPENCV",
      fl_x: 1000,
      fl_y: 1001,
      cx: 960,
      cy: 540,
      w: 1920,
      h: 1080,
      frames: [{
        file_path: "images/000000.jpg",
        transform_matrix: frame.cameraToWorld,
      }],
    });
  });

  it("places application metadata and telemetry outside transforms.json", () => {
    const dataset: CaptureDataset = {
      capture: {
        format: "open3dcapture",
        version: 1,
        captureId: "capture-test",
        createdAt: "2026-08-24T00:00:00.000Z",
        updatedAt: "2026-08-24T00:00:00.000Z",
        captureMode: "diagnostic",
        source: "webxr",
        units: "meters",
        frameCount: 1,
        hasDepth: false,
        hasImu: false,
        status: "complete",
      },
      frames: [frame],
      imu: [],
      images: new Map([[frame.imagePath!, new Blob(["jpg"])]]),
      depths: new Map(),
    };

    const files = buildDatasetFiles(dataset);
    expect(files.map((file) => file.path)).toEqual([
      "transforms.json",
      "capture.json",
      "telemetry/frames.jsonl",
      "telemetry/imu.jsonl",
      "images/000000.jpg",
    ]);
    const transforms = JSON.parse(files[0].data as string) as Record<string, unknown>;
    expect(transforms).not.toHaveProperty("captureId");
    expect(transforms).not.toHaveProperty("format");
  });
});
