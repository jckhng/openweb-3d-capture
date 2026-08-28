#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import {
  extractBriefFeatures,
  extractImageFeatures,
  matchImageFeatures,
  matchScaleInvariantFeatures,
  resizeGray,
} from "../src/refinement/features.ts";
import { scoreEpipolarConsistency } from "../src/refinement/reprojection.ts";
import { VisualConnectivityGraph } from "../src/refinement/visual-graph.ts";
import { verifyFeatureGeometry } from "../src/refinement/geometric-verification.ts";
import { estimateSharedCalibration } from "../src/refinement/calibration-estimator.ts";

const arguments_ = process.argv.slice(2);
const outputIndex = arguments_.indexOf("--output");
const outputPath = outputIndex >= 0 ? path.resolve(arguments_[outputIndex + 1]) : undefined;
if (outputIndex >= 0) arguments_.splice(outputIndex, 2);
const includeConstraintsIndex = arguments_.indexOf("--include-constraints");
const includeConstraints = includeConstraintsIndex >= 0;
if (includeConstraintsIndex >= 0) arguments_.splice(includeConstraintsIndex, 1);
const multiViewTrackOffsets = [1, 2, 4];
const deferredDimension = integerOption(arguments_, "--deferred-dimension", 720);
const captureDimension = integerOption(arguments_, "--capture-dimension", 480);
const deferredFeatures = integerOption(arguments_, "--deferred-features", 600);
const gradientRatio = numberOption(arguments_, "--gradient-ratio", 0.84);
const captureDirectory = arguments_[0] ? path.resolve(arguments_[0]) : undefined;
if (!captureDirectory) {
  console.error("Usage: npm run benchmark:features -- <capture-directory> [--capture-dimension 480] [--deferred-dimension 720] [--include-constraints] [--output report.json]");
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
const decoded = [];
const captureDecoded = [];
const capturePhaseFrameMilliseconds = [];
for (const frame of frames) {
  const started = performance.now();
  const image = decodeGray(
    path.join(captureDirectory, frame.imagePath),
    frame.width,
    frame.height,
    deferredDimension,
  );
  decoded.push(image);
  captureDecoded.push(resizeGray(image, captureDimension));
  capturePhaseFrameMilliseconds.push(performance.now() - started);
}
const extractionStarted = performance.now();
const briefFeatures = captureDecoded.map((image, index) => {
  const started = performance.now();
  const features = extractBriefFeatures(image, {
    maximumFeatures: 450,
    fastThreshold: 18,
    cellSize: 12,
  });
  capturePhaseFrameMilliseconds[index] += performance.now() - started;
  return features;
});
const matchingStarted = performance.now();
const strongFeatureCache = new Map();
const featuresFor = (index, matcher) => {
  if (matcher === "brief") return briefFeatures[index];
  let features = strongFeatureCache.get(index);
  if (!features) {
    features = extractImageFeatures(decoded[index], {
      maximumFeatures: deferredFeatures,
      fastThreshold: 18,
      cellSize: 12,
    });
    strongFeatureCache.set(index, features);
  }
  return features;
};

const scorePair = ([indexA, indexB, kind, matcher = "brief"]) => {
  const featuresA = featuresFor(indexA, matcher);
  const featuresB = featuresFor(indexB, matcher);
  const matches = matcher === "gradient"
    ? matchScaleInvariantFeatures(featuresA, featuresB, gradientRatio)
    : matchImageFeatures(featuresA, featuresB);
  const pointMatches = matches.map((match) => ({
    pointA: sourcePoint(
      featuresA[match.featureA],
      matcher === "gradient" ? decoded[indexA] : captureDecoded[indexA],
      frames[indexA],
    ),
    pointB: sourcePoint(
      featuresB[match.featureB],
      matcher === "gradient" ? decoded[indexB] : captureDecoded[indexB],
      frames[indexB],
    ),
    featureA: canonicalFeatureId(indexA, matcher, match.featureA),
    featureB: canonicalFeatureId(indexB, matcher, match.featureB),
  }));
  const verification = verifyFeatureGeometry(pointMatches, frames[indexA].width, frames[indexA].height);
  const inlierMatches = verification.inlierIndices.map((index) => pointMatches[index]);
  const scoredMatches = inlierMatches.length ? inlierMatches : pointMatches;
  const raw = scoreEpipolarConsistency(
    scoredMatches,
    frames[indexA].webxrCameraToWorld ?? frames[indexA].cameraToWorld,
    frames[indexB].webxrCameraToWorld ?? frames[indexB].cameraToWorld,
    frames[indexA].intrinsics,
  );
  const { inlierIndices: _, ...geometry } = verification;
  let refined;
  if (frames[indexA].refinedCameraToWorld && frames[indexB].refinedCameraToWorld && refinement) {
    refined = scoreEpipolarConsistency(
      scoredMatches,
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
    matcher,
    featuresA: featuresA.length,
    featuresB: featuresB.length,
    matches: matches.length,
    geometry,
    calibrationObservation: {
      matches: inlierMatches.length <= 64
        ? inlierMatches
        : Array.from({ length: 64 }, (_, index) => inlierMatches[Math.floor(index * inlierMatches.length / 64)]),
      cameraToWorldA: frames[indexA].webxrCameraToWorld ?? frames[indexA].cameraToWorld,
      cameraToWorldB: frames[indexB].webxrCameraToWorld ?? frames[indexB].cameraToWorld,
      intrinsics: frames[indexA].intrinsics,
    },
    raw,
    refined,
  };
};
const graph = new VisualConnectivityGraph();
for (const frame of frames) graph.addFrame(frame.id);
const pairReports = [];
const attemptedStrongPairs = new Set();
const addPair = (definition) => {
  const pair = scorePair(definition);
  pairReports.push(pair);
  if (pair.matcher === "gradient") attemptedStrongPairs.add(pairKey(pair.frameA, pair.frameB));
  graph.addEdge({
    frameA: pair.frameA,
    frameB: pair.frameB,
    kind: pair.kind,
    matcher: pair.matcher,
    matches: pair.matches,
    geometricInliers: pair.geometry.inliers,
    geometricInlierRatio: pair.geometry.inlierRatio,
    medianResidualPixels: pair.raw.medianPixels,
    p90ResidualPixels: pair.raw.p90Pixels,
    accepted: pair.geometry.accepted,
  });
  return pair;
};
for (let index = 0; index < frames.length - 1; index += 1) {
  const started = performance.now();
  addPair([index, index + 1, "adjacent", "brief"]);
  capturePhaseFrameMilliseconds[index + 1] += performance.now() - started;
}
const capturePhaseCompleted = performance.now();
for (const pair of loopPairs(frames)) addPair([...pair, "gradient"]);
repairDisconnectedGraph();
const deferredRefinementCompleted = performance.now();

const usable = pairReports.filter((pair) => pair.matches >= 12);
const adjacentUsable = usable.filter((pair) => pair.kind === "adjacent");
const loopUsable = usable.filter((pair) => pair.kind === "loop");
const visualTracking = graph.report();
visualTracking.processing = {
  capturePhaseFrames: frames.length,
  capturePhaseTotalMilliseconds: capturePhaseCompleted - decodeStarted,
  capturePhaseMaximumFrameMilliseconds: Math.max(0, ...capturePhaseFrameMilliseconds),
  deferredRefinementMilliseconds: deferredRefinementCompleted - capturePhaseCompleted,
  retainedGrayBytes: decoded.reduce((sum, image) => sum + image.data.byteLength, 0),
  captureMaximumDimension: captureDimension,
  deferredMaximumDimension: deferredDimension,
  deferredMaximumFeatures: deferredFeatures,
  deferredMatchRatio: gradientRatio,
};
if (visualTracking.readyForCalibration) {
  visualTracking.calibrationEstimate = estimateSharedCalibration(
    pairReports
      .filter((pair) => pair.geometry.accepted)
      .slice(-120)
      .map((pair) => pair.calibrationObservation),
  );
}
const multiViewConstraintPairs = includeConstraints ? buildMultiViewConstraintPairs() : [];
const poseConstraints = includeConstraints
  ? multiViewConstraintPairs
    .filter((pair) => pair.geometry.accepted)
    .map((pair) => ({
      frameA: pair.frameA,
      frameB: pair.frameB,
      kind: pair.kind,
      matches: pair.calibrationObservation.matches,
    }))
  : undefined;
for (const pair of pairReports) delete pair.calibrationObservation;
const completed = performance.now();
const report = {
  format: "open3dcapture-feature-benchmark",
  version: 1,
  captureDirectory,
  configuration: {
    captureMaximumDimension: captureDimension,
    deferredMaximumDimension: deferredDimension,
    captureMaximumFeatures: 450,
    deferredMaximumFeatures: deferredFeatures,
    gradientRatio,
    descriptor: "capture: single-scale oriented BRIEF-256; stop-time: multi-scale gradient-128",
    matcher: `capture-phase mutual Hamming 0.8; deferred unique gradient L2 ${gradientRatio.toFixed(2)} for repair/loops`,
    minimumUsableMatches: 12,
    multiViewTrackOffsets: includeConstraints ? multiViewTrackOffsets : undefined,
    multiViewConstraintPairs: includeConstraints ? multiViewConstraintPairs.length : undefined,
  },
  frames: frames.length,
  meanFeatures: mean(briefFeatures.map((value) => value.length)),
  meanStrongFeatures: mean([...strongFeatureCache.values()].map((value) => value.length)),
  strongFeatureFrames: strongFeatureCache.size,
  pairs: pairReports.length,
  usablePairs: usable.length,
  usableAdjacentPairs: adjacentUsable.length,
  usableLoopPairs: loopUsable.length,
  timingsMilliseconds: {
    desktopDecode: extractionStarted - decodeStarted,
    capturePhaseBriefExtraction: matchingStarted - extractionStarted,
    capturePhaseBriefMatchingAndScoring: capturePhaseCompleted - matchingStarted,
    deferredStrongRefinement: deferredRefinementCompleted - capturePhaseCompleted,
    workerSafeExtraction: matchingStarted - extractionStarted,
    workerSafeMatchingAndScoring: completed - matchingStarted,
  },
  rawMedianPairResidualPixels: median(adjacentUsable.map((pair) => pair.raw.medianPixels)),
  refinedMedianPairResidualPixels: median(adjacentUsable.map((pair) => pair.refined?.medianPixels).filter(Number.isFinite)),
  visualTracking,
  poseConstraints,
  pairReports,
};
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (outputPath) atomicWrite(outputPath, serialized);
process.stdout.write(outputPath ? `${JSON.stringify({
  outputPath,
  frames: report.frames,
  pairs: report.pairs,
  poseConstraints: report.poseConstraints?.length ?? 0,
  strongFeatureFrames: report.strongFeatureFrames,
  timingsMilliseconds: report.timingsMilliseconds,
  visualTracking: {
    frameCount: report.visualTracking.frameCount,
    connectedFrameCount: report.visualTracking.connectedFrameCount,
    componentCount: report.visualTracking.componentCount,
    loopClosures: report.visualTracking.loopClosures,
    calibrationEstimate: report.visualTracking.calibrationEstimate,
  },
}, null, 2)}\n` : serialized);

function canonicalFeatureId(frameIndex, matcher, featureIndex) {
  if (matcher === "brief") return `brief:${featureIndex}`;
  return `strong:${featureIndex}`;
}

function buildMultiViewConstraintPairs() {
  const pairs = [];
  const included = new Set();
  for (const offset of multiViewTrackOffsets) {
    for (let index = 0; index < frames.length - offset; index += 1) {
      const pair = scorePair([index, index + offset, offset === 1 ? "adjacent" : "recovery", "gradient"]);
      pairs.push(pair);
      included.add(pairKey(pair.frameA, pair.frameB));
    }
  }
  for (const pair of pairReports) {
    if (pair.matcher !== "gradient" || included.has(pairKey(pair.frameA, pair.frameB))) continue;
    pairs.push(pair);
    included.add(pairKey(pair.frameA, pair.frameB));
  }
  return pairs;
}

function loopPairs(values) {
  const maximumDistance = overlapDistanceLimit(values);
  const selected = [];
  for (let b = 48; b < values.length; b += 8) {
    const candidates = [];
    for (let a = 0; a <= b - 48; a += 1) {
      const score = overlapCost(values[a], values[b], 0.65, maximumDistance);
      if (Number.isFinite(score)) candidates.push({ a, b, score });
    }
    candidates.sort((first, second) => first.score - second.score);
    selected.push(...candidates.slice(0, 2).map(({ a, b }) => [a, b, "loop"]));
  }
  return selected;
}

function repairDisconnectedGraph() {
  if (graph.componentCount() <= 1) return;
  const maximumDistance = overlapDistanceLimit(frames);
  const candidates = [];
  for (let a = 0; a < frames.length; a += 1) {
    for (let b = a + 1; b < frames.length; b += 1) {
      if (attemptedStrongPairs.has(pairKey(frames[a].id, frames[b].id))) continue;
      const separation = b - a;
      const loop = separation >= 48;
      const overlap = overlapCost(
        frames[a],
        frames[b],
        loop ? 0.65 : 0.35,
        loop ? maximumDistance : maximumDistance * 0.75,
      );
      if (Number.isFinite(overlap)) {
        candidates.push({
          a,
          b,
          kind: loop ? "loop" : "recovery",
          score: recoveryTier(separation) * 10 + overlap,
        });
      }
    }
  }
  candidates.sort((first, second) => first.score - second.score);
  let attempts = 0;
  for (const candidate of candidates) {
    if (graph.componentCount() <= 1 || attempts >= 96) break;
    if (graph.areConnected(candidate.a, candidate.b)) continue;
    addPair([candidate.a, candidate.b, candidate.kind, "gradient"]);
    attempts += 1;
  }
}

function recoveryTier(separation) {
  if (separation === 1) return 0;
  if (separation <= 8) return 1;
  if (separation < 48) return 2;
  return 3;
}

function overlapCost(frameA, frameB, minimumAgreement, maximumDistance) {
  const poseA = frameA.webxrCameraToWorld ?? frameA.cameraToWorld;
  const poseB = frameB.webxrCameraToWorld ?? frameB.cameraToWorld;
  const directionA = [-poseA[0][2], -poseA[1][2], -poseA[2][2]];
  const directionB = [-poseB[0][2], -poseB[1][2], -poseB[2][2]];
  const agreement = directionA[0] * directionB[0] + directionA[1] * directionB[1] + directionA[2] * directionB[2];
  if (agreement < minimumAgreement) return Number.POSITIVE_INFINITY;
  const distance = Math.hypot(
    poseA[0][3] - poseB[0][3],
    poseA[1][3] - poseB[1][3],
    poseA[2][3] - poseB[2][3],
  );
  return distance <= maximumDistance ? distance + (1 - agreement) * 0.5 : Number.POSITIVE_INFINITY;
}

function overlapDistanceLimit(values) {
  const baselines = [];
  for (let index = 1; index < values.length; index += 1) {
    const poseA = values[index - 1].webxrCameraToWorld ?? values[index - 1].cameraToWorld;
    const poseB = values[index].webxrCameraToWorld ?? values[index].cameraToWorld;
    baselines.push(Math.hypot(
      poseA[0][3] - poseB[0][3],
      poseA[1][3] - poseB[1][3],
      poseA[2][3] - poseB[2][3],
    ));
  }
  baselines.sort((a, b) => a - b);
  return Math.min(1, Math.max(0.2, baselines[Math.floor(baselines.length / 2)] * 12));
}

function pairKey(frameA, frameB) {
  return frameA < frameB ? `${frameA}:${frameB}` : `${frameB}:${frameA}`;
}

function decodeGray(filename, sourceWidth, sourceHeight, maximumDimension) {
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

function integerOption(values, name, fallback) {
  const index = values.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(values[index + 1]);
  values.splice(index, 2);
  if (!Number.isInteger(value) || value < 17) throw new Error(`${name} must be an integer of at least 17`);
  return value;
}

function numberOption(values, name, fallback) {
  const index = values.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(values[index + 1]);
  values.splice(index, 2);
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
  return value;
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
