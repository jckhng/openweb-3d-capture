import type { ColoredPoint } from "./depth-points";

interface VoxelAccumulatorEntry {
  x: number;
  y: number;
  z: number;
  red: number;
  green: number;
  blue: number;
  count: number;
}

export class VoxelAccumulator {
  private readonly voxels = new Map<string, VoxelAccumulatorEntry>();

  constructor(readonly voxelSize = 0.015) {
    if (!(voxelSize > 0) || !Number.isFinite(voxelSize)) throw new Error("Voxel size must be positive");
  }

  add(point: ColoredPoint): void {
    const key = [point.x, point.y, point.z]
      .map((value) => Math.floor(value / this.voxelSize))
      .join(",");
    const current = this.voxels.get(key);
    if (current) {
      current.x += point.x;
      current.y += point.y;
      current.z += point.z;
      current.red += point.red;
      current.green += point.green;
      current.blue += point.blue;
      current.count += 1;
    } else {
      this.voxels.set(key, { ...point, count: 1 });
    }
  }

  toPoints(maximumPoints = 500_000, minimumObservations = 1): ColoredPoint[] {
    if (!Number.isInteger(maximumPoints) || maximumPoints < 1) throw new Error("Maximum points must be positive");
    if (!Number.isInteger(minimumObservations) || minimumObservations < 1) {
      throw new Error("Minimum observations must be positive");
    }
    const points: ColoredPoint[] = [];
    for (const value of this.voxels.values()) {
      if (value.count < minimumObservations) continue;
      points.push({
        x: value.x / value.count,
        y: value.y / value.count,
        z: value.z / value.count,
        red: Math.round(value.red / value.count),
        green: Math.round(value.green / value.count),
        blue: Math.round(value.blue / value.count),
      });
    }
    if (points.length <= maximumPoints) return points;
    const step = points.length / maximumPoints;
    return Array.from({ length: maximumPoints }, (_, index) => points[Math.floor(index * step)]);
  }

  get size(): number {
    return this.voxels.size;
  }
}
