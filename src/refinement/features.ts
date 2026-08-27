export interface GrayImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface ImageFeature {
  x: number;
  y: number;
  score: number;
  scale: number;
  orientation: number;
  descriptor: Uint32Array;
  gradientDescriptor: Uint8Array;
}

export interface FeatureMatch {
  featureA: number;
  featureB: number;
  distance: number;
}

export interface FeatureOptions {
  maximumFeatures?: number;
  fastThreshold?: number;
  cellSize?: number;
}

const FAST_CIRCLE = [
  [0, -3], [1, -3], [2, -2], [3, -1],
  [3, 0], [3, 1], [2, 2], [1, 3],
  [0, 3], [-1, 3], [-2, 2], [-3, 1],
  [-3, 0], [-3, -1], [-2, -2], [-1, -3],
] as const;
const BRIEF_RADIUS = 8;
const BRIEF_PAIRS = createBriefPairs(256);
const PYRAMID_SCALES = [1, 0.75, 0.5] as const;

interface PyramidCandidate {
  x: number;
  y: number;
  score: number;
  scale: number;
  level: GrayImage;
}

/** Worker-safe multi-scale FAST/BRIEF tracking for low-resolution accepted frames. */
export function extractImageFeatures(
  image: GrayImage,
  options: FeatureOptions = {},
): ImageFeature[] {
  validateImage(image);
  const maximumFeatures = options.maximumFeatures ?? 500;
  const threshold = options.fastThreshold ?? 18;
  const cellSize = options.cellSize ?? 12;
  const featuresPerLevel = Math.ceil(maximumFeatures / PYRAMID_SCALES.length);
  const candidates: PyramidCandidate[] = [];

  for (const scale of PYRAMID_SCALES) {
    const level = scale === 1 ? image : resizeGray(image, scale);
    const levelCandidates: Array<Pick<PyramidCandidate, "x" | "y" | "score">> = [];
    for (let y = BRIEF_RADIUS; y < level.height - BRIEF_RADIUS; y += 1) {
      for (let x = BRIEF_RADIUS; x < level.width - BRIEF_RADIUS; x += 1) {
        const score = Math.max(
          fastScore(level, x, y, threshold),
          cornerScore(level, x, y, threshold),
        );
        if (score > 0) levelCandidates.push({ x, y, score });
      }
    }

    const levelCellSize = Math.max(4, Math.round(cellSize * scale));
    const cells = new Map<string, Pick<PyramidCandidate, "x" | "y" | "score">>();
    for (const candidate of levelCandidates) {
      const key = `${Math.floor(candidate.x / levelCellSize)}:${Math.floor(candidate.y / levelCellSize)}`;
      const previous = cells.get(key);
      if (!previous || candidate.score > previous.score) cells.set(key, candidate);
    }
    candidates.push(
      ...[...cells.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, featuresPerLevel)
        .map((candidate) => ({ ...candidate, scale, level })),
    );
  }

  return candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, maximumFeatures)
    .map((feature) => {
      const orientation = intensityOrientation(feature.level, feature.x, feature.y);
      return {
        x: feature.x / feature.scale,
        y: feature.y / feature.scale,
        score: feature.score,
        scale: 1 / feature.scale,
        orientation,
        descriptor: briefDescriptor(feature.level, feature.x, feature.y, orientation),
        gradientDescriptor: gradientDescriptor(feature.level, feature.x, feature.y, orientation),
      };
    });
}

/** SIFT-like gradient matching reserved for graph repair and wide-baseline edges. */
export function matchScaleInvariantFeatures(
  featuresA: ImageFeature[],
  featuresB: ImageFeature[],
  ratio = 0.78,
): FeatureMatch[] {
  if (!(ratio > 0 && ratio < 1)) throw new Error("Match ratio must be between zero and one");
  if (featuresA.length === 0 || featuresB.length < 2) return [];
  const candidates: FeatureMatch[] = [];
  const ratioSquared = ratio * ratio;
  for (let indexA = 0; indexA < featuresA.length; indexA += 1) {
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    let secondDistance = Number.POSITIVE_INFINITY;
    for (let indexB = 0; indexB < featuresB.length; indexB += 1) {
      const distance = squaredDescriptorDistance(
        featuresA[indexA].gradientDescriptor,
        featuresB[indexB].gradientDescriptor,
        secondDistance,
      );
      if (distance < bestDistance) {
        secondDistance = bestDistance;
        bestDistance = distance;
        bestIndex = indexB;
      } else if (distance < secondDistance) {
        secondDistance = distance;
      }
    }
    if (bestIndex >= 0 && bestDistance < ratioSquared * secondDistance) {
      candidates.push({ featureA: indexA, featureB: bestIndex, distance: Math.sqrt(bestDistance) });
    }
  }
  const bestByTarget = new Map<number, FeatureMatch>();
  for (const candidate of candidates) {
    const previous = bestByTarget.get(candidate.featureB);
    if (!previous || candidate.distance < previous.distance) {
      bestByTarget.set(candidate.featureB, candidate);
    }
  }
  return [...bestByTarget.values()];
}

export function matchImageFeatures(
  featuresA: ImageFeature[],
  featuresB: ImageFeature[],
  ratio = 0.8,
  maximumDistance = 80,
): FeatureMatch[] {
  if (!(ratio > 0 && ratio < 1)) throw new Error("Match ratio must be between zero and one");
  if (!(maximumDistance > 0)) throw new Error("Maximum descriptor distance must be positive");
  if (featuresA.length === 0 || featuresB.length < 2) return [];

  const reverseBest = featuresB.map((featureB) => {
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < featuresA.length; index += 1) {
      const distance = hammingDistance(featureB.descriptor, featuresA[index].descriptor);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
    return bestIndex;
  });

  const matches: FeatureMatch[] = [];
  for (let indexA = 0; indexA < featuresA.length; indexA += 1) {
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    let secondDistance = Number.POSITIVE_INFINITY;
    for (let indexB = 0; indexB < featuresB.length; indexB += 1) {
      const distance = hammingDistance(featuresA[indexA].descriptor, featuresB[indexB].descriptor);
      if (distance < bestDistance) {
        secondDistance = bestDistance;
        bestDistance = distance;
        bestIndex = indexB;
      } else if (distance < secondDistance) {
        secondDistance = distance;
      }
    }
    if (
      bestIndex >= 0 &&
      bestDistance <= maximumDistance &&
      bestDistance < ratio * secondDistance &&
      reverseBest[bestIndex] === indexA
    ) {
      matches.push({ featureA: indexA, featureB: bestIndex, distance: bestDistance });
    }
  }
  return matches;
}

function fastScore(image: GrayImage, x: number, y: number, threshold: number): number {
  const center = image.data[y * image.width + x];
  const differences = FAST_CIRCLE.map(([dx, dy]) => image.data[(y + dy) * image.width + x + dx] - center);
  let best = 0;
  for (const polarity of [-1, 1]) {
    let run = 0;
    for (let index = 0; index < differences.length + 8; index += 1) {
      const value = differences[index % differences.length] * polarity;
      run = value > threshold ? run + 1 : 0;
      if (run >= 9) best = Math.max(best, Math.abs(value));
    }
  }
  return best;
}

function cornerScore(image: GrayImage, x: number, y: number, threshold: number): number {
  let xx = 0;
  let yy = 0;
  let xy = 0;
  for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      const index = (y + offsetY) * image.width + x + offsetX;
      const gradientX = image.data[index + 1] - image.data[index - 1];
      const gradientY = image.data[index + image.width] - image.data[index - image.width];
      xx += gradientX * gradientX;
      yy += gradientY * gradientY;
      xy += gradientX * gradientY;
    }
  }
  const trace = xx + yy;
  const minimumEigenvalue = (trace - Math.sqrt(Math.max(0, (xx - yy) ** 2 + 4 * xy ** 2))) / 2;
  return minimumEigenvalue > threshold * threshold * 4 ? minimumEigenvalue : 0;
}

function briefDescriptor(
  image: GrayImage,
  x: number,
  y: number,
  orientation: number,
): Uint32Array {
  const words = new Uint32Array(8);
  const cosine = Math.cos(orientation);
  const sine = Math.sin(orientation);
  for (let bit = 0; bit < BRIEF_PAIRS.length; bit += 1) {
    const [ax, ay, bx, by] = BRIEF_PAIRS[bit];
    const rotatedAx = Math.round(cosine * ax - sine * ay);
    const rotatedAy = Math.round(sine * ax + cosine * ay);
    const rotatedBx = Math.round(cosine * bx - sine * by);
    const rotatedBy = Math.round(sine * bx + cosine * by);
    const first = image.data[(y + rotatedAy) * image.width + x + rotatedAx];
    const second = image.data[(y + rotatedBy) * image.width + x + rotatedBx];
    if (first < second) words[bit >>> 5] |= (1 << (bit & 31)) >>> 0;
  }
  return words;
}

function intensityOrientation(image: GrayImage, x: number, y: number): number {
  let horizontalMoment = 0;
  let verticalMoment = 0;
  for (let offsetY = -BRIEF_RADIUS; offsetY <= BRIEF_RADIUS; offsetY += 1) {
    for (let offsetX = -BRIEF_RADIUS; offsetX <= BRIEF_RADIUS; offsetX += 1) {
      if (offsetX * offsetX + offsetY * offsetY > BRIEF_RADIUS * BRIEF_RADIUS) continue;
      const intensity = image.data[(y + offsetY) * image.width + x + offsetX];
      horizontalMoment += offsetX * intensity;
      verticalMoment += offsetY * intensity;
    }
  }
  return Math.atan2(verticalMoment, horizontalMoment);
}

function gradientDescriptor(
  image: GrayImage,
  x: number,
  y: number,
  orientation: number,
): Uint8Array {
  const cells = 4;
  const bins = 8;
  const cellWidth = 4;
  const radius = cells * cellWidth / 2;
  const histogram = new Float64Array(cells * cells * bins);
  const cosine = Math.cos(orientation);
  const sine = Math.sin(orientation);
  for (let patchY = -radius; patchY < radius; patchY += 1) {
    for (let patchX = -radius; patchX < radius; patchX += 1) {
      const sampleX = Math.round(x + cosine * patchX - sine * patchY);
      const sampleY = Math.round(y + sine * patchX + cosine * patchY);
      if (sampleX <= 0 || sampleY <= 0 || sampleX >= image.width - 1 || sampleY >= image.height - 1) {
        continue;
      }
      const gradientX = image.data[sampleY * image.width + sampleX + 1]
        - image.data[sampleY * image.width + sampleX - 1];
      const gradientY = image.data[(sampleY + 1) * image.width + sampleX]
        - image.data[(sampleY - 1) * image.width + sampleX];
      const magnitude = Math.hypot(gradientX, gradientY)
        * Math.exp(-(patchX * patchX + patchY * patchY) / 128);
      const relativeAngle = normalizeAngle(Math.atan2(gradientY, gradientX) - orientation);
      const bin = Math.floor(relativeAngle * bins / (Math.PI * 2)) % bins;
      const cellX = Math.min(cells - 1, Math.floor((patchX + radius) / cellWidth));
      const cellY = Math.min(cells - 1, Math.floor((patchY + radius) / cellWidth));
      histogram[(cellY * cells + cellX) * bins + bin] += magnitude;
    }
  }
  normalizeHistogram(histogram, Number.POSITIVE_INFINITY);
  normalizeHistogram(histogram, 0.2);
  const descriptor = new Uint8Array(histogram.length);
  for (let index = 0; index < histogram.length; index += 1) {
    descriptor[index] = Math.min(255, Math.round(histogram[index] * 512));
  }
  return descriptor;
}

function normalizeHistogram(histogram: Float64Array, maximum: number): void {
  let squaredNorm = 0;
  for (let index = 0; index < histogram.length; index += 1) {
    histogram[index] = Math.min(maximum, histogram[index]);
    squaredNorm += histogram[index] * histogram[index];
  }
  const norm = Math.sqrt(squaredNorm);
  if (norm <= 1e-12) return;
  for (let index = 0; index < histogram.length; index += 1) histogram[index] /= norm;
}

function normalizeAngle(angle: number): number {
  const fullTurn = Math.PI * 2;
  return ((angle % fullTurn) + fullTurn) % fullTurn;
}

function squaredDescriptorDistance(a: Uint8Array, b: Uint8Array, stopAbove: number): number {
  if (a.length !== b.length) throw new Error("Gradient descriptor lengths do not match");
  let distance = 0;
  for (let index = 0; index < a.length; index += 1) {
    const difference = a[index] - b[index];
    distance += difference * difference;
    if (distance > stopAbove) return distance;
  }
  return distance;
}

function hammingDistance(a: Uint32Array, b: Uint32Array): number {
  if (a.length !== b.length) throw new Error("Descriptor lengths do not match");
  let distance = 0;
  for (let index = 0; index < a.length; index += 1) {
    let value = (a[index] ^ b[index]) >>> 0;
    value -= (value >>> 1) & 0x55555555;
    value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
    distance += (((value + (value >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  }
  return distance;
}

function createBriefPairs(count: number): Array<readonly [number, number, number, number]> {
  let state = 0x6d2b79f5;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state % (BRIEF_RADIUS * 2 + 1)) - BRIEF_RADIUS;
  };
  return Array.from({ length: count }, () => [next(), next(), next(), next()] as const);
}

function resizeGray(image: GrayImage, scale: number): GrayImage {
  const width = Math.max(17, Math.round(image.width * scale));
  const height = Math.max(17, Math.round(image.height * scale));
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(image.height - 1, (y + 0.5) / scale - 0.5);
    const y0 = Math.max(0, Math.floor(sourceY));
    const y1 = Math.min(image.height - 1, y0 + 1);
    const weightY = sourceY - y0;
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(image.width - 1, (x + 0.5) / scale - 0.5);
      const x0 = Math.max(0, Math.floor(sourceX));
      const x1 = Math.min(image.width - 1, x0 + 1);
      const weightX = sourceX - x0;
      const top = image.data[y0 * image.width + x0] * (1 - weightX)
        + image.data[y0 * image.width + x1] * weightX;
      const bottom = image.data[y1 * image.width + x0] * (1 - weightX)
        + image.data[y1 * image.width + x1] * weightX;
      data[y * width + x] = Math.round(top * (1 - weightY) + bottom * weightY);
    }
  }
  return { width, height, data };
}

function validateImage(image: GrayImage): void {
  if (!Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 17 || image.height < 17) {
    throw new Error("Feature image must be at least 17 by 17 pixels");
  }
  if (image.data.length !== image.width * image.height) throw new Error("Grayscale image size mismatch");
}
