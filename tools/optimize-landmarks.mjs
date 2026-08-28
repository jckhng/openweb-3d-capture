#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  DEFAULT_LANDMARK_OPTIMIZER_CONFIG,
  optimizeLandmarkBundle,
} from "../src/refinement/multi-view-optimizer.ts";

const arguments_ = process.argv.slice(2);
const calibrationIndex = arguments_.indexOf("--calibration");
const calibrationPath = calibrationIndex >= 0 ? path.resolve(arguments_[calibrationIndex + 1]) : undefined;
if (calibrationIndex >= 0) arguments_.splice(calibrationIndex, 2);
const rotationOnlyIndex = arguments_.indexOf("--rotation-only");
const rotationOnly = rotationOnlyIndex >= 0;
if (rotationOnlyIndex >= 0) arguments_.splice(rotationOnlyIndex, 1);
const [captureArgument, constraintsArgument, outputArgument] = arguments_;
if (!captureArgument || !constraintsArgument || !outputArgument) {
  console.error("Usage: npm run optimize:landmarks -- <capture-directory> <feature-report.json> <output.json> [--calibration refinement.json] [--rotation-only]");
  process.exit(2);
}
const captureDirectory = path.resolve(captureArgument);
const constraintsPath = path.resolve(constraintsArgument);
const outputPath = path.resolve(outputArgument);
const frames = readJsonl(path.join(captureDirectory, "telemetry", "frames.jsonl"))
  .filter((frame) => frame.imagePath);
const benchmark = JSON.parse(fs.readFileSync(constraintsPath, "utf8"));
if (!benchmark.poseConstraints?.length) {
  throw new Error("Feature report has no poseConstraints; rerun benchmark:features with --include-constraints");
}
const calibrationOverride = calibrationPath
  ? JSON.parse(fs.readFileSync(calibrationPath, "utf8")).calibration
  : undefined;
const calibration = calibrationOverride ?? benchmark.visualTracking?.calibrationEstimate;
const intrinsics = calibration?.intrinsics ?? frames[0].intrinsics;
const distortion = calibration?.distortion;
const started = performance.now();
const result = optimizeLandmarkBundle(
  frames.map((frame) => ({
    id: frame.id,
    cameraToWorld: frame.webxrCameraToWorld ?? frame.cameraToWorld,
  })),
  benchmark.poseConstraints,
  intrinsics,
  distortion,
  { ...DEFAULT_LANDMARK_OPTIMIZER_CONFIG, optimizeTranslation: !rotationOnly },
);
const candidateById = new Map(result.poses.map((pose) => [pose.id, pose.cameraToWorld]));
const report = {
  format: "open3dcapture-multi-view-landmark-optimization",
  version: 1,
  captureDirectory,
  constraintsPath,
  method: "experimental WebXR-regularized multi-view landmark bundle refinement",
  optimizationMode: rotationOnly ? "SO3_WITH_WEBXR_CENTERS" : "SE3",
  calibrationSource: calibrationOverride ? calibrationPath : "feature-report",
  processingMilliseconds: performance.now() - started,
  calibration: calibration ?? { intrinsics, distortion },
  ...result,
  frames: frames.map((frame) => ({
    id: frame.id,
    webxrCameraToWorld: frame.webxrCameraToWorld ?? frame.cameraToWorld,
    phoneRefinedCameraToWorld: candidateById.get(frame.id),
  })),
};
atomicWrite(outputPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  outputPath,
  processingMilliseconds: report.processingMilliseconds,
  tracks: result.tracks,
  initial: result.initial,
  final: result.final,
  corrections: result.corrections,
  internalValidationPassed: result.internalValidationPassed,
  safeToExport: result.safeToExport,
  fallbackReason: result.fallbackReason,
}, null, 2)}\n`);

function readJsonl(filename) {
  return fs.readFileSync(filename, "utf8").split("\n").filter(Boolean).map(JSON.parse);
}

function atomicWrite(filename, data) {
  const temporary = `${filename}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, data);
  fs.renameSync(temporary, filename);
}
