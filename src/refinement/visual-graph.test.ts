import { describe, expect, it } from "vitest";
import { VisualConnectivityGraph } from "./visual-graph";

describe("visual connectivity graph", () => {
  it("requires enough connected low-res tracks before calibration", () => {
    const graph = new VisualConnectivityGraph();
    for (let frame = 0; frame < 10; frame += 1) {
      graph.addFrame(frame);
      if (frame > 0) graph.addEdge({
        frameA: frame - 1,
        frameB: frame,
        kind: "adjacent",
        matches: 30,
        medianResidualPixels: 0.8,
        p90ResidualPixels: 2,
        accepted: true,
      });
    }
    expect(graph.report()).toMatchObject({
      state: "calibration-ready",
      frameCount: 10,
      connectedFrameCount: 10,
      componentCount: 1,
      readyForCalibration: true,
      readyForGlobalOptimization: false,
      directTrainReady: false,
    });
    expect(graph.areConnected(0, 9)).toBe(true);
    expect(graph.componentCount()).toBe(1);
  });

  it("reports disconnected graphs as weak and connected noisy graphs as optimization-ready", () => {
    const disconnected = new VisualConnectivityGraph();
    for (let frame = 0; frame < 10; frame += 1) disconnected.addFrame(frame);
    expect(disconnected.report().fallbackReason).toContain("disconnected");

    const noisy = new VisualConnectivityGraph();
    for (let frame = 0; frame < 10; frame += 1) {
      noisy.addFrame(frame);
      if (frame > 0) noisy.addEdge({
        frameA: frame - 1,
        frameB: frame,
        kind: "adjacent",
        matches: 25,
        medianResidualPixels: 2.5,
        p90ResidualPixels: 6,
        accepted: true,
      });
    }
    expect(noisy.report()).toMatchObject({ state: "calibration-ready", readyForCalibration: true });
    expect(noisy.report().fallbackReason).toContain("no loop closure");
  });
});
