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
  /** Experimental target-tiled denoised Laplacian–Tenengrad score. */
  sharpFramesHybridScore?: number;
  motionScore: number;
  noveltyScore: number;
  coverageGain: number;
}

export type CaptureDecisionReason =
  | "accepted"
  | "checkpoint-burst"
  | "sector-full"
  | "tracking"
  | "image-unavailable"
  | "unsynchronized-image"
  | "off-target"
  | "settling"
  | "viewpoint-too-close"
  | "too-close"
  | "low-texture"
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
  sharpFramesHybridScore?: number;
  textureScore?: number;
  sharpnessThreshold?: number;
  linearVelocity: number;
  angularVelocity: number;
  translationNovelty: number;
  rotationNovelty: number;
  targetDistance?: number;
  targetNdc?: [number, number];
  targetInFront?: boolean;
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

/**
 * A full-resolution browser-camera photograph that deliberately has no pose.
 * It must be registered by downstream SfM before reconstruction or training.
 */
export interface UnposedPhoto {
  id: number;
  timestamp: number;
  capturedAt: string;
  imagePath: string;
  width: number;
  height: number;
  poseStatus: "unposed";
  imageSource: "image-capture";
  imageSynchronized: false;
  quality: Pick<FrameQuality, "blurScore" | "sharpFramesHybridScore"> & {
    sharpnessScore: number;
    textureScore: number;
    previewMotionScore: number;
  };
  camera: {
    focusMode?: string;
    focusDistance?: number;
    exposureMode?: string;
    exposureTime?: number;
    iso?: number;
    whiteBalanceMode?: string;
    zoom?: number;
    burstSize: number;
    selectedBurstIndex: number;
    focusPoint?: [number, number];
  };
}

export interface IMUSample {
  timestamp: number;
  gyro?: [number, number, number];
  accel?: [number, number, number];
}

export type CaptureStatus = "incomplete" | "complete";

export type CaptureReadinessStatus = "ready" | "add-views" | "capture-risk";

export type CaptureCoverageLatitude = "low" | "level" | "raised" | "high";

export interface CaptureCoverageCell {
  azimuthBin: number;
  latitude: CaptureCoverageLatitude;
  required: boolean;
  frameCount: number;
  stableFrameCount: number;
  bestSharpness: number;
  selectedFrameIds: number[];
  state: "empty" | "sampled" | "captured";
}

export type CaptureReadinessReasonCode =
  | "insufficient-frames"
  | "missing-images"
  | "unsynchronized-images"
  | "soft-accepted-images"
  | "missing-coverage-checkpoints"
  | "missing-azimuth"
  | "missing-elevation"
  | "visual-check-unavailable"
  | "visual-disconnected"
  | "weak-bridge"
  | "loop-not-closed";

export interface CaptureReadinessIssue {
  code: CaptureReadinessReasonCode;
  severity: "repair" | "risk";
  message: string;
  action: string;
  frameRange?: [number, number];
}

export interface CaptureReadinessReport {
  format: "open3dcapture-readiness";
  version: 1;
  status: CaptureReadinessStatus;
  primaryAction: string;
  generatedAt: string;
  metrics: {
    acceptedFrames: number;
    imageFrames: number;
    synchronizedImageFrames: number;
    synchronizedImageRatio: number;
    p10AcceptedSharpness: number;
    azimuthBinsCovered: number;
    azimuthBinCount: number;
    missingAzimuthBins: number[];
    elevationBandsCovered: Array<"low" | "level" | "high">;
    elevationSpanDegrees: number;
    coverageCells?: CaptureCoverageCell[];
    coverageCheckpointsCompleted?: number;
    coverageCheckpointsRequired?: number;
    currentCoverageCell?: {
      azimuthBin: number;
      latitude: CaptureCoverageLatitude;
    };
    targetEstimate?: [number, number, number];
    visualConnectedFrames: number;
    visualComponentCount: number;
    adjacentEdgeCoverage: number;
    loopClosureDetected: boolean;
    physicalLoopClosed: boolean;
  };
  issues: CaptureReadinessIssue[];
}

export interface CaptureReadinessSummary {
  status: CaptureReadinessStatus;
  primaryAction: string;
  issueCodes: CaptureReadinessReasonCode[];
}

export interface CaptureMetadata {
  format: "open3dcapture";
  version: 1;
  captureId: string;
  createdAt: string;
  updatedAt: string;
  captureMode: "diagnostic" | "object" | "scene" | "photo-sfm";
  source: "webxr" | "replay" | "media-stream";
  units: "meters";
  frameCount: number;
  hasDepth: boolean;
  hasImu: boolean;
  status: CaptureStatus;
  applicationBuild?: {
    builtAt: string;
  };
  cameraResolution?: { width: number; height: number };
  target?: {
    worldPoint: [number, number, number];
    distanceMeters: number;
    source: "depth-center" | "assumed-distance";
    lockedAt: string;
  };
  readiness?: CaptureReadinessSummary;
  handoff?: {
    poseAuthority: "downstream-sfm";
    imagesAreUnposed: true;
    minimumRecommendedImages: number;
  };
}

export interface CaptureDataset {
  capture: CaptureMetadata;
  frames: CaptureFrame[];
  decisions: CaptureDecision[];
  imu: IMUSample[];
  images: Map<string, Blob>;
  depths: Map<string, Blob>;
  candidatePreviews?: Map<string, Blob>;
  unposedPhotos?: UnposedPhoto[];
  refinement?: DatasetRefinement;
  visualTracking?: VisualTrackingReport;
  readiness?: CaptureReadinessReport;
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

export interface VisualTrackingEdge {
  frameA: number;
  frameB: number;
  kind: "adjacent" | "recovery" | "loop";
  matcher?: "brief" | "gradient";
  matches: number;
  geometricInliers?: number;
  geometricInlierRatio?: number;
  /** Inliers whose observations both fall inside the centered target-region proxy. */
  targetRegionInliers?: number;
  targetRegionInlierRatio?: number;
  medianResidualPixels: number;
  p90ResidualPixels: number;
  accepted: boolean;
}

export interface VisualPoseConstraint {
  frameA: number;
  frameB: number;
  kind: "adjacent" | "recovery" | "loop";
  matches: Array<{
    pointA: [number, number];
    pointB: [number, number];
    /** Stable within a frame; used to join pair matches into multi-view tracks. */
    featureA?: string;
    featureB?: string;
  }>;
}

export interface VisualTrackingReport {
  format: "open3dcapture-visual-tracking";
  version: 1;
  state: "unavailable" | "collecting" | "weak" | "calibration-ready";
  frameCount: number;
  connectedFrameCount: number;
  componentCount: number;
  loopClosures: number;
  medianResidualPixels: number;
  p90ResidualPixels: number;
  readyForCalibration: boolean;
  readyForGlobalOptimization: boolean;
  directTrainReady: false;
  fallbackReason: string;
  calibrationEstimate?: {
    model: "FOCAL_SCALE_K1";
    observationEdges: number;
    observationMatches: number;
    focalScale: number;
    intrinsics: Intrinsics;
    distortion: LensDistortion;
    initialMedianResidualPixels: number;
    estimatedMedianResidualPixels: number;
  };
  processing?: {
    capturePhaseFrames: number;
    capturePhaseTotalMilliseconds: number;
    capturePhaseMaximumFrameMilliseconds: number;
    deferredRefinementMilliseconds: number;
    retainedGrayBytes: number;
    captureMaximumDimension?: number;
    deferredMaximumDimension?: number;
    deferredMaximumFeatures?: number;
    deferredMatchRatio?: number;
    phase?: "capture" | "deferred" | "complete";
    deferredRepairAttempts?: number;
    deferredMaximumRepairAttempts?: number;
  };
  /** Added only to the final report so live worker updates stay small. */
  poseConstraints?: VisualPoseConstraint[];
  /** Informational only until target-region thresholds are calibrated on hardware. */
  targetRegion?: {
    linearFraction: number;
    featureObservations: number;
    targetRegionFeatureObservations: number;
    targetRegionFeatureFraction: number;
    acceptedEdges: number;
    edgesWithTargetRegionInliers: number;
    geometricInliers: number;
    targetRegionInliers: number;
    targetRegionInlierFraction: number;
  };
  edges: VisualTrackingEdge[];
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
