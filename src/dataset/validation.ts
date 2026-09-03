export type ValidationSeverity = "error" | "warning";

export interface ValidationIssue {
  severity: ValidationSeverity;
  code: string;
  message: string;
  path?: string;
}

export interface ValidationSummary {
  transformFrames: number;
  telemetryFrames: number;
  images: number;
  synchronizedImages: number;
  depthFrames: number;
  imuSamples: number;
  decisions: number;
  pointCloudVertices?: number;
  trackingFrames?: number;
  connectedTrackingFrames?: number;
  loopClosures?: number;
  imageWidth?: number;
  imageHeight?: number;
  medianBaselineMeters?: number;
  poseExtentMeters?: number;
}

export interface DatasetValidationReport {
  valid: boolean;
  summary: ValidationSummary;
  issues: ValidationIssue[];
}

export interface ValidationSource {
  paths: readonly string[];
  read(path: string): Promise<Uint8Array>;
}

type JsonRecord = Record<string, unknown>;

const decoder = new TextDecoder();
const REQUIRED_PATHS = [
  "transforms.json",
  "capture.json",
  "telemetry/frames.jsonl",
  "telemetry/imu.jsonl",
  "debug/session.jsonl",
] as const;

export async function validateCaptureDataset(source: ValidationSource): Promise<DatasetValidationReport> {
  const paths = new Set(source.paths);
  const issues: ValidationIssue[] = [];
  const summary: ValidationSummary = {
    transformFrames: 0,
    telemetryFrames: 0,
    images: 0,
    synchronizedImages: 0,
    depthFrames: 0,
    imuSamples: 0,
    decisions: 0,
  };
  const add = (severity: ValidationSeverity, code: string, message: string, path?: string) => {
    issues.push({ severity, code, message, ...(path ? { path } : {}) });
  };

  for (const path of REQUIRED_PATHS) {
    if (!paths.has(path)) add("error", "missing-required-file", `Required file is missing: ${path}`, path);
  }

  const transforms = await readJson(source, "transforms.json", add);
  const capture = await readJson(source, "capture.json", add);
  const frames = await readJsonl(source, "telemetry/frames.jsonl", add);
  const imu = await readJsonl(source, "telemetry/imu.jsonl", add);
  const decisions = await readJsonl(source, "debug/session.jsonl", add);
  const photos = paths.has("telemetry/photos.jsonl")
    ? await readJsonl(source, "telemetry/photos.jsonl", add)
    : [];
  summary.telemetryFrames = frames.length;
  summary.imuSamples = imu.length;
  summary.decisions = decisions.length;

  if (capture) validateCapture(capture, frames, photos, imu, add);
  if (transforms) await validateTransforms(source, paths, transforms, frames, capture, summary, add);
  await validateTelemetry(source, paths, frames, decisions, capture, summary, add);
  await validateUnposedPhotos(source, paths, photos, capture, summary, add);
  if (capture?.captureMode !== "photo-sfm") {
    if (transforms) await validatePointCloud(source, paths, transforms, summary, add);
    await validateTracking(source, paths, frames, summary, add);
  }

  issues.sort((a, b) => severityOrder(a.severity) - severityOrder(b.severity) ||
    (a.path ?? "").localeCompare(b.path ?? "") || a.code.localeCompare(b.code));
  return {
    valid: !issues.some((issue) => issue.severity === "error"),
    summary,
    issues,
  };
}

function validateCapture(
  capture: JsonRecord,
  frames: JsonRecord[],
  photos: JsonRecord[],
  imu: JsonRecord[],
  add: AddIssue,
): void {
  if (capture.format !== "open3dcapture" || capture.version !== 1) {
    add("error", "capture-format", "capture.json must use open3dcapture format version 1", "capture.json");
  }
  if (capture.status !== "complete") {
    add("warning", "capture-incomplete", "Capture status is not complete", "capture.json");
  }
  const records = capture.captureMode === "photo-sfm" ? photos : frames;
  if (capture.captureMode === "photo-sfm" && photos.length === 0) {
    add("error", "photo-telemetry-empty", "Autofocus photo capture has no unposed photo telemetry", "telemetry/photos.jsonl");
  }
  if (!Number.isInteger(capture.frameCount) || capture.frameCount !== records.length) {
    add("error", "capture-frame-count", `capture.json frameCount ${String(capture.frameCount)} does not match ${records.length} capture records`, "capture.json");
  }
  if (capture.hasImu === true && imu.length === 0) {
    add("warning", "imu-empty", "Capture declares IMU data but telemetry/imu.jsonl is empty", "telemetry/imu.jsonl");
  }
  const depthFrames = frames.filter((frame) => typeof frame.depthPath === "string").length;
  if (capture.hasDepth === true && depthFrames === 0) {
    add("warning", "depth-empty", "Capture declares depth data but no frame references depth", "telemetry/frames.jsonl");
  }
  if (capture.hasDepth === false && depthFrames > 0) {
    add("warning", "depth-metadata", "Depth frames exist but capture.json hasDepth is false", "capture.json");
  }
}

async function validateTransforms(
  source: ValidationSource,
  paths: Set<string>,
  transforms: JsonRecord,
  frames: JsonRecord[],
  capture: JsonRecord | undefined,
  summary: ValidationSummary,
  add: AddIssue,
): Promise<void> {
  const unposedPhotoMode = capture?.captureMode === "photo-sfm";
  if (transforms.camera_model !== "OPENCV") {
    add("error", "camera-model", "transforms.json camera_model must be OPENCV", "transforms.json");
  }
  for (const name of ["fl_x", "fl_y"] as const) {
    if (!unposedPhotoMode && !positiveFinite(transforms[name])) add("error", "camera-intrinsics", `${name} must be a positive finite number`, "transforms.json");
  }
  for (const name of ["cx", "cy"] as const) {
    if (!unposedPhotoMode && !finite(transforms[name])) add("error", "camera-intrinsics", `${name} must be finite`, "transforms.json");
  }
  const width = transforms.w;
  const height = transforms.h;
  if (!unposedPhotoMode && (!positiveInteger(width) || !positiveInteger(height))) {
    add("error", "camera-resolution", "w and h must be positive integers", "transforms.json");
  }
  if (positiveInteger(width) && positiveInteger(height)) {
    summary.imageWidth = width;
    summary.imageHeight = height;
  }
  const transformFrames = Array.isArray(transforms.frames)
    ? transforms.frames.filter(isRecord)
    : [];
  summary.transformFrames = transformFrames.length;
  if (!Array.isArray(transforms.frames) || (!unposedPhotoMode && transformFrames.length === 0)) {
    add("error", "transforms-frames", "transforms.json must contain at least one frame", "transforms.json");
  }
  if (transformFrames.length !== frames.length) {
    add("error", "transform-frame-count", `transforms.json contains ${transformFrames.length} frames but telemetry contains ${frames.length}`, "transforms.json");
  }

  const telemetryByImage = new Map(frames
    .filter((frame) => typeof frame.imagePath === "string")
    .map((frame) => [frame.imagePath as string, frame]));
  const seen = new Set<string>();
  for (let index = 0; index < transformFrames.length; index += 1) {
    const frame = transformFrames[index];
    const context = `transforms.json frame ${index}`;
    const imagePath = frame.file_path;
    if (typeof imagePath !== "string" || !safeRelativePath(imagePath)) {
      add("error", "image-path", `${context} has an invalid file_path`, "transforms.json");
      continue;
    }
    if (seen.has(imagePath)) add("error", "duplicate-image", `Duplicate transform image path: ${imagePath}`, "transforms.json");
    seen.add(imagePath);
    validateMatrix(frame.transform_matrix, context, add, "transforms.json");
    if (!paths.has(imagePath)) {
      add("error", "missing-image", `Referenced image is missing: ${imagePath}`, imagePath);
      continue;
    }
    summary.images += 1;
    const bytes = await safeRead(source, imagePath, add);
    if (!bytes) continue;
    const dimensions = jpegDimensions(bytes);
    if (!dimensions) {
      add("error", "invalid-jpeg", "Image is not a readable JPEG", imagePath);
      continue;
    }
    if (positiveInteger(width) && positiveInteger(height) &&
      (dimensions.width !== width || dimensions.height !== height)) {
      add("error", "image-resolution", `JPEG is ${dimensions.width}x${dimensions.height}, expected ${width}x${height}`, imagePath);
    }
    const telemetry = telemetryByImage.get(imagePath);
    if (!telemetry) {
      add("error", "missing-frame-telemetry", "Transform image has no matching telemetry frame", imagePath);
    } else if (telemetry.width !== dimensions.width || telemetry.height !== dimensions.height) {
      add("error", "telemetry-image-resolution", "Telemetry dimensions do not match JPEG dimensions", imagePath);
    }
  }
}

async function validateUnposedPhotos(
  source: ValidationSource,
  paths: Set<string>,
  photos: JsonRecord[],
  capture: JsonRecord | undefined,
  summary: ValidationSummary,
  add: AddIssue,
): Promise<void> {
  if (capture?.captureMode !== "photo-sfm") return;
  const ids = new Set<number>();
  for (let index = 0; index < photos.length; index += 1) {
    const photo = photos[index];
    const context = `unposed photo ${index}`;
    if (!Number.isInteger(photo.id) || ids.has(photo.id as number)) {
      add("error", "photo-id", `${context} has a missing or duplicate integer id`, "telemetry/photos.jsonl");
    } else {
      ids.add(photo.id as number);
    }
    if (photo.poseStatus !== "unposed" || photo.imageSynchronized !== false) {
      add("error", "photo-pose-status", `${context} must be explicitly unposed and unsynchronized`, "telemetry/photos.jsonl");
    }
    if ("cameraToWorld" in photo || "transform_matrix" in photo) {
      add("error", "fabricated-photo-pose", `${context} must not contain a camera pose`, "telemetry/photos.jsonl");
    }
    const imagePath = photo.imagePath;
    if (typeof imagePath !== "string" || !safeRelativePath(imagePath) || !paths.has(imagePath)) {
      add("error", "missing-image", `${context} references a missing image`, typeof imagePath === "string" ? imagePath : undefined);
      continue;
    }
    const bytes = await safeRead(source, imagePath, add);
    if (!bytes) continue;
    const dimensions = jpegDimensions(bytes);
    if (!dimensions) {
      add("error", "invalid-jpeg", "Image is not a readable JPEG", imagePath);
      continue;
    }
    if (photo.width !== dimensions.width || photo.height !== dimensions.height) {
      add("error", "photo-image-resolution", "Photo telemetry dimensions do not match JPEG dimensions", imagePath);
    }
    summary.images += 1;
  }
}

async function validateTelemetry(
  source: ValidationSource,
  paths: Set<string>,
  frames: JsonRecord[],
  decisions: JsonRecord[],
  capture: JsonRecord | undefined,
  summary: ValidationSummary,
  add: AddIssue,
): Promise<void> {
  const ids = new Set<number>();
  const timestamps: number[] = [];
  const translations: Array<[number, number, number]> = [];
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    const context = `telemetry frame ${index}`;
    if (!Number.isInteger(frame.id) || ids.has(frame.id as number)) {
      add("error", "frame-id", `${context} has a missing or duplicate integer id`, "telemetry/frames.jsonl");
    } else {
      ids.add(frame.id as number);
    }
    validateMatrix(frame.cameraToWorld, context, add, "telemetry/frames.jsonl");
    if (!finite(frame.timestamp)) {
      add("error", "frame-timestamp", `${context} has a non-finite timestamp`, "telemetry/frames.jsonl");
    } else {
      timestamps.push(frame.timestamp);
    }
    const translation = matrixTranslation(frame.cameraToWorld);
    if (translation) translations.push(translation);
    if (!positiveInteger(frame.width) || !positiveInteger(frame.height)) {
      add("error", "frame-resolution", `${context} has invalid dimensions`, "telemetry/frames.jsonl");
    }
    const intrinsics = isRecord(frame.intrinsics) ? frame.intrinsics : undefined;
    if (!intrinsics || !positiveFinite(intrinsics.fx) || !positiveFinite(intrinsics.fy) ||
      !finite(intrinsics.cx) || !finite(intrinsics.cy)) {
      add("error", "frame-intrinsics", `${context} has invalid intrinsics`, "telemetry/frames.jsonl");
    }
    if (capture?.source === "webxr" && frame.imagePath &&
      (frame.imageSource !== "xr-camera" || frame.imageSynchronized !== true)) {
      add("error", "unsynchronized-frame", `${context} is not a synchronized XR camera image`, "telemetry/frames.jsonl");
    } else if (frame.imageSynchronized === true) {
      summary.synchronizedImages += 1;
    }
    if (typeof frame.imagePath === "string" && !paths.has(frame.imagePath)) {
      add("error", "missing-image", `Telemetry image is missing: ${frame.imagePath}`, frame.imagePath);
    }
    if (typeof frame.depthPath === "string") {
      summary.depthFrames += 1;
      await validateDepth(source, paths, frame, context, add);
    }
  }
  for (let index = 1; index < timestamps.length; index += 1) {
    if (timestamps[index] <= timestamps[index - 1]) {
      add("error", "timestamp-order", "Frame timestamps must be strictly increasing", "telemetry/frames.jsonl");
      break;
    }
  }
  const baselines = translations.slice(1).map((translation, index) => distance(translation, translations[index]));
  if (baselines.length > 0) {
    baselines.sort((a, b) => a - b);
    summary.medianBaselineMeters = baselines[Math.floor(baselines.length / 2)];
  }
  if (translations.length > 0) {
    summary.poseExtentMeters = poseExtent(translations);
    if (translations.length > 1 && summary.poseExtentMeters < 0.01) {
      add("warning", "pose-static", `Camera translation extent is only ${summary.poseExtentMeters.toFixed(4)} m`, "telemetry/frames.jsonl");
    }
  }
  if (capture?.captureMode === "object" && decisions.length > 0) {
    const accepted = decisions.filter((decision) => decision.accepted === true).length;
    if (accepted !== frames.length) {
      add("error", "accepted-decision-count", `${accepted} accepted decisions do not match ${frames.length} persisted frames`, "debug/session.jsonl");
    }
  }
}

async function validateDepth(
  source: ValidationSource,
  paths: Set<string>,
  frame: JsonRecord,
  context: string,
  add: AddIssue,
): Promise<void> {
  const depthPath = frame.depthPath as string;
  if (!safeRelativePath(depthPath) || !paths.has(depthPath)) {
    add("error", "missing-depth", `${context} references missing depth: ${depthPath}`, depthPath);
    return;
  }
  if (!positiveInteger(frame.depthWidth) || !positiveInteger(frame.depthHeight) ||
    !positiveFinite(frame.depthRawValueToMeters)) {
    add("error", "depth-metadata", `${context} has invalid depth dimensions or scale`, "telemetry/frames.jsonl");
    return;
  }
  validateMatrix(frame.normDepthBufferFromNormView, context, add, "telemetry/frames.jsonl");
  const bytes = await safeRead(source, depthPath, add);
  if (!bytes) return;
  const bytesPerPixel = frame.depthDataFormat === "float32"
    ? 4
    : frame.depthDataFormat === "luminance-alpha"
      ? 2
      : undefined;
  if (!bytesPerPixel) {
    add("warning", "depth-format", `Unknown depth format: ${String(frame.depthDataFormat)}`, "telemetry/frames.jsonl");
    return;
  }
  const expected = (frame.depthWidth as number) * (frame.depthHeight as number) * bytesPerPixel;
  if (bytes.byteLength !== expected) {
    add("error", "depth-size", `Depth payload has ${bytes.byteLength} bytes, expected ${expected}`, depthPath);
  }
}

async function validatePointCloud(
  source: ValidationSource,
  paths: Set<string>,
  transforms: JsonRecord,
  summary: ValidationSummary,
  add: AddIssue,
): Promise<void> {
  const declared = transforms.ply_file_path;
  if (declared === undefined) {
    if (paths.has("pointcloud.ply")) {
      add("warning", "unreferenced-pointcloud", "pointcloud.ply exists but transforms.json does not reference it", "transforms.json");
    } else {
      add("warning", "missing-pointcloud", "No seed point cloud is available for Spirula initialization", "transforms.json");
    }
    return;
  }
  if (typeof declared !== "string" || !safeRelativePath(declared) || !paths.has(declared)) {
    add("error", "missing-pointcloud", `Declared point cloud is missing: ${String(declared)}`, "transforms.json");
    return;
  }
  const bytes = await safeRead(source, declared, add);
  if (!bytes) return;
  const parsed = parsePointCloudPly(bytes);
  if ("error" in parsed) {
    add("error", "invalid-pointcloud", parsed.error, declared);
    return;
  }
  summary.pointCloudVertices = parsed.vertices;
}

async function validateTracking(
  source: ValidationSource,
  paths: Set<string>,
  frames: JsonRecord[],
  summary: ValidationSummary,
  add: AddIssue,
): Promise<void> {
  const path = "refinement/tracking.json";
  if (!paths.has(path)) {
    add("warning", "missing-tracking-report", "No visual tracking report is present", path);
    return;
  }
  const report = await readJson(source, path, add);
  if (!report) return;
  if (report.format !== "open3dcapture-visual-tracking" || report.version !== 1) {
    add("error", "tracking-format", "Unsupported visual tracking report format", path);
  }
  if (!positiveInteger(report.frameCount) || report.frameCount !== frames.length) {
    add("error", "tracking-frame-count", `Tracking report frameCount ${String(report.frameCount)} does not match ${frames.length} telemetry frames`, path);
  }
  summary.trackingFrames = typeof report.frameCount === "number" ? report.frameCount : undefined;
  summary.connectedTrackingFrames = typeof report.connectedFrameCount === "number" ? report.connectedFrameCount : undefined;
  summary.loopClosures = typeof report.loopClosures === "number" ? report.loopClosures : undefined;
  if (report.directTrainReady !== false) {
    add("error", "unsafe-readiness", "Phone tracking report must not claim direct-train readiness before pose optimization", path);
  }
  const target = isRecord(report.targetRegion) ? report.targetRegion : undefined;
  if (target) {
    for (const name of ["targetRegionFeatureFraction", "targetRegionInlierFraction"] as const) {
      const value = target[name];
      if (!finite(value) || (value as number) < 0 || (value as number) > 1) {
        add("error", "target-region-metric", `${name} must be between 0 and 1`, path);
      }
    }
  }
}

export function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 3 < bytes.length) {
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (offset + 1 >= bytes.length) break;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) return undefined;
    if (isStartOfFrame(marker) && length >= 7) {
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    offset += length;
  }
  return undefined;
}

export function parsePointCloudPly(bytes: Uint8Array): { vertices: number } | { error: string } {
  const endMarker = new TextEncoder().encode("end_header\n");
  const headerEnd = indexOfBytes(bytes, endMarker);
  if (headerEnd < 0) return { error: "PLY header has no end_header marker" };
  const dataOffset = headerEnd + endMarker.length;
  const header = decoder.decode(bytes.subarray(0, dataOffset));
  if (!header.startsWith("ply\n") || !header.includes("format binary_little_endian 1.0")) {
    return { error: "PLY must use binary_little_endian 1.0" };
  }
  const match = /^element vertex (\d+)$/m.exec(header);
  if (!match) return { error: "PLY header has no vertex count" };
  const vertices = Number(match[1]);
  if (!Number.isSafeInteger(vertices) || vertices <= 0) return { error: "PLY vertex count must be positive" };
  const expectedProperties = [
    "property float x",
    "property float y",
    "property float z",
    "property uchar red",
    "property uchar green",
    "property uchar blue",
  ];
  if (!expectedProperties.every((property) => header.includes(property))) {
    return { error: "PLY must contain float XYZ and uchar RGB properties" };
  }
  const expectedBytes = dataOffset + vertices * 15;
  if (bytes.byteLength !== expectedBytes) {
    return { error: `PLY has ${bytes.byteLength - dataOffset} vertex bytes, expected ${vertices * 15}` };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0, offset = dataOffset; index < vertices; index += 1, offset += 15) {
    if (![view.getFloat32(offset, true), view.getFloat32(offset + 4, true), view.getFloat32(offset + 8, true)]
      .every(Number.isFinite)) {
      return { error: `PLY vertex ${index} contains a non-finite coordinate` };
    }
  }
  return { vertices };
}

async function readJson(source: ValidationSource, path: string, add: AddIssue): Promise<JsonRecord | undefined> {
  const bytes = await safeRead(source, path, add);
  if (!bytes) return undefined;
  try {
    const value: unknown = JSON.parse(decoder.decode(bytes));
    if (!isRecord(value)) throw new Error("root value is not an object");
    return value;
  } catch (error) {
    add("error", "invalid-json", `Could not parse JSON: ${errorMessage(error)}`, path);
    return undefined;
  }
}

async function readJsonl(source: ValidationSource, path: string, add: AddIssue): Promise<JsonRecord[]> {
  const bytes = await safeRead(source, path, add);
  if (!bytes) return [];
  const records: JsonRecord[] = [];
  const lines = decoder.decode(bytes).split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (!isRecord(value)) throw new Error("record is not an object");
      records.push(value);
    } catch (error) {
      add("error", "invalid-jsonl", `Line ${index + 1} is invalid: ${errorMessage(error)}`, path);
    }
  }
  return records;
}

async function safeRead(source: ValidationSource, path: string, add: AddIssue): Promise<Uint8Array | undefined> {
  if (!source.paths.includes(path)) return undefined;
  try {
    return await source.read(path);
  } catch (error) {
    add("error", "read-failed", `Could not read file: ${errorMessage(error)}`, path);
    return undefined;
  }
}

function validateMatrix(value: unknown, context: string, add: AddIssue, path: string): void {
  if (!Array.isArray(value) || value.length !== 4 ||
    !value.every((row) => Array.isArray(row) && row.length === 4 && row.every(finite))) {
    add("error", "matrix", `${context} must contain a finite 4x4 matrix`, path);
    return;
  }
  const last = value[3] as number[];
  if (Math.abs(last[0]) > 1e-6 || Math.abs(last[1]) > 1e-6 ||
    Math.abs(last[2]) > 1e-6 || Math.abs(last[3] - 1) > 1e-6) {
    add("error", "matrix-homogeneous", `${context} has an invalid homogeneous row`, path);
  }
}

function safeRelativePath(value: string): boolean {
  return value.length > 0 && !value.startsWith("/") && !value.includes("\\") &&
    value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function matrixTranslation(value: unknown): [number, number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 4 ||
    !value.slice(0, 3).every((row) => Array.isArray(row) && row.length === 4 && finite(row[3]))) {
    return undefined;
  }
  return [value[0][3] as number, value[1][3] as number, value[2][3] as number];
}

function distance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function poseExtent(translations: Array<[number, number, number]>): number {
  const minimum = [...translations[0]];
  const maximum = [...translations[0]];
  for (const translation of translations.slice(1)) {
    for (let axis = 0; axis < 3; axis += 1) {
      minimum[axis] = Math.min(minimum[axis], translation[axis]);
      maximum[axis] = Math.max(maximum[axis], translation[axis]);
    }
  }
  return distance(minimum, maximum);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function positiveFinite(value: unknown): value is number {
  return finite(value) && value > 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStartOfFrame(marker: number): boolean {
  return [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker);
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let offset = 0; offset <= haystack.length - needle.length; offset += 1) {
    for (let index = 0; index < needle.length; index += 1) {
      if (haystack[offset + index] !== needle[index]) continue outer;
    }
    return offset;
  }
  return -1;
}

function severityOrder(value: ValidationSeverity): number {
  return value === "error" ? 0 : 1;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type AddIssue = (severity: ValidationSeverity, code: string, message: string, path?: string) => void;
