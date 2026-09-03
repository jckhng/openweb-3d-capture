import { useMemo } from "react";
import {
  buildPhotoCoverageCells,
  currentPhotoCheckpoint,
  PHOTO_CHECKPOINT_COUNT,
  type PhotoOverlapMetrics,
} from "../photo/photo-guidance";
import type {
  CaptureCoverageCell,
  CaptureReadinessReport,
  PhotoCaptureGuidance,
} from "../shared/types";
import { CaptureGlobe, type GlobeOrientation } from "./CaptureGlobe";

export function PhotoCaptureGlobe({
  photoCount,
  overlap,
  guidedCells,
  guidance,
}: {
  photoCount: number;
  overlap?: PhotoOverlapMetrics;
  guidedCells?: CaptureCoverageCell[];
  guidance?: PhotoCaptureGuidance;
}) {
  const manualCells = useMemo(() => buildPhotoCoverageCells(photoCount), [photoCount]);
  const cells = guidedCells ?? manualCells;
  const current = currentPhotoCheckpoint(photoCount);
  const orientation = manualPhotoGlobeOrientation(current.azimuthBin, current.latitude);
  const completed = cells.filter((cell) => cell.state === "captured").length;
  const report: CaptureReadinessReport = {
    format: "open3dcapture-readiness",
    version: 1,
    status: completed >= PHOTO_CHECKPOINT_COUNT ? "ready" : "add-views",
    primaryAction: "Follow the manual autofocus capture sequence.",
    generatedAt: new Date(0).toISOString(),
    metrics: {
      acceptedFrames: photoCount,
      imageFrames: photoCount,
      synchronizedImageFrames: 0,
      synchronizedImageRatio: 0,
      p10AcceptedSharpness: 0,
      azimuthBinsCovered: new Set(cells.filter((cell) => cell.state === "captured").map((cell) => cell.azimuthBin)).size,
      azimuthBinCount: 12,
      missingAzimuthBins: [],
      elevationBandsCovered: [],
      elevationSpanDegrees: 0,
      coverageCells: cells,
      coverageCheckpointsCompleted: completed,
      coverageCheckpointsRequired: PHOTO_CHECKPOINT_COUNT,
      currentCoverageCell: guidance ?? (photoCount >= PHOTO_CHECKPOINT_COUNT * 2 ? undefined : current),
      visualConnectedFrames: 0,
      visualComponentCount: 0,
      adjacentEdgeCoverage: 0,
      loopClosureDetected: false,
      physicalLoopClosed: false,
    },
    issues: [],
  };

  return (
    <div className="photo-capture-globe">
      <CaptureGlobe
        report={report}
        orientationOverride={guidance
          ? { longitude: guidance.longitude, elevation: guidance.elevation }
          : orientation}
        guidanceLabel={overlapLabel(overlap, Boolean(guidance))}
      />
    </div>
  );
}

function manualPhotoGlobeOrientation(
  azimuthBin: number,
  latitude: "low" | "level" | "raised" | "high",
): GlobeOrientation {
  return {
    longitude: -180 + (azimuthBin + 0.5) * 30,
    elevation: latitude === "high" ? 75 : latitude === "raised" ? 47.5 : latitude === "low" ? -7.5 : 20,
  };
}

function overlapLabel(overlap: PhotoOverlapMetrics | undefined, visuallyGuided: boolean): string {
  if (!overlap || overlap.verdict === "first") return visuallyGuided ? "visual guide · first anchor" : "initializing visual guide";
  if (overlap.verdict === "useful") return `image overlap good · ${overlap.matches} matches`;
  if (overlap.verdict === "too-similar") return "move wider · view too similar";
  return "move less · overlap weak";
}
