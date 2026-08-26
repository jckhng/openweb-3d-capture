import { toNerfstudioTransform } from "../shared/matrix";
import type {
  CaptureDataset,
  CaptureDecision,
  CaptureFrame,
  CaptureMetadata,
  IMUSample,
} from "../shared/types";

export interface NerfstudioFrame {
  file_path: string;
  transform_matrix: number[][];
}

export interface NerfstudioTransforms {
  camera_model: "OPENCV";
  ply_file_path?: string;
  fl_x?: number;
  fl_y?: number;
  cx?: number;
  cy?: number;
  w?: number;
  h?: number;
  frames: NerfstudioFrame[];
}

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
): NerfstudioTransforms {
  const imageFrames = frames.filter((frame) => Boolean(frame.imagePath));
  const first = imageFrames[0];
  const result: NerfstudioTransforms = {
    camera_model: "OPENCV",
    frames: imageFrames.map((frame) => ({
      file_path: frame.imagePath as string,
      transform_matrix: toNerfstudioTransform(frame.cameraToWorld),
    })),
  };

  if (first) {
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
  const files: DatasetFile[] = [
    {
      path: "transforms.json",
      data: JSON.stringify(buildNerfstudioTransforms(dataset.frames, pointCloud?.path), null, 2) + "\n",
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

  for (const [path, data] of dataset.images) files.push({ path, data });
  for (const [path, data] of dataset.depths) files.push({ path, data });
  if (pointCloud) files.push(pointCloud);
  return files;
}
