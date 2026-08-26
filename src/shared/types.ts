export type Matrix4 = number[][];

export interface Intrinsics {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
}

export interface LensDistortion {
  k1: number;
  k2: number;
  p1: number;
  p2: number;
}

export interface CameraCalibration {
  cameraModel: "OPENCV";
  width: number;
  height: number;
  intrinsics: Intrinsics;
  distortion: LensDistortion;
}

export interface FrameQuality {
  blurScore: number;
  motionScore: number;
  noveltyScore: number;
  coverageGain: number;
}

export type CaptureDecisionReason =
  | "accepted"
  | "tracking"
  | "image-unavailable"
  | "unsynchronized-image"
  | "too-close"
  | "blur"
  | "motion"
  | "redundant";

export interface CaptureDecision {
  candidateId: number;
  acceptedFrameId?: number;
  timestamp: number;
  accepted: boolean;
  reason: CaptureDecisionReason;
  trackingState: string;
  cameraToWorld: Matrix4;
  sharpnessScore: number;
  linearVelocity: number;
  angularVelocity: number;
  translationNovelty: number;
  rotationNovelty: number;
  targetDistance?: number;
  quality: FrameQuality;
}

export interface CaptureFrame {
  id: number;
  timestamp: number;
  imagePath?: string;
  width: number;
  height: number;
  intrinsics: Intrinsics;
  /** Original metric WebXR pose. `cameraToWorld` remains its legacy alias. */
  webxrCameraToWorld?: Matrix4;
  cameraToWorld: Matrix4;
  /** Visually refined pose aligned into the original WebXR metric world. */
  refinedCameraToWorld?: Matrix4;
  poseCorrection?: {
    translationMeters: number;
    rotationRadians: number;
  };
  visualValidation?: {
    observationCount: number;
    medianReprojectionErrorPixels: number;
    p90ReprojectionErrorPixels: number;
  };
  trackingState: string;
  imageSource?: "xr-camera" | "media-stream";
  imageSynchronized?: boolean;
  targetDistance?: number;
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
  decisions: CaptureDecision[];
  imu: IMUSample[];
  images: Map<string, Blob>;
  depths: Map<string, Blob>;
  refinement?: DatasetRefinement;
}

export interface DatasetRefinement {
  method: string;
  calibration: CameraCalibration;
  registeredFrameCount: number;
  totalFrameCount: number;
  medianReprojectionErrorPixels: number;
  p90ReprojectionErrorPixels: number;
  directTrainReady: boolean;
  fallbackReason?: string;
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
