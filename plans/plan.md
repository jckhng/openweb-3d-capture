# Project Plan: Open Web 3D Capture

## 0. Implementation status — 25 August 2026

Milestones 0 and 1 are accepted on the target phone. Milestone 2 deterministic quality selection is implemented and awaits threshold calibration on the target phone.

Implemented:

* Vite, React, TypeScript, PWA manifest, production service worker
* browser capability probe and live diagnostic UI
* immersive AR session, pose, projection, intrinsics, frame-rate, IMU, and CPU-depth telemetry
* 20-frame diagnostic capture with raw-XR-camera readback where granted
* OPFS persistence with in-memory fallback
* Nerfstudio-compatible ZIP serialization plus separate application telemetry
* local capture listing and export after reload
* matrix and dataset serialization unit tests
* secure-origin and experimental-API documentation
* open-ended M1 object recorder with explicit start/stop
* four-FPS temporal keyframe gate separated from XR/UI code
* capture-window IMU export
* network-first production service worker with offline fallback
* compact immersive capture HUD that leaves the camera view unobstructed
* center-crop Laplacian sharpness scoring
* pose-derived linear/angular motion scoring
* translation/rotation novelty selection
* explicit rejection reasons and live quality guidance
* durable per-candidate `debug/session.jsonl` telemetry

Local verification:

```text
npm run build   PASS
npm test        PASS (21 tests)
npm audit       PASS (0 known vulnerabilities)
```

Hardware and reconstruction evidence:

* 20 synchronized 886×1920 XR camera JPEGs
* tracked, changing, finite poses and stable intrinsics
* 20 valid 160×90 CPU depth buffers
* IMU telemetry at approximately 56 Hz
* complete export after page reload from OPFS
* 90-frame synchronized chair capture with 90 valid depth frames
* approximately 340-degree chair orbit with stable intrinsics and tracked poses
* recognizable, upright chair reconstruction in Brush web, confirming pose convention

Required before declaring M2 complete:

1. Deploy the M2 recorder and exercise blur, fast motion, stationary/redundant views, and tracking loss.
2. Confirm the compact HUD gives the correct single instruction and remains operable during XR.
3. Capture 50–100 accepted frames and inspect `debug/session.jsonl` rejection distributions.
4. Adjust thresholds if rejection rates or reconstruction quality show systematic errors.
5. Reconstruct the filtered dataset and compare visible floaters with the M1 chair baseline.

Plan constraints clarified by implementation:

* API-surface detection is not proof of a granted WebXR feature; the live session is authoritative.
* `getUserMedia()` frames are not pose-synchronized and cannot satisfy Gate 0 or Gate 1. They remain a diagnostic fallback and are marked as unsynchronized in telemetry.
* M0 requests CPU depth only. GPU depth readback is deferred until a target device demonstrates it is needed.
* Do not begin M3 coverage guidance until M2 thresholds have been exercised on the target phone.

## 1. Objective

Build an open-source, local-first web application that turns an Android phone into a **guided 3D capture instrument**.

The app does **not** perform full Gaussian-splat reconstruction in v1.

Its job is to:

1. access camera + WebXR tracking data,
2. select useful reconstruction keyframes,
3. guide the user toward missing viewpoints,
4. retain useful camera/depth/IMU telemetry,
5. save everything locally on-device,
6. export a standard dataset that can be processed by:

   * Brush
   * Spirula Studio
   * LichtFeld Studio
   * Nerfstudio-compatible tooling
7. optionally load the resulting splat back onto the phone for viewing.

Core philosophy:

> Capture once. Keep the raw data. Reconstruct anywhere.

---

# 2. Primary target

Initial supported platform:

```text
Android
Chrome / Chromium
WebXR-capable device
ARCore-capable device preferred
```

Primary development device can be the current phone.

Do not attempt:

* iOS/Safari parity
* Firefox
* desktop capture
* APK/native Android
* broad device compatibility

during v1.

Feature detection must be used everywhere so unsupported capabilities degrade cleanly.

---

# 3. V1 user workflow

```text
Open URL
   ↓
Install as PWA optionally
   ↓
New Capture
   ↓
Choose:
  OBJECT
  SCENE [later]
   ↓
Camera opens
   ↓
WebXR tracking starts
   ↓
User walks around object
   ↓
App:
  - monitors motion
  - evaluates sharpness
  - selects keyframes
  - tracks viewpoints
  - shows capture coverage
  - directs user toward missing areas
   ↓
Capture complete
   ↓
Dataset remains stored locally
   ↓
EXPORT
   ↓
capture.zip
   ↓
PC
   ↓
Brush / Spirula / LichtFeld
   ↓
Gaussian splat
   ↓
optional:
transfer .ply/.spz to phone
   ↓
view in PWA
```

---

# 4. Architectural rule

Separate **capture data** from **capture UI**.

The project should be structured roughly as:

```text
open3dcapture/
│
├── apps/
│   └── web/
│
├── packages/
│   ├── capture/
│   ├── xr/
│   ├── quality/
│   ├── keyframes/
│   ├── coverage/
│   ├── storage/
│   ├── dataset/
│   ├── viewer/
│   └── shared/
│
├── tools/
│   ├── inspect-dataset/
│   ├── validate-dataset/
│   └── convert/
│
├── test-data/
│
└── docs/
    ├── architecture.md
    ├── capture-format.md
    └── compatibility.md
```

Do not bury capture algorithms inside UI components.

UI should consume application state produced by the capture engine.

---

# 5. Data model

Internally, every accepted camera frame should produce something conceptually equivalent to:

```typescript
interface CaptureFrame {
  id: number;
  timestamp: number;

  imagePath: string;

  width: number;
  height: number;

  intrinsics: {
    fx: number;
    fy: number;
    cx: number;
    cy: number;
  };

  cameraToWorld: number[][];

  trackingState: string;

  quality: {
    blurScore: number;
    motionScore: number;
    noveltyScore: number;
    coverageGain: number;
  };

  depthPath?: string;
}
```

Telemetry should remain separate:

```typescript
interface IMUSample {
  timestamp: number;

  gyro?: [number, number, number];
  accel?: [number, number, number];
}
```

Do not throw away information just because Nerfstudio does not use it.

---

# 6. Export format

Make **Nerfstudio `transforms.json`** the primary compatibility format.

Export:

```text
capture-name/
│
├── transforms.json
│
├── images/
│   ├── 000000.jpg
│   ├── 000001.jpg
│   └── ...
│
├── capture.json
│
├── telemetry/
│   ├── frames.jsonl
│   └── imu.jsonl
│
├── depth/
│   └── ...
│
├── pointcloud.ply
│
└── thumbnail.jpg
```

Not every file is mandatory.

Minimum valid export:

```text
transforms.json
images/
```

Preferred export:

```text
transforms.json
images/
capture.json
telemetry/
depth/
pointcloud.ply
```

---

# 7. Important format decision

`transforms.json` must remain standards-compatible.

Do not add proprietary application fields unless they are known to be harmless.

Put our metadata into:

```text
capture.json
```

For example:

```json
{
  "format": "open3dcapture",
  "version": 1,
  "captureMode": "object",
  "source": "webxr",
  "units": "meters",
  "frameCount": 172,
  "hasDepth": true,
  "hasImu": true
}
```

This provides two levels of compatibility:

```text
generic reconstruction software
          ↓
   transforms.json

our tools / future processing
          ↓
 capture.json + telemetry
```

---

# 8. Coordinate conventions

This must be documented and tested early.

Choose one canonical internal convention.

Recommended:

```text
camera transform = camera-to-world
units            = meters
matrix           = 4×4
```

Export conversion into Nerfstudio/OpenGL convention happens in one clearly defined function.

Never scatter:

```text
flip X
flip Y
negate Z
transpose matrix
```

throughout the code.

Create something like:

```typescript
toNerfstudioTransform()
fromWebXRTransform()
```

and unit-test them.

Pose convention bugs can make an apparently healthy capture completely unusable.

---

# 9. Milestone 0 — capability probe

Build an intentionally ugly diagnostic page first.

Display:

```text
WebXR              available
immersive-ar       available
camera access      available
raw XR camera      available
depth              available
gyro               available
accelerometer      available
WebGPU             available
OPFS               available

XR FPS             60
camera resolution  ...
depth resolution   ...
tracking            good
```

Buttons:

```text
START XR
CAPTURE 20 FRAMES
EXPORT DIAGNOSTICS
```

### Acceptance criteria

On the target phone:

* WebXR session starts.
* Camera frames can be obtained.
* Camera pose changes correctly with movement.
* Intrinsics/projection data can be recovered.
* frames and poses have meaningful timestamps.
* optional IMU data can be recorded.
* optional depth can be recorded.
* files can be written into OPFS.
* a capture survives page refresh.

Do not proceed to fancy UI until this works.

---

# 10. Milestone 1 — basic recorder

Implement capture without intelligence.

Workflow:

```text
START CAPTURE
      ↓
record selected interval
      ↓
STOP
      ↓
save dataset
      ↓
EXPORT ZIP
```

Initially use a simple temporal keyframe strategy:

```text
maximum 2–5 images/sec
```

rather than retaining every frame.

### Acceptance criteria

Export at least 50 images from a real object capture.

Dataset must load into:

* Brush
* Spirula Studio
* LichtFeld Studio

This is the first major project gate.

Do not consider M1 complete merely because the ZIP looks correct.

Actually reconstruct something.

---

# 11. Milestone 2 — quality scoring

Create a frame-scoring pipeline.

Each candidate frame gets:

```text
tracking quality
motion
blur
viewpoint novelty
distance travelled
angular difference
```

Initial capture decision:

```text
tracking bad
    → reject

blur excessive
    → reject

rotation too fast
    → reject

almost same pose as previous frame
    → reject

otherwise
    → candidate
```

Do not make this ML-based initially.

Simple deterministic CV and geometry should be sufficient.

---

# 12. Blur detection

Start with a cheap method such as:

```text
Laplacian variance
```

or equivalent edge-energy metric.

Normalize enough that thresholds can eventually be calibrated across resolution changes.

Output should be continuous:

```text
sharpness = 0..1
```

rather than only:

```text
good/bad
```

UI can threshold it later.

---

# 13. Motion detection

Use XR pose and gyro if available.

Track:

```text
linear velocity
angular velocity
```

Feedback:

```text
GOOD

SLOW DOWN

HOLD STEADY
```

Rejected frames should remain observable in debug mode so thresholds can be tuned.

---

# 14. Keyframe selection

Keyframes should be selected based mainly on **new information**, not time.

A candidate frame becomes useful if it provides sufficient:

```text
translation baseline
OR
angular difference
OR
coverage improvement
```

Example conceptual score:

```text
score =
    w1 * translationNovelty
  + w2 * angularNovelty
  + w3 * coverageGain
  + w4 * sharpness
  - w5 * motionPenalty
```

Do not over-optimize the formula initially.

Log every component.

---

# 15. Milestone 3 — object capture guidance

Implement **Object Mode first**.

User identifies an approximate target.

Initial implementation can simply have the user:

```text
aim center at object
tap TARGET
```

Then approximate target position using depth if available.

If not available, use an assumed/default object distance and refine later.

Maintain spherical viewpoint coverage around the target.

Conceptually:

```text
             top

        ○ ○ ○ ○ ○

     ○             ○

   ○      object     ○

     ●             ○
   current

        ○ ○ ○ ○ ○
```

Each cell records:

```text
unseen
poor
good
```

based on accepted camera poses.

---

# 16. Capture guidance

From coverage data calculate the next useful viewpoint.

UI should issue commands such as:

```text
MOVE LEFT

MOVE RIGHT

MOVE HIGHER

MOVE LOWER

MOVE CLOSER

MOVE FARTHER

SLOW DOWN

HOLD STEADY
```

Avoid clutter.

The app should generally show **one highest-priority instruction**.

---

# 17. Capture-complete criteria

Do not simply require N frames.

For Object Mode calculate something like:

```text
coverage percentage
+
minimum vertical diversity
+
minimum horizontal diversity
+
minimum accepted keyframes
```

Example initial gate:

```text
>= 75% target coverage
>= 40 accepted keyframes
>= multiple elevation bands
```

Thresholds should be configurable during development.

---

# 18. UI design

Primary capture view:

```text
┌──────────────────────────────┐
│                              │
│                              │
│          CAMERA              │
│                              │
│        [ target ]            │
│                              │
│         ← MOVE LEFT          │
│                              │
├──────────────────────────────┤
│ coverage             67%     │
│ frames                83     │
│ tracking             GOOD    │
│ motion               GOOD    │
│ sharpness            GOOD    │
└──────────────────────────────┘
```

Debug mode can expose much more.

Normal mode should not.

---

# 19. Capture telemetry overlay

Create a developer/debug overlay containing:

```text
XR fps
camera fps
accepted fps
total candidates
accepted frames
rejected blur
rejected motion
rejected redundancy
translation velocity
angular velocity
tracking state
coverage
OPFS usage
memory estimate
depth availability
```

This will be invaluable when testing on one device.

---

# 20. Milestone 4 — local scan library

Scans must persist without accounts or servers.

Screen:

```text
MY CAPTURES

Playground
24 Aug 2026
182 frames
437 MB

[DETAILS] [EXPORT] [DELETE]
```

Use:

```text
OPFS
```

as primary capture storage.

Do not use browser RAM as working storage for an entire capture.

Write accepted images immediately.

---

# 21. Crash/reload recovery

Maintain capture state incrementally.

Every accepted frame should be durable shortly after capture.

On reopening:

```text
Incomplete capture detected

[RESUME]
[EXPORT PARTIAL]
[DELETE]
```

A browser crash should not destroy a 10-minute scan.

---

# 22. ZIP export

Export:

```text
my-scan.zip
```

which contains the dataset directory directly.

Avoid introducing a proprietary container.

An `.open3dcapture` extension could exist eventually, but it should still just be ZIP if introduced.

For v1:

```text
.zip
```

is preferable.

---

# 23. Dataset validator

Build a small desktop/Node command-line utility:

```text
validate-capture my-scan/
```

It should verify:

```text
transforms.json parses
all referenced images exist
matrix dimensions valid
no NaN/Inf
intrinsics valid
image dimensions match
frame count sensible
camera poses change
timestamps monotonic
optional depth dimensions valid
```

Output:

```text
VALID

184 frames
resolution 1920x1080
median baseline ...
pose extent ...
depth available
IMU available
```

This is valuable for agent development and debugging.

---

# 24. Reconstruction compatibility test

Maintain a small known capture in `test-data/`.

For each supported backend document the simplest workflow.

Example:

```text
test-data/chair/
```

Acceptance:

```text
Brush loads it
Spirula loads it
LichtFeld loads it
```

Where a backend needs an additional preprocessing step, document it rather than creating format hacks.

---

# 25. Milestone 5 — depth seed point cloud

If WebXR depth is available:

```text
depth
+
intrinsics
+
camera pose
+
RGB
      ↓
world-space point samples
```

Aggregate them.

Perform:

```text
voxel downsample
```

and export:

```text
pointcloud.ply
```

Target perhaps:

```text
100k–500k points
```

not millions.

The seed cloud is not intended to be the final reconstruction.

---

# 26. Point-cloud correctness tests

Validate:

* scale
* orientation
* RGB mapping
* pose conventions

A quick debug viewer should show:

```text
camera frustums
+
point cloud
```

If the point cloud looks correct, the coordinate chain is probably correct.

---

# 27. Milestone 6 — splat viewer

Add an independent viewer.

Initial support:

```text
Gaussian PLY
```

Workflow:

```text
OPEN SPLAT
     ↓
select .ply
     ↓
render locally
```

Viewer capabilities:

```text
orbit
pan
zoom
first-person/free-fly
reset view
```

Later:

```text
SPZ
compressed PLY
SOG
```

Do not couple viewer work to capture milestones.

---

# 28. Scene Mode — subsequent milestone

Do not block v1 on arbitrary environments.

After Object Mode works, implement Scene Mode.

Scene coverage becomes based on observed space/surfaces rather than a spherical target.

Conceptually:

```text
captured surfaces
      ↓
coarse spatial map
      ↓
find under-observed regions
      ↓
guide user
```

Possible representations:

```text
voxels
TSDF
depth-derived surfels
occupancy grid
```

Select based on browser performance.

---

# 29. Explicit non-goals for v1

Do not implement:

* Gaussian training on phone
* cloud reconstruction
* user accounts
* social features
* proprietary hosting
* mesh reconstruction
* mesh editing
* AI segmentation
* custom SLAM
* custom SfM
* SIFT/SURF pose tracking
* native Android
* iOS
* automatic cloud backup
* server database
* multiplayer/shared scans

---

# 30. Technology choices

Suggested initial stack:

```text
TypeScript
Vite
minimal React/Preact/Svelte UI
WebXR
WebGL2 or WebGPU where justified
OPFS
Web Workers
ZIP library
Vitest
Playwright for desktop-testable UI
```

Avoid introducing WASM until profiling demonstrates a need.

Most initial work is:

```text
geometry
state management
file IO
simple image metrics
```

JavaScript/TypeScript should be sufficient.

---

# 31. Threading model

Heavy per-frame analysis should run outside the main UI thread where practical.

```text
XR/render thread
      │
      ├── pose/UI
      │
      └── candidate frame
                ↓
             Worker
                ↓
          quality scoring
                ↓
          accept/reject
                ↓
             OPFS
```

Do not allow JPEG encoding or image-quality analysis to visibly stall the camera UI.

---

# 32. Performance budgets

Initial targets:

```text
XR UI              30+ FPS
quality feedback   >= 10 Hz
pose tracking      XR rate
accepted images    ~1–5/sec
capture latency    < 200 ms feedback
```

There is no requirement to process every camera frame.

Dropping frames is acceptable.

Blocking the interface is not.

---

# 33. Storage policy

Prefer high-quality JPEG rather than raw frames.

Initial configuration:

```text
JPEG quality: ~90–95
```

Potential optional settings later:

```text
Balanced
High Quality
Maximum
```

Don't expose this in early UX.

---

# 34. Logging

Every development capture should optionally save:

```text
debug/session.jsonl
```

containing:

```text
timestamp
tracking state
pose
blur score
motion score
coverage gain
novelty score
accepted/rejected
rejection reason
```

That makes tuning reproducible.

---

# 35. Replay mode

Build this sooner than it initially appears necessary.

Allow:

```text
recorded capture
     ↓
replay through algorithms
```

This means coverage/keyframe logic can be changed without repeatedly walking around an object.

Architecture:

```text
CaptureSource
     │
 ┌───┴─────┐
 │         │
WebXR    Replay
 │         │
 └────┬────┘
      ↓
CaptureEngine
```

This will matter significantly once the coding agent starts modifying heuristics.

---

# 36. Testing strategy

### Unit tests

Test:

```text
matrix conversion
pose distance
angular difference
camera intrinsics
coverage binning
keyframe scoring
Nerfstudio export
manifest parsing
```

### Golden-data tests

Provide known sequences of poses and expected:

```text
accepted frames
coverage values
next-best viewpoint
```

### Dataset integration test

Generated dataset must parse successfully.

### Real-phone test

Keep a standardized physical target:

```text
chair
toy
desk object
```

Repeat captures periodically.

---

# 37. Main project gates

## Gate 0 — browser viability

Phone exposes usable:

```text
camera
XR pose
intrinsics
storage
```

If this fails, reassess web approach.

---

## Gate 1 — reconstruction viability

A basic web capture produces a recognizable Gaussian reconstruction in at least Brush.

This is the single most important early gate.

---

## Gate 2 — interoperability

The same dataset works with at least two of:

```text
Brush
Spirula
LichtFeld
```

---

## Gate 3 — guidance improves results

Compare:

```text
unguided capture
vs
guided capture
```

using approximately equal capture time.

Guided mode should produce measurably:

```text
better coverage
fewer redundant frames
fewer bad frames
fewer reconstruction holes
```

Otherwise the guidance system has not justified itself.

---

## Gate 4 — local-first robustness

A user can:

```text
capture
close browser
reopen
find scan
export it
reconstruct elsewhere
```

without any backend.

---

# 38. Coding-agent priority order

Give the agent work in this order:

```text
1. Repository scaffold

2. WebXR capability diagnostic

3. Capture frame + pose

4. OPFS persistence

5. Export Nerfstudio dataset

6. Validate reconstruction externally

7. Capture quality scoring

8. Keyframe selection

9. Object target model

10. Coverage visualization

11. Next-view guidance

12. Capture library

13. Depth recording

14. PLY seed generation

15. Splat viewer

16. Scene Mode
```

Do not let the agent jump ahead to splat rendering because it looks more visually interesting.

---

# 39. First coding-agent task

The initial handoff should be extremely narrow:

```text
Implement M0: WebXR Capture Capability Probe.

Create a TypeScript/Vite PWA intended primarily for Android Chrome.

Requirements:

1. Detect and display support for:
   - WebXR
   - immersive-ar
   - raw camera access if exposed
   - depth sensing
   - gyroscope
   - accelerometer
   - WebGPU
   - OPFS

2. Start an immersive AR session.

3. Display live:
   - XR frame rate
   - camera pose
   - tracking availability
   - projection matrix
   - derived/available camera intrinsics where possible
   - depth dimensions where available
   - gyro/accelerometer sample rates

4. Implement a diagnostic capture:
   - record approximately 20 useful frames
   - record camera transforms and timestamps
   - save images if raw camera access permits
   - record depth when available
   - record IMU samples

5. Persist captured data into OPFS.

6. Add an Export Diagnostics button producing a ZIP.

7. Keep platform/XR code separate from UI.

8. Add unit tests for matrix conversion and dataset serialization.

9. Document all unavailable/experimental APIs and graceful fallbacks.

Do not implement:
   - reconstruction
   - Gaussian splatting
   - capture guidance
   - cloud services
   - accounts
   - native Android

The milestone succeeds only when the resulting ZIP can be inspected and contains synchronized camera/pose data from a real Android phone.
```

That is where I would start the coding agent. The first few hours of this project should answer the hard question—**what precise reconstruction-quality data Chrome actually lets us extract from the phone**—before we build the rest around assumptions.
