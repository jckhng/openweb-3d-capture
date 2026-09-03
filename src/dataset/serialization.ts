import { toNerfstudioTransform } from "../shared/matrix";
import type {
  CameraCalibration,
  CaptureCoverageCell,
  CaptureDataset,
  CaptureDecision,
  CaptureFrame,
  CaptureMetadata,
  CaptureReadinessStatus,
  IMUSample,
  UnposedPhoto,
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
  mode: "stationary-checkpoints" | "bounded-sectors" | "all-images-fallback";
  sourceImageCount: number;
  selectedImageCount: number;
  selectedFrameIds: number[];
  reason: string;
}

const MINIMUM_DESTINATION_CHECKPOINT_IMAGES = 50;
const MINIMUM_DESTINATION_AZIMUTH_BINS = 12;
const MINIMUM_BOUNDED_SELECTION_IMAGES = 20;
const MINIMUM_BOUNDED_SELECTION_AZIMUTH_BINS = 6;
const MAXIMUM_DESTINATION_IMAGES_PER_CELL = 4;
const MAXIMUM_DESTINATION_MOTION_SCORE = 0.4;

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

export function serializeUnposedPhotosJsonl(photos: UnposedPhoto[]): string {
  return photos.map((photo) => JSON.stringify(photo)).join("\n") + (photos.length ? "\n" : "");
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

  if (dataset.unposedPhotos?.length) {
    files.push({
      path: "telemetry/photos.jsonl",
      data: serializeUnposedPhotosJsonl(dataset.unposedPhotos),
    });
  }

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
      data: destinationInstructions(profile, imageSelection, dataset.capture, dataset.readiness?.status),
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
        sourcePoseStatus: dataset.capture.captureMode === "photo-sfm" ? "unposed" : "webxr-prior",
        webxrPoses: dataset.capture.captureMode === "photo-sfm"
          ? undefined
          : "open3dcapture/telemetry/frames.jsonl",
        unposedPhotoMetadata: dataset.unposedPhotos?.length
          ? "open3dcapture/telemetry/photos.jsonl"
          : undefined,
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

  if (dataset.unposedPhotos?.length) {
    files.push({
      path: "open3dcapture/telemetry/photos.jsonl",
      data: serializeUnposedPhotosJsonl(dataset.unposedPhotos),
    });
  }

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
  if (dataset.capture.captureMode === "photo-sfm") {
    const photos = dataset.unposedPhotos ?? [];
    return {
      mode: "all-images-fallback",
      sourceImageCount: dataset.images.size,
      selectedImageCount: photos.length,
      selectedFrameIds: photos.map((photo) => photo.id),
      reason: "Autofocus photo mode exports every accepted full-resolution image for downstream SfM registration.",
    };
  }
  const cells = dataset.readiness?.metrics.coverageCells ?? [];
  const availableFrameIds = new Set(
    dataset.frames
      .filter((frame) => frame.imagePath && dataset.images.has(frame.imagePath))
      .map((frame) => frame.id),
  );
  const requiredCells = cells.filter((cell) => cell.required && cell.state === "captured");
  const requiredSelectedIds = selectedIds(requiredCells, availableFrameIds, dataset.frames);
  const requiredAzimuthBins = coveredAzimuthBins(requiredCells, new Set(requiredSelectedIds));
  const requiredCellCount = cells.filter((cell) => cell.required).length;
  const checkpointSetIsSafe = requiredCellCount > 0 && requiredCells.length === requiredCellCount &&
    requiredSelectedIds.length >= MINIMUM_DESTINATION_CHECKPOINT_IMAGES &&
    requiredAzimuthBins >= MINIMUM_DESTINATION_AZIMUTH_BINS;
  if (checkpointSetIsSafe) {
    return {
      mode: "stationary-checkpoints",
      sourceImageCount: dataset.images.size,
      selectedImageCount: requiredSelectedIds.length,
      selectedFrameIds: requiredSelectedIds,
      reason: "Selected up to four spatially distinct, hybrid-ranked images with motion score at most 0.4 per required checkpoint with complete coverage.",
    };
  }
  const boundedSelectedIds = selectedIds(cells, availableFrameIds, dataset.frames);
  const boundedAzimuthBins = coveredAzimuthBins(cells, new Set(boundedSelectedIds));
  if (
    boundedSelectedIds.length >= MINIMUM_BOUNDED_SELECTION_IMAGES &&
    boundedAzimuthBins >= MINIMUM_BOUNDED_SELECTION_AZIMUTH_BINS
  ) {
    return {
      mode: "bounded-sectors",
      sourceImageCount: dataset.images.size,
      selectedImageCount: boundedSelectedIds.length,
      selectedFrameIds: boundedSelectedIds,
      reason: `Coverage is incomplete; selected up to four spatially distinct, hybrid-ranked images with motion score at most 0.4 per populated sector across ${boundedAzimuthBins} azimuth bins.`,
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
    reason: `Only ${boundedSelectedIds.length} stationary sector images across ${boundedAzimuthBins} azimuth bins were available; exported all images for downstream SfM recovery.`,
  };
}

function selectedIds(
  cells: CaptureCoverageCell[],
  availableFrameIds: ReadonlySet<number>,
  frames: readonly CaptureFrame[],
): number[] {
  const frameById = new Map(frames.map((frame) => [frame.id, frame]));
  return Array.from(new Set(cells.flatMap((cell) => (
    (cell.selectedFrameIds ?? [])
      .filter((id) => {
        const frame = frameById.get(id);
        return availableFrameIds.has(id) && frame &&
          frame.quality.motionScore <= MAXIMUM_DESTINATION_MOTION_SCORE;
      })
      .sort((leftId, rightId) => compareExportFrames(frameById.get(leftId)!, frameById.get(rightId)!))
      .slice(0, MAXIMUM_DESTINATION_IMAGES_PER_CELL)
  ))))
    .sort((left, right) => left - right);
}

function compareExportFrames(left: CaptureFrame, right: CaptureFrame): number {
  const leftHybrid = left.quality.sharpFramesHybridScore;
  const rightHybrid = right.quality.sharpFramesHybridScore;
  if (Number.isFinite(leftHybrid) && Number.isFinite(rightHybrid) && leftHybrid !== rightHybrid) {
    return rightHybrid! - leftHybrid!;
  }
  const sharpnessDifference = left.quality.blurScore - right.quality.blurScore;
  if (sharpnessDifference !== 0) return sharpnessDifference;
  const motionDifference = left.quality.motionScore - right.quality.motionScore;
  return motionDifference !== 0 ? motionDifference : left.id - right.id;
}

function coveredAzimuthBins(
  cells: CaptureCoverageCell[],
  availableFrameIds: ReadonlySet<number>,
): number {
  return new Set(
    cells
      .filter((cell) => (cell.selectedFrameIds ?? []).some((id) => availableFrameIds.has(id)))
      .map((cell) => cell.azimuthBin),
  ).size;
}

function destinationInstructions(
  profile: Exclude<ExportProfile, "canonical">,
  imageSelection: DestinationImageSelection,
  capture: CaptureMetadata,
  readinessStatus?: CaptureReadinessStatus,
): string {
  const photoMode = capture.captureMode === "photo-sfm";
  const selectionNote = imageSelection.mode === "all-images-fallback"
    ? photoMode
      ? `The images directory contains all ${imageSelection.selectedImageCount} accepted autofocus photographs.`
      : `The sector sample was too sparse to filter safely, so the images directory contains all ${imageSelection.sourceImageCount} source images.`
    : `The images directory contains ${imageSelection.selectedImageCount} sharp stationary sector frames selected from ${imageSelection.sourceImageCount} source images.`;
  const readinessWarning = readinessStatus && readinessStatus !== "ready"
    ? `WARNING: capture preflight status is ${readinessStatus.toUpperCase()}. Review open3dcapture/preflight/readiness.json before reconstruction.`
    : undefined;
  if (profile === "spirula") {
    return [
      "Open Web 3D Capture — Spirula Studio handoff",
      "",
      readinessWarning,
      readinessWarning ? "" : undefined,
      "1. Extract this ZIP.",
      "2. In Spirula Studio choose Create Dataset from Photos/Video.",
      "3. Select the extracted images directory.",
      "4. Run Spirula's native SfM (or its COLMAP workflow) before training.",
      "",
      "This package intentionally has no root transforms.json, sparse/, or colmap/ marker.",
      photoMode
        ? "These autofocus photographs are intentionally unposed. Spirula SfM must register them before training."
        : "WebXR poses are navigation priors stored under open3dcapture/telemetry; they are not final training poses.",
      selectionNote,
      "",
    ].filter((line): line is string => line !== undefined).join("\n");
  }
  return [
    "Open Web 3D Capture — LichtFeld Studio handoff",
    "",
    readinessWarning,
    readinessWarning ? "" : undefined,
    "1. Extract this ZIP.",
    "2. In LichtFeld Studio's plugin browser, install COLMAP Reconstruction (community:colmap) if it is absent. It requires LichtFeld 0.5.0 or newer.",
    "3. Start the COLMAP Reconstruction plugin.",
    "4. Select the extracted images directory as the photo input.",
    "5. Run sparse reconstruction, inspect its quality metrics, then import/train.",
    "",
    "This package intentionally contains no fabricated COLMAP model.",
    photoMode
      ? "These autofocus photographs are intentionally unposed. COLMAP must register them before training."
      : "WebXR poses are navigation priors stored under open3dcapture/telemetry; they are not final training poses.",
    selectionNote,
    "",
  ].filter((line): line is string => line !== undefined).join("\n");
}
