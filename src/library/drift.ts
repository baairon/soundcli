import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { SOURCE_LABELS, type SourceId, type Track } from "./types";
import { sanitizeName } from "../ytdlp/args";

/** A set of library entries that are all the same song. */
export interface DuplicateGroup {
  signature: string;
  tracks: Track[];
}

/**
 * A normalized "this is the same song in the same collection" key: lowercased
 * artist + title with emoji/symbols stripped, scoped to the (source, owner)
 * collection it belongs to. Within one collection a song never saves twice
 * (likes vs a set of the same handle still dedupe); different handles keep
 * complete, self-contained copies. Ownerless tracks (Spotify, legacy entries)
 * share one global bucket, preserving the old cross-source dedupe for them.
 */
export function trackSignature(
  t: Pick<Track, "artist" | "title" | "owner"> & { source?: Track["source"] },
): string {
  const artist = foldForSignature((t.artist ?? "").toLowerCase());
  const title = foldForSignature((t.title ?? "").toLowerCase());
  const collection = t.owner ? `${t.source ?? ""}:${t.owner.toLowerCase()}` : "";
  return `${collection}|${artist}|${title}`;
}

/**
 * Emoji/symbol-insensitive folding for dedupe signatures only. Display now
 * renders titles 1:1, but signatures must keep the historical strict strip or
 * previously-merged duplicates ("🔥 Song" vs "Song") stop matching.
 */
function foldForSignature(s: string): string {
  let out = "";
  for (const ch of s.normalize("NFC")) {
    const cp = ch.codePointAt(0)!;
    const junk =
      cp < 0x20 ||
      cp === 0x7f ||
      cp === 0xfffd ||
      (cp >= 0x200b && cp <= 0x200f) ||
      (cp >= 0x2028 && cp <= 0x202e) ||
      cp === 0x2060 ||
      cp === 0xfeff ||
      cp === 0xfe0f ||
      cp === 0x20e3 ||
      (cp >= 0x2190 && cp <= 0x21ff) ||
      (cp >= 0x2300 && cp <= 0x23ff) ||
      (cp >= 0x2600 && cp <= 0x27bf) ||
      (cp >= 0x2b00 && cp <= 0x2bff) ||
      (cp >= 0x1f000 && cp <= 0x1ffff);
    if (!junk) out += ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

/** Group tracks by signature, returning only the groups with 2+ members. */
export function findDuplicates(tracks: Track[]): DuplicateGroup[] {
  const groups = new Map<string, Track[]>();
  for (const t of tracks) {
    const sig = trackSignature(t);
    const arr = groups.get(sig);
    if (arr) arr.push(t);
    else groups.set(sig, [t]);
  }
  const out: DuplicateGroup[] = [];
  for (const [signature, members] of groups) {
    if (members.length > 1) out.push({ signature, tracks: members });
  }
  return out;
}

/**
 * True if the file at `filePath` still exists on disk. An optional shared
 * cache lets boot-time passes (migrate + reconcile) stat each path once
 * instead of once per pass; writers must keep the cache honest on renames.
 */
export async function fileExists(
  filePath: string,
  cache?: Map<string, boolean>,
): Promise<boolean> {
  const hit = cache?.get(filePath);
  if (hit !== undefined) return hit;
  let exists: boolean;
  try {
    await fs.access(filePath);
    exists = true;
  } catch {
    exists = false;
  }
  cache?.set(filePath, exists);
  return exists;
}

/** Audio extensions soundcli writes; the rescan skips artwork, json, and .part. */
export const AUDIO_EXTS = new Set([
  ".mp3",
  ".m4a",
  ".opus",
  ".flac",
  ".wav",
  ".ogg",
  ".aac",
  ".webm",
]);

/**
 * Walk `dir` recursively and group every audio file by its basename, so a track
 * whose file was moved or reorganized inside the library can be re-found by
 * name. Plain fs recursion (cross-OS, no watchers); a missing or unreadable dir
 * yields an empty map, and non-audio files (artwork, json, .part) are skipped.
 */
export async function indexAudioByBasename(
  dir: string,
): Promise<Map<string, string[]>> {
  const byBasename = new Map<string, string[]>();
  const walk = async (d: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (
        e.isFile() &&
        AUDIO_EXTS.has(path.extname(e.name).toLowerCase())
      ) {
        const arr = byBasename.get(e.name);
        if (arr) arr.push(full);
        else byBasename.set(e.name, [full]);
      }
    }
  };
  await walk(dir);
  return byBasename;
}

const SOURCE_BY_FOLDER = new Map<string, SourceId>(
  (Object.entries(SOURCE_LABELS) as [SourceId, string][]).map(
    ([id, label]) => [label, id],
  ),
);

/**
 * The tab a track displays under: the top-level source folder its file sits
 * in, so the visible grouping follows the file manager like playlists do.
 * Anything under an unrecognized folder, or loose at the library root, reads
 * as "local"; a file living outside the library keeps its download
 * provenance. Display-only: `track.source` (identity, dedupe scope) never
 * changes.
 */
export function displaySource(
  t: Track,
  libraryDir: string | undefined,
): SourceId {
  if (!libraryDir) return t.source;
  const rel = path.relative(libraryDir, t.filePath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return t.source;
  const segs = rel.split(path.sep);
  if (segs.length < 2) return "local"; // loose at the library root
  return SOURCE_BY_FOLDER.get(segs[0]!) ?? "local";
}

/**
 * The playlist a file's location implies, so on-disk organization is the
 * source of truth for grouping: the immediate parent folder's name, after
 * stepping past the source root (YouTube, SoundCloud, …) and its owner
 * segment. "Singles" mirrors the download layout's no-playlist folder, and a
 * file sitting at the library root or a source root has no playlist. Assumes
 * `filePath` is inside `libraryDir` (both relink and adoption guarantee it).
 */
export function playlistFromPath(
  filePath: string,
  libraryDir: string,
  owner?: string,
): string | undefined {
  const rel = path.relative(libraryDir, filePath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  const segs = rel.split(path.sep).slice(0, -1);
  if (segs[0] !== undefined && SOURCE_BY_FOLDER.has(segs[0])) segs.shift();
  if (owner && segs[0] === sanitizeName(owner)) segs.shift();
  const parent = segs[segs.length - 1];
  if (!parent || parent === "Singles") return undefined;
  return parent;
}

/**
 * The owner-handle segment the download layout reserves under a source root
 * (<Source>/<owner>/...), or undefined when the file doesn't sit in one.
 * Purely positional: whether the segment really names an owner is decided by
 * whoever holds matching metadata (see reconcile's owner healing).
 */
export function ownerFolderOf(
  filePath: string,
  libraryDir: string,
): string | undefined {
  const rel = path.relative(libraryDir, filePath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  const segs = rel.split(path.sep).slice(0, -1);
  if (segs.length < 2) return undefined; // owner folders sit below a source root
  return SOURCE_BY_FOLDER.has(segs[0]!) ? segs[1] : undefined;
}

/**
 * Grouping key for the playlists panel: the folder the file sits in, so
 * on-disk organization is the single truth for what forms a set and metadata
 * drift (a missing owner, a cross-source stray) can never split a folder
 * into look-alike playlists. Case-folded, since Windows paths are
 * case-insensitive and a false merge elsewhere is harmless. Undefined for a
 * file outside the library (or no library dir): callers fall back to
 * metadata grouping.
 */
export function setFolderKey(
  t: Track,
  libraryDir: string | undefined,
): string | undefined {
  if (!libraryDir) return undefined;
  const rel = path.relative(libraryDir, path.dirname(t.filePath));
  if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  return `dir|${rel.toLowerCase()}`;
}

/**
 * Title (and artist, when present) from a filename shaped like the download
 * layout writes them: "Artist - Title.ext". Anything without the separator is
 * all title.
 */
export function titleFromFilename(name: string): {
  title: string;
  artist?: string;
} {
  const stem = name.replace(/\.[^.]+$/, "").trim();
  const i = stem.indexOf(" - ");
  if (i > 0) {
    const artist = stem.slice(0, i).trim();
    const title = stem.slice(i + 3).trim();
    if (artist && title) return { title, artist };
  }
  return { title: stem || name };
}

/** Byte size of a file, or undefined if it can't be stat'd. */
export async function fileSizeOf(
  filePath: string,
): Promise<number | undefined> {
  try {
    return (await fs.stat(filePath)).size;
  } catch {
    return undefined;
  }
}
