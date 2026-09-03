import { describe, expect, it } from "vitest";
import type { CaptureDataset, CaptureFrame } from "../shared/types";
import {
  buildDatasetFiles,
  buildExportFiles,
  buildNerfstudioTransforms,
  selectDestinationImages,
  serializeDecisionsJsonl,
} from "./serialization";

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
        applicationBuild: { builtAt: "2026-08-28T03:15:00.000Z" },
      },
      frames: [frame],
      decisions: [],
      imu: [],
      images: new Map([[frame.imagePath!, new Blob(["jpg"])]]),
      depths: new Map(),
      candidatePreviews: new Map([["debug/rejected/000004.jpg", new Blob(["preview"])]]),
    };

    const files = buildDatasetFiles(dataset);
    expect(files.map((file) => file.path)).toEqual([
      "transforms.json",
      "capture.json",
      "telemetry/frames.jsonl",
      "telemetry/imu.jsonl",
      "debug/session.jsonl",
      "images/000000.jpg",
      "debug/rejected/000004.jpg",
    ]);
    const transforms = JSON.parse(files[0].data as string) as Record<string, unknown>;
    expect(transforms).not.toHaveProperty("captureId");
    expect(transforms).not.toHaveProperty("format");
    expect(JSON.parse(files[1].data as string)).toMatchObject({
      applicationBuild: { builtAt: "2026-08-28T03:15:00.000Z" },
    });
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

  it("exports the incremental visual tracking report without claiming refined poses", () => {
    const dataset: CaptureDataset = {
      capture: {
        format: "open3dcapture",
        version: 1,
        captureId: "capture-tracking",
        createdAt: "2026-08-27T00:00:00.000Z",
        updatedAt: "2026-08-27T00:00:00.000Z",
        captureMode: "object",
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
      images: new Map(),
      depths: new Map(),
      visualTracking: {
        format: "open3dcapture-visual-tracking",
        version: 1,
        state: "calibration-ready",
        frameCount: 10,
        connectedFrameCount: 10,
        componentCount: 1,
        loopClosures: 0,
        medianResidualPixels: 0.8,
        p90ResidualPixels: 2,
        readyForCalibration: true,
        readyForGlobalOptimization: false,
        directTrainReady: false,
        fallbackReason: "visual graph passes; calibration and pose optimization have not run",
        edges: [],
      },
    };
    const files = buildDatasetFiles(dataset);
    expect(files.map((file) => file.path)).toContain("refinement/tracking.json");
    const transforms = JSON.parse(files.find((file) => file.path === "transforms.json")!.data as string);
    expect(transforms.frames[0].transform_matrix).toEqual(frame.cameraToWorld);
  });

  it("builds destination packages that force downstream SfM and preserve WebXR provenance", () => {
    const dataset: CaptureDataset = {
      capture: {
        format: "open3dcapture",
        version: 1,
        captureId: "capture-handoff",
        createdAt: "2026-08-28T00:00:00.000Z",
        updatedAt: "2026-08-28T00:00:00.000Z",
        captureMode: "object",
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
      readiness: {
        format: "open3dcapture-readiness",
        version: 1,
        status: "add-views",
        primaryAction: "Add more views.",
        generatedAt: "2026-08-28T00:00:00.000Z",
        metrics: {
          acceptedFrames: 1,
          imageFrames: 1,
          synchronizedImageFrames: 1,
          synchronizedImageRatio: 1,
          p10AcceptedSharpness: 1,
          azimuthBinsCovered: 1,
          azimuthBinCount: 12,
          missingAzimuthBins: [1, 2],
          elevationBandsCovered: [],
          elevationSpanDegrees: 0,
          visualConnectedFrames: 0,
          visualComponentCount: 0,
          adjacentEdgeCoverage: 0,
          loopClosureDetected: false,
          physicalLoopClosed: false,
        },
        issues: [],
      },
    };

    for (const profile of ["spirula", "lichtfeld"] as const) {
      const files = buildExportFiles(dataset, profile);
      const paths = files.map((file) => file.path);
      expect(paths).toContain("images/000000.jpg");
      expect(paths).toContain("open3dcapture/telemetry/frames.jsonl");
      expect(paths).toContain("open3dcapture/preflight/readiness.json");
      expect(paths).not.toContain("transforms.json");
      expect(paths.some((path) => path.startsWith("sparse/") || path.startsWith("colmap/"))).toBe(false);
      const manifest = JSON.parse(
        files.find((file) => file.path === "open3dcapture/export.json")!.data as string,
      );
      expect(manifest).toMatchObject({ profile, finalPoseAuthority: "downstream-sfm" });
      expect(manifest.imageSelection.mode).toBe("all-images-fallback");
      const instructions = files.find((file) => file.path.startsWith("README-"))!.data as string;
      expect(instructions).toContain("WARNING: capture preflight status is ADD-VIEWS");
      if (profile === "lichtfeld") {
        expect(instructions).toContain("community:colmap");
        expect(instructions).toContain("LichtFeld 0.5.0 or newer");
      }
    }
  });

  it("hands destination tools only complete stationary checkpoint bursts", () => {
    const checkpointCoordinates = [
      ...Array.from({ length: 12 }, (_, azimuthBin) => ({ azimuthBin, latitude: "level" as const })),
      ...[0, 2, 4, 6, 8, 10].map((azimuthBin) => ({ azimuthBin, latitude: "raised" as const })),
      { azimuthBin: 0, latitude: "high" as const },
      ...[0, 2, 4, 6, 8, 10].map((azimuthBin) => ({ azimuthBin, latitude: "low" as const })),
    ];
    const selectedFrames = checkpointCoordinates.flatMap((_, checkpointIndex) => (
      [0, 1].map((offset) => {
        const id = checkpointIndex * 2 + offset;
        return { ...frame, id, imagePath: `images/${String(id).padStart(6, "0")}.jpg` };
      })
    ));
    const movingFrame = {
      ...frame,
      id: selectedFrames.length,
      imagePath: `images/${String(selectedFrames.length).padStart(6, "0")}.jpg`,
    };
    const frames = [...selectedFrames, movingFrame];
    const dataset: CaptureDataset = {
      capture: {
        format: "open3dcapture",
        version: 1,
        captureId: "capture-checkpoints",
        createdAt: "2026-09-02T00:00:00.000Z",
        updatedAt: "2026-09-02T00:00:00.000Z",
        captureMode: "object",
        source: "webxr",
        units: "meters",
        frameCount: frames.length,
        hasDepth: false,
        hasImu: false,
        status: "complete",
      },
      frames,
      decisions: [],
      imu: [],
      images: new Map(frames.map((candidate) => [candidate.imagePath!, new Blob(["jpg"])])),
      depths: new Map(),
      readiness: {
        format: "open3dcapture-readiness",
        version: 1,
        status: "ready",
        primaryAction: "Ready.",
        generatedAt: "2026-09-02T00:00:00.000Z",
        metrics: {
          acceptedFrames: frames.length,
          imageFrames: frames.length,
          synchronizedImageFrames: frames.length,
          synchronizedImageRatio: 1,
          p10AcceptedSharpness: 1,
          azimuthBinsCovered: 12,
          azimuthBinCount: 12,
          missingAzimuthBins: [],
          elevationBandsCovered: ["low", "level", "high"],
          elevationSpanDegrees: 40,
          coverageCells: checkpointCoordinates.map((coordinate, checkpointIndex) => ({
            ...coordinate,
            required: true,
            frameCount: 2,
            stableFrameCount: 2,
            bestSharpness: 1,
            selectedFrameIds: [checkpointIndex * 2, checkpointIndex * 2 + 1],
            state: "captured",
          })),
          coverageCheckpointsCompleted: 25,
          coverageCheckpointsRequired: 25,
          visualConnectedFrames: frames.length,
          visualComponentCount: 1,
          adjacentEdgeCoverage: 1,
          loopClosureDetected: true,
          physicalLoopClosed: true,
        },
        issues: [],
      },
    };

    const files = buildExportFiles(dataset, "spirula");
    const manifest = JSON.parse(
      files.find((file) => file.path === "open3dcapture/export.json")!.data as string,
    );
    expect(manifest.imageSelection).toMatchObject({
      mode: "stationary-checkpoints",
      sourceImageCount: 51,
      selectedImageCount: 50,
    });
    expect(files.map((file) => file.path)).not.toContain(movingFrame.imagePath);

    const boundedDataset: CaptureDataset = {
      ...dataset,
      readiness: {
        ...dataset.readiness!,
        metrics: {
          ...dataset.readiness!.metrics,
          coverageCells: [
            ...dataset.readiness!.metrics.coverageCells!.slice(0, 10),
            {
              ...dataset.readiness!.metrics.coverageCells![10],
              frameCount: 0,
              stableFrameCount: 0,
              selectedFrameIds: [],
              state: "empty",
            },
          ],
          coverageCheckpointsCompleted: 10,
          coverageCheckpointsRequired: 11,
        },
      },
    };
    const boundedFiles = buildExportFiles(boundedDataset, "lichtfeld");
    const boundedManifest = JSON.parse(
      boundedFiles.find((file) => file.path === "open3dcapture/export.json")!.data as string,
    );
    expect(boundedManifest.imageSelection).toMatchObject({
      mode: "bounded-sectors",
      selectedImageCount: 20,
    });
  });

  it("exports at most four low-motion hybrid-ranked frames per populated cell", () => {
    const frames = Array.from({ length: 30 }, (_, id): CaptureFrame => ({
      ...frame,
      id,
      imagePath: `images/${String(id).padStart(6, "0")}.jpg`,
      quality: {
        ...frame.quality,
        sharpFramesHybridScore: id % 5,
        motionScore: id % 5 === 0 ? 0.5 : 0.2,
      },
    }));
    const dataset: CaptureDataset = {
      capture: {
        format: "open3dcapture",
        version: 1,
        captureId: "capture-curated",
        createdAt: "2026-09-03T00:00:00.000Z",
        updatedAt: "2026-09-03T00:00:00.000Z",
        captureMode: "object",
        source: "webxr",
        units: "meters",
        frameCount: frames.length,
        hasDepth: false,
        hasImu: false,
        status: "complete",
      },
      frames,
      decisions: [],
      imu: [],
      images: new Map(frames.map((candidate) => [candidate.imagePath!, new Blob(["jpg"])])),
      depths: new Map(),
      readiness: {
        format: "open3dcapture-readiness",
        version: 1,
        status: "add-views",
        primaryAction: "Add views.",
        generatedAt: "2026-09-03T00:00:00.000Z",
        metrics: {
          acceptedFrames: 30,
          imageFrames: 30,
          synchronizedImageFrames: 30,
          synchronizedImageRatio: 1,
          p10AcceptedSharpness: 1,
          azimuthBinsCovered: 6,
          azimuthBinCount: 12,
          missingAzimuthBins: [6, 7, 8, 9, 10, 11],
          elevationBandsCovered: ["level"],
          elevationSpanDegrees: 0,
          coverageCells: Array.from({ length: 6 }, (_, azimuthBin) => ({
            azimuthBin,
            latitude: "level" as const,
            required: true,
            frameCount: 5,
            stableFrameCount: 5,
            bestSharpness: 1,
            selectedFrameIds: Array.from({ length: 5 }, (_, offset) => azimuthBin * 5 + offset),
            state: "captured" as const,
          })),
          visualConnectedFrames: 30,
          visualComponentCount: 1,
          adjacentEdgeCoverage: 1,
          loopClosureDetected: false,
          physicalLoopClosed: false,
        },
        issues: [],
      },
    };

    const selection = selectDestinationImages(dataset);
    expect(selection).toMatchObject({ mode: "bounded-sectors", selectedImageCount: 24 });
    expect(selection.selectedFrameIds.some((id) => id % 5 === 0)).toBe(false);
  });
});
