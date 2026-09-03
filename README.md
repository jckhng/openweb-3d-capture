# Open Web 3D Capture

Open Web 3D Capture is an experimental, local-first Android WebXR capture app for Gaussian splatting and photogrammetry. It turns object capture into a guided stop-and-shoot orbit, keeps the subject centered, selects sharp and spatially distinct images, and packages them for visual registration in [Spirula Studio](https://github.com/harry7557558/spirula-studio) or [LichtFeld Studio](https://github.com/MrNeRF/LichtFeld-Studio).

The app is a capture and preflight tool. It does not reconstruct a Gaussian splat or produce final training poses on the phone. WebXR poses drive guidance and remain available as provenance; downstream structure from motion (SfM) remains the final pose authority.

> [!IMPORTANT]
> The current capture path requires Android Chrome on an ARCore-capable phone, an immersive AR session, Origin Private File System storage, and granted WebXR Raw Camera Access. WebXR feature detection does not guarantee that a session will expose synchronized camera images. The live capability and capture status in the app are authoritative.

## What it does

- Locks the centered subject in world space when capture starts.
- Uses a translucent rotating globe to guide a 25-checkpoint object orbit.
- Separates movement from acquisition: move to a viewpoint, stop, and let the app select a stable frame.
- Rejects off-target, soft, low-texture, high-motion, badly tracked, and unsynchronized candidates.
- Requires two viewpoints at least 6° apart for each completed checkpoint.
- Runs local visual-connectivity checks and reports `READY FOR SFM`, `ADD VIEWS`, or `CAPTURE RISK`.
- Exports bounded photo packages for Spirula and LichtFeld, plus a full diagnostic archive.

The recorder evaluates at most four candidates per second. After movement, it requires a three-candidate stable window before accepting another reconstruction image. A complete required checkpoint set contains 50–100 selected images. Incomplete exports can contain a different number, and sparse captures fall back to all accepted images.

## Privacy

Photos, depth maps, camera poses, motion samples, quality decisions, and preflight results remain in Origin Private File System storage on the device. The application has no capture-upload endpoint, cloud synchronization, account system, or analytics integration. Data leaves the device only when the user exports a ZIP and independently shares or uploads it.

The static hosting provider still receives ordinary requests for application files and associated request metadata. Exported images can contain faces, homes, location clues, serial numbers, and other private information. Do not attach captures to public issues. See [PRIVACY.md](PRIVACY.md) and [SECURITY.md](SECURITY.md).

## Supported capture conditions

- Static, textured, medium-sized subject.
- Bright, even illumination.
- Enough safe space to move around the subject.
- At least 250 MB of available browser storage.
- Approximately 45 cm or more between the phone and subject.

The 45 cm limit is provisional guidance, not a universal optical specification. ARCore currently defaults to fixed focus on supported cameras, while WebXR Raw Camera Access provides no autofocus, lens-selection, or manual-focus control. Automatic close-range rejection works only when the device supplies usable CPU depth. Without CPU depth, the app cannot measure closeness and places the initial subject estimate 1 m in front of the camera; globe guidance is consequently approximate.

Small close-range subjects remain outside the calibrated web capture path.

## Capture workflow

1. Open the deployed HTTPS application in Android Chrome. Avoid embedded social-app browsers.
2. Confirm that immersive AR, OPFS local storage, and the XR camera image are available.
3. Select **Open camera**, center the subject, and remain at least 45 cm away. If target distance is displayed, verify that it is plausible.
4. Select **Start capture**. Opening the camera does not begin recording.
5. Move to the highlighted globe cell, stop, and hold through the settling prompt.
6. After **VIEWPOINT 1 / 2**, take a sideways step within the same cell, stop, and wait for **SECTOR CAPTURED**.
7. Complete the standard, low, raised, and top checkpoints. Keep the subject in the reticle and return near the starting view to close the visual loop.
8. Select **Finish scan**, review the preflight result, and choose an export.

Uncaptured cells are light blue, the active cell is blue, and completed cells are orange. The required checkpoints are six low, twelve standard handheld, six raised, and one top checkpoint. On devices with CPU depth, a display-only constellation shows newly observed surface points in blue and multi-view support in orange.

See [wider rollout testing](docs/wider-testing.md) for the detailed test protocol and failure recovery.

## Exports

| Export | Contents | Intended workflow |
| --- | --- | --- |
| **Spirula ZIP** | Selected reconstruction images, preflight report, WebXR provenance, and handoff instructions. It deliberately omits root pose and reconstruction markers. | Extract the ZIP, create a dataset from the image directory, run Spirula's built-in SfM, inspect registration, then train. |
| **LichtFeld ZIP** | Selected reconstruction images, preflight report, WebXR provenance, and handoff instructions. It contains no fabricated COLMAP model. | Extract the ZIP and run the [`community:colmap`](https://lichtfeld.io/plugins/) reconstruction plugin, which currently requires LichtFeld 0.5.0 or newer. Inspect the sparse reconstruction before training. |
| **Archive ZIP** | Complete accepted images, raw WebXR transforms, depth, IMU, decisions, rejected-frame samples, visual tracking, and preflight data. When synchronized CPU depth is available, it also includes `pointcloud.ply` referenced by `transforms.json`. | Engineering analysis, validation, desktop refinement, and recovery. |

Spirula and LichtFeld destination ZIPs store WebXR telemetry under `open3dcapture/` but do not present those poses as reconstruction output. Each populated globe cell contributes at most four representatives with motion score at most 0.4, ranked using the attributed hybrid sharpness score. Sparse captures fall back to all accepted images rather than applying an unsafe filter. Exporting below the preflight threshold produces an interactive warning and a warning inside the package.

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
- The `getUserMedia()` diagnostic fallback is not pose-synchronized and cannot satisfy reconstruction readiness.
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
