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
  if (pointCloud) files.push(pointCloud);
  return files;
}
