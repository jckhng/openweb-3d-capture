import type { Intrinsics, LensDistortion, Matrix4 } from "../shared/types";

export interface PointMatch {
  pointA: [number, number];
  pointB: [number, number];
}

export interface ReprojectionScore {
  count: number;
  medianPixels: number;
  p90Pixels: number;
  maximumPixels: number;
}

/** Score feature tracks against WebXR-basis camera poses using Sampson error. */
export function scoreEpipolarConsistency(
  matches: PointMatch[],
  cameraToWorldA: Matrix4,
  cameraToWorldB: Matrix4,
  intrinsics: Intrinsics,
  distortion?: LensDistortion,
): ReprojectionScore {
  if (matches.length === 0) return { count: 0, medianPixels: 0, p90Pixels: 0, maximumPixels: 0 };
  const essential = relativeEssential(cameraToWorldA, cameraToWorldB);
  const pixelScale = (intrinsics.fx + intrinsics.fy) / 2;
  const errors = matches.map((match) => {
    const a = normalize(match.pointA, intrinsics, distortion);
    const b = normalize(match.pointB, intrinsics, distortion);
    const ea = multiplyMatrixVector(essential, a);
    const etb = multiplyMatrixVector(transpose3(essential), b);
    const numerator = Math.abs(dot3(b, ea));
    const denominator = Math.sqrt(ea[0] ** 2 + ea[1] ** 2 + etb[0] ** 2 + etb[1] ** 2);
    return denominator > 1e-12 ? (numerator / denominator) * pixelScale : Number.POSITIVE_INFINITY;
  }).sort((a, b) => a - b);
  return {
    count: errors.length,
    medianPixels: percentile(errors, 0.5),
    p90Pixels: percentile(errors, 0.9),
    maximumPixels: errors.at(-1)!,
  };
}

function relativeEssential(a: Matrix4, b: Matrix4): number[][] {
  const cameraBasis = [[1, 0, 0], [0, -1, 0], [0, 0, -1]];
  const worldFromCameraA = multiply3(rotation3(a), cameraBasis);
  const worldFromCameraB = multiply3(rotation3(b), cameraBasis);
  const cameraBFromWorld = transpose3(worldFromCameraB);
  const rotation = multiply3(cameraBFromWorld, worldFromCameraA);
  const centerDelta = [a[0][3] - b[0][3], a[1][3] - b[1][3], a[2][3] - b[2][3]];
  const translation = multiplyMatrixVector(cameraBFromWorld, centerDelta);
  return multiply3(skew(translation), rotation);
}

function normalize(
  point: [number, number],
  intrinsics: Intrinsics,
  distortion?: LensDistortion,
): number[] {
  const distortedX = (point[0] - intrinsics.cx) / intrinsics.fx;
  const distortedY = (point[1] - intrinsics.cy) / intrinsics.fy;
  if (!distortion) return [distortedX, distortedY, 1];
  let x = distortedX;
  let y = distortedY;
  for (let iteration = 0; iteration < 6; iteration += 1) {
    const radiusSquared = x * x + y * y;
    const radial = 1 + distortion.k1 * radiusSquared + distortion.k2 * radiusSquared ** 2;
    const tangentialX = 2 * distortion.p1 * x * y + distortion.p2 * (radiusSquared + 2 * x * x);
    const tangentialY = distortion.p1 * (radiusSquared + 2 * y * y) + 2 * distortion.p2 * x * y;
    x = (distortedX - tangentialX) / radial;
    y = (distortedY - tangentialY) / radial;
  }
  return [x, y, 1];
}

function rotation3(matrix: Matrix4): number[][] {
  return matrix.slice(0, 3).map((row) => row.slice(0, 3));
}

function skew(vector: number[]): number[][] {
  return [[0, -vector[2], vector[1]], [vector[2], 0, -vector[0]], [-vector[1], vector[0], 0]];
}

function multiply3(a: number[][], b: number[][]): number[][] {
  return a.map((row) => b[0].map((_, column) => row.reduce((sum, value, index) => sum + value * b[index][column], 0)));
}

function multiplyMatrixVector(matrix: number[][], vector: number[]): number[] {
  return matrix.map((row) => dot3(row, vector));
}

function transpose3(matrix: number[][]): number[][] {
  return matrix[0].map((_, column) => matrix.map((row) => row[column]));
}

function dot3(a: number[], b: number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}
