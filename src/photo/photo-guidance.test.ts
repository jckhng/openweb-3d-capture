import { describe, expect, it } from "vitest";
import {
  buildPhotoCoverageCells,
  buildGuidedPhotoCoverageCells,
  classifyPhotoOverlap,
  currentPhotoCheckpoint,
  PHOTO_TARGET,
  guidedPhotoPrompt,
} from "./photo-guidance";

describe("autofocus photo guidance", () => {
  it("maps 50 photographs onto 25 two-view checkpoints", () => {
    expect(PHOTO_TARGET).toBe(50);
    const empty = buildPhotoCoverageCells(0);
    expect(empty).toHaveLength(25);
    expect(empty.filter((cell) => cell.latitude === "level")).toHaveLength(12);
    expect(empty.filter((cell) => cell.latitude === "raised")).toHaveLength(6);
    expect(empty.filter((cell) => cell.latitude === "low")).toHaveLength(6);
    expect(empty.filter((cell) => cell.latitude === "high")).toHaveLength(1);

    const partial = buildPhotoCoverageCells(3);
    expect(partial[0].state).toBe("captured");
    expect(partial[1].state).toBe("sampled");
    expect(partial[1].selectedFrameIds).toEqual([2]);
    expect(buildPhotoCoverageCells(50).every((cell) => cell.state === "captured")).toBe(true);
  });

  it("advances through level, raised, top, and low checkpoints", () => {
    expect(currentPhotoCheckpoint(0)).toMatchObject({ latitude: "level", azimuthBin: 0 });
    expect(currentPhotoCheckpoint(24)).toMatchObject({ latitude: "raised", azimuthBin: 0 });
    expect(currentPhotoCheckpoint(36)).toMatchObject({ latitude: "high", azimuthBin: 0 });
    expect(currentPhotoCheckpoint(38)).toMatchObject({ latitude: "low", azimuthBin: 10 });
  });

  it("separates duplicate, disconnected, and useful views", () => {
    expect(classifyPhotoOverlap({ matches: 80, matchRatio: 0.4, medianDisplacement: 0.005 }).verdict)
      .toBe("too-similar");
    expect(classifyPhotoOverlap({ matches: 4, matchRatio: 0.02, medianDisplacement: 0.2 }).verdict)
      .toBe("low-overlap");
    expect(classifyPhotoOverlap({ matches: 35, matchRatio: 0.16, medianDisplacement: 0.08 }).verdict)
      .toBe("useful");
  });

  it("fills visually guided cells by measured sector rather than capture order", () => {
    const cells = buildGuidedPhotoCoverageCells([
      { photoId: 0, latitude: "raised", azimuthBin: 4 },
      { photoId: 1, latitude: "raised", azimuthBin: 4 },
      { photoId: 2, latitude: "level", azimuthBin: 9 },
    ]);
    expect(cells.find((cell) => cell.latitude === "raised" && cell.azimuthBin === 4)?.state)
      .toBe("captured");
    expect(cells.find((cell) => cell.latitude === "level" && cell.azimuthBin === 9)?.state)
      .toBe("sampled");
    expect(cells[0].state).toBe("empty");
  });

  it("blocks capture outside a required visually guided checkpoint", () => {
    const cells = buildGuidedPhotoCoverageCells([]);
    expect(guidedPhotoPrompt({
      source: "visual-navigation",
      poseSynchronized: false,
      longitude: -135,
      azimuthBin: 1,
      latitude: "raised",
      elevation: 45,
      trackingState: "tracking",
      matches: 42,
      inlierRatio: 0.7,
      confidence: 0.7,
    }, cells)).toContain("between required sectors");
  });
});
