import { promises as fs } from "node:fs";
import path from "node:path";
import { dirname } from "node:path";
import { execa } from "execa";
import { resolvedFfmpegPath } from "../bin/ffmpeg-fetch";
import { downloadLogFile } from "../config/paths";
import type { AudioFormat } from "../ytdlp/args";
import type { Track } from "./types";

/**
 * Encoder settings per target container. Bitrates are the point where another
 * generation of lossy re-encoding stops being audible against sources that
 * hand us 128 to 256k in the first place; opus reaches the same place lower.
 */
const ENCODER: Record<AudioFormat, string[]> = {
  m4a: ["-c:a", "aac", "-b:a", "192k"],
  mp3: ["-c:a", "libmp3lame", "-b:a", "192k", "-id3v2_version", "3"],
  opus: ["-c:a", "libopus", "-b:a", "128k"],
};

/**
 * Cover art rides along for m4a and mp3, which both carry an embedded picture
 * stream. Opus keeps art in a metadata block ffmpeg cannot fill from an mjpeg
 * stream, so that conversion drops the video stream instead of failing on it.
 */
const ART: Record<AudioFormat, string[]> = {
  m4a: ["-c:v", "copy"],
  mp3: ["-c:v", "copy"],
  opus: ["-vn"],
};

/**
 * The muxer, named rather than inferred. ffmpeg reads the output container off
 * the file extension, and the temp file deliberately ends in `.tmp` so that a
 * leftover from a crash is invisible to the library walk (which only sees the
 * extensions in AUDIO_EXTS). Naming the muxer is what lets it keep that
 * extension.
 */
const MUXER: Record<AudioFormat, string> = {
  m4a: "ipod",
  mp3: "mp3",
  opus: "opus",
};

/** Same folder, same name, new extension: the library's layout never moves. */
export function targetPath(filePath: string, format: AudioFormat): string {
  const dir = path.dirname(filePath);
  const stem = path.basename(filePath, path.extname(filePath));
  return path.join(dir, `${stem}.${format}`);
}

/** True when this track is not already in the target format. */
export function needsConversion(track: Track, format: AudioFormat): boolean {
  return path.extname(track.filePath).toLowerCase() !== `.${format}`;
}

export interface ConvertProgress {
  /** Songs actually re-encoded so far. Never counts a failure as a success. */
  converted: number;
  /** Songs ffmpeg could not convert so far. */
  failed: number;
  /** Songs that need re-encoding; already-correct ones are excluded. */
  total: number;
}

export interface ConvertResult {
  /** Files re-encoded and swapped into place. */
  converted: number;
  /** Paths ffmpeg could not convert; their originals are still there. */
  failed: string[];
  /** True when a stop was requested before the batch finished. */
  stopped: boolean;
  /**
   * This ffmpeg cannot make this format at all. ffmpeg-static repackages a
   * different upstream builder per OS, so rather than assume every one of them
   * ships libmp3lame and libopus, the first "unknown encoder" ends the run:
   * one clear answer beats the same failure repeated for every song.
   */
  missingEncoder: boolean;
}

/** ffmpeg's own words for a codec this build was not compiled with. */
function isMissingEncoder(detail: string): boolean {
  return /unknown encoder|encoder not found|could not find encoder/i.test(
    detail,
  );
}

/** One line per failure so "2 failed" has somewhere to lead. */
async function logFailure(filePath: string, detail: string): Promise<void> {
  if (process.env.VITEST) return;
  try {
    await fs.mkdir(dirname(downloadLogFile), { recursive: true });
    await fs.appendFile(
      downloadLogFile,
      `${new Date().toISOString()} [convert] ${filePath} | ${detail}\n`,
    );
  } catch {
    // Never let logging affect the conversion.
  }
}

/**
 * Re-encode a library into one format, in place.
 *
 * Every file is replaced where it already lives, so the
 * `<Source>/<owner>/<playlist>/` layout survives and no second copy of the
 * library appears on disk. Each track is its own atomic step: ffmpeg writes a
 * sibling temp file, that file is renamed over the target, and only then is
 * the original removed. A crash, a failure or a stop therefore leaves every
 * track as either its old file or its new one, never neither, and re-running
 * skips whatever already landed rather than starting over.
 *
 * Returns the counts for the UI plus the tracks whose paths changed, which the
 * caller writes back with `library.upsertMany`.
 */
export async function convertLibrary(
  tracks: readonly Track[],
  format: AudioFormat,
  opts: {
    onProgress?: (p: ConvertProgress) => void;
    signal?: AbortSignal;
  } = {},
): Promise<{ result: ConvertResult; changed: Track[] }> {
  const { onProgress, signal } = opts;
  // Filtered here as well as by the caller: this is the module's own rule, and
  // it keeps a song that is already right from being re-encoded onto itself.
  const pending = tracks.filter((t) => needsConversion(t, format));
  const result: ConvertResult = {
    converted: 0,
    failed: [],
    stopped: false,
    missingEncoder: false,
  };
  const changed: Track[] = [];
  const total = pending.length;

  for (const track of pending) {
    if (signal?.aborted) {
      result.stopped = true;
      break;
    }
    onProgress?.({
      converted: result.converted,
      failed: result.failed.length,
      total,
    });

    const target = targetPath(track.filePath, format);
    const temp = `${target}.tmp`;
    try {
      await execa(
        resolvedFfmpegPath(),
        [
          "-y",
          "-loglevel",
          "error",
          "-i",
          track.filePath,
          "-map_metadata",
          "0",
          ...ART[format],
          ...ENCODER[format],
          "-f",
          MUXER[format],
          temp,
        ],
        { cancelSignal: signal },
      );
      // Only now is it safe to disturb what the user already has.
      await fs.rename(temp, target);
      if (target !== track.filePath) {
        await fs.rm(track.filePath, { force: true });
      }
      const size = await fs.stat(target).then(
        (s) => s.size,
        () => undefined,
      );
      changed.push({ ...track, filePath: target, fileSize: size });
      result.converted++;
    } catch (e) {
      await fs.rm(temp, { force: true }).catch(() => {});
      if (signal?.aborted) {
        // The stop killed ffmpeg mid-encode; that is not a failed track.
        result.stopped = true;
        break;
      }
      const detail = e instanceof Error ? e.message : String(e);
      await logFailure(track.filePath, detail);
      if (isMissingEncoder(detail)) {
        // Nothing was touched, and nothing would be: stop on the first one.
        result.missingEncoder = true;
        break;
      }
      result.failed.push(track.filePath);
    }
  }

  onProgress?.({
    converted: result.converted,
    failed: result.failed.length,
    total,
  });
  return { result, changed };
}
