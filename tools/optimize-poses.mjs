#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { optimizePoseGraph } from "../src/refinement/pose-optimizer.ts";

const [captureArgument, constraintsArgument, outputArgument] = process.argv.slice(2);
if (!captureArgument || !constraintsArgument || !outputArgument) {
  console.error("Usage: npm run optimize:poses -- <capture-directory> <feature-report.json> <output.json>");
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
const calibration = benchmark.visualTracking?.calibrationEstimate;
const intrinsics = calibration?.intrinsics ?? frames[0].intrinsics;
const distortion = calibration?.distortion;
const result = optimizePoseGraph(
  frames.map((frame) => ({
    id: frame.id,
    cameraToWorld: frame.webxrCameraToWorld ?? frame.cameraToWorld,
  })),
  benchmark.poseConstraints,
  intrinsics,
  distortion,
);
const refinedById = new Map(result.poses.map((pose) => [pose.id, pose.cameraToWorld]));
const report = {
  format: "open3dcapture-bounded-pose-optimization",
  version: 1,
  captureDirectory,
  constraintsPath,
  method: "experimental bounded coordinate descent over verified pairwise epipolar constraints",
  calibration: calibration ?? { intrinsics, distortion },
  ...result,
  frames: frames.map((frame) => ({
    id: frame.id,
    webxrCameraToWorld: frame.webxrCameraToWorld ?? frame.cameraToWorld,
    phoneRefinedCameraToWorld: refinedById.get(frame.id),
  })),
};
atomicWrite(outputPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  outputPath,
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
