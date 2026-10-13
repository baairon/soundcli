// Turning playlists and links into queued tracks. Shared by the dashboard's
// add flows and by `sndcli add`, so a batch is gathered the same way whoever
// asked for it.

import type { Config } from "../config/config";
import { SOURCE_LABELS, type SourceId } from "../library/types";
import { ownerForHandle } from "../sources/accounts";
import { tracksFromUrl } from "../sources/enqueue-url";
import { ownerFromHandle } from "../sources/handle";
import { adapterFor, type LinkTarget } from "../sources/resolve-link";
import type {
  SourceAdapter,
  SourcePlaylist,
  SourceTrack,
} from "../sources/types";
import type { DownloadQueue } from "./queue";

type OkTarget = Extract<LinkTarget, { ok: true }>;

/** Re-home a listed track before it is queued, or drop it (undefined). */
export type Place = (track: SourceTrack) => SourceTrack | undefined;

export interface GatherOptions {
  front?: boolean;
  place?: Place;
}

/** What a caller asked for beyond the link itself. */
export interface Placement {
  /** A folder of the user's own collection to save into (see `--into`). */
  into?: string;
  /** Ids to leave alone: what a watched link listed before it was watched. */
  seen?: readonly string[];
}

export interface GatherResult {
  /** Tracks listed across everything gathered. */
  total: number;
  /** Tracks that entered the queue. */
  added: number;
  /** Tracks the library already holds. */
  alreadySaved: number;
  /** Tracks that need a real download. */
  newTracks: number;
  /** Tracks left alone because they failed for good not long ago. */
  unavailable: number;
  /** The first listing failure, for callers that end up with nothing queued. */
  firstError?: string;
  /** The queue was canceled or cleared while lists were still loading. */
  aborted: boolean;
}

function emptyResult(): GatherResult {
  return {
    total: 0,
    added: 0,
    alreadySaved: 0,
    newTracks: 0,
    unavailable: 0,
    aborted: false,
  };
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
  opts: GatherOptions = {},
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
        const tracks = placed(await adapter.listTracks(pl), opts.place);
        if (signal.aborted) return; // canceled mid-fetch: don't revive the queue
        if (tracks.length > 0) {
          const r = queue.enqueue(
            tracks.map((t) => ({
              source: adapter.id,
              sourceLabel: adapter.label,
              track: t,
            })),
            opts,
          );
          result.total += r.total;
          result.added += r.added;
          result.alreadySaved += r.alreadySaved;
          result.newTracks += r.newTracks;
          result.unavailable += r.unavailable;
        }
      } catch (e) {
        result.firstError ??= reason(e);
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

function placed(tracks: SourceTrack[], place?: Place): SourceTrack[] {
  if (!place) return tracks;
  return tracks.flatMap((t) => place(t) ?? []);
}

const NOTHING_PUBLIC = "Nothing public to download there.";
const UNREADABLE = "Couldn't read that link.";

/**
 * Why a listing failed, never empty: callers tell a failed link from a fine
 * one by whether there is a reason, and an error can arrive with no message.
 */
function reason(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)) || UNREADABLE;
}

/** The adapter for a link that names lists, and the lists it asks for. */
async function pickLists(
  target: Extract<OkTarget, { kind: "lists" }>,
): Promise<{ adapter: SourceAdapter; lists: SourcePlaylist[] }> {
  const adapter = adapterFor(target.source, target.input);
  const lists = await adapter.listPlaylists();
  return {
    adapter,
    lists:
      target.pick === "all"
        ? lists
        : target.pick === "liked"
          ? lists.filter((l) => l.kind === "liked")
          : lists.slice(0, 1),
  };
}

/**
 * Queue whatever a routed link points at: one song read directly, or the
 * lists it names gathered through the source's adapter. Never throws; a link
 * that could not be read comes back with `firstError` and nothing added.
 */
export async function enqueueTarget(
  queue: DownloadQueue,
  target: OkTarget,
  opts: GatherOptions = {},
): Promise<GatherResult> {
  try {
    if (target.kind === "track") {
      const listed = await tracksFromUrl(target.source, target.url);
      if (listed.length === 0) {
        return { ...emptyResult(), firstError: UNREADABLE };
      }
      const r = queue.enqueue(
        placed(listed, opts.place).map((t) => ({
          source: target.source,
          sourceLabel: SOURCE_LABELS[target.source],
          track: t,
        })),
        opts,
      );
      return { ...r, aborted: false };
    }

    const { adapter, lists } = await pickLists(target);
    if (lists.length === 0) {
      return { ...emptyResult(), firstError: NOTHING_PUBLIC };
    }
    return await gatherLists(queue, adapter, lists, undefined, opts);
  } catch (e) {
    return { ...emptyResult(), firstError: reason(e) };
  }
}

/**
 * Everything a routed link lists right now, with nothing queued: what a watch
 * records so that only later arrivals count as new. Throws when any of it
 * can't be read, since a partial answer would pass old songs off as new ones.
 */
export async function listTarget(target: OkTarget): Promise<SourceTrack[]> {
  if (target.kind === "track") {
    const listed = await tracksFromUrl(target.source, target.url);
    if (listed.length === 0) throw new Error(UNREADABLE);
    return listed;
  }
  const { adapter, lists } = await pickLists(target);
  if (lists.length === 0) throw new Error(NOTHING_PUBLIC);
  const out: SourceTrack[] = [];
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < lists.length) {
      out.push(...(await adapter.listTracks(lists[cursor++]!)));
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(5, lists.length) }, () => worker()),
  );
  return out;
}

/**
 * How a link's tracks are filed when the caller asked for more than the link:
 * the ones a watch has already seen are dropped, and `into` re-homes the rest
 * in a folder of the user's own collection. That means their owner, the one
 * their handle for this source leads to, so a song saved here is the same
 * library entry a like or a set of theirs would name. Spotify is never
 * owner-scoped and a generic site keeps its own folder; both only change the
 * playlist. Undefined when there is nothing to change.
 */
export async function placement(
  source: SourceId,
  asked: Placement,
  config: Config,
): Promise<Place | undefined> {
  const { into } = asked;
  const seen = new Set(asked.seen);
  if (!into && seen.size === 0) return undefined;
  const handle =
    source === "youtube"
      ? config.youtubeHandle
      : source === "soundcloud"
        ? config.soundcloudHandle
        : undefined;
  const mine =
    into && handle
      ? await ownerForHandle(source, ownerFromHandle(handle))
      : undefined;
  return (t) => {
    if (seen.has(t.id)) return undefined;
    if (!into) return t;
    return {
      ...t,
      owner: source === "link" ? t.owner : mine,
      playlistTitle: into,
      // A folder of one's own follows no feed, so it carries no feed order.
      position: undefined,
    };
  };
}

/** Queue a routed link the way its caller asked for it (see placement). */
export async function enqueueAsked(
  queue: DownloadQueue,
  target: OkTarget,
  asked: Placement,
  opts: { front?: boolean } = {},
): Promise<GatherResult> {
  const place = await placement(target.source, asked, queue.getConfig());
  return enqueueTarget(queue, target, { ...opts, place });
}
