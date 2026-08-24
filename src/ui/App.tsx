import { useEffect, useMemo, useState } from "react";
import type { DiagnosticSnapshot } from "../xr/diagnostic-controller";
import { XRDiagnosticController } from "../xr/diagnostic-controller";
import { probeCapabilities } from "../xr/capabilities";
import type { CapabilityReport, CaptureMetadata, Matrix4 } from "../shared/types";
import { MemoryCaptureStore } from "../storage/memory";
import { OPFSCaptureStore } from "../storage/opfs";
import { isOpfsSupported } from "../storage/storage";

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

  const refreshCaptures = async () => setCaptures(await store.listCaptures());

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

  async function run(label: string, action: () => Promise<void>) {
    setBusy(label);
    setError(undefined);
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

  async function downloadCapture(captureId?: string) {
    const exported = captureId
      ? await controller.exportCapture(captureId)
      : await controller.exportLastCapture();
    const url = URL.createObjectURL(exported.blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = exported.filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  return (
    <main>
      <header>
        <p className="eyebrow">M1 basic recorder</p>
        <h1>Open Web 3D Capture</h1>
        <p className="lede">Record a durable, reconstruction-ready WebXR image and pose sequence.</p>
      </header>

      {error || snapshot.lastError ? (
        <div className="error" role="alert">{error ?? snapshot.lastError}</div>
      ) : null}

      <section className="capture-panel" aria-label="Capture controls">
        <div className="capture-status">
          <div>
            <span>accepted frames</span>
            <strong>{snapshot.captureProgress.current}</strong>
          </div>
          <div>
            <span>capture state</span>
            <strong>{snapshot.captureId ? "recording" : "idle"}</strong>
          </div>
          <div>
            <span>minimum target</span>
            <strong className={snapshot.captureProgress.current >= 50 ? "available" : undefined}>50</strong>
          </div>
        </div>
        <p className="capture-instruction">
          {snapshot.captureId
            ? "Move slowly around the object. Include low, level, and elevated views. Stop after 50–100 frames."
            : snapshot.running
              ? "XR is ready. Center the object, then start the basic capture."
              : "Start XR on the Android phone before recording."}
        </p>
        <div className="actions">
          <button
            disabled={Boolean(busy) || snapshot.running}
            onClick={() => void run("starting XR", () => controller.start())}
          >
            Start XR
          </button>
          <button
            className="primary"
            disabled={Boolean(busy) || !snapshot.running || Boolean(snapshot.captureId)}
            onClick={() => void run("starting object capture", () => controller.startBasicCapture())}
          >
            Start capture
          </button>
          <button
            className="danger"
            disabled={Boolean(busy) || !snapshot.captureId}
            onClick={() => void run("saving capture", () => controller.stopCapture())}
          >
            Stop and save
          </button>
          <button
            disabled={Boolean(busy) || Boolean(snapshot.captureId) || !snapshot.lastCaptureId}
            onClick={() => void run("exporting ZIP", () => downloadCapture())}
          >
            Export latest
          </button>
        </div>
        <details>
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
            <button
              disabled={Boolean(busy) || !snapshot.running}
              onClick={() => void run("stopping XR", () => controller.stop())}
            >
              End XR session
            </button>
          </div>
        </details>
      </section>

      {busy ? <p className="busy" aria-live="polite">{busy}</p> : null}

      <section>
        <div className="section-heading">
          <h2>Capabilities</h2>
          <span className="storage">storage: {store.kind}</span>
        </div>
        <CapabilityGrid report={snapshot.capabilities} />
      </section>

      <section>
        <h2>Live XR telemetry</h2>
        <dl className="telemetry">
          <Metric label="session" value={snapshot.running ? "running" : "stopped"} />
          <Metric label="tracking" value={snapshot.trackingState} />
          <Metric label="XR FPS" value={snapshot.xrFps} />
          <Metric label="camera FPS" value={snapshot.cameraFps} />
          <Metric label="camera resolution" value={formatResolution(snapshot.cameraResolution)} />
          <Metric label="depth resolution" value={formatResolution(snapshot.depthResolution)} />
          <Metric label="depth scale" value={formatNumber(snapshot.depthScale)} />
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

      <section>
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
                  <span>{capture.frameCount} frames · {capture.captureMode} · {capture.status} · {capture.createdAt}</span>
                </div>
                <button
                  disabled={Boolean(busy)}
                  onClick={() => void run("exporting ZIP", () => downloadCapture(capture.captureId))}
                >
                  Export
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No persisted captures found.</p>
        )}
      </section>
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

function formatNumber(value?: number) {
  return value === undefined ? "unavailable" : value.toPrecision(6);
}

function humanize(value: string) {
  return value.replace(/([A-Z])/g, " $1").replace(/^./, (first) => first.toUpperCase());
}
