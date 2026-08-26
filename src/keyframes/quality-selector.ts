import { poseTranslationDistance, rotationAngleDifference } from "../shared/matrix";
import type { CaptureDecision, CaptureDecisionReason, Matrix4 } from "../shared/types";

export interface QualitySelectorConfig {
  minimumSharpness: number;
  minimumTargetDistance: number;
  maximumLinearVelocity: number;
  maximumAngularVelocity: number;
  minimumTranslation: number;
  minimumRotation: number;
}

export const DEFAULT_QUALITY_SELECTOR_CONFIG: Readonly<QualitySelectorConfig> = {
  minimumSharpness: 0.5,
  minimumTargetDistance: 0.45,
  // Replaying the first rigid M2 orbit rejects 33% of candidates at these limits.
  maximumLinearVelocity: 0.4,
  maximumAngularVelocity: 0.45,
  minimumTranslation: 0.02,
  minimumRotation: Math.PI / 60,
};

export interface QualityCandidate {
  candidateId: number;
  timestamp: number;
  cameraToWorld: Matrix4;
  trackingState: string;
  imageAvailable: boolean;
  imageSynchronized: boolean;
  sharpnessScore: number;
  targetDistance?: number;
}

export class QualityKeyframeSelector {
  private previousCandidate?: Pick<QualityCandidate, "timestamp" | "cameraToWorld">;
  private previousAccepted?: Pick<QualityCandidate, "timestamp" | "cameraToWorld">;

  constructor(private readonly config: QualitySelectorConfig = DEFAULT_QUALITY_SELECTOR_CONFIG) {
    validateConfig(config);
  }

  evaluate(candidate: QualityCandidate): CaptureDecision {
    const motion = this.measureMotion(candidate);
    const novelty = this.measureNovelty(candidate);
    const sharpnessScore = clamp01(candidate.sharpnessScore);
    const blurScore = 1 - sharpnessScore;
    const motionScore = Math.max(
      motion.linearVelocity / this.config.maximumLinearVelocity,
      motion.angularVelocity / this.config.maximumAngularVelocity,
    );
    const noveltyScore = this.previousAccepted
      ? Math.max(
        novelty.translation / this.config.minimumTranslation,
        novelty.rotation / this.config.minimumRotation,
      )
      : 1;

    const reason = this.rejectionReason(candidate, sharpnessScore, motionScore, noveltyScore);
    const decision: CaptureDecision = {
      candidateId: candidate.candidateId,
      timestamp: candidate.timestamp,
      accepted: reason === "accepted",
      reason,
      trackingState: candidate.trackingState,
      cameraToWorld: candidate.cameraToWorld.map((row) => [...row]),
      sharpnessScore,
      linearVelocity: motion.linearVelocity,
      angularVelocity: motion.angularVelocity,
      translationNovelty: novelty.translation,
      rotationNovelty: novelty.rotation,
      targetDistance: candidate.targetDistance,
      quality: {
        blurScore,
        motionScore: clamp01(motionScore),
        noveltyScore: clamp01(noveltyScore),
        coverageGain: 0,
      },
    };
    this.previousCandidate = {
      timestamp: candidate.timestamp,
      cameraToWorld: candidate.cameraToWorld.map((row) => [...row]),
    };
    return decision;
  }

  commitAccepted(decision: CaptureDecision): void {
    if (!decision.accepted) throw new Error("Cannot commit a rejected quality decision");
    this.previousAccepted = {
      timestamp: decision.timestamp,
      cameraToWorld: decision.cameraToWorld.map((row) => [...row]),
    };
  }

  private measureMotion(candidate: QualityCandidate) {
    const elapsedSeconds = this.previousCandidate
      ? (candidate.timestamp - this.previousCandidate.timestamp) / 1000
      : 0;
    if (!(elapsedSeconds > 0)) return { linearVelocity: 0, angularVelocity: 0 };
    return {
      linearVelocity: poseTranslationDistance(this.previousCandidate!.cameraToWorld, candidate.cameraToWorld) / elapsedSeconds,
      angularVelocity: rotationAngleDifference(this.previousCandidate!.cameraToWorld, candidate.cameraToWorld) / elapsedSeconds,
    };
  }

  private measureNovelty(candidate: QualityCandidate) {
    if (!this.previousAccepted) return { translation: 0, rotation: 0 };
    return {
      translation: poseTranslationDistance(this.previousAccepted.cameraToWorld, candidate.cameraToWorld),
      rotation: rotationAngleDifference(this.previousAccepted.cameraToWorld, candidate.cameraToWorld),
    };
  }

  private rejectionReason(
    candidate: QualityCandidate,
    sharpnessScore: number,
    motionScore: number,
    noveltyScore: number,
  ): CaptureDecisionReason {
    if (candidate.trackingState !== "tracked") return "tracking";
    if (!candidate.imageAvailable) return "image-unavailable";
    if (!candidate.imageSynchronized) return "unsynchronized-image";
    if (
      candidate.targetDistance !== undefined &&
      candidate.targetDistance > 0 &&
      candidate.targetDistance < this.config.minimumTargetDistance
    ) return "too-close";
    if (sharpnessScore < this.config.minimumSharpness) return "blur";
    if (motionScore > 1) return "motion";
    if (this.previousAccepted && noveltyScore < 1) return "redundant";
    return "accepted";
  }
}

function validateConfig(config: QualitySelectorConfig): void {
  for (const [name, value] of Object.entries(config)) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  }
  if (config.minimumSharpness > 1) throw new Error("minimumSharpness must not exceed 1");
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}
