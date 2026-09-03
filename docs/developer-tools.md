# Developer tools

These commands operate locally. They do not upload captures.

## Analyze an existing capture

Replay readiness checks against a ZIP or extracted capture without modifying it:

```bash
npm run analyze:readiness -- /path/to/capture.zip
```

Compare the production sharpness score with the experimental attributed Sharp Frames hybrid score:

```bash
npm run analyze:quality -- /path/to/extracted-capture
```

The hybrid score is used to rank otherwise eligible destination-export frames. It does not control live frame acceptance.

## Validate an export

```bash
npm run validate -- /path/to/capture.zip
npm run validate -- /path/to/capture-directory
```

The validator checks Nerfstudio transforms and intrinsics, JPEG dimensions and references, synchronization state, frame counts and timestamps, pose motion, depth payloads, IMU and decision telemetry, the seed PLY, and visual-tracking output. Errors produce a non-zero exit status. Add `--json` for machine-readable output.

## Generate a seed point cloud

The converter requires ImageMagick's `convert` command and an extracted Archive capture containing synchronized RGB and CPU depth:

```bash
npm run pointcloud -- /path/to/capture-directory
```

It writes `pointcloud.ply` and adds `"ply_file_path": "pointcloud.ply"` to `transforms.json`. It refuses to replace an existing point cloud unless requested:

```bash
npm run pointcloud -- /path/to/capture-directory --force
```

## Build an independent COLMAP reference

The refinement tools use an isolated Python environment and do not replace the system COLMAP installation:

```bash
python3 -m venv .venv-refinement
.venv-refinement/bin/pip install -r tools/requirements-refinement.txt
```

Create a PyCOLMAP reference model from an extracted Archive capture:

```bash
npm run refine:colmap -- /path/to/capture /path/to/colmap-reference
```

The default sequential matcher uses 15-frame overlap with quadratic pairing. For difficult sequences:

```bash
npm run refine:colmap -- /path/to/capture /path/to/colmap-reference --matcher exhaustive
```

Convert a selected COLMAP sparse model into portable dual-pose output:

```bash
.venv-refinement/bin/python tools/prepare-refinement-benchmark.py \
  /path/to/capture \
  /path/to/colmap/sparse/0 \
  /path/to/refined-output \
  --copy-assets
```

The output contains:

- `transforms.json`: refined poses when at least 95% of images register and median/p90 reprojection errors are at most 1.5/4.0 pixels; otherwise raw WebXR poses.
- `transforms_webxr.json`: original metric WebXR poses.
- `transforms_refined.json`: registered visual poses aligned to the WebXR metric frame, with OPENCV calibration and distortion.
- `refinement.json`: registration, reprojection, calibration, and pose-selection result.
- `colmap/images` and `colmap/sparse/0`: portable COLMAP workspace.
- `pointcloud.ply`: metric seed cloud when present in the source Archive capture.

This desktop gate measures registration and reprojection. It does not replace inspection of subject coverage or reconstruction quality.

## Visual-tracking benchmark

Run the low-resolution visual-tracking pipeline against an extracted capture or derived dataset:

```bash
npm run benchmark:features -- /path/to/dataset \
  --output /path/to/feature-tracking.json
```

Add pairwise constraints for diagnostic optimization:

```bash
npm run benchmark:features -- /path/to/capture \
  --include-constraints \
  --output /path/to/feature-constraints.json
```

## Diagnostic pose experiments

The pairwise and multi-view optimizers are retained as negative controls and research tools. Their output is not considered safe for direct training and is never selected by the production phone export.

```bash
npm run optimize:poses -- \
  /path/to/capture \
  /path/to/feature-constraints.json \
  /path/to/pose-candidate.json

npm run optimize:landmarks -- \
  /path/to/capture \
  /path/to/feature-constraints.json \
  /path/to/landmark-candidate.json

npm run compare:poses -- \
  /path/to/pose-candidate.json \
  /path/to/refined-output/telemetry/frames.jsonl
```

`optimize:landmarks` also accepts `--rotation-only` and `--calibration /path/to/refinement.json`. Neither option enables refined production export.
