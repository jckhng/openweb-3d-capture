// Calibrated against the first target-phone M2 dataset. The previous 0.0025
// value compressed real captures into 0.876-0.984 and could not reject blur.
const DEFAULT_NORMALIZATION = 0.03;

/**
 * Estimate high-frequency image energy from normalized RGBA pixels.
 *
 * The returned score is continuous from 0 (flat) toward 1 (very sharp). The
 * caller should analyze a small target-centered crop so this remains cheap and
 * measures the subject instead of distant background detail.
 */
export function scoreLaplacianSharpness(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  normalization = DEFAULT_NORMALIZATION,
): number {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 3 || height < 3) return 0;
  if (rgba.length !== width * height * 4) throw new Error("RGBA buffer size does not match dimensions");
  if (!(normalization > 0) || !Number.isFinite(normalization)) {
    throw new Error("Sharpness normalization must be positive");
  }

  const luminance = new Float32Array(width * height);
  for (let index = 0, pixel = 0; index < rgba.length; index += 4, pixel += 1) {
    luminance[pixel] = (
      0.2126 * rgba[index] +
      0.7152 * rgba[index + 1] +
      0.0722 * rgba[index + 2]
    ) / 255;
  }

  let count = 0;
  let mean = 0;
  let sumSquaredDelta = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      const laplacian =
        4 * luminance[index] -
        luminance[index - 1] -
        luminance[index + 1] -
        luminance[index - width] -
        luminance[index + width];
      count += 1;
      const delta = laplacian - mean;
      mean += delta / count;
      sumSquaredDelta += delta * (laplacian - mean);
    }
  }

  const variance = count > 1 ? sumSquaredDelta / (count - 1) : 0;
  return clamp01(variance / (variance + normalization));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
