import type { Intrinsics, Matrix4 } from "../shared/types";
import { invertNormalizedDepthMapping, readDepthMeters } from "./depth-points";

const MAXIMUM_DISPLAY_POINTS = 260;

export interface CaptureMapPoint {
  /** Position relative to the locked target, normalized by radiusMeters. */
  x: number;
  y: number;
  z: number;
  /** Number of distinct accepted viewpoints that observed this voxel. */
  support: number;
}

export interface CaptureMapSnapshot {
  points: CaptureMapPoint[];
  radiusMeters: number;
  observedViewCount: number;
}

export interface CaptureMapDepthFrame {
  frameId: number;
  cameraToWorld: Matrix4;
  intrinsics: Intrinsics;
  viewWidth: number;
  viewHeight: number;
  depthWidth: number;
  depthHeight: number;
  depthRawValueToMeters: number;
  depthDataFormat?: string;
  normDepthBufferFromNormView: Matrix4;
  depth: Uint8Array;
  targetNdc?: [number, number];
  targetDistance?: number;
}

interface VoxelEntry {
  x: number;
  y: number;
  z: number;
  samples: number;
  support: number;
}

/**
 * A bounded, display-only depth constellation. It is deliberately separate
 * from the exported seed cloud and never changes capture/readiness decisions.
 */
export class CaptureMapAccumulator {
  private readonly voxels = new Map<string, VoxelEntry>();
  private readonly ingestedFrameIds = new Set<number>();
  private readonly voxelSize: number;
  readonly radiusMeters: number;
  private observedViewCount = 0;

  constructor(
    private readonly target: [number, number, number],
    referenceDistanceMeters: number,
  ) {
    const distance = Number.isFinite(referenceDistanceMeters) && referenceDistanceMeters > 0
      ? referenceDistanceMeters
      : 1;
    this.radiusMeters = clamp(distance * 0.55, 0.22, 0.8);
    this.voxelSize = clamp(distance * 0.018, 0.01, 0.025);
  }

  ingest(frame: CaptureMapDepthFrame): number {
    if (this.ingestedFrameIds.has(frame.frameId)) return 0;
    if (
      !(frame.viewWidth > 0) || !(frame.viewHeight > 0) ||
      !(frame.depthWidth > 0) || !(frame.depthHeight > 0) ||
      !(frame.intrinsics.fx > 0) || !(frame.intrinsics.fy > 0)
    ) return 0;

    const inverse = invertNormalizedDepthMapping(frame.normDepthBufferFromNormView);
    const targetViewX = ((frame.targetNdc?.[0] ?? 0) + 1) / 2;
    const targetViewY = (1 - (frame.targetNdc?.[1] ?? 0)) / 2;
    const cameraDistance = Math.hypot(
      frame.cameraToWorld[0][3] - this.target[0],
      frame.cameraToWorld[1][3] - this.target[1],
      frame.cameraToWorld[2][3] - this.target[2],
    );
    const targetDistance = frame.targetDistance && frame.targetDistance > 0
      ? frame.targetDistance
      : cameraDistance;
    const depthTolerance = clamp(targetDistance * 0.35, 0.15, 0.6);
    const stride = Math.max(1, Math.ceil(Math.max(frame.depthWidth, frame.depthHeight) / 36));
    const frameVoxels = new Map<string, VoxelEntry>();

    for (let depthY = 0; depthY < frame.depthHeight; depthY += stride) {
      for (let depthX = 0; depthX < frame.depthWidth; depthX += stride) {
        const depthNormX = (depthX + 0.5) / frame.depthWidth;
        const depthNormY = (depthY + 0.5) / frame.depthHeight;
        const [viewX, viewY] = inverse(depthNormX, depthNormY);
        const roiX = (viewX - targetViewX) / 0.38;
        const roiY = (viewY - targetViewY) / 0.38;
        if (roiX * roiX + roiY * roiY > 1) continue;

        const index = depthY * frame.depthWidth + depthX;
        const meters = readDepthMeters(
          frame.depthDataFormat,
          frame.depth,
          index,
          frame.depthRawValueToMeters,
        );
        if (!Number.isFinite(meters) || meters < 0.15 || meters > 5) continue;
        if (Number.isFinite(targetDistance) && Math.abs(meters - targetDistance) > depthTolerance) continue;

        const pixelX = viewX * frame.viewWidth;
        const pixelY = viewY * frame.viewHeight;
        const cameraX = ((pixelX - frame.intrinsics.cx) / frame.intrinsics.fx) * meters;
        const cameraY = -((pixelY - frame.intrinsics.cy) / frame.intrinsics.fy) * meters;
        const cameraZ = -meters;
        const matrix = frame.cameraToWorld;
        const worldX = matrix[0][0] * cameraX + matrix[0][1] * cameraY + matrix[0][2] * cameraZ + matrix[0][3];
        const worldY = matrix[1][0] * cameraX + matrix[1][1] * cameraY + matrix[1][2] * cameraZ + matrix[1][3];
        const worldZ = matrix[2][0] * cameraX + matrix[2][1] * cameraY + matrix[2][2] * cameraZ + matrix[2][3];
        if (![worldX, worldY, worldZ].every(Number.isFinite)) continue;
        if (Math.hypot(worldX - this.target[0], worldY - this.target[1], worldZ - this.target[2]) > this.radiusMeters) continue;

        const key = this.voxelKey(worldX, worldY, worldZ);
        const existing = frameVoxels.get(key);
        if (existing) {
          existing.x += worldX;
          existing.y += worldY;
          existing.z += worldZ;
          existing.samples += 1;
        } else {
          frameVoxels.set(key, { x: worldX, y: worldY, z: worldZ, samples: 1, support: 1 });
        }
      }
    }

    if (!frameVoxels.size) return 0;
    this.ingestedFrameIds.add(frame.frameId);
    for (const [key, observed] of frameVoxels) {
      const x = observed.x / observed.samples;
      const y = observed.y / observed.samples;
      const z = observed.z / observed.samples;
      const existing = this.voxels.get(key);
      if (existing) {
        existing.x += x;
        existing.y += y;
        existing.z += z;
        existing.samples += 1;
        existing.support += 1;
      } else {
        this.voxels.set(key, { x, y, z, samples: 1, support: 1 });
      }
    }
    this.observedViewCount += 1;
    return frameVoxels.size;
  }

  snapshot(maximumPoints = MAXIMUM_DISPLAY_POINTS): CaptureMapSnapshot {
    const points = [...this.voxels.values()].map((voxel): CaptureMapPoint => ({
      x: (voxel.x / voxel.samples - this.target[0]) / this.radiusMeters,
      y: (voxel.y / voxel.samples - this.target[1]) / this.radiusMeters,
      z: (voxel.z / voxel.samples - this.target[2]) / this.radiusMeters,
      support: voxel.support,
    }));
    const confirmed = points.filter((point) => point.support > 1);
    const newPoints = points.filter((point) => point.support === 1);
    const confirmedLimit = Math.min(confirmed.length, Math.round(maximumPoints * 0.7));
    const selectedConfirmed = evenlySample(confirmed, confirmedLimit);
    const selectedNew = evenlySample(newPoints, maximumPoints - selectedConfirmed.length);
    const selected = selectedConfirmed.length + selectedNew.length < maximumPoints
      ? [...selectedConfirmed, ...selectedNew, ...evenlySample(
        confirmed.filter((point) => !selectedConfirmed.includes(point)),
        maximumPoints - selectedConfirmed.length - selectedNew.length,
      )]
      : [...selectedConfirmed, ...selectedNew];
    return {
      points: selected,
      radiusMeters: this.radiusMeters,
      observedViewCount: this.observedViewCount,
    };
  }

  private voxelKey(x: number, y: number, z: number): string {
    return [x, y, z].map((value) => Math.floor(value / this.voxelSize)).join(",");
  }
}

function evenlySample<T>(values: T[], count: number): T[] {
  if (count <= 0 || values.length === 0) return [];
  if (values.length <= count) return [...values];
  const step = values.length / count;
  return Array.from({ length: count }, (_, index) => values[Math.floor(index * step)]);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
