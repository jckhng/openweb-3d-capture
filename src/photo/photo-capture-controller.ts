import { exportDatasetZip, type ExportProfile } from "../dataset/zip";
import { DEFAULT_QUALITY_SELECTOR_CONFIG } from "../keyframes/quality-selector";
import { analyzeTargetImageQuality, type ImageQualityAnalysis } from "../quality/sharpness";
import { extractBriefFeatures } from "../refinement/features";
import { BUILD_TIMESTAMP } from "../shared/build";
import type {
  CaptureCoverageCell,
  CaptureMetadata,
  PhotoCaptureGuidance,
  UnposedPhoto,
} from "../shared/types";
import { makeCaptureId, type CapturePersistence } from "../storage/storage";
import {
  measurePhotoOverlap,
  photoCapturePrompt,
  buildPhotoCoverageCells,
  buildGuidedPhotoCoverageCells,
  guidedPhotoPrompt,
  PHOTO_TARGET,
  type PhotoCoverageSample,
  type PhotoFeatureSignature,
  type PhotoOverlapMetrics,
} from "./photo-guidance";
import { PhotoVisualNavigator } from "./photo-visual-navigation";

const BURST_SIZE = 3;
const PREVIEW_SAMPLE_COUNT = 7;
const PREVIEW_SAMPLE_INTERVAL_MS = 120;
const MAXIMUM_PREVIEW_MOTION = 0.065;
const MINIMUM_PHOTO_SHARPNESS = 0.32;
const NAVIGATION_SAMPLE_INTERVAL = 2;

type PhotoPhase = "closed" | "preview" | "capturing" | "complete";
export type PhotoCaptureStage =
  | "idle"
  | "move"
  | "ready"
  | "focusing"
  | "settling"
  | "burst"
  | "selecting"
  | "overlap"
  | "saving"
  | "saved"
  | "rejected";

export interface PhotoCaptureSnapshot {
  phase: PhotoPhase;
  captureId?: string;
  lastCaptureId?: string;
  photoCount: number;
  target: number;
  rejectedCount: number;
  focusMode: string;
  focusDistance?: number;
  previewResolution?: { width: number; height: number };
  photoResolution?: { width: number; height: number };
  lastQuality?: ImageQualityAnalysis & { previewMotionScore: number };
  liveQuality?: ImageQualityAnalysis & { previewMotionScore: number; ready: boolean };
  lastOverlap?: PhotoOverlapMetrics;
  stage: PhotoCaptureStage;
  stageProgress: number;
  burstFrame: number;
  automaticCapture: boolean;
  guidanceMode: "manual" | "visual-navigation";
  guidance?: PhotoCaptureGuidance;
  navigationOrientationAvailable: boolean;
  coverageCells: CaptureCoverageCell[];
  cameraStreamState: "closed" | "live" | "muted" | "ended";
  lastPhotoPreviewUrl?: string;
  instruction: string;
  lastError?: string;
}

interface ExtendedTrackCapabilities extends MediaTrackCapabilities {
  focusMode?: string[];
  pointsOfInterest?: boolean;
}

interface ExtendedTrackSettings extends MediaTrackSettings {
  exposureMode?: string;
  exposureTime?: number;
  focusDistance?: number;
  focusMode?: string;
  iso?: number;
}

interface ExtendedConstraintSet extends MediaTrackConstraintSet {
  exposureMode?: ConstrainDOMString;
  focusMode?: ConstrainDOMString;
  pointsOfInterest?: Array<{ x: number; y: number }>;
}

interface PreviewSample {
  quality: ImageQualityAnalysis;
  luminance: Uint8Array;
  gray: { width: number; height: number; data: Uint8Array };
}

interface ScoredPhoto {
  blob: Blob;
  width: number;
  height: number;
  quality: ImageQualityAnalysis;
  gray: { width: number; height: number; data: Uint8Array };
}

type Listener = (snapshot: PhotoCaptureSnapshot) => void;

export class PhotoCaptureController {
  private readonly listeners = new Set<Listener>();
  private readonly qualityCanvas = document.createElement("canvas");
  private stream?: MediaStream;
  private track?: MediaStreamTrack;
  private imageCapture?: ImageCapture;
  private preferredPhotoSettings?: PhotoSettings;
  private video?: HTMLVideoElement;
  private activeMetadata?: CaptureMetadata;
  private recentSharpness: number[] = [];
  private readonly signatures: Array<{ photoId: number; signature: PhotoFeatureSignature }> = [];
  private readonly guidanceSamples: PhotoCoverageSample[] = [];
  private readonly visualNavigator = new PhotoVisualNavigator();
  private currentGuidance?: PhotoCaptureGuidance;
  private navigationTick = 0;
  private previewTimer?: number;
  private previousPreview?: PreviewSample;
  private movementObserved = true;
  private automaticCaptureEligibleAt = 0;
  private lastPhotoPreviewUrl?: string;
  private readonly snapshot: PhotoCaptureSnapshot = {
    phase: "closed",
    photoCount: 0,
    target: PHOTO_TARGET,
    rejectedCount: 0,
    focusMode: "unavailable",
    stage: "idle",
    stageProgress: 0,
    burstFrame: 0,
    automaticCapture: false,
    guidanceMode: "manual",
    navigationOrientationAvailable: false,
    coverageCells: buildPhotoCoverageCells(0),
    cameraStreamState: "closed",
    instruction: "Open the autofocus camera for a close-focus photo scan.",
  };

  constructor(private readonly persistence: CapturePersistence) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): PhotoCaptureSnapshot {
    return structuredClone(this.snapshot);
  }

  async open(video: HTMLVideoElement): Promise<void> {
    if (this.stream) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Browser camera capture is unavailable");
    }
    if (!("ImageCapture" in window)) {
      throw new Error("Full-resolution ImageCapture is unavailable in this browser");
    }
    this.snapshot.lastError = undefined;
    let stream: MediaStream | undefined;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      });
      const track = stream.getVideoTracks()[0];
      if (!track) throw new Error("No camera video track was returned");
      this.stream = stream;
      this.track = track;
      track.addEventListener("mute", this.handleTrackMute);
      track.addEventListener("unmute", this.handleTrackUnmute);
      track.addEventListener("ended", this.handleTrackEnded);
      this.imageCapture = new ImageCapture(track);
      this.preferredPhotoSettings = await preferredPhotoSettings(this.imageCapture);
      this.video = video;
      video.srcObject = stream;
      await video.play();
      await waitForVideoDimensions(video);
      await this.configureAutofocus(track);
      const settings = track.getSettings() as ExtendedTrackSettings;
      this.snapshot.phase = "preview";
      this.snapshot.previewResolution = {
        width: settings.width ?? video.videoWidth,
        height: settings.height ?? video.videoHeight,
      };
      this.snapshot.focusMode = settings.focusMode ?? this.snapshot.focusMode;
      this.snapshot.focusDistance = settings.focusDistance;
      this.snapshot.cameraStreamState = track.muted ? "muted" : "live";
      this.snapshot.stage = "idle";
      this.snapshot.stageProgress = 0;
      this.snapshot.instruction = "Center the close subject, then start the photo scan.";
      this.emit();
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      this.resetCamera();
      throw error;
    }
  }

  async startCapture(): Promise<void> {
    if (!this.stream || !this.track || !this.imageCapture) {
      throw new Error("Open the autofocus camera first");
    }
    if (this.activeMetadata) throw new Error("A photo scan is already active");
    await requestDeviceOrientationPermission();
    const now = new Date().toISOString();
    const metadata: CaptureMetadata = {
      format: "open3dcapture",
      version: 1,
      captureId: makeCaptureId(),
      createdAt: now,
      updatedAt: now,
      captureMode: "photo-sfm",
      source: "media-stream",
      units: "meters",
      frameCount: 0,
      hasDepth: false,
      hasImu: false,
      status: "incomplete",
      applicationBuild: { builtAt: BUILD_TIMESTAMP },
      handoff: {
        poseAuthority: "downstream-sfm",
        imagesAreUnposed: true,
        minimumRecommendedImages: PHOTO_TARGET,
        guidanceSource: "visual-navigation",
        guidanceOnly: true,
      },
    };
    await this.persistence.createCapture(metadata);
    this.revokeLastPhotoPreview();
    this.activeMetadata = metadata;
    this.recentSharpness = [];
    this.signatures.length = 0;
    this.guidanceSamples.length = 0;
    this.visualNavigator.reset();
    this.navigationTick = 0;
    this.currentGuidance = undefined;
    window.addEventListener("deviceorientation", this.handleDeviceOrientation);
    this.previousPreview = undefined;
    this.movementObserved = true;
    this.automaticCaptureEligibleAt = Date.now() + 600;
    this.snapshot.captureId = metadata.captureId;
    this.snapshot.photoCount = 0;
    this.snapshot.rejectedCount = 0;
    this.snapshot.lastQuality = undefined;
    this.snapshot.liveQuality = undefined;
    this.snapshot.lastOverlap = undefined;
    this.snapshot.guidanceMode = "visual-navigation";
    this.snapshot.guidance = undefined;
    this.snapshot.navigationOrientationAvailable = false;
    this.snapshot.coverageCells = buildPhotoCoverageCells(0);
    this.snapshot.stage = "move";
    this.snapshot.stageProgress = 0;
    this.snapshot.burstFrame = 0;
    this.snapshot.instruction = this.capturePrompt();
    this.startPreviewMonitor();
    this.emit();
  }

  setAutomaticCapture(enabled: boolean): void {
    this.snapshot.automaticCapture = enabled;
    this.automaticCaptureEligibleAt = Date.now() + 500;
    if (enabled) this.movementObserved = true;
    this.emit();
  }

  async capturePhoto(): Promise<void> {
    const metadata = this.activeMetadata;
    const imageCapture = this.imageCapture;
    const track = this.track;
    const video = this.video;
    if (!metadata || !imageCapture || !track || !video) {
      throw new Error("Start a photo scan first");
    }
    if (this.snapshot.phase === "capturing") return;
    const captureGuidance = this.snapshot.guidanceMode === "visual-navigation" && this.currentGuidance
      ? { ...this.currentGuidance }
      : undefined;
    const guidanceIssue = this.guidanceIssue(captureGuidance);
    if (guidanceIssue) {
      this.reject(guidanceIssue, true);
      return;
    }

    this.snapshot.phase = "capturing";
    this.snapshot.stage = "focusing";
    this.snapshot.stageProgress = 0.08;
    this.snapshot.burstFrame = 0;
    this.snapshot.instruction = "FOCUSING — keep the object centered.";
    this.snapshot.lastError = undefined;
    this.emit();

    try {
      await this.requestCenterFocus(track);
      this.snapshot.stage = "settling";
      this.snapshot.stageProgress = 0.14;
      this.snapshot.instruction = "HOLD STEADY — waiting for the image to settle.";
      this.emit();
      const previewMotionScore = await this.waitForStablePreview(video);
      if (previewMotionScore > MAXIMUM_PREVIEW_MOTION) {
        this.reject(`Camera still moving (${Math.round(previewMotionScore * 100)}%). Hold still and try again.`);
        return;
      }

      const burst: ScoredPhoto[] = [];
      for (let index = 0; index < BURST_SIZE; index += 1) {
        this.snapshot.stage = "burst";
        this.snapshot.burstFrame = index + 1;
        this.snapshot.stageProgress = 0.38 + index * 0.12;
        this.snapshot.instruction = `CAPTURING BURST ${index + 1} / ${BURST_SIZE} — hold still.`;
        this.emit();
        try {
          const source = await takeMaximumResolutionPhoto(imageCapture, this.preferredPhotoSettings);
          const jpeg = await normalizeJpeg(source);
          burst.push(await scorePhoto(jpeg, this.qualityCanvas));
        } catch (error) {
          if (!burst.length) throw error;
          break;
        }
        if (index + 1 < BURST_SIZE) await delay(100);
      }
      this.snapshot.stage = "selecting";
      this.snapshot.stageProgress = 0.72;
      this.snapshot.instruction = "SELECTING — comparing sharpness across the burst.";
      this.emit();
      const selectedIndex = bestPhotoIndex(burst);
      const selected = burst[selectedIndex];
      const threshold = this.sharpnessThreshold();
      const result = { ...selected.quality, previewMotionScore };
      this.snapshot.lastQuality = result;
      if (selected.quality.textureScore < DEFAULT_QUALITY_SELECTOR_CONFIG.minimumTexture) {
        this.reject("Subject region has too little detail to verify focus. Aim the reticle at a textured edge.");
        return;
      }
      if (selected.quality.sharpnessScore < threshold) {
        this.reject(`Best burst image was soft (${Math.round(selected.quality.sharpnessScore * 100)}%; need ${Math.round(threshold * 100)}%). Hold still or improve light.`);
        return;
      }

      this.snapshot.stage = "overlap";
      this.snapshot.stageProgress = 0.82;
      this.snapshot.instruction = "CHECKING VIEW — measuring overlap and viewpoint change.";
      this.emit();
      const selectedSignature: PhotoFeatureSignature = {
        width: selected.gray.width,
        height: selected.gray.height,
        features: extractBriefFeatures(selected.gray, {
          maximumFeatures: 320,
          fastThreshold: 18,
          cellSize: 14,
        }),
      };
      const overlap = measurePhotoOverlap(selectedSignature, this.signatures);
      this.snapshot.lastOverlap = overlap;
      if (overlap.verdict === "too-similar") {
        this.reject("TOO SIMILAR — take a wider sideways step within this sector.", true);
        return;
      }
      if (overlap.verdict === "low-overlap") {
        this.reject("LOW OVERLAP — move closer to the previous viewpoint and keep the object centered.", true);
        return;
      }

      const id = this.snapshot.photoCount;
      const settings = track.getSettings() as ExtendedTrackSettings;
      const photo: UnposedPhoto = {
        id,
        timestamp: performance.now(),
        capturedAt: new Date().toISOString(),
        imagePath: `images/${String(id).padStart(6, "0")}.jpg`,
        width: selected.width,
        height: selected.height,
        poseStatus: "unposed",
        imageSource: "image-capture",
        imageSynchronized: false,
        quality: {
          blurScore: 1 - selected.quality.sharpnessScore,
          sharpnessScore: selected.quality.sharpnessScore,
          sharpFramesHybridScore: selected.quality.sharpFramesHybridScore,
          textureScore: selected.quality.textureScore,
          previewMotionScore,
        },
        camera: {
          focusMode: settings.focusMode,
          focusDistance: settings.focusDistance,
          exposureMode: settings.exposureMode,
          exposureTime: settings.exposureTime,
          iso: settings.iso,
          whiteBalanceMode: settings.whiteBalanceMode,
          zoom: settings.zoom,
          burstSize: burst.length,
          selectedBurstIndex: selectedIndex,
          focusPoint: [0.5, 0.5],
        },
        visualGuidance: {
          verdict: overlap.verdict,
          matches: overlap.matches,
          matchRatio: overlap.matchRatio,
          medianDisplacement: overlap.medianDisplacement,
          referencePhotoId: overlap.referencePhotoId,
        },
        captureGuidance,
      };
      this.snapshot.stage = "saving";
      this.snapshot.stageProgress = 0.92;
      this.snapshot.instruction = "SAVING LOCALLY — keep this screen open.";
      this.emit();
      await this.persistence.appendUnposedPhoto(metadata.captureId, photo, selected.blob);
      this.visualNavigator.acceptCurrent();
      this.signatures.push({ photoId: id, signature: selectedSignature });
      this.recentSharpness.push(selected.quality.sharpnessScore);
      if (this.recentSharpness.length > 24) this.recentSharpness.shift();
      this.snapshot.photoCount += 1;
      if (captureGuidance) {
        this.guidanceSamples.push({
          photoId: id,
          azimuthBin: captureGuidance.azimuthBin,
          latitude: captureGuidance.latitude,
        });
        this.snapshot.coverageCells = buildGuidedPhotoCoverageCells(this.guidanceSamples);
      } else {
        this.snapshot.coverageCells = buildPhotoCoverageCells(this.snapshot.photoCount);
      }
      this.snapshot.photoResolution = { width: selected.width, height: selected.height };
      this.snapshot.focusMode = settings.focusMode ?? this.snapshot.focusMode;
      this.snapshot.focusDistance = settings.focusDistance;
      this.setLastPhotoPreview(selected.blob);
      this.snapshot.stage = "saved";
      this.snapshot.stageProgress = 1;
      this.snapshot.instruction = `VIEW SAVED — ${this.capturePrompt()}`;
      this.movementObserved = false;
      this.previousPreview = undefined;
      this.automaticCaptureEligibleAt = Date.now() + 900;
      if ("vibrate" in navigator) navigator.vibrate([35, 25, 55]);
    } catch (error) {
      this.snapshot.lastError = errorMessage(error);
      this.snapshot.stage = "rejected";
      this.snapshot.stageProgress = 0;
      this.snapshot.instruction = "Photo failed. Keep the subject centered and retry this view.";
    } finally {
      this.snapshot.phase = "preview";
      this.emit();
    }
  }

  async finishCapture(): Promise<string> {
    const metadata = this.activeMetadata;
    if (!metadata) throw new Error("No photo scan is active");
    if (this.snapshot.photoCount === 0) throw new Error("Capture at least one photograph before finishing");
    metadata.frameCount = this.snapshot.photoCount;
    metadata.cameraResolution = this.snapshot.photoResolution;
    metadata.updatedAt = new Date().toISOString();
    metadata.status = "complete";
    await this.persistence.finalizeCapture(metadata.captureId, metadata);
    this.stopPreviewMonitor();
    this.stopVisualNavigation();
    this.activeMetadata = undefined;
    this.snapshot.captureId = undefined;
    this.snapshot.lastCaptureId = metadata.captureId;
    this.snapshot.phase = "complete";
    this.snapshot.stage = "saved";
    this.snapshot.lastError = undefined;
    this.snapshot.instruction = this.snapshot.photoCount >= PHOTO_TARGET
      ? "Photo set saved. Run downstream SfM before training."
      : `Photo set saved with ${this.snapshot.photoCount} views; ${PHOTO_TARGET}+ is recommended before downstream SfM.`;
    this.stopCameraTracks();
    this.emit();
    return metadata.captureId;
  }

  async exportCapture(captureId: string, profile: ExportProfile): Promise<{ blob: Blob; filename: string }> {
    const dataset = await this.persistence.loadCapture(captureId);
    return {
      blob: await exportDatasetZip(dataset, profile),
      filename: profile === "canonical"
        ? `${captureId}.zip`
        : `${captureId}-${profile}.zip`,
    };
  }

  async close(): Promise<void> {
    this.stopPreviewMonitor();
    this.stopVisualNavigation();
    if (this.activeMetadata) {
      const metadata = this.activeMetadata;
      metadata.frameCount = this.snapshot.photoCount;
      metadata.cameraResolution = this.snapshot.photoResolution;
      metadata.updatedAt = new Date().toISOString();
      metadata.status = "incomplete";
      await this.persistence.finalizeCapture(metadata.captureId, metadata);
      this.activeMetadata = undefined;
    }
    this.stopCameraTracks();
    this.snapshot.phase = "closed";
    this.snapshot.stage = "idle";
    this.snapshot.stageProgress = 0;
    this.snapshot.captureId = undefined;
    this.snapshot.lastError = undefined;
    this.snapshot.instruction = "Open the autofocus camera for a close-focus photo scan.";
    this.emit();
  }

  async dispose(): Promise<void> {
    await this.close();
    this.revokeLastPhotoPreview();
    this.listeners.clear();
  }

  private async configureAutofocus(track: MediaStreamTrack): Promise<void> {
    const capabilities = track.getCapabilities() as ExtendedTrackCapabilities;
    const focusMode = capabilities.focusMode?.includes("continuous")
      ? "continuous"
      : capabilities.focusMode?.includes("single-shot")
        ? "single-shot"
        : undefined;
    const exposureMode = (capabilities as ExtendedTrackCapabilities & { exposureMode?: string[] })
      .exposureMode?.includes("continuous") ? "continuous" : undefined;
    if (!focusMode && !exposureMode) {
      this.snapshot.focusMode = capabilities.focusMode?.join(", ") || "browser default";
      return;
    }
    const advanced: ExtendedConstraintSet = {};
    if (focusMode) advanced.focusMode = focusMode;
    if (exposureMode) advanced.exposureMode = exposureMode;
    try {
      await track.applyConstraints({ advanced: [advanced] } as MediaTrackConstraints);
      this.snapshot.focusMode = focusMode ?? "browser default";
    } catch {
      this.snapshot.focusMode = "browser default";
    }
  }

  private async requestCenterFocus(track: MediaStreamTrack): Promise<void> {
    const capabilities = track.getCapabilities() as ExtendedTrackCapabilities;
    const advanced: ExtendedConstraintSet = {};
    if (capabilities.focusMode?.includes("single-shot")) advanced.focusMode = "single-shot";
    else if (capabilities.focusMode?.includes("continuous")) advanced.focusMode = "continuous";
    if (capabilities.pointsOfInterest) advanced.pointsOfInterest = [{ x: 0.5, y: 0.5 }];
    if (!Object.keys(advanced).length) return;
    try {
      await track.applyConstraints({ advanced: [advanced] } as MediaTrackConstraints);
    } catch {
      // Some Android camera stacks advertise controls but reject combinations.
      if (advanced.focusMode) {
        try {
          await track.applyConstraints(
            { advanced: [{ focusMode: advanced.focusMode }] } as unknown as MediaTrackConstraints,
          );
        } catch {
          // The camera's own autofocus behavior remains usable without constraints.
        }
      }
    }
  }

  private async waitForStablePreview(video: HTMLVideoElement): Promise<number> {
    let previous: PreviewSample | undefined;
    const recentMotion: number[] = [];
    for (let index = 0; index < PREVIEW_SAMPLE_COUNT; index += 1) {
      this.snapshot.stageProgress = 0.14 + (index + 1) / PREVIEW_SAMPLE_COUNT * 0.2;
      this.emit();
      const sample = samplePreview(video, this.qualityCanvas);
      if (previous) {
        recentMotion.push(luminanceDifference(previous.luminance, sample.luminance));
        if (recentMotion.length > 3) recentMotion.shift();
        if (recentMotion.length === 3 && Math.max(...recentMotion) <= MAXIMUM_PREVIEW_MOTION * 0.72) {
          return Math.max(...recentMotion);
        }
      }
      previous = sample;
      await delay(PREVIEW_SAMPLE_INTERVAL_MS);
    }
    return recentMotion.length ? Math.max(...recentMotion) : 1;
  }

  private sharpnessThreshold(): number {
    if (this.recentSharpness.length < 4) return MINIMUM_PHOTO_SHARPNESS;
    const sorted = [...this.recentSharpness].sort((a, b) => a - b);
    const baseline = sorted[Math.floor((sorted.length - 1) * 0.75)];
    return Math.max(MINIMUM_PHOTO_SHARPNESS, Math.min(0.5, baseline * 0.65));
  }

  private reject(message: string, requireMovement = false): void {
    this.snapshot.rejectedCount += 1;
    this.snapshot.lastError = message;
    this.snapshot.instruction = message;
    this.snapshot.phase = "preview";
    this.snapshot.stage = "rejected";
    this.snapshot.stageProgress = 0;
    this.automaticCaptureEligibleAt = Date.now() + 1200;
    if (requireMovement) this.movementObserved = false;
    if ("vibrate" in navigator) navigator.vibrate([80, 40, 80]);
    this.emit();
  }

  private stopCameraTracks(): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    if (this.video) this.video.srcObject = null;
    this.resetCamera();
  }

  private resetCamera(): void {
    if (this.track) {
      this.track.removeEventListener("mute", this.handleTrackMute);
      this.track.removeEventListener("unmute", this.handleTrackUnmute);
      this.track.removeEventListener("ended", this.handleTrackEnded);
    }
    this.stream = undefined;
    this.track = undefined;
    this.imageCapture = undefined;
    this.preferredPhotoSettings = undefined;
    this.video = undefined;
    this.snapshot.cameraStreamState = "closed";
  }

  private startPreviewMonitor(): void {
    this.stopPreviewMonitor();
    this.previewTimer = window.setInterval(() => this.updateLivePreview(), 420);
  }

  private stopPreviewMonitor(): void {
    if (this.previewTimer !== undefined) window.clearInterval(this.previewTimer);
    this.previewTimer = undefined;
    this.previousPreview = undefined;
  }

  private updateLivePreview(): void {
    const video = this.video;
    if (!video || !this.activeMetadata || this.snapshot.phase !== "preview") return;
    try {
      const sample = samplePreview(video, this.qualityCanvas);
      this.navigationTick += 1;
      if (this.navigationTick % NAVIGATION_SAMPLE_INTERVAL === 0 || !this.currentGuidance) {
        const navigation = this.visualNavigator.observe(sample.gray);
        this.currentGuidance = navigation.guidance;
        this.snapshot.guidance = navigation.guidance;
        this.snapshot.navigationOrientationAvailable = navigation.orientationAvailable;
      } else {
        const navigation = this.visualNavigator.getSnapshot();
        this.currentGuidance = navigation.guidance;
        this.snapshot.guidance = navigation.guidance;
        this.snapshot.navigationOrientationAvailable = navigation.orientationAvailable;
      }
      const hadPrevious = Boolean(this.previousPreview);
      const motion = this.previousPreview
        ? luminanceDifference(this.previousPreview.luminance, sample.luminance)
        : 0;
      this.previousPreview = sample;
      const sharpEnough = sample.quality.sharpnessScore >= this.sharpnessThreshold();
      const detailedEnough = sample.quality.textureScore >= DEFAULT_QUALITY_SELECTOR_CONFIG.minimumTexture;
      const steady = motion <= MAXIMUM_PREVIEW_MOTION * 0.72;
      const ready = steady && sharpEnough && detailedEnough;
      this.snapshot.liveQuality = { ...sample.quality, previewMotionScore: motion, ready };
      if (this.snapshot.stage === "saved" && Date.now() < this.automaticCaptureEligibleAt) {
        this.emit();
        return;
      }
      if (hadPrevious && !steady) {
        this.movementObserved = true;
        this.snapshot.lastError = undefined;
        this.snapshot.stage = "move";
        this.snapshot.stageProgress = 0;
        this.snapshot.instruction = this.capturePrompt();
      } else if (!this.movementObserved) {
        this.snapshot.stage = "move";
        this.snapshot.stageProgress = 0;
        this.snapshot.instruction = this.capturePrompt();
      } else if (this.guidanceIssue()) {
        this.snapshot.stage = "move";
        this.snapshot.stageProgress = 0;
        this.snapshot.instruction = this.guidanceIssue()!;
      } else if (!detailedEnough) {
        this.snapshot.stage = "move";
        this.snapshot.stageProgress = 0;
        this.snapshot.instruction = "AIM AT MORE DETAIL — keep a textured part of the object in the reticle.";
      } else if (!sharpEnough) {
        this.snapshot.stage = "settling";
        this.snapshot.stageProgress = 0.12;
        this.snapshot.instruction = "HOLD STEADY — waiting for sharper focus.";
      } else {
        this.snapshot.stage = "ready";
        this.snapshot.stageProgress = 0.18;
        this.snapshot.instruction = this.snapshot.automaticCapture
          ? "READY — automatic capture armed. Hold still."
          : "READY — arm this viewpoint when the object is centered.";
        if (
          this.snapshot.automaticCapture &&
          this.movementObserved &&
          Date.now() >= this.automaticCaptureEligibleAt
        ) {
          this.movementObserved = false;
          void this.capturePhoto();
          return;
        }
      }
      this.emit();
    } catch {
      // A transient video-frame read must not stop the preview or capture.
    }
  }

  private setLastPhotoPreview(blob: Blob): void {
    this.revokeLastPhotoPreview();
    this.lastPhotoPreviewUrl = URL.createObjectURL(blob);
    this.snapshot.lastPhotoPreviewUrl = this.lastPhotoPreviewUrl;
  }

  private revokeLastPhotoPreview(): void {
    if (this.lastPhotoPreviewUrl) URL.revokeObjectURL(this.lastPhotoPreviewUrl);
    this.lastPhotoPreviewUrl = undefined;
    this.snapshot.lastPhotoPreviewUrl = undefined;
  }

  private capturePrompt(): string {
    return this.snapshot.guidanceMode === "visual-navigation"
      ? guidedPhotoPrompt(this.currentGuidance, this.snapshot.coverageCells)
      : photoCapturePrompt(this.snapshot.photoCount);
  }

  private guidanceIssue(guidance = this.currentGuidance): string | undefined {
    if (this.snapshot.guidanceMode !== "visual-navigation") return undefined;
    const prompt = guidedPhotoPrompt(guidance, this.snapshot.coverageCells);
    if (this.snapshot.photoCount === 0 && guidance?.trackingState === "initializing") return undefined;
    return prompt.startsWith("BLUE SECTOR READY") || prompt.startsWith("VIEW 1 / 2 SAVED")
      ? undefined
      : prompt;
  }

  private stopVisualNavigation(): void {
    window.removeEventListener("deviceorientation", this.handleDeviceOrientation);
    this.visualNavigator.reset();
    this.currentGuidance = undefined;
  }

  private readonly handleDeviceOrientation = (event: DeviceOrientationEvent): void => {
    this.visualNavigator.updateOrientation(
      event.alpha,
      event.beta,
      event.gamma,
      screen.orientation?.angle ?? window.orientation ?? 0,
    );
  };

  private readonly handleTrackMute = (): void => {
    this.snapshot.cameraStreamState = "muted";
    this.emit();
  };

  private readonly handleTrackUnmute = (): void => {
    this.snapshot.cameraStreamState = "live";
    this.emit();
  };

  private readonly handleTrackEnded = (): void => {
    this.snapshot.cameraStreamState = "ended";
    this.snapshot.lastError = "Autofocus camera stream ended; save the partial set and reopen autofocus-only mode.";
    this.snapshot.automaticCapture = false;
    this.emit();
  };

  private emit(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}

async function requestDeviceOrientationPermission(): Promise<void> {
  if (!("DeviceOrientationEvent" in window)) return;
  const orientation = window.DeviceOrientationEvent as typeof DeviceOrientationEvent & {
    requestPermission?: () => Promise<"granted" | "denied">;
  };
  if (!orientation.requestPermission) return;
  try {
    await orientation.requestPermission();
  } catch {
    // Preview-only tracking remains available when sensor permission is denied.
  }
}

function samplePreview(video: HTMLVideoElement, canvas: HTMLCanvasElement): PreviewSample {
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  if (!sourceWidth || !sourceHeight) throw new Error("Camera preview is not ready");
  const cropWidth = Math.round(sourceWidth * 0.62);
  const cropHeight = Math.round(sourceHeight * 0.62);
  const width = Math.max(96, Math.round(384 * cropWidth / Math.max(cropWidth, cropHeight)));
  const height = Math.max(96, Math.round(384 * cropHeight / Math.max(cropWidth, cropHeight)));
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Camera quality analysis is unavailable");
  context.drawImage(
    video,
    Math.round((sourceWidth - cropWidth) / 2),
    Math.round((sourceHeight - cropHeight) / 2),
    cropWidth,
    cropHeight,
    0,
    0,
    width,
    height,
  );
  const pixels = context.getImageData(0, 0, width, height).data;
  const luminance = new Uint8Array(width * height);
  for (let source = 0, target = 0; source < pixels.length; source += 4, target += 1) {
    luminance[target] = Math.round(0.2126 * pixels[source] + 0.7152 * pixels[source + 1] + 0.0722 * pixels[source + 2]);
  }
  return {
    quality: analyzeTargetImageQuality(pixels, width, height),
    luminance,
    gray: { width, height, data: luminance },
  };
}

async function scorePhoto(blob: Blob, canvas: HTMLCanvasElement): Promise<ScoredPhoto> {
  const encodedDimensions = jpegDimensions(new Uint8Array(await blob.slice(0, 256 * 1024).arrayBuffer()));
  const bitmap = await createImageBitmap(blob);
  try {
    const cropWidth = Math.round(bitmap.width * 0.62);
    const cropHeight = Math.round(bitmap.height * 0.62);
    const width = Math.max(96, Math.round(512 * cropWidth / Math.max(cropWidth, cropHeight)));
    const height = Math.max(96, Math.round(512 * cropHeight / Math.max(cropWidth, cropHeight)));
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Photo quality analysis is unavailable");
    context.drawImage(
      bitmap,
      Math.round((bitmap.width - cropWidth) / 2),
      Math.round((bitmap.height - cropHeight) / 2),
      cropWidth,
      cropHeight,
      0,
      0,
      width,
      height,
    );
    const pixels = context.getImageData(0, 0, width, height).data;
    const luminance = new Uint8Array(width * height);
    for (let source = 0, target = 0; source < pixels.length; source += 4, target += 1) {
      luminance[target] = Math.round(
        0.2126 * pixels[source] + 0.7152 * pixels[source + 1] + 0.0722 * pixels[source + 2],
      );
    }
    return {
      blob,
      width: encodedDimensions?.width ?? bitmap.width,
      height: encodedDimensions?.height ?? bitmap.height,
      quality: analyzeTargetImageQuality(pixels, width, height),
      gray: { width, height, data: luminance },
    };
  } finally {
    bitmap.close();
  }
}

function bestPhotoIndex(photos: ScoredPhoto[]): number {
  let best = 0;
  for (let index = 1; index < photos.length; index += 1) {
    const current = photos[index].quality;
    const selected = photos[best].quality;
    if (current.textureScore >= DEFAULT_QUALITY_SELECTOR_CONFIG.minimumTexture &&
      (selected.textureScore < DEFAULT_QUALITY_SELECTOR_CONFIG.minimumTexture ||
        current.sharpnessScore > selected.sharpnessScore)) {
      best = index;
    }
  }
  return best;
}

function luminanceDifference(left: Uint8Array, right: Uint8Array): number {
  if (left.length !== right.length || left.length === 0) return 1;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference += Math.abs(left[index] - right[index]);
  }
  return difference / left.length / 255;
}

async function preferredPhotoSettings(imageCapture: ImageCapture): Promise<PhotoSettings | undefined> {
  try {
    const capabilities = await imageCapture.getPhotoCapabilities();
    const imageWidth = capabilities.imageWidth?.max;
    const imageHeight = capabilities.imageHeight?.max;
    if (!(imageWidth && imageHeight)) return undefined;
    return { imageWidth, imageHeight };
  } catch {
    return undefined;
  }
}

async function takeMaximumResolutionPhoto(
  imageCapture: ImageCapture,
  settings?: PhotoSettings,
): Promise<Blob> {
  if (settings) {
    try {
      return await imageCapture.takePhoto(settings);
    } catch {
      // Some devices advertise separate maxima that are not a valid pair.
    }
  }
  return imageCapture.takePhoto();
}

async function normalizeJpeg(blob: Blob): Promise<Blob> {
  const signature = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  if (blob.type === "image/jpeg" || (signature[0] === 0xff && signature[1] === 0xd8)) return blob;
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("JPEG conversion is unavailable");
    context.drawImage(bitmap, 0, 0);
    const jpeg = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.95));
    if (!jpeg) throw new Error("Camera image could not be encoded as JPEG");
    return jpeg;
  } finally {
    bitmap.close();
  }
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 3 < bytes.length) {
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (offset + 1 >= bytes.length) break;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) return undefined;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 7) {
      return {
        height: (bytes[offset + 3] << 8) | bytes[offset + 4],
        width: (bytes[offset + 5] << 8) | bytes[offset + 6],
      };
    }
    offset += length;
  }
  return undefined;
}

function waitForVideoDimensions(video: HTMLVideoElement): Promise<void> {
  if (video.videoWidth > 0 && video.videoHeight > 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("Camera preview did not start"));
    }, 5000);
    const loaded = () => {
      if (!video.videoWidth || !video.videoHeight) return;
      cleanup();
      resolve();
    };
    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener("loadedmetadata", loaded);
      video.removeEventListener("resize", loaded);
    };
    video.addEventListener("loadedmetadata", loaded);
    video.addEventListener("resize", loaded);
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
