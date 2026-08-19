import path from "node:path";
import { promises as fs } from "node:fs";
import { execa } from "execa";
import { resolvedFfmpegPath } from "../bin/ffmpeg-fetch";
import type { Track } from "./types";

/**
 * Mirror a track's library-relative folder structure under `<libraryDir>/mp3/`,
 * swapping the extension to `.mp3`. A track at
 *   `<libraryDir>/YouTube/@nasa/My Playlist/song.opus`
 * converts to
 *   `<libraryDir>/mp3/YouTube/@nasa/My Playlist/song.mp3`.
 *
 * This keeps the per-source / per-owner / per-playlist grouping intact, so
 * converted files sit beside their originals' layout instead of being
 * flattened (which collided same-named files from different playlists and
 * threw away the source/owner hierarchy). Tracks whose `filePath` isn't
 * actually under `libraryDir` (e.g. adopted local files elsewhere) fall back
 * to `<libraryDir>/mp3/<basename>.mp3` so we never write outside the library.
 */
export function mp3MirroredPath(libraryDir: string, track: Track): string {
  const rel = path.relative(libraryDir, track.filePath);
  // `..` segments mean the file lives outside the library: don't mirror a
  // path that would escape `<libraryDir>/mp3/`. Drop to a flat basename.
  const safe = rel && !rel.startsWith("..") && !path.isAbsolute(rel)
    ? rel
    : path.basename(track.filePath);
  const withoutExt = safe.replace(/\.[^./\\]+$/, "");
  return path.join(libraryDir, "mp3", `${withoutExt}.mp3`);
}

export interface ConvertProgress {
  /** 1-based index of the track being processed (includes skips). */
  done: number;
  /** Total non-mp3 tracks in this batch. */
  total: number;
  track: Track;
}

export interface ConvertResult {
  /** Newly converted + already-present skips (matches the old UI counter). */
  converted: number;
  /** Already present on disk, left as-is. */
  skipped: number;
  /** ffmpeg failed for these. */
  failed: number;
}

/**
 * Convert a batch of tracks to MP3 (192k libmp3lame), mirroring each track's
 * library folder structure under `<libraryDir>/mp3/`. Already-mp3 sources are
 * skipped up front; existing mp3 outputs are left untouched (counted as
 * skipped). The caller drives the progress UI through `onProgress`.
 */
export async function convertTracksToMp3(
  libraryDir: string,
  tracks: Track[],
  onProgress?: (p: ConvertProgress) => void,
): Promise<ConvertResult> {
  const toConvert = tracks.filter((t) => !t.filePath.endsWith(".mp3"));
  let converted = 0;
  let skipped = 0;
  let failed = 0;

  for (const track of toConvert) {
    const mp3Path = mp3MirroredPath(libraryDir, track);

    // Skip if the mp3 already exists.
    try {
      await fs.access(mp3Path);
      skipped++;
      converted++;
      onProgress?.({ done: converted, total: toConvert.length, track });
      continue;
    } catch {
      // not present, proceed
    }

    onProgress?.({ done: converted + 1, total: toConvert.length, track });

    try {
      await fs.mkdir(path.dirname(mp3Path), { recursive: true });
      await execa(resolvedFfmpegPath(), [
        "-i",
        track.filePath,
        "-codec:a",
        "libmp3lame",
        "-b:a",
        "192k",
        mp3Path,
      ]);
      converted++;
    } catch (e) {
      failed++;
      console.error(`Failed to convert ${track.title}:`, e);
    }
  }

  return { converted, skipped, failed };
}
