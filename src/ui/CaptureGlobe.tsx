import { useEffect, useRef } from "react";
import type {
  CaptureCoverageCell,
  CaptureCoverageLatitude,
  CaptureReadinessReport,
  Matrix4,
} from "../shared/types";
import type { CaptureMapSnapshot } from "../pointcloud/capture-map";

const LONGITUDE_SECTORS = 12;
const CENTER_X = 100;
const CENTER_Y = 86;
const RADIUS = 76;
const DISPLAY_ELEVATION = 32;

const LATITUDES: ReadonlyArray<{
  latitude: CaptureCoverageLatitude;
  minimum: number;
  maximum: number;
  center: number;
}> = [
  { latitude: "high", minimum: 60, maximum: 90, center: 75 },
  { latitude: "raised", minimum: 35, maximum: 60, center: 47.5 },
  { latitude: "level", minimum: 5, maximum: 35, center: 20 },
  { latitude: "low", minimum: -20, maximum: 5, center: -7.5 },
];

export function CaptureGlobe({
  report,
  pose,
  captureMap,
  framingLost = false,
  orientationOverride,
  guidanceLabel,
}: {
  report: CaptureReadinessReport;
  pose?: Matrix4;
  captureMap?: CaptureMapSnapshot;
  framingLost?: boolean;
  orientationOverride?: GlobeOrientation;
  guidanceLabel?: string;
}) {
  const cells = report.metrics.coverageCells ?? [];
  const liveOrientation = coverageOrientation(pose, report.metrics.targetEstimate);
  const liveCell = liveOrientation
    ? coverageCell(liveOrientation)
    : report.metrics.currentCoverageCell;
  const fallbackLatitude = LATITUDES.find((band) => band.latitude === liveCell?.latitude)?.center ?? 5;
  const orientation = orientationOverride ?? liveOrientation ?? {
    longitude: liveCell ? longitudeCenter(liveCell.azimuthBin) : 0,
    elevation: fallbackLatitude,
  };
  const target = nextTargetCell(cells, liveCell);
  const polygons = cells.map((cell) => projectCell(cell, orientation)).sort(
    (a, b) => a.depth - b.depth,
  );
  const completed = report.metrics.coverageCheckpointsCompleted ??
    cells.filter((cell) => cell.required && cell.state === "captured").length;
  const required = report.metrics.coverageCheckpointsRequired ??
    cells.filter((cell) => cell.required).length;
  const markerLatitude = LATITUDES.find((band) => band.latitude === liveCell?.latitude)?.center ?? 5;
  const marker = project(
    liveCell?.latitude === "high" ? orientation.longitude : longitudeCenter(liveCell?.azimuthBin ?? 0),
    markerLatitude,
    orientation,
  );

  return (
    <aside className={`capture-globe${framingLost ? " capture-globe-framing-lost" : ""}`} aria-label={`${completed} of ${required} capture checkpoints complete`}>
      <div className="capture-globe-visual">
        <svg viewBox="0 0 200 180" role="img" aria-hidden="true">
          <defs>
            <radialGradient id="globe-glass" cx="38%" cy="30%" r="70%">
              <stop offset="0" stopColor="#e0f2fe" stopOpacity="0.18" />
              <stop offset="0.65" stopColor="#38bdf8" stopOpacity="0.08" />
              <stop offset="1" stopColor="#020617" stopOpacity="0.2" />
            </radialGradient>
            <filter id="globe-glow" x="-60%" y="-60%" width="220%" height="220%">
              <feGaussianBlur stdDeviation="2.5" result="blur" />
              <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
          </defs>
          <circle cx={CENTER_X} cy={CENTER_Y} r={RADIUS} fill="url(#globe-glass)" className="globe-shell" />
          {polygons.map(({ cell, points, depth }) => (
            <polygon
              key={`${cell.latitude}-${cell.azimuthBin}`}
              points={points}
              className={[
                "globe-cell",
                `globe-cell-${cell.state}`,
                depth < 0 ? "globe-cell-back" : "globe-cell-front",
                cell.required ? "globe-cell-required" : "globe-cell-optional",
                liveCell && sameCell(cell, liveCell) ? "globe-cell-current" : "",
                target && sameCell(cell, target) ? "globe-cell-target" : "",
              ].filter(Boolean).join(" ")}
            />
          ))}
          {[-20, 5, 35, 60, 90].map((latitude) => (
            <polyline
              key={latitude}
              points={latitudeLine(latitude, orientation)}
              className="globe-grid"
            />
          ))}
          <circle cx={CENTER_X} cy={CENTER_Y} r={RADIUS} className="globe-outline" />
          {liveCell ? (
            <g className="globe-you" transform={`translate(${marker.x} ${marker.y})`} filter="url(#globe-glow)">
              <circle r="5" />
              <circle r="10" className="globe-you-ring" />
            </g>
          ) : null}
        </svg>
        {captureMap?.points.length ? (
          <CaptureConstellation map={captureMap} orientation={orientation} />
        ) : null}
      </div>
      <div className="capture-globe-status">
        <strong>{completed}/{required}</strong>
        <span>{guidanceLabel ?? (target ? `next: ${latitudeLabel(target.latitude)} sector` : "checkpoint coverage complete")}</span>
      </div>
    </aside>
  );
}

function CaptureConstellation({
  map,
  orientation,
}: {
  map: CaptureMapSnapshot;
  orientation: GlobeOrientation;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const scale = canvas.width / 200;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.save();
    context.scale(scale, scale);
    context.beginPath();
    context.arc(CENTER_X, CENTER_Y, RADIUS - 2, 0, Math.PI * 2);
    context.clip();

    const points = map.points.map((point) => ({
      ...projectCapturePoint(point, orientation),
      support: point.support,
    })).sort((a, b) => a.depth - b.depth);
    for (const point of points) {
      const confirmed = point.support > 1;
      const depthOpacity = 0.3 + 0.6 * ((point.depth + 1) / 2);
      const radius = Math.min(3.1, confirmed ? 1.55 + Math.log2(point.support) * 0.42 : 1.15);
      context.globalAlpha = depthOpacity;
      context.shadowBlur = confirmed ? 5 : 3;
      context.shadowColor = confirmed ? "#fb923c" : "#38bdf8";
      context.fillStyle = confirmed ? "#fb923c" : "#7dd3fc";
      context.beginPath();
      context.arc(point.x, point.y, radius, 0, Math.PI * 2);
      context.fill();
    }
    context.restore();
  }, [map, orientation]);

  return (
    <canvas
      ref={canvasRef}
      className="globe-constellation"
      width="400"
      height="360"
      aria-hidden="true"
    />
  );
}

export interface GlobeOrientation {
  longitude: number;
  elevation: number;
}

export function projectCapturePoint(
  point: { x: number; y: number; z: number },
  orientation: GlobeOrientation,
) {
  const yaw = orientation.longitude * Math.PI / 180;
  const pitch = (orientation.elevation - DISPLAY_ELEVATION) * Math.PI / 180;
  const rotatedX = point.x * Math.cos(yaw) - point.z * Math.sin(yaw);
  const yawedZ = point.x * Math.sin(yaw) + point.z * Math.cos(yaw);
  const rotatedY = point.y * Math.cos(pitch) - yawedZ * Math.sin(pitch);
  const rotatedZ = point.y * Math.sin(pitch) + yawedZ * Math.cos(pitch);
  const mapRadius = RADIUS * 0.82;
  return {
    x: CENTER_X + mapRadius * rotatedX,
    y: CENTER_Y - mapRadius * rotatedY,
    depth: Math.max(-1, Math.min(1, rotatedZ)),
  };
}

function projectCell(cell: CaptureCoverageCell, orientation: GlobeOrientation) {
  const latitude = LATITUDES.find((band) => band.latitude === cell.latitude) ?? LATITUDES[2];
  if (cell.latitude === "high") {
    const perimeter = Array.from({ length: 73 }, (_, index) => (
      project(-180 + index * 5, latitude.minimum, orientation)
    ));
    const center = project(orientation.longitude, 90, orientation);
    return {
      cell,
      depth: center.depth,
      points: perimeter.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" "),
    };
  }
  const minimumLongitude = -180 + cell.azimuthBin * 360 / LONGITUDE_SECTORS;
  const maximumLongitude = minimumLongitude + 360 / LONGITUDE_SECTORS;
  const corners = [
    project(minimumLongitude, latitude.minimum, orientation),
    project(maximumLongitude, latitude.minimum, orientation),
    project(maximumLongitude, latitude.maximum, orientation),
    project(minimumLongitude, latitude.maximum, orientation),
  ];
  const center = project(longitudeCenter(cell.azimuthBin), latitude.center, orientation);
  return {
    cell,
    depth: center.depth,
    points: corners.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" "),
  };
}

function project(longitude: number, latitude: number, orientation: GlobeOrientation) {
  const lon = normalizeDegrees(longitude - orientation.longitude) * Math.PI / 180;
  const lat = latitude * Math.PI / 180;
  const pitch = (orientation.elevation - DISPLAY_ELEVATION) * Math.PI / 180;
  const sphereX = Math.cos(lat) * Math.sin(lon);
  const sphereY = Math.sin(lat);
  const sphereZ = Math.cos(lat) * Math.cos(lon);
  const rotatedY = sphereY * Math.cos(pitch) - sphereZ * Math.sin(pitch);
  const rotatedZ = sphereY * Math.sin(pitch) + sphereZ * Math.cos(pitch);
  return {
    x: CENTER_X + RADIUS * sphereX,
    y: CENTER_Y - RADIUS * rotatedY,
    depth: rotatedZ,
  };
}

function latitudeLine(latitude: number, orientation: GlobeOrientation): string {
  return Array.from({ length: 73 }, (_, index) => {
    const point = project(-180 + index * 5, latitude, orientation);
    return `${point.x.toFixed(2)},${point.y.toFixed(2)}`;
  }).join(" ");
}

function coverageOrientation(
  pose: Matrix4 | undefined,
  target: [number, number, number] | undefined,
): GlobeOrientation | undefined {
  if (!pose || !target) return undefined;
  const delta = [pose[0][3] - target[0], pose[1][3] - target[1], pose[2][3] - target[2]];
  const horizontal = Math.hypot(delta[0], delta[2]);
  if (!(horizontal > 0.05)) return undefined;
  const longitude = Math.atan2(delta[0], delta[2]) * 180 / Math.PI;
  const elevation = Math.atan2(delta[1], horizontal) * 180 / Math.PI;
  return { longitude, elevation: Math.max(-45, Math.min(90, elevation)) };
}

function coverageCell(orientation: GlobeOrientation) {
  const normalized = (orientation.longitude + 180) / 360;
  const latitude = latitudeForElevation(orientation.elevation);
  return {
    azimuthBin: latitude === "high"
      ? 0
      : Math.min(LONGITUDE_SECTORS - 1, Math.max(0, Math.floor(normalized * LONGITUDE_SECTORS))),
    latitude,
  };
}

function nextTargetCell(
  cells: readonly CaptureCoverageCell[],
  current?: { azimuthBin: number; latitude: CaptureCoverageLatitude },
): CaptureCoverageCell | undefined {
  const order: CaptureCoverageLatitude[] = ["level", "raised", "high", "low"];
  for (const latitude of order) {
    const candidates = cells.filter(
      (cell) => cell.latitude === latitude && cell.required && cell.state !== "captured",
    );
    if (!candidates.length) continue;
    return [...candidates].sort((a, b) => (
      circularDistance(a.azimuthBin, current?.azimuthBin ?? 0) -
      circularDistance(b.azimuthBin, current?.azimuthBin ?? 0)
    ))[0];
  }
  return undefined;
}

function circularDistance(a: number, b: number): number {
  const difference = Math.abs(a - b);
  return Math.min(difference, LONGITUDE_SECTORS - difference);
}

function longitudeCenter(bin: number): number {
  return -180 + (bin + 0.5) * 360 / LONGITUDE_SECTORS;
}

function latitudeForElevation(elevation: number): CaptureCoverageLatitude {
  return LATITUDES.find(
    (band) => elevation >= band.minimum && elevation < band.maximum,
  )?.latitude ?? (elevation < LATITUDES.at(-1)!.minimum ? "low" : "high");
}

function sameCell(
  a: Pick<CaptureCoverageCell, "azimuthBin" | "latitude">,
  b: { azimuthBin: number; latitude: CaptureCoverageLatitude },
): boolean {
  return a.azimuthBin === b.azimuthBin && a.latitude === b.latitude;
}

function normalizeDegrees(value: number): number {
  return ((value + 180) % 360 + 360) % 360 - 180;
}

function latitudeLabel(latitude: CaptureCoverageLatitude): string {
  if (latitude === "raised") return "above";
  if (latitude === "high") return "top";
  if (latitude === "low") return "slightly below";
  return "standard";
}
