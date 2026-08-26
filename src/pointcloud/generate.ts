import type { CaptureDataset, CaptureFrame } from "../shared/types";
import { type DecodedImage, sampleDepthFrame } from "./depth-points";
import { encodeBinaryPointCloudPly } from "./ply";
import { VoxelAccumulator } from "./voxel";

export interface SeedFrameSource {
  frame: CaptureFrame;
  loadDepth(): Promise<Uint8Array>;
  loadImage(): Promise<DecodedImage>;
}

export interface SeedPointCloudOptions {
  voxelSize: number;
  maximumPoints: number;
  minimumObservations: number;
}

export interface SeedPointCloudResult {
  data: Uint8Array;
  pointCount: number;
  sampledPointCount: number;
  bounds: {
    minimum: [number, number, number];
    maximum: [number, number, number];
  };
}

export const DEFAULT_SEED_POINT_CLOUD_OPTIONS: Readonly<SeedPointCloudOptions> = {
  voxelSize: 0.015,
  maximumPoints: 500_000,
  minimumObservations: 1,
};

export async function generateSeedPointCloud(
  sources: SeedFrameSource[],
  options: SeedPointCloudOptions = DEFAULT_SEED_POINT_CLOUD_OPTIONS,
): Promise<SeedPointCloudResult | undefined> {
  if (!sources.length) return undefined;
  const accumulator = new VoxelAccumulator(options.voxelSize);
  let sampledPointCount = 0;
  for (const source of sources) {
    const [depth, image] = await Promise.all([source.loadDepth(), source.loadImage()]);
    sampledPointCount += sampleDepthFrame(source.frame, depth, image, (point) => accumulator.add(point));
  }
  const points = accumulator.toPoints(options.maximumPoints, options.minimumObservations);
  if (!points.length) return undefined;
  return {
    data: encodeBinaryPointCloudPly(points),
    pointCount: points.length,
    sampledPointCount,
    bounds: pointBounds(points),
  };
}

export async function generateDatasetSeedPointCloud(
  dataset: CaptureDataset,
): Promise<SeedPointCloudResult | undefined> {
  const sources: SeedFrameSource[] = [];
  for (const frame of dataset.frames) {
    if (!frame.imagePath || !frame.depthPath || !frame.normDepthBufferFromNormView) continue;
    const image = dataset.images.get(frame.imagePath);
    const depth = dataset.depths.get(frame.depthPath);
    if (!image || !depth) continue;
    sources.push({
      frame,
      loadDepth: async () => new Uint8Array(await depth.arrayBuffer()),
      loadImage: async () => decodeBrowserImage(image),
    });
  }
  return generateSeedPointCloud(sources);
}

async function decodeBrowserImage(blob: Blob): Promise<DecodedImage> {
  if (typeof createImageBitmap !== "function") throw new Error("Image decoding is unavailable for point-cloud export");
  const bitmap = await createImageBitmap(blob);
  try {
    const maximumDimension = 256;
    const scale = maximumDimension / Math.max(bitmap.width, bitmap.height);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Canvas decoding is unavailable for point-cloud export");
    context.drawImage(bitmap, 0, 0, width, height);
    const image = context.getImageData(0, 0, width, height);
    return { width, height, data: image.data };
  } finally {
    bitmap.close();
  }
}

function pointBounds(points: Array<{ x: number; y: number; z: number }>) {
  const minimum: [number, number, number] = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const maximum: [number, number, number] = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (const point of points) {
    minimum[0] = Math.min(minimum[0], point.x);
    minimum[1] = Math.min(minimum[1], point.y);
    minimum[2] = Math.min(minimum[2], point.z);
    maximum[0] = Math.max(maximum[0], point.x);
    maximum[1] = Math.max(maximum[1], point.y);
    maximum[2] = Math.max(maximum[2], point.z);
  }
  return { minimum, maximum };
}
