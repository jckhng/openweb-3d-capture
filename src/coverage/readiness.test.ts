import { describe, expect, it } from "vitest";
import type {
  CaptureFrame,
  Matrix4,
  VisualTrackingEdge,
  VisualTrackingReport,
} from "../shared/types";
import { analyzeCaptureReadiness, summarizeCaptureReadiness } from "./readiness";

describe("capture readiness", () => {
  it("marks a connected closed orbit with full azimuth and elevation coverage ready", () => {
    const frames = orbitFrames(60, (index, count) => ({
      angle: 2 * Math.PI * index / (count - 1),
      elevation: index === count - 1 ? -15 : [-15, 0, 15][index % 3],
    }));
    const report = analyzeCaptureReadiness(
      { frames, decisions: [], visualTracking: trackingReport(frames) },
      new Date("2026-09-01T00:00:00.000Z"),
    );

    expect(report.status).toBe("ready");
    expect(report.issues).toEqual([]);
    expect(report.metrics).toMatchObject({
      acceptedFrames: 60,
      imageFrames: 60,
      synchronizedImageFrames: 60,
      azimuthBinsCovered: 12,
      elevationBandsCovered: ["low", "level", "high"],
      visualConnectedFrames: 60,
      visualComponentCount: 1,
      loopClosureDetected: true,
      physicalLoopClosed: true,
    });
    expect(report.metrics.elevationSpanDegrees).toBeCloseTo(30, 5);
    expect(summarizeCaptureReadiness(report)).toEqual({
      status: "ready",
      primaryAction: report.primaryAction,
      issueCodes: [],
    });
  });

  it("asks the user to continue around the object when orbit sectors are missing", () => {
    const frames = orbitFrames(50, (index, count) => ({
      angle: Math.PI * index / (count - 1),
      elevation: [-15, 0, 15][index % 3],
    }));
    const report = analyzeCaptureReadiness({
      frames,
      decisions: [],
      visualTracking: trackingReport(frames),
    });

    expect(report.status).toBe("add-views");
    expect(report.metrics.azimuthBinsCovered).toBeLessThan(12);
    expect(report.issues.map((issue) => issue.code)).toContain("missing-azimuth");
    expect(report.primaryAction).toContain("Continue around the object");
  });

  it("requests both lower and higher views when the orbit stays level", () => {
    const frames = orbitFrames(60, (index, count) => ({
      angle: 2 * Math.PI * index / (count - 1),
      elevation: 0,
    }));
    const report = analyzeCaptureReadiness({
      frames,
      decisions: [],
      visualTracking: trackingReport(frames),
    });
    const issue = report.issues.find((candidate) => candidate.code === "missing-elevation");

    expect(report.status).toBe("add-views");
    expect(report.metrics.elevationBandsCovered).toEqual(["level"]);
    expect(issue?.action).toContain("lower pass and a higher pass");
  });

  it("prioritizes rebuilding overlap when the visual graph is disconnected", () => {
    const frames = orbitFrames(60, (index, count) => ({
      angle: 2 * Math.PI * index / (count - 1),
      elevation: index === count - 1 ? -15 : [-15, 0, 15][index % 3],
    }));
    const visualTracking = trackingReport(frames, {
      connectedFrameCount: 30,
      componentCount: 2,
      missingAdjacentPair: [29, 30],
    });
    const report = analyzeCaptureReadiness({ frames, decisions: [], visualTracking });

    expect(report.status).toBe("add-views");
    expect(report.issues.map((issue) => issue.code)).toContain("visual-disconnected");
    expect(report.primaryAction).toContain("Go back to the last well-tracked view");
  });

  it("flags unsynchronized reconstruction images as capture risk", () => {
    const frames = orbitFrames(60, (index, count) => ({
      angle: 2 * Math.PI * index / (count - 1),
      elevation: index === count - 1 ? -15 : [-15, 0, 15][index % 3],
    }));
    frames[20] = { ...frames[20], imageSynchronized: false };
    const report = analyzeCaptureReadiness({
      frames,
      decisions: [],
      visualTracking: trackingReport(frames),
    });

    expect(report.status).toBe("capture-risk");
    expect(report.issues.map((issue) => issue.code)).toContain("unsynchronized-images");
    expect(report.metrics.synchronizedImageRatio).toBeCloseTo(59 / 60);
  });

  it("estimates the object center from camera rays when depth is unavailable", () => {
    const frames = orbitFrames(60, (index, count) => ({
      angle: 2 * Math.PI * index / (count - 1),
      elevation: index === count - 1 ? -15 : [-15, 0, 15][index % 3],
    }));
    const withoutDepth = frames.map((frame) => ({ ...frame, targetDistance: undefined }));
    const report = analyzeCaptureReadiness({
      frames: withoutDepth,
      decisions: [],
      visualTracking: trackingReport(withoutDepth),
    });

    expect(report.metrics.targetEstimate).toEqual([
      expect.closeTo(0, 8),
      expect.closeTo(0, 8),
      expect.closeTo(0, 8),
    ]);
    expect(report.metrics.azimuthBinsCovered).toBe(12);
    expect(report.status).toBe("ready");
  });
});

function orbitFrames(
  count: number,
  sample: (index: number, count: number) => { angle: number; elevation: number },
): CaptureFrame[] {
  return Array.from({ length: count }, (_, id) => {
    const { angle, elevation } = sample(id, count);
    const horizontalRadius = 1;
    const height = Math.tan(elevation * Math.PI / 180) * horizontalRadius;
    const position: [number, number, number] = [
      Math.sin(angle) * horizontalRadius,
      height,
      Math.cos(angle) * horizontalRadius,
    ];
    return {
      id,
      timestamp: id * 250,
      imagePath: "images/" + String(id).padStart(6, "0") + ".jpg",
      width: 886,
      height: 1920,
      intrinsics: { fx: 1246, fy: 1246, cx: 443, cy: 960 },
      cameraToWorld: lookAtOrigin(position),
      trackingState: "tracked",
      imageSource: "xr-camera",
      imageSynchronized: true,
      targetDistance: Math.hypot(...position),
      quality: {
        blurScore: 0.1,
        motionScore: 0.1,
        noveltyScore: 1,
        coverageGain: 1,
      },
    };
  });
}

function trackingReport(
  frames: readonly CaptureFrame[],
  options: {
    connectedFrameCount?: number;
    componentCount?: number;
    missingAdjacentPair?: [number, number];
  } = {},
): VisualTrackingReport {
  const edges: VisualTrackingEdge[] = [];
  for (let index = 1; index < frames.length; index += 1) {
    const pair: [number, number] = [frames[index - 1].id, frames[index].id];
    if (
      options.missingAdjacentPair &&
      pair[0] === options.missingAdjacentPair[0] &&
      pair[1] === options.missingAdjacentPair[1]
    ) continue;
    edges.push(edge(pair[0], pair[1], "adjacent"));
  }
  edges.push(edge(frames[0].id, frames.at(-1)!.id, "loop"));
  return {
    format: "open3dcapture-visual-tracking",
    version: 1,
    state: "calibration-ready",
    frameCount: frames.length,
    connectedFrameCount: options.connectedFrameCount ?? frames.length,
    componentCount: options.componentCount ?? 1,
    loopClosures: 1,
    medianResidualPixels: 0.8,
    p90ResidualPixels: 1.8,
    readyForCalibration: true,
    readyForGlobalOptimization: true,
    directTrainReady: false,
    fallbackReason: "downstream SfM remains authoritative",
    edges,
  };
}

function edge(
  frameA: number,
  frameB: number,
  kind: VisualTrackingEdge["kind"],
): VisualTrackingEdge {
  return {
    frameA,
    frameB,
    kind,
    matches: 80,
    geometricInliers: 50,
    geometricInlierRatio: 0.625,
    medianResidualPixels: 0.8,
    p90ResidualPixels: 1.8,
    accepted: true,
  };
}

function lookAtOrigin(position: [number, number, number]): Matrix4 {
  const z = normalize(position);
  const x = normalize(cross([0, 1, 0], z));
  const y = cross(z, x);
  return [
    [x[0], y[0], z[0], position[0]],
    [x[1], y[1], z[1], position[1]],
    [x[2], y[2], z[2], position[2]],
    [0, 0, 0, 1],
  ];
}

function normalize(value: [number, number, number]): [number, number, number] {
  const length = Math.hypot(...value);
  return [value[0] / length, value[1] / length, value[2] / length];
}

function cross(
  a: [number, number, number],
  b: [number, number, number],
): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
