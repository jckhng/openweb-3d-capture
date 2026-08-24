export type Matrix4 = number[][];

export interface Intrinsics {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
}

export interface FrameQuality {
  blurScore: number;
  motionScore: number;
  noveltyScore: number;
  coverageGain: number;
}

export interface CaptureFrame {
  id: number;
  timestamp: number;
  imagePath?: string;
  width: number;
  height: number;
  intrinsics: Intrinsics;
  cameraToWorld: Matrix4;
  trackingState: string;
  imageSource?: "xr-camera" | "media-stream";
  imageSynchronized?: boolean;
  quality: FrameQuality;
  depthPath?: string;
  depthWidth?: number;
  depthHeight?: number;
  depthRawValueToMeters?: number;
  depthDataFormat?: string;
  normDepthBufferFromNormView?: Matrix4;
}

export interface IMUSample {
  timestamp: number;
  gyro?: [number, number, number];
  accel?: [number, number, number];
}

export type CaptureStatus = "incomplete" | "complete";

export interface CaptureMetadata {
  format: "open3dcapture";
  version: 1;
  captureId: string;
  createdAt: string;
  updatedAt: string;
  captureMode: "diagnostic" | "object" | "scene";
  source: "webxr" | "replay";
  units: "meters";
  frameCount: number;
  hasDepth: boolean;
  hasImu: boolean;
  status: CaptureStatus;
  cameraResolution?: { width: number; height: number };
}

export interface CaptureDataset {
  capture: CaptureMetadata;
  frames: CaptureFrame[];
  imu: IMUSample[];
  images: Map<string, Blob>;
  depths: Map<string, Blob>;
}

export interface CapabilityEntry {
  available: boolean;
  detail: string;
}

export interface CapabilityReport {
  webxr: CapabilityEntry;
  immersiveAR: CapabilityEntry;
  cameraAccess: CapabilityEntry;
  rawXRCamera: CapabilityEntry;
  depth: CapabilityEntry;
  gyro: CapabilityEntry;
  accelerometer: CapabilityEntry;
  webgpu: CapabilityEntry;
  opfs: CapabilityEntry;
}
