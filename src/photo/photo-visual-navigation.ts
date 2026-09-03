import { verifyFeatureGeometry } from "../refinement/geometric-verification";
import {
  extractBriefFeatures,
  matchImageFeatures,
  type GrayImage,
  type ImageFeature,
} from "../refinement/features";
import type { PhotoCaptureGuidance } from "../shared/types";

const INITIAL_LONGITUDE = -165;
const INITIAL_ELEVATION = 20;
const APPROXIMATE_HORIZONTAL_FOV_DEGREES = 65;
const ORIENTATION_STALE_AFTER_MS = 2500;

export interface NavigationFrame {
  width: number;
  height: number;
  features: ImageFeature[];
}

export interface PhotoNavigationSnapshot {
  guidance?: PhotoCaptureGuidance;
  orientationAvailable: boolean;
}

export class PhotoVisualNavigator {
  private previous?: NavigationFrame;
  private reference?: NavigationFrame;
  private current?: NavigationFrame;
  private referenceAlpha?: number;
  private previousAlpha?: number;
  private lastOrientationAt = 0;
  private accumulatedHeading = 0;
  private referenceTilt?: number;
  private visualLongitude = INITIAL_LONGITUDE;
  private guidance?: PhotoCaptureGuidance;

  reset(): void {
    this.previous = undefined;
    this.reference = undefined;
    this.current = undefined;
    this.referenceAlpha = undefined;
    this.previousAlpha = undefined;
    this.lastOrientationAt = 0;
    this.accumulatedHeading = 0;
    this.referenceTilt = undefined;
    this.visualLongitude = INITIAL_LONGITUDE;
    this.guidance = undefined;
  }

  updateOrientation(alpha: number | null, beta: number | null, gamma: number | null, screenAngle: number): void {
    if (alpha === null) return;
    this.lastOrientationAt = Date.now();
    const tilt = screenRelativeTilt(beta, gamma, screenAngle);
    if (this.referenceAlpha === undefined) {
      this.referenceAlpha = alpha;
      this.previousAlpha = alpha;
      this.referenceTilt = tilt;
    } else {
      const delta = normalizeSignedDegrees(alpha - this.previousAlpha!);
      if (Math.abs(delta) <= 45) this.accumulatedHeading += delta;
      this.previousAlpha = alpha;
    }
    this.refreshGuidance(this.guidance?.trackingState ?? "initializing", {
      matches: this.guidance?.matches ?? 0,
      inlierRatio: this.guidance?.inlierRatio ?? 0,
      confidence: this.guidance?.confidence ?? 0,
    }, tilt);
  }

  observe(image: GrayImage): PhotoNavigationSnapshot {
    const current: NavigationFrame = {
      width: image.width,
      height: image.height,
      features: extractBriefFeatures(image, {
        maximumFeatures: 240,
        fastThreshold: 18,
        cellSize: 14,
      }),
    };
    this.current = current;

    if (this.previous) {
      const motion = compareFrames(this.previous, current);
      if (motion.trackingState === "tracking" && !this.orientationAvailable()) {
        this.visualLongitude = normalizeLongitude(
          this.visualLongitude - motion.horizontalFlow * APPROXIMATE_HORIZONTAL_FOV_DEGREES,
        );
      }
    }

    const tracking = this.reference
      ? compareFrames(this.reference, current)
      : { trackingState: "initializing" as const, matches: 0, inlierRatio: 0, confidence: 0, horizontalFlow: 0 };
    this.previous = current;
    this.refreshGuidance(tracking.trackingState, tracking);
    return this.getSnapshot();
  }

  acceptCurrent(): PhotoCaptureGuidance | undefined {
    if (!this.current || !this.guidance) return undefined;
    this.reference = this.current;
    return { ...this.guidance };
  }

  getSnapshot(): PhotoNavigationSnapshot {
    return {
      guidance: this.guidance ? { ...this.guidance } : undefined,
      orientationAvailable: this.orientationAvailable(),
    };
  }

  private refreshGuidance(
    trackingState: PhotoCaptureGuidance["trackingState"],
    metrics: { matches: number; inlierRatio: number; confidence: number },
    currentTilt?: number,
  ): void {
    const longitude = this.orientationAvailable()
      ? normalizeLongitude(INITIAL_LONGITUDE + this.accumulatedHeading)
      : this.visualLongitude;
    if (this.orientationAvailable()) this.visualLongitude = longitude;
    const elevation = this.referenceTilt === undefined || currentTilt === undefined
      ? this.guidance?.elevation ?? INITIAL_ELEVATION
      : clamp(INITIAL_ELEVATION + this.referenceTilt - currentTilt, -20, 85);
    const cell = navigationCell(longitude, elevation);
    this.guidance = {
      source: "visual-navigation",
      poseSynchronized: false,
      longitude,
      elevation,
      azimuthBin: cell.azimuthBin,
      latitude: cell.latitude,
      trackingState,
      matches: metrics.matches,
      inlierRatio: metrics.inlierRatio,
      confidence: metrics.confidence,
    };
  }

  private orientationAvailable(): boolean {
    return this.referenceAlpha !== undefined && Date.now() - this.lastOrientationAt <= ORIENTATION_STALE_AFTER_MS;
  }
}

export function compareFrames(left: NavigationFrame, right: NavigationFrame) {
  const matches = matchImageFeatures(left.features, right.features, 0.82, 84);
  const points = matches.map((match) => ({
    pointA: [left.features[match.featureA].x, left.features[match.featureA].y] as [number, number],
    pointB: [right.features[match.featureB].x, right.features[match.featureB].y] as [number, number],
  }));
  const geometry = verifyFeatureGeometry(points, Math.max(left.width, right.width), Math.max(left.height, right.height));
  const matchRatio = matches.length / Math.max(1, Math.min(left.features.length, right.features.length));
  const displacement = points.map(({ pointA, pointB }) => Math.hypot(
    (pointB[0] / right.width) - (pointA[0] / left.width),
    (pointB[1] / right.height) - (pointA[1] / left.height),
  ));
  const medianDisplacement = median(displacement);
  // A stationary preview is intentionally degenerate for an eight-point model.
  // Strong mutual descriptor continuity is sufficient for navigation lock here;
  // reconstruction and pose export continue to require downstream SfM.
  const descriptorContinuity = matches.length >= 16 &&
    matchRatio >= 0.07 &&
    medianDisplacement <= 0.18;
  const accepted = geometry.accepted || descriptorContinuity;
  const flowPoints = geometry.accepted
    ? geometry.inlierIndices.map((index) => points[index])
    : descriptorContinuity ? points : [];
  const horizontalFlow = median(flowPoints.map(({ pointA, pointB }) => (
    (pointB[0] / right.width) - (pointA[0] / left.width)
  )));
  const geometryConfidence = Math.min(1, geometry.inliers / 30) * geometry.inlierRatio;
  const descriptorConfidence = descriptorContinuity
    ? Math.min(1, matches.length / 40) * Math.min(1, matchRatio / 0.2)
    : 0;
  return {
    trackingState: accepted ? "tracking" as const : "weak" as const,
    matches: matches.length,
    inlierRatio: geometry.inlierRatio,
    confidence: Math.max(geometryConfidence, descriptorConfidence),
    horizontalFlow,
  };
}

export function navigationCell(longitude: number, elevation: number) {
  const normalized = (normalizeLongitude(longitude) + 180) / 360;
  const latitude = elevation >= 60
    ? "high" as const
    : elevation >= 35
      ? "raised" as const
      : elevation >= 5 ? "level" as const : "low" as const;
  return {
    azimuthBin: latitude === "high" ? 0 : Math.min(11, Math.max(0, Math.floor(normalized * 12))),
    latitude,
  };
}

export function screenRelativeTilt(beta: number | null, gamma: number | null, screenAngle: number): number | undefined {
  if (Math.abs(screenAngle) === 90 || screenAngle === 270) {
    if (gamma === null) return undefined;
    return screenAngle === 90 ? gamma : -gamma;
  }
  if (beta === null) return undefined;
  return Math.abs(screenAngle) === 180 ? -beta : beta;
}

function normalizeLongitude(value: number): number {
  return ((value + 180) % 360 + 360) % 360 - 180;
}

function normalizeSignedDegrees(value: number): number {
  return normalizeLongitude(value);
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
