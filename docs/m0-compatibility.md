# M0 API compatibility

## Target-phone result — 24 August 2026

M0 passed on the tested Android/ARCore phone:

- 20 of 20 valid, correctly oriented, synchronized XR camera JPEGs at 886×1920;
- 20 of 20 tracked, finite camera-to-world poses with plausible motion;
- stable intrinsics (`fx` 1246.76, `fy` 1246.97, `cx` 443, `cy` 960);
- 20 CPU depth buffers at 160×90 in `luminance-alpha` format;
- 823 IMU samples at approximately 56 Hz;
- complete ZIP export after page reload, confirming OPFS persistence.

The remaining coordinate-convention check belongs to Gate 1: produce a recognizable reconstruction from an M1 dataset.

## Capability results

The initial probe reports API surface availability, not permission or per-session feature grants. `immersive-ar` is the only result backed by `navigator.xr.isSessionSupported()`.

| Capability | Probe meaning | Runtime proof |
| --- | --- | --- |
| WebXR | `navigator.xr` exists | XR session request succeeds |
| immersive AR | Browser reports session-mode support | XR session starts on the target device |
| raw XR camera | `XRWebGLBinding.prototype.getCameraImage` exists | `view.camera` is non-null and a JPEG is saved |
| depth | CPU or GPU depth API surface exists | CPU depth information and bytes are saved |
| gyro/accelerometer | `DeviceMotionEvent` exists | Non-empty samples are exported |
| OPFS | `navigator.storage.getDirectory` exists | Capture survives reload and exports afterward |

## Raw camera path

The session requests the optional `camera-access` feature. Inside the XR animation callback, the controller obtains the view-aligned opaque camera texture from `XRWebGLBinding`, samples it through an owned WebGL2 framebuffer, reads the pixels, vertically normalizes them, and encodes a JPEG.

This path is considered viable only after a target-phone export confirms:

- non-blank, correctly oriented JPEGs;
- JPEG dimensions match frame metadata;
- projection-derived intrinsics use those image dimensions;
- camera transforms and timestamps correspond to the sampled views.

The `getUserMedia()` fallback is diagnostic only. The WebXR Raw Camera Access explainer explicitly distinguishes it from pose-synchronized XR camera frames. The exporter preserves that distinction in frame telemetry.

## Depth path

The session requests `cpu-optimized` depth with `luminance-alpha` then `float32` preference and view matching. Each recorded frame retains:

- raw depth bytes;
- width and height;
- raw-value-to-meters scale;
- selected data format;
- normalized-view to normalized-depth-buffer transform.

GPU-only depth is not recorded in M0. Supporting it requires a separate texture readback implementation and format tests.

## Coordinate convention

Internal and exported poses are 4×4 row-major camera-to-world matrices in meters. WebXR matrices are converted once in `fromWebXRTransform()`. Nerfstudio conversion is isolated in `toNerfstudioTransform()` and is currently identity because both paths use right-handed, Y-up, negative-Z-forward camera coordinates.

This convention remains provisional until a real reconstruction or a known-world pose fixture verifies orientation and handedness end to end.
