import type { VisualTrackingReport } from "../shared/types";
import type {
  VisualTrackingFrameInput,
  VisualWorkerRequest,
  VisualWorkerResponse,
} from "./worker-protocol";

type Listener = (report: VisualTrackingReport) => void;

export class IncrementalVisualTracker {
  private readonly worker?: Worker;
  private readonly pending = new Map<number, (report: VisualTrackingReport) => void>();
  private requestId = 0;
  private latest = unavailableReport("visual worker has not started");

  constructor(private readonly listener: Listener) {
    if (typeof Worker === "undefined") {
      this.latest = unavailableReport("Web Workers are unavailable");
      return;
    }
    try {
      this.worker = new Worker(new URL("./visual-worker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = (event: MessageEvent<VisualWorkerResponse>) => this.handleMessage(event.data);
      this.worker.onerror = () => this.fail("visual worker crashed");
    } catch {
      this.latest = unavailableReport("visual worker could not start");
    }
  }

  reset(): void {
    this.latest = unavailableReport(this.worker ? "waiting for accepted frames" : this.latest.fallbackReason);
    this.listener(this.latest);
    this.post({ type: "reset" });
  }

  track(frame: VisualTrackingFrameInput): void {
    this.post({ type: "track", frame });
  }

  finish(): Promise<VisualTrackingReport> {
    if (!this.worker) return Promise.resolve(this.latest);
    const requestId = this.requestId++;
    return new Promise((resolve) => {
      this.pending.set(requestId, resolve);
      this.post({ type: "finish", requestId });
    });
  }

  dispose(): void {
    this.worker?.terminate();
    for (const resolve of this.pending.values()) resolve(this.latest);
    this.pending.clear();
  }

  private post(message: VisualWorkerRequest): void {
    this.worker?.postMessage(message);
  }

  private handleMessage(message: VisualWorkerResponse): void {
    if (message.type === "error") {
      this.fail(message.message);
      return;
    }
    this.setReport(message.report);
    if (message.type === "finished") {
      this.pending.get(message.requestId)?.(message.report);
      this.pending.delete(message.requestId);
    }
  }

  private setReport(report: VisualTrackingReport): void {
    this.latest = report;
    this.listener(report);
  }

  private fail(reason: string): void {
    this.setReport(unavailableReport(reason));
    for (const resolve of this.pending.values()) resolve(this.latest);
    this.pending.clear();
  }
}

export function unavailableReport(reason: string): VisualTrackingReport {
  return {
    format: "open3dcapture-visual-tracking",
    version: 1,
    state: "unavailable",
    frameCount: 0,
    connectedFrameCount: 0,
    componentCount: 0,
    loopClosures: 0,
    medianResidualPixels: 0,
    p90ResidualPixels: 0,
    readyForCalibration: false,
    readyForGlobalOptimization: false,
    directTrainReady: false,
    fallbackReason: reason,
    edges: [],
  };
}
