#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { analyzeTargetImageQuality } from "../src/quality/sharpness.ts";
import { DEFAULT_QUALITY_SELECTOR_CONFIG } from "../src/keyframes/quality-selector.ts";

const captureDirectory = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
if (!captureDirectory) {
  console.error("Usage: npm run analyze:quality -- <capture-directory>");
  process.exit(2);
}

const frames = readJsonl(path.join(captureDirectory, "telemetry", "frames.jsonl"));
const decisions = readJsonl(path.join(captureDirectory, "debug", "session.jsonl"));
const acceptedByFrame = new Map(
  decisions.filter((decision) => decision.accepted).map((decision) => [decision.acceptedFrameId, decision]),
);
const accepted = frames
  .filter((frame) => frame.imagePath)
  .map((frame) => {
    const filename = path.join(captureDirectory, frame.imagePath);
    return {
      frameId: frame.id,
      candidateId: acceptedByFrame.get(frame.id)?.candidateId,
      previousSharpnessScore: acceptedByFrame.get(frame.id)?.sharpnessScore,
      ...analyzeTargetImageQuality(decodeTargetCrop(filename, frame.width, frame.height), 128, 128),
    };
  });

const rejectedDirectory = path.join(captureDirectory, "debug", "rejected");
const rejected = fs.existsSync(rejectedDirectory)
  ? fs.readdirSync(rejectedDirectory)
    .filter((name) => name.endsWith(".jpg"))
    .sort()
    .map((name) => ({
      candidateId: Number.parseInt(path.basename(name, ".jpg"), 10),
      ...analyzeTargetImageQuality(decodeImage(path.join(rejectedDirectory, name), 128, 128), 128, 128),
    }))
  : [];

process.stdout.write(`${JSON.stringify({
  format: "open3dcapture-image-quality-analysis",
  version: 1,
  captureDirectory,
  accepted: summarize(accepted),
  rejected: summarize(rejected),
}, null, 2)}\n`);

function summarize(values) {
  return {
    count: values.length,
    sharpness: distribution(values.map((value) => value.sharpnessScore)),
    texture: distribution(values.map((value) => value.textureScore)),
    belowAbsoluteSharpnessFloor: values
      .filter((value) => value.sharpnessScore < DEFAULT_QUALITY_SELECTOR_CONFIG.minimumSharpness).length,
    belowAbsoluteSharpnessFloorIds: values
      .filter((value) => value.sharpnessScore < DEFAULT_QUALITY_SELECTOR_CONFIG.minimumSharpness)
      .map((value) => value.candidateId ?? value.frameId),
    belowTextureFloor: values
      .filter((value) => value.textureScore < DEFAULT_QUALITY_SELECTOR_CONFIG.minimumTexture).length,
    belowTextureFloorIds: values
      .filter((value) => value.textureScore < DEFAULT_QUALITY_SELECTOR_CONFIG.minimumTexture)
      .map((value) => value.candidateId ?? value.frameId),
  };
}

function distribution(values) {
  if (!values.length) return { minimum: 0, median: 0, p90: 0, maximum: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    minimum: sorted[0],
    median: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    maximum: sorted.at(-1),
  };
}

function percentile(sorted, fraction) {
  return sorted[Math.floor((sorted.length - 1) * fraction)];
}

function readJsonl(filename) {
  return fs.readFileSync(filename, "utf8").split("\n").filter(Boolean).map(JSON.parse);
}

function decodeTargetCrop(filename, width, height) {
  const cropSize = Math.max(1, Math.floor(Math.min(width, height) * 0.6));
  const sourceX = Math.floor((width - cropSize) / 2);
  const sourceY = Math.floor((height - cropSize) / 2);
  return decodeImage(filename, 128, 128, ["-crop", `${cropSize}x${cropSize}+${sourceX}+${sourceY}`, "+repage"]);
}

function decodeImage(filename, width, height, operations = []) {
  const conversion = spawnSync(
    "convert",
    [filename, ...operations, "-resize", `${width}x${height}!`, "rgba:-"],
    { maxBuffer: width * height * 4 + 4096 },
  );
  if (conversion.error || conversion.status !== 0) {
    const detail = conversion.stderr?.toString().trim() || conversion.error?.message || `status ${conversion.status}`;
    throw new Error(`Could not decode ${filename}: ${detail}`);
  }
  if (conversion.stdout.byteLength !== width * height * 4) {
    throw new Error(`Decoded RGBA size mismatch for ${filename}`);
  }
  return new Uint8ClampedArray(conversion.stdout);
}
