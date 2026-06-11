import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Recover a file path whose name was mangled by a legacy-codepage pipe.
 *
 * When a spawned tool prints a path through a non-UTF-8 stdout, characters it
 * can't encode arrive as "?" (or U+FFFD after decoding). Neither character can
 * appear in a legal Windows filename, so their presence proves the reported
 * name is mangled, never that the file is truly named that way.
 */

const MANGLED = /[?�]/;

/** Optional metadata when yt-dlp's printed path disagrees with the file on disk. */
export interface DownloadFileHints {
  title?: string;
  artist?: string;
}

/**
 * Build a regex matching the real filename behind a mangled one: every "?" or
 * U+FFFD stands for exactly one arbitrary character, everything else literal.
 * The "u" flag makes "." span a full codepoint, since the mangling replaced
 * one codepoint (even astral ones like 𖤐) with one "?".
 */
export function mangledNameToRegex(basename: string): RegExp {
  const escaped = basename.replace(/[.*+^${}()|[\]\\]/g, "\\$&");
  const pattern = escaped.replace(/[?\uFFFD]/g, ".");
  return new RegExp(`^${pattern}$`, "u");
}

/** Compare names ignoring punctuation, spaces, and emoji/symbol differences. */
function normLetters(s: string): string {
  return s.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
}

function looseMatch(a: string, b: string): boolean {
  return normLetters(a) === normLetters(b);
}

/**
 * If `filepath`'s basename looks mangled, scan its directory for the real
 * file. Returns the recovered path only when exactly one entry matches, so an
 * ambiguous directory can never mis-assign a track to the wrong file.
 * Windows-only: "?" is a legal filename character on POSIX.
 */
export async function recoverMangledPath(
  filepath: string,
): Promise<string | undefined> {
  if (process.platform !== "win32") return undefined;
  const base = path.basename(filepath);
  if (!MANGLED.test(base)) return undefined;
  let entries: string[];
  try {
    entries = await fs.readdir(path.dirname(filepath));
  } catch {
    return undefined;
  }
  const re = mangledNameToRegex(base);
  const matches = entries.filter((e) => re.test(e));
  if (matches.length !== 1) return undefined;
  return path.join(path.dirname(filepath), matches[0]!);
}

/** Audio containers yt-dlp can leave behind after `-x` extraction. */
const AUDIO_EXTS = new Set([
  ".opus",
  ".m4a",
  ".mp3",
  ".ogg",
  ".oga",
  ".webm",
  ".flac",
  ".wav",
  ".aac",
]);

/** True if `filePath` exists (a file we can stat). */
async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function stemOf(name: string): string {
  return name.slice(0, name.length - path.extname(name).length);
}

/** Title portion after the last " - " separator, if any. */
function titleFromStem(stem: string): string {
  const idx = stem.lastIndexOf(" - ");
  return idx >= 0 ? stem.slice(idx + 3) : stem;
}

/**
 * Match a filename stem to catalog metadata when yt-dlp dropped the artist
 * prefix, stripped emoji/unicode, or sanitized punctuation differently.
 */
function titleMatchesStem(
  stem: string,
  title: string,
  artist?: string,
): boolean {
  if (looseMatch(stem, title)) return true;
  if (artist && looseMatch(stem, `${artist} - ${title}`)) return true;
  const suffix = titleFromStem(stem);
  if (looseMatch(suffix, title)) return true;
  // yt-dlp sometimes prints "- Title" with the uploader missing from the path.
  const nTitle = normLetters(title);
  if (!nTitle) return false;
  const nStem = normLetters(stem);
  if (nStem === nTitle) return true;
  // Require a reasonable title length so short stems don't collide.
  if (nTitle.length >= 8 && (nStem.endsWith(nTitle) || nTitle.endsWith(nStem))) {
    return true;
  }
  return false;
}

/**
 * Resolve the path yt-dlp actually wrote, given the `filepath` it printed.
 * yt-dlp's `after_move:filepath` can disagree with the file on disk in several
 * systematic ways:
 *   1. A legacy-codepage pipe mangled CJK/astral characters to "?" (Windows).
 *   2. `-x` (extract-audio) reports the pre-extraction container extension
 *      (e.g. "… .m4a") while the kept file carries the extracted codec's
 *      extension (e.g. "… .opus"): same stem, different suffix.
 *   3. The printed path drops or mangles the artist prefix / unicode symbols.
 * Tries exact match, then mangled-name regex, then stem/extension scan, then
 * title/artist hints. Returns undefined when nothing resolves unambiguously.
 */
export async function findDownloadedFile(
  reportedPath: string,
  hints: DownloadFileHints = {},
): Promise<string | undefined> {
  if (await exists(reportedPath)) return reportedPath;

  const dir = path.dirname(reportedPath);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return undefined;
  }

  const base = path.basename(reportedPath);
  const win = process.platform === "win32";

  // (1) Mangled-name recovery (Windows-only; "?"/U+FFFD stand-ins).
  if (win && MANGLED.test(base)) {
    const re = mangledNameToRegex(base);
    const matches = entries.filter((e) => re.test(e));
    if (matches.length === 1) return path.join(dir, matches[0]!);
  }

  // (2) Same stem, any audio extension: covers the `-x` extension mismatch.
  const target = stemOf(base);
  const audioMatches = entries.filter((e) => {
    if (!AUDIO_EXTS.has(path.extname(e).toLowerCase())) return false;
    const s = stemOf(e);
    return win ? looseMatch(s, target) : s === target;
  });
  if (audioMatches.length === 1) return path.join(dir, audioMatches[0]!);

  // (3) Title/artist hints when the printed stem is incomplete or sanitized.
  const { title, artist } = hints;
  if (title) {
    const titleMatches = entries.filter((e) => {
      if (!AUDIO_EXTS.has(path.extname(e).toLowerCase())) return false;
      return titleMatchesStem(stemOf(e), title, artist);
    });
    if (titleMatches.length === 1) return path.join(dir, titleMatches[0]!);
  }

  return undefined;
}
