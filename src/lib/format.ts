// Small display helpers shared by the client shell components.

/** Human-readable byte size, e.g. 1536 -> "1.5 KB", 0 -> "0 B". */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 bytes";
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  if (i === 0) return `${n} ${n === 1 ? "byte" : "bytes"}`;
  const value = n / 1024 ** i;
  const digits = value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[i]}`;
}

/**
 * A short human duration from seconds, e.g. 14 -> "14s", 83 -> "1m 23s". Used for
 * the upload ETA (spec 0004 AC-5). Returns "" for non-finite/negative input so a
 * caller can withhold a nonsense estimate rather than render it.
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const s = Math.ceil(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** Compact relative time from an ISO string, e.g. "3m ago", "just now". */
export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}
