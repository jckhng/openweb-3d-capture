import { useEffect, useRef, useState } from "react";

export type WakeLockState = "inactive" | "active" | "unsupported" | "unavailable";

export function useScreenWakeLock(shouldHold: boolean): WakeLockState {
  const sentinel = useRef<WakeLockSentinel | undefined>(undefined);
  const [state, setState] = useState<WakeLockState>("inactive");

  useEffect(() => {
    let current = true;
    const wakeLock = (navigator as unknown as { wakeLock?: WakeLock }).wakeLock;

    const release = async () => {
      const held = sentinel.current;
      sentinel.current = undefined;
      if (held && !held.released) await held.release().catch(() => undefined);
    };
    const acquire = async () => {
      if (!shouldHold) {
        await release();
        if (current) setState("inactive");
        return;
      }
      if (!wakeLock) {
        if (current) setState("unsupported");
        return;
      }
      if (document.visibilityState !== "visible" || sentinel.current) return;
      try {
        const held = await wakeLock.request("screen");
        if (!current || !shouldHold) {
          await held.release().catch(() => undefined);
          return;
        }
        sentinel.current = held;
        held.addEventListener("release", () => {
          if (sentinel.current === held) sentinel.current = undefined;
          if (current) setState("unavailable");
        }, { once: true });
        setState("active");
      } catch {
        if (current) setState("unavailable");
      }
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") void acquire();
    };

    document.addEventListener("visibilitychange", handleVisibility);
    void acquire();
    return () => {
      current = false;
      document.removeEventListener("visibilitychange", handleVisibility);
      void release();
    };
  }, [shouldHold]);

  return state;
}
