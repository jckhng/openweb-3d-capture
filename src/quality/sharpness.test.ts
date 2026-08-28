import { describe, expect, it } from "vitest";
import { analyzeTargetImageQuality, scoreLaplacianSharpness } from "./sharpness";

const QUALITY_SIZE = 96;

function image(width: number, height: number, sample: (x: number, y: number) => number) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const value = sample(x, y);
      pixels[offset] = value;
      pixels[offset + 1] = value;
      pixels[offset + 2] = value;
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

function boxBlur(pixels: Uint8ClampedArray, width: number, height: number, radius: number) {
  const output = new Uint8ClampedArray(pixels.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      let count = 0;
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          const sampleX = Math.max(0, Math.min(width - 1, x + dx));
          const sampleY = Math.max(0, Math.min(height - 1, y + dy));
          sum += pixels[(sampleY * width + sampleX) * 4];
          count += 1;
        }
      }
      const offset = (y * width + x) * 4;
      output[offset] = output[offset + 1] = output[offset + 2] = Math.round(sum / count);
      output[offset + 3] = 255;
    }
  }
  return output;
}

describe("Laplacian sharpness", () => {
  it("reports a flat image as unsharp", () => {
    expect(scoreLaplacianSharpness(image(16, 16, () => 128), 16, 16)).toBe(0);
  });

  it("scores high-frequency detail above a smooth gradient", () => {
    const gradient = scoreLaplacianSharpness(image(32, 32, (x) => x * 8), 32, 32);
    const checkerboard = scoreLaplacianSharpness(
      image(32, 32, (x, y) => (x + y) % 2 ? 255 : 0),
      32,
      32,
    );
    expect(gradient).toBeLessThan(0.05);
    expect(checkerboard).toBeGreaterThan(0.9);
  });

  it("separates low texture from measured sharpness", () => {
    const flat = analyzeTargetImageQuality(
      image(QUALITY_SIZE, QUALITY_SIZE, () => 128),
      QUALITY_SIZE,
      QUALITY_SIZE,
    );
    const detailed = analyzeTargetImageQuality(
      image(QUALITY_SIZE, QUALITY_SIZE, (x, y) => (
        (Math.floor(x / 3) + Math.floor(y / 3)) % 2 ? 230 : 20
      )),
      QUALITY_SIZE,
      QUALITY_SIZE,
    );
    expect(flat).toEqual({ sharpnessScore: 0, textureScore: 0 });
    expect(detailed.sharpnessScore).toBeGreaterThan(0.8);
    expect(detailed.textureScore).toBeGreaterThan(0.5);
  });

  it("uses detailed tiles without letting one edge dominate the crop", () => {
    const partlyDetailed = analyzeTargetImageQuality(
      image(QUALITY_SIZE, QUALITY_SIZE, (x, y) => x < 64 && (x + y) % 2 ? 255 : 0),
      QUALITY_SIZE,
      QUALITY_SIZE,
    );
    const singleEdge = analyzeTargetImageQuality(
      image(QUALITY_SIZE, QUALITY_SIZE, (x) => x < 48 ? 0 : 255),
      QUALITY_SIZE,
      QUALITY_SIZE,
    );
    expect(partlyDetailed.sharpnessScore).toBeGreaterThan(0.8);
    expect(partlyDetailed.textureScore).toBeGreaterThan(0.5);
    expect(singleEdge.textureScore).toBeLessThan(0.2);
  });

  it("scores optically smoothed texture below the sharp source", () => {
    const source = image(
      QUALITY_SIZE,
      QUALITY_SIZE,
      (x, y) => (Math.floor(x / 4) + Math.floor(y / 4)) % 2 ? 230 : 20,
    );
    const sharp = analyzeTargetImageQuality(source, QUALITY_SIZE, QUALITY_SIZE);
    const blurred = analyzeTargetImageQuality(
      boxBlur(source, QUALITY_SIZE, QUALITY_SIZE, 3),
      QUALITY_SIZE,
      QUALITY_SIZE,
    );
    expect(blurred.textureScore).toBeGreaterThan(0.12);
    expect(blurred.sharpnessScore).toBeLessThan(sharp.sharpnessScore - 0.2);
  });

  it("rejects inconsistent buffer dimensions", () => {
    expect(() => scoreLaplacianSharpness(new Uint8ClampedArray(4), 8, 8)).toThrow(/buffer size/);
  });
});
