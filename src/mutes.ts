// Sync payloads can use Unix seconds or milliseconds; -1 / uint64 max mean always.
export function muteDeadline(value: number | null): number | undefined {
  if (value === null || value === 0) return 0;
  if (!Number.isFinite(value)) return;
  if (value < 0 || value >= Number.MAX_SAFE_INTEGER) return -1;
  return Math.floor(value < 100_000_000_000 ? value * 1000 : value);
}
