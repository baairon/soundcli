import os from "node:os";
import stringWidth from "string-width";

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

/**
 * Coarse total runtime for a set's subtitle: "47 min", "1h 23m", "2h".
 * Returns "" for no/zero duration so the caller can drop the segment cleanly.
 * (formatDuration stays the per-track m:ss form.)
 */
export function formatRuntime(totalSec?: number): string {
  if (totalSec === undefined || !Number.isFinite(totalSec) || totalSec <= 0) {
    return "";
  }
  const mins = Math.round(totalSec / 60);
  if (mins <= 0) return "<1 min";
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/**
 * True only for code points that corrupt a single-line Ink row: control chars,
 * hard line breaks, and bidi controls that reorder the rest of the line.
 * Everything else (emoji, symbols, joiners) renders as typed.
 */
function isBreakingCodePoint(cp: number): boolean {
  if (cp < 0x20 || cp === 0x7f) return true; // control chars
  if (cp === 0x2028 || cp === 0x2029) return true; // line/para separators
  if (cp === 0x200e || cp === 0x200f) return true; // directional marks
  if (cp >= 0x202a && cp <= 0x202e) return true; // bidi embeds/overrides
  if (cp >= 0x2066 && cp <= 0x2069) return true; // bidi isolates
  if (cp === 0xfffd) return true; // replacement char: decode junk, never a glyph
  return false;
}

// Zero-measured chars that still form clusters: ZWJ joins emoji, VS16/VS15
// switch presentation; the grapheme stabilizer consumes them downstream.
const CLUSTER_JOINERS = /[‍︎️]/u;

/**
 * Invisible to string-width but not to every terminal: default-ignorable
 * characters (Hangul fillers, ZWSP, word joiner, BOM) measure 0, yet some get
 * real cells when drawn (U+3164 draws 2 in Windows Terminal). One such char
 * makes the row draw wider than Ink measured it, the line wraps, and the
 * whole frame's incremental redraw corrupts (rows shift, stale cells linger).
 * Combining marks also measure 0 but stay: they compose onto their base.
 */
function isInvisibleCodePoint(ch: string, cp: number): boolean {
  if (cp < 0x80) return false; // ASCII fast path (soft hyphen sits at 0xad)
  if (CLUSTER_JOINERS.test(ch)) return false;
  return stringWidth(ch) === 0 && !/\p{M}/u.test(ch);
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const VS16 = "️";

/**
 * Ink lays the row out with string-width, but the terminal draws with its own
 * font rules; any disagreement hard-wraps the row and corrupts the redraw.
 * Normalize the emoji classes that lie: ZWJ sequences shrink to their lead
 * emoji, skin tones drop, and text-presentation pictographs get VS16 so both
 * sides agree on 2 cells. Everything that already agrees passes through 1:1.
 */
function stabilizeCluster(cluster: string): string {
  // ZWJ sequence: keep the lead scalar (+ its VS16); a terminal that can't
  // compose the full sequence draws each part, up to 3x the measured width.
  const zwj = cluster.indexOf("‍");
  if (zwj >= 0) cluster = cluster.slice(0, zwj);
  // Skin tones: keep the base emoji; uncomposed fallbacks render double-wide.
  cluster = cluster.replace(/[\u{1f3fb}-\u{1f3ff}]/gu, "");
  if (!cluster) return "";
  // Only the emoji plane can disagree with the terminal; BMP symbols (★, bare
  // ☠) measure 1 and render 1-cell text-style everywhere.
  if (!/[\u{1f000}-\u{1ffff}]/u.test(cluster)) return cluster;
  if (stringWidth(cluster) === 2) return cluster;
  // Text-presentation pictograph (bare 🕸 measures 1, renders 2): force emoji
  // presentation so measurement and glyph agree.
  if (stringWidth(cluster + VS16) === 2) return cluster + VS16;
  return "";
}

// Anything needing grapheme-level stabilization: ZWJ, VS16, or emoji plane.
const NEEDS_STABILIZING = /[‍️\u{1f000}-\u{1ffff}]/u;
// The same titles re-render on every playback tick; cache the cleaned form.
const cleanCache = new Map<string, string>();

/**
 * Titles render 1:1 (emoji and symbols included); only characters that would
 * break the row itself are dropped, emoji are width-stabilized, and inner
 * whitespace collapses so a name with a newline still fits one line.
 */
export function cleanText(s: string): string {
  const hit = cleanCache.get(s);
  if (hit !== undefined) return hit;
  let filtered = "";
  for (const ch of s.normalize("NFC")) {
    const cp = ch.codePointAt(0)!;
    if (!isBreakingCodePoint(cp) && !isInvisibleCodePoint(ch, cp)) {
      filtered += ch;
    }
  }
  // ASCII/BMP-only titles (the overwhelming majority) skip the Segmenter.
  let out = filtered;
  if (NEEDS_STABILIZING.test(filtered)) {
    out = "";
    for (const { segment } of graphemes.segment(filtered)) {
      out += stabilizeCluster(segment);
    }
  }
  const result = out.replace(/\s+/g, " ").trim() || "Untitled";
  if (cleanCache.size >= 4000) cleanCache.clear();
  cleanCache.set(s, result);
  return result;
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

/** Strip scheme and www/m. prefix for a compact URL line in the UI. */
export function displayUrl(url: string): string {
  return url
    .replace(/^https?:\/\//i, "")
    .replace(/^(?:www|m)\./i, "");
}

/**
 * Human label for a pasted collection or track URL. Adapters use this instead
 * of the literal "URL" when listPlaylists returns a single direct link.
 */
export function linkCollectionTitle(url: string): string {
  const fromSlug = slugTitle(url);
  if (fromSlug) return fromSlug;
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(?:www|m)\./i, "").toLowerCase();
    if (host.includes("spotify.com")) {
      const kind = u.pathname.split("/").filter(Boolean)[0];
      if (kind === "album") return "Spotify album";
      if (kind === "playlist") return "Spotify playlist";
      if (kind === "track") return "Spotify track";
    }
    if (host.includes("youtube.com") || host === "youtu.be") {
      if (u.searchParams.has("list") || u.pathname.startsWith("/playlist")) {
        return "YouTube playlist";
      }
      return "YouTube video";
    }
    if (host === "soundcloud.com") {
      const parts = u.pathname.split("/").filter(Boolean);
      if (parts[1] === "sets" && parts[2]) {
        return cleanText(parts[2].replace(/[-_]+/g, " "));
      }
      return "SoundCloud link";
    }
    return cleanText(host);
  } catch {
    return "This link";
  }
}

/** Truncate to `max` characters with a trailing ellipsis. Slices by code
 *  point, never through the middle of a surrogate pair (emoji). */
export function truncate(s: string, max: number): string {
  const chars = [...s];
  if (max <= 1) return chars.slice(0, Math.max(0, max)).join("");
  return chars.length <= max ? s : chars.slice(0, max - 1).join("") + "…";
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
