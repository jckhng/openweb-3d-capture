import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildPhotoCoverageCells,
  currentPhotoCheckpoint,
  PHOTO_CHECKPOINT_COUNT,
  type PhotoOverlapMetrics,
} from "../photo/photo-guidance";
import type { CaptureReadinessReport } from "../shared/types";
import { CaptureGlobe, type GlobeOrientation } from "./CaptureGlobe";

export function PhotoCaptureGlobe({
  photoCount,
  overlap,
}: {
  photoCount: number;
  overlap?: PhotoOverlapMetrics;
}) {
  const cells = useMemo(() => buildPhotoCoverageCells(photoCount), [photoCount]);
  const current = currentPhotoCheckpoint(photoCount);
  const checkpointIndex = Math.floor(photoCount / 2);
  const orientation = usePhotoGlobeOrientation(checkpointIndex, current.azimuthBin, current.latitude);
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
      currentCoverageCell: photoCount >= PHOTO_CHECKPOINT_COUNT * 2 ? undefined : current,
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
        orientationOverride={orientation}
        guidanceLabel={overlapLabel(overlap)}
      />
    </div>
  );
}

function usePhotoGlobeOrientation(
  checkpointKey: number,
  azimuthBin: number,
  latitude: "low" | "level" | "raised" | "high",
): GlobeOrientation {
  const base = useMemo(() => ({
    longitude: -180 + (azimuthBin + 0.5) * 30,
    elevation: latitude === "high" ? 75 : latitude === "raised" ? 47.5 : latitude === "low" ? -7.5 : 20,
  }), [azimuthBin, latitude]);
  const reference = useRef<{ alpha: number; tilt: number }>();
  const [orientation, setOrientation] = useState<GlobeOrientation>(base);

  useEffect(() => {
    reference.current = undefined;
    setOrientation(base);
    const update = (event: DeviceOrientationEvent) => {
      if (event.alpha === null) return;
      const screenAngle = screen.orientation?.angle ?? 0;
      const tiltValue = Math.abs(screenAngle) === 90
        ? event.gamma ?? 0
        : event.beta ?? 0;
      reference.current ??= { alpha: event.alpha, tilt: tiltValue };
      const yawDelta = normalizeDegrees(event.alpha - reference.current.alpha);
      const tiltDelta = tiltValue - reference.current.tilt;
      const target = {
        longitude: base.longitude - clamp(yawDelta, -18, 18),
        elevation: clamp(base.elevation + clamp(tiltDelta, -10, 10), -20, 85),
      };
      setOrientation((previous) => ({
        longitude: previous.longitude * 0.72 + target.longitude * 0.28,
        elevation: previous.elevation * 0.72 + target.elevation * 0.28,
      }));
    };
    window.addEventListener("deviceorientation", update);
    return () => window.removeEventListener("deviceorientation", update);
  }, [base, checkpointKey]);

  return orientation;
}

function overlapLabel(overlap?: PhotoOverlapMetrics): string {
  if (!overlap || overlap.verdict === "first") return "manual guide · first anchor";
  if (overlap.verdict === "useful") return `image overlap good · ${overlap.matches} matches`;
  if (overlap.verdict === "too-similar") return "move wider · view too similar";
  return "move less · overlap weak";
}

function normalizeDegrees(value: number): number {
  return ((value + 180) % 360 + 360) % 360 - 180;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
