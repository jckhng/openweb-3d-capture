# Project Plan: Open Web 3D Capture

## 0. Implementation status — 28 August 2026

Milestones 0 and 1 are accepted on the target phone. Milestone 2 deterministic quality selection is implemented and has produced multiple hardware captures. Incremental phone-worker visual tracking, bounded shared calibration, scale-aware recovery matching, and verified loop-closure discovery are implemented. The capture backpressure regression and deferred repair are validated on the target phone. Pairwise SE(3) correction is rejected. A bounded multi-view landmark prototype improves one reference capture and regresses another despite passing its internal score. On-phone pose refinement is therefore removed from the production critical path. M3 capture preflight, coverage guidance, and destination-specific Spirula/LichtFeld handoff are now the active product milestones.

Production decision:

> Open Web 3D Capture is a capture compiler and preflight system, not a mobile SfM replacement. The phone prevents irreversible capture defects and emits a validated, provenance-preserving package. Spirula Studio or LichtFeld Studio performs final visual registration before training.

The existing pose optimizers remain diagnostic negative controls. They must not produce a direct-train export or block capture-guidance work.

Implemented:

* Vite, React, TypeScript, PWA manifest, production service worker
* visible UTC build timestamp persisted into every new capture export
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
* 3×3 target-region Laplacian sharpness scoring with separate texture confidence
* pose-derived linear/angular motion scoring
* translation/rotation novelty selection
* explicit rejection reasons and live quality guidance
* durable per-candidate `debug/session.jsonl` telemetry
* depth-to-world back-projection with RGB sampling
* voxel-downsampled binary RGB `pointcloud.ply` generation during ZIP export
* Nerfstudio `ply_file_path` export and a desktop converter for existing captures
* center-depth target-distance telemetry and rejection below the provisional WebXR focus floor
* recalibrated sharpness normalization and conservative capture-motion limits
* non-destructive raw-WebXR and refined-pose dataset schema
* separate `transforms_webxr.json`, `transforms_refined.json`, and readiness-selected `transforms.json` exports
* portable Spirula/Nerfstudio and LichtFeld/COLMAP benchmark preparation tool
* isolated PyCOLMAP 4.1.1 refinement environment without replacing system COLMAP 3.6
* worker-safe low-resolution corner/BRIEF feature extraction, matching, and pose residual scoring prototype
* dedicated incremental browser worker for accepted synchronized frames
* pose-independent geometric edge verification and recovery matching
* persisted visual connectivity/readiness report with explicit downstream-SfM fallback
* bounded shared focal-scale and radial-distortion estimation
* hard gate preventing global pose optimization without a loop closure
* multi-scale oriented gradient descriptors for recovery and wider-baseline matching
* RANSAC-inlier-only residual and calibration scoring
* bounded disconnected-component repair and stricter loop-closure classification
* capture-time single-scale BRIEF separated from stop-time multi-scale recovery and loop matching
* bounded retained grayscale memory and capture/deferred worker timing telemetry
* 480-pixel live BRIEF tracking backed by retained 720-pixel grayscale for deferred repair
* recovery across all temporal separations, prioritized from adjacent breaks through verified loops
* visible deferred-repair progress while capture finalization is running
* texture-aware 3×3 target-region sharpness analysis with separate low-texture guidance
* bounded scene-adaptive sharpness threshold with a 0.38 absolute floor
* sampled 128×128 rejected-candidate crops for auditable quality calibration without per-rejection write pressure
* desktop PyCOLMAP reference reconstruction runner with shared OPENCV calibration
* diagnostic bounded SE(3) replay with immutable raw poses, explicit correction limits, held-out pairwise scoring, and continuity priors
* independent raw/candidate/COLMAP pose comparison gate that prevents the diagnostic correction from being exported as refined
* stable final-only feature identities, multi-view track joining, WebXR-initialized ray triangulation, robust landmark reprojection scoring, and bounded alternating pose/retriangulation replay
* independent similarity-gauge alignment for fair raw/candidate/COLMAP trajectory comparison
* hard per-pose and adjacent-correction bounds with raw-pose immutability and diagnostic-only output
* destination-independent capture-readiness report with explicit repair/risk reason codes
* object-centered twelve-sector azimuth coverage and low/level/high elevation analysis
* visual disconnection, weak adjacent bridge, and physical/visual loop-return checks
* minimal live orbit strip and post-capture `READY FOR SFM | ADD VIEWS | CAPTURE RISK` result
* separate canonical, Spirula native-SfM, and LichtFeld COLMAP-plugin ZIP profiles
* destination packages that retain WebXR provenance without root pose/reconstruction markers
* extracted-directory and ZIP dataset validator with Nerfstudio, image, pose, depth, PLY, and tracking checks
* informational centered target-region feature and geometric-inlier telemetry

Local verification:

```text
npm run build   PASS
npm test        PASS (69 tests)
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
* 105-frame M2 seesaw capture with valid synchronized RGB, depth, and WebXR poses
* seesaw depth seed cloud with 153,784 finite colored vertices and plausible world orientation
* all 105 seesaw frames registered by independent COLMAP reconstruction
* COLMAP sparse model with 13,276 points and 0.78-pixel mean reprojection error
* portable refined seesaw dataset at `E:\Share\capture-1787740492935-xhkfx7-refined`
* 105/105 refined frames with 0.63-pixel median and 1.75-pixel p90 observation residual
* refined poses remain aligned to the WebXR metric world and depth seed point cloud
* all 104 adjacent low-resolution feature pairs are usable; median pair residual improves from 1.07 pixels raw to 0.82 pixels refined
* zero of eight proposed non-adjacent pairs pass the initial loop-closure match floor
* worker-safe processing of all 105 low-resolution frames takes 5.08 seconds for extraction and 2.43 seconds for geometric matching, scoring, and shared calibration on the development desktop; phone performance remains unmeasured
* pose-independent replay connects 105/105 frames through 104 accepted visual edges, including one recovery edge
* raw visual graph residual is 1.09 pixels median and 5.09 pixels p90, indicating correction is required
* shared calibration replay estimates focal scale 1.0175 and radial k1 0.040; median residual falls to 0.96 pixels
* the reference COLMAP solution is approximately focal scale 1.0155 and radial k1 0.0548
* 145-frame second target-phone capture with all frames registered by PyCOLMAP 4.1.1
* second-capture sparse model with 82,743 points and 0.55-pixel mean reprojection error
* second-capture phone-safe hybrid replay connects 145/145 frames in one component and verifies eight loop closures separated by at least 48 frames
* those eight loop edges score 9.24–56.91 pixels under raw WebXR poses but 0.80–2.01 pixels under independently refined COLMAP poses, supporting real drift constraints rather than short-range overlap mislabeled as loops
* second-capture bounded shared calibration estimates focal scale 1.0125 and radial k1 0.070, compared with COLMAP's approximately 1.027–1.028 and 0.056; this is useful initialization but not yet accurate enough to replace joint pose/calibration refinement
* second-capture raw visual graph remains above the direct-train residual gate, so the current export correctly requests pose optimization or downstream SfM
* the upgraded seesaw replay remains connected but finds no verified loop closure and therefore still requests downstream SfM
* a 32-frame low-light plush capture exposed a regression from 0.27-second to 4.25-second candidate intervals, producing median adjacent gaps of 46.5 cm and 36.9 degrees and a ten-component phone graph
* desktop COLMAP still registered 32/32 low-light frames, but required median corrections of 10.9 cm and 6.25 degrees; this dataset is unsuitable as evidence for direct phone training
* deferred-refinement replay reduces capture-phase work to approximately 41 ms/frame on the 145-frame dataset while preserving 145/145 connectivity and all eight loop closures; only 45 frames require strong descriptors after stop
* deferred seesaw replay preserves 105/105 connectivity, correctly finds no loop, and upgrades only two frames after stop
* target-phone backpressure validation capture restores a 0.266-second median candidate interval and 0.292-second maximum interval across 113 accepted frames
* the same capture initially leaves only 18/113 frames in the largest phone visual component even though PyCOLMAP registers 113/113 with 0.40-pixel mean reprojection error
* 720-pixel deferred replay with 600 features and a 0.84 ratio connects 113/113 frames, verifies three loop closures, retains 27.0 MB grayscale, and completes deferred desktop work in 11.2 seconds
* independent refined poses score the three graph-bridging loop edges at 0.77, 1.13, and 1.69 pixels, confirming real overlap rather than false closures
* regression replay remains 105/105 with zero loops on the seesaw and 145/145 with six independently validated loops on the second capture
* a 51-frame bicycle capture validates 0.266-second candidate cadence, 63 ms mean/125.5 ms maximum capture-worker time, and 51/51 live visual connectivity
* that capture rejects 110/178 candidates as blur in three long viewpoint-dependent runs despite lower rejected-frame motion and visually usable accepted images, proving the single absolute Laplacian threshold confounds texture with focus
* the bicycle capture finishes 2.18 m from its starting camera and has no loop closure; final low-score runs starved the intended coverage rather than exposing a graph-repair failure
* the 142-frame build-identified validation capture preserves a 0.267-second median candidate interval, accepts 142/169 candidates, and connects all 142 frames in one phone-generated visual component
* independent PyCOLMAP 4.1.1 reconstruction registers 142/142 frames with 284,740 sparse points and 0.354-pixel mean reprojection error
* aligned COLMAP poses differ from WebXR by only 1.16 cm median/3.62 cm maximum translation and 0.77-degree median/1.25-degree maximum rotation, confirming WebXR remains a strong metric prior
* COLMAP refinement reduces the low-resolution median pair residual from 0.796 to 0.643 pixels and passes the desktop direct-train gate
* the bounded pairwise SE(3) prototype reduces its held-out loop residual from 7.13 to 2.66 pixels while staying within 4 cm and 1.31 degrees, but this apparent success is false: only 2/142 corrected poses move closer to COLMAP
* candidate-to-COLMAP error regresses from 1.15 to 1.35 cm median translation and from 0.76 to 0.80 degrees median rotation; pairwise epipolar scoring is therefore rejected as the final phone objective
* unified strong matching at temporal offsets 1/2/4 produces 403 accepted constraints, 1,500 selected tracks, 1,367 stable landmarks, 6,041 training observations, and 1,367 held-out observations on the 142-frame capture
* the bounded multi-view replay takes approximately 0.40 seconds after matching and reduces held-out median/p90 landmark residual from 2.58/6.55 to 2.34/5.69 pixels
* after independent similarity alignment, the same candidate improves 142-frame median translation from 1.16 to 1.08 cm and median rotation from 0.76 to 0.70 degrees; p90 also improves, but maximum translation error regresses and only 39% of frames improve in both measures
* the same fixed configuration produces 1,186 landmarks on the independent 145-frame dataset and improves held-out landmark residual, yet median COLMAP disagreement regresses from 1.79 to 1.80 cm and from 1.34 to 1.36 degrees
* known COLMAP calibration does not remove the 142-frame translation outliers; track geometry and the alternating optimizer remain the primary limitations
* unified deferred matching costs approximately 61–70 seconds on the development desktop versus less than 0.5 seconds for track joining, triangulation, and pose replay; the current matcher is not phone-ready
* direct Spirula Studio import and training of the WebXR/seed-cloud export succeeds; raw-pose registration quality remains inadequate without downstream SfM

M2 calibration findings:

* 105 of 118 seesaw candidates were accepted; 9 were rejected for motion and 4 as redundant.
* no candidate was rejected for blur because the current normalized sharpness score compressed into 0.876–0.984.
* an independent Laplacian measurement found approximately 1.7× variation between the softest and sharpest source frames.
* recalibrated sharpness replay spans 0.370–0.836 and rejects 7 of 118 candidates (5.9%) at the provisional 0.50 threshold.
* motion replay rejects 39 of 118 candidates (33.1%) at 0.40 m/s or 0.45 rad/s; the initially proposed tighter limits would have rejected approximately 90% and were discarded.
* a universal sharpness threshold also fails in the opposite direction: the bicycle capture rejects 61.8% at 0.50, while provisional floors of 0.42 and 0.40 would reject 19.7% and 11.8% before multi-region adaptation.
* variance of Laplacian measures available high-frequency energy, not focus independently; smooth objects, blank backgrounds, crop placement, and backlighting require separate texture confidence and scene adaptation.
* the seesaw was confirmed rigid during capture; scene motion is not the explanation for duplication.
* after global similarity alignment, COLMAP and WebXR poses differ by a median 1.6 cm and 0.92 degrees.
* COLMAP refined focal lengths by approximately 1.5% and estimated non-zero radial/tangential distortion omitted by the WebXR pinhole export.
* reconstruction duplication is therefore a systematic camera-model and trajectory-accuracy problem, not only a small set of removable pose outliers.

Close-focus findings:

* ARCore currently defaults most supported cameras to fixed focus for tracking.
* WebXR raw camera access exposes the aligned camera texture but no autofocus, lens selection, or focus-distance control.
* the web recorder cannot recover optical detail that was never focused; it must reject too-close/soft frames and declare a minimum supported capture scale.
* the provisional minimum target distance is 0.45 m and requires calibration on the target phone.
* WebXR remains useful as a synchronized metric pose, depth, motion, and capture-guidance source even when its camera frames are unsuitable for close-range reconstruction.
* the seesaw comparison supports treating WebXR as a strong prior rather than a final solution: after similarity alignment, its poses are close to the independent COLMAP result, but the refined reconstruction is materially better.
* the product must not require the sensor that supplies navigation to also be the only source of reconstruction imagery.
* autofocus is not sufficient by itself: capture must wait for focus convergence and a stationary lens, otherwise focus scans create blurred frames and changing effective intrinsics.

Required before declaring M2 complete:

1. Deploy the recalibrated M2 recorder and exercise close range, blur, fast motion, stationary/redundant views, and tracking loss.
2. Confirm the compact HUD gives the correct single instruction and remains operable during XR.
3. Capture 50–100 accepted frames and inspect `debug/session.jsonl` rejection distributions.
4. Adjust thresholds if rejection rates or reconstruction quality show systematic errors.
5. Reconstruct the filtered dataset and compare visible floaters with the M1 chair baseline.
6. Verify the 0.45 m distance gate against a printed high-frequency target at 0.25, 0.35, 0.45, and 0.60 m.
7. Confirm the recalibrated blur and motion limits still allow a deliberate 50–100-frame orbit.
8. Record the minimum object size that retains identifiable detail at the calibrated focus floor; constrain web v1 scope if necessary.

Plan constraints clarified by implementation:

* API-surface detection is not proof of a granted WebXR feature; the live session is authoritative.
* `getUserMedia()` frames are not pose-synchronized and cannot satisfy Gate 0 or Gate 1. They remain a diagnostic fallback and are marked as unsynchronized in telemetry.
* M0 requests CPU depth only. GPU depth readback is deferred until a target device demonstrates it is needed.
* M3 coverage guidance is now unblocked. Continue calibrating M2 quality thresholds, but do not make universal blur thresholds or phone pose refinement prerequisites for guidance work.
* M5 seed generation was pulled forward for interoperability experiments. It does not replace downstream SfM or block M3.
* WebXR poses are metric navigation priors, not reconstruction-grade final poses. Production training uses downstream visual SfM.
* Current Spirula desktop builds can run native SfM from raw photos/video. LichtFeld can run COLMAP reconstruction through its plugin. Exports must make both paths explicit.
* The deferred phase split restores sub-second candidate cadence on the target phone. Do not start SE(3) work until the higher-resolution deferred repair is deployed and confirms a connected graph without capture regression or false loops.
* Registration percentage and reprojection error alone can produce a false-positive readiness result when features lie mainly on the background. Centered target-region feature/inlier telemetry is now recorded, but minimum sampling and coverage thresholds still require calibration before trusting desktop or phone `directTrainReady` for object capture.
* The current approach is fail-safe but not yet universally reconstruction-robust: it preserves raw data, gates unverified refinement, and falls back to downstream SfM, but fixed-focus WebXR imposes an unrecoverable optical-quality limit for small or close subjects.
* Do not couple the open dataset schema to one capture frontend. WebXR, an autofocus-photo fallback, and any future native precision frontend must produce the same raw/refined provenance model and downstream-compatible exports.

## 1. Objective

Build an open-source, local-first web application that turns an Android phone into a **guided 3D capture instrument**.

The app does **not** perform full Gaussian-splat reconstruction in v1.

Its job is to:

1. access camera + WebXR tracking data,
2. select useful reconstruction keyframes,
3. validate image quality, overlap, connectivity, and capture completeness while the user can still correct them,
4. guide the user toward missing viewpoints and weak visual connections,
5. retain useful camera/depth/IMU telemetry,
6. save everything locally on-device,
7. export a canonical capture archive plus explicit downstream packages for:

   * Brush
   * Spirula Studio
   * LichtFeld Studio
   * Nerfstudio-compatible tooling
8. optionally load the resulting splat back onto the phone for viewing.

Core philosophy:

> Capture once. Detect omissions before leaving. Keep the raw data. Reconstruct anywhere.

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

Do not attempt as production v1 scope:

* iOS/Safari parity
* Firefox
* desktop capture
* a production APK/native Android application
* broad device compatibility

during v1.

A bounded native Android camera feasibility spike is permitted after the destination adapters and capture-preflight workflow are validated. It addresses the fixed-focus operating envelope, not phone SfM, and must export the same open dataset schema as the web recorder.

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
Preflight checks:
  - image quality
  - target coverage
  - overlap/connectivity
  - closure/bridge views
   ↓
READY | ADD SPECIFIC VIEWS | CAPTURE RISK
   ↓
Dataset remains stored locally
   ↓
Choose destination:
  SPIRULA | LICHTFELD | CANONICAL ARCHIVE
   ↓
destination-safe package
   ↓
PC
   ↓
downstream SfM in Spirula or LichtFeld
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

# 12A. Close-focus and minimum object scale

WebXR does not expose ARCore focus mode or lens selection. Treat optical focus as an input constraint, not a post-processing problem.

When CPU depth is available:

```text
sample center depth
    ↓
below calibrated focus floor
    → reject: too-close
```

The initial focus floor is 0.45 m. Calibrate it with a printed high-frequency target at several distances on the primary phone.

Required behavior:

* show target distance before and during capture
* distinguish `too-close` from motion blur
* never accept a close frame merely because it contains high-contrast blurred edges
* retain sharpness as the final authority when depth is missing or the object does not occupy the center
* document the minimum practical object size at the calibrated distance

If small-object detail remains inadequate at the focus floor, constrain web v1 to medium objects. Autofocus, macro-lens selection, and manual focus require a native Android capture path unless WebXR adds controls.

---

# 12B. Pose sensor versus reconstruction camera

Architectural decision:

> WebXR is a navigation and measurement source. It is not required to be the final reconstruction-image source or the final pose authority.

The capture system has two distinct information channels:

```text
navigation channel
WebXR / ARCore pose + depth + IMU
    ↓
metric scale, overlap prediction, motion guidance,
pair selection, correction bounds, coverage

reconstruction channel
sharp, calibrated camera keyframes
    ↓
features, visual refinement, final training images
```

The channels may come from the same synchronized WebXR frame when optical quality is adequate. They may be separated when fixed focus prevents the subject from being recorded sharply.

WebXR poses remain useful even when replaced in the final transform file because they:

* reduce visual matching from an unrestricted all-pairs search to likely overlapping neighbors
* provide approximate metric scale and gravity/world orientation
* enable live speed, baseline, redundancy, and coverage guidance
* regularize phone pose corrections and reject physically implausible solutions
* provide an immediate raw-pose export when visual refinement cannot run

Never overwrite this information. Preserve raw WebXR, experimental refined, and downstream-SfM poses independently with explicit provenance. Production exports must treat downstream SfM as the final pose authority.

## Capture-path spectrum

### Standard WebXR mode — v1

Use synchronized WebXR images and poses for medium objects, furniture, and environments that lie inside the calibrated sharp-focus envelope.

Properties:

* zero installation and lowest capture friction
* best browser-accessible pose/image synchronization
* live depth, motion, and coverage guidance where available
* fixed-focus optical floor on the current platform
* downstream visual SfM required before training

### Autofocus photo/SfM fallback — candidate web mode

Use ordinary browser camera capture for sharper images, but do not claim that those images inherit synchronized WebXR poses.

Properties:

* preserves the zero-install path for small or close subjects
* exports photos explicitly as unposed or approximately guided
* routes to Spirula native SfM or LichtFeld COLMAP
* exports unposed reconstruction images rather than pretending asynchronous photos inherit WebXR poses

This is preferable to attaching stale or guessed WebXR transforms to autofocus images.

### WebXR plus browser autofocus hybrid — experimental only

Concurrent or interleaved WebXR and `getUserMedia()` capture has unresolved camera ownership, frame-time alignment, lens-state, intrinsics, and relocalization risks. A two-pass variant may use WebXR to survey an orbit and then capture autofocus photographs, but the photographs still require visual registration.

Do not make this hybrid the product foundation without measured cross-stream synchronization and calibration evidence.

### Native precision mode — post-v1 candidate

A thin Android capture frontend may retain ARCore as the navigation source while using ARCore autofocus or Shared Camera/Camera2 for controlled, high-quality keyframes.

Required properties:

* same capture and export schema as the web application
* sensor timestamps and per-frame camera metadata
* autofocus state, lens state, focus distance/range, exposure, and available intrinsic/distortion metadata
* capture only after focus convergence, lens stability, acceptable motion, and sharpness validation
* raw ARCore poses retained as priors; final poses remain visually validated/refined
* device capability detection and graceful fallback

Shared Camera stream counts and high-resolution still support vary by device. Its hardware-depth behavior also differs from a normal ARCore session. Treat these as measured device capabilities, not architectural assumptions.

## Focus-aware keyframe policy

Continuous autofocus can introduce focus sweeps and focus breathing. Precision capture should therefore use an event-driven keyframe policy:

```text
aim at subject
    ↓
request/allow focus
    ↓
wait for focused state + stationary lens
    ↓
wait for low camera motion
    ↓
measure subject-region sharpness
    ↓
capture keyframe and save lens/camera metadata
```

Reject or defer frames while the lens is scanning. Prefer stable sharp keyframes over a high frame count. If focus changes materially during an orbit, represent the corresponding intrinsics per frame or split frames into calibration groups rather than forcing one shared camera model.

## Architecture validation experiment

Before committing to a native precision frontend, capture the same rigid textured target under fixed lighting and approximately identical motion at 0.25, 0.35, 0.45, 0.60, and 1.00 m using:

1. current WebXR fixed-focus capture
2. ordinary web autofocus photos routed through downstream SfM
3. a minimal native ARCore `AUTO` and, where supported, Shared Camera/Camera2 prototype

Record and compare:

```text
subject-region sharpness / printed-target detail
focus state, lens state, and focus distance
image and pose timestamp relationship
intrinsics stability and distortion estimate
valid feature count and pair connectivity
registered-frame percentage
median and p90 reprojection residual
pose corrections relative to WebXR
duplicate edges, floaters, and missing detail in reconstruction
processing time, thermal behavior, and capture failure rate
```

Decision rules:

* if WebXR meets the sharpness and reconstruction gates beyond a calibrated distance, retain it as Standard Capture with an explicit operating envelope
* if autofocus photographs are materially sharper but cannot be synchronized robustly in-browser, use web photo/SfM as the fallback and pursue native Precision Capture
* if ARCore `AUTO` alone supplies stable sharp synchronized frames, prefer the simpler native path over Shared Camera complexity
* use Shared Camera only when its added resolution, metadata, or focus control materially improves reconstruction on supported devices
* retain downstream SfM regardless; no capture frontend may label its supplied WebXR or experimental poses direct-train ready

This creates progressive product tiers rather than forcing one mechanism to cover incompatible operating ranges:

```text
STANDARD CAPTURE
WebXR, zero install, calibrated medium/large-subject envelope

PRECISION CAPTURE
native candidate, controlled focus and metadata for small/close subjects

PHOTO/SFM FALLBACK
sharp images, no trusted supplied poses, downstream reconstruction required
```

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

# 14A. Capture preflight and downstream reconstruction

WebXR pose, depth, and IMU are capture-time navigation priors. They organize images, estimate coverage, identify likely overlap, detect tracking discontinuities, and preserve metric context. They are not production training poses.

Production pipeline:

```text
accepted WebXR keyframe
    ↓
low-resolution feature extraction in a worker
    ↓
quality, target-support, and likely-overlap checks
    ↓
coverage graph and weak-bridge detection
    ↓
specific capture repair instruction while on site
    ↓
canonical archive + destination adapter
    ↓
final SfM in Spirula or LichtFeld
```

Phone preflight constraints:

* process accepted keyframes incrementally without attempting production bundle adjustment
* use WebXR poses to restrict likely-overlap checks and maintain a live coverage model
* distinguish optical blur, low texture, excessive motion, redundancy, missing coverage, and weak graph bridges
* run feature work outside the UI/XR thread
* show one actionable instruction at a time; keep diagnostics out of the primary viewfinder
* retain raw images, WebXR poses, experimental poses, quality evidence, and coverage evidence independently
* always allow canonical raw export; label risk instead of presenting phone poses as reconstruction-ready

Readiness report should include:

```text
accepted image count and quality distribution
target-region feature support
azimuth and elevation coverage
likely-overlap graph connectivity
weak bridges and tracking discontinuities
loop-return status
READY FOR DOWNSTREAM SFM | ADD SPECIFIC VIEWS | CAPTURE RISK
```

Production reconstruction paths:

* Spirula Studio native raw-photo/video SfM
* LichtFeld Studio COLMAP Reconstruction plugin
* project desktop tools for validation and regression analysis only

Destination-adapter rules:

* retain one canonical archive as the source of truth
* emit a Spirula photo-input package that cannot be mistaken for an already reconstructed `transforms.json`, `sparse/`, or `colmap/` dataset
* emit a LichtFeld image-input package for its COLMAP Reconstruction plugin without presenting WebXR poses as COLMAP output
* preserve WebXR poses under telemetry/provenance paths in both workflows
* provide destination-specific instructions and record the selected adapter in the export manifest
* do not duplicate image bytes inside the canonical archive merely to create adapter aliases

Phone-refinement experiment result:

* raw and refined poses are preserved independently and exported through separate standard transform files
* PyCOLMAP 4.1.1 registers 105/105 seesaw frames with 0.63-pixel median and 1.75-pixel p90 observation residual
* the TypeScript low-resolution tracker connects every adjacent pair and measures lower residual for refined poses
* the initial BRIEF loop candidates do not produce enough matches; do not start pose optimization from this graph yet
* pose-independent RANSAC plus recovery edges connect the complete sequence without trusting WebXR residuals as the connectivity test
* bounded focal-scale/k1 estimation recovers the direction and magnitude of the independent COLMAP calibration
* the hybrid multi-scale matcher connects all 145 frames of the second phone capture and verifies eight long-range loop closures
* independent COLMAP poses reduce the accepted loop-edge residuals from 9.24–56.91 pixels to 0.80–2.01 pixels, validating their use as pose-drift constraints
* the same hybrid matcher does not fabricate a loop closure on the seesaw sequence

Experiment conclusion:

* the phone-generated visual graph is useful for preflight and bridge detection
* bounded pairwise and multi-view corrections do not generalize sufficiently to become final poses
* internal reprojection improvement is not a safe proxy for independent trajectory improvement
* full mobile SfM and bundle adjustment are no longer v1 requirements
* retain the experiments for regression research; do not expose them in the normal capture or export workflow

Next production bound:

1. validate the new readiness guidance on the target phone and tune only thresholds that produce demonstrated false prompts
2. run the same capture set through Spirula native SfM and the LichtFeld COLMAP plugin; record registration rate, reconstruction quality, manual steps, and handoff time
3. add sector-specific repair visualization or representative thumbnails when a text/strip instruction is insufficient to locate a weak bridge
4. add an autofocus photo path or native precision spike only for subjects outside WebXR's calibrated focus envelope

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

Implementation status:

* `npm run validate -- <capture-directory-or-zip>` accepts extracted captures and direct ZIP exports
* validates transforms, finite homogeneous poses, intrinsics, JPEG references and dimensions, timestamps, pose extent/baseline, synchronized WebXR images, depth payload sizes, telemetry counts, binary RGB PLY contents, and visual-tracking safety fields
* `--json` provides machine-readable output and validation errors return a non-zero exit status
* target-region and object-coverage thresholds remain informational until calibrated on hardware

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
* a production native Android application during v1
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

## Gate 1A — capture-preflight usefulness

For a rigid, textured target, the phone must identify defects the user can still repair:

```text
blur or insufficient target detail
missing azimuth/elevation regions
weak overlap bridges
tracking discontinuities
failure to close the orbit
```

The normal workflow must never label WebXR or experimental mobile-refinement poses as direct-train ready. Canonical export remains available when preflight reports risk.

---

## Gate 2 — interoperability

The same canonical capture can be handed to both production destinations without manual file rearrangement:

```text
Spirula native photo SfM
LichtFeld COLMAP Reconstruction plugin
```

Each destination must reconstruct from images rather than silently accepting WebXR transforms as final poses.

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

9. Close-focus and calibrated blur rejection

10. Object target and spherical coverage model

11. Capture-readiness report and reason codes

12. Weak-bridge and missing-region repair guidance

13. Minimal single-instruction capture HUD and post-capture repair flow

14. Spirula native-SfM export adapter

15. LichtFeld COLMAP-plugin export adapter

16. Cross-destination reconstruction regression suite

17. Controlled web-versus-native focus architecture experiment

18. Capture library

19. Depth recording

20. PLY seed generation

21. Splat viewer

22. Scene Mode

23. On-phone pose refinement research, only after production gates pass
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
