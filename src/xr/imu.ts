import type { IMUSample } from "../shared/types";

interface DeviceMotionLike {
  acceleration?: { x: number | null; y: number | null; z: number | null } | null;
  accelerationIncludingGravity?: { x: number | null; y: number | null; z: number | null } | null;
  rotationRate?: { alpha: number | null; beta: number | null; gamma: number | null } | null;
}

interface PermissionBearingConstructor {
  requestPermission?: () => Promise<"granted" | "denied">;
}

export class IMUSensorRecorder {
  private readonly samples: IMUSample[] = [];
  private startedAt = 0;
  private listener?: (event: DeviceMotionEvent) => void;

  async start(): Promise<{ enabled: boolean; detail: string }> {
    if (typeof window === "undefined" || !("DeviceMotionEvent" in window)) {
      return { enabled: false, detail: "DeviceMotionEvent is unavailable" };
    }

    const permissionBearing = window.DeviceMotionEvent as unknown as PermissionBearingConstructor;
    if (permissionBearing.requestPermission) {
      try {
        const permission = await permissionBearing.requestPermission();
        if (permission !== "granted") {
          return { enabled: false, detail: "Motion permission was denied" };
        }
      } catch (error) {
        return { enabled: false, detail: error instanceof Error ? error.message : "Motion permission failed" };
      }
    }

    this.samples.length = 0;
    this.startedAt = performance.now();
    this.listener = (event) => this.record(event as unknown as DeviceMotionLike);
    window.addEventListener("devicemotion", this.listener);
    return { enabled: true, detail: "Listening for devicemotion samples" };
  }

  stop(): void {
    if (this.listener && typeof window !== "undefined") {
      window.removeEventListener("devicemotion", this.listener);
    }
    this.listener = undefined;
  }

  getSamples(): IMUSample[] {
    return this.samples.map((sample) => ({
      ...sample,
      gyro: sample.gyro ? [...sample.gyro] as [number, number, number] : undefined,
      accel: sample.accel ? [...sample.accel] as [number, number, number] : undefined,
    }));
  }

  getSampleRate(): number {
    if (this.samples.length < 2) return this.samples.length;
    const durationSeconds = (this.samples[this.samples.length - 1].timestamp - this.samples[0].timestamp) / 1000;
    return durationSeconds > 0 ? (this.samples.length - 1) / durationSeconds : this.samples.length;
  }

  private record(event: DeviceMotionLike): void {
    const rate = event.rotationRate;
    const acceleration = event.acceleration ?? event.accelerationIncludingGravity;
    const gyro = rate && [rate.alpha, rate.beta, rate.gamma].every((value) => value !== null)
      ? [rate.alpha ?? 0, rate.beta ?? 0, rate.gamma ?? 0] as [number, number, number]
      : undefined;
    const accel = acceleration && [acceleration.x, acceleration.y, acceleration.z].every((value) => value !== null)
      ? [acceleration.x ?? 0, acceleration.y ?? 0, acceleration.z ?? 0] as [number, number, number]
      : undefined;

    if (gyro || accel) {
      this.samples.push({
        timestamp: performance.now(),
        gyro,
        accel,
      });
    }
  }
}

