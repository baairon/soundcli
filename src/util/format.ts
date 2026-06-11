import os from "node:os";

/**
 * Shorten a path for display: the home-directory prefix collapses to "~".
 * The prefix must end at a separator boundary (so "C:\Users\dust" never eats
 * into "C:\Users\dustin"), the comparison is case-insensitive on Windows only,
 * the rest keeps its native separators, and paths already starting with "~"
 * pass through. Pure string work, no disk IO.
 */
export function displayPath(p: string, home = os.homedir()): string {
  if (p.startsWith("~") || !home) return p;
  const fold = (s: string) =>
    process.platform === "win32" ? s.toLowerCase() : s;
  if (fold(p) === fold(home)) return "~";
  const boundary = p[home.length];
  if (
    fold(p).startsWith(fold(home)) &&
    (boundary === "/" || boundary === "\\")
  ) {
    return "~" + p.slice(home.length);
  }
  return p;
}

/** Format seconds as m:ss (or h:mm:ss). */
export function formatDuration(sec?: number): string {
  if (sec === undefined || !Number.isFinite(sec)) return "";
  const total = Math.floor(sec);
  const s = (total % 60).toString().padStart(2, "0");
  const m = Math.floor(total / 60);
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const mm = (m % 60).toString().padStart(2, "0");
    return `${h}:${mm}:${s}`;
  }
  return `${m}:${s}`;
}

/** True for code points that render as boxes / "?" in a terminal (emoji, symbols, controls). */
function isJunkCodePoint(cp: number): boolean {
  if (cp < 0x20 || cp === 0x7f) return true; // control chars
  if (cp === 0xfffd) return true; // replacement char
  if (cp >= 0x200b && cp <= 0x200f) return true; // zero-width / directional marks
  if (cp >= 0x2028 && cp <= 0x202e) return true; // line/para sep, bidi overrides
  if (cp === 0x2060 || cp === 0xfeff) return true; // word joiner / BOM
  if (cp === 0x200d || cp === 0xfe0f || cp === 0x20e3) return true; // ZWJ, VS16, keycap
  if (cp >= 0x2190 && cp <= 0x21ff) return true; // arrows
  if (cp >= 0x2300 && cp <= 0x23ff) return true; // misc technical (⌚ ⏰ …)
  if (cp >= 0x2600 && cp <= 0x27bf) return true; // misc symbols + dingbats
  if (cp >= 0x2b00 && cp <= 0x2bff) return true; // misc symbols and arrows
  if (cp >= 0x1f000 && cp <= 0x1ffff) return true; // emoji / pictographs / flags
  return false;
}

/**
 * Strip emoji, symbols, and other characters that render as "?" / "□" in a
 * terminal, so titles stay clean. Keeps normal letters (incl. accents / CJK).
 */
export function cleanText(s: string): string {
  let out = "";
  for (const ch of s.normalize("NFC")) {
    if (!isJunkCodePoint(ch.codePointAt(0)!)) out += ch;
  }
  return out.replace(/\s+/g, " ").trim() || "Untitled";
}

/**
 * Recover a human title from a track URL's slug (soundcloud.com/artist/my-song
 * → "my song"). Flat enumeration sometimes returns no usable title, but the
 * slug almost always carries it. Returns "" when the slug is junk (numeric
 * IDs, watch pages, no letters).
 */
export function slugTitle(url?: string): string {
  if (!url) return "";
  try {
    const seg = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
    if (!seg || seg === "watch" || /^\d+$/.test(seg)) return "";
    const words = decodeURIComponent(seg).replace(/[-_]+/g, " ").trim();
    if (!/[a-z]/i.test(words)) return "";
    const cleaned = cleanText(words);
    return cleaned === "Untitled" ? "" : cleaned;
  } catch {
    return "";
  }
}

/**
 * Return a friendly title for display. A bare numeric ID or empty title never
 * reaches the screen: we fall back to the URL slug, then the artist name.
 */
export function trackDisplayTitle(track: {
  title?: string;
  artist?: string;
  downloadUrl?: string;
}): string {
  const t = cleanText(track.title || "");
  if (t !== "Untitled" && !/^\d+$/.test(t)) return t;
  const fromSlug = slugTitle(track.downloadUrl);
  if (fromSlug) return fromSlug;
  return track.artist ? cleanText(track.artist) : "Untitled track";
}

/** Truncate to `max` characters with a trailing ellipsis. */
export function truncate(s: string, max: number): string {
  if (max <= 1) return s.slice(0, Math.max(0, max));
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

/** Compact remaining-time label, e.g. "3h 10m", "12m 30s", "45s". */
export function formatEtaShort(sec?: number): string {
  if (sec === undefined || !Number.isFinite(sec) || sec < 0) return "";
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

/** Human-readable transfer rate, e.g. "1.2 MB/s". */
export function formatBytesPerSec(bytes?: number): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B/s", "KB/s", "MB/s", "GB/s"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}
