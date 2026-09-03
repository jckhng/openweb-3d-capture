import type { CaptureDecision } from "../shared/types";
import { poseTranslationDistance, rotationAngleDifference } from "../shared/matrix";

export interface StableViewpointGateConfig {
  requiredStableCandidates: number;
  maximumMotionScore: number;
  maximumWindowTranslationMeters: number;
  maximumWindowRotationRadians: number;
}

export const DEFAULT_STABLE_VIEWPOINT_GATE_CONFIG: Readonly<StableViewpointGateConfig> = {
  requiredStableCandidates: 3,
  maximumMotionScore: 0.4,
  maximumWindowTranslationMeters: 0.02,
  maximumWindowRotationRadians: 1.5 * Math.PI / 180,
};

/**
 * Discards the first candidates after movement so a viewpoint is recorded only
 * after roughly half a second of stable tracking at the four-Hz quality gate.
 */
export class StableViewpointGate {
  private stableCandidates: CaptureDecision[] = [];

  constructor(
    private readonly config: StableViewpointGateConfig = DEFAULT_STABLE_VIEWPOINT_GATE_CONFIG,
  ) {
    if (!Number.isInteger(config.requiredStableCandidates) || config.requiredStableCandidates < 1) {
      throw new Error("Required stable candidates must be a positive integer");
    }
    if (!(config.maximumMotionScore > 0 && config.maximumMotionScore <= 1)) {
      throw new Error("Maximum motion score must be between zero and one");
    }
    if (!(config.maximumWindowTranslationMeters > 0) || !(config.maximumWindowRotationRadians > 0)) {
      throw new Error("Stable-window pose limits must be positive");
    }
  }

  evaluate(decision: CaptureDecision): CaptureDecision {
    if (resetsStability(decision) || decision.quality.motionScore > this.config.maximumMotionScore) {
      this.stableCandidates = [];
      return decision.accepted
        ? { ...decision, accepted: false, reason: "motion" }
        : decision;
    }

    const windowStart = this.stableCandidates[0];
    if (
      windowStart &&
      (poseTranslationDistance(windowStart.cameraToWorld, decision.cameraToWorld) >
        this.config.maximumWindowTranslationMeters ||
        rotationAngleDifference(windowStart.cameraToWorld, decision.cameraToWorld) >
          this.config.maximumWindowRotationRadians)
    ) {
      this.stableCandidates = [];
    }
    this.stableCandidates.push(decision);
    if (this.stableCandidates.length > this.config.requiredStableCandidates) {
      this.stableCandidates.shift();
    }
    if (!decision.accepted) return decision;
    if (this.stableCandidates.length < this.config.requiredStableCandidates) {
      return { ...decision, accepted: false, reason: "settling" };
    }
    this.stableCandidates = [];
    return decision;
  }

  reset(): void {
    this.stableCandidates = [];
  }
}

function resetsStability(decision: CaptureDecision): boolean {
  return decision.reason === "tracking" ||
    decision.reason === "image-unavailable" ||
    decision.reason === "unsynchronized-image" ||
    decision.reason === "off-target" ||
    decision.reason === "too-close" ||
    decision.reason === "motion";
}
