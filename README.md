# Open Web 3D Capture

Open Web 3D Capture is an experimental, local-first Android capture app for Gaussian splatting and photogrammetry. It provides a pose-guided WebXR mode for medium objects and an autofocus photo mode for small, close subjects, then packages the images for visual registration in [Spirula Studio](https://github.com/harry7557558/spirula-studio) or [LichtFeld Studio](https://github.com/MrNeRF/LichtFeld-Studio).

The app is a capture and preflight tool. It does not reconstruct a Gaussian splat or produce final training poses on the phone. WebXR poses drive guidance in WebXR mode and remain available as provenance. Autofocus-mode photos are explicitly unposed. Downstream structure from motion (SfM) remains the final pose authority in both modes.

> [!IMPORTANT]
> Both modes require persistent Origin Private File System storage. Guided WebXR additionally requires Android Chrome on an ARCore-capable phone and granted WebXR Raw Camera Access. Close-focus mode requires browser `ImageCapture` support and exports unposed photographs that must pass through SfM. The autofocus mode is implemented but still requires target-phone and reconstruction validation.

## What it does

- Locks the centered subject in world space when capture starts.
- Uses a translucent rotating globe to guide a 25-checkpoint object orbit.
- Separates movement from acquisition: move to a viewpoint, stop, and let the app select a stable frame.
- Rejects off-target, soft, low-texture, high-motion, badly tracked, and unsynchronized candidates.
- Requires two viewpoints at least 6° apart for each completed checkpoint.
- Runs local visual-connectivity checks and reports `READY FOR SFM`, `ADD VIEWS`, or `CAPTURE RISK`.
- Exports bounded photo packages for Spirula and LichtFeld, plus a full diagnostic archive.
- Provides a separate close-focus mode with the same 25-checkpoint globe, live move/hold/focus/burst/save feedback, optional automatic capture, a saved-image confirmation, and image-feature checks for overlap and viewpoint change.
- Requests supported autofocus controls, checks preview stability, takes up to three full-resolution photographs, and retains only the sharpest acceptable image.

The recorder evaluates at most four candidates per second. After movement, it requires a three-candidate stable window before accepting another reconstruction image. A complete required checkpoint set contains 50–100 selected images. Incomplete exports can contain a different number, and sparse captures fall back to all accepted images.

## Privacy

Photos, depth maps, camera poses, motion samples, quality decisions, and preflight results remain in Origin Private File System storage on the device. The application has no capture-upload endpoint, cloud synchronization, account system, or analytics integration. Data leaves the device only when the user exports a ZIP and independently shares or uploads it.

The static hosting provider still receives ordinary requests for application files and associated request metadata. Exported images can contain faces, homes, location clues, serial numbers, and other private information. Do not attach captures to public issues. See [PRIVACY.md](PRIVACY.md) and [SECURITY.md](SECURITY.md).

## Supported capture conditions

- Static, textured subject.
- Bright, even illumination.
- Enough safe space to move around the subject.
- At least 250 MB of available browser storage.
- Approximately 45 cm or more in WebXR mode; close-focus distance depends on the selected phone camera.

The 45 cm limit is provisional guidance, not a universal optical specification. ARCore currently defaults to fixed focus on supported cameras, while WebXR Raw Camera Access provides no autofocus, lens-selection, or manual-focus control. Automatic close-range rejection works only when the device supplies usable CPU depth. Without CPU depth, the app cannot measure closeness and places the initial subject estimate 1 m in front of the camera; globe guidance is consequently approximate.

For small or close subjects, use **Open close-focus photos**. This ordinary-camera path can autofocus but has no synchronized WebXR pose, depth, or measured coverage. Its globe is a manual navigation sequence. Local feature matching rejects views that appear too similar or have too little overlap, but it does not recover a pose or prove geometric coverage.

## Capture workflow

### Guided WebXR

1. Open the deployed HTTPS application in Android Chrome. Avoid embedded social-app browsers.
2. Confirm that immersive AR, OPFS local storage, and the XR camera image are available.
3. Select **Open guided WebXR**, center the subject, and remain at least 45 cm away. If target distance is displayed, verify that it is plausible.
4. Select **Start capture**. Opening the camera does not begin recording.
5. Move to the highlighted globe cell, stop, and hold through the settling prompt.
6. After **VIEWPOINT 1 / 2**, take a sideways step within the same cell, stop, and wait for **SECTOR CAPTURED**.
7. Complete the standard, low, raised, and top checkpoints. Keep the subject in the reticle and return near the starting view to close the visual loop.
8. Select **Finish scan**, review the preflight result, and choose an export.

Uncaptured cells are light blue, the active cell is blue, and completed cells are orange. The required checkpoints are six low, twelve standard handheld, six raised, and one top checkpoint. On devices with CPU depth, a display-only constellation shows newly observed surface points in blue and multi-view support in orange.

### Close-focus autofocus photos

1. Select **Open close-focus photos**, center a textured part of the subject in the circular reticle, then select **Start photo scan**.
2. Follow the blue active cell around the translucent globe. Each of its 25 checkpoints needs two accepted photographs. Globe rotation follows device orientation for presentation only; it does not measure the camera position.
3. Move between viewpoints, keep the subject inside the reticle, and stop. Select **Arm this viewpoint**, or enable **Auto capture** after starting the scan. The app waits for sufficient detail, sharpness, and stability before taking a burst.
4. The app retains the sharpest burst image, checks its visual overlap and displacement against accepted photographs, shows the saved winner, and asks for a wider or smaller step when the view is unsuitable.
5. Capture at least 50 accepted views, finish the set, then export to Spirula or LichtFeld and run SfM before training.

See [wider rollout testing](docs/wider-testing.md) for the detailed test protocol and failure recovery.

## Exports

| Export | Contents | Intended workflow |
| --- | --- | --- |
| **Spirula ZIP** | Selected reconstruction images, preflight report, WebXR provenance, and handoff instructions. It deliberately omits root pose and reconstruction markers. | Extract the ZIP, create a dataset from the image directory, run Spirula's built-in SfM, inspect registration, then train. |
| **LichtFeld ZIP** | Selected reconstruction images, preflight report, WebXR provenance, and handoff instructions. It contains no fabricated COLMAP model. | Extract the ZIP and run the [`community:colmap`](https://lichtfeld.io/plugins/) reconstruction plugin, which currently requires LichtFeld 0.5.0 or newer. Inspect the sparse reconstruction before training. |
| **Archive ZIP** | Complete accepted images and mode-specific telemetry. WebXR archives include raw transforms, depth, IMU, decisions, visual tracking, and preflight data. Autofocus archives include explicit unposed-photo and camera-control metadata. | Engineering analysis, validation, desktop refinement, and recovery. |

Spirula and LichtFeld destination ZIPs store WebXR telemetry under `open3dcapture/` when it exists but do not present those poses as reconstruction output. Autofocus exports contain no fabricated pose. Each populated WebXR globe cell contributes at most four representatives with motion score at most 0.4, ranked using the attributed hybrid sharpness score. Sparse WebXR captures fall back to all accepted images rather than applying an unsafe filter. Exporting below the WebXR preflight threshold produces an interactive warning and a warning inside the package.

The Archive seed point cloud provides metric depth initialization and has been imported successfully by Spirula, but raw WebXR poses have not produced reconstruction quality comparable to desktop SfM. The LichtFeld photo-to-COLMAP handoff remains subject to wider multi-device rollout testing.

## Run locally

Requirements: Node.js 18 or newer and npm.

```bash
npm install
npm test
npm run build
npm run dev
```

Open `http://localhost:5173` for desktop UI and serialization work. Immersive capture requires a compatible Android phone and a secure context. For USB-connected development:

```bash
npm run dev -- --host 127.0.0.1
adb reverse tcp:5173 tcp:5173
```

Open `http://localhost:5173` in Chrome on the phone. Android treats the forwarded `localhost` origin as potentially trustworthy. Re-run `adb reverse` after reconnecting the device.

Production builds register a network-first service worker with offline fallback. The application and every new capture show the UTC production build timestamp so stale deployments can be identified.

## Development tools

The repository includes commands for dataset validation, readiness and image-quality analysis, seed-cloud generation, independent PyCOLMAP reconstruction, dual-pose export, and diagnostic pose-optimization experiments. See [developer tools](docs/developer-tools.md).

Implementation status, validation evidence, rejected experiments, and future work are maintained in [plans/plan.md](plans/plan.md). WebXR API behavior is documented in [docs/m0-compatibility.md](docs/m0-compatibility.md).

## Current limitations

- WebXR Raw Camera Access is an experimental optional API. A non-null `view.camera` during the live XR session is the decisive signal.
- Autofocus `getUserMedia()`/`ImageCapture` photographs are not pose-synchronized; their orbit prompts are not measured and their exports require downstream SfM.
- Browser camera capability reporting and autofocus behavior vary by device. The close-focus burst and thresholds require target-phone calibration.
- Only CPU-accessible WebXR depth is recorded. GPU-only depth does not produce depth files, the constellation, distance enforcement, or a seed point cloud.
- Fixed-focus WebXR can irreversibly blur small or close subjects.
- Phone-side visual tracking checks overlap and connectivity but does not refine production poses.
- Preflight reduces avoidable capture failures; it cannot guarantee that downstream SfM will register every image or produce a good splat.
- Browser storage can be cleared or evicted. Export valuable captures before clearing site data or uninstalling the browser.

## License and independence

Copyright © 2026 Open Web 3D Capture contributors.

Open Web 3D Capture is licensed under the [GNU General Public License version 3 or later](LICENSE). Third-party components and adapted code retain their own licenses; see the [third-party notices](public/THIRD_PARTY_NOTICES.txt).

This is an independent community project. It is not affiliated with or endorsed by Google, ARCore, Spirula Studio, LichtFeld Studio, COLMAP, or Nerfstudio. Product and project names are used only to describe compatibility.

Before contributing, read [CONTRIBUTING.md](CONTRIBUTING.md). Do not post capture ZIPs or photos publicly unless every depicted person, location, object, and embedded datum is safe to disclose.
