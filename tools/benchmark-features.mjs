#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { extractImageFeatures, matchImageFeatures } from "../src/refinement/features.ts";
import { scoreEpipolarConsistency } from "../src/refinement/reprojection.ts";

const arguments_ = process.argv.slice(2);
const outputIndex = arguments_.indexOf("--output");
const outputPath = outputIndex >= 0 ? path.resolve(arguments_[outputIndex + 1]) : undefined;
if (outputIndex >= 0) arguments_.splice(outputIndex, 2);
const captureDirectory = arguments_[0] ? path.resolve(arguments_[0]) : undefined;
if (!captureDirectory) {
  console.error("Usage: npm run benchmark:features -- <capture-directory> [--output report.json]");
  process.exit(2);
}

const frames = fs.readFileSync(path.join(captureDirectory, "telemetry", "frames.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map(JSON.parse)
  .filter((frame) => frame.imagePath);
const refinementPath = path.join(captureDirectory, "refinement.json");
const refinement = fs.existsSync(refinementPath) ? JSON.parse(fs.readFileSync(refinementPath, "utf8")) : undefined;
const decodeStarted = performance.now();
const decoded = frames.map((frame) => decodeGray(
  path.join(captureDirectory, frame.imagePath),
  frame.width,
  frame.height,
));
const extractionStarted = performance.now();
const features = decoded.map((image) => extractImageFeatures(image, {
  maximumFeatures: 450,
  fastThreshold: 18,
  cellSize: 12,
}));
const matchingStarted = performance.now();

const pairs = adjacentPairs(frames.length);
for (const pair of loopPairs(frames, 8)) pairs.push(pair);
const pairReports = pairs.map(([indexA, indexB, kind]) => {
  const matches = matchImageFeatures(features[indexA], features[indexB]);
  const pointMatches = matches.map((match) => ({
    pointA: sourcePoint(features[indexA][match.featureA], decoded[indexA], frames[indexA]),
    pointB: sourcePoint(features[indexB][match.featureB], decoded[indexB], frames[indexB]),
  }));
  const raw = scoreEpipolarConsistency(
    pointMatches,
    frames[indexA].webxrCameraToWorld ?? frames[indexA].cameraToWorld,
    frames[indexB].webxrCameraToWorld ?? frames[indexB].cameraToWorld,
    frames[indexA].intrinsics,
  );
  let refined;
  if (frames[indexA].refinedCameraToWorld && frames[indexB].refinedCameraToWorld && refinement) {
    refined = scoreEpipolarConsistency(
      pointMatches,
      frames[indexA].refinedCameraToWorld,
      frames[indexB].refinedCameraToWorld,
      refinement.calibration.intrinsics,
      refinement.calibration.distortion,
    );
  }
  return {
    kind,
    frameA: frames[indexA].id,
    frameB: frames[indexB].id,
    featuresA: features[indexA].length,
    featuresB: features[indexB].length,
    matches: matches.length,
    raw,
    refined,
  };
});

const usable = pairReports.filter((pair) => pair.matches >= 12);
const adjacentUsable = usable.filter((pair) => pair.kind === "adjacent");
const loopUsable = usable.filter((pair) => pair.kind === "loop");
const completed = performance.now();
const report = {
  format: "open3dcapture-feature-benchmark",
  version: 1,
  captureDirectory,
  configuration: {
    maximumDimension: 480,
    maximumFeatures: 450,
    descriptor: "FAST/Shi-Tomasi + BRIEF-256",
    matcher: "mutual Hamming + ratio 0.8",
    minimumUsableMatches: 12,
  },
  frames: frames.length,
  meanFeatures: mean(features.map((value) => value.length)),
  pairs: pairReports.length,
  usablePairs: usable.length,
  usableAdjacentPairs: adjacentUsable.length,
  usableLoopPairs: loopUsable.length,
  timingsMilliseconds: {
    desktopDecode: extractionStarted - decodeStarted,
    workerSafeExtraction: matchingStarted - extractionStarted,
    workerSafeMatchingAndScoring: completed - matchingStarted,
  },
  rawMedianPairResidualPixels: median(adjacentUsable.map((pair) => pair.raw.medianPixels)),
  refinedMedianPairResidualPixels: median(adjacentUsable.map((pair) => pair.refined?.medianPixels).filter(Number.isFinite)),
  pairReports,
};
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (outputPath) atomicWrite(outputPath, serialized);
process.stdout.write(serialized);

function adjacentPairs(length) {
  return Array.from({ length: Math.max(0, length - 1) }, (_, index) => [index, index + 1, "adjacent"]);
}

function loopPairs(values, maximumPairs) {
  const candidates = [];
  for (let a = 0; a < values.length; a += 1) {
    for (let b = a + 20; b < values.length; b += 1) {
      const poseA = values[a].webxrCameraToWorld ?? values[a].cameraToWorld;
      const poseB = values[b].webxrCameraToWorld ?? values[b].cameraToWorld;
      const distance = Math.hypot(
        poseA[0][3] - poseB[0][3],
        poseA[1][3] - poseB[1][3],
        poseA[2][3] - poseB[2][3],
      );
      candidates.push({ a, b, distance });
    }
  }
  candidates.sort((first, second) => first.distance - second.distance);
  const selected = [];
  for (const candidate of candidates) {
    if (selected.some(([a, b]) => Math.abs(a - candidate.a) < 5 || Math.abs(b - candidate.b) < 5)) continue;
    selected.push([candidate.a, candidate.b, "loop"]);
    if (selected.length === maximumPairs) break;
  }
  return selected;
}

function decodeGray(filename, sourceWidth, sourceHeight) {
  const maximumDimension = 480;
  const scale = maximumDimension / Math.max(sourceWidth, sourceHeight);
  const width = Math.max(17, Math.round(sourceWidth * scale));
  const height = Math.max(17, Math.round(sourceHeight * scale));
  const conversion = spawnSync("convert", [filename, "-resize", `${width}x${height}!`, "gray:-"], {
    maxBuffer: width * height + 4096,
  });
  if (conversion.error || conversion.status !== 0) {
    const detail = conversion.stderr?.toString().trim() || conversion.error?.message || `status ${conversion.status}`;
    throw new Error(`Could not decode ${filename}: ${detail}`);
  }
  if (conversion.stdout.byteLength !== width * height) {
    throw new Error(`Decoded grayscale size mismatch for ${filename}`);
  }
  return { width, height, data: new Uint8Array(conversion.stdout) };
}

function sourcePoint(feature, image, frame) {
  return [feature.x * frame.width / image.width, feature.y * frame.height / image.height];
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function atomicWrite(filename, data) {
  const temporary = `${filename}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, data);
  fs.renameSync(temporary, filename);
}
