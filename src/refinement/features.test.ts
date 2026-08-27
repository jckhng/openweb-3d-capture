import { describe, expect, it } from "vitest";
import {
  extractImageFeatures,
  matchImageFeatures,
  type GrayImage,
} from "./features";

function checkerboard(shiftX = 0): GrayImage {
  const width = 80;
  const height = 80;
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      data[y * width + x] = ((Math.floor((x - shiftX) / 10) + Math.floor(y / 10)) & 1) ? 230 : 20;
    }
  }
  return { width, height, data };
}

function texture(shiftX = 0): GrayImage {
  const width = 80;
  const height = 80;
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sourceX = x - shiftX;
      if (sourceX < 0 || sourceX >= width) continue;
      let value = (sourceX + y * width + 1) >>> 0;
      value ^= value << 13;
      value ^= value >>> 17;
      value ^= value << 5;
      data[y * width + x] = value & 0xff;
    }
  }
  return { width, height, data };
}

describe("low-resolution feature tracking", () => {
  it("extracts spatially distributed FAST/BRIEF features", () => {
    const features = extractImageFeatures(checkerboard(), { maximumFeatures: 100, cellSize: 8 });
    expect(features.length).toBeGreaterThan(20);
    expect(features.length).toBeLessThanOrEqual(100);
    expect(features.every((feature) => feature.descriptor.length === 8)).toBe(true);
    expect(features.every((feature) => Number.isFinite(feature.orientation))).toBe(true);
  });

  it("matches translated image features with mutual ratio filtering", () => {
    const first = extractImageFeatures(texture(), { maximumFeatures: 120, cellSize: 8 });
    const second = extractImageFeatures(texture(2), { maximumFeatures: 120, cellSize: 8 });
    const matches = matchImageFeatures(first, second);
    expect(matches.length).toBeGreaterThan(8);
    const medianShift = matches
      .map((match) => second[match.featureB].x - first[match.featureA].x)
      .sort((a, b) => a - b)[Math.floor(matches.length / 2)];
    expect(medianShift).toBe(2);
  });

});
