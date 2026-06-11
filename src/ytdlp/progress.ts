export interface DownloadProgress {
  /** yt-dlp status: downloading | finished | converting | done | ... */
  status: string;
  downloadedBytes?: number;
  totalBytes?: number;
  speed?: number; // bytes/sec
  eta?: number; // seconds
  percent?: number; // 0..100
}

function num(s: string | undefined): number | undefined {
  if (!s || s === "NA") return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Parse a tab-delimited progress line emitted by our yt-dlp --progress-template.
 * Format: SCPROG \t status \t downloaded \t total \t total_estimate \t speed \t eta
 */
export function parseProgress(line: string): DownloadProgress | undefined {
  const parts = line.split("\t");
  if (parts[0] !== "SCPROG" || parts.length < 7) return undefined;
  const downloadedBytes = num(parts[2]);
  const totalBytes = num(parts[3]) ?? num(parts[4]);
  const percent =
    downloadedBytes !== undefined && totalBytes
      ? Math.min(100, (downloadedBytes / totalBytes) * 100)
      : undefined;
  return {
    status: parts[1] ?? "",
    downloadedBytes,
    totalBytes,
    speed: num(parts[5]),
    eta: num(parts[6]),
    percent,
  };
}
