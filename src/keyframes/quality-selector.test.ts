import { describe, expect, it } from "vitest";
import type { Matrix4 } from "../shared/types";
import { QualityKeyframeSelector, type QualityCandidate } from "./quality-selector";

function pose(x = 0, yaw = 0): Matrix4 {
  const cosine = Math.cos(yaw);
  const sine = Math.sin(yaw);
  return [
    [cosine, 0, sine, x],
    [0, 1, 0, 0],
    [-sine, 0, cosine, 0],
    [0, 0, 0, 1],
  ];
}

function candidate(overrides: Partial<QualityCandidate> = {}): QualityCandidate {
  return {
    candidateId: 0,
    timestamp: 0,
    cameraToWorld: pose(),
    trackingState: "tracked",
    imageAvailable: true,
    imageSynchronized: true,
    sharpnessScore: 0.8,
    sharpFramesHybridScore: 123,
    textureScore: 0.8,
    ...overrides,
  };
}

describe("QualityKeyframeSelector", () => {
  it("accepts and commits the first valid synchronized frame", () => {
    const selector = new QualityKeyframeSelector();
    const decision = selector.evaluate(candidate());
    expect(decision.reason).toBe("accepted");
    expect(decision.sharpFramesHybridScore).toBe(123);
    expect(decision.quality).toEqual({
      blurScore: expect.closeTo(0.2),
      sharpFramesHybridScore: 123,
      motionScore: 0,
      noveltyScore: 1,
      coverageGain: 0,
    });
    selector.commitAccepted(decision);
  });

  it.each([
    [{ trackingState: "emulated" }, "tracking"],
    [{ imageAvailable: false }, "image-unavailable"],
    [{ imageSynchronized: false }, "unsynchronized-image"],
    [{ targetDistance: 0.3 }, "too-close"],
    [{ textureScore: 0.05 }, "low-texture"],
    [{ sharpnessScore: 0.2 }, "blur"],
  ] as const)("rejects invalid input as %s", (overrides, reason) => {
    const selector = new QualityKeyframeSelector();
    expect(selector.evaluate(candidate(overrides)).reason).toBe(reason);
  });

  it("rejects fast motion and then permits a steady novel view", () => {
    const selector = new QualityKeyframeSelector();
    const first = selector.evaluate(candidate());
    selector.commitAccepted(first);
    expect(selector.evaluate(candidate({ candidateId: 1, timestamp: 250, cameraToWorld: pose(0.2) })).reason)
      .toBe("motion");
    const steady = selector.evaluate(candidate({ candidateId: 2, timestamp: 500, cameraToWorld: pose(0.22) }));
    expect(steady.reason).toBe("accepted");
  });

  it("rejects redundant views but accepts rotation novelty", () => {
    const selector = new QualityKeyframeSelector();
    const first = selector.evaluate(candidate());
    selector.commitAccepted(first);
    expect(selector.evaluate(candidate({ candidateId: 1, timestamp: 250, cameraToWorld: pose(0.005) })).reason)
      .toBe("redundant");
    expect(selector.evaluate(candidate({ candidateId: 2, timestamp: 1000, cameraToWorld: pose(0.006, Math.PI / 30) })).reason)
      .toBe("accepted");
  });

  it("adapts to recent sharp views without exceeding the bounded threshold", () => {
    const selector = new QualityKeyframeSelector();
    for (let index = 0; index < 4; index += 1) {
      selector.evaluate(candidate({ candidateId: index, timestamp: index * 250, sharpnessScore: 0.8 }));
    }
    const marginal = selector.evaluate(candidate({ candidateId: 5, timestamp: 1250, sharpnessScore: 0.49 }));
    expect(marginal.sharpnessThreshold).toBeCloseTo(0.5);
    expect(marginal.reason).toBe("blur");
    const bounded = selector.evaluate(candidate({ candidateId: 6, timestamp: 1500, sharpnessScore: 0.51 }));
    expect(bounded.reason).toBe("accepted");
  });
});
