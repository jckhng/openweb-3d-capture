export const BUILD_TIMESTAMP = __BUILD_TIMESTAMP__;

export function formatBuildTimestamp(timestamp = BUILD_TIMESTAMP): string {
  return new Date(timestamp).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}
