import type { CaptureFrame } from "../shared/types";

export interface ColoredPoint {
  x: number;
  y: number;
  z: number;
  red: number;
  green: number;
  blue: number;
}

export interface DecodedImage {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

export interface DepthSamplingOptions {
  stride: number;
  minimumDepth: number;
  maximumDepth: number;
}

export const DEFAULT_DEPTH_SAMPLING_OPTIONS: Readonly<DepthSamplingOptions> = {
  stride: 2,
  minimumDepth: 0.15,
  maximumDepth: 5,
};

export function sampleDepthFrame(
  frame: CaptureFrame,
  depth: Uint8Array,
  image: DecodedImage,
  visit: (point: ColoredPoint) => void,
  options: DepthSamplingOptions = DEFAULT_DEPTH_SAMPLING_OPTIONS,
): number {
  const depthWidth = frame.depthWidth;
  const depthHeight = frame.depthHeight;
  const scale = frame.depthRawValueToMeters;
  const normDepthFromNormView = frame.normDepthBufferFromNormView;
  if (!depthWidth || !depthHeight || !scale || !normDepthFromNormView) return 0;
  if (!Number.isInteger(options.stride) || options.stride < 1) throw new Error("Depth stride must be positive");
  if (!(options.minimumDepth >= 0) || !(options.maximumDepth > options.minimumDepth)) {
    throw new Error("Depth range is invalid");
  }
  if (image.width < 1 || image.height < 1 || image.data.length !== image.width * image.height * 4) {
    throw new Error("Decoded image dimensions are invalid");
  }

  const inverse = invertNormalizedDepthMapping(normDepthFromNormView);
  const viewWidth = frame.width;
  const viewHeight = frame.height;
  const { fx, fy, cx, cy } = frame.intrinsics;
  if (!(viewWidth > 0) || !(viewHeight > 0) || !(fx > 0) || !(fy > 0)) return 0;

  let count = 0;
  for (let depthY = 0; depthY < depthHeight; depthY += options.stride) {
    for (let depthX = 0; depthX < depthWidth; depthX += options.stride) {
      const depthNormX = (depthX + 0.5) / depthWidth;
      const depthNormY = (depthY + 0.5) / depthHeight;
      const [viewNormX, viewNormY] = inverse(depthNormX, depthNormY);
      if (viewNormX < 0 || viewNormX >= 1 || viewNormY < 0 || viewNormY >= 1) continue;

      const depthIndex = depthY * depthWidth + depthX;
      const meters = readDepthMeters(frame.depthDataFormat, depth, depthIndex, scale);
      if (!Number.isFinite(meters) || meters < options.minimumDepth || meters > options.maximumDepth) continue;

      const pixelX = viewNormX * viewWidth;
      const pixelY = viewNormY * viewHeight;
      const cameraX = ((pixelX - cx) / fx) * meters;
      const cameraY = -((pixelY - cy) / fy) * meters;
      const cameraZ = -meters;
      const matrix = frame.cameraToWorld;
      const worldX = matrix[0][0] * cameraX + matrix[0][1] * cameraY + matrix[0][2] * cameraZ + matrix[0][3];
      const worldY = matrix[1][0] * cameraX + matrix[1][1] * cameraY + matrix[1][2] * cameraZ + matrix[1][3];
      const worldZ = matrix[2][0] * cameraX + matrix[2][1] * cameraY + matrix[2][2] * cameraZ + matrix[2][3];
      if (![worldX, worldY, worldZ].every(Number.isFinite)) continue;

      const colorX = Math.min(image.width - 1, Math.floor(viewNormX * image.width));
      const colorY = Math.min(image.height - 1, Math.floor(viewNormY * image.height));
      const colorOffset = (colorY * image.width + colorX) * 4;
      visit({
        x: worldX,
        y: worldY,
        z: worldZ,
        red: image.data[colorOffset],
        green: image.data[colorOffset + 1],
        blue: image.data[colorOffset + 2],
      });
      count += 1;
    }
  }
  return count;
}

export function invertNormalizedDepthMapping(matrix: number[][]) {
  if (matrix.length !== 4 || matrix.some((row) => row.length !== 4)) {
    throw new Error("Depth mapping must be a 4x4 matrix");
  }
  const a = matrix[0][0];
  const b = matrix[0][1];
  const c = matrix[0][3];
  const d = matrix[1][0];
  const e = matrix[1][1];
  const f = matrix[1][3];
  const determinant = a * e - b * d;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-8) {
    throw new Error("Depth mapping is not invertible in normalized view space");
  }
  return (depthX: number, depthY: number): [number, number] => {
    const x = depthX - c;
    const y = depthY - f;
    return [
      (e * x - b * y) / determinant,
      (-d * x + a * y) / determinant,
    ];
  };
}

function readDepthMeters(
  format: string | undefined,
  data: Uint8Array,
  index: number,
  scale: number,
): number {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (format === "float32") {
    const offset = index * 4;
    return offset + 4 <= data.byteLength ? view.getFloat32(offset, true) * scale : Number.NaN;
  }
  const offset = index * 2;
  return offset + 2 <= data.byteLength ? view.getUint16(offset, true) * scale : Number.NaN;
}
