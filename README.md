# Open Web 3D Capture

Current scope: Milestone 2, an Android Chrome WebXR quality recorder. It evaluates up to four synchronized candidates per second, rejects blur, excessive motion, bad tracking, unsynchronized images, and redundant poses, then writes accepted images, poses, CPU depth, and capture-window IMU data directly to OPFS.

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

M2 test sequence:

1. Confirm `immersive-ar`, OPFS, and the relevant sensor capabilities.
2. Select **Start XR** and grant requested permissions.
3. Confirm pose, projection matrix, intrinsics, and frame rate change live.
4. Center a static, textured object and select **Start capture**.
5. Confirm the reticle and instruction react to sharpness, motion, tracking, and redundant views.
6. Move slowly around the object, including low, level, and elevated viewpoints.
7. Select **Stop and save** after 50–100 accepted frames.
8. Select **Export latest**.
9. Inspect `capture.json`, `transforms.json`, `telemetry/frames.jsonl`, `debug/session.jsonl`, images, optional depth, and IMU samples.
10. Load the dataset into Brush or another Nerfstudio-compatible reconstruction path.

Exports with synchronized CPU depth now include a voxel-downsampled `pointcloud.ply` and reference it through `ply_file_path` in `transforms.json`. This supplies the initial point cloud required by Spirula Studio.

## Add a seed point cloud to an existing capture

The desktop converter requires ImageMagick's `convert` command. Run it against an extracted capture directory:

```bash
npm run pointcloud -- /path/to/capture-directory
```

It creates `pointcloud.ply` and atomically adds `"ply_file_path": "pointcloud.ply"` to `transforms.json`. It refuses to overwrite an existing point cloud unless explicitly requested:

```bash
npm run pointcloud -- /path/to/capture-directory --force
```

The production build registers a network-first service worker with offline fallback. The Vite development build does not register it.

## Current limitations

- Raw WebXR camera access is an incubating, optional API. Constructor detection does not prove that a session will grant `camera-access`; the decisive signal is a non-null `view.camera` during an XR animation frame.
- **Enable camera fallback** uses `getUserMedia()`. Those images are not WebXR pose-synchronized. Exported frame telemetry marks them with `imageSource: "media-stream"` and `imageSynchronized: false`; they cannot satisfy the reconstruction viability gate.
- Depth capture currently requests CPU-accessible depth only. GPU-only depth implementations are reported by the probe but are not recorded.
- M0 passed on the target phone with synchronized 886×1920 XR camera JPEGs, 160×90 CPU depth, tracked poses, IMU data, and OPFS reload recovery.
- M1 passed with a 90-frame chair capture that produced a recognizable, upright reconstruction in Brush. Floaters remain because M1 had no quality selection or seed point cloud.
- M2 quality thresholds are initial values derived from the accepted chair trajectory. They require calibration on the target phone before M2 is accepted.
- The first M2 seesaw capture accepted 105 of 118 candidates. Its recorded sharpness score saturated and rejected no frames for blur, so blur normalization still requires correction.
- A depth-derived seed point cloud is generated during ZIP export. Spirula interoperability still requires a direct import test of the new export.

See [plans/plan.md](plans/plan.md) for project sequencing and [docs/m0-compatibility.md](docs/m0-compatibility.md) for API behavior.
