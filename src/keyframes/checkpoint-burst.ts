import type { CaptureDecision } from "../shared/types";

export interface CheckpointBurstConfig {
  supplementalFrames: number;
  maximumMotionScore: number;
}

export const DEFAULT_CHECKPOINT_BURST_CONFIG: Readonly<CheckpointBurstConfig> = {
  supplementalFrames: 2,
  maximumMotionScore: 0.55,
};

export class CheckpointBurstGate {
  private remaining = 0;

  constructor(
    private readonly config: CheckpointBurstConfig = DEFAULT_CHECKPOINT_BURST_CONFIG,
  ) {}

  evaluate(decision: CaptureDecision): CaptureDecision {
    if (decision.accepted) {
      this.remaining = this.config.supplementalFrames;
      return decision;
    }
    if (
      decision.reason !== "redundant" ||
      this.remaining <= 0 ||
      decision.quality.motionScore > this.config.maximumMotionScore ||
      decision.sharpnessScore < (decision.sharpnessThreshold ?? 0)
    ) return decision;

    this.remaining -= 1;
    return {
      ...decision,
      accepted: true,
      reason: "checkpoint-burst",
    };
  }

  reset(): void {
    this.remaining = 0;
  }
}
