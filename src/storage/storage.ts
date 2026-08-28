import type {
  CaptureDataset,
  CaptureDecision,
  CaptureFrame,
  CaptureMetadata,
  CaptureReadinessReport,
  IMUSample,
  VisualTrackingReport,
} from "../shared/types";

export interface CapturePersistence {
  readonly kind: "opfs" | "memory";
  createCapture(metadata: CaptureMetadata): Promise<void>;
  appendFrame(captureId: string, frame: CaptureFrame, image?: Blob, depth?: Blob): Promise<void>;
  appendDecision(captureId: string, decision: CaptureDecision, preview?: Blob): Promise<void>;
  appendImu(captureId: string, samples: IMUSample[]): Promise<void>;
  saveVisualTracking(captureId: string, report: VisualTrackingReport): Promise<void>;
  saveCaptureReadiness(captureId: string, report: CaptureReadinessReport): Promise<void>;
  finalizeCapture(captureId: string, metadata: CaptureMetadata): Promise<void>;
  loadCapture(captureId: string): Promise<CaptureDataset>;
  listCaptures(): Promise<CaptureMetadata[]>;
  deleteCapture(captureId: string): Promise<void>;
}

export function isOpfsSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "storage" in navigator &&
    typeof navigator.storage?.getDirectory === "function"
  );
}

export function makeCaptureId(now = Date.now()): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `capture-${now}-${random}`;
}
