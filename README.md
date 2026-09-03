# Open Web 3D Capture

Current scope: capture preflight, stop-and-shoot object coverage guidance, and safe handoff to Spirula Studio and LichtFeld Studio. The Android Chrome WebXR recorder evaluates up to four synchronized candidates per second, locks the centered subject in world space at Start, projects that target into every camera frame, and rejects off-target framing, subject-region blur, excessive motion, close-range fixed-focus failures, bad tracking, and unsynchronized images. At each new viewpoint it records a bounded stationary burst, retains accepted frames and capture telemetry in the canonical archive, and selects the sharp low-motion checkpoint images for destination exports once coverage is sufficient. WebXR poses support navigation and diagnostics; production reconstruction uses downstream visual SfM.

New captures also record an experimental target-tiled Sharp Frames hybrid score alongside the production sharpness score. It is an attributed adaptation of Reflct's denoised Laplacian–Tenengrad metric. It ranks otherwise eligible destination-export frames but does not control live acceptance. Run `npm run analyze:quality -- /path/to/extracted-capture` to compare both score distributions and their rank correlation. See [third-party notices](public/THIRD_PARTY_NOTICES.txt).

## Capture-data privacy

Capture processing and persistence are local to the browser. Photos, depth maps, camera poses, motion samples, quality decisions, and reconstruction preflight results are stored in OPFS on the device. The application has no capture-upload endpoint, cloud synchronization, user account, or analytics integration. Capture data leaves the device only after the user exports a ZIP and independently shares or uploads that file. The static hosting provider still receives ordinary requests for the application files and normal request metadata; it does not receive the capture dataset.

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
2. Select **Open camera** and grant requested permissions. Center the object before selecting **Start capture**; opening XR no longer begins recording.
3. Confirm pose, projection matrix, intrinsics, and frame rate change live.
4. Center a static, textured object at least 45 cm from the phone. Confirm the live target-distance value is plausible, then select **Start capture**.
5. Move to the highlighted translucent-globe sector. Movement is navigation only; the app does not expect a sharp keyframe while walking.
6. Keep the object inside the central reticle. If it leaves the locked capture region, the globe fades, the reticle turns red, and capture pauses until the directional prompt is followed.
7. Stop briefly and hold the phone steady while the app records a two-frame sharp burst. Wait for the haptic and **SECTOR CAPTURED** confirmation before moving again.
8. Repeat for the required standard, raised, top, and low checkpoints. Select **Finish scan** when the globe and readiness result show sufficient coverage.
9. Export the capture for Spirula, LichtFeld, or as a full archive.
10. Inspect `capture.json`, `transforms.json`, `telemetry/frames.jsonl`, `debug/session.jsonl`, sampled `debug/rejected/` quality crops, images, optional depth, and IMU samples.
11. Reconstruct the images through Spirula native SfM or LichtFeld's COLMAP Reconstruction plugin before training. Do not treat the WebXR transform file as final reconstruction poses.

Exports with synchronized CPU depth now include a voxel-downsampled `pointcloud.ply` and reference it through `ply_file_path` in `transforms.json`. This supplies the initial point cloud required by Spirula Studio.

During capture, a translucent 12-longitude by 4-layer globe rotates continuously with the live WebXR azimuth and elevation. Uncaptured cells are light blue, the active cell is blue, and completed cells are orange; reverse-side cells remain visible. The 25 required checkpoints comprise six low views (-20° to 5°), twelve standard handheld views (5° to 35° above the object), six raised views (35° to 60°), and one top cap (60° to 90°). This makes the normal phone-at-chest/head-height, camera-pointed-slightly-downward posture the dense ring. Coverage is derived from camera position around the estimated object, not phone pitch alone. A checkpoint lights only after two sharp, low-motion images are retained.

Stopping first marks the capture durable in OPFS and exposes it in the capture library. Deferred visual analysis runs afterward. The UI explicitly reports when the photos are safe; leaving at that point preserves the capture but may skip final connectivity checks.

After capture, the app reports `READY FOR SFM`, `ADD VIEWS`, or `CAPTURE RISK`. The report checks image synchronization, sharpness, coverage, elevation diversity, visual connectivity, weak bridges, and loop return, and is stored as `preflight/readiness.json`.

Three export buttons are available:

- **Archive ZIP** preserves the complete canonical dataset, including raw WebXR transforms, depth, IMU, diagnostics, and optional seed point cloud.
- **Spirula ZIP** contains reconstruction images, provenance, readiness report, and instructions for Spirula's Create Dataset from Photos/Video workflow. Images are checkpoint-selected when the safety gate passes. The package intentionally omits root reconstruction markers so native SfM runs.
- **LichtFeld ZIP** contains reconstruction images, provenance, readiness report, and instructions for the `community:colmap` COLMAP Reconstruction plugin (LichtFeld 0.5.0 or newer). Images are checkpoint-selected when the safety gate passes. The package intentionally contains no fabricated COLMAP model.

Both destination packages preserve WebXR poses under `open3dcapture/telemetry/frames.jsonl` but declare downstream SfM as the final pose authority. The recorder may retain up to ten accepted images per populated globe cell in the canonical archive. Destination exports select at most four per cell, reject motion scores above 0.4, and rank the remaining views with the attributed hybrid sharpness metric. A complete 25-checkpoint capture therefore begins at 50 images and is capped at 100 destination images. Incomplete but sufficiently distributed captures use the same bounded sector selection; very sparse captures fall back to every image. Exporting a non-ready capture produces both an interactive warning and a warning in the handoff README. The choice and selected frame IDs are recorded in `open3dcapture/export.json`.

Replay the same readiness checks against an existing capture without modifying it:

```bash
npm run analyze:readiness -- /path/to/capture.zip
```

## Add a seed point cloud to an existing capture

The desktop converter requires ImageMagick's `convert` command. Run it against an extracted capture directory:

```bash
npm run pointcloud -- /path/to/capture-directory
```

It creates `pointcloud.ply` and atomically adds `"ply_file_path": "pointcloud.ply"` to `transforms.json`. It refuses to overwrite an existing point cloud unless explicitly requested:

```bash
npm run pointcloud -- /path/to/capture-directory --force
```

## Validate an exported capture

The validator accepts either the downloaded ZIP or an extracted capture directory:

```bash
npm run validate -- /path/to/capture.zip
npm run validate -- /path/to/capture-directory
```

It checks Nerfstudio transforms and intrinsics, JPEG dimensions and references,
synchronized-image status, frame counts and timestamps, pose motion, depth payloads,
IMU/decision telemetry, the seed PLY, and the visual-tracking report. Errors produce
a non-zero exit status. Machine-readable output is available with `--json`.

## Prepare a refined desktop dataset

The refinement tools use an isolated Python environment. The system COLMAP installation is not changed.

```bash
python3 -m venv .venv-refinement
.venv-refinement/bin/pip install -r tools/requirements-refinement.txt
```

Create an independent COLMAP reference model from an extracted capture:

```bash
npm run refine:colmap -- /path/to/capture /path/to/colmap-reference
```

The default sequential matcher uses 15-frame overlap plus quadratic pairing. Use `--matcher exhaustive` when a sequence cannot register completely.

Convert the selected COLMAP model into portable refined outputs:

```bash
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

The bounded pose-correction experiment can be replayed against a raw capture. It is diagnostic and never marks its output safe for direct training; pairwise epipolar scoring proved insufficient to determine the correct correction direction.

```bash
npm run benchmark:features -- /path/to/capture \
  --include-constraints \
  --output /path/to/feature-constraints.json

npm run optimize:poses -- \
  /path/to/capture \
  /path/to/feature-constraints.json \
  /path/to/pose-candidate.json

npm run compare:poses -- \
  /path/to/pose-candidate.json \
  /path/to/refined-output/telemetry/frames.jsonl
```

The multi-view experiment uses one deferred strong-feature identity across temporal offsets 1, 2, and 4, joins observations into tracks, triangulates landmarks, and alternates bounded SE(3) updates with retriangulation:

```bash
npm run optimize:landmarks -- \
  /path/to/capture \
  /path/to/feature-constraints.json \
  /path/to/landmark-candidate.json
```

This output is also diagnostic-only. Use `--rotation-only` to isolate SO(3), or `--calibration /path/to/refinement.json` for a reference-calibration experiment. Neither option enables refined export.

The production build registers a network-first service worker with offline fallback. The Vite development build does not register it. See [Wider rollout testing](docs/wider-testing.md) for supported devices, the capture protocol, privacy behavior, failure recovery, and the feedback package.

The capture HUD shows the UTC production build time. New captures also persist it as `applicationBuild.builtAt` in `capture.json`, making stale phone deployments identifiable from both the live UI and exported ZIP.

## Current limitations

- Raw WebXR camera access is an incubating, optional API. Constructor detection does not prove that a session will grant `camera-access`; the decisive signal is a non-null `view.camera` during an XR animation frame.
- **Enable camera fallback** uses `getUserMedia()`. Those images are not WebXR pose-synchronized. Exported frame telemetry marks them with `imageSource: "media-stream"` and `imageSynchronized: false`; they cannot satisfy the reconstruction viability gate.
- Depth capture currently requests CPU-accessible depth only. GPU-only depth implementations are reported by the probe but are not recorded.
- M0 passed on the target phone with synchronized 886×1920 XR camera JPEGs, 160×90 CPU depth, tracked poses, IMU data, and OPFS reload recovery.
- M1 passed with a 90-frame chair capture that produced a recognizable, upright reconstruction in Brush. Floaters remain because M1 had no quality selection or seed point cloud.
- M2 selection is implemented but requires one more target-phone capture before acceptance. The first M2 seesaw capture accepted 105 of 118 candidates and exposed saturated blur scores plus overly permissive motion limits.
- A later bicycle capture showed that one absolute center-crop Laplacian threshold confuses smooth or backlit content with blur, rejecting 110/178 candidates despite low motion and usable accepted images. Quality analysis now uses nine target-region tiles, reports low texture separately, adapts against recent detailed views above a 0.38 floor, and exports every fourth rejected-candidate crop under `debug/rejected/` for calibration without restoring capture backpressure.
- ARCore commonly uses fixed focus for tracking, and WebXR exposes no autofocus, lens-selection, or manual-focus control. The recorder therefore reports center depth and rejects targets closer than a provisional 45 cm focus floor. This cannot restore detail that was optically blurred.
- Web v1 should be treated as a medium-object capture path until the 45 cm floor and minimum usable object size are measured on the target phone. Reliable close-range small-object capture likely requires a native Android path with camera focus control.
- WebXR poses are retained as metric priors, not assumed to be reconstruction-grade final poses. Independent COLMAP refinement registers all 105 seesaw frames and all 145 frames of the second phone capture, while correcting poses, focal length, and lens distortion.
- Dual-pose serialization and an incremental low-resolution TypeScript feature/reprojection pipeline are implemented. It uses compact BRIEF for adjacent frames and a multi-scale oriented-gradient descriptor for recovery and long-range edges.
- The tracker runs in a dedicated browser worker on accepted synchronized frames and persists `refinement/tracking.json`. Pose-independent RANSAC verification, inlier-only scoring, and bounded component repair connect 105/105 seesaw frames, 145/145 second-capture frames, and 113/113 latest validation frames in replay.
- Multi-scale tracking caused severe phone CPU contention in a low-light test: candidate cadence fell from 0.27 seconds to 4.25 seconds. The worker now runs only single-scale BRIEF and adjacent matching during capture, then defers multi-scale recovery, component repair, and loop matching until capture stops.
- Target-phone validation confirms the phase split restored a 0.266-second median candidate interval. Live matching remains at 480 pixels; a retained 720-pixel grayscale pass performs stronger bounded repair after stop. Latest-capture replay connects 113/113 frames in 11.2 desktop seconds while retaining 27.0 MB. `refinement/tracking.json` records phase, progress, timing, configuration, and retained grayscale bytes for phone validation.
- Bounded shared calibration is diagnostic initialization, not a final camera solution. Its estimates vary across captures because WebXR pose and calibration errors are coupled.
- The second capture yields six validated long-range loop closures; the seesaw replay yields none. Pairwise SE(3) correction is rejected. A multi-view landmark prototype improves one reference capture but regresses another despite improving held-out reprojection in both. Mobile pose refinement is therefore removed from the production path and retained only as a research tool.
- Unified deferred matching across offsets 1/2/4 takes approximately 61–70 seconds on the development desktop. Production capture guidance should use only the bounded live/deferred checks needed for coverage and weak-bridge detection.
- Registration and reprojection residual alone are insufficient for object readiness: a sparse low-light plush capture registered 32/32 frames through its patterned background despite inadequate object sampling. Target-region feature and coverage gates remain required.
- A depth-derived seed point cloud is generated in the canonical archive. Spirula direct import/training is confirmed. The LichtFeld `community:colmap` handoff still requires an end-to-end rollout test.
- The worker now records feature and geometric-inlier concentration inside the centered 60% target-region proxy. These values are informational until hardware captures calibrate a safe readiness threshold.
- A depth-derived seed point cloud is generated during ZIP export. Direct Spirula Studio import and training have been confirmed; raw WebXR pose registration still produces low-quality geometry and requires downstream SfM/refinement.

See [plans/plan.md](plans/plan.md) for project sequencing and [docs/m0-compatibility.md](docs/m0-compatibility.md) for API behavior.
