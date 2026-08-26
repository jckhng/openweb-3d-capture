import { describe, expect, it } from "vitest";
import type { CaptureDataset, CaptureFrame } from "../shared/types";
import { buildDatasetFiles, buildNerfstudioTransforms, serializeDecisionsJsonl } from "./serialization";

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
      decisions: [],
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
      "debug/session.jsonl",
      "images/000000.jpg",
    ]);
    const transforms = JSON.parse(files[0].data as string) as Record<string, unknown>;
    expect(transforms).not.toHaveProperty("captureId");
    expect(transforms).not.toHaveProperty("format");
  });

  it("serializes quality decisions separately from accepted frames", () => {
    const decision = {
      candidateId: 4,
      timestamp: 1000,
      accepted: false,
      reason: "blur" as const,
      trackingState: "tracked",
      cameraToWorld: frame.cameraToWorld,
      sharpnessScore: 0.2,
      linearVelocity: 0.1,
      angularVelocity: 0.2,
      translationNovelty: 0.03,
      rotationNovelty: 0.04,
      quality: { blurScore: 0.8, motionScore: 0.1, noveltyScore: 1, coverageGain: 0 },
    };
    expect(serializeDecisionsJsonl([decision])).toBe(`${JSON.stringify(decision)}\n`);
  });

  it("references an included seed point cloud using Nerfstudio convention", () => {
    const pointCloud = { path: "pointcloud.ply", data: new Uint8Array([1, 2, 3]) };
    const dataset: CaptureDataset = {
      capture: {
        format: "open3dcapture",
        version: 1,
        captureId: "capture-ply",
        createdAt: "2026-08-26T00:00:00.000Z",
        updatedAt: "2026-08-26T00:00:00.000Z",
        captureMode: "object",
        source: "webxr",
        units: "meters",
        frameCount: 1,
        hasDepth: true,
        hasImu: false,
        status: "complete",
      },
      frames: [frame],
      decisions: [],
      imu: [],
      images: new Map(),
      depths: new Map(),
    };
    const files = buildDatasetFiles(dataset, pointCloud);
    const transforms = JSON.parse(files[0].data as string) as Record<string, unknown>;
    expect(transforms.ply_file_path).toBe("pointcloud.ply");
    expect(files.at(-1)).toEqual(pointCloud);
  });

  it("preserves raw WebXR and refined poses in separate compatible exports", () => {
    const refinedPose = frame.cameraToWorld.map((row) => [...row]);
    refinedPose[0][3] += 0.02;
    const refinedFrame: CaptureFrame = {
      ...frame,
      webxrCameraToWorld: frame.cameraToWorld,
      refinedCameraToWorld: refinedPose,
      poseCorrection: { translationMeters: 0.02, rotationRadians: 0 },
    };
    const dataset: CaptureDataset = {
      capture: {
        format: "open3dcapture",
        version: 1,
        captureId: "capture-refined",
        createdAt: "2026-08-27T00:00:00.000Z",
        updatedAt: "2026-08-27T00:00:00.000Z",
        captureMode: "object",
        source: "replay",
        units: "meters",
        frameCount: 1,
        hasDepth: false,
        hasImu: false,
        status: "complete",
      },
      frames: [refinedFrame],
      decisions: [],
      imu: [],
      images: new Map(),
      depths: new Map(),
      refinement: {
        method: "test",
        calibration: {
          cameraModel: "OPENCV",
          width: 1920,
          height: 1080,
          intrinsics: { fx: 1010, fy: 1011, cx: 959, cy: 541 },
          distortion: { k1: 0.1, k2: -0.01, p1: 0.001, p2: -0.002 },
        },
        registeredFrameCount: 1,
        totalFrameCount: 1,
        medianReprojectionErrorPixels: 0.8,
        p90ReprojectionErrorPixels: 1.5,
        directTrainReady: true,
      },
    };

    const files = buildDatasetFiles(dataset);
    expect(files.map((file) => file.path)).toContain("transforms_webxr.json");
    expect(files.map((file) => file.path)).toContain("transforms_refined.json");
    expect(files.map((file) => file.path)).toContain("refinement.json");

    const main = JSON.parse(files.find((file) => file.path === "transforms.json")!.data as string);
    expect(main.frames[0]).toMatchObject({
      transform_matrix: refinedPose,
      transform_matrix_source: "refined",
      webxr_transform_matrix: frame.cameraToWorld,
      refined_transform_matrix: refinedPose,
    });
    expect(main).toMatchObject({
      fl_x: 1010,
      k1: 0.1,
      p2: -0.002,
    });

    const raw = JSON.parse(files.find((file) => file.path === "transforms_webxr.json")!.data as string);
    expect(raw.frames[0].transform_matrix).toEqual(frame.cameraToWorld);
    const refined = JSON.parse(files.find((file) => file.path === "transforms_refined.json")!.data as string);
    expect(refined.frames[0].transform_matrix).toEqual(refinedPose);
  });

  it("keeps raw WebXR poses authoritative when refinement is not ready", () => {
    const refinedPose = frame.cameraToWorld.map((row) => [...row]);
    refinedPose[1][3] += 0.03;
    const dataset: CaptureDataset = {
      capture: {
        format: "open3dcapture",
        version: 1,
        captureId: "capture-unready",
        createdAt: "2026-08-27T00:00:00.000Z",
        updatedAt: "2026-08-27T00:00:00.000Z",
        captureMode: "object",
        source: "replay",
        units: "meters",
        frameCount: 1,
        hasDepth: false,
        hasImu: false,
        status: "complete",
      },
      frames: [{ ...frame, refinedCameraToWorld: refinedPose }],
      decisions: [],
      imu: [],
      images: new Map(),
      depths: new Map(),
      refinement: {
        method: "test",
        calibration: {
          cameraModel: "OPENCV",
          width: 1920,
          height: 1080,
          intrinsics: frame.intrinsics,
          distortion: { k1: 0, k2: 0, p1: 0, p2: 0 },
        },
        registeredFrameCount: 1,
        totalFrameCount: 1,
        medianReprojectionErrorPixels: 3,
        p90ReprojectionErrorPixels: 8,
        directTrainReady: false,
        fallbackReason: "residual threshold failed",
      },
    };

    const files = buildDatasetFiles(dataset);
    const main = JSON.parse(files.find((file) => file.path === "transforms.json")!.data as string);
    expect(main.frames[0].transform_matrix).toEqual(frame.cameraToWorld);
    expect(main.frames[0].transform_matrix_source).toBe("webxr");
  });
});
