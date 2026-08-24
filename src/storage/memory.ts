import type {
  CaptureDataset,
  CaptureDecision,
  CaptureFrame,
  CaptureMetadata,
  IMUSample,
} from "../shared/types";
import type { CapturePersistence } from "./storage";

export class MemoryCaptureStore implements CapturePersistence {
  readonly kind = "memory" as const;
  private readonly captures = new Map<string, CaptureDataset>();

  async createCapture(metadata: CaptureMetadata): Promise<void> {
    this.captures.set(metadata.captureId, {
      capture: { ...metadata },
      frames: [],
      decisions: [],
      imu: [],
      images: new Map(),
      depths: new Map(),
    });
  }

  async appendDecision(captureId: string, decision: CaptureDecision): Promise<void> {
    this.require(captureId).decisions.push(structuredClone(decision));
  }

  async appendFrame(captureId: string, frame: CaptureFrame, image?: Blob, depth?: Blob): Promise<void> {
    const dataset = this.require(captureId);
    dataset.frames.push(structuredClone(frame));
    if (image && frame.imagePath) dataset.images.set(frame.imagePath, image);
    if (depth && frame.depthPath) dataset.depths.set(frame.depthPath, depth);
    dataset.capture.frameCount = dataset.frames.length;
    dataset.capture.hasDepth ||= Boolean(depth);
  }

  async appendImu(captureId: string, samples: IMUSample[]): Promise<void> {
    const dataset = this.require(captureId);
    dataset.imu.push(...structuredClone(samples));
    dataset.capture.hasImu ||= samples.length > 0;
  }

  async finalizeCapture(captureId: string, metadata: CaptureMetadata): Promise<void> {
    const dataset = this.require(captureId);
    dataset.capture = { ...metadata };
  }

  async loadCapture(captureId: string): Promise<CaptureDataset> {
    const dataset = this.require(captureId);
    return {
      capture: { ...dataset.capture },
      frames: structuredClone(dataset.frames),
      decisions: structuredClone(dataset.decisions),
      imu: structuredClone(dataset.imu),
      images: new Map(dataset.images),
      depths: new Map(dataset.depths),
    };
  }

  async listCaptures(): Promise<CaptureMetadata[]> {
    return [...this.captures.values()]
      .map((dataset) => ({ ...dataset.capture }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async deleteCapture(captureId: string): Promise<void> {
    this.captures.delete(captureId);
  }

  private require(captureId: string): CaptureDataset {
    const dataset = this.captures.get(captureId);
    if (!dataset) throw new Error(`Capture not found: ${captureId}`);
    return dataset;
  }
}
