import type { VisualTrackingEdge, VisualTrackingReport } from "../shared/types";

const MINIMUM_FRAMES = 10;
const MAXIMUM_MEDIAN_RESIDUAL = 1.5;
const MAXIMUM_P90_RESIDUAL = 4;

export class VisualConnectivityGraph {
  private readonly parents = new Map<number, number>();
  private readonly edges: VisualTrackingEdge[] = [];

  addFrame(frameId: number): void {
    if (!this.parents.has(frameId)) this.parents.set(frameId, frameId);
  }

  addEdge(edge: VisualTrackingEdge): void {
    this.addFrame(edge.frameA);
    this.addFrame(edge.frameB);
    this.edges.push({ ...edge });
    if (edge.accepted) this.union(edge.frameA, edge.frameB);
  }

  report(): VisualTrackingReport {
    const frameIds = [...this.parents.keys()];
    const componentSizes = new Map<number, number>();
    for (const frameId of frameIds) {
      const root = this.find(frameId);
      componentSizes.set(root, (componentSizes.get(root) ?? 0) + 1);
    }
    const accepted = this.edges.filter((edge) => edge.accepted);
    const residuals = accepted.map((edge) => edge.medianResidualPixels).sort((a, b) => a - b);
    const p90Residuals = accepted.map((edge) => edge.p90ResidualPixels).sort((a, b) => a - b);
    const connectedFrameCount = Math.max(0, ...componentSizes.values());
    const componentCount = componentSizes.size;
    const loopClosures = accepted.filter((edge) => edge.kind === "loop").length;
    const medianResidualPixels = percentile(residuals, 0.5);
    const p90ResidualPixels = percentile(p90Residuals, 0.9);
    const connected = frameIds.length >= MINIMUM_FRAMES && componentCount === 1;
    const readyForCalibration = connected;
    const readyForGlobalOptimization = connected && loopClosures > 0;
    return {
      format: "open3dcapture-visual-tracking",
      version: 1,
      state: frameIds.length === 0
        ? "unavailable"
        : readyForCalibration
          ? "calibration-ready"
          : frameIds.length < MINIMUM_FRAMES
            ? "collecting"
            : "weak",
      frameCount: frameIds.length,
      connectedFrameCount,
      componentCount,
      loopClosures,
      medianResidualPixels,
      p90ResidualPixels,
      readyForCalibration,
      readyForGlobalOptimization,
      directTrainReady: false,
      fallbackReason: readyForCalibration
        ? residualWarning(medianResidualPixels, p90ResidualPixels, loopClosures)
        : failureReason(frameIds.length, componentCount, medianResidualPixels, p90ResidualPixels),
      edges: this.edges.map((edge) => ({ ...edge })),
    };
  }

  private find(frameId: number): number {
    const parent = this.parents.get(frameId);
    if (parent === undefined) throw new Error(`Unknown visual frame ${frameId}`);
    if (parent === frameId) return frameId;
    const root = this.find(parent);
    this.parents.set(frameId, root);
    return root;
  }

  private union(a: number, b: number): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parents.set(rootB, rootA);
  }
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  return values[Math.floor((values.length - 1) * fraction)];
}

function failureReason(frameCount: number, componentCount: number, median: number, p90: number): string {
  if (frameCount < MINIMUM_FRAMES) return `need at least ${MINIMUM_FRAMES} visually tracked frames`;
  if (componentCount !== 1) return `visual graph has ${componentCount} disconnected components`;
  if (median > MAXIMUM_MEDIAN_RESIDUAL) return `median residual ${median.toFixed(2)}px exceeds ${MAXIMUM_MEDIAN_RESIDUAL}px`;
  if (p90 > MAXIMUM_P90_RESIDUAL) return `p90 residual ${p90.toFixed(2)}px exceeds ${MAXIMUM_P90_RESIDUAL}px`;
  return "visual graph is not ready";
}

function residualWarning(median: number, p90: number, loopClosures: number): string {
  if (loopClosures === 0) {
    return "connected for shared calibration; no loop closure, so global pose optimization requires downstream SfM";
  }
  if (median > MAXIMUM_MEDIAN_RESIDUAL || p90 > MAXIMUM_P90_RESIDUAL) {
    return `visual graph connected; raw pose residual ${median.toFixed(2)}px median/${p90.toFixed(2)}px p90 requires optimization`;
  }
  return "visual graph passes; calibration and pose optimization have not run";
}
