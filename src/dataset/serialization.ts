import { toNerfstudioTransform } from "../shared/matrix";
import type {
  CameraCalibration,
  CaptureDataset,
  CaptureDecision,
  CaptureFrame,
  CaptureMetadata,
  IMUSample,
} from "../shared/types";

export interface NerfstudioFrame {
  file_path: string;
  transform_matrix: number[][];
  transform_matrix_source?: "webxr" | "refined";
  webxr_transform_matrix?: number[][];
  refined_transform_matrix?: number[][];
}

export interface NerfstudioTransforms {
  camera_model: "OPENCV";
  ply_file_path?: string;
  fl_x?: number;
  fl_y?: number;
  cx?: number;
  cy?: number;
  k1?: number;
  k2?: number;
  p1?: number;
  p2?: number;
  w?: number;
  h?: number;
  frames: NerfstudioFrame[];
}

export type PoseSource = "webxr" | "refined";

export interface DatasetFile {
  path: string;
  data: string | Blob | Uint8Array;
}

export interface PointCloudFile {
  path: string;
  data: Uint8Array;
}

export type ExportProfile = "canonical" | "spirula" | "lichtfeld";

export interface DestinationImageSelection {
  mode: "stationary-checkpoints" | "all-images-fallback";
  sourceImageCount: number;
  selectedImageCount: number;
  selectedFrameIds: number[];
  reason: string;
}

const MINIMUM_DESTINATION_CHECKPOINT_IMAGES = 50;
const MINIMUM_DESTINATION_AZIMUTH_BINS = 12;

export function buildNerfstudioTransforms(
  frames: CaptureFrame[],
  plyFilePath?: string,
  poseSource: PoseSource = "webxr",
  refinedCalibration?: CameraCalibration,
): NerfstudioTransforms {
  const imageFrames = frames.filter((frame) => (
    Boolean(frame.imagePath) && (poseSource === "webxr" || Boolean(frame.refinedCameraToWorld))
  ));
  const first = imageFrames[0];
  const result: NerfstudioTransforms = {
    camera_model: "OPENCV",
    frames: imageFrames.map((frame) => {
      const webxr = frame.webxrCameraToWorld ?? frame.cameraToWorld;
      const refined = frame.refinedCameraToWorld;
      const selected = poseSource === "refined" && refined ? refined : webxr;
      const output: NerfstudioFrame = {
        file_path: frame.imagePath as string,
        transform_matrix: toNerfstudioTransform(selected),
      };
      if (refined) {
        output.transform_matrix_source = poseSource;
        output.webxr_transform_matrix = toNerfstudioTransform(webxr);
        output.refined_transform_matrix = toNerfstudioTransform(refined);
      }
      return output;
    }),
  };

  const calibration = poseSource === "refined" ? refinedCalibration : undefined;
  if (calibration) {
    result.fl_x = calibration.intrinsics.fx;
    result.fl_y = calibration.intrinsics.fy;
    result.cx = calibration.intrinsics.cx;
    result.cy = calibration.intrinsics.cy;
    result.k1 = calibration.distortion.k1;
    result.k2 = calibration.distortion.k2;
    result.p1 = calibration.distortion.p1;
    result.p2 = calibration.distortion.p2;
    result.w = calibration.width;
    result.h = calibration.height;
  } else if (first) {
    result.fl_x = first.intrinsics.fx;
    result.fl_y = first.intrinsics.fy;
    result.cx = first.intrinsics.cx;
    result.cy = first.intrinsics.cy;
    result.w = first.width;
    result.h = first.height;
  }
  if (plyFilePath) result.ply_file_path = plyFilePath;

  return result;
}

export function serializeFramesJsonl(frames: CaptureFrame[]): string {
  return frames.map((frame) => JSON.stringify(frame)).join("\n") + (frames.length ? "\n" : "");
}

export function serializeImuJsonl(samples: IMUSample[]): string {
  return samples.map((sample) => JSON.stringify(sample)).join("\n") + (samples.length ? "\n" : "");
}

export function serializeDecisionsJsonl(decisions: CaptureDecision[]): string {
  return decisions.map((decision) => JSON.stringify(decision)).join("\n") + (decisions.length ? "\n" : "");
}

export function serializeCaptureMetadata(metadata: CaptureMetadata): string {
  return JSON.stringify(metadata, null, 2) + "\n";
}

export function buildDatasetFiles(dataset: CaptureDataset, pointCloud?: PointCloudFile): DatasetFile[] {
  const hasCompleteRefinement = Boolean(
    dataset.refinement &&
    dataset.frames.filter((frame) => frame.imagePath).every((frame) => frame.refinedCameraToWorld),
  );
  const mainPoseSource: PoseSource = dataset.refinement?.directTrainReady && hasCompleteRefinement
    ? "refined"
    : "webxr";
  const files: DatasetFile[] = [
    {
      path: "transforms.json",
      data: JSON.stringify(buildNerfstudioTransforms(
        dataset.frames,
        pointCloud?.path,
        mainPoseSource,
        dataset.refinement?.calibration,
      ), null, 2) + "\n",
    },
    {
      path: "capture.json",
      data: serializeCaptureMetadata(dataset.capture),
    },
    {
      path: "telemetry/frames.jsonl",
      data: serializeFramesJsonl(dataset.frames),
    },
    {
      path: "telemetry/imu.jsonl",
      data: serializeImuJsonl(dataset.imu),
    },
    {
      path: "debug/session.jsonl",
      data: serializeDecisionsJsonl(dataset.decisions),
    },
  ];

  if (dataset.visualTracking) {
    files.push({
      path: "refinement/tracking.json",
      data: JSON.stringify(dataset.visualTracking, null, 2) + "\n",
    });
  }

  if (dataset.readiness) {
    files.push({
      path: "preflight/readiness.json",
      data: JSON.stringify(dataset.readiness, null, 2) + "\n",
    });
  }

  if (dataset.refinement) {
    files.push({
      path: "transforms_webxr.json",
      data: JSON.stringify(buildNerfstudioTransforms(dataset.frames, pointCloud?.path), null, 2) + "\n",
    });
    files.push({
      path: "transforms_refined.json",
      data: JSON.stringify(buildNerfstudioTransforms(
        dataset.frames,
        pointCloud?.path,
        "refined",
        dataset.refinement.calibration,
      ), null, 2) + "\n",
    });
    files.push({
      path: "refinement.json",
      data: JSON.stringify(dataset.refinement, null, 2) + "\n",
    });
  }

  for (const [path, data] of dataset.images) files.push({ path, data });
  for (const [path, data] of dataset.depths) files.push({ path, data });
  for (const [path, data] of dataset.candidatePreviews ?? []) files.push({ path, data });
  if (pointCloud) files.push(pointCloud);
  return files;
}

export function buildExportFiles(
  dataset: CaptureDataset,
  profile: ExportProfile,
  pointCloud?: PointCloudFile,
): DatasetFile[] {
  if (profile === "canonical") return buildDatasetFiles(dataset, pointCloud);

  const destination = profile === "spirula" ? "Spirula Studio" : "LichtFeld Studio";
  const imageSelection = selectDestinationImages(dataset);
  const files: DatasetFile[] = [
    {
      path: `README-${profile.toUpperCase()}.txt`,
      data: destinationInstructions(profile, imageSelection),
    },
    {
      path: "open3dcapture/export.json",
      data: JSON.stringify({
        format: "open3dcapture-destination-export",
        version: 1,
        profile,
        destination,
        sourceCaptureId: dataset.capture.captureId,
        imageDirectory: "images",
        finalPoseAuthority: "downstream-sfm",
        webxrPoses: "open3dcapture/telemetry/frames.jsonl",
        readiness: dataset.readiness ? "open3dcapture/preflight/readiness.json" : undefined,
        imageSelection,
      }, null, 2) + "\n",
    },
    {
      path: "open3dcapture/capture.json",
      data: serializeCaptureMetadata(dataset.capture),
    },
    {
      path: "open3dcapture/telemetry/frames.jsonl",
      data: serializeFramesJsonl(dataset.frames),
    },
  ];

  if (dataset.readiness) {
    files.push({
      path: "open3dcapture/preflight/readiness.json",
      data: JSON.stringify(dataset.readiness, null, 2) + "\n",
    });
  }
  if (dataset.visualTracking) {
    files.push({
      path: "open3dcapture/preflight/visual-tracking.json",
      data: JSON.stringify(dataset.visualTracking, null, 2) + "\n",
    });
  }
  const selectedPaths = new Set(
    dataset.frames
      .filter((frame) => imageSelection.selectedFrameIds.includes(frame.id))
      .map((frame) => frame.imagePath)
      .filter((path): path is string => Boolean(path)),
  );
  for (const [path, data] of dataset.images) {
    if (imageSelection.mode === "all-images-fallback" || selectedPaths.has(path)) {
      files.push({ path, data });
    }
  }
  return files;
}

export function selectDestinationImages(dataset: CaptureDataset): DestinationImageSelection {
  const cells = dataset.readiness?.metrics.coverageCells ?? [];
  const selectedFrameIds = Array.from(new Set(
    cells
      .filter((cell) => cell.required && cell.state === "captured")
      .flatMap((cell) => cell.selectedFrameIds ?? []),
  )).sort((left, right) => left - right);
  const selectedIdSet = new Set(selectedFrameIds);
  const availableFrameIds = new Set(
    dataset.frames
      .filter((frame) => frame.imagePath && dataset.images.has(frame.imagePath))
      .map((frame) => frame.id),
  );
  const availableSelectedIds = selectedFrameIds.filter((id) => availableFrameIds.has(id));
  const coveredAzimuthBins = new Set(
    cells
      .filter((cell) => cell.required && cell.state === "captured" &&
        (cell.selectedFrameIds ?? []).some((id) => selectedIdSet.has(id) && availableFrameIds.has(id)))
      .map((cell) => cell.azimuthBin),
  ).size;
  const checkpointSetIsSafe = availableSelectedIds.length >= MINIMUM_DESTINATION_CHECKPOINT_IMAGES &&
    coveredAzimuthBins >= MINIMUM_DESTINATION_AZIMUTH_BINS;
  if (checkpointSetIsSafe) {
    return {
      mode: "stationary-checkpoints",
      sourceImageCount: dataset.images.size,
      selectedImageCount: availableSelectedIds.length,
      selectedFrameIds: availableSelectedIds,
      reason: "Selected sharp, low-motion stationary checkpoint bursts with complete azimuth coverage.",
    };
  }
  const allFrameIds = dataset.frames
    .filter((frame) => frame.imagePath && dataset.images.has(frame.imagePath))
    .map((frame) => frame.id);
  return {
    mode: "all-images-fallback",
    sourceImageCount: dataset.images.size,
    selectedImageCount: dataset.images.size,
    selectedFrameIds: allFrameIds,
    reason: `Checkpoint selection retained ${availableSelectedIds.length}/${MINIMUM_DESTINATION_CHECKPOINT_IMAGES} required images across ${coveredAzimuthBins}/${MINIMUM_DESTINATION_AZIMUTH_BINS} azimuth bins; exported all images for downstream SfM recovery.`,
  };
}

function destinationInstructions(
  profile: Exclude<ExportProfile, "canonical">,
  imageSelection: DestinationImageSelection,
): string {
  const selectionNote = imageSelection.mode === "stationary-checkpoints"
    ? `The images directory contains ${imageSelection.selectedImageCount} sharp stationary checkpoint frames selected from ${imageSelection.sourceImageCount} source images.`
    : `The checkpoint set was incomplete, so the images directory contains all ${imageSelection.sourceImageCount} source images for downstream SfM recovery.`;
  if (profile === "spirula") {
    return [
      "Open Web 3D Capture — Spirula Studio handoff",
      "",
      "1. Extract this ZIP.",
      "2. In Spirula Studio choose Create Dataset from Photos/Video.",
      "3. Select the extracted images directory.",
      "4. Run Spirula's native SfM (or its COLMAP workflow) before training.",
      "",
      "This package intentionally has no root transforms.json, sparse/, or colmap/ marker.",
      "WebXR poses are navigation priors stored under open3dcapture/telemetry; they are not final training poses.",
      selectionNote,
      "",
    ].join("\n");
  }
  return [
    "Open Web 3D Capture — LichtFeld Studio handoff",
    "",
    "1. Extract this ZIP.",
    "2. Open LichtFeld Studio and start the COLMAP Reconstruction plugin.",
    "3. Select the extracted images directory as the photo input.",
    "4. Run sparse reconstruction, inspect its quality metrics, then import/train.",
    "",
    "This package intentionally contains no fabricated COLMAP model.",
    "WebXR poses are navigation priors stored under open3dcapture/telemetry; they are not final training poses.",
    selectionNote,
    "",
  ].join("\n");
}
