#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import JSZip from "jszip";
import { validateCaptureDataset } from "../src/dataset/validation.ts";

const arguments_ = process.argv.slice(2);
const json = removeFlag(arguments_, "--json");
const input = arguments_[0] ? path.resolve(arguments_[0]) : undefined;
if (!input || arguments_.length !== 1) {
  console.error("Usage: npm run validate -- <capture-directory-or-zip> [--json]");
  process.exit(2);
}

try {
  const source = fs.statSync(input).isDirectory()
    ? directorySource(input)
    : await zipSource(input);
  const report = await validateCaptureDataset(source);
  if (json) {
    console.log(JSON.stringify({ input, ...report }, null, 2));
  } else {
    printHumanReport(input, report);
  }
  process.exitCode = report.valid ? 0 : 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}

function directorySource(root) {
  const files = listFiles(root);
  const logical = withDatasetRoot(files.map((filename) => path.relative(root, filename).split(path.sep).join("/")));
  const byPath = new Map(logical.paths.map((name) => [
    name,
    path.join(root, ...logical.resolve(name).split("/")),
  ]));
  return {
    paths: [...byPath.keys()],
    read: async (name) => fs.readFileSync(byPath.get(name)),
  };
}

async function zipSource(filename) {
  const zip = await JSZip.loadAsync(fs.readFileSync(filename));
  const names = Object.values(zip.files).filter((entry) => !entry.dir).map((entry) => entry.name);
  const logical = withDatasetRoot(names);
  return {
    paths: logical.paths,
    read: async (name) => {
      const entry = zip.file(logical.resolve(name));
      if (!entry) throw new Error(`ZIP entry is missing: ${name}`);
      return entry.async("uint8array");
    },
  };
}

function withDatasetRoot(names) {
  if (names.includes("transforms.json")) {
    return { paths: names, resolve: (name) => name };
  }
  const candidates = names.filter((name) => name.endsWith("/transforms.json"));
  if (candidates.length !== 1) {
    return { paths: names, resolve: (name) => name };
  }
  const prefix = candidates[0].slice(0, -"transforms.json".length);
  return {
    paths: names.filter((name) => name.startsWith(prefix)).map((name) => name.slice(prefix.length)),
    resolve: (name) => prefix + name,
  };
}

function listFiles(root) {
  const output = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const filename = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...listFiles(filename));
    else if (entry.isFile()) output.push(filename);
  }
  return output;
}

function removeFlag(values, flag) {
  const index = values.indexOf(flag);
  if (index < 0) return false;
  values.splice(index, 1);
  return true;
}

function printHumanReport(input, report) {
  const summary = report.summary;
  console.log(`Capture validation: ${report.valid ? "PASS" : "FAIL"}`);
  console.log(`Input: ${input}`);
  console.log(`Frames: ${summary.telemetryFrames} telemetry / ${summary.transformFrames} transforms`);
  if (summary.imageWidth !== undefined) {
    console.log(`Resolution: ${summary.imageWidth}x${summary.imageHeight}`);
  }
  if (summary.poseExtentMeters !== undefined) {
    const baseline = summary.medianBaselineMeters === undefined
      ? "unavailable"
      : `${summary.medianBaselineMeters.toFixed(3)} m`;
    console.log(`Pose motion: ${summary.poseExtentMeters.toFixed(3)} m extent, ${baseline} median baseline`);
  }
  console.log(`Assets: ${summary.images} images, ${summary.synchronizedImages} synchronized, ${summary.depthFrames} depth, ${summary.imuSamples} IMU samples`);
  console.log(`Decisions: ${summary.decisions}`);
  console.log(`Point cloud: ${summary.pointCloudVertices === undefined ? "unavailable" : `${summary.pointCloudVertices} vertices`}`);
  if (summary.trackingFrames !== undefined) {
    console.log(`Visual tracking: ${summary.connectedTrackingFrames} / ${summary.trackingFrames} connected, ${summary.loopClosures} loops`);
  }
  if (report.issues.length === 0) {
    console.log("Issues: none");
    return;
  }
  console.log("Issues:");
  for (const issue of report.issues) {
    console.log(`  ${issue.severity.toUpperCase()} [${issue.code}]${issue.path ? ` ${issue.path}:` : ""} ${issue.message}`);
  }
}
