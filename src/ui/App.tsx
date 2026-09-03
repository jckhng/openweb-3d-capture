import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { DEFAULT_QUALITY_SELECTOR_CONFIG } from "../keyframes/quality-selector";
import { locateCoverageCell } from "../coverage/readiness";
import type { DiagnosticSnapshot } from "../xr/diagnostic-controller";
import { XRDiagnosticController } from "../xr/diagnostic-controller";
import { probeCapabilities } from "../xr/capabilities";
import type {
  CapabilityReport,
  CaptureMetadata,
  CaptureReadinessStatus,
  Matrix4,
  PhotoCaptureGuidance,
} from "../shared/types";
import { MemoryCaptureStore } from "../storage/memory";
import { OPFSCaptureStore } from "../storage/opfs";
import { isOpfsSupported } from "../storage/storage";
import {
  inspectBrowserStorage,
  requestPersistentBrowserStorage,
  type BrowserStorageStatus,
} from "../storage/browser-storage";
import { BUILD_TIMESTAMP, formatBuildTimestamp } from "../shared/build";
import type { CaptureReadinessReport } from "../shared/types";
import type { ExportProfile } from "../dataset/zip";
import { CaptureGlobe } from "./CaptureGlobe";
import { useScreenWakeLock } from "./use-screen-wake-lock";
import { PhotoCaptureGlobe } from "./PhotoCaptureGlobe";
import {
  PhotoCaptureController,
  type PhotoCaptureSnapshot,
} from "../photo/photo-capture-controller";

const MINIMUM_TARGET_DISTANCE_CM = Math.round(
  DEFAULT_QUALITY_SELECTOR_CONFIG.minimumTargetDistance * 100,
);
const MINIMUM_FREE_STORAGE_BYTES = 250 * 1024 * 1024;

function createStore() {
  return isOpfsSupported() ? new OPFSCaptureStore() : new MemoryCaptureStore();
}

export function App() {
  const store = useMemo(createStore, []);
  const controller = useMemo(() => new XRDiagnosticController(store), [store]);
  const photoController = useMemo(() => new PhotoCaptureController(store), [store]);
  const [snapshot, setSnapshot] = useState<DiagnosticSnapshot>(() => controller.getSnapshot());
  const [photoSnapshot, setPhotoSnapshot] = useState<PhotoCaptureSnapshot>(() => photoController.getSnapshot());
  const [captures, setCaptures] = useState<CaptureMetadata[]>([]);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [storageStatus, setStorageStatus] = useState<BrowserStorageStatus>({});
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [hybridMode, setHybridMode] = useState(false);
  const [hybridFallbackDistance, setHybridFallbackDistance] = useState(0.3);
  const previousCheckpointCount = useRef(0);
  const previousOffTarget = useRef(false);
  const photoVideo = useRef<HTMLVideoElement>(null);
  const photoActive = photoSnapshot.phase === "preview" || photoSnapshot.phase === "capturing";
  const photoCaptureSupported = typeof window !== "undefined" &&
    "ImageCapture" in window && Boolean(navigator.mediaDevices?.getUserMedia);
  const wakeLockState = useScreenWakeLock(
    snapshot.running || photoActive || Boolean(snapshot.captureFinalization),
  );

  const refreshCaptures = async () => {
    const [nextCaptures, nextStorage] = await Promise.all([
      store.listCaptures(),
      inspectBrowserStorage(),
    ]);
    setCaptures(nextCaptures);
    setStorageStatus(nextStorage);
  };

  useEffect(() => controller.subscribe(setSnapshot), [controller]);
  useEffect(() => photoController.subscribe(setPhotoSnapshot), [photoController]);

  useEffect(() => {
    photoController.setWebXRGuidance(hybridMode ? makePhotoGuidance(snapshot) : undefined);
  }, [
    hybridMode,
    photoController,
    snapshot.guidanceFraming,
    snapshot.guidanceTarget,
    snapshot.pose,
    snapshot.trackingState,
  ]);

  useEffect(() => {
    void run("capability probe", async () => {
      const report = await probeCapabilities();
      controller.setCapabilities(report);
      await refreshCaptures();
    });
    return () => {
      void controller.dispose();
      void photoController.dispose();
    };
    // Controller and store are stable for this component lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, photoController]);

  useEffect(() => {
    if (snapshot.lastCaptureId) void refreshCaptures().catch(showError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.lastCaptureId]);

  useEffect(() => {
    document.documentElement.classList.toggle("xr-active-root", snapshot.running);
    document.documentElement.classList.toggle("photo-active-root", photoActive);
    return () => {
      document.documentElement.classList.remove("xr-active-root");
      document.documentElement.classList.remove("photo-active-root");
    };
  }, [snapshot.running, photoActive]);

  useEffect(() => {
    if (photoSnapshot.phase === "complete") void refreshCaptures().catch(showError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photoSnapshot.phase]);

  useEffect(() => {
    if (!snapshot.captureId) {
      previousCheckpointCount.current = 0;
      return;
    }
    const completed = snapshot.captureReadiness?.metrics.coverageCheckpointsCompleted ?? 0;
    if (completed > previousCheckpointCount.current && "vibrate" in navigator) {
      navigator.vibrate([35, 25, 65]);
    }
    previousCheckpointCount.current = completed;
  }, [snapshot.captureId, snapshot.captureReadiness?.metrics.coverageCheckpointsCompleted]);

  useEffect(() => {
    const offTarget = Boolean(snapshot.captureId && snapshot.targetFraming && !snapshot.targetFraming.centered);
    if (offTarget && !previousOffTarget.current && "vibrate" in navigator) {
      navigator.vibrate([90, 50, 90]);
    }
    previousOffTarget.current = offTarget;
  }, [snapshot.captureId, snapshot.targetFraming]);

  async function run(label: string, action: () => Promise<void>) {
    setBusy(label);
    setError(undefined);
    setNotice(undefined);
    try {
      await action();
    } catch (caught) {
      showError(caught);
    } finally {
      setBusy(undefined);
    }
  }

  function showError(caught: unknown) {
    setError(caught instanceof Error ? caught.message : String(caught));
  }

  async function downloadCapture(
    profile: ExportProfile,
    captureId?: string,
    readinessStatus?: CaptureReadinessStatus,
  ) {
    if (
      profile !== "canonical" &&
      readinessStatus &&
      readinessStatus !== "ready" &&
      !window.confirm(
        `This capture is ${readinessLabel(readinessStatus)}, not READY FOR SFM. Export anyway?`,
      )
    ) return;
    const exported = captureId
      ? await controller.exportCapture(captureId, profile)
      : await controller.exportLastCapture(profile);
    const url = URL.createObjectURL(exported.blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = exported.filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  async function startCapture() {
    await ensureCaptureStorage();
    await controller.startBasicCapture();
  }

  async function startPhotoCapture() {
    await ensureCaptureStorage();
    if (hybridMode) {
      controller.lockGuidanceTarget(hybridFallbackDistance);
      photoController.setWebXRGuidance(makePhotoGuidance(controller.getSnapshot()));
    }
    await photoController.startCapture(hybridMode ? "webxr" : "manual");
  }

  async function ensureCaptureStorage() {
    if (store.kind !== "opfs") {
      throw new Error("Persistent browser storage is required for object capture on this device");
    }
    const nextStorage = await requestPersistentBrowserStorage();
    setStorageStatus(nextStorage);
    if (
      nextStorage.available !== undefined &&
      nextStorage.available < MINIMUM_FREE_STORAGE_BYTES
    ) {
      throw new Error(`At least ${formatBytes(MINIMUM_FREE_STORAGE_BYTES)} of free browser storage is required`);
    }
  }

  async function openPhotoCamera() {
    if (!photoVideo.current) throw new Error("Camera preview is unavailable");
    await photoController.open(photoVideo.current);
  }

  async function openHybridCamera() {
    if (!photoVideo.current) throw new Error("Camera preview is unavailable");
    await controller.start();
    try {
      await photoController.open(photoVideo.current);
      await delay(500);
      const xrState = controller.getSnapshot();
      const cameraState = photoController.getSnapshot();
      if (!xrState.running) throw new Error("WebXR ended when the autofocus stream opened");
      if (cameraState.cameraStreamState !== "live") {
        throw new Error(`Autofocus stream became ${cameraState.cameraStreamState} while WebXR was active`);
      }
      setHybridMode(true);
    } catch (caught) {
      await controller.stop();
      if (photoController.getSnapshot().cameraStreamState !== "live") {
        await photoController.close();
        await photoController.open(photoVideo.current);
      }
      setHybridMode(false);
      setError(`XR and autofocus could not run together. Autofocus-only fallback opened: ${errorMessage(caught)}`);
    }
  }

  async function finishPhotoCapture() {
    await photoController.finishCapture();
    if (hybridMode) await controller.stop();
    setHybridMode(false);
    await refreshCaptures();
  }

  async function closePhotoCamera() {
    await photoController.close();
    if (hybridMode) await controller.stop();
    setHybridMode(false);
    await refreshCaptures();
  }

  async function deleteCapture(capture: CaptureMetadata) {
    const partial = capture.status === "incomplete" ? " incomplete" : "";
    if (!window.confirm(`Delete${partial} capture ${capture.captureId}? This cannot be undone.`)) return;
    await controller.deleteCapture(capture.captureId);
    await refreshCaptures();
    setNotice(`Deleted ${capture.captureId}.`);
  }

  async function copyTesterReport() {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable");
    await navigator.clipboard.writeText(testReport(
      snapshot,
      photoSnapshot,
      store.kind,
      storageStatus,
      wakeLockState,
    ));
    setNotice("Test report copied. Add what happened and attach the relevant ZIP privately.");
  }

  return (
    <main className={[
      snapshot.running ? "xr-active" : "",
      photoActive ? "photo-active" : "",
      snapshot.running && photoActive ? "hybrid-active" : "",
    ].filter(Boolean).join(" ") || undefined}>
      <header>
        <p className="eyebrow">Capture preflight</p>
        <h1>Open Web 3D Capture</h1>
        <p className="header-build-id">
          Build <time dateTime={BUILD_TIMESTAMP}>{formatBuildTimestamp()}</time>
        </p>
        <p className="lede">Open the camera, center the object, then start capture when you are ready.</p>
      </header>

      {error || (photoActive ? photoSnapshot.lastError : snapshot.lastError ?? photoSnapshot.lastError) ? (
        <div className="error" role="alert">
          {error ?? (photoActive ? photoSnapshot.lastError : snapshot.lastError ?? photoSnapshot.lastError)}
        </div>
      ) : null}
      {notice ? <div className="notice" role="status">{notice}</div> : null}

      {!snapshot.running && !photoActive ? (
        <section className="onboarding" aria-labelledby="before-capture-title">
          <div className="section-heading">
            <h2 id="before-capture-title">Before capturing</h2>
            <strong className={store.kind === "opfs" ? "available" : "unavailable"}>
              {store.kind === "opfs" ? "Local capture ready" : "Persistent storage required"}
            </strong>
          </div>
          <ol className="capture-steps">
            <li>Choose WebXR for guided medium-object capture or Autofocus photos for small, close subjects.</li>
            <li>Use bright, even light and keep the object static.</li>
            <li>Open the selected camera, center the object, then explicitly start capture.</li>
            <li>Move between overlapping viewpoints and stop while each image is acquired.</li>
          </ol>
          <p className="privacy-note">
            <strong>Local browser only — no capture uploads.</strong>{" "}
            Photos, depth, motion, poses, and diagnostics stay in browser storage on this device. The app has no cloud sync or analytics. Data leaves the device only when you export a ZIP and choose to share it. Backgrounds may contain private information.
          </p>
          <dl className="rollout-status">
            <Metric label="local storage" value={store.kind === "opfs" ? "available" : "not persistent"} />
            <Metric label="free space" value={formatBytes(storageStatus.available)} />
            <Metric
              label="storage protection"
              value={storageStatus.persisted === undefined
                ? "unknown"
                : storageStatus.persisted ? "persistent" : "best effort"}
            />
            <Metric label="screen wake lock" value={wakeLockState} />
            <Metric label="autofocus photos" value={photoCaptureSupported ? "available" : "unavailable"} />
          </dl>
          {storageWarning(store.kind, storageStatus)}
        </section>
      ) : null}

      <video
        ref={photoVideo}
        className="photo-preview"
        autoPlay
        muted
        playsInline
        aria-label="Autofocus camera preview"
      />

      {photoActive && photoSnapshot.captureId ? (
        <PhotoCaptureGlobe
          photoCount={photoSnapshot.photoCount}
          overlap={photoSnapshot.lastOverlap}
          trackedCells={photoSnapshot.guidanceMode === "webxr" ? photoSnapshot.coverageCells : undefined}
          guidance={photoSnapshot.guidance}
          guidancePose={hybridMode ? snapshot.pose : undefined}
          guidanceTarget={hybridMode ? snapshot.guidanceTarget?.worldPoint : undefined}
        />
      ) : null}

      {photoActive ? (
        <div
          className={`photo-reticle photo-stage-${photoSnapshot.stage}`}
          style={{ "--photo-stage-progress": `${photoSnapshot.stageProgress * 360}deg` } as CSSProperties}
          aria-hidden="true"
        >
          <span className="photo-reticle-progress" />
          <strong>{photoStageLabel(photoSnapshot)}</strong>
        </div>
      ) : null}

      {photoActive && photoSnapshot.lastPhotoPreviewUrl ? (
        <figure className="photo-winner-preview">
          <img src={photoSnapshot.lastPhotoPreviewUrl} alt="Sharpest photograph retained from the last burst" />
          <figcaption>saved winner</figcaption>
        </figure>
      ) : null}

      {snapshot.running && !photoActive ? (
        <div className={`reticle ${snapshot.targetFraming && !snapshot.targetFraming.centered ? "quality-off-target" : qualityClass(snapshot.captureQuality.lastDecision)}`} aria-hidden="true" />
      ) : null}

      {snapshot.captureId && snapshot.targetFraming && !snapshot.targetFraming.centered ? (
        <div className="target-warning" role="status">
          {targetDirection(snapshot.targetFraming.ndc)} — RE-CENTER OBJECT
        </div>
      ) : null}

      {hybridMode && photoSnapshot.captureId && snapshot.guidanceFraming && !snapshot.guidanceFraming.centered ? (
        <div className="target-warning" role="status">
          {targetDirection(snapshot.guidanceFraming.ndc)} — RE-CENTER OBJECT
        </div>
      ) : null}

      {snapshot.captureId && snapshot.captureReadiness ? (
        <CaptureGlobe
          report={snapshot.captureReadiness}
          pose={snapshot.pose}
          captureMap={snapshot.captureMap}
          framingLost={Boolean(snapshot.targetFraming && !snapshot.targetFraming.centered)}
        />
      ) : null}

      {photoActive ? (
        <PhotoCapturePanel
          snapshot={photoSnapshot}
          busy={busy}
          storageAvailable={store.kind === "opfs"}
          onStart={() => void run("starting autofocus photo scan", startPhotoCapture)}
          onCapture={() => void run("capturing sharp photo burst", () => photoController.capturePhoto())}
          onAutomaticChange={(enabled) => photoController.setAutomaticCapture(enabled)}
          hybrid={hybridMode}
          hybridFallbackDistance={hybridFallbackDistance}
          onHybridFallbackDistanceChange={setHybridFallbackDistance}
          xrSnapshot={snapshot}
          onFinish={() => void run("saving autofocus photo scan", finishPhotoCapture)}
          onClose={() => void run("closing autofocus camera", closePhotoCamera)}
        />
      ) : (
      <section className="capture-panel" aria-label="Capture controls">
        <p className="local-data-status">LOCAL DEVICE ONLY · NO CAPTURE UPLOADS</p>
        <p className="build-id">
          Build <time dateTime={BUILD_TIMESTAMP}>{formatBuildTimestamp()}</time>
        </p>
        <div className="capture-status">
          <div>
            <span>{snapshot.captureId ? "views" : "capture"}</span>
            <strong>{snapshot.captureId ? snapshot.captureProgress.current : "choose mode"}</strong>
          </div>
          <div>
            <span>{snapshot.captureId ? "orbit" : "minimum distance"}</span>
            <strong>
              {snapshot.captureId
                ? `${snapshot.captureReadiness?.metrics.azimuthBinsCovered ?? 0}/${snapshot.captureReadiness?.metrics.azimuthBinCount ?? 12}`
                : `${MINIMUM_TARGET_DISTANCE_CM} cm`}
            </strong>
          </div>
          <div>
            <span>{snapshot.captureId ? "connected" : "last result"}</span>
            <strong>
              {snapshot.captureId
                ? `${snapshot.visualTracking.connectedFrameCount}/${snapshot.captureProgress.current}`
                : snapshot.lastReadiness ? readinessLabel(snapshot.lastReadiness.status) : "new"}
            </strong>
          </div>
        </div>
        <p className={`capture-instruction ${qualityClass(snapshot.captureQuality.lastDecision)}`}>
          {captureInstruction(snapshot)}
        </p>
        <div className="actions">
          {!snapshot.running ? (
            <>
              <button
                className="primary"
                disabled={Boolean(busy) || snapshot.capabilities?.immersiveAR.available !== true}
                onClick={() => void run("opening XR camera", () => controller.start())}
              >
                Open guided WebXR
              </button>
              <button
                disabled={Boolean(busy) || store.kind !== "opfs" || !photoCaptureSupported}
                onClick={() => void run("opening autofocus camera", openPhotoCamera)}
              >
                Open close-focus photos
              </button>
              <button
                disabled={Boolean(busy) || store.kind !== "opfs" || !photoCaptureSupported || snapshot.capabilities?.immersiveAR.available !== true}
                onClick={() => void run("probing XR-assisted autofocus", openHybridCamera)}
              >
                Try XR-assisted autofocus
              </button>
            </>
          ) : null}
          {snapshot.running && !snapshot.captureId ? (
            <button
              className="primary"
              disabled={Boolean(busy) || store.kind !== "opfs"}
              onClick={() => void run("starting object capture", startCapture)}
            >
              {snapshot.lastCaptureId ? "Start another capture" : "Start capture"}
            </button>
          ) : null}
          {snapshot.captureId ? (
            <button
              className={snapshot.captureReadiness?.status === "ready" ? "primary" : "danger"}
              disabled={Boolean(busy)}
              onClick={() => void run("saving capture", () => controller.stopCapture())}
            >
              {snapshot.captureReadiness?.status === "ready" ? "Finish scan" : "Stop and review"}
            </button>
          ) : null}
          {!snapshot.captureId && snapshot.lastCaptureId ? (
            <>
              <button
                className="primary"
                disabled={Boolean(busy)}
                onClick={() => void run("exporting for Spirula", () => downloadCapture("spirula", undefined, snapshot.lastReadiness?.status))}
              >
                Export to Spirula
              </button>
              <button
                disabled={Boolean(busy)}
                onClick={() => void run("exporting for LichtFeld", () => downloadCapture("lichtfeld", undefined, snapshot.lastReadiness?.status))}
              >
                Export to LichtFeld
              </button>
              <button
                disabled={Boolean(busy)}
                onClick={() => void run("exporting canonical archive", () => downloadCapture("canonical"))}
              >
                Full archive
              </button>
            </>
          ) : null}
          {!snapshot.running && photoSnapshot.lastCaptureId ? (
            <>
              <button
                className="primary"
                disabled={Boolean(busy)}
                onClick={() => void run("exporting autofocus photos for Spirula", () => downloadCapture("spirula", photoSnapshot.lastCaptureId))}
              >
                Autofocus set to Spirula
              </button>
              <button
                disabled={Boolean(busy)}
                onClick={() => void run("exporting autofocus photos for LichtFeld", () => downloadCapture("lichtfeld", photoSnapshot.lastCaptureId))}
              >
                Autofocus set to LichtFeld
              </button>
            </>
          ) : null}
          {snapshot.running ? (
            <button
              disabled={Boolean(busy)}
              onClick={() => void run("stopping XR", () => controller.stop())}
            >
              End XR
            </button>
          ) : null}
        </div>
        {showDiagnostics ? <details className="diagnostic-controls">
          <summary>Diagnostic controls</summary>
          <div className="actions diagnostic-actions">
            <button
              disabled={Boolean(busy) || !snapshot.running || Boolean(snapshot.captureId)}
              onClick={() => void run("starting diagnostic capture", () => controller.captureFrames(20))}
            >
              Capture 20 frames
            </button>
            <button
              disabled={Boolean(busy) || Boolean(snapshot.captureId)}
              onClick={() => void run("enabling fallback camera", () => controller.enableRawCamera())}
            >
              Enable camera fallback
            </button>
          </div>
        </details> : null}
      </section>
      )}

      {busy ? (
        <p className="busy" aria-live="polite">
          {busy === "saving capture"
            ? finalizationMessage(snapshot)
            : busy}
        </p>
      ) : null}

      {!photoActive && !snapshot.captureId && snapshot.lastReadiness ? (
        <ReadinessPanel report={snapshot.lastReadiness} />
      ) : null}

      <section className="debug-section advanced-toggle">
        <div className="section-heading">
          <h2>Advanced diagnostics</h2>
          <button disabled={Boolean(busy)} onClick={() => setShowDiagnostics((visible) => !visible)}>
            {showDiagnostics ? "Hide" : "Show"}
          </button>
        </div>
        <p className="muted">Capability details, capture telemetry, matrices, and diagnostic controls.</p>
      </section>

      {showDiagnostics ? (
        <>
          <section className="debug-section">
            <div className="section-heading">
              <h2>Capabilities</h2>
              <span className="storage">storage: {store.kind}</span>
            </div>
            <CapabilityGrid report={snapshot.capabilities} />
          </section>

          <section className="debug-section">
            <h2>Live XR telemetry</h2>
            <dl className="telemetry">
          <Metric label="session" value={snapshot.running ? "running" : "stopped"} />
          <Metric label="tracking" value={snapshot.trackingState} />
          <Metric label="XR FPS" value={snapshot.xrFps} />
          <Metric label="camera FPS" value={snapshot.cameraFps} />
          <Metric label="camera resolution" value={formatResolution(snapshot.cameraResolution)} />
          <Metric label="depth resolution" value={formatResolution(snapshot.depthResolution)} />
          <Metric label="depth scale" value={formatNumber(snapshot.depthScale)} />
          <Metric
            label="target distance"
            value={snapshot.targetDistance === undefined ? "unavailable" : `${snapshot.targetDistance.toFixed(2)} m`}
          />
          <Metric label="IMU samples/sec" value={snapshot.imuSampleRate.toFixed(1)} />
          <Metric label="IMU" value={snapshot.imuStatus} />
          <Metric label="image" value={snapshot.lastImageStatus} />
          <Metric label="capture mode" value={snapshot.captureMode ?? "none"} />
          <Metric
            label="capture"
            value={snapshot.captureProgress.target
              ? `${snapshot.captureProgress.current} / ${snapshot.captureProgress.target}`
              : `${snapshot.captureProgress.current} frames`}
          />
          <Metric label="quality decision" value={snapshot.captureQuality.lastDecision} />
          <Metric label="candidates" value={snapshot.captureQuality.candidates} />
          <Metric label="rejected" value={snapshot.captureQuality.rejected} />
          <Metric label="rejected blur" value={snapshot.captureQuality.rejectedBlur} />
          <Metric label="rejected low texture" value={snapshot.captureQuality.rejectedLowTexture} />
          <Metric label="rejected motion" value={snapshot.captureQuality.rejectedMotion} />
          <Metric label="rejected redundant" value={snapshot.captureQuality.rejectedRedundant} />
          <Metric label="rejected tracking" value={snapshot.captureQuality.rejectedTracking} />
          <Metric label="rejected image" value={snapshot.captureQuality.rejectedImage} />
          <Metric label="rejected too close" value={snapshot.captureQuality.rejectedTooClose} />
          <Metric label="rejected off target" value={snapshot.captureQuality.rejectedOffTarget} />
          <Metric label="settling candidates" value={snapshot.captureQuality.rejectedSettling} />
          <Metric label="sharpness" value={formatPercent(snapshot.captureQuality.sharpnessScore)} />
          <Metric
            label="Sharp Frames shadow score"
            value={snapshot.captureQuality.sharpFramesHybridScore.toFixed(1)}
          />
          <Metric label="sharpness threshold" value={formatPercent(snapshot.captureQuality.sharpnessThreshold)} />
          <Metric label="texture" value={formatPercent(snapshot.captureQuality.textureScore)} />
          <Metric label="motion score" value={formatPercent(snapshot.captureQuality.motionScore)} />
          <Metric label="novelty score" value={formatPercent(snapshot.captureQuality.noveltyScore)} />
          <Metric label="visual graph" value={snapshot.visualTracking.state} />
          <Metric
            label="visually connected"
            value={`${snapshot.visualTracking.connectedFrameCount} / ${snapshot.visualTracking.frameCount}`}
          />
          <Metric label="visual components" value={snapshot.visualTracking.componentCount} />
          <Metric label="loop closures" value={snapshot.visualTracking.loopClosures} />
          <Metric
            label="visual processing"
            value={formatVisualProcessing(snapshot.visualTracking)}
          />
          <Metric
            label="capture worker mean"
            value={formatWorkerMean(snapshot.visualTracking)}
          />
          <Metric
            label="capture worker max"
            value={snapshot.visualTracking.processing
              ? `${snapshot.visualTracking.processing.capturePhaseMaximumFrameMilliseconds.toFixed(0)} ms`
              : "unavailable"}
          />
          <Metric
            label="deferred refinement"
            value={snapshot.visualTracking.processing
              ? `${(snapshot.visualTracking.processing.deferredRefinementMilliseconds / 1000).toFixed(1)} s`
              : "unavailable"}
          />
          <Metric
            label="retained grayscale"
            value={snapshot.visualTracking.processing
              ? `${(snapshot.visualTracking.processing.retainedGrayBytes / 1024 / 1024).toFixed(1)} MB`
              : "unavailable"}
          />
          <Metric
            label="target-region features"
            value={snapshot.visualTracking.targetRegion
              ? formatPercent(snapshot.visualTracking.targetRegion.targetRegionFeatureFraction)
              : "unavailable"}
          />
          <Metric
            label="target-region inliers"
            value={snapshot.visualTracking.targetRegion
              ? formatPercent(snapshot.visualTracking.targetRegion.targetRegionInlierFraction)
              : "unavailable"}
          />
          <Metric
            label="target-supported edges"
            value={snapshot.visualTracking.targetRegion
              ? `${snapshot.visualTracking.targetRegion.edgesWithTargetRegionInliers} / ${snapshot.visualTracking.targetRegion.acceptedEdges}`
              : "unavailable"}
          />
          <Metric
            label="global optimization gate"
            value={snapshot.visualTracking.readyForGlobalOptimization ? "graph ready" : "downstream SfM required"}
          />
          <Metric
            label="visual median residual"
            value={`${snapshot.visualTracking.medianResidualPixels.toFixed(2)} px`}
          />
          <Metric
            label="visual p90 residual"
            value={`${snapshot.visualTracking.p90ResidualPixels.toFixed(2)} px`}
          />
          <Metric
            label="estimated focal scale"
            value={snapshot.visualTracking.calibrationEstimate
              ? snapshot.visualTracking.calibrationEstimate.focalScale.toFixed(4)
              : "not estimated"}
          />
          <Metric
            label="estimated radial k1"
            value={snapshot.visualTracking.calibrationEstimate
              ? snapshot.visualTracking.calibrationEstimate.distortion.k1.toFixed(4)
              : "not estimated"}
          />
          <Metric label="visual fallback" value={snapshot.visualTracking.fallbackReason} />
          <Metric label="linear velocity" value={`${snapshot.captureQuality.linearVelocity.toFixed(3)} m/s`} />
          <Metric
            label="angular velocity"
            value={`${(snapshot.captureQuality.angularVelocity * 180 / Math.PI).toFixed(1)} deg/s`}
          />
            </dl>
            <div className="matrix-grid">
              <MatrixPanel title="Camera-to-world pose" matrix={snapshot.pose} />
              <MatrixPanel title="Projection matrix" matrix={toRows(snapshot.projectionMatrix)} />
            </div>
            <div className="intrinsics">
              <h3>Intrinsics</h3>
              <code>{snapshot.intrinsics ? JSON.stringify(snapshot.intrinsics, null, 2) : "unavailable"}</code>
            </div>
          </section>
        </>
      ) : null}

      <section className="debug-section">
        <div className="section-heading">
          <h2>Local captures</h2>
          <button disabled={Boolean(busy)} onClick={() => void run("refreshing captures", refreshCaptures)}>
            Refresh
          </button>
        </div>
        {captures.length ? (
          <ul className="capture-list">
            {captures.map((capture) => (
              <li key={capture.captureId}>
                <div>
                  <strong>{capture.captureId}</strong>
                  <span>
                    {capture.frameCount} frames · {capture.captureMode} · {capture.status} · {capture.createdAt}
                    {capture.applicationBuild ? ` · build ${formatBuildTimestamp(capture.applicationBuild.builtAt)}` : " · legacy build"}
                    {capture.captureMode === "photo-sfm"
                      ? " · unposed · downstream SfM required"
                      : capture.readiness ? ` · ${readinessLabel(capture.readiness.status)}` : " · preflight unavailable"}
                  </span>
                  {capture.status === "incomplete" ? (
                    <small>
                      Interrupted capture. Export the partial data or delete it.
                      {capture.source === "webxr" ? " Resuming is unsafe after WebXR creates a new coordinate frame." : " Autofocus photos already saved remain usable for SfM."}
                    </small>
                  ) : null}
                </div>
                <div className="capture-export-actions">
                  <button
                    disabled={Boolean(busy)}
                    onClick={() => void run("exporting canonical archive", () => downloadCapture("canonical", capture.captureId))}
                  >
                    {capture.status === "incomplete" ? "Export partial" : "Archive"}
                  </button>
                  <button
                    disabled={Boolean(busy)}
                    onClick={() => void run("exporting for Spirula", () => downloadCapture("spirula", capture.captureId, capture.readiness?.status))}
                  >
                    Spirula
                  </button>
                  <button
                    disabled={Boolean(busy)}
                    onClick={() => void run("exporting for LichtFeld", () => downloadCapture("lichtfeld", capture.captureId, capture.readiness?.status))}
                  >
                    LichtFeld
                  </button>
                  <button
                    className="danger"
                    disabled={Boolean(busy)}
                    onClick={() => void run("deleting capture", () => deleteCapture(capture))}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No persisted captures found.</p>
        )}
      </section>

      <section className="tester-panel">
        <h2>Wider-test feedback</h2>
        <p>Copy the device/build report, add the observed problem and reproduction steps, then send it with the relevant Archive ZIP through a private channel.</p>
        <div className="actions">
          <button disabled={Boolean(busy)} onClick={() => void run("copying test report", copyTesterReport)}>
            Copy test report
          </button>
        </div>
      </section>

      <footer className="app-footer">
        <p>Copyright © 2026 Open Web 3D Capture contributors. No warranty. You may redistribute this software under GPL-3.0-or-later.</p>
        <nav aria-label="Legal and source links">
          <a href="https://github.com/jckhng/openweb-3d-capture" target="_blank" rel="noreferrer">Source code</a>
          <a href="https://github.com/jckhng/openweb-3d-capture/blob/main/LICENSE" target="_blank" rel="noreferrer">License</a>
          <a href="/THIRD_PARTY_NOTICES.txt" target="_blank" rel="noreferrer">Third-party notices</a>
        </nav>
      </footer>
    </main>
  );
}

function PhotoCapturePanel({
  snapshot,
  busy,
  storageAvailable,
  onStart,
  onCapture,
  onAutomaticChange,
  hybrid,
  hybridFallbackDistance,
  onHybridFallbackDistanceChange,
  xrSnapshot,
  onFinish,
  onClose,
}: {
  snapshot: PhotoCaptureSnapshot;
  busy?: string;
  storageAvailable: boolean;
  onStart: () => void;
  onCapture: () => void;
  onAutomaticChange: (enabled: boolean) => void;
  hybrid: boolean;
  hybridFallbackDistance: number;
  onHybridFallbackDistanceChange: (meters: number) => void;
  xrSnapshot: DiagnosticSnapshot;
  onFinish: () => void;
  onClose: () => void;
}) {
  const capturing = snapshot.phase === "capturing";
  return (
    <section className="capture-panel photo-capture-panel" aria-label="Autofocus photo controls">
      <p className="local-data-status">
        LOCAL DEVICE ONLY · {hybrid ? "XR GUIDE ONLY · " : ""}UNPOSED PHOTOS · DOWNSTREAM SFM REQUIRED
      </p>
      <p className="build-id">
        Build <time dateTime={BUILD_TIMESTAMP}>{formatBuildTimestamp()}</time>
      </p>
      <div className="capture-status">
        <div><span>saved views</span><strong>{snapshot.photoCount}/{snapshot.target}</strong></div>
        <div>
          <span>{hybrid ? "XR guide" : "camera"}</span>
          <strong>{hybrid ? xrGuideLabel(xrSnapshot) : snapshot.liveQuality?.ready ? "ready" : snapshot.stage === "move" ? "moving" : snapshot.stage}</strong>
        </div>
        <div>
          <span>sharpness</span>
          <strong>{snapshot.lastQuality ? formatPercent(snapshot.lastQuality.sharpnessScore) : "—"}</strong>
        </div>
      </div>
      <p className={`capture-instruction ${snapshot.lastError ? "quality-warning" : ""}`}>
        {snapshot.instruction}
      </p>
      {!snapshot.captureId ? (
        <>
          <p className="photo-mode-note">
            {hybrid
              ? `Experimental probe: XR ${xrSnapshot.xrFps} fps · autofocus stream ${snapshot.cameraStreamState} · focus ${snapshot.focusMode}. XR drives the globe only; photographs remain unposed.`
              : "Up to three full-resolution photos are taken per stop; only the sharpest is retained. Coverage prompts are count-based because this mode intentionally records no camera pose."}
          </p>
          {hybrid && xrSnapshot.targetDistance === undefined ? (
            <label className="hybrid-distance">
              Object-centre distance
              <select
                value={hybridFallbackDistance}
                onChange={(event) => onHybridFallbackDistanceChange(Number(event.currentTarget.value))}
              >
                <option value={0.2}>20 cm</option>
                <option value={0.3}>30 cm</option>
                <option value={0.45}>45 cm</option>
                <option value={0.6}>60 cm</option>
              </select>
              <small>XR depth unavailable; estimate camera-to-centre distance before starting.</small>
            </label>
          ) : hybrid ? (
            <p className="hybrid-depth">XR centre depth: {Math.round(xrSnapshot.targetDistance! * 100)} cm</p>
          ) : null}
        </>
      ) : hybrid ? (
        <p className="photo-mode-note">
          XR {xrSnapshot.xrFps} fps · tracking {xrSnapshot.trackingState} · autofocus stream {snapshot.cameraStreamState} · focus {snapshot.focusMode}
        </p>
      ) : null}
      <div className="actions">
        {!snapshot.captureId ? (
          <button className="primary" disabled={Boolean(busy) || !storageAvailable} onClick={onStart}>
            Start photo scan
          </button>
        ) : (
          <>
            <button className="primary photo-shutter" disabled={Boolean(busy) || capturing} onClick={onCapture}>
              {capturing ? "Capturing…" : "Arm this viewpoint"}
            </button>
            <button
              className={snapshot.automaticCapture ? "automatic-enabled" : undefined}
              disabled={Boolean(busy) || capturing}
              aria-pressed={snapshot.automaticCapture}
              onClick={() => onAutomaticChange(!snapshot.automaticCapture)}
            >
              Auto capture: {snapshot.automaticCapture ? "on" : "off"}
            </button>
            <button disabled={Boolean(busy) || capturing} onClick={onFinish}>
              Finish photo set
            </button>
          </>
        )}
        <button disabled={Boolean(busy) || capturing} onClick={onClose}>
          {snapshot.captureId ? "Save partial and close" : "Close camera"}
        </button>
      </div>
    </section>
  );
}

function photoStageLabel(snapshot: PhotoCaptureSnapshot): string {
  if (snapshot.stage === "burst") return `${snapshot.burstFrame}/3`;
  if (snapshot.stage === "saved") return "SAVED";
  if (snapshot.stage === "rejected") return "RETRY";
  if (snapshot.stage === "ready") return "READY";
  if (snapshot.stage === "focusing") return "FOCUS";
  if (snapshot.stage === "settling") return "HOLD";
  if (snapshot.stage === "selecting" || snapshot.stage === "overlap" || snapshot.stage === "saving") return "CHECK";
  return snapshot.captureId ? "MOVE" : "CENTER";
}

function makePhotoGuidance(snapshot: DiagnosticSnapshot): PhotoCaptureGuidance | undefined {
  const target = snapshot.guidanceTarget?.worldPoint;
  if (!target || !snapshot.pose) return undefined;
  const location = locateCoverageCell(snapshot.pose, target);
  if (!location) return undefined;
  return {
    source: "webxr",
    poseSynchronized: false,
    azimuthBin: location.azimuthBin,
    latitude: location.latitude,
    elevation: location.elevation,
    centered: snapshot.guidanceFraming?.centered ?? false,
    trackingState: snapshot.trackingState,
  };
}

function xrGuideLabel(snapshot: DiagnosticSnapshot): string {
  if (!snapshot.running) return "ended";
  if (!snapshot.guidanceTarget) return snapshot.trackingState === "tracked" ? "ready" : snapshot.trackingState;
  if (snapshot.guidanceFraming && !snapshot.guidanceFraming.centered) return "off target";
  return snapshot.trackingState;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function CapabilityGrid({ report }: { report?: CapabilityReport }) {
  if (!report) return <p className="muted">Probing browser APIs.</p>;
  return (
    <dl className="capabilities">
      {Object.entries(report).map(([name, value]) => (
        <div key={name}>
          <dt>{humanize(name)}</dt>
          <dd>
            <span className={value.available ? "available" : "unavailable"}>
              {value.available ? "available" : "unavailable"}
            </span>
            <small>{value.detail}</small>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function ReadinessPanel({ report }: { report: CaptureReadinessReport }) {
  return (
    <section className={`readiness-panel readiness-${report.status}`} aria-labelledby="readiness-title">
      <div className="section-heading">
        <h2 id="readiness-title">Capture readiness</h2>
        <strong>{readinessLabel(report.status)}</strong>
      </div>
      <p>{report.primaryAction}</p>
      <dl className="readiness-metrics">
        <Metric label="images" value={report.metrics.imageFrames} />
        <Metric
          label="orbit sectors"
          value={`${report.metrics.azimuthBinsCovered} / ${report.metrics.azimuthBinCount}`}
        />
        <Metric
          label="elevation span"
          value={`${report.metrics.elevationSpanDegrees.toFixed(1)}°`}
        />
        <Metric
          label="visual graph"
          value={`${report.metrics.visualConnectedFrames} / ${report.metrics.imageFrames}`}
        />
      </dl>
      {report.issues.length ? (
        <ul className="readiness-issues">
          {report.issues.map((issue) => <li key={issue.code}>{issue.message}</li>)}
        </ul>
      ) : null}
    </section>
  );
}

function readinessLabel(status: CaptureReadinessReport["status"]): string {
  if (status === "ready") return "READY FOR SFM";
  if (status === "add-views") return "ADD VIEWS";
  return "CAPTURE RISK";
}

function MatrixPanel({ title, matrix }: { title: string; matrix?: Matrix4 }) {
  return (
    <div className="matrix">
      <h3>{title}</h3>
      <code>
        {matrix
          ? matrix.map((row) => row.map((value) => value.toFixed(4)).join("  ")).join("\n")
          : "unavailable"}
      </code>
    </div>
  );
}

function toRows(values?: number[]): Matrix4 | undefined {
  if (!values || values.length !== 16) return undefined;
  return Array.from({ length: 4 }, (_, row) => values.slice(row * 4, row * 4 + 4));
}

function formatResolution(value?: { width: number; height: number }) {
  return value ? `${value.width} × ${value.height}` : "unavailable";
}

function formatBytes(value?: number): string {
  if (value === undefined) return "unknown";
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(value / 1024 ** 2)} MB`;
}

function storageWarning(kind: string, status: BrowserStorageStatus) {
  if (kind !== "opfs") {
    return <p className="storage-warning">Persistent OPFS storage is unavailable. Capture is disabled to prevent data loss.</p>;
  }
  if (status.available !== undefined && status.available < MINIMUM_FREE_STORAGE_BYTES) {
    return (
      <p className="storage-warning">
        Less than {formatBytes(MINIMUM_FREE_STORAGE_BYTES)} is free. Export and delete old captures before starting.
      </p>
    );
  }
  if (status.persisted === false) {
    return <p className="storage-warning">Browser storage is best effort. The app will request protection when capture starts.</p>;
  }
  return null;
}

function testReport(
  snapshot: DiagnosticSnapshot,
  photoSnapshot: PhotoCaptureSnapshot,
  storageKind: string,
  storage: BrowserStorageStatus,
  wakeLockState: string,
): string {
  const lines = [
    "Open Web 3D Capture wider-test report",
    `Build: ${formatBuildTimestamp()}`,
    `URL: ${window.location.href}`,
    `User agent: ${navigator.userAgent}`,
    `WebXR immersive AR: ${snapshot.capabilities?.immersiveAR.available ? "available" : "unavailable"}`,
    `XR tracking: ${snapshot.trackingState}; ${snapshot.xrFps} fps`,
    `Autofocus stream: ${photoSnapshot.cameraStreamState}; focus ${photoSnapshot.focusMode}`,
    `Autofocus guidance: ${photoSnapshot.guidanceMode}; ${photoSnapshot.photoCount} saved; ${photoSnapshot.rejectedCount} rejected`,
    `Storage: ${storageKind}; ${formatBytes(storage.available)} free; protection ${storage.persisted === undefined ? "unknown" : storage.persisted ? "persistent" : "best effort"}`,
    `Screen wake lock: ${wakeLockState}`,
    `Capture ID: ${photoSnapshot.lastCaptureId ?? photoSnapshot.captureId ?? snapshot.lastCaptureId ?? snapshot.captureId ?? "none"}`,
    `Readiness: ${snapshot.lastReadiness ? readinessLabel(snapshot.lastReadiness.status) : "unavailable"}`,
    "",
    "Observed problem:",
    "",
    "Steps to reproduce:",
    "",
    "Expected:",
    "",
    "Actual:",
    "",
    "Spirula/LichtFeld result:",
  ];
  return lines.join("\n");
}

function formatNumber(value?: number) {
  return value === undefined ? "unavailable" : value.toPrecision(6);
}

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function formatWorkerMean(report: DiagnosticSnapshot["visualTracking"]) {
  const processing = report.processing;
  if (!processing || processing.capturePhaseFrames === 0) return "unavailable";
  return `${(processing.capturePhaseTotalMilliseconds / processing.capturePhaseFrames).toFixed(0)} ms`;
}

function formatVisualProcessing(report: DiagnosticSnapshot["visualTracking"]) {
  const processing = report.processing;
  if (!processing?.phase) return "unavailable";
  if (processing.phase !== "deferred") return processing.phase;
  const attempts = processing.deferredRepairAttempts ?? 0;
  const maximum = processing.deferredMaximumRepairAttempts;
  return maximum === undefined ? "deferred" : `deferred repair ${attempts} / ${maximum}`;
}

function finalizationMessage(snapshot: DiagnosticSnapshot): string {
  if (snapshot.captureFinalization === "saving") {
    return "Saving capture locally — keep this screen open.";
  }
  if (snapshot.captureFinalization === "refining") {
    return `Capture saved locally — finishing analysis. Leaving now preserves the photos but may skip final checks. ${formatVisualProcessing(snapshot.visualTracking)}`;
  }
  if (snapshot.captureFinalization === "saved") {
    return "Capture saved locally.";
  }
  return "Finishing capture.";
}

function qualityClass(reason: DiagnosticSnapshot["captureQuality"]["lastDecision"]) {
  if (reason === "accepted" || reason === "checkpoint-burst") return "quality-good";
  if (reason === "waiting") return "";
  return "quality-warning";
}

function captureInstruction(snapshot: DiagnosticSnapshot) {
  if (!snapshot.running) {
    return snapshot.lastReadiness
      ? `${readinessLabel(snapshot.lastReadiness.status)} — ${snapshot.lastReadiness.primaryAction}`
      : "Choose guided WebXR for medium objects or autofocus photos for close subjects.";
  }
  if (!snapshot.captureId) {
    if (snapshot.lastReadiness) {
      return `${readinessLabel(snapshot.lastReadiness.status)} — ${snapshot.lastReadiness.primaryAction}`;
    }
    if (
      snapshot.targetDistance !== undefined &&
      snapshot.targetDistance < DEFAULT_QUALITY_SELECTOR_CONFIG.minimumTargetDistance
    ) return "MOVE FARTHER — fixed-focus WebXR is unreliable at this distance.";
    return `XR is ready. Center the object at least ${MINIMUM_TARGET_DISTANCE_CM} cm away, then start capture.`;
  }
  if (snapshot.targetFraming && !snapshot.targetFraming.centered) {
    return `${targetDirection(snapshot.targetFraming.ndc)} — RE-CENTER OBJECT; capture is paused.`;
  }
  switch (snapshot.captureQuality.lastDecision) {
    case "accepted":
    case "checkpoint-burst":
      return checkpointInstruction(snapshot.captureReadiness);
    case "blur":
      return "HOLD STEADY OR MOVE FARTHER — the target is not sharp enough.";
    case "low-texture":
      return "AIM AT MORE DETAIL — keep the object centered with visible edges or texture.";
    case "too-close":
      return `MOVE FARTHER — fixed-focus WebXR is unreliable below ${MINIMUM_TARGET_DISTANCE_CM} cm.`;
    case "off-target":
      return "RE-CENTER OBJECT — capture is paused.";
    case "settling":
      return "HOLD STEADY — locking this viewpoint.";
    case "viewpoint-too-close":
      return "VIEWPOINT SAVED — take a wider sideways step within this sector, then stop.";
    case "motion":
      return "MOVE TO THE NEXT SECTOR, THEN STOP — sharp frames are captured while stationary.";
    case "redundant":
      return currentCheckpointCaptured(snapshot.captureReadiness)
        ? "SECTOR CAPTURED — move to the highlighted unlit sector."
        : "VIEWPOINT SAVED — take a small sideways step within this sector, then stop again.";
    case "sector-full":
      return "SECTOR FULL — move to the highlighted sector.";
    case "tracking":
      return "TRACKING LOST — aim at a detailed, well-lit area.";
    case "image-unavailable":
    case "unsynchronized-image":
      return "XR CAMERA UNAVAILABLE — synchronized frames are required.";
    default:
      return "Hold steady while the first frame is evaluated.";
  }
}

function targetDirection([x, y]: [number, number]): string {
  const horizontal = x > 0.18 ? "RIGHT" : x < -0.18 ? "LEFT" : "";
  const vertical = y > 0.18 ? "UP" : y < -0.18 ? "DOWN" : "";
  return `AIM ${[vertical, horizontal].filter(Boolean).join(" ") || "AT CENTER"}`;
}

function checkpointInstruction(report?: CaptureReadinessReport): string {
  const cell = currentCoverageCell(report);
  if (!cell) return liveReadinessInstruction(report);
  if (cell.state === "captured") {
    return "SECTOR CAPTURED — move to the highlighted unlit sector.";
  }
  if (cell.selectedFrameIds.length === 1) {
    return "VIEWPOINT 1 / 2 — take a small sideways step within this sector, then stop.";
  }
  return "HOLD STEADY — capturing viewpoint 1 / 2.";
}

function currentCheckpointCaptured(report?: CaptureReadinessReport): boolean {
  return currentCoverageCell(report)?.state === "captured";
}

function currentCoverageCell(report?: CaptureReadinessReport) {
  const current = report?.metrics.currentCoverageCell;
  if (!current) return undefined;
  return report.metrics.coverageCells?.find(
    (cell) => cell.azimuthBin === current.azimuthBin && cell.latitude === current.latitude,
  );
}

function liveReadinessInstruction(report?: CaptureReadinessReport): string {
  if (!report) return "GOOD — continue around the object.";
  const frames = report.metrics.imageFrames;
  if (frames < 12) return "GOOD — continue a level orbit around the object.";
  const overlap = report.issues.find(
    (issue) => issue.code === "visual-disconnected" || issue.code === "weak-bridge",
  );
  if (overlap) return overlap.action;
  const azimuth = report.issues.find((issue) => issue.code === "missing-azimuth");
  if (frames >= 24 && azimuth) return azimuth.action;
  const elevation = report.issues.find((issue) => issue.code === "missing-elevation");
  if (frames >= 36 && elevation) return elevation.action;
  if (frames < 50) return `GOOD — add ${50 - frames} more distinct views.`;
  const loop = report.issues.find((issue) => issue.code === "loop-not-closed");
  if (loop) return loop.action;
  return report.primaryAction;
}

function humanize(value: string) {
  return value.replace(/([A-Z])/g, " $1").replace(/^./, (first) => first.toUpperCase());
}
