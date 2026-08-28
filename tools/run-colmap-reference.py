#!/usr/bin/env python3
"""Build an independent PyCOLMAP reference model from an extracted capture."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

import pycolmap


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("capture_directory", type=Path)
    parser.add_argument("output_directory", type=Path)
    parser.add_argument("--matcher", choices=("sequential", "exhaustive"), default="sequential")
    parser.add_argument("--overlap", type=int, default=15)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    capture = args.capture_directory.resolve()
    output = args.output_directory.resolve()
    if output.exists():
        raise SystemExit(f"Refusing to overwrite existing output: {output}")
    if args.overlap < 1:
        raise SystemExit("--overlap must be positive")

    frames = read_jsonl(capture / "telemetry" / "frames.jsonl")
    image_frames = [frame for frame in frames if frame.get("imagePath")]
    if len(image_frames) < 3:
        raise SystemExit("Capture needs at least three image-bearing frames")
    first = image_frames[0]
    intrinsics = first["intrinsics"]
    camera_parameters = [
        intrinsics["fx"], intrinsics["fy"], intrinsics["cx"], intrinsics["cy"],
        0, 0, 0, 0,
    ]

    output.mkdir(parents=True)
    sparse = output / "sparse"
    sparse.mkdir()
    database = output / "database.db"
    reader = pycolmap.ImageReaderOptions(
        camera_model="OPENCV",
        camera_params=", ".join(str(value) for value in camera_parameters),
    )
    extraction = pycolmap.FeatureExtractionOptions(max_image_size=max(first["width"], first["height"]))
    pycolmap.extract_features(
        database,
        capture / "images",
        image_names=[Path(frame["imagePath"]).name for frame in image_frames],
        camera_mode=pycolmap.CameraMode.SINGLE,
        reader_options=reader,
        extraction_options=extraction,
        device=pycolmap.Device.cpu,
    )

    if args.matcher == "sequential":
        pairing = pycolmap.SequentialPairingOptions(overlap=args.overlap, quadratic_overlap=True)
        pycolmap.match_sequential(database, pairing_options=pairing, device=pycolmap.Device.cpu)
    else:
        pycolmap.match_exhaustive(database, device=pycolmap.Device.cpu)

    options = pycolmap.IncrementalPipelineOptions(multiple_models=False, max_num_models=1)
    models = pycolmap.incremental_mapping(
        database,
        capture / "images",
        sparse,
        options=options,
    )
    if not models:
        raise SystemExit("PyCOLMAP did not produce a reconstruction")
    model_id, reconstruction = max(models.items(), key=lambda entry: entry[1].num_reg_images())
    report = {
        "format": "open3dcapture-colmap-reference",
        "version": 1,
        "pycolmap": pycolmap.__version__,
        "captureDirectory": str(capture),
        "outputDirectory": str(output),
        "matcher": args.matcher,
        "overlap": args.overlap if args.matcher == "sequential" else None,
        "modelId": model_id,
        "registeredFrames": reconstruction.num_reg_images(),
        "totalFrames": len(image_frames),
        "points3D": reconstruction.num_points3D(),
        "meanReprojectionErrorPixels": reconstruction.compute_mean_reprojection_error(),
    }
    (output / "reference.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf8")
    print(json.dumps(report, indent=2))
    return 0


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf8").splitlines() if line]


if __name__ == "__main__":
    sys.exit(main())
