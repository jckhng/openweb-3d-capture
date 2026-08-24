import { describe, expect, it } from "vitest";
import { TemporalKeyframeGate } from "./temporal-gate";

describe("TemporalKeyframeGate", () => {
  it("accepts at no more than the configured rate", () => {
    const gate = new TemporalKeyframeGate(4);
    expect([0, 100, 249, 250, 499, 500].map((time) => gate.tryAccept(time))).toEqual([
      true,
      false,
      false,
      true,
      false,
      true,
    ]);
  });

  it("does not accumulate a burst after a delayed frame", () => {
    const gate = new TemporalKeyframeGate(5);
    expect(gate.tryAccept(0)).toBe(true);
    expect(gate.tryAccept(1000)).toBe(true);
    expect(gate.tryAccept(1001)).toBe(false);
    expect(gate.tryAccept(1200)).toBe(true);
  });

  it("rejects rates outside the M1 budget", () => {
    expect(() => new TemporalKeyframeGate(1)).toThrow(/between 2 and 5/);
    expect(() => new TemporalKeyframeGate(6)).toThrow(/between 2 and 5/);
  });
});
