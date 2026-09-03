import { matchImageFeatures, type ImageFeature } from "../refinement/features";
import type { CaptureCoverageCell, CaptureCoverageLatitude } from "../shared/types";

export const PHOTO_CHECKPOINT_COUNT = 25;
export const PHOTO_IMAGES_PER_CHECKPOINT = 2;
export const PHOTO_TARGET = PHOTO_CHECKPOINT_COUNT * PHOTO_IMAGES_PER_CHECKPOINT;

const CHECKPOINTS: ReadonlyArray<{ latitude: CaptureCoverageLatitude; azimuthBin: number }> = [
  ...Array.from({ length: 12 }, (_, azimuthBin) => ({ latitude: "level" as const, azimuthBin })),
  ...[0, 2, 4, 6, 8, 10].map((azimuthBin) => ({ latitude: "raised" as const, azimuthBin })),
  { latitude: "high", azimuthBin: 0 },
  ...[10, 8, 6, 4, 2, 0].map((azimuthBin) => ({ latitude: "low" as const, azimuthBin })),
];

export type PhotoOverlapVerdict = "first" | "useful" | "too-similar" | "low-overlap";

export interface PhotoFeatureSignature {
  width: number;
  height: number;
  features: ImageFeature[];
}

export interface PhotoOverlapMetrics {
  verdict: PhotoOverlapVerdict;
  matches: number;
  matchRatio: number;
  medianDisplacement: number;
  referencePhotoId?: number;
}

export function buildPhotoCoverageCells(photoCount: number): CaptureCoverageCell[] {
  return CHECKPOINTS.map((checkpoint, index) => {
    const firstPhoto = index * PHOTO_IMAGES_PER_CHECKPOINT;
    const frameCount = Math.max(0, Math.min(
      PHOTO_IMAGES_PER_CHECKPOINT,
      photoCount - firstPhoto,
    ));
    return {
      ...checkpoint,
      required: true,
      frameCount,
      stableFrameCount: frameCount,
      bestSharpness: 0,
      selectedFrameIds: Array.from({ length: frameCount }, (_, offset) => firstPhoto + offset),
      state: frameCount >= PHOTO_IMAGES_PER_CHECKPOINT
        ? "captured"
        : frameCount > 0 ? "sampled" : "empty",
    };
  });
}

export function currentPhotoCheckpoint(photoCount: number) {
  return CHECKPOINTS[Math.min(CHECKPOINTS.length - 1, Math.floor(photoCount / PHOTO_IMAGES_PER_CHECKPOINT))];
}

export function photoCapturePrompt(photoCount: number): string {
  if (photoCount >= PHOTO_TARGET) return "COVERAGE COMPLETE — add useful detail views or finish.";
  const checkpointIndex = Math.floor(photoCount / PHOTO_IMAGES_PER_CHECKPOINT);
  const checkpoint = CHECKPOINTS[checkpointIndex];
  const view = photoCount % PHOTO_IMAGES_PER_CHECKPOINT + 1;
  const sector = checkpoint.latitude === "high"
    ? "top checkpoint"
    : `${latitudeLabel(checkpoint.latitude)} sector ${sectorNumber(checkpoint.azimuthBin)} / 12`;
  if (view === 1) return `MOVE TO ${sector.toUpperCase()}, keep overlap, then stop.`;
  return `VIEW 1 / 2 SAVED — take a small sideways step within ${sector.toUpperCase()}, then stop.`;
}

export function measurePhotoOverlap(
  candidate: PhotoFeatureSignature,
  references: ReadonlyArray<{ photoId: number; signature: PhotoFeatureSignature }>,
): PhotoOverlapMetrics {
  if (!references.length) {
    return { verdict: "first", matches: 0, matchRatio: 0, medianDisplacement: 0 };
  }
  let strongest: PhotoOverlapMetrics | undefined;
  for (const reference of references) {
    const matches = matchImageFeatures(reference.signature.features, candidate.features, 0.82, 84);
    const matchRatio = matches.length / Math.max(
      1,
      Math.min(reference.signature.features.length, candidate.features.length),
    );
    const displacements = matches.map((match) => {
      const left = reference.signature.features[match.featureA];
      const right = candidate.features[match.featureB];
      return Math.hypot(
        left.x / reference.signature.width - right.x / candidate.width,
        left.y / reference.signature.height - right.y / candidate.height,
      );
    }).sort((a, b) => a - b);
    const metrics: PhotoOverlapMetrics = {
      verdict: "useful",
      matches: matches.length,
      matchRatio,
      medianDisplacement: displacements[Math.floor(displacements.length / 2)] ?? 1,
      referencePhotoId: reference.photoId,
    };
    if (!strongest || metrics.matchRatio > strongest.matchRatio ||
      (metrics.matchRatio === strongest.matchRatio && metrics.matches > strongest.matches)) {
      strongest = metrics;
    }
  }
  return classifyPhotoOverlap(strongest!);
}

export function classifyPhotoOverlap(
  metrics: Omit<PhotoOverlapMetrics, "verdict">,
): PhotoOverlapMetrics {
  if (metrics.matches >= 16 && metrics.matchRatio >= 0.08 && metrics.medianDisplacement < 0.014) {
    return { ...metrics, verdict: "too-similar" };
  }
  if (metrics.matches < 10 || metrics.matchRatio < 0.035) {
    return { ...metrics, verdict: "low-overlap" };
  }
  return { ...metrics, verdict: "useful" };
}

function latitudeLabel(latitude: CaptureCoverageLatitude): string {
  if (latitude === "raised") return "raised";
  if (latitude === "low") return "low";
  return "level";
}

function sectorNumber(azimuthBin: number): number {
  return azimuthBin + 1;
}
