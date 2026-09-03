import { describe, expect, it } from "vitest";
import type { CaptureDecision } from "../shared/types";
import { StableViewpointGate } from "./stable-viewpoint-gate";

describe("StableViewpointGate", () => {
  it("waits for three stable candidates before accepting a viewpoint", () => {
    const gate = new StableViewpointGate();
    expect(gate.evaluate(decision()).reason).toBe("settling");
    expect(gate.evaluate(decision()).reason).toBe("settling");
    expect(gate.evaluate(decision())).toMatchObject({ accepted: true, reason: "accepted" });
  });

  it("resets after excessive motion", () => {
    const gate = new StableViewpointGate();
    gate.evaluate(decision());
    expect(gate.evaluate(decision({ motionScore: 0.6 }))).toMatchObject({
      accepted: false,
      reason: "motion",
    });
    expect(gate.evaluate(decision()).reason).toBe("settling");
  });

  it("lets a soft stable candidate contribute to the settling period", () => {
    const gate = new StableViewpointGate();
    expect(gate.evaluate(decision({ accepted: false, reason: "blur" })).reason).toBe("blur");
    expect(gate.evaluate(decision()).reason).toBe("settling");
    expect(gate.evaluate(decision()).accepted).toBe(true);
  });

  it("restarts the settling window while the camera drifts slowly", () => {
    const gate = new StableViewpointGate();
    gate.evaluate(decision({ poseX: 0 }));
    gate.evaluate(decision({ poseX: 0.03 }));
    expect(gate.evaluate(decision({ poseX: 0.06 })).reason).toBe("settling");
    expect(gate.evaluate(decision({ poseX: 0.06 })).reason).toBe("settling");
    expect(gate.evaluate(decision({ poseX: 0.06 })).accepted).toBe(true);
  });
});

function decision(overrides: {
  accepted?: boolean;
  reason?: CaptureDecision["reason"];
  motionScore?: number;
  poseX?: number;
} = {}): CaptureDecision {
  return {
    candidateId: 0,
    timestamp: 0,
    accepted: overrides.accepted ?? true,
    reason: overrides.reason ?? "accepted",
    trackingState: "tracked",
    cameraToWorld: [
      [1, 0, 0, overrides.poseX ?? 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
    ],
    sharpnessScore: 0.8,
    sharpnessThreshold: 0.5,
    linearVelocity: 0,
    angularVelocity: 0,
    translationNovelty: 0.1,
    rotationNovelty: 0.1,
    quality: {
      blurScore: 0.2,
      motionScore: overrides.motionScore ?? 0.1,
      noveltyScore: 1,
      coverageGain: 0,
    },
  };
}
