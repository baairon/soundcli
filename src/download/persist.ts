import { promises as fs, writeFileSync, mkdirSync } from "node:fs";
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

interface QueueSnapshot {
  version: 1;
  items: PersistedItem[];
  /** Absent in a file written before the pacing budget was saved. */
  youtubeStarts?: number[];
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

function snapshot(items: QueueItem[], youtubeStarts: number[]): string {
  const all: QueueSnapshot = { version: 1, items: snapshotItems(items), youtubeStarts };
  return JSON.stringify(all, null, 2);
}

export async function saveQueue(
  items: QueueItem[],
  youtubeStarts: number[],
): Promise<void> {
  // The suite runs real queues, and every one of them would otherwise
  // overwrite the user's own saved queue with its fixtures.
  if (process.env.VITEST) return;
  await fs.mkdir(path.dirname(queueFile), { recursive: true });
  const tmp = `${queueFile}.tmp`;
  await fs.writeFile(tmp, snapshot(items, youtubeStarts), "utf8");
  await fs.rename(tmp, queueFile);
}

/** Synchronous save for app quit, so a partial download survives even on exit. */
export function saveQueueSync(items: QueueItem[], youtubeStarts: number[]): void {
  if (process.env.VITEST) return;
  mkdirSync(path.dirname(queueFile), { recursive: true });
  writeFileSync(queueFile, snapshot(items, youtubeStarts), "utf8");
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
      };
    }
  } catch {
    // missing or invalid: nothing to restore
  }
  return { items: [], youtubeStarts: [] };
}
