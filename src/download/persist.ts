import { promises as fs, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { queueFile } from "../config/paths";
import type { Library } from "../library/library";
import { libId, type SourceId } from "../library/types";
import {
  isSoundcloudTombstone,
  SOUNDCLOUD_LIKED_TITLE,
} from "../sources/soundcloud";
import type { SourceTrack } from "../sources/types";
import type { QueueItem } from "./queue";

/** The unfinished part of a download we save to disk so it survives a restart. */
export interface PersistedItem {
  source: SourceId;
  sourceLabel: string;
  track: SourceTrack;
  status: "pending" | "paused";
  /** Spotify-only: carried so an unverified-match flag survives a restart. */
  unverifiedMatch?: boolean;
}

/** A track that failed for good: how often in a row, when last, and why. */
export interface DeadTrack {
  fails: number;
  last: number;
  error: string;
}

interface QueueSnapshot {
  version: 1;
  items: PersistedItem[];
  /** Absent in a file written before the pacing budget was saved. */
  youtubeStarts?: number[];
  dead?: Record<string, DeadTrack>;
}

/** What a saved queue brings back. */
export interface SavedQueue {
  items: PersistedItem[];
  /**
   * When recent YouTube-backed downloads started. Saved so the pacing budget
   * outlives the process: otherwise every `sndcli add` and every relaunch
   * would open with a full burst.
   */
  youtubeStarts: number[];
  /** Tracks that failed for good, by library id (see the queue's `dead`). */
  dead?: Record<string, DeadTrack>;
}

/**
 * The unfinished items worth persisting. Downloading items become "pending"
 * (they resume from their .part next launch); done/skipped/error/canceled drop.
 */
export function snapshotItems(items: QueueItem[]): PersistedItem[] {
  const out: PersistedItem[] = [];
  for (const i of items) {
    if (i.status === "pending" || i.status === "downloading") {
      out.push({
        source: i.source,
        sourceLabel: i.sourceLabel,
        track: i.track,
        status: "pending",
        unverifiedMatch: i.unverifiedMatch,
      });
    } else if (i.status === "paused") {
      out.push({
        source: i.source,
        sourceLabel: i.sourceLabel,
        track: i.track,
        status: "paused",
        unverifiedMatch: i.unverifiedMatch,
      });
    }
  }
  return out;
}

/**
 * Drop anything that already landed in the library (finished before a crash),
 * plus SoundCloud liked-feed tombstones persisted before the enumeration
 * filter existed (deleted tracks that 404 forever; restoring them
 * re-manufactures failures). Scoped to the likes feed to mirror enumeration:
 * bare api-v2 URLs inside real sets are kept, since yt-dlp resolves those
 * during download.
 */
export function restorableItems(
  persisted: PersistedItem[],
  library: Library,
): PersistedItem[] {
  return persisted.filter(
    (p) =>
      !library.has(libId(p.source, p.track.id, p.track.owner)) &&
      !(
        p.source === "soundcloud" &&
        p.track.playlistTitle === SOUNDCLOUD_LIKED_TITLE &&
        isSoundcloudTombstone({
          url: p.track.downloadUrl,
          title: p.track.title,
        })
      ),
  );
}

function snapshot(items: QueueItem[], rest: Omit<SavedQueue, "items">): string {
  const all: QueueSnapshot = { version: 1, items: snapshotItems(items), ...rest };
  return JSON.stringify(all, null, 2);
}

export async function saveQueue(
  items: QueueItem[],
  rest: Omit<SavedQueue, "items">,
  /** Asked once the write is ready to go into place. */
  wanted: () => boolean = () => true,
  file: string = queueFile,
): Promise<void> {
  // The suite runs real queues, and every one of them would otherwise
  // overwrite the user's own saved queue with its fixtures.
  if (process.env.VITEST && file === queueFile) return;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, snapshot(items, rest), "utf8");
  // The write at quit may have happened while this one was on its way (see
  // saveQueueSync): an older one never goes over it.
  if (!wanted()) return;
  await fs.rename(tmp, file);
}

/**
 * Synchronous save for app quit, so a partial download survives even on exit.
 * Written beside the queue and renamed over it: a run killed part-way through
 * this write leaves the last complete save, where half a file would read as
 * an empty queue.
 */
export function saveQueueSync(
  items: QueueItem[],
  rest: Omit<SavedQueue, "items">,
  file: string = queueFile,
): void {
  // Only the user's own queue is off limits to the suite (see saveQueue).
  if (process.env.VITEST && file === queueFile) return;
  mkdirSync(path.dirname(file), { recursive: true });
  const text = snapshot(items, rest);
  try {
    const tmp = `${file}.quit.tmp`;
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, file);
  } catch {
    // Windows refuses the rename while a scanner has the file open. A save
    // written in place still beats no save at all on the way out.
    writeFileSync(file, text, "utf8");
  }
}

export async function loadQueue(): Promise<SavedQueue> {
  try {
    const raw = await fs.readFile(queueFile, "utf8");
    const parsed = JSON.parse(raw) as QueueSnapshot;
    if (parsed && parsed.version === 1 && Array.isArray(parsed.items)) {
      const starts = parsed.youtubeStarts;
      return {
        items: parsed.items,
        youtubeStarts: Array.isArray(starts) ? starts : [],
        dead: parsed.dead,
      };
    }
  } catch {
    // missing or invalid: nothing to restore
  }
  return { items: [], youtubeStarts: [] };
}
