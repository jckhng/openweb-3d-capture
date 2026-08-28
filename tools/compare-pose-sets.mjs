#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { poseTranslationDistance, rotationAngleDifference } from "../src/shared/matrix.ts";
import { applyPoseSimilarity, estimatePoseSimilarity } from "../src/refinement/similarity-alignment.ts";

const [phoneArgument, referenceFramesArgument] = process.argv.slice(2);
if (!phoneArgument || !referenceFramesArgument) {
  console.error("Usage: npm run compare:poses -- <phone-optimization.json> <reference-frames.jsonl>");
  process.exit(2);
}
const phoneReport = JSON.parse(fs.readFileSync(path.resolve(phoneArgument), "utf8"));
const referenceFrames = fs.readFileSync(path.resolve(referenceFramesArgument), "utf8")
  .split("\n")
  .filter(Boolean)
  .map(JSON.parse);
const referenceById = new Map(referenceFrames
  .filter((frame) => frame.refinedCameraToWorld)
  .map((frame) => [frame.id, frame.refinedCameraToWorld]));
const commonFrames = phoneReport.frames
  .filter((frame) => referenceById.has(frame.id))
  .map((frame) => ({ ...frame, reference: referenceById.get(frame.id) }));
if (!commonFrames.length) throw new Error("No common refined frame IDs were found");
const rawAlignment = estimatePoseSimilarity(
  commonFrames.map((frame) => frame.webxrCameraToWorld),
  commonFrames.map((frame) => frame.reference),
);
const candidateAlignment = estimatePoseSimilarity(
  commonFrames.map((frame) => frame.phoneRefinedCameraToWorld),
  commonFrames.map((frame) => frame.reference),
);
const comparisons = commonFrames.map((frame) => {
    const raw = applyPoseSimilarity(frame.webxrCameraToWorld, rawAlignment);
    const candidate = applyPoseSimilarity(frame.phoneRefinedCameraToWorld, candidateAlignment);
    return {
      id: frame.id,
      rawTranslationMeters: poseTranslationDistance(raw, frame.reference),
      phoneTranslationMeters: poseTranslationDistance(candidate, frame.reference),
      rawRotationRadians: rotationAngleDifference(raw, frame.reference),
      phoneRotationRadians: rotationAngleDifference(candidate, frame.reference),
    };
  });
const rawSummary = summarize(
  comparisons.map((value) => value.rawTranslationMeters),
  comparisons.map((value) => value.rawRotationRadians),
);
const phoneSummary = summarize(
  comparisons.map((value) => value.phoneTranslationMeters),
  comparisons.map((value) => value.phoneRotationRadians),
);
const improvedFrameFraction = comparisons.filter((value) =>
  value.phoneTranslationMeters < value.rawTranslationMeters &&
  value.phoneRotationRadians < value.rawRotationRadians
).length / comparisons.length;
const translationImprovedFrameFraction = comparisons.filter((value) =>
  value.phoneTranslationMeters < value.rawTranslationMeters
).length / comparisons.length;
const rotationImprovedFrameFraction = comparisons.filter((value) =>
  value.phoneRotationRadians < value.rawRotationRadians
).length / comparisons.length;
const referenceValidationPassed =
  phoneSummary.translationMeters.median <= rawSummary.translationMeters.median * 0.95 &&
  phoneSummary.rotationDegrees.median <= rawSummary.rotationDegrees.median * 0.95 &&
  improvedFrameFraction >= 0.6;
const report = {
  format: "open3dcapture-pose-comparison",
  version: 1,
  frames: comparisons.length,
  alignment: {
    rawScale: rawAlignment.scale,
    candidateScale: candidateAlignment.scale,
  },
  rawToReference: rawSummary,
  phoneToReference: phoneSummary,
  improvedFrameFraction,
  translationImprovedFrameFraction,
  rotationImprovedFrameFraction,
  referenceValidation: {
    passed: referenceValidationPassed,
    criteria: {
      minimumMedianTranslationImprovementFraction: 0.05,
      minimumMedianRotationImprovementFraction: 0.05,
      minimumImprovedFrameFraction: 0.6,
    },
    fallbackReason: referenceValidationPassed
      ? undefined
      : "candidate corrections do not consistently approach the independent COLMAP poses",
  },
  largestTranslationRegressions: [...comparisons]
    .sort((a, b) =>
      (b.phoneTranslationMeters - b.rawTranslationMeters) -
      (a.phoneTranslationMeters - a.rawTranslationMeters)
    )
    .slice(0, 5)
    .map((value) => ({
      id: value.id,
      regressionMeters: value.phoneTranslationMeters - value.rawTranslationMeters,
      rawMeters: value.rawTranslationMeters,
      candidateMeters: value.phoneTranslationMeters,
    })),
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

function summarize(translations, rotations) {
  return {
    translationMeters: distribution(translations),
    rotationDegrees: distribution(rotations.map((value) => value * 180 / Math.PI)),
  };
}

function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    median: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    maximum: sorted.at(-1),
  };
}

function percentile(sorted, fraction) {
  return sorted[Math.floor((sorted.length - 1) * fraction)];
}
