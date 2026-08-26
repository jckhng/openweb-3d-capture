#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { generateSeedPointCloud } from "../src/pointcloud/generate.ts";

const arguments_ = process.argv.slice(2);
const forceIndex = arguments_.indexOf("--force");
const force = forceIndex >= 0;
if (force) arguments_.splice(forceIndex, 1);
const captureDirectory = arguments_[0] ? path.resolve(arguments_[0]) : undefined;
if (!captureDirectory) {
  console.error("Usage: npm run pointcloud -- <capture-directory> [--force]");
  process.exit(2);
}

const framesPath = path.join(captureDirectory, "telemetry", "frames.jsonl");
const transformsPath = path.join(captureDirectory, "transforms.json");
const pointCloudPath = path.join(captureDirectory, "pointcloud.ply");
if (!force && fs.existsSync(pointCloudPath)) {
  console.error(`Refusing to overwrite ${pointCloudPath}; pass --force to regenerate it.`);
  process.exit(2);
}

const frames = fs.readFileSync(framesPath, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const sources = frames
  .filter((frame) => frame.imagePath && frame.depthPath && frame.normDepthBufferFromNormView)
  .map((frame) => ({
    frame,
    loadDepth: async () => fs.readFileSync(path.join(captureDirectory, frame.depthPath)),
    loadImage: async () => decodeImage(path.join(captureDirectory, frame.imagePath), frame.width, frame.height),
  }));

const result = await generateSeedPointCloud(sources);
if (!result) {
  console.error("No usable synchronized RGB/depth samples were available.");
  process.exit(1);
}

atomicWrite(pointCloudPath, result.data);
const transforms = JSON.parse(fs.readFileSync(transformsPath, "utf8"));
transforms.ply_file_path = "pointcloud.ply";
atomicWrite(transformsPath, `${JSON.stringify(transforms, null, 2)}\n`);
console.log(JSON.stringify({
  captureDirectory,
  sourceFrames: sources.length,
  sampledPoints: result.sampledPointCount,
  outputPoints: result.pointCount,
  bounds: result.bounds,
  pointCloudPath,
  transformsPath,
}, null, 2));

function decodeImage(filename, sourceWidth, sourceHeight) {
  const maximumDimension = 256;
  const scale = maximumDimension / Math.max(sourceWidth, sourceHeight);
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const conversion = spawnSync("convert", [
    filename,
    "-resize",
    `${width}x${height}!`,
    "rgba:-",
  ], { maxBuffer: width * height * 4 + 4096 });
  if (conversion.error || conversion.status !== 0) {
    const detail = conversion.stderr?.toString().trim() || conversion.error?.message || `status ${conversion.status}`;
    throw new Error(`Could not decode ${filename}: ${detail}`);
  }
  if (conversion.stdout.byteLength !== width * height * 4) {
    throw new Error(`Decoded image size mismatch for ${filename}`);
  }
  return { width, height, data: conversion.stdout };
}

function atomicWrite(filename, data) {
  const temporary = `${filename}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, data);
  fs.renameSync(temporary, filename);
}
