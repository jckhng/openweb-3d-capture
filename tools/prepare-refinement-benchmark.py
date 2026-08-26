#!/usr/bin/env python3
"""Create a non-destructive dual-pose benchmark from a capture and COLMAP model."""

from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import shutil
import sys
from typing import Any

import cv2
import numpy as np
import pycolmap


CAMERA_BASIS = np.diag([1.0, -1.0, -1.0])


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("capture_directory", type=Path)
    parser.add_argument("colmap_model", type=Path)
    parser.add_argument("output_directory", type=Path)
    parser.add_argument(
        "--copy-assets",
        action="store_true",
        help="Materialize images/depth/pointcloud instead of creating local symlinks",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    capture_directory = args.capture_directory.resolve()
    model_directory = args.colmap_model.resolve()
    output_directory = args.output_directory.resolve()
    if output_directory.exists():
        raise SystemExit(f"Refusing to overwrite existing output: {output_directory}")

    frames = read_jsonl(capture_directory / "telemetry" / "frames.jsonl")
    capture = read_json(capture_directory / "capture.json")
    reconstruction = pycolmap.Reconstruction(model_directory)
    by_name = {
        Path(frame["imagePath"]).name: frame
        for frame in frames
        if frame.get("imagePath")
    }

    registered: list[tuple[dict[str, Any], Any, np.ndarray, np.ndarray]] = []
    for image in reconstruction.images.values():
        frame = by_name.get(Path(image.name).name)
        if frame is None:
            continue
        camera_from_world = np.asarray(image.cam_from_world().matrix(), dtype=np.float64)
        rotation_camera_from_world = camera_from_world[:, :3]
        translation_camera_from_world = camera_from_world[:, 3]
        rotation_world_from_camera = rotation_camera_from_world.T
        center = -rotation_world_from_camera @ translation_camera_from_world
        registered.append((frame, image, center, rotation_world_from_camera))

    if len(registered) < 3:
        raise SystemExit("Fewer than three COLMAP images match capture frame names")

    colmap_centers = np.stack([entry[2] for entry in registered])
    webxr_centers = np.stack([translation(np.asarray(entry[0]["cameraToWorld"])) for entry in registered])
    scale, alignment_rotation, alignment_translation = similarity_alignment(colmap_centers, webxr_centers)

    all_errors: list[float] = []
    refined_by_name: dict[str, dict[str, Any]] = {}
    translation_corrections: list[float] = []
    rotation_corrections: list[float] = []
    for frame, image, center, rotation_world_from_colmap_camera in registered:
        refined_rotation = alignment_rotation @ rotation_world_from_colmap_camera @ CAMERA_BASIS
        refined_center = scale * alignment_rotation @ center + alignment_translation
        refined_pose = homogeneous(refined_rotation, refined_center)
        raw_pose = np.asarray(frame["cameraToWorld"], dtype=np.float64)
        translation_correction = float(np.linalg.norm(refined_center - translation(raw_pose)))
        rotation_correction = rotation_angle(raw_pose[:3, :3], refined_rotation)
        errors = image_reprojection_errors(reconstruction, image)
        all_errors.extend(errors)
        translation_corrections.append(translation_correction)
        rotation_corrections.append(rotation_correction)
        refined_by_name[Path(image.name).name] = {
            "pose": refined_pose.tolist(),
            "translationCorrection": translation_correction,
            "rotationCorrection": rotation_correction,
            "errors": errors,
        }

    camera = next(iter(reconstruction.cameras.values()))
    calibration = calibration_from_colmap(camera)
    median_error = percentile(all_errors, 0.5)
    p90_error = percentile(all_errors, 0.9)
    registered_fraction = len(registered) / len(by_name)
    direct_train_ready = registered_fraction >= 0.95 and median_error <= 1.5 and p90_error <= 4.0
    fallback_reason = None if direct_train_ready else readiness_failure(
        registered_fraction,
        median_error,
        p90_error,
    )

    refinement = {
        "method": f"COLMAP/PyCOLMAP {pycolmap.__version__}",
        "calibration": calibration,
        "registeredFrameCount": len(registered),
        "totalFrameCount": len(by_name),
        "medianReprojectionErrorPixels": median_error,
        "p90ReprojectionErrorPixels": p90_error,
        "directTrainReady": direct_train_ready,
    }
    if fallback_reason:
        refinement["fallbackReason"] = fallback_reason

    enriched_frames: list[dict[str, Any]] = []
    for frame in frames:
        output = dict(frame)
        output["webxrCameraToWorld"] = frame["cameraToWorld"]
        image_name = Path(frame.get("imagePath", "")).name
        refined = refined_by_name.get(image_name)
        if refined:
            errors = refined["errors"]
            output["refinedCameraToWorld"] = refined["pose"]
            output["poseCorrection"] = {
                "translationMeters": refined["translationCorrection"],
                "rotationRadians": refined["rotationCorrection"],
            }
            output["visualValidation"] = {
                "observationCount": len(errors),
                "medianReprojectionErrorPixels": percentile(errors, 0.5),
                "p90ReprojectionErrorPixels": percentile(errors, 0.9),
            }
        enriched_frames.append(output)

    output_directory.mkdir(parents=True)
    place_directory(
        capture_directory / "images",
        output_directory / "images",
        args.copy_assets,
    )
    if (capture_directory / "depth").is_dir():
        place_directory(
            capture_directory / "depth",
            output_directory / "depth",
            args.copy_assets,
        )
    if (capture_directory / "pointcloud.ply").is_file():
        place_file(
            capture_directory / "pointcloud.ply",
            output_directory / "pointcloud.ply",
            args.copy_assets,
        )

    (output_directory / "telemetry").mkdir()
    write_jsonl(output_directory / "telemetry" / "frames.jsonl", enriched_frames)
    write_json(output_directory / "capture.json", capture)
    write_json(output_directory / "refinement.json", refinement)

    pointcloud_path = "pointcloud.ply" if (output_directory / "pointcloud.ply").exists() else None
    raw_transforms = build_transforms(enriched_frames, "webxr", None, pointcloud_path)
    refined_transforms = build_transforms(enriched_frames, "refined", calibration, pointcloud_path)
    write_json(output_directory / "transforms_webxr.json", raw_transforms)
    write_json(output_directory / "transforms_refined.json", refined_transforms)
    write_json(
        output_directory / "transforms.json",
        refined_transforms if direct_train_ready else raw_transforms,
    )

    colmap_output = output_directory / "colmap" / "sparse" / "0"
    colmap_output.mkdir(parents=True)
    reconstruction.write(colmap_output)
    reconstruction.write_text(colmap_output)
    if args.copy_assets:
        place_directory(capture_directory / "images", output_directory / "colmap" / "images", True)
    else:
        link_directory(output_directory / "images", output_directory / "colmap" / "images")

    report = {
        "captureId": capture.get("captureId"),
        "sourceCapture": str(capture_directory),
        "sourceColmapModel": str(model_directory),
        "toolVersions": {
            "pycolmap": pycolmap.__version__,
            "opencv": cv2.__version__,
            "numpy": np.__version__,
        },
        "alignment": {
            "scale": scale,
            "rotation": alignment_rotation.tolist(),
            "translation": alignment_translation.tolist(),
            "medianTranslationCorrectionMeters": percentile(translation_corrections, 0.5),
            "maximumTranslationCorrectionMeters": max(translation_corrections),
            "medianRotationCorrectionDegrees": math.degrees(percentile(rotation_corrections, 0.5)),
            "maximumRotationCorrectionDegrees": math.degrees(max(rotation_corrections)),
        },
        "refinement": refinement,
        "outputs": {
            "defaultTransforms": "transforms_refined.json" if direct_train_ready else "transforms_webxr.json",
            "spirulaDataset": str(output_directory),
            "lichtfeldColmapWorkspace": str(output_directory / "colmap"),
        },
    }
    write_json(output_directory / "benchmark.json", report)
    (output_directory / "README.txt").write_text(
        "Spirula/Nerfstudio: open this directory; transforms.json selects the readiness-approved pose set.\n"
        "LichtFeld/COLMAP: import colmap/images with colmap/sparse/0.\n"
        "Raw and refined poses remain in transforms_webxr.json, transforms_refined.json, and telemetry/frames.jsonl.\n",
        encoding="utf8",
    )
    print(json.dumps(report, indent=2))
    return 0


def calibration_from_colmap(camera: Any) -> dict[str, Any]:
    if camera.model_name != "OPENCV" or len(camera.params) != 8:
        raise SystemExit(f"Expected one OPENCV camera with eight parameters, received {camera.model_name}")
    fx, fy, cx, cy, k1, k2, p1, p2 = map(float, camera.params)
    return {
        "cameraModel": "OPENCV",
        "width": int(camera.width),
        "height": int(camera.height),
        "intrinsics": {"fx": fx, "fy": fy, "cx": cx, "cy": cy},
        "distortion": {"k1": k1, "k2": k2, "p1": p1, "p2": p2},
    }


def build_transforms(
    frames: list[dict[str, Any]],
    pose_source: str,
    calibration: dict[str, Any] | None,
    pointcloud_path: str | None,
) -> dict[str, Any]:
    image_frames = [frame for frame in frames if frame.get("imagePath")]
    if pose_source == "refined":
        image_frames = [frame for frame in image_frames if frame.get("refinedCameraToWorld")]
    first = image_frames[0]
    active_calibration = calibration or {
        "width": first["width"],
        "height": first["height"],
        "intrinsics": first["intrinsics"],
        "distortion": {"k1": 0.0, "k2": 0.0, "p1": 0.0, "p2": 0.0},
    }
    output = {
        "camera_model": "OPENCV",
        "fl_x": active_calibration["intrinsics"]["fx"],
        "fl_y": active_calibration["intrinsics"]["fy"],
        "cx": active_calibration["intrinsics"]["cx"],
        "cy": active_calibration["intrinsics"]["cy"],
        "k1": active_calibration["distortion"]["k1"],
        "k2": active_calibration["distortion"]["k2"],
        "p1": active_calibration["distortion"]["p1"],
        "p2": active_calibration["distortion"]["p2"],
        "w": active_calibration["width"],
        "h": active_calibration["height"],
        "pose_source": pose_source,
        "frames": [],
    }
    if pointcloud_path:
        output["ply_file_path"] = pointcloud_path
    for frame in image_frames:
        raw = frame["webxrCameraToWorld"]
        refined = frame.get("refinedCameraToWorld")
        selected = refined if pose_source == "refined" else raw
        output["frames"].append({
            "file_path": frame["imagePath"],
            "transform_matrix": selected,
            "transform_matrix_source": pose_source,
            "webxr_transform_matrix": raw,
            "refined_transform_matrix": refined,
        })
    return output


def image_reprojection_errors(reconstruction: Any, image: Any) -> list[float]:
    camera = reconstruction.cameras[image.camera_id]
    errors: list[float] = []
    for point2d in image.points2D:
        if not point2d.has_point3D():
            continue
        point3d = reconstruction.points3D[point2d.point3D_id]
        projected = camera.img_from_cam(image.cam_from_world() * point3d.xyz)
        if projected is not None and np.all(np.isfinite(projected)):
            errors.append(float(np.linalg.norm(np.asarray(point2d.xy) - np.asarray(projected))))
    return errors


def similarity_alignment(source: np.ndarray, target: np.ndarray) -> tuple[float, np.ndarray, np.ndarray]:
    source_mean = source.mean(axis=0)
    target_mean = target.mean(axis=0)
    source_centered = source - source_mean
    target_centered = target - target_mean
    covariance = target_centered.T @ source_centered / len(source)
    u, singular_values, vt = np.linalg.svd(covariance)
    signs = np.ones(3)
    if np.linalg.det(u @ vt) < 0:
        signs[-1] = -1
    rotation = u @ np.diag(signs) @ vt
    variance = np.mean(np.sum(source_centered * source_centered, axis=1))
    scale = float(np.sum(singular_values * signs) / variance)
    translation_value = target_mean - scale * rotation @ source_mean
    return scale, rotation, translation_value


def homogeneous(rotation: np.ndarray, position: np.ndarray) -> np.ndarray:
    output = np.eye(4)
    output[:3, :3] = rotation
    output[:3, 3] = position
    return output


def translation(matrix: np.ndarray) -> np.ndarray:
    return matrix[:3, 3]


def rotation_angle(a: np.ndarray, b: np.ndarray) -> float:
    cosine = np.clip((np.trace(a.T @ b) - 1.0) / 2.0, -1.0, 1.0)
    return float(np.arccos(cosine))


def readiness_failure(registered_fraction: float, median: float, p90: float) -> str:
    reasons = []
    if registered_fraction < 0.95:
        reasons.append(f"only {registered_fraction:.1%} of frames registered")
    if median > 1.5:
        reasons.append(f"median residual {median:.2f}px exceeds 1.50px")
    if p90 > 4.0:
        reasons.append(f"p90 residual {p90:.2f}px exceeds 4.00px")
    return "; ".join(reasons)


def percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    return float(np.percentile(np.asarray(values), fraction * 100.0))


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf8"))


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf8").splitlines() if line]


def write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf8")


def write_jsonl(path: Path, values: list[dict[str, Any]]) -> None:
    path.write_text("".join(json.dumps(value, separators=(",", ":")) + "\n" for value in values), encoding="utf8")


def link_directory(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    os.symlink(source, destination, target_is_directory=True)


def link_file(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    os.symlink(source, destination)


def place_directory(source: Path, destination: Path, copy_assets: bool) -> None:
    if not copy_assets:
        link_directory(source, destination)
        return
    destination.mkdir(parents=True)
    for source_file in source.rglob("*"):
        relative = source_file.relative_to(source)
        destination_file = destination / relative
        if source_file.is_dir():
            destination_file.mkdir(exist_ok=True)
        else:
            destination_file.parent.mkdir(parents=True, exist_ok=True)
            place_file(source_file, destination_file, True)


def place_file(source: Path, destination: Path, copy_asset: bool) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if not copy_asset:
        link_file(source, destination)
        return
    try:
        os.link(source, destination)
    except OSError:
        shutil.copy2(source, destination)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except BrokenPipeError:
        sys.exit(1)
