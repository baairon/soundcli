export function formatDuration(sec?: number): string {
  if (sec === undefined || !Number.isFinite(sec) || sec < 0) return "";
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}

export function formatSpeed(bytes?: number): string {
  if (!bytes) return "";
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)} MB/s` : `${Math.round(bytes / 1024)} KB/s`;
}

export function matches(query: string, ...fields: (string | undefined)[]): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = fields.join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
}
