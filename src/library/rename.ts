import { promises as fs } from "node:fs";
import path from "node:path";
import type { Track } from "./types";
import { fileExists } from "./drift";
import { sanitizeName } from "../ytdlp/args";

export type RenameResult = "renamed" | "collision" | "failed" | "noop";

/** The slice of Library that renames need; tests can fake it. */
export interface UpsertsTracks {
  upsert(track: Track): Promise<void>;
  upsertMany(tracks: Track[]): Promise<void>;
}

/** Same path modulo case, so a case-only rename isn't mistaken for a collision
 *  with itself on case-insensitive filesystems (Windows, default macOS). */
function samePathish(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Retitle a track and move its file to match, keeping the download layout's
 * "Artist - Title.ext" shape so a later re-adoption parses it back. The index
 * only changes when the disk does: a failed move changes nothing, because a
 * metadata-only title is silently reverted by the next reconcile relink.
 */
export async function renameTrack(
  library: UpsertsTracks,
  track: Track,
  newTitle: string,
): Promise<RenameResult> {
  const title = newTitle.trim();
  if (!title || title === track.title) return "noop";

  const ext = path.extname(track.filePath);
  const stem = track.artist
    ? `${sanitizeName(track.artist)} - ${sanitizeName(title)}`
    : sanitizeName(title);
  const newPath = path.join(path.dirname(track.filePath), `${stem}${ext}`);

  // Sanitizing collapsed the change away: the file already has this name, so
  // only the display title moves (safe: reconcile never derives titles for
  // owned tracks from filenames).
  if (newPath === track.filePath) {
    await library.upsert({ ...track, title });
    return "renamed";
  }

  // Never move onto an existing file: fs.rename silently overwrites on POSIX,
  // which would destroy the other track's audio.
  if (!samePathish(newPath, track.filePath) && (await fileExists(newPath))) {
    return "collision";
  }

  try {
    await fs.rename(track.filePath, newPath);
  } catch {
    return "failed";
  }
  await library.upsert({ ...track, title, filePath: newPath });
  return "renamed";
}

/**
 * Rename a playlist by renaming its folder(s) on disk in one move each (no
 * per-file shuffling, no leftover empty folder), then re-point every track.
 * Folders are the organizing truth, so the next reconcile agrees with us.
 */
export async function renamePlaylist(
  library: UpsertsTracks,
  tracks: Track[],
  newName: string,
): Promise<RenameResult> {
  const name = newName.trim();
  if (!name || tracks.length === 0) return "noop";
  const folder = sanitizeName(name);

  // A set normally lives in one folder, but grouping tolerates strays; move
  // each distinct parent. Refuse the whole rename if any target already
  // exists: merging into another playlist's folder invites dedupe deletions.
  const dirs = [...new Set(tracks.map((t) => path.dirname(t.filePath)))];
  const moves: Array<{ from: string; to: string }> = [];
  for (const dir of dirs) {
    const to = path.join(path.dirname(dir), folder);
    if (to === dir) continue;
    if (!samePathish(to, dir) && (await fileExists(to))) return "collision";
    moves.push({ from: dir, to });
  }

  try {
    for (const m of moves) await fs.rename(m.from, m.to);
  } catch {
    // A partial move heals on the next reconcile: basenames are untouched, so
    // relink re-finds every file wherever it landed.
    return "failed";
  }

  const dest = new Map(moves.map((m) => [m.from, m.to]));
  await library.upsertMany(
    tracks.map((t) => {
      const dir = path.dirname(t.filePath);
      const moved = dest.get(dir);
      return {
        ...t,
        playlist: name,
        filePath: moved ? path.join(moved, path.basename(t.filePath)) : t.filePath,
      };
    }),
  );
  return moves.length > 0 || tracks.some((t) => t.playlist !== name)
    ? "renamed"
    : "noop";
}
