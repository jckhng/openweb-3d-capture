import type {
  CaptureDataset,
  CaptureDecision,
  CaptureFrame,
  CaptureMetadata,
  CaptureReadinessReport,
  IMUSample,
  UnposedPhoto,
  VisualTrackingReport,
} from "../shared/types";
import type { CapturePersistence } from "./storage";

const CAPTURES_DIRECTORY = "captures";

export class OPFSCaptureStore implements CapturePersistence {
  readonly kind = "opfs" as const;
  private root?: FileSystemDirectoryHandle;
  private captures?: FileSystemDirectoryHandle;

  async createCapture(metadata: CaptureMetadata): Promise<void> {
    const directory = await this.captureDirectory(metadata.captureId, true);
    await directory.getDirectoryHandle("frames", { create: true });
    await directory.getDirectoryHandle("photos", { create: true });
    await directory.getDirectoryHandle("images", { create: true });
    await directory.getDirectoryHandle("depth", { create: true });
    await directory.getDirectoryHandle("telemetry", { create: true });
    await directory.getDirectoryHandle("debug", { create: true });
    const debug = await directory.getDirectoryHandle("debug");
    await debug.getDirectoryHandle("rejected", { create: true });
    await directory.getDirectoryHandle("refinement", { create: true });
    await directory.getDirectoryHandle("preflight", { create: true });
    await writeJson(directory, "capture.json", metadata);
  }

  async appendDecision(captureId: string, decision: CaptureDecision, preview?: Blob): Promise<void> {
    const directory = await this.captureDirectory(captureId);
    const debugDirectory = await directory.getDirectoryHandle("debug");
    await writeJson(debugDirectory, `${pad(decision.candidateId)}.json`, decision);
    if (preview) {
      const rejected = await debugDirectory.getDirectoryHandle("rejected", { create: true });
      await writeFile(rejected, `${pad(decision.candidateId)}.jpg`, preview);
    }
  }

  async appendFrame(captureId: string, frame: CaptureFrame, image?: Blob, depth?: Blob): Promise<void> {
    const directory = await this.captureDirectory(captureId);
    const frameDirectory = await directory.getDirectoryHandle("frames");
    await writeJson(frameDirectory, `${pad(frame.id)}.json`, frame);

    if (image && frame.imagePath) {
      const imageDirectory = await directory.getDirectoryHandle("images");
      await writeFile(imageDirectory, basename(frame.imagePath), image);
    }
    if (depth && frame.depthPath) {
      const depthDirectory = await directory.getDirectoryHandle("depth");
      await writeFile(depthDirectory, basename(frame.depthPath), depth);
    }

    const metadata = await readJson<CaptureMetadata>(directory, "capture.json");
    metadata.frameCount = Math.max(metadata.frameCount, frame.id + 1);
    metadata.hasDepth ||= Boolean(depth);
    metadata.updatedAt = new Date().toISOString();
    await writeJson(directory, "capture.json", metadata);
  }

  async appendUnposedPhoto(captureId: string, photo: UnposedPhoto, image: Blob): Promise<void> {
    const directory = await this.captureDirectory(captureId);
    const photos = await directory.getDirectoryHandle("photos", { create: true });
    const images = await directory.getDirectoryHandle("images");
    await writeFile(images, basename(photo.imagePath), image);
    await writeJson(photos, `${pad(photo.id)}.json`, photo);

    const metadata = await readJson<CaptureMetadata>(directory, "capture.json");
    metadata.frameCount = Math.max(metadata.frameCount, photo.id + 1);
    metadata.updatedAt = new Date().toISOString();
    metadata.cameraResolution ??= { width: photo.width, height: photo.height };
    await writeJson(directory, "capture.json", metadata);
  }

  async appendImu(captureId: string, samples: IMUSample[]): Promise<void> {
    if (!samples.length) return;
    const directory = await this.captureDirectory(captureId);
    const telemetry = await directory.getDirectoryHandle("telemetry");
    const existing = await readTextIfPresent(telemetry, "imu.jsonl");
    const lines = samples.map((sample) => JSON.stringify(sample)).join("\n");
    await writeText(telemetry, "imu.jsonl", existing + lines + "\n");

    const metadata = await readJson<CaptureMetadata>(directory, "capture.json");
    metadata.hasImu = true;
    metadata.updatedAt = new Date().toISOString();
    await writeJson(directory, "capture.json", metadata);
  }

  async saveVisualTracking(captureId: string, report: VisualTrackingReport): Promise<void> {
    const directory = await this.captureDirectory(captureId);
    const refinement = await directory.getDirectoryHandle("refinement", { create: true });
    await writeJson(refinement, "tracking.json", report);
  }

  async saveCaptureReadiness(captureId: string, report: CaptureReadinessReport): Promise<void> {
    const directory = await this.captureDirectory(captureId);
    const preflight = await directory.getDirectoryHandle("preflight", { create: true });
    await writeJson(preflight, "readiness.json", report);
  }

  async finalizeCapture(captureId: string, metadata: CaptureMetadata): Promise<void> {
    const directory = await this.captureDirectory(captureId);
    await writeJson(directory, "capture.json", metadata);
  }

  async loadCapture(captureId: string): Promise<CaptureDataset> {
    const directory = await this.captureDirectory(captureId);
    const capture = await readJson<CaptureMetadata>(directory, "capture.json");
    const framesDirectory = await directory.getDirectoryHandle("frames");
    const frameNames: string[] = [];
    for await (const [name, handle] of entriesOf(framesDirectory)) {
      if (handle.kind === "file" && name.endsWith(".json")) frameNames.push(name);
    }
    frameNames.sort();

    const frames: CaptureFrame[] = [];
    const images = new Map<string, Blob>();
    const depths = new Map<string, Blob>();
    for (const name of frameNames) {
      const frame = await readJson<CaptureFrame>(framesDirectory, name);
      frames.push(frame);
      if (frame.imagePath) {
        const image = await readFileIfPresent(directory, "images", basename(frame.imagePath));
        if (image) images.set(frame.imagePath, image);
      }
      if (frame.depthPath) {
        const depth = await readFileIfPresent(directory, "depth", basename(frame.depthPath));
        if (depth) depths.set(frame.depthPath, depth);
      }
    }

    const unposedPhotos: UnposedPhoto[] = [];
    try {
      const photosDirectory = await directory.getDirectoryHandle("photos");
      const photoNames: string[] = [];
      for await (const [name, handle] of entriesOf(photosDirectory)) {
        if (handle.kind === "file" && name.endsWith(".json")) photoNames.push(name);
      }
      photoNames.sort();
      for (const name of photoNames) {
        const photo = await readJson<UnposedPhoto>(photosDirectory, name);
        unposedPhotos.push(photo);
        const image = await readFileIfPresent(directory, "images", basename(photo.imagePath));
        if (image) images.set(photo.imagePath, image);
      }
    } catch {
      // WebXR-only captures have no unposed photo records.
    }

    const decisions: CaptureDecision[] = [];
    const candidatePreviews = new Map<string, Blob>();
    try {
      const debugDirectory = await directory.getDirectoryHandle("debug");
      const decisionNames: string[] = [];
      for await (const [name, handle] of entriesOf(debugDirectory)) {
        if (handle.kind === "file" && name.endsWith(".json")) decisionNames.push(name);
      }
      decisionNames.sort();
      for (const name of decisionNames) {
        decisions.push(await readJson<CaptureDecision>(debugDirectory, name));
      }
      try {
        const rejected = await debugDirectory.getDirectoryHandle("rejected");
        for await (const [name, handle] of entriesOf(rejected)) {
          if (handle.kind !== "file" || !name.endsWith(".jpg")) continue;
          const file = await (await rejected.getFileHandle(name)).getFile();
          candidatePreviews.set(`debug/rejected/${name}`, file);
        }
      } catch {
        // Captures created before rejected preview telemetry have no thumbnails.
      }
    } catch {
      // M0/M1 captures predate quality decision telemetry.
    }

    const telemetry = await directory.getDirectoryHandle("telemetry");
    const imuText = await readTextIfPresent(telemetry, "imu.jsonl");
    const imu = imuText
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as IMUSample);
    let visualTracking: VisualTrackingReport | undefined;
    try {
      const refinement = await directory.getDirectoryHandle("refinement");
      visualTracking = await readJson<VisualTrackingReport>(refinement, "tracking.json");
    } catch {
      // Captures created before incremental visual tracking have no report.
    }
    let readiness: CaptureReadinessReport | undefined;
    try {
      const preflight = await directory.getDirectoryHandle("preflight");
      readiness = await readJson<CaptureReadinessReport>(preflight, "readiness.json");
    } catch {
      // Captures created before capture preflight have no readiness report.
    }
    return { capture, frames, decisions, imu, images, depths, candidatePreviews, unposedPhotos, visualTracking, readiness };
  }

  async listCaptures(): Promise<CaptureMetadata[]> {
    const captures = await this.captureDirectoryRoot();
    const result: CaptureMetadata[] = [];
    for await (const [name, handle] of entriesOf(captures)) {
      if (handle.kind !== "directory") continue;
      try {
        const directory = await captures.getDirectoryHandle(name);
        result.push(await readJson<CaptureMetadata>(directory, "capture.json"));
      } catch {
        // Ignore a directory that was interrupted before its manifest was durable.
      }
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async deleteCapture(captureId: string): Promise<void> {
    const captures = await this.captureDirectoryRoot();
    await captures.removeEntry(assertSafeId(captureId), { recursive: true });
  }

  private async captureDirectoryRoot(): Promise<FileSystemDirectoryHandle> {
    if (!this.captures) {
      if (!isOpfsAvailable()) throw new Error("OPFS is unavailable in this browser");
      this.root = await navigator.storage.getDirectory();
      this.captures = await this.root.getDirectoryHandle(CAPTURES_DIRECTORY, { create: true });
    }
    return this.captures;
  }

  private async captureDirectory(captureId: string, create = false): Promise<FileSystemDirectoryHandle> {
    const captures = await this.captureDirectoryRoot();
    return captures.getDirectoryHandle(assertSafeId(captureId), { create });
  }
}

function isOpfsAvailable(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.storage?.getDirectory === "function";
}

function assertSafeId(value: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error("Invalid capture id");
  return value;
}

function pad(value: number): string {
  return String(value).padStart(6, "0");
}

function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1];
}

async function writeJson(directory: FileSystemDirectoryHandle, name: string, value: unknown): Promise<void> {
  await writeText(directory, name, JSON.stringify(value, null, 2));
}

async function readJson<T>(directory: FileSystemDirectoryHandle, name: string): Promise<T> {
  const file = await (await directory.getFileHandle(name)).getFile();
  return JSON.parse(await file.text()) as T;
}

async function writeText(directory: FileSystemDirectoryHandle, name: string, value: string): Promise<void> {
  await writeFile(directory, name, value);
}

async function writeFile(
  directory: FileSystemDirectoryHandle,
  name: string,
  value: string | Blob | ArrayBuffer,
): Promise<void> {
  const file = await directory.getFileHandle(name, { create: true });
  const writable = await file.createWritable();
  await writable.write(value);
  await writable.close();
}

function entriesOf(
  directory: FileSystemDirectoryHandle,
): AsyncIterableIterator<[string, FileSystemHandle]> {
  return (directory as FileSystemDirectoryHandle & {
    entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
  }).entries();
}

async function readTextIfPresent(directory: FileSystemDirectoryHandle, name: string): Promise<string> {
  try {
    const file = await (await directory.getFileHandle(name)).getFile();
    return file.text();
  } catch {
    return "";
  }
}

async function readFileIfPresent(
  parent: FileSystemDirectoryHandle,
  childDirectory: string,
  name: string,
): Promise<Blob | undefined> {
  try {
    const directory = await parent.getDirectoryHandle(childDirectory);
    return (await directory.getFileHandle(name)).getFile();
  } catch {
    return undefined;
  }
}
