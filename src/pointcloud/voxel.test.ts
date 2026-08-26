import { describe, expect, it } from "vitest";
import { VoxelAccumulator } from "./voxel";

describe("VoxelAccumulator", () => {
  it("averages positions and colors in each voxel", () => {
    const accumulator = new VoxelAccumulator(0.1);
    accumulator.add({ x: 0.01, y: 0.02, z: 0.03, red: 10, green: 20, blue: 30 });
    accumulator.add({ x: 0.03, y: 0.04, z: 0.05, red: 30, green: 40, blue: 50 });
    expect(accumulator.toPoints()).toEqual([{
      x: 0.02,
      y: 0.03,
      z: 0.04,
      red: 20,
      green: 30,
      blue: 40,
    }]);
  });

  it("supports observation filtering and deterministic point caps", () => {
    const accumulator = new VoxelAccumulator(0.1);
    for (let index = 0; index < 10; index += 1) {
      accumulator.add({ x: index, y: 0, z: 0, red: index, green: 0, blue: 0 });
    }
    expect(accumulator.toPoints(4)).toHaveLength(4);
    expect(accumulator.toPoints(20, 2)).toHaveLength(0);
  });
});
