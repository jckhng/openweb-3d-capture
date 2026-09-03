import { describe, expect, it } from "vitest";
import type { ImageFeature } from "../refinement/features";
import {
  compareFrames,
  navigationCell,
  screenRelativeTilt,
  type NavigationFrame,
} from "./photo-visual-navigation";

describe("photo visual navigation", () => {
  it("maps continuous globe orientation into required latitude bands", () => {
    expect(navigationCell(-165, 20)).toEqual({ latitude: "level", azimuthBin: 0 });
    expect(navigationCell(-15, 45)).toEqual({ latitude: "raised", azimuthBin: 5 });
    expect(navigationCell(120, -5)).toEqual({ latitude: "low", azimuthBin: 10 });
    expect(navigationCell(80, 70)).toEqual({ latitude: "high", azimuthBin: 0 });
  });

  it("selects the screen-relative tilt axis", () => {
    expect(screenRelativeTilt(75, 12, 0)).toBe(75);
    expect(screenRelativeTilt(75, 12, 90)).toBe(12);
    expect(screenRelativeTilt(75, 12, 270)).toBe(-12);
    expect(screenRelativeTilt(75, 12, 180)).toBe(-75);
  });

  it("retains navigation lock on a stationary feature-rich preview", () => {
    const features = Array.from({ length: 24 }, (_, index) => makeFeature(index));
    const frame: NavigationFrame = { width: 320, height: 240, features };
    const tracking = compareFrames(frame, {
      ...frame,
      features: features.map((feature) => ({ ...feature, descriptor: feature.descriptor.slice() })),
    });

    expect(tracking.trackingState).toBe("tracking");
    expect(tracking.matches).toBe(24);
    expect(tracking.horizontalFlow).toBe(0);
  });
});

function makeFeature(index: number): ImageFeature {
  const descriptor = new Uint32Array(8);
  descriptor[0] = (index + 1) * 0x9e3779b1;
  descriptor[1] = ((index + 3) * 0x85ebca6b) >>> 0;
  return {
    x: 24 + index % 6 * 48,
    y: 24 + Math.floor(index / 6) * 48,
    score: 100 - index,
    scale: 1,
    orientation: 0,
    descriptor,
  };
}
