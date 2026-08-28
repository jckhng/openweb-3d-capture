import { exportDatasetZip } from "../dataset/zip";
import {
  DEFAULT_QUALITY_SELECTOR_CONFIG,
  QualityKeyframeSelector,
} from "../keyframes/quality-selector";
import { TemporalKeyframeGate } from "../keyframes/temporal-gate";
import { analyzeTargetImageQuality } from "../quality/sharpness";
import { medianCenterDepth } from "../quality/focus-distance";
import { IncrementalVisualTracker, unavailableReport } from "../refinement/visual-tracker";
import { deriveIntrinsics, fromWebXRTransform } from "../shared/matrix";
import { BUILD_TIMESTAMP } from "../shared/build";
import type {
  CaptureDecision,
  CaptureDecisionReason,
  CaptureFrame,
  CapabilityReport,
  CaptureMetadata,
  Intrinsics,
  Matrix4,
  VisualTrackingReport,
} from "../shared/types";
import { makeCaptureId } from "../storage/storage";
import type { CapturePersistence } from "../storage/storage";
import { IMUSensorRecorder } from "./imu";

const REJECTED_PREVIEW_INTERVAL = 4;

interface XRViewWithCamera extends XRView {
  camera?: {
    width: number;
    height: number;
  };
}

interface XRFrameDepthAccess {
  getDepthInformation?: (view: XRView) => XRCPUDepthInformation | null | undefined;
}

interface XRWebGLBindingLike {
  getCameraImage(camera: unknown): WebGLTexture | null;
}

interface ActiveCapture {
  id: string;
  target?: number;
  frames: number;
  candidates: number;
  metadata: CaptureMetadata;
  gate: TemporalKeyframeGate;
  selector?: QualityKeyframeSelector;
  imuStartIndex: number;
  inFlight: boolean;
  stopping: boolean;
  pendingWrite?: Promise<void>;
}

interface CandidateFrameInput {
  timestamp: number;
  cameraToWorld: Matrix4;
  projectionMatrix: ArrayLike<number>;
  intrinsics?: Intrinsics;
  width: number;
  height: number;
  trackingState: string;
  depth: DepthCapture | null;
  view: XRViewWithCamera;
}

export interface CaptureQualityTelemetry {
  candidates: number;
  rejected: number;
  rejectedBlur: number;
  rejectedLowTexture: number;
  rejectedMotion: number;
  rejectedRedundant: number;
  rejectedTracking: number;
  rejectedImage: number;
  rejectedTooClose: number;
  sharpnessScore: number;
  sharpnessThreshold: number;
  textureScore: number;
  motionScore: number;
  noveltyScore: number;
  linearVelocity: number;
  angularVelocity: number;
  targetDistance?: number;
  lastDecision: CaptureDecisionReason | "waiting";
}

export interface DiagnosticSnapshot {
  running: boolean;
  capabilities?: CapabilityReport;
  xrFps: number;
  cameraFps: number;
  trackingState: string;
  pose?: Matrix4;
  projectionMatrix?: number[];
  intrinsics?: Intrinsics;
  cameraResolution?: { width: number; height: number };
  depthResolution?: { width: number; height: number };
  depthScale?: number;
  targetDistance?: number;
  imuSampleRate: number;
  imuStatus: string;
  captureId?: string;
  captureMode?: "diagnostic" | "object";
  captureProgress: { current: number; target?: number };
  captureQuality: CaptureQualityTelemetry;
  visualTracking: VisualTrackingReport;
  lastCaptureId?: string;
  lastImageStatus: string;
  lastError?: string;
}

type Listener = (snapshot: DiagnosticSnapshot) => void;

export class XRDiagnosticController {
  private readonly imu = new IMUSensorRecorder();
  private readonly listeners = new Set<Listener>();
  private readonly canvas: HTMLCanvasElement;
  private readonly qualityCanvas: HTMLCanvasElement;
  private readonly visualTracker: IncrementalVisualTracker;
  private readonly snapshot: DiagnosticSnapshot = {
    running: false,
    xrFps: 0,
    cameraFps: 0,
    trackingState: "not running",
    imuSampleRate: 0,
    imuStatus: "not started",
    captureProgress: { current: 0 },
    captureQuality: createQualityTelemetry(),
    visualTracking: unavailableReport("waiting for object capture"),
    lastImageStatus: "not attempted",
  };
  private session?: XRSession;
  private referenceSpace?: XRReferenceSpace;
  private gl?: WebGL2RenderingContext;
  private binding?: XRWebGLBindingLike;
  private cameraReadProgram?: WebGLProgram;
  private cameraReadFramebuffer?: WebGLFramebuffer;
  private cameraReadTexture?: WebGLTexture;
  private cameraReadSize?: { width: number; height: number };
  private frameTimes: number[] = [];
  private activeCapture?: ActiveCapture;
  private lastCaptureId?: string;
  private rawVideo?: HTMLVideoElement;
  private rawStream?: MediaStream;
  private disposed = false;

  constructor(
    private readonly persistence: CapturePersistence,
    capabilities?: CapabilityReport,
  ) {
    this.snapshot.capabilities = capabilities;
    this.canvas = document.createElement("canvas");
    this.canvas.width = 1;
    this.canvas.height = 1;
    this.qualityCanvas = document.createElement("canvas");
    this.qualityCanvas.width = 128;
    this.qualityCanvas.height = 128;
    this.visualTracker = new IncrementalVisualTracker((report) => {
      this.snapshot.visualTracking = report;
      this.emit();
    });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  setCapabilities(capabilities: CapabilityReport): void {
    this.snapshot.capabilities = capabilities;
    this.emit();
  }

  getSnapshot(): DiagnosticSnapshot {
    return {
      ...this.snapshot,
      captureProgress: { ...this.snapshot.captureProgress },
      captureQuality: { ...this.snapshot.captureQuality },
      visualTracking: {
        ...this.snapshot.visualTracking,
        edges: this.snapshot.visualTracking.edges.map((edge) => ({ ...edge })),
      },
      pose: this.snapshot.pose?.map((row) => [...row]),
      projectionMatrix: this.snapshot.projectionMatrix ? [...this.snapshot.projectionMatrix] : undefined,
      intrinsics: this.snapshot.intrinsics ? { ...this.snapshot.intrinsics } : undefined,
      cameraResolution: this.snapshot.cameraResolution ? { ...this.snapshot.cameraResolution } : undefined,
      depthResolution: this.snapshot.depthResolution ? { ...this.snapshot.depthResolution } : undefined,
    };
  }

  async start(): Promise<void> {
    if (this.session) return;
    if (!navigator.xr) throw new Error("WebXR is unavailable");

    const sessionInit = {
      optionalFeatures: ["local", "dom-overlay", "depth-sensing", "camera-access"],
      domOverlay: { root: document.body },
      depthSensing: {
        usagePreference: ["cpu-optimized"],
        dataFormatPreference: ["luminance-alpha", "float32"],
        matchDepthView: true,
      },
    } as unknown as XRSessionInit;
    this.session = await navigator.xr.requestSession("immersive-ar", sessionInit);
    this.session.addEventListener("end", this.handleSessionEnd);

    try {
      try {
        this.referenceSpace = await this.session.requestReferenceSpace("local");
      } catch {
        this.referenceSpace = await this.session.requestReferenceSpace("viewer");
      }

      this.gl = this.canvas.getContext("webgl2", {
        alpha: true,
        antialias: false,
        preserveDrawingBuffer: false,
        xrCompatible: true,
      }) ?? undefined;
      if (!this.gl) throw new Error("WebGL2 is required for the XR diagnostic");
      await this.gl.makeXRCompatible();

      const layer = new XRWebGLLayer(this.session, this.gl);
      this.session.updateRenderState({ baseLayer: layer });

      const bindingConstructor = (globalThis as Record<string, unknown>).XRWebGLBinding as
        | (new (session: XRSession, context: WebGLRenderingContext) => XRWebGLBindingLike)
        | undefined;
      if (bindingConstructor) {
        this.binding = new bindingConstructor(this.session, this.gl);
      }

      const imuResult = await this.imu.start();
      this.snapshot.imuStatus = imuResult.detail;
      this.snapshot.running = true;
      this.snapshot.trackingState = "waiting for pose";
      this.emit();
      this.session.requestAnimationFrame(this.onXRFrame);
    } catch (error) {
      const failedSession = this.session;
      failedSession.removeEventListener("end", this.handleSessionEnd);
      this.session = undefined;
      this.referenceSpace = undefined;
      this.binding = undefined;
      await failedSession.end().catch(() => undefined);
      throw error;
    }
  }

  async enableRawCamera(): Promise<void> {
    if (this.rawVideo) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("getUserMedia is unavailable");
    }
    this.rawStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false,
    });
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = this.rawStream;
    await video.play();
    this.rawVideo = video;
    this.snapshot.lastImageStatus = "raw camera fallback enabled";
    this.emit();
  }

  async captureFrames(target = 20): Promise<void> {
    if (!Number.isInteger(target) || target < 1) throw new Error("Frame target must be a positive integer");
    await this.beginCapture("diagnostic", target);
  }

  async startBasicCapture(): Promise<void> {
    await this.beginCapture("object");
  }

  async stopCapture(): Promise<void> {
    const active = this.activeCapture;
    if (!active) throw new Error("No capture is running");
    active.stopping = true;
    await active.pendingWrite;
    if (this.activeCapture !== active) return;
    await this.finalizeActiveCapture(active, "complete");
  }

  private async beginCapture(captureMode: "diagnostic" | "object", target?: number): Promise<void> {
    if (!this.session || !this.snapshot.running) throw new Error("Start XR before capturing");
    if (this.activeCapture) throw new Error("A capture is already running");

    const now = new Date().toISOString();
    const metadata: CaptureMetadata = {
      format: "open3dcapture",
      version: 1,
      captureId: makeCaptureId(),
      createdAt: now,
      updatedAt: now,
      captureMode,
      source: "webxr",
      units: "meters",
      frameCount: 0,
      hasDepth: false,
      hasImu: false,
      status: "incomplete",
      applicationBuild: { builtAt: BUILD_TIMESTAMP },
    };
    await this.persistence.createCapture(metadata);
    this.activeCapture = {
      id: metadata.captureId,
      target,
      frames: 0,
      candidates: 0,
      metadata,
      gate: new TemporalKeyframeGate(4),
      selector: captureMode === "object" ? new QualityKeyframeSelector() : undefined,
      imuStartIndex: this.imu.getSampleCount(),
      inFlight: false,
      stopping: false,
    };
    this.snapshot.captureId = metadata.captureId;
    this.snapshot.captureMode = captureMode;
    this.snapshot.captureProgress = { current: 0, target };
    this.snapshot.captureQuality = createQualityTelemetry();
    this.visualTracker.reset();
    this.snapshot.lastError = undefined;
    this.emit();
  }

  async exportLastCapture(): Promise<{ blob: Blob; filename: string }> {
    if (!this.lastCaptureId && !this.activeCapture?.id) {
      throw new Error("No capture is available to export");
    }
    const captureId = this.lastCaptureId ?? this.activeCapture?.id;
    if (!captureId) throw new Error("No capture is available to export");
    const dataset = await this.persistence.loadCapture(captureId);
    return {
      blob: await exportDatasetZip(dataset),
      filename: `${captureId}.zip`,
    };
  }

  async exportCapture(captureId: string): Promise<{ blob: Blob; filename: string }> {
    const dataset = await this.persistence.loadCapture(captureId);
    return {
      blob: await exportDatasetZip(dataset),
      filename: `${captureId}.zip`,
    };
  }

  async stop(): Promise<void> {
    if (this.session) await this.session.end();
    else this.handleSessionEnd();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.stop();
    this.imu.stop();
    this.rawStream?.getTracks().forEach((track) => track.stop());
    this.rawStream = undefined;
    this.rawVideo = undefined;
    this.destroyCameraReadPipeline();
    this.visualTracker.dispose();
    this.listeners.clear();
  }

  private readonly onXRFrame = (time: number, frame: XRFrame): void => {
    if (this.disposed || !this.session || !this.referenceSpace) return;
    this.session.requestAnimationFrame(this.onXRFrame);

    const pose = frame.getViewerPose(this.referenceSpace);
    this.updateRate(time);
    this.snapshot.imuSampleRate = this.imu.getSampleRate();
    if (!pose) {
      this.snapshot.trackingState = "no pose";
      this.emit();
      return;
    }

    const view = pose.views[0] as XRViewWithCamera | undefined;
    if (!view) return;
    const camera = view.camera;
    const viewport = this.session.renderState.baseLayer?.getViewport(view);
    const width = camera?.width ?? viewport?.width ?? 0;
    const height = camera?.height ?? viewport?.height ?? 0;
    const cameraToWorld = fromWebXRTransform(view.transform);
    const projectionMatrix = Array.from(view.projectionMatrix);
    const intrinsics = width > 0 && height > 0
      ? deriveIntrinsics(view.projectionMatrix, width, height)
      : undefined;
    const depth = this.readDepth(frame, view);

    this.snapshot.pose = cameraToWorld;
    this.snapshot.projectionMatrix = projectionMatrix;
    this.snapshot.intrinsics = intrinsics;
    this.snapshot.cameraResolution = width > 0 && height > 0 ? { width, height } : undefined;
    this.snapshot.depthResolution = depth ? { width: depth.width, height: depth.height } : undefined;
    this.snapshot.depthScale = depth?.rawValueToMeters;
    this.snapshot.targetDistance = depth?.targetDistance;
    this.snapshot.trackingState = pose.emulatedPosition ? "emulated" : "tracked";

    const active = this.activeCapture;
    const belowTarget = active?.target === undefined || active.frames < active.target;
    if (
      active &&
      !active.stopping &&
      !active.inFlight &&
      belowTarget &&
      active.gate.tryAccept(time)
    ) {
      active.inFlight = true;
      const write = this.processCandidate({
        timestamp: time,
        cameraToWorld,
        projectionMatrix: view.projectionMatrix,
        intrinsics,
        width,
        height,
        trackingState: this.snapshot.trackingState,
        depth,
        view,
      }).catch((error: unknown) => {
        this.snapshot.lastError = error instanceof Error ? error.message : "Frame persistence failed";
      }).finally(() => {
        active.inFlight = false;
        active.pendingWrite = undefined;
      });
      active.pendingWrite = write;
    }
    this.emit();
  };

  private async processCandidate(input: CandidateFrameInput): Promise<void> {
    const active = this.activeCapture;
    if (!active) return;
    const candidateId = active.candidates;
    active.candidates += 1;
    const image = await this.readCameraImage(input.view);
    let decision: CaptureDecision | undefined;
    if (active.selector) {
      decision = active.selector.evaluate({
        candidateId,
        timestamp: input.timestamp,
        cameraToWorld: input.cameraToWorld,
        trackingState: input.trackingState,
        imageAvailable: Boolean(image),
        imageSynchronized: image?.source === "xr-camera",
        sharpnessScore: image?.sharpnessScore ?? 0,
        textureScore: image?.textureScore ?? 0,
        targetDistance: input.depth?.targetDistance,
      });
      if (decision.accepted) decision.acceptedFrameId = active.frames;
      this.updateQualityTelemetry(decision);
      const rejectedPreview = decision.accepted || !image || candidateId % REJECTED_PREVIEW_INTERVAL !== 0
        ? undefined
        : await canvasToBlob(this.qualityCanvas, "image/jpeg", 0.7) ?? undefined;
      await this.persistence.appendDecision(active.id, decision, rejectedPreview);
      if (!decision.accepted) {
        this.snapshot.lastImageStatus = `candidate rejected: ${decision.reason}`;
        this.emit();
        return;
      }
    }

    await this.persistAcceptedFrame(input, image, decision?.quality ?? emptyFrameQuality());
    if (decision) active.selector?.commitAccepted(decision);
  }

  private async persistAcceptedFrame(
    input: CandidateFrameInput,
    image: CapturedImage | null,
    quality: CaptureFrame["quality"],
  ): Promise<void> {
    const active = this.activeCapture;
    if (!active) return;
    const id = active.frames;
    const imagePath = image ? `images/${String(id).padStart(6, "0")}.jpg` : undefined;
    const outputWidth = image?.width ?? input.width;
    const outputHeight = image?.height ?? input.height;
    const intrinsics = scaleIntrinsics(
      input.intrinsics ?? { fx: 0, fy: 0, cx: 0, cy: 0 },
      input.width,
      input.height,
      outputWidth,
      outputHeight,
    );
    const frame: CaptureFrame = {
      id,
      timestamp: input.timestamp,
      imagePath,
      width: outputWidth,
      height: outputHeight,
      intrinsics,
      cameraToWorld: input.cameraToWorld,
      trackingState: input.trackingState,
      imageSource: image?.source,
      imageSynchronized: image?.source === "xr-camera",
      targetDistance: input.depth?.targetDistance,
      quality,
      depthPath: input.depth ? `depth/${String(id).padStart(6, "0")}.bin` : undefined,
      depthWidth: input.depth?.width,
      depthHeight: input.depth?.height,
      depthRawValueToMeters: input.depth?.rawValueToMeters,
      depthDataFormat: input.depth?.dataFormat,
      normDepthBufferFromNormView: input.depth?.normDepthBufferFromNormView,
    };

    await this.persistence.appendFrame(active.id, frame, image?.blob, input.depth?.blob);
    if (active.selector && image?.source === "xr-camera") {
      this.visualTracker.track({
        id,
        image: image.blob,
        width: outputWidth,
        height: outputHeight,
        intrinsics,
        cameraToWorld: input.cameraToWorld,
      });
    }
    active.frames += 1;
    active.metadata.frameCount = active.frames;
    active.metadata.hasDepth ||= Boolean(input.depth);
    active.metadata.cameraResolution ??= outputWidth > 0
      ? { width: outputWidth, height: outputHeight }
      : undefined;
    this.snapshot.captureProgress = { current: active.frames, target: active.target };
    this.snapshot.lastImageStatus = image
      ? image.source === "xr-camera"
        ? "synchronized XR camera image saved"
        : "unsynchronized media-stream image saved"
      : this.rawVideo
        ? "raw camera fallback produced no frame"
        : "XR camera image unavailable; pose retained";

    if (active.target !== undefined && active.frames >= active.target) {
      active.stopping = true;
      await this.finalizeActiveCapture(active, "complete");
    }
    this.emit();
  }

  private updateQualityTelemetry(decision: CaptureDecision): void {
    const telemetry = this.snapshot.captureQuality;
    telemetry.candidates += 1;
    telemetry.sharpnessScore = decision.sharpnessScore;
    telemetry.sharpnessThreshold = decision.sharpnessThreshold ?? DEFAULT_QUALITY_SELECTOR_CONFIG.minimumSharpness;
    telemetry.textureScore = decision.textureScore ?? 0;
    telemetry.motionScore = decision.quality.motionScore;
    telemetry.noveltyScore = decision.quality.noveltyScore;
    telemetry.linearVelocity = decision.linearVelocity;
    telemetry.angularVelocity = decision.angularVelocity;
    telemetry.targetDistance = decision.targetDistance;
    telemetry.lastDecision = decision.reason;
    if (decision.accepted) return;

    telemetry.rejected += 1;
    if (decision.reason === "blur") telemetry.rejectedBlur += 1;
    else if (decision.reason === "low-texture") telemetry.rejectedLowTexture += 1;
    else if (decision.reason === "too-close") telemetry.rejectedTooClose += 1;
    else if (decision.reason === "motion") telemetry.rejectedMotion += 1;
    else if (decision.reason === "redundant") telemetry.rejectedRedundant += 1;
    else if (decision.reason === "tracking") telemetry.rejectedTracking += 1;
    else telemetry.rejectedImage += 1;
  }

  private readDepth(frame: XRFrame, view: XRView): DepthCapture | null {
    const frameWithDepth = frame as unknown as XRFrameDepthAccess;
    if (!frameWithDepth.getDepthInformation) return null;
    try {
      const information = frameWithDepth.getDepthInformation(view);
      if (!information) return null;
      const data = information.data;
      return {
        width: information.width,
        height: information.height,
        rawValueToMeters: information.rawValueToMeters,
        dataFormat: this.session?.depthDataFormat,
        normDepthBufferFromNormView: fromWebXRTransform(information.normDepthBufferFromNormView),
        targetDistance: medianCenterDepth(information.getDepthInMeters.bind(information)),
        blob: data ? new Blob([data], { type: "application/octet-stream" }) : undefined,
      };
    } catch {
      return null;
    }
  }

  private async readCameraImage(view: XRViewWithCamera): Promise<CapturedImage | null> {
    const camera = view.camera;
    if (camera && this.binding && this.gl) {
      try {
        const texture = this.binding.getCameraImage(camera);
        if (!texture) return null;
        const width = camera.width;
        const height = camera.height;
        if (!(width > 0) || !(height > 0)) return null;
        const gl = this.gl;
        this.ensureCameraReadPipeline(width, height);
        const framebuffer = this.cameraReadFramebuffer;
        const program = this.cameraReadProgram;
        if (!framebuffer || !program) return null;
        const previousFramebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
        const previousProgram = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null;
        const previousActiveTexture = gl.getParameter(gl.ACTIVE_TEXTURE) as number;
        const previousViewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.viewport(0, 0, width, height);
        gl.useProgram(program);
        gl.activeTexture(gl.TEXTURE0);
        const previousTexture0 = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.uniform1i(gl.getUniformLocation(program, "cameraTexture"), 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        const pixels = new Uint8Array(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        gl.bindTexture(gl.TEXTURE_2D, previousTexture0);
        gl.activeTexture(previousActiveTexture);
        gl.useProgram(previousProgram);
        gl.bindFramebuffer(gl.FRAMEBUFFER, previousFramebuffer);
        gl.viewport(previousViewport[0], previousViewport[1], previousViewport[2], previousViewport[3]);

        const imageData = new ImageData(width, height);
        for (let y = 0; y < height; y += 1) {
          const sourceOffset = (height - y - 1) * width * 4;
          imageData.data.set(pixels.subarray(sourceOffset, sourceOffset + width * 4), y * width * 4);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d")?.putImageData(imageData, 0, 0);
        const quality = this.measureImageQuality(canvas, width, height);
        const blob = await canvasToBlob(canvas, "image/jpeg", 0.92);
        if (blob) return { blob, width, height, source: "xr-camera", ...quality };
      } catch {
        // Fall through to the optional getUserMedia camera.
      }
    }

    if (this.rawVideo && this.rawVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      const width = this.rawVideo.videoWidth;
      const height = this.rawVideo.videoHeight;
      if (width > 0 && height > 0) {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d")?.drawImage(this.rawVideo, 0, 0, width, height);
        const quality = this.measureImageQuality(canvas, width, height);
        const blob = await canvasToBlob(canvas, "image/jpeg", 0.92);
        return blob ? { blob, width, height, source: "media-stream", ...quality } : null;
      }
    }
    return null;
  }

  private measureImageQuality(
    source: CanvasImageSource,
    width: number,
    height: number,
  ): { sharpnessScore: number; textureScore: number } {
    const context = this.qualityCanvas.getContext("2d", { willReadFrequently: true });
    if (!context) return { sharpnessScore: 0, textureScore: 0 };
    const cropSize = Math.max(1, Math.floor(Math.min(width, height) * 0.6));
    const sourceX = Math.floor((width - cropSize) / 2);
    const sourceY = Math.floor((height - cropSize) / 2);
    context.drawImage(
      source,
      sourceX,
      sourceY,
      cropSize,
      cropSize,
      0,
      0,
      this.qualityCanvas.width,
      this.qualityCanvas.height,
    );
    const image = context.getImageData(0, 0, this.qualityCanvas.width, this.qualityCanvas.height);
    return analyzeTargetImageQuality(image.data, image.width, image.height);
  }

  private ensureCameraReadPipeline(width: number, height: number): void {
    const gl = this.gl;
    if (!gl) throw new Error("WebGL is unavailable");
    if (!this.cameraReadProgram) {
      this.cameraReadProgram = createProgram(gl, CAMERA_VERTEX_SHADER, CAMERA_FRAGMENT_SHADER);
    }
    if (
      this.cameraReadFramebuffer &&
      this.cameraReadTexture &&
      this.cameraReadSize?.width === width &&
      this.cameraReadSize.height === height
    ) return;

    if (this.cameraReadFramebuffer) gl.deleteFramebuffer(this.cameraReadFramebuffer);
    if (this.cameraReadTexture) gl.deleteTexture(this.cameraReadTexture);
    const framebuffer = gl.createFramebuffer();
    const texture = gl.createTexture();
    if (!framebuffer || !texture) throw new Error("Could not allocate camera readback target");

    const previousFramebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const previousTexture = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, previousFramebuffer);
    gl.bindTexture(gl.TEXTURE_2D, previousTexture);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteFramebuffer(framebuffer);
      gl.deleteTexture(texture);
      throw new Error(`Camera readback framebuffer is incomplete: ${status}`);
    }
    this.cameraReadFramebuffer = framebuffer;
    this.cameraReadTexture = texture;
    this.cameraReadSize = { width, height };
  }

  private destroyCameraReadPipeline(): void {
    if (!this.gl) return;
    if (this.cameraReadFramebuffer) this.gl.deleteFramebuffer(this.cameraReadFramebuffer);
    if (this.cameraReadTexture) this.gl.deleteTexture(this.cameraReadTexture);
    if (this.cameraReadProgram) this.gl.deleteProgram(this.cameraReadProgram);
    this.cameraReadFramebuffer = undefined;
    this.cameraReadTexture = undefined;
    this.cameraReadProgram = undefined;
    this.cameraReadSize = undefined;
  }

  private updateRate(time: number): void {
    this.frameTimes.push(time);
    while (this.frameTimes.length > 0 && time - this.frameTimes[0] > 1000) this.frameTimes.shift();
    this.snapshot.xrFps = this.frameTimes.length;
    this.snapshot.cameraFps = this.snapshot.cameraResolution ? this.frameTimes.length : 0;
  }

  private readonly handleSessionEnd = (): void => {
    this.session?.removeEventListener("end", this.handleSessionEnd);
    this.session = undefined;
    this.referenceSpace = undefined;
    this.snapshot.running = false;
    this.snapshot.trackingState = "session ended";
    this.imu.stop();
    const interrupted = this.activeCapture;
    if (interrupted) {
      void this.finalizeInterruptedCapture(interrupted).catch((error: unknown) => {
        this.snapshot.lastError = error instanceof Error
          ? error.message
          : "Could not finalize interrupted capture";
        this.emit();
      });
    }
    this.emit();
  };

  private async finalizeInterruptedCapture(active: ActiveCapture): Promise<void> {
    active.stopping = true;
    await active.pendingWrite;
    if (this.activeCapture !== active) return;
    await this.finalizeActiveCapture(active, "incomplete");
  }

  private async finalizeActiveCapture(active: ActiveCapture, status: "complete" | "incomplete"): Promise<void> {
    const samples = this.imu.getSamples(active.imuStartIndex);
    await this.persistence.appendImu(active.id, samples);
    if (active.selector) {
      const visualTracking = await this.visualTracker.finish();
      await this.persistence.saveVisualTracking(active.id, visualTracking);
      this.snapshot.visualTracking = visualTracking;
    }
    await this.persistence.finalizeCapture(active.id, {
      ...active.metadata,
      frameCount: active.frames,
      hasImu: samples.length > 0,
      status,
      updatedAt: new Date().toISOString(),
    });
    this.lastCaptureId = active.id;
    this.snapshot.lastCaptureId = active.id;
    this.snapshot.captureId = undefined;
    this.snapshot.captureMode = undefined;
    this.activeCapture = undefined;
    this.emit();
  }

  private emit(): void {
    const value = this.getSnapshot();
    for (const listener of this.listeners) listener(value);
  }
}

interface DepthCapture {
  width: number;
  height: number;
  rawValueToMeters: number;
  dataFormat?: string;
  normDepthBufferFromNormView: Matrix4;
  targetDistance?: number;
  blob?: Blob;
}

interface CapturedImage {
  blob: Blob;
  width: number;
  height: number;
  source: "xr-camera" | "media-stream";
  sharpnessScore: number;
  textureScore: number;
}

function createQualityTelemetry(): CaptureQualityTelemetry {
  return {
    candidates: 0,
    rejected: 0,
    rejectedBlur: 0,
    rejectedLowTexture: 0,
    rejectedMotion: 0,
    rejectedRedundant: 0,
    rejectedTracking: 0,
    rejectedImage: 0,
    rejectedTooClose: 0,
    sharpnessScore: 0,
    sharpnessThreshold: DEFAULT_QUALITY_SELECTOR_CONFIG.minimumSharpness,
    textureScore: 0,
    motionScore: 0,
    noveltyScore: 0,
    linearVelocity: 0,
    angularVelocity: 0,
    lastDecision: "waiting",
  };
}

function emptyFrameQuality(): CaptureFrame["quality"] {
  return { blurScore: 0, motionScore: 0, noveltyScore: 0, coverageGain: 0 };
}

function scaleIntrinsics(
  intrinsics: Intrinsics,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): Intrinsics {
  if (!(sourceWidth > 0) || !(sourceHeight > 0)) return intrinsics;
  const scaleX = targetWidth / sourceWidth;
  const scaleY = targetHeight / sourceHeight;
  return {
    fx: intrinsics.fx * scaleX,
    fy: intrinsics.fy * scaleY,
    cx: intrinsics.cx * scaleX,
    cy: intrinsics.cy * scaleY,
  };
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

const CAMERA_VERTEX_SHADER = `#version 300 es
out vec2 textureCoordinate;
void main() {
  vec2 position = gl_VertexID == 0 ? vec2(-1.0, -1.0)
    : gl_VertexID == 1 ? vec2(3.0, -1.0)
    : vec2(-1.0, 3.0);
  textureCoordinate = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}`;

const CAMERA_FRAGMENT_SHADER = `#version 300 es
precision mediump float;
uniform sampler2D cameraTexture;
in vec2 textureCoordinate;
out vec4 outputColor;
void main() {
  outputColor = texture(cameraTexture, textureCoordinate);
}`;

function createProgram(gl: WebGL2RenderingContext, vertexSource: string, fragmentSource: string): WebGLProgram {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (!program) throw new Error("Could not allocate camera readback shader program");
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const detail = gl.getProgramInfoLog(program) ?? "unknown link error";
    gl.deleteProgram(program);
    throw new Error(`Camera readback shader link failed: ${detail}`);
  }
  return program;
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Could not allocate camera readback shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const detail = gl.getShaderInfoLog(shader) ?? "unknown compile error";
    gl.deleteShader(shader);
    throw new Error(`Camera readback shader compilation failed: ${detail}`);
  }
  return shader;
}
