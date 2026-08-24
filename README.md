# Open Web 3D Capture

Current scope: Milestone 0, an Android Chrome WebXR capability and dataset diagnostic. Reconstruction and capture guidance are intentionally not implemented.

## Run locally

Requirements: Node.js 18 or newer and npm.

```bash
npm install
npm test
npm run build
npm run dev
```

Open `http://localhost:5173`. Desktop browsers can exercise the UI, capability probe, serialization, and memory/OPFS code. Immersive AR requires a compatible Android device.

## Run on an Android phone

WebXR, camera access, motion sensors, OPFS, and service workers require a secure context. A LAN URL served over plain HTTP is not a valid phone test.

Use either a deployment with a valid HTTPS certificate or Android Debug Bridge port reversal:

```bash
npm run dev -- --host 127.0.0.1
adb reverse tcp:5173 tcp:5173
```

Then open `http://localhost:5173` in Chrome on the USB-connected phone. `localhost` is treated as a potentially trustworthy origin. Re-run `adb reverse` after reconnecting the device.

Test sequence:

1. Confirm `immersive-ar`, OPFS, and the relevant sensor capabilities.
2. Select **Start XR** and grant requested permissions.
3. Confirm pose, projection matrix, intrinsics, and frame rate change live.
4. Select **Capture 20 frames** and move the phone around a static object.
5. Export the resulting ZIP.
6. Inspect `capture.json`, `transforms.json`, `telemetry/frames.jsonl`, images, optional depth, and IMU samples.

The production build registers the service worker. The Vite development build does not, which prevents stale development assets.

## Current limitations

- Raw WebXR camera access is an incubating, optional API. Constructor detection does not prove that a session will grant `camera-access`; the decisive signal is a non-null `view.camera` during an XR animation frame.
- **Enable camera fallback** uses `getUserMedia()`. Those images are not WebXR pose-synchronized. Exported frame telemetry marks them with `imageSource: "media-stream"` and `imageSynchronized: false`; they cannot satisfy the reconstruction viability gate.
- Depth capture currently requests CPU-accessible depth only. GPU-only depth implementations are reported by the probe but are not recorded.
- M0 is not accepted until a real phone export contains usable, correctly oriented XR camera JPEGs with changing poses and valid intrinsics.
- The directory contains an empty `.git` placeholder, not a usable Git repository. Git history and diffs are unavailable until the workspace is initialized or restored from its source repository.

See [plans/plan.md](plans/plan.md) for project sequencing and [docs/m0-compatibility.md](docs/m0-compatibility.md) for API behavior.
