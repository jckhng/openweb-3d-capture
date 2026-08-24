import { describe, expect, it } from "vitest";
import { scoreLaplacianSharpness } from "./sharpness";

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

  it("rejects inconsistent buffer dimensions", () => {
    expect(() => scoreLaplacianSharpness(new Uint8ClampedArray(4), 8, 8)).toThrow(/buffer size/);
  });
});
