import type { Matrix4 } from "../shared/types";

export interface SimilarityTransform {
  scale: number;
  rotation: number[][];
  translation: [number, number, number];
}

/** Horn absolute orientation: align source camera centers to target centers. */
export function estimatePoseSimilarity(source: Matrix4[], target: Matrix4[]): SimilarityTransform {
  if (source.length !== target.length || source.length < 3) {
    throw new Error("Similarity alignment requires at least three corresponding poses");
  }
  const sourceCenters = source.map(center);
  const targetCenters = target.map(center);
  const sourceMean = mean3(sourceCenters);
  const targetMean = mean3(targetCenters);
  const covariance = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  let sourceVariance = 0;
  for (let index = 0; index < source.length; index += 1) {
    const a = subtract3(sourceCenters[index], sourceMean);
    const b = subtract3(targetCenters[index], targetMean);
    sourceVariance += dot3(a, a);
    for (let row = 0; row < 3; row += 1) {
      for (let column = 0; column < 3; column += 1) covariance[row][column] += a[row] * b[column];
    }
  }
  if (sourceVariance < 1e-12) throw new Error("Similarity alignment source trajectory is degenerate");
  const [sxx, sxy, sxz] = covariance[0];
  const [syx, syy, syz] = covariance[1];
  const [szx, szy, szz] = covariance[2];
  const trace = sxx + syy + szz;
  const horn = [
    [trace, syz - szy, szx - sxz, sxy - syx],
    [syz - szy, sxx - syy - szz, sxy + syx, szx + sxz],
    [szx - sxz, sxy + syx, -sxx + syy - szz, syz + szy],
    [sxy - syx, szx + sxz, syz + szy, -sxx - syy + szz],
  ];
  const quaternion = largestEigenvectorSymmetric(horn);
  const rotation = quaternionRotation(quaternion);
  let numerator = 0;
  for (let index = 0; index < source.length; index += 1) {
    const a = subtract3(sourceCenters[index], sourceMean);
    const b = subtract3(targetCenters[index], targetMean);
    numerator += dot3(b, multiplyMatrixVector(rotation, a));
  }
  const scale = numerator / sourceVariance;
  const rotatedMean = multiplyMatrixVector(rotation, sourceMean);
  const translation: [number, number, number] = [
    targetMean[0] - scale * rotatedMean[0],
    targetMean[1] - scale * rotatedMean[1],
    targetMean[2] - scale * rotatedMean[2],
  ];
  return { scale, rotation, translation };
}

export function applyPoseSimilarity(pose: Matrix4, transform: SimilarityTransform): Matrix4 {
  const poseRotation = pose.slice(0, 3).map((row) => row.slice(0, 3));
  const rotation = multiply3(transform.rotation, poseRotation);
  const transformedCenter = multiplyMatrixVector(transform.rotation, center(pose)).map(
    (value, index) => transform.scale * value + transform.translation[index],
  );
  return [
    [...rotation[0], transformedCenter[0]],
    [...rotation[1], transformedCenter[1]],
    [...rotation[2], transformedCenter[2]],
    [0, 0, 0, 1],
  ];
}

function largestEigenvectorSymmetric(input: number[][]): [number, number, number, number] {
  const matrix = input.map((row) => [...row]);
  const vectors = identity4();
  for (let iteration = 0; iteration < 80; iteration += 1) {
    let p = 0;
    let q = 1;
    let maximum = 0;
    for (let row = 0; row < 4; row += 1) {
      for (let column = row + 1; column < 4; column += 1) {
        if (Math.abs(matrix[row][column]) > maximum) {
          maximum = Math.abs(matrix[row][column]);
          p = row;
          q = column;
        }
      }
    }
    if (maximum < 1e-12) break;
    const angle = 0.5 * Math.atan2(2 * matrix[p][q], matrix[q][q] - matrix[p][p]);
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    const app = matrix[p][p];
    const aqq = matrix[q][q];
    const apq = matrix[p][q];
    matrix[p][p] = cosine * cosine * app - 2 * sine * cosine * apq + sine * sine * aqq;
    matrix[q][q] = sine * sine * app + 2 * sine * cosine * apq + cosine * cosine * aqq;
    matrix[p][q] = 0;
    matrix[q][p] = 0;
    for (let index = 0; index < 4; index += 1) {
      if (index === p || index === q) continue;
      const aip = matrix[index][p];
      const aiq = matrix[index][q];
      matrix[index][p] = cosine * aip - sine * aiq;
      matrix[p][index] = matrix[index][p];
      matrix[index][q] = sine * aip + cosine * aiq;
      matrix[q][index] = matrix[index][q];
    }
    for (let row = 0; row < 4; row += 1) {
      const vip = vectors[row][p];
      const viq = vectors[row][q];
      vectors[row][p] = cosine * vip - sine * viq;
      vectors[row][q] = sine * vip + cosine * viq;
    }
  }
  let largest = 0;
  for (let index = 1; index < 4; index += 1) {
    if (matrix[index][index] > matrix[largest][largest]) largest = index;
  }
  const result = vectors.map((row) => row[largest]);
  const length = Math.hypot(...result);
  return result.map((value) => value / length) as [number, number, number, number];
}

function quaternionRotation([w, x, y, z]: [number, number, number, number]): number[][] {
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
}

function center(pose: Matrix4): [number, number, number] {
  return [pose[0][3], pose[1][3], pose[2][3]];
}

function mean3(values: Array<[number, number, number]>): [number, number, number] {
  return [0, 1, 2].map((axis) => values.reduce((sum, value) => sum + value[axis], 0) / values.length) as
    [number, number, number];
}

function subtract3(a: number[], b: number[]): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot3(a: number[], b: number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function multiplyMatrixVector(matrix: number[][], vector: number[]): [number, number, number] {
  return matrix.map((row) => dot3(row, vector)) as [number, number, number];
}

function multiply3(a: number[][], b: number[][]): number[][] {
  return a.map((row) => b[0].map((_, column) => row.reduce(
    (sum, value, index) => sum + value * b[index][column], 0,
  )));
}

function identity4(): number[][] {
  return Array.from({ length: 4 }, (_, row) =>
    Array.from({ length: 4 }, (_, column) => row === column ? 1 : 0));
}
