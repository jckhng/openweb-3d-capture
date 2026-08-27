import type { PointMatch } from "./reprojection";

export interface GeometricVerification {
  matches: number;
  inliers: number;
  inlierRatio: number;
  accepted: boolean;
}

const SAMPLE_SIZE = 8;
const ITERATIONS = 160;

/** Pose-independent normalized eight-point RANSAC for worker-side edge verification. */
export function verifyFeatureGeometry(
  matches: PointMatch[],
  width: number,
  height: number,
): GeometricVerification {
  if (matches.length < SAMPLE_SIZE) return result(matches.length, 0);
  const scale = Math.max(width, height);
  const normalized = matches.map((match) => ({
    pointA: normalize(match.pointA, width, height, scale),
    pointB: normalize(match.pointB, width, height, scale),
  }));
  const threshold = 3 / scale;
  let bestInliers = 0;
  let randomState = (matches.length * 2654435761) >>> 0;
  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    const indices: number[] = [];
    while (indices.length < SAMPLE_SIZE) {
      randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
      const index = randomState % normalized.length;
      if (!indices.includes(index)) indices.push(index);
    }
    const fundamental = fundamentalFromEight(indices.map((index) => normalized[index]));
    if (!fundamental) continue;
    let inliers = 0;
    for (const match of normalized) {
      if (sampsonDistance(match.pointA, match.pointB, fundamental) <= threshold) inliers += 1;
    }
    bestInliers = Math.max(bestInliers, inliers);
  }
  return result(matches.length, bestInliers);
}

function result(matches: number, inliers: number): GeometricVerification {
  const inlierRatio = matches ? inliers / matches : 0;
  return {
    matches,
    inliers,
    inlierRatio,
    accepted: inliers >= 12 && inlierRatio >= 0.35,
  };
}

function fundamentalFromEight(matches: PointMatch[]): number[] | undefined {
  const matrix = matches.map(({ pointA: [x1, y1], pointB: [x2, y2] }) => [
    x2 * x1, x2 * y1, x2,
    y2 * x1, y2 * y1, y2,
    x1, y1, 1,
  ]);
  const pivotColumns: number[] = [];
  let pivotRow = 0;
  for (let column = 0; column < 9 && pivotRow < 8; column += 1) {
    let selected = pivotRow;
    for (let row = pivotRow + 1; row < 8; row += 1) {
      if (Math.abs(matrix[row][column]) > Math.abs(matrix[selected][column])) selected = row;
    }
    if (Math.abs(matrix[selected][column]) < 1e-10) continue;
    [matrix[pivotRow], matrix[selected]] = [matrix[selected], matrix[pivotRow]];
    const divisor = matrix[pivotRow][column];
    for (let value = column; value < 9; value += 1) matrix[pivotRow][value] /= divisor;
    for (let row = 0; row < 8; row += 1) {
      if (row === pivotRow) continue;
      const factor = matrix[row][column];
      for (let value = column; value < 9; value += 1) {
        matrix[row][value] -= factor * matrix[pivotRow][value];
      }
    }
    pivotColumns.push(column);
    pivotRow += 1;
  }
  if (pivotColumns.length < 8) return undefined;
  const freeColumn = Array.from({ length: 9 }, (_, index) => index)
    .find((column) => !pivotColumns.includes(column));
  if (freeColumn === undefined) return undefined;
  const solution = new Array<number>(9).fill(0);
  solution[freeColumn] = 1;
  for (let row = pivotColumns.length - 1; row >= 0; row -= 1) {
    const pivot = pivotColumns[row];
    let value = 0;
    for (let column = pivot + 1; column < 9; column += 1) value += matrix[row][column] * solution[column];
    solution[pivot] = -value;
  }
  const norm = Math.hypot(...solution);
  return norm > 1e-12 ? solution.map((value) => value / norm) : undefined;
}

function sampsonDistance(a: [number, number], b: [number, number], f: number[]): number {
  const fa0 = f[0] * a[0] + f[1] * a[1] + f[2];
  const fa1 = f[3] * a[0] + f[4] * a[1] + f[5];
  const fb0 = f[0] * b[0] + f[3] * b[1] + f[6];
  const fb1 = f[1] * b[0] + f[4] * b[1] + f[7];
  const numerator = Math.abs(b[0] * fa0 + b[1] * fa1 + f[6] * a[0] + f[7] * a[1] + f[8]);
  const denominator = Math.sqrt(fa0 * fa0 + fa1 * fa1 + fb0 * fb0 + fb1 * fb1);
  return denominator > 1e-12 ? numerator / denominator : Number.POSITIVE_INFINITY;
}

function normalize(
  point: [number, number],
  width: number,
  height: number,
  scale: number,
): [number, number] {
  return [(point[0] - width / 2) / scale, (point[1] - height / 2) / scale];
}
