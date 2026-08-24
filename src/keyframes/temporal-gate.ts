const MIN_RATE = 2;
const MAX_RATE = 5;

/**
 * Cap expensive image analysis to a fixed rate without coupling the policy to
 * WebXR or UI state. M2 applies quality and novelty selection after this gate.
 */
export class TemporalKeyframeGate {
  readonly intervalMs: number;
  private nextAcceptedAt = Number.NEGATIVE_INFINITY;

  constructor(readonly maxFramesPerSecond = 4) {
    if (!Number.isFinite(maxFramesPerSecond) || maxFramesPerSecond < MIN_RATE || maxFramesPerSecond > MAX_RATE) {
      throw new Error(`Frame rate must be between ${MIN_RATE} and ${MAX_RATE} FPS`);
    }
    this.intervalMs = 1000 / maxFramesPerSecond;
  }

  tryAccept(timestamp: number): boolean {
    if (!Number.isFinite(timestamp)) return false;
    if (timestamp < this.nextAcceptedAt) return false;
    this.nextAcceptedAt = timestamp + this.intervalMs;
    return true;
  }
}
