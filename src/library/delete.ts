// Delete downloaded songs: the file on disk, the now-empty folders above it,
// and the library index entry. Sets are just a list of tracks to the same code.

import { promises as fs } from "node:fs";
import path from "node:path";
import type { Track } from "./types";

/** The one Library method this module needs (narrow so tests can stub it). */
interface RemovesTracks {
  removeMany(ids: string[]): Promise<void>;
}

/**
 * Remove each track's audio file and its index entry. A file that is already
 * gone still counts as removed (the entry is stale either way); a file we
 * can't unlink (e.g. held open by another player) counts as failed and keeps
 * its entry, so the song stays visible instead of orphaned on disk. Callers
 * must stop playback first when the playing song is among the victims: mpv
 * holds the file handle and Windows refuses to unlink it.
 */
export async function deleteTracks(
  library: RemovesTracks,
  tracks: Track[],
  libraryDir: string,
): Promise<{ removed: number; failed: number }> {
  const root = path.resolve(libraryDir);
  let failed = 0;
  // Index entries to drop, batched into one removeMany so a whole set deletes
  // with a single notify + index write instead of one per track.
  const removedIds: string[] = [];
  for (const t of tracks) {
    try {
      await fs.unlink(t.filePath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        failed++;
        continue;
      }
    }
    await pruneEmptyDirs(path.dirname(t.filePath), root);
    removedIds.push(t.id);
  }
  await library.removeMany(removedIds);
  return { removed: removedIds.length, failed };
}

/**
 * Remove now-empty folders walking upward, stopping at the library root
 * (exclusive) or the first folder that still has anything in it. rmdir on a
 * non-empty folder fails, which is exactly the stop condition.
 */
async function pruneEmptyDirs(dir: string, root: string): Promise<void> {
  let d = path.resolve(dir);
  while (d !== root && d.startsWith(root + path.sep)) {
    try {
      await fs.rmdir(d);
    } catch {
      return;
    }
    d = path.dirname(d);
  }
}
