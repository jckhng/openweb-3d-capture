import { toNerfstudioTransform } from "../shared/matrix";
import type { CaptureDataset, CaptureFrame, CaptureMetadata, IMUSample } from "../shared/types";

export interface NerfstudioFrame {
  file_path: string;
  transform_matrix: number[][];
}

export interface NerfstudioTransforms {
  camera_model: "OPENCV";
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
  data: string | Blob;
}

export function buildNerfstudioTransforms(frames: CaptureFrame[]): NerfstudioTransforms {
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

  return result;
}

export function serializeFramesJsonl(frames: CaptureFrame[]): string {
  return frames.map((frame) => JSON.stringify(frame)).join("\n") + (frames.length ? "\n" : "");
}

export function serializeImuJsonl(samples: IMUSample[]): string {
  return samples.map((sample) => JSON.stringify(sample)).join("\n") + (samples.length ? "\n" : "");
}

export function serializeCaptureMetadata(metadata: CaptureMetadata): string {
  return JSON.stringify(metadata, null, 2) + "\n";
}

export function buildDatasetFiles(dataset: CaptureDataset): DatasetFile[] {
  const files: DatasetFile[] = [
    {
      path: "transforms.json",
      data: JSON.stringify(buildNerfstudioTransforms(dataset.frames), null, 2) + "\n",
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
  ];

  for (const [path, data] of dataset.images) files.push({ path, data });
  for (const [path, data] of dataset.depths) files.push({ path, data });
  return files;
}

