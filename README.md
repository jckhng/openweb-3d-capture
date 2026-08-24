# Open Web 3D Capture

Current scope: Milestone 1, an Android Chrome WebXR basic recorder. It captures synchronized images, poses, CPU depth, and capture-window IMU data directly to OPFS at a maximum of four frames per second. Quality scoring and guidance are not implemented.

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

M1 test sequence:

1. Confirm `immersive-ar`, OPFS, and the relevant sensor capabilities.
2. Select **Start XR** and grant requested permissions.
3. Confirm pose, projection matrix, intrinsics, and frame rate change live.
4. Center a static object and select **Start capture**.
5. Move slowly around it, including low, level, and elevated viewpoints.
6. Select **Stop and save** after 50–100 accepted frames.
7. Select **Export latest**.
8. Inspect `capture.json`, `transforms.json`, `telemetry/frames.jsonl`, images, optional depth, and IMU samples.
9. Load the dataset into Brush or another Nerfstudio-compatible reconstruction path.

The production build registers a network-first service worker with offline fallback. The Vite development build does not register it.

## Current limitations

- Raw WebXR camera access is an incubating, optional API. Constructor detection does not prove that a session will grant `camera-access`; the decisive signal is a non-null `view.camera` during an XR animation frame.
- **Enable camera fallback** uses `getUserMedia()`. Those images are not WebXR pose-synchronized. Exported frame telemetry marks them with `imageSource: "media-stream"` and `imageSynchronized: false`; they cannot satisfy the reconstruction viability gate.
- Depth capture currently requests CPU-accessible depth only. GPU-only depth implementations are reported by the probe but are not recorded.
- M0 passed on the target phone with synchronized 886×1920 XR camera JPEGs, 160×90 CPU depth, tracked poses, IMU data, and OPFS reload recovery.
- M1 is not accepted until a 50–100-frame dataset produces a recognizable reconstruction and confirms the exported pose convention.

See [plans/plan.md](plans/plan.md) for project sequencing and [docs/m0-compatibility.md](docs/m0-compatibility.md) for API behavior.
