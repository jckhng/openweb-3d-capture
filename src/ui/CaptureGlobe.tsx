import type {
  CaptureCoverageCell,
  CaptureCoverageLatitude,
  CaptureReadinessReport,
  Matrix4,
} from "../shared/types";

const LONGITUDE_SECTORS = 12;
const CENTER_X = 100;
const CENTER_Y = 86;
const RADIUS = 76;

const LATITUDES: ReadonlyArray<{
  latitude: CaptureCoverageLatitude;
  minimum: number;
  maximum: number;
  center: number;
}> = [
  { latitude: "high", minimum: 25, maximum: 50, center: 37.5 },
  { latitude: "raised", minimum: 10, maximum: 25, center: 17.5 },
  { latitude: "level", minimum: -5, maximum: 10, center: 2.5 },
  { latitude: "low", minimum: -35, maximum: -5, center: -20 },
];

export function CaptureGlobe({
  report,
  pose,
}: {
  report: CaptureReadinessReport;
  pose?: Matrix4;
}) {
  const cells = report.metrics.coverageCells ?? [];
  const liveCell = liveCoverageCell(pose, report.metrics.targetEstimate) ??
    report.metrics.currentCoverageCell;
  const centerLongitude = liveCell
    ? longitudeCenter(liveCell.azimuthBin)
    : 0;
  const target = nextTargetCell(cells, liveCell);
  const polygons = cells.map((cell) => projectCell(cell, centerLongitude)).sort(
    (a, b) => a.depth - b.depth,
  );
  const completed = report.metrics.coverageCheckpointsCompleted ??
    cells.filter((cell) => cell.required && cell.state === "captured").length;
  const required = report.metrics.coverageCheckpointsRequired ??
    cells.filter((cell) => cell.required).length;
  const currentLatitude = LATITUDES.find((band) => band.latitude === liveCell?.latitude)?.center ?? 2.5;
  const marker = project(centerLongitude, currentLatitude, centerLongitude);

  return (
    <aside className="capture-globe" aria-label={`${completed} of ${required} capture checkpoints complete`}>
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
        {[-35, -5, 10, 25, 50].map((latitude) => {
          const y = project(0, latitude, 0).y;
          const radius = Math.cos(latitude * Math.PI / 180) * RADIUS;
          return <ellipse key={latitude} cx={CENTER_X} cy={y} rx={radius} ry={Math.max(2, radius * 0.12)} className="globe-grid" />;
        })}
        <ellipse cx={CENTER_X} cy={CENTER_Y} rx={RADIUS} ry={RADIUS} className="globe-outline" />
        {liveCell ? (
          <g className="globe-you" transform={`translate(${marker.x} ${marker.y})`} filter="url(#globe-glow)">
            <circle r="5" />
            <circle r="10" className="globe-you-ring" />
          </g>
        ) : null}
      </svg>
      <div className="capture-globe-status">
        <strong>{completed}/{required}</strong>
        <span>{target ? `next: ${latitudeLabel(target.latitude)} sector` : "checkpoint coverage complete"}</span>
      </div>
    </aside>
  );
}

function projectCell(cell: CaptureCoverageCell, centerLongitude: number) {
  const latitude = LATITUDES.find((band) => band.latitude === cell.latitude) ?? LATITUDES[2];
  const minimumLongitude = -180 + cell.azimuthBin * 360 / LONGITUDE_SECTORS;
  const maximumLongitude = minimumLongitude + 360 / LONGITUDE_SECTORS;
  const corners = [
    project(minimumLongitude, latitude.minimum, centerLongitude),
    project(maximumLongitude, latitude.minimum, centerLongitude),
    project(maximumLongitude, latitude.maximum, centerLongitude),
    project(minimumLongitude, latitude.maximum, centerLongitude),
  ];
  const center = project(longitudeCenter(cell.azimuthBin), latitude.center, centerLongitude);
  return {
    cell,
    depth: center.depth,
    points: corners.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" "),
  };
}

function project(longitude: number, latitude: number, centerLongitude: number) {
  const lon = normalizeDegrees(longitude - centerLongitude) * Math.PI / 180;
  const lat = latitude * Math.PI / 180;
  return {
    x: CENTER_X + RADIUS * Math.cos(lat) * Math.sin(lon),
    y: CENTER_Y - RADIUS * Math.sin(lat),
    depth: Math.cos(lat) * Math.cos(lon),
  };
}

function liveCoverageCell(
  pose: Matrix4 | undefined,
  target: [number, number, number] | undefined,
): { azimuthBin: number; latitude: CaptureCoverageLatitude } | undefined {
  if (!pose || !target) return undefined;
  const delta = [pose[0][3] - target[0], pose[1][3] - target[1], pose[2][3] - target[2]];
  const horizontal = Math.hypot(delta[0], delta[2]);
  if (!(horizontal > 0.05)) return undefined;
  const longitude = Math.atan2(delta[0], delta[2]) * 180 / Math.PI;
  const normalized = (longitude + 180) / 360;
  const azimuthBin = Math.min(LONGITUDE_SECTORS - 1, Math.max(0, Math.floor(normalized * LONGITUDE_SECTORS)));
  const elevation = Math.atan2(delta[1], horizontal) * 180 / Math.PI;
  return { azimuthBin, latitude: latitudeForElevation(elevation) };
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
  if (latitude === "raised") return "raised";
  if (latitude === "high") return "high";
  if (latitude === "low") return "low";
  return "level";
}
