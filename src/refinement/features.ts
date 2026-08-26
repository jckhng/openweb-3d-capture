export interface GrayImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface ImageFeature {
  x: number;
  y: number;
  score: number;
  descriptor: Uint32Array;
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

/** Worker-safe FAST/BRIEF prototype for low-resolution accepted frames. */
export function extractImageFeatures(
  image: GrayImage,
  options: FeatureOptions = {},
): ImageFeature[] {
  validateImage(image);
  const maximumFeatures = options.maximumFeatures ?? 500;
  const threshold = options.fastThreshold ?? 18;
  const cellSize = options.cellSize ?? 12;
  const candidates: Array<Omit<ImageFeature, "descriptor">> = [];

  for (let y = BRIEF_RADIUS; y < image.height - BRIEF_RADIUS; y += 1) {
    for (let x = BRIEF_RADIUS; x < image.width - BRIEF_RADIUS; x += 1) {
      const score = Math.max(
        fastScore(image, x, y, threshold),
        cornerScore(image, x, y, threshold),
      );
      if (score > 0) candidates.push({ x, y, score });
    }
  }

  const cells = new Map<string, Omit<ImageFeature, "descriptor">>();
  for (const candidate of candidates) {
    const key = `${Math.floor(candidate.x / cellSize)}:${Math.floor(candidate.y / cellSize)}`;
    const previous = cells.get(key);
    if (!previous || candidate.score > previous.score) cells.set(key, candidate);
  }

  return [...cells.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, maximumFeatures)
    .map((feature) => ({
      ...feature,
      descriptor: briefDescriptor(image, feature.x, feature.y),
    }));
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

function briefDescriptor(image: GrayImage, x: number, y: number): Uint32Array {
  const words = new Uint32Array(8);
  for (let bit = 0; bit < BRIEF_PAIRS.length; bit += 1) {
    const [ax, ay, bx, by] = BRIEF_PAIRS[bit];
    const first = image.data[(y + ay) * image.width + x + ax];
    const second = image.data[(y + by) * image.width + x + bx];
    if (first < second) words[bit >>> 5] |= (1 << (bit & 31)) >>> 0;
  }
  return words;
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

function validateImage(image: GrayImage): void {
  if (!Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 17 || image.height < 17) {
    throw new Error("Feature image must be at least 17 by 17 pixels");
  }
  if (image.data.length !== image.width * image.height) throw new Error("Grayscale image size mismatch");
}
