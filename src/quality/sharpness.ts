// Calibrated against the first target-phone M2 dataset. The previous 0.0025
// value compressed real captures into 0.876-0.984 and could not reject blur.
const DEFAULT_NORMALIZATION = 0.03;
const TILE_NORMALIZATION = 0.015;
const DEFAULT_TEXTURE_NORMALIZATION = 0.08;
const TILE_GRID_SIZE = 3;
const GAUSSIAN_SIGMA_ONE_KERNEL = [
  0.05448868454964294,
  0.24420134200323332,
  0.4026199468942474,
  0.24420134200323332,
  0.05448868454964294,
] as const;

export interface ImageQualityAnalysis {
  sharpnessScore: number;
  textureScore: number;
  /** Experimental shadow metric; it does not control live frame acceptance. */
  sharpFramesHybridScore: number;
}

/**
 * Score several target-region tiles so a smooth wall or object surface cannot
 * dominate the focus decision. Texture is reported separately because a focus
 * score is not meaningful when the crop has almost no usable edges.
 */
export function analyzeTargetImageQuality(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): ImageQualityAnalysis {
  const luminance = luminanceImage(rgba, width, height);
  const denoised = gaussianBlurSigmaOne(luminance, width, height);
  const sharpness: number[] = [];
  const texture: number[] = [];
  const hybridSharpness: number[] = [];
  for (let tileY = 0; tileY < TILE_GRID_SIZE; tileY += 1) {
    for (let tileX = 0; tileX < TILE_GRID_SIZE; tileX += 1) {
      const x0 = Math.floor(tileX * width / TILE_GRID_SIZE);
      const x1 = Math.floor((tileX + 1) * width / TILE_GRID_SIZE);
      const y0 = Math.floor(tileY * height / TILE_GRID_SIZE);
      const y1 = Math.floor((tileY + 1) * height / TILE_GRID_SIZE);
      const metrics = regionMetrics(luminance, width, height, x0, y0, x1, y1);
      sharpness.push(metrics.variance / (metrics.variance + TILE_NORMALIZATION));
      texture.push(metrics.edgeDensity / (metrics.edgeDensity + DEFAULT_TEXTURE_NORMALIZATION));
      hybridSharpness.push(sharpFramesRegionScore(denoised, width, height, x0, y0, x1, y1));
    }
  }
  return {
    sharpnessScore: percentile(sharpness, 0.67),
    textureScore: percentile(texture, 0.67),
    sharpFramesHybridScore: percentile(hybridSharpness, 0.67),
  };
}

/**
 * Target-tiled TypeScript adaptation of Reflct Sharp Frames' MIT-licensed
 * normalized Laplacian + Tenengrad focus metric. See
 * public/THIRD_PARTY_NOTICES.txt.
 * The upstream implementation analyzes a whole image at a 512-pixel long edge;
 * this shadow metric runs on our fixed target crop and must be calibrated before
 * it can influence capture decisions.
 */
function sharpFramesRegionScore(
  denoised: Float32Array,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  if (denoised.length === 0) return 0;
  let count = 0;
  let laplacianMean = 0;
  let laplacianSquaredDelta = 0;
  let tenengradSum = 0;
  for (let y = Math.max(1, y0); y < Math.min(height - 1, y1); y += 1) {
    for (let x = Math.max(1, x0); x < Math.min(width - 1, x1); x += 1) {
      const index = y * width + x;
      const laplacian = 255 * (
        4 * denoised[index] -
        denoised[index - 1] -
        denoised[index + 1] -
        denoised[index - width] -
        denoised[index + width]
      );
      const gradientX = 255 * (
        -denoised[index - width - 1] + denoised[index - width + 1] -
        2 * denoised[index - 1] + 2 * denoised[index + 1] -
        denoised[index + width - 1] + denoised[index + width + 1]
      );
      const gradientY = 255 * (
        -denoised[index - width - 1] - 2 * denoised[index - width] - denoised[index - width + 1] +
        denoised[index + width - 1] + 2 * denoised[index + width] + denoised[index + width + 1]
      );
      count += 1;
      const delta = laplacian - laplacianMean;
      laplacianMean += delta / count;
      laplacianSquaredDelta += delta * (laplacian - laplacianMean);
      tenengradSum += gradientX * gradientX + gradientY * gradientY;
    }
  }
  if (!count) return 0;
  const laplacianVariance = laplacianSquaredDelta / count;
  const tenengrad = tenengradSum / count;
  return Math.expm1(0.5 * Math.log1p(laplacianVariance) + 0.5 * Math.log1p(tenengrad));
}

function gaussianBlurSigmaOne(
  source: Float32Array,
  width: number,
  height: number,
): Float32Array {
  if (source.length === 0) return source;
  const horizontal = new Float32Array(source.length);
  const output = new Float32Array(source.length);
  const radius = Math.floor(GAUSSIAN_SIGMA_ONE_KERNEL.length / 2);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let value = 0;
      for (let offset = -radius; offset <= radius; offset += 1) {
        value += source[y * width + reflect101(x + offset, width)] *
          GAUSSIAN_SIGMA_ONE_KERNEL[offset + radius];
      }
      horizontal[y * width + x] = value;
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let value = 0;
      for (let offset = -radius; offset <= radius; offset += 1) {
        value += horizontal[reflect101(y + offset, height) * width + x] *
          GAUSSIAN_SIGMA_ONE_KERNEL[offset + radius];
      }
      output[y * width + x] = value;
    }
  }
  return output;
}

function reflect101(index: number, length: number): number {
  if (length <= 1) return 0;
  let reflected = index;
  while (reflected < 0 || reflected >= length) {
    reflected = reflected < 0 ? -reflected : 2 * length - reflected - 2;
  }
  return reflected;
}

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
  if (!(normalization > 0) || !Number.isFinite(normalization)) {
    throw new Error("Sharpness normalization must be positive");
  }
  const luminance = luminanceImage(rgba, width, height);
  const { variance } = regionMetrics(luminance, width, height, 0, 0, width, height);
  return clamp01(variance / (variance + normalization));
}

function luminanceImage(rgba: Uint8ClampedArray, width: number, height: number): Float32Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 3 || height < 3) {
    return new Float32Array();
  }
  if (rgba.length !== width * height * 4) throw new Error("RGBA buffer size does not match dimensions");
  const luminance = new Float32Array(width * height);
  for (let index = 0, pixel = 0; index < rgba.length; index += 4, pixel += 1) {
    luminance[pixel] = (
      0.2126 * rgba[index] +
      0.7152 * rgba[index + 1] +
      0.0722 * rgba[index + 2]
    ) / 255;
  }
  return luminance;
}

function regionMetrics(
  luminance: Float32Array,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): { variance: number; edgeDensity: number } {
  if (luminance.length === 0) return { variance: 0, edgeDensity: 0 };
  let count = 0;
  let mean = 0;
  let sumSquaredDelta = 0;
  let edges = 0;
  for (let y = Math.max(1, y0); y < Math.min(height - 1, y1); y += 1) {
    for (let x = Math.max(1, x0); x < Math.min(width - 1, x1); x += 1) {
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
      const forwardDifference = Math.max(
        Math.abs(luminance[index + 1] - luminance[index]),
        Math.abs(luminance[index + width] - luminance[index]),
      );
      if (forwardDifference > 0.06) edges += 1;
    }
  }
  const variance = count > 1 ? sumSquaredDelta / (count - 1) : 0;
  return { variance, edgeDensity: count ? edges / count : 0 };
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * fraction)];
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
