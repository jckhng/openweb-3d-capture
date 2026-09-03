export interface BrowserStorageStatus {
  usage?: number;
  quota?: number;
  available?: number;
  persisted?: boolean;
}

export async function inspectBrowserStorage(): Promise<BrowserStorageStatus> {
  if (typeof navigator === "undefined" || !navigator.storage) return {};
  const [estimate, persisted] = await Promise.all([
    navigator.storage.estimate?.().catch(() => undefined),
    navigator.storage.persisted?.().catch(() => undefined),
  ]);
  const usage = finiteNonNegative(estimate?.usage);
  const quota = finiteNonNegative(estimate?.quota);
  return {
    usage,
    quota,
    available: usage !== undefined && quota !== undefined ? Math.max(0, quota - usage) : undefined,
    persisted,
  };
}

export async function requestPersistentBrowserStorage(): Promise<BrowserStorageStatus> {
  if (typeof navigator !== "undefined" && navigator.storage?.persist) {
    await navigator.storage.persist().catch(() => false);
  }
  return inspectBrowserStorage();
}

function finiteNonNegative(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}
