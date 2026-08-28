import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import { analyzeCaptureReadiness } from "../src/coverage/readiness.ts";

const input = process.argv[2];
if (!input) {
  throw new Error("Usage: npm run analyze:readiness -- /path/to/capture.zip");
}

const zip = await JSZip.loadAsync(await readFile(input));
const frames = parseJsonl(await readZipText(zip, "telemetry/frames.jsonl", true));
const decisions = parseJsonl(await readZipText(zip, "debug/session.jsonl", false));
const trackingText = await readZipText(zip, "refinement/tracking.json", false);
const report = analyzeCaptureReadiness({
  frames,
  decisions,
  visualTracking: trackingText ? JSON.parse(trackingText) : undefined,
});

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

async function readZipText(zip, path, required) {
  const entry = zip.file(path);
  if (!entry && required) throw new Error(`Capture is missing ${path}`);
  return entry ? entry.async("string") : "";
}

function parseJsonl(text) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
