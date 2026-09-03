import { useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_QUALITY_SELECTOR_CONFIG } from "../keyframes/quality-selector";
import type { DiagnosticSnapshot } from "../xr/diagnostic-controller";
import { XRDiagnosticController } from "../xr/diagnostic-controller";
import { probeCapabilities } from "../xr/capabilities";
import type { CapabilityReport, CaptureMetadata, CaptureReadinessStatus, Matrix4 } from "../shared/types";
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
  const [snapshot, setSnapshot] = useState<DiagnosticSnapshot>(() => controller.getSnapshot());
  const [captures, setCaptures] = useState<CaptureMetadata[]>([]);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [storageStatus, setStorageStatus] = useState<BrowserStorageStatus>({});
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const previousCheckpointCount = useRef(0);
  const previousOffTarget = useRef(false);
  const wakeLockState = useScreenWakeLock(snapshot.running || Boolean(snapshot.captureFinalization));

  const refreshCaptures = async () => {
    const [nextCaptures, nextStorage] = await Promise.all([
      store.listCaptures(),
      inspectBrowserStorage(),
    ]);
    setCaptures(nextCaptures);
    setStorageStatus(nextStorage);
  };

  useEffect(() => controller.subscribe(setSnapshot), [controller]);

  useEffect(() => {
    void run("capability probe", async () => {
      const report = await probeCapabilities();
      controller.setCapabilities(report);
      await refreshCaptures();
    });
    return () => {
      void controller.dispose();
    };
    // Controller and store are stable for this component lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller]);

  useEffect(() => {
    if (snapshot.lastCaptureId) void refreshCaptures().catch(showError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.lastCaptureId]);

  useEffect(() => {
    document.documentElement.classList.toggle("xr-active-root", snapshot.running);
    return () => document.documentElement.classList.remove("xr-active-root");
  }, [snapshot.running]);

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
    await controller.startBasicCapture();
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
    await navigator.clipboard.writeText(testReport(snapshot, store.kind, storageStatus, wakeLockState));
    setNotice("Test report copied. Add what happened and attach the relevant ZIP privately.");
  }

  return (
    <main className={snapshot.running ? "xr-active" : undefined}>
      <header>
        <p className="eyebrow">Capture preflight</p>
        <h1>Open Web 3D Capture</h1>
        <p className="header-build-id">
          Build <time dateTime={BUILD_TIMESTAMP}>{formatBuildTimestamp()}</time>
        </p>
        <p className="lede">Open the camera, center the object, then start capture when you are ready.</p>
      </header>

      {error || snapshot.lastError ? (
        <div className="error" role="alert">{error ?? snapshot.lastError}</div>
      ) : null}
      {notice ? <div className="notice" role="status">{notice}</div> : null}

      {!snapshot.running ? (
        <section className="onboarding" aria-labelledby="before-capture-title">
          <div className="section-heading">
            <h2 id="before-capture-title">Before capturing</h2>
            <strong className={snapshot.capabilities?.immersiveAR.available ? "available" : "unavailable"}>
              {snapshot.capabilities?.immersiveAR.available ? "Android WebXR ready" : "Android WebXR required"}
            </strong>
          </div>
          <ol className="capture-steps">
            <li>Use Android Chrome on an ARCore-capable phone.</li>
            <li>Choose a static, medium-sized object in bright, even light. Stay at least {MINIMUM_TARGET_DISTANCE_CM} cm away.</li>
            <li>Open the camera, center the object, then explicitly start capture.</li>
            <li>Move to the highlighted cell, stop, and wait for the orange confirmation before moving again.</li>
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
          </dl>
          {storageWarning(store.kind, storageStatus)}
        </section>
      ) : null}

      {snapshot.running ? (
        <div className={`reticle ${snapshot.targetFraming && !snapshot.targetFraming.centered ? "quality-off-target" : qualityClass(snapshot.captureQuality.lastDecision)}`} aria-hidden="true" />
      ) : null}

      {snapshot.captureId && snapshot.targetFraming && !snapshot.targetFraming.centered ? (
        <div className="target-warning" role="status">
          {targetDirection(snapshot.targetFraming.ndc)} — RE-CENTER OBJECT
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

      <section className="capture-panel" aria-label="Capture controls">
        <p className="local-data-status">LOCAL DEVICE ONLY · NO CAPTURE UPLOADS</p>
        <p className="build-id">
          Build <time dateTime={BUILD_TIMESTAMP}>{formatBuildTimestamp()}</time>
        </p>
        <div className="capture-status">
          <div>
            <span>{snapshot.captureId ? "views" : "scan"}</span>
            <strong>{snapshot.captureId ? snapshot.captureProgress.current : "ready"}</strong>
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
            <button
              className="primary"
              disabled={Boolean(busy) || snapshot.capabilities?.immersiveAR.available !== true}
              onClick={() => void run("opening XR camera", () => controller.start())}
            >
              Open camera
            </button>
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

      {busy ? (
        <p className="busy" aria-live="polite">
          {busy === "saving capture"
            ? finalizationMessage(snapshot)
            : busy}
        </p>
      ) : null}

      {!snapshot.captureId && snapshot.lastReadiness ? (
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
                    {capture.readiness ? ` · ${readinessLabel(capture.readiness.status)}` : " · preflight unavailable"}
                  </span>
                  {capture.status === "incomplete" ? (
                    <small>Interrupted capture. Export the partial data or delete it; resuming is unsafe after WebXR creates a new coordinate frame.</small>
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
        <a href="/THIRD_PARTY_NOTICES.txt" target="_blank" rel="noreferrer">Third-party notices</a>
      </footer>
    </main>
  );
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
    `Storage: ${storageKind}; ${formatBytes(storage.available)} free; protection ${storage.persisted === undefined ? "unknown" : storage.persisted ? "persistent" : "best effort"}`,
    `Screen wake lock: ${wakeLockState}`,
    `Capture ID: ${snapshot.lastCaptureId ?? snapshot.captureId ?? "none"}`,
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
      : "Center a well-lit object, stand at least 45 cm away, and start the guided scan.";
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
