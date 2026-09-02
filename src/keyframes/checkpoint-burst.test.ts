import { describe, expect, it } from "vitest";
import type { CaptureDecision } from "../shared/types";
import { CheckpointBurstGate } from "./checkpoint-burst";

describe("checkpoint burst gate", () => {
  it("arms two stable supplemental frames after a novel viewpoint", () => {
    const gate = new CheckpointBurstGate();

    expect(gate.evaluate(decision("accepted", true)).reason).toBe("accepted");
    expect(gate.evaluate(decision("redundant", false)).reason).toBe("checkpoint-burst");
    expect(gate.evaluate(decision("redundant", false)).reason).toBe("checkpoint-burst");
    expect(gate.evaluate(decision("redundant", false))).toMatchObject({
      accepted: false,
      reason: "redundant",
    });
  });

  it("does not spend the burst on motion or blur", () => {
    const gate = new CheckpointBurstGate();
    gate.evaluate(decision("accepted", true));

    expect(gate.evaluate(decision("redundant", false, { motionScore: 0.8 })).accepted).toBe(false);
    expect(gate.evaluate(decision("redundant", false, { sharpnessScore: 0.4 })).accepted).toBe(false);
    expect(gate.evaluate(decision("redundant", false)).reason).toBe("checkpoint-burst");
  });
});

function decision(
  reason: CaptureDecision["reason"],
  accepted: boolean,
  overrides: { motionScore?: number; sharpnessScore?: number } = {},
): CaptureDecision {
  return {
    candidateId: 0,
    timestamp: 0,
    accepted,
    reason,
    trackingState: "tracked",
    cameraToWorld: [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
    ],
    sharpnessScore: overrides.sharpnessScore ?? 0.8,
    sharpnessThreshold: 0.5,
    linearVelocity: 0,
    angularVelocity: 0,
    translationNovelty: 0,
    rotationNovelty: 0,
    quality: {
      blurScore: 0.2,
      motionScore: overrides.motionScore ?? 0.2,
      noveltyScore: accepted ? 1 : 0,
      coverageGain: 0,
    },
  };
}
