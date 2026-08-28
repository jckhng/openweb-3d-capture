# Open Web 3D Capture

Current scope: Milestone 2 calibration and the reconstruction-readiness bridge to Milestone 3. The Android Chrome WebXR recorder evaluates up to four synchronized candidates per second, rejects blur, excessive motion, close-range fixed-focus failures, bad tracking, unsynchronized images, and redundant poses, then writes accepted images, poses, CPU depth, and capture-window IMU data directly to OPFS.

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
4. Center a static, textured object at least 45 cm from the phone. Confirm the live target-distance value is plausible, then select **Start capture**.
5. Confirm the reticle and instruction react to close range, sharpness, motion, tracking, and redundant views.
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

## Prepare a refined desktop dataset

The refinement tools use an isolated Python environment. The system COLMAP installation is not changed.

```bash
python3 -m venv .venv-refinement
.venv-refinement/bin/pip install -r tools/requirements-refinement.txt
.venv-refinement/bin/python tools/prepare-refinement-benchmark.py \
  /path/to/capture \
  /path/to/colmap/sparse/0 \
  /path/to/refined-output \
  --copy-assets
```

The output contains:

- `transforms.json`: readiness-selected standard export.
- `transforms_webxr.json`: original metric WebXR poses.
- `transforms_refined.json`: visually refined poses and OPENCV distortion.
- `refinement.json`: registration, residual, calibration, and readiness result.
- `colmap/images` and `colmap/sparse/0`: portable COLMAP workspace for LichtFeld.
- `pointcloud.ply`: metric seed cloud for Spirula when the source capture contains depth.

Run the worker-safe low-resolution feature prototype against the derived dataset:

```bash
npm run benchmark:features -- /path/to/refined-output \
  --output /path/to/refined-output/feature-tracking.json
```

The production build registers a network-first service worker with offline fallback. The Vite development build does not register it.

## Current limitations

- Raw WebXR camera access is an incubating, optional API. Constructor detection does not prove that a session will grant `camera-access`; the decisive signal is a non-null `view.camera` during an XR animation frame.
- **Enable camera fallback** uses `getUserMedia()`. Those images are not WebXR pose-synchronized. Exported frame telemetry marks them with `imageSource: "media-stream"` and `imageSynchronized: false`; they cannot satisfy the reconstruction viability gate.
- Depth capture currently requests CPU-accessible depth only. GPU-only depth implementations are reported by the probe but are not recorded.
- M0 passed on the target phone with synchronized 886×1920 XR camera JPEGs, 160×90 CPU depth, tracked poses, IMU data, and OPFS reload recovery.
- M1 passed with a 90-frame chair capture that produced a recognizable, upright reconstruction in Brush. Floaters remain because M1 had no quality selection or seed point cloud.
- M2 selection is implemented but requires one more target-phone capture before acceptance. The first M2 seesaw capture accepted 105 of 118 candidates and exposed saturated blur scores plus overly permissive motion limits.
- Blur normalization and motion limits have been recalibrated from that telemetry. Replay predicts 5.9% blur rejection and 33.1% motion rejection; these predictions require a live capture test.
- ARCore commonly uses fixed focus for tracking, and WebXR exposes no autofocus, lens-selection, or manual-focus control. The recorder therefore reports center depth and rejects targets closer than a provisional 45 cm focus floor. This cannot restore detail that was optically blurred.
- Web v1 should be treated as a medium-object capture path until the 45 cm floor and minimum usable object size are measured on the target phone. Reliable close-range small-object capture likely requires a native Android path with camera focus control.
- WebXR poses are retained as metric priors, not assumed to be reconstruction-grade final poses. Independent COLMAP refinement registers all 105 seesaw frames and all 145 frames of the second phone capture, while correcting poses, focal length, and lens distortion.
- Dual-pose serialization and an incremental low-resolution TypeScript feature/reprojection pipeline are implemented. It uses compact BRIEF for adjacent frames and a multi-scale oriented-gradient descriptor for recovery and long-range edges.
- The tracker runs in a dedicated browser worker on accepted synchronized frames and persists `refinement/tracking.json`. Pose-independent RANSAC verification, inlier-only scoring, and bounded component repair connect 105/105 seesaw frames, 145/145 second-capture frames, and 113/113 latest validation frames in replay.
- Multi-scale tracking caused severe phone CPU contention in a low-light test: candidate cadence fell from 0.27 seconds to 4.25 seconds. The worker now runs only single-scale BRIEF and adjacent matching during capture, then defers multi-scale recovery, component repair, and loop matching until capture stops.
- Target-phone validation confirms the phase split restored a 0.266-second median candidate interval. Live matching remains at 480 pixels; a retained 720-pixel grayscale pass performs stronger bounded repair after stop. Latest-capture replay connects 113/113 frames in 11.2 desktop seconds while retaining 27.0 MB. `refinement/tracking.json` records phase, progress, timing, configuration, and retained grayscale bytes for phone validation.
- Bounded shared calibration provides a phone-safe initialization, not a final camera solution. Its current estimates vary across captures because WebXR pose error and calibration error are still coupled; joint pose/calibration refinement remains required before direct training.
- The second capture yields six long-range loop closures under the current bounded configuration, all validated against independent COLMAP poses; the latest capture yields three and the seesaw replay still yields none. Global SE(3) correction is not yet implemented, so direct-train readiness remains disabled and export continues to request downstream SfM.
- Registration and reprojection residual alone are insufficient for object readiness: a sparse low-light plush capture registered 32/32 frames through its patterned background despite inadequate object sampling. Target-region feature and coverage gates remain required.
- A depth-derived seed point cloud is generated during ZIP export. Spirula interoperability still requires a direct import test of the new export.

See [plans/plan.md](plans/plan.md) for project sequencing and [docs/m0-compatibility.md](docs/m0-compatibility.md) for API behavior.
