import type { Intrinsics, Matrix4 } from "./types";

const MATRIX_SIZE = 4;

function assertLength(values: ArrayLike<number>): void {
  if (values.length !== MATRIX_SIZE * MATRIX_SIZE) {
    throw new Error(`Expected a 4x4 matrix, received ${values.length} values`);
  }
}

/** Convert a WebXR/DOMMatrix column-major matrix into our row-major matrix. */
export function fromWebXRTransform(
  transform: { matrix: ArrayLike<number> } | ArrayLike<number>,
): Matrix4 {
  const values = "matrix" in transform ? transform.matrix : transform;
  assertLength(values);

  return Array.from({ length: MATRIX_SIZE }, (_, row) =>
    Array.from({ length: MATRIX_SIZE }, (_, column) => values[column * MATRIX_SIZE + row]),
  );
}

/** Convert our row-major matrix to the column-major layout used by WebXR APIs. */
export function toWebXRMatrix(matrix: Matrix4): Float32Array {
  assertMatrix(matrix);
  return new Float32Array(
    Array.from({ length: MATRIX_SIZE }, (_, column) =>
      Array.from({ length: MATRIX_SIZE }, (_, row) => matrix[row][column]),
    ).flat(),
  );
}

/**
 * WebXR and Nerfstudio both use a right-handed camera with +Y up and -Z
 * forward. The world origin is arbitrary, so the canonical conversion is
 * currently an explicit identity. Keeping it here prevents convention
 * changes from spreading through capture and export code.
 */
export function toNerfstudioTransform(cameraToWorld: Matrix4): Matrix4 {
  assertMatrix(cameraToWorld);
  return cameraToWorld.map((row) => [...row]);
}

export function deriveIntrinsics(
  projectionMatrix: ArrayLike<number>,
  width: number,
  height: number,
): Intrinsics {
  assertLength(projectionMatrix);
  if (!(width > 0) || !(height > 0)) {
    throw new Error("Image dimensions must be positive");
  }

  // OpenGL/WebXR projection matrices are column-major. m[8] and m[9]
  // encode the principal-point offset for an asymmetric projection.
  return {
    fx: (width * projectionMatrix[0]) / 2,
    fy: (height * projectionMatrix[5]) / 2,
    cx: (width * (1 - projectionMatrix[8])) / 2,
    cy: (height * (1 - projectionMatrix[9])) / 2,
  };
}

export function translationOf(matrix: Matrix4): [number, number, number] {
  assertMatrix(matrix);
  return [matrix[0][3], matrix[1][3], matrix[2][3]];
}

export function poseTranslationDistance(a: Matrix4, b: Matrix4): number {
  const ta = translationOf(a);
  const tb = translationOf(b);
  return Math.hypot(ta[0] - tb[0], ta[1] - tb[1], ta[2] - tb[2]);
}

export function rotationAngleDifference(a: Matrix4, b: Matrix4): number {
  assertMatrix(a);
  assertMatrix(b);
  const relativeTrace =
    a[0][0] * b[0][0] + a[0][1] * b[0][1] + a[0][2] * b[0][2] +
    a[1][0] * b[1][0] + a[1][1] * b[1][1] + a[1][2] * b[1][2] +
    a[2][0] * b[2][0] + a[2][1] * b[2][1] + a[2][2] * b[2][2];
  const cosine = Math.max(-1, Math.min(1, (relativeTrace - 1) / 2));
  return Math.acos(cosine);
}

export function isFiniteMatrix(matrix: Matrix4): boolean {
  return (
    matrix.length === MATRIX_SIZE &&
    matrix.every((row) => row.length === MATRIX_SIZE && row.every(Number.isFinite))
  );
}

function assertMatrix(matrix: Matrix4): void {
  if (!isFiniteMatrix(matrix)) {
    throw new Error("Expected a finite 4x4 matrix");
  }
}
