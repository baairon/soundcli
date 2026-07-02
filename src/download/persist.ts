import { promises as fs, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { queueFile } from "../config/paths";
import type { Library } from "../library/library";
import { libId, type SourceId } from "../library/types";
import { isSoundcloudTombstone } from "../sources/soundcloud";
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
  /** Per-source batch counts to resume rate limiting after restart. */
  perSourceCounts?: Record<string, number>;
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
 * plus SoundCloud tombstones persisted before the enumeration filter existed
 * (deleted tracks that 404 forever; restoring them re-manufactures failures).
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
        isSoundcloudTombstone({
          url: p.track.downloadUrl,
          title: p.track.title,
        })
      ),
  );
}

export async function saveQueue(items: QueueItem[], perSourceCounts?: Map<string, number>): Promise<void> {
  const snapshot: QueueSnapshot = {
    version: 1,
    items: snapshotItems(items),
    perSourceCounts: perSourceCounts ? Object.fromEntries(perSourceCounts) : undefined,
  };
  await fs.mkdir(path.dirname(queueFile), { recursive: true });
  const tmp = `${queueFile}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(snapshot, null, 2), "utf8");
  await fs.rename(tmp, queueFile);
}

/** Synchronous save for app quit, so a partial download survives even on exit. */
export function saveQueueSync(items: QueueItem[], perSourceCounts?: Map<string, number>): void {
  const snapshot: QueueSnapshot = {
    version: 1,
    items: snapshotItems(items),
    perSourceCounts: perSourceCounts ? Object.fromEntries(perSourceCounts) : undefined,
  };
  mkdirSync(path.dirname(queueFile), { recursive: true });
  writeFileSync(queueFile, JSON.stringify(snapshot, null, 2), "utf8");
}

export async function loadQueue(): Promise<{ items: PersistedItem[]; perSourceCounts: Record<string, number> }> {
  try {
    const raw = await fs.readFile(queueFile, "utf8");
    const parsed = JSON.parse(raw) as QueueSnapshot;
    if (parsed && parsed.version === 1 && Array.isArray(parsed.items)) {
      return {
        items: parsed.items,
        perSourceCounts: parsed.perSourceCounts ?? {},
      };
    }
  } catch {
    // missing or invalid: nothing to restore
  }
  return { items: [], perSourceCounts: {} };
}
