// Turning playlists into queued tracks. Shared by the dashboard's add flows,
// so a batch is gathered the same way whoever asked for it.

import type { SourceAdapter, SourcePlaylist } from "../sources/types";
import type { DownloadQueue } from "./queue";

export interface GatherResult {
  /** Tracks listed across everything gathered. */
  total: number;
  /** Tracks that entered the queue. */
  added: number;
  /** Tracks the library already holds. */
  alreadySaved: number;
  /** Tracks that need a real download. */
  newTracks: number;
  /** The first listing failure, for callers that end up with nothing queued. */
  firstError?: string;
  /** The queue was canceled or cleared while lists were still loading. */
  aborted: boolean;
}

function emptyResult(): GatherResult {
  return { total: 0, added: 0, alreadySaved: 0, newTracks: 0, aborted: false };
}

/**
 * Enumerate the lists concurrently and enqueue each one's tracks the moment
 * they're ready, so downloads start within seconds instead of waiting for
 * every list to be fetched first.
 *
 * The gather keeps running after the caller moves on to watching the queue, so
 * a mid-gather cancel must stop it: otherwise each list that finishes loading
 * would re-enqueue (and revive) the just-canceled queue. The queue hands out
 * an abort signal; cancelAll/clearAll trip it and we bail before enqueuing.
 */
export async function gatherLists(
  queue: DownloadQueue,
  adapter: SourceAdapter,
  lists: SourcePlaylist[],
  onProgress?: (done: number, total: number) => void,
): Promise<GatherResult> {
  const result = emptyResult();
  const signal = queue.beginGather();
  let gathered = 0;
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < lists.length) {
      if (signal.aborted) return;
      const pl = lists[cursor++]!;
      try {
        const tracks = await adapter.listTracks(pl);
        if (signal.aborted) return; // canceled mid-fetch: don't revive the queue
        if (tracks.length > 0) {
          const r = queue.enqueue(
            tracks.map((t) => ({
              source: adapter.id,
              sourceLabel: adapter.label,
              track: t,
            })),
          );
          result.total += r.total;
          result.added += r.added;
          result.alreadySaved += r.alreadySaved;
          result.newTracks += r.newTracks;
        }
      } catch (e) {
        result.firstError ??= e instanceof Error ? e.message : String(e);
      }
      gathered++;
      onProgress?.(gathered, lists.length);
    }
  };
  try {
    await Promise.all(
      Array.from({ length: Math.min(5, lists.length) }, () => worker()),
    );
  } finally {
    queue.endGather(signal);
  }
  result.aborted = signal.aborted;
  return result;
}
