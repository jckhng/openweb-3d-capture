const CENTER_SAMPLES = [0.45, 0.5, 0.55] as const;

export function medianCenterDepth(
  getDepthInMeters: (x: number, y: number) => number,
): number | undefined {
  const samples: number[] = [];
  for (const y of CENTER_SAMPLES) {
    for (const x of CENTER_SAMPLES) {
      const depth = getDepthInMeters(x, y);
      if (Number.isFinite(depth) && depth >= 0.1 && depth <= 10) samples.push(depth);
    }
  }
  if (!samples.length) return undefined;
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}
