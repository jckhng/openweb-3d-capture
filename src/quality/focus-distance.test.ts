import { describe, expect, it } from "vitest";
import { medianCenterDepth } from "./focus-distance";

describe("center target distance", () => {
  it("returns the median valid depth from the center sampling grid", () => {
    let sample = 0;
    const values = [0, 0.4, 0.44, 0.46, 0.5, 0.52, 0.54, Number.NaN, 20];
    expect(medianCenterDepth(() => values[sample++])).toBe(0.5);
  });

  it("returns unavailable when the center has no valid depth", () => {
    expect(medianCenterDepth(() => 0)).toBeUndefined();
  });
});
