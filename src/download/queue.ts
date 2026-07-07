import { EventEmitter } from "node:events";
import { basename, dirname, join, relative, resolve } from "node:path";
import { constants as fsConstants, promises as fs } from "node:fs";
import type { Config } from "../config/config";
import { downloadLogFile } from "../config/paths";
import type { Library } from "../library/library";
import { libId, type SourceId, type Track } from "../library/types";
import type { SourceTrack } from "../sources/types";
import { playlistFromPath, trackSignature } from "../library/drift";
import { findDownloadedFile } from "../util/recover-path";
import {
  downloadTrack,
  enumerate,
  type DownloadParams,
  type DownloadResult,
} from "../ytdlp/ytdlp";
import { renameTrack } from "../library/rename";
import type { DownloadProgress } from "../ytdlp/progress";
import { resolveSpotifyDownloadUrl } from "../sources/spotify/resolve";
import { sanitizeName } from "../ytdlp/args";
import {
  restorableItems,
  saveQueue,
  saveQueueSync,
  type PersistedItem,
} from "./persist";

export type QueueStatus =
  | "pending"
  | "downloading"
  | "paused"
  | "done"
  | "skipped"
  | "error"
  | "canceled";

export interface QueueItem {
  id: string;
  source: SourceId;
  sourceLabel: string;
  track: SourceTrack;
  status: QueueStatus;
  percent: number;
  speed?: number; // bytes/sec
  eta?: number; // seconds
  error?: string;
  /**
   * Spotify only: true when YouTube matching found no confident result and we
   * fell back to the blind ytsearch1 query, so the audio may be the wrong cut.
   * Shown as "saved, unverified" in the queue UI and exempt from auto-clear.
   */
  unverifiedMatch?: boolean;
}

export interface EnqueueInput {
  source: SourceId;
  sourceLabel: string;
  track: SourceTrack;
}

export interface QueueStats {
  total: number;
  /** Tracks considered in the current batch, including already-saved items. */
  inputTotal: number;
  /** Input tracks that were already represented in the library. */
  alreadySaved: number;
  /** Input tracks that require a real network download. */
  newTracks: number;
  finished: number;
  done: number;
  skipped: number;
  failed: number;
  canceled: number;
  downloading: number;
  pending: number;
  paused: number;
  rateLimited: boolean;
  rateLimitReason: string;
  /** Source label whose downloads keep permanently failing, or null. */
  failingSource: string | null;
  overallPercent: number;
  /** Rough, self-correcting estimate of seconds left for the whole batch. */
  etaSeconds?: number;
}

let counter = 0;

/** Fixed number of simultaneous downloads (not user-configurable). */
const DEFAULT_CONCURRENCY = 3;

/**
 * A title that is missing or just a platform track id (a bare api-v2 stub that
 * never got real metadata). These render as "900000006" or blank in every
 * list, so indexing avoids them and a redownload attempt is allowed through as
 * a chance to heal the name.
 */
function needsTitleHeal(title: string): boolean {
  const t = title.trim();
  return !t || /^\d+$/.test(t);
}

/** First candidate that is a usable display title (present and not a bare id). */
function healthyTitle(
  ...candidates: Array<string | undefined>
): string | undefined {
  return candidates.find((t) => t !== undefined && !needsTitleHeal(t));
}

/**
 * Pause the whole queue after this many hard failures in a row. A cluster of
 * back-to-back failures almost always means the platform is throttling/blocking
 * us (not that the tracks are individually broken), so we stop and let the user
 * resume later instead of silently burning through the batch as "failed". Read
 * at runtime so tests can lower it.
 */
function failureStreakLimit(): number {
  return Number(process.env.SOUNDCLI_FAILURE_STREAK ?? 6);
}

/**
 * Permanent failures in a row from one source before we hint that the
 * downloader itself may be stale. Genuinely dead tracks arrive scattered
 * through a playlist; a broken extractor 404s everything at once.
 */
const PERMANENT_STREAK_NOTICE = 5;

/**
 * Newest error and unverified-match rows kept in the list. Both stay visible
 * until the user clears them, but a marathon session of failing batches must
 * not grow the queue without bound; evicted rows fold into the cleared
 * counters so the totals stay honest.
 */
const RETAINED_ROWS_CAP = 200;

/** rateLimitReason while the queue is parked waiting for the audio engine. */
export const WAITING_FOR_TOOLS = "waiting for tools";

/**
 * Whether a failure is the track's fault rather than the platform's mood:
 * removed, private, region-locked, copy-protected, or plain missing. These
 * can never succeed on a retry, so they neither burn retry attempts nor count
 * toward the repeated-errors circuit breaker (a playlist of dead tracks isn't
 * throttling).
 */
export function isPermanentTrackError(text: string): boolean {
  return /unavailable|private|removed|does not exist|404|not available in your country|geo.?restrict|drm/i.test(
    text,
  );
}

/**
 * Concurrent download queue. Emits "update" on any change. Skips tracks already
 * in the library or already queued (no song downloads twice), records finished
 * downloads in the library, and supports instant cancel (kills yt-dlp).
 */
export class DownloadQueue extends EventEmitter {
  private items: QueueItem[] = [];
  private active = 0;
  private stopped = false;
  private clearedDone = 0;
  private clearedSkipped = 0;
  private clearedFailed = 0;
  private clearedCanceled = 0;
  private batchInputTotal = 0;
  private batchAlreadySaved = 0;
  private batchNewTracks = 0;
  private readonly controllers = new Map<string, AbortController>();
  /** Item ids being paused (vs canceled) so run() knows the intent on abort. */
  private readonly pausing = new Set<string>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set when the platform rate-limited us and we paused the queue. */
  private rateLimited = false;
  private rateLimitReason = "";
  /** Wall-clock start of the current run window (null while idle), for the ETA. */
  private runStartedAt: number | null = null;
  /** `done` count when the current run window began, so the ETA rate is per-run. */
  private runDoneBaseline = 0;
  /** Hard failures in a row; trips the auto-pause circuit breaker. */
  private consecutiveErrors = 0;
  /** Consecutive permanent (dead-track) failures, per source label. */
  private permanentStreaks = new Map<string, number>();
  /**
   * Source label whose downloads keep permanently failing (a one-line UI
   * notice). Informational only: the queue never pauses for it, and retrying
   * with `f` keeps it up, since retrying on a stale tool fails identically.
   */
  private failingSource: string | null = null;
  /** One rotation check per process, so the failure log stays bounded. */
  private logRotated = false;
  /**
   * Aborts the in-flight "gather" (the UI enumerating selected playlists and
   * streaming their tracks in via enqueue). Cancelling/clearing the queue trips
   * it so a still-running enumeration of a *canceled* batch can't keep feeding
   * (and reviving) the queue. A fresh Add starts a new, un-aborted session.
   */
  private gatherController: AbortController | null = null;
  /**
   * trackSignature of every library entry, for the cross-source "same song"
   * dedupe. A full library walk per enqueue call is quadratic on a
   * multi-playlist "download all" (one enqueue per gathered playlist), so the
   * set is rebuilt only when the library version has moved since the last
   * build. Per-call additions layer into a separate set, never into this one.
   */
  private librarySignatures: Set<string> | null = null;
  private librarySignaturesVersion = -1;

  constructor(
    private config: Config,
    private library: Library,
    private concurrency = DEFAULT_CONCURRENCY,
    /** Awaited before each download spawns (the ffmpeg gate); injectable. */
    private ensureTools: () => Promise<void> = async () => {},
  ) {
    super();
  }

  /** Persist the unfinished queue to disk, debounced (resume across restart). */
  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void saveQueue(this.items).catch(() => {});
    }, 300);
  }

  updateConfig(config: Config): void {
    this.config = config;
  }

  getItems(): QueueItem[] {
    return this.items;
  }

  get activeCount(): number {
    return this.items.filter(
      (i) => i.status === "pending" || i.status === "downloading",
    ).length;
  }

  get doneCount(): number {
    return this.items.filter(
      (i) => i.status === "done" || i.status === "skipped",
    ).length + this.clearedDone + this.clearedSkipped;
  }

  stats(): QueueStats {
    let done = this.clearedDone;
    let skipped = this.clearedSkipped;
    let failed = this.clearedFailed;
    let canceled = this.clearedCanceled;
    let downloading = 0;
    let pending = 0;
    let paused = 0;
    for (const i of this.items) {
      if (i.status === "done") done++;
      else if (i.status === "skipped") skipped++;
      else if (i.status === "error") failed++;
      else if (i.status === "canceled") canceled++;
      else if (i.status === "downloading") downloading++;
      else if (i.status === "pending") pending++;
      else if (i.status === "paused") paused++;
    }
    const total =
      this.items.length +
      this.clearedDone +
      this.clearedSkipped +
      this.clearedFailed +
      this.clearedCanceled;
    const finished = done + skipped + failed + canceled;
    return {
      total,
      inputTotal: this.batchInputTotal || total,
      alreadySaved: this.batchAlreadySaved,
      newTracks: this.batchNewTracks || Math.max(0, total - this.batchAlreadySaved),
      finished,
      done,
      skipped,
      failed,
      canceled,
      downloading,
      pending,
      paused,
      rateLimited: this.rateLimited,
      rateLimitReason: this.rateLimitReason,
      failingSource: this.failingSource,
      overallPercent: total ? Math.round((finished / total) * 100) : 0,
      etaSeconds: this.estimateEta(done, downloading, pending),
    };
  }

  /**
   * Whole-batch ETA. Pending tracks have unknown size, so we estimate from
   * throughput: how long completed downloads took per track times the work left
   * (counting in-flight items by their remaining fraction). This self-corrects
   * as the run proceeds and already bakes in the parallelism. Before the first
   * track finishes we fall back to the slowest in-flight yt-dlp eta when nothing
   * is still pending; otherwise it stays undefined ("estimating…").
   */
  private estimateEta(
    done: number,
    downloading: number,
    pending: number,
  ): number | undefined {
    const remaining = downloading + pending;
    if (remaining === 0) return undefined;

    if (this.runStartedAt !== null) {
      const completedThisRun = done - this.runDoneBaseline;
      const elapsedSec = (Date.now() - this.runStartedAt) / 1000;
      if (completedThisRun > 0 && elapsedSec > 0) {
        const perTrack = elapsedSec / completedThisRun;
        let remainingTracks = pending;
        for (const i of this.items) {
          if (i.status === "downloading")
            remainingTracks += (100 - i.percent) / 100;
        }
        return perTrack * remainingTracks;
      }
    }

    // No completed-track sample yet: only the in-flight batch is estimable.
    if (pending === 0 && downloading > 0) {
      const etas = this.items
        .filter((i) => i.status === "downloading" && i.eta !== undefined)
        .map((i) => i.eta as number);
      if (etas.length) return Math.max(...etas);
    }
    return undefined;
  }

  private clearIfFinished(item: QueueItem): void {
    if (item.status === "skipped" || (item.status === "done" && !item.unverifiedMatch)) {
      const idx = this.items.indexOf(item);
      if (idx !== -1) {
        this.items.splice(idx, 1);
        if (item.status === "done") this.clearedDone++;
        else if (item.status === "skipped") this.clearedSkipped++;
      }
    }
    this.compactRetained();
  }

  /**
   * Drop rows that no longer need a line of their own: canceled items (the
   * summary counters already tell that story) and the oldest error /
   * unverified-match rows beyond the retention cap. Every eviction lands in a
   * cleared counter, so stats() and doneCount read the same before and after.
   * Items are stored in enqueue order, so the front of the array is oldest.
   */
  private compactRetained(): void {
    let canceled = 0;
    let errors = 0;
    let unverified = 0;
    for (const i of this.items) {
      if (i.status === "canceled") canceled++;
      else if (i.status === "error") errors++;
      else if (i.status === "done" && i.unverifiedMatch) unverified++;
    }
    let dropErrors = Math.max(0, errors - RETAINED_ROWS_CAP);
    let dropUnverified = Math.max(0, unverified - RETAINED_ROWS_CAP);
    if (canceled === 0 && dropErrors === 0 && dropUnverified === 0) return;
    this.items = this.items.filter((i) => {
      if (i.status === "canceled") {
        this.clearedCanceled++;
        return false;
      }
      if (i.status === "error" && dropErrors > 0) {
        dropErrors--;
        this.clearedFailed++;
        return false;
      }
      if (i.status === "done" && i.unverifiedMatch && dropUnverified > 0) {
        dropUnverified--;
        this.clearedDone++;
        return false;
      }
      return true;
    });
  }

  clearFinished(): void {
    this.items = this.items.filter(
      (i) =>
        i.status === "pending" ||
        i.status === "downloading" ||
        i.status === "paused",
    );
    this.clearedDone = 0;
    this.clearedSkipped = 0;
    this.clearedFailed = 0;
    this.clearedCanceled = 0;
    this.batchInputTotal = 0;
    this.batchAlreadySaved = 0;
    this.batchNewTracks = 0;
    if (this.runStartedAt !== null) {
      this.runStartedAt = Date.now();
      const st = this.stats();
      this.runDoneBaseline = st.done;
    }
    this.emit("update");
    this.scheduleSave();
  }

  /** Empty the entire queue: abort in-flight downloads and drop every item. */
  clearAll(): void {
    this.gatherController?.abort();
    for (const c of this.controllers.values()) c.abort();
    this.controllers.clear();
    this.pausing.clear();
    this.items = [];
    this.clearedDone = 0;
    this.clearedSkipped = 0;
    this.clearedFailed = 0;
    this.clearedCanceled = 0;
    this.batchInputTotal = 0;
    this.batchAlreadySaved = 0;
    this.batchNewTracks = 0;
    this.rateLimited = false;
    this.rateLimitReason = "";
    this.permanentStreaks.clear();
    this.failingSource = null;
    this.stopped = false;
    this.runStartedAt = null;
    this.emit("update");
    this.scheduleSave();
  }

  /** Pause one item (downloading → kill child but keep .part; pending → hold). */
  pause(id: string): void {
    const item = this.items.find((i) => i.id === id);
    if (!item) return;
    if (item.status === "downloading") {
      this.pausing.add(id);
      this.controllers.get(id)?.abort();
    } else if (item.status === "pending") {
      item.status = "paused";
      item.percent = 0;
      this.emit("update");
      this.scheduleSave();
    }
  }

  /** Resume one paused item. */
  resume(id: string): void {
    const item = this.items.find((i) => i.id === id);
    if (!item || item.status !== "paused") return;
    item.status = "pending";
    item.error = undefined;
    this.stopped = false;
    this.rateLimited = false;
    this.rateLimitReason = "";
    this.consecutiveErrors = 0;
    this.emit("update");
    this.scheduleSave();
    this.pump();
  }

  /** Re-queue everything that failed (clears the error). */
  retryFailed(): void {
    let any = false;
    for (const i of this.items) {
      if (i.status === "error") {
        i.status = "pending";
        i.error = undefined;
        i.percent = 0;
        any = true;
      }
    }
    if (!any) return;
    this.stopped = false;
    this.rateLimited = false;
    this.rateLimitReason = "";
    this.consecutiveErrors = 0;
    this.emit("update");
    this.scheduleSave();
    this.pump();
  }

  /**
   * Platform throttled us: stop the whole queue and say so. Nothing resumes on
   * its own: hammering a throttling platform on a timer just digs the hole
   * deeper. Progress (including .part files) is kept; the user resumes with `]`
   * whenever they're ready.
   */
  private onRateLimited(reason: string): void {
    this.rateLimited = true;
    this.rateLimitReason = reason;
    this.stopped = true;
    this.consecutiveErrors = 0;
    for (const i of this.items) {
      if (i.status === "pending") {
        i.status = "paused";
        i.percent = 0;
      } else if (i.status === "downloading") {
        this.pausing.add(i.id);
        this.controllers.get(i.id)?.abort();
      }
    }
    this.emit("update");
    this.scheduleSave();
  }

  /**
   * A burst of "dead track" failures from one source smells like a stale
   * extractor, not N individually dead tracks, so raise the one-line notice.
   */
  private notePermanentFailure(label: string): void {
    const n = (this.permanentStreaks.get(label) ?? 0) + 1;
    this.permanentStreaks.set(label, n);
    if (n >= PERMANENT_STREAK_NOTICE) this.failingSource = label;
  }

  /** A real download from this source succeeded, so the tool works. */
  private noteSourceSuccess(label: string): void {
    this.permanentStreaks.delete(label);
    if (this.failingSource === label) this.failingSource = null;
  }

  /** Folder where this item should live when it came from a playlist/set. */
  private playlistFolder(item: EnqueueInput | QueueItem): string | undefined {
    const playlist = item.track.playlistTitle;
    if (!playlist) return undefined;
    return join(
      this.config.libraryDir,
      item.sourceLabel,
      ...(item.track.owner ? [sanitizeName(item.track.owner)] : []),
      sanitizeName(playlist),
    );
  }

  /** True when the existing library file already lives in this requested folder. */
  private isInRequestedFolder(existing: Track, item: EnqueueInput | QueueItem): boolean {
    const folder = this.playlistFolder(item);
    if (!folder) return true;
    return resolve(dirname(existing.filePath)) === resolve(folder);
  }

  /**
   * If a track is already downloaded from another playlist (usually Liked Songs),
   * copy the local file into this playlist's folder instead of silently skipping
   * it. Playlist folders are part of the library's promise: selecting a set
   * should leave that set complete on disk even when some songs were saved before.
   */
  private async materializeExisting(item: QueueItem): Promise<boolean> {
    const get = (this.library as Library & { get?: (id: string) => Track | undefined }).get;
    const existing = typeof get === "function"
      ? get.call(this.library, libId(item.source, item.track.id, item.track.owner))
      : undefined;
    const folder = this.playlistFolder(item);
    if (!existing || !folder) return false;
    if (this.isInRequestedFolder(existing, item)) {
      // Queued despite already living here (e.g. a title heal): still refresh
      // its feed position so the set keeps mirroring the platform's order.
      if (
        item.track.position !== undefined &&
        existing.playlistPos !== item.track.position
      ) {
        await this.library.upsert({
          ...existing,
          playlistPos: item.track.position,
        });
      }
      return true;
    }

    const source = existing.filePath;
    const target = join(folder, basename(source));
    try {
      await fs.mkdir(folder, { recursive: true });
      await fs.copyFile(source, target, fsConstants.COPYFILE_EXCL);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return false;
      if (err.code !== "EEXIST") throw e;
    }
    // Index the copy right away, under the same path-derived id reconcile's
    // adoption would mint, so the set shows complete without waiting for a
    // rescan (which then upserts the same entry, a no-op). It stays a "local"
    // entry: the real (source, owner) id already names the original file, and
    // local tracks are exempt from dedupe, so the copy never gets cleaned up.
    const rel = relative(this.config.libraryDir, target);
    const stat = await fs.stat(target).catch(() => undefined);
    await this.library.upsert({
      id: libId("local", rel),
      source: "local",
      sourceTrackId: rel,
      // The copy is the same audio as the original entry, so it inherits that
      // entry's real metadata; feed stubs (slug/api-v2 names) only fill gaps.
      title: healthyTitle(existing.title, item.track.title) ?? existing.title,
      artist: existing.artist ?? item.track.artist,
      album: existing.album,
      durationSec: existing.durationSec,
      webpageUrl: existing.webpageUrl,
      filePath: target,
      fileSize: stat?.size,
      playlist: playlistFromPath(target, this.config.libraryDir, item.track.owner),
      playlistPos: item.track.position,
      owner: item.track.owner,
      addedAt: new Date().toISOString(),
    });
    return true;
  }

  /**
   * A saved track stuck with a missing or bare id title (an api-v2 stub that
   * never got real metadata) heals when the user re-attempts its download:
   * resolve the real name (from the incoming track, or one metadata probe) and
   * retitle the entry + file via renameTrack. Best effort and silent, like
   * reconcile: a failed probe changes nothing and never fails the item.
   */
  private async healMissingTitle(item: QueueItem): Promise<void> {
    try {
      const existing = this.library.get(
        libId(item.source, item.track.id, item.track.owner),
      );
      if (!existing || !needsTitleHeal(existing.title)) return;
      let title = item.track.title;
      let artist = item.track.artist;
      if (needsTitleHeal(title) && item.track.downloadUrl) {
        const probed = await enumerate(item.track.downloadUrl, { flat: false });
        const e = probed.entries[0];
        if (!e) return;
        title = e.title;
        artist = artist ?? e.uploader;
      }
      if (needsTitleHeal(title)) return;
      await renameTrack(
        this.library,
        { ...existing, artist: existing.artist ?? artist },
        title,
      );
      // Carry the healed name onto the item so a materialize copy that
      // follows indexes it too (and the queue row reads human).
      item.track = { ...item.track, title, artist: item.track.artist ?? artist };
    } catch {
      // offline or unresolvable: keep the id title, heal on a later attempt
    }
  }

  pauseAll(): void {
    // A manual pause also clears the throttle banner.
    this.rateLimited = false;
    this.rateLimitReason = "";
    for (const i of this.items) {
      if (i.status === "pending" || i.status === "downloading") this.pause(i.id);
    }
  }

  resumeAll(): void {
    for (const i of this.items) if (i.status === "paused") this.resume(i.id);
  }

  /** Restore a persisted queue from a previous session. */
  restore(persisted: PersistedItem[]): void {
    for (const p of restorableItems(persisted, this.library)) {
      this.items.push({
        id: `q${++counter}`,
        source: p.source,
        sourceLabel: p.sourceLabel,
        track: p.track,
        status: p.status,
        percent: 0,
        unverifiedMatch: p.unverifiedMatch,
      });
    }
    this.emit("update");
    this.pump();
  }

  /**
   * Stop for app quit: kill in-flight children and persist the unfinished queue
   * synchronously (downloading → pending) so it resumes from .part next launch.
   */
  suspend(): void {
    this.stopped = true;
    for (const c of this.controllers.values()) c.abort();
    try {
      saveQueueSync(this.items);
    } catch {
      // best effort on exit
    }
  }

  /** Abort everything in flight and drop anything still pending. */
  cancelAll(): void {
    this.stopped = true;
    // Stop the UI's in-flight playlist enumeration from re-feeding the queue.
    this.gatherController?.abort();
    for (const item of this.items) {
      if (item.status === "pending" || item.status === "paused") {
        item.status = "canceled";
        item.percent = 0;
      }
    }
    for (const c of this.controllers.values()) c.abort();
    // Fold the freshly canceled rows into the counters right away: items that
    // never reached run() have no other path through clearIfFinished, and a
    // canceled batch left in place would grow the list across batches forever.
    this.compactRetained();
    this.emit("update");
    this.scheduleSave();
  }

  /** Cancel a single item (pending/paused → dropped, downloading → killed). */
  cancel(id: string): void {
    const item = this.items.find((i) => i.id === id);
    if (!item) return;
    if (item.status === "pending" || item.status === "paused") {
      item.status = "canceled";
      this.emit("update");
      this.scheduleSave();
    } else {
      this.controllers.get(id)?.abort();
    }
  }

  /**
   * Begin a new "gather session" and return its abort signal. The UI calls this
   * before enumerating the selected playlists, checks the signal before each
   * enqueue, and bails if it aborts. cancelAll/clearAll abort the current
   * session; a new Add gets a fresh, un-aborted one, so a genuine add still
   * starts downloads while a canceled batch's stragglers can't revive the queue.
   */
  beginGather(): AbortSignal {
    this.gatherController = new AbortController();
    return this.gatherController.signal;
  }

  /**
   * Signatures of every library entry, cached until the library changes.
   * Callers must treat the returned set as read-only: batch-local signatures
   * belong in their own layer, or the cache would leak this batch's state
   * into the next.
   */
  private ownedSignatureSet(): Set<string> {
    const getVersion = (this.library as Library & { getVersion?: () => number })
      .getVersion;
    const version =
      typeof getVersion === "function" ? getVersion.call(this.library) : 0;
    if (!this.librarySignatures || this.librarySignaturesVersion !== version) {
      const set = new Set<string>();
      for (const t of this.library.all()) set.add(trackSignature(t));
      this.librarySignatures = set;
      this.librarySignaturesVersion = version;
    }
    return this.librarySignatures;
  }
  /**
   * Add tracks to the queue while de-duping against the library, current
   * queue, and same-title/artist matches from other sources. The return tells UI
   * how many were actually added vs skipped as duplicates, while separating
   * already-saved playlist materialization from genuinely new downloads.
   */
  enqueue(inputs: EnqueueInput[]): {
    total: number;
    added: number;
    skipped: number;
    alreadySaved: number;
    newTracks: number;
  } {
    if (this.items.length === 0) {
      this.clearedDone = 0;
      this.clearedSkipped = 0;
      this.clearedFailed = 0;
      this.clearedCanceled = 0;
      this.batchInputTotal = 0;
      this.batchAlreadySaved = 0;
      this.batchNewTracks = 0;
    }
    this.stopped = false;
    this.rateLimited = false;
    this.rateLimitReason = "";
    const blocked = new Set<string>();
    // Signatures of songs we already own or have queued, so the *same song*
    // never downloads twice even under a different id or from another source.
    // The library-derived set is cached per library version (a multi-playlist
    // gather calls enqueue once per playlist); queue items and this call's
    // own additions layer into the separate per-call set.
    const ownedSignatures = this.ownedSignatureSet();
    const signatures = new Set<string>();
    for (const i of this.items) {
      if (
        i.status === "pending" ||
        i.status === "downloading" ||
        i.status === "done" ||
        i.status === "skipped"
      ) {
        blocked.add(libId(i.source, i.track.id, i.track.owner));
        signatures.add(trackSignature({ ...i.track, source: i.source }));
      }
    }

    let added = 0;
    let skipped = 0;
    let alreadySaved = 0;
    let newTracks = 0;
    // Feed positions to restamp onto already-saved tracks: "download all"
    // re-lists every playlist, so each pass self-heals stored order for free.
    const heals: Track[] = [];
    for (const inp of inputs) {
      const id = libId(inp.source, inp.track.id, inp.track.owner);
      const sig = trackSignature({ ...inp.track, source: inp.source });
      const inLibrary = this.library.has(id);
      const existing = inLibrary ? this.library.get(id) : undefined;
      if (
        existing &&
        !blocked.has(id) &&
        (!this.isInRequestedFolder(existing, inp) ||
          needsTitleHeal(existing.title))
      ) {
        // Already downloaded elsewhere, but this playlist folder is incomplete
        // (queue a local copy operation rather than hiding the track as a
        // skip), or saved under a bare id title (let run() heal the name).
        alreadySaved++;
      } else if (
        inLibrary ||
        blocked.has(id) ||
        ownedSignatures.has(sig) ||
        signatures.has(sig)
      ) {
        if (inLibrary || ownedSignatures.has(sig)) alreadySaved++;
        if (
          existing &&
          inp.track.playlistTitle &&
          inp.track.position !== undefined &&
          existing.playlistPos !== inp.track.position &&
          this.isInRequestedFolder(existing, inp)
        ) {
          // Lives in this folder under a stale (or missing) feed position. A
          // track saved in another folder keeps that playlist's position; its
          // copy here gets stamped by materialize instead.
          heals.push({ ...existing, playlistPos: inp.track.position });
        }
        skipped++;
        continue;
      } else {
        newTracks++;
      }
      blocked.add(id);
      signatures.add(sig);
      this.items.push({
        id: `q${++counter}`,
        source: inp.source,
        sourceLabel: inp.sourceLabel,
        track: inp.track,
        status: "pending",
        percent: 0,
      });
      added++;
    }

    if (heals.length > 0) {
      // One notify + one atomic index write for the whole listing.
      void this.library.upsertMany(heals).catch(() => {});
    }

    this.batchInputTotal += inputs.length;
    this.batchAlreadySaved += alreadySaved;
    this.batchNewTracks += newTracks;

    this.emit("update");
    this.scheduleSave();
    this.pump();
    return { total: inputs.length, added, skipped, alreadySaved, newTracks };
  }

  private pump(): void {
    if (this.stopped) return;
    const limit = Math.max(1, this.concurrency);
    while (this.active < limit) {
      const next = this.items.find((i) => i.status === "pending");
      if (!next) break;
      void this.run(next);
    }
  }

  /**
   * Run a single download, retrying a bounded number of times on transient
   * errors (mirrors spotDL: yt-dlp already retries internally, and the outer
   * loop retries the whole attempt a couple of times before giving up). A
   * rate-limit comes back as a status (not a throw) and is returned as-is so the
   * whole-batch auto-pause still fires; aborts (cancel/pause) stop immediately.
   */
  private async downloadWithRetry(
    params: DownloadParams,
    signal: AbortSignal,
    onProgress: (p: DownloadProgress) => void,
    maxRetries = 2,
  ): Promise<DownloadResult> {
    // Backoff base, overridable via env so tests can run retries with no delay.
    const baseMs = Number(process.env.SOUNDCLI_RETRY_BASE_MS ?? 500);
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (signal.aborted) return { status: "canceled" };
      try {
        return await downloadTrack(params, onProgress);
      } catch (e) {
        if (signal.aborted) return { status: "canceled" };
        lastError = e;
        // A permanently dead track (removed/private/404) can't succeed on a
        // retry, so don't burn attempts or backoff delay on it.
        if (isPermanentTrackError(e instanceof Error ? e.message : String(e))) {
          break;
        }
        if (attempt < maxRetries) {
          // Short, growing backoff that aborts early on cancel/pause.
          await this.abortableSleep(baseMs * (attempt + 1), signal);
          if (signal.aborted) return { status: "canceled" };
          continue;
        }
        break;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /**
   * Append a raw failure line to the log so "what's failing?" is answerable
   * after the fact (the UI deliberately shows only short, calm reasons).
   * Fire-and-forget: logging must never slow or break the run.
   */
  private logFailure(item: QueueItem, detail: string): void {
    if (process.env.VITEST) return;
    void (async () => {
      try {
        if (!this.logRotated) {
          this.logRotated = true;
          const st = await fs.stat(downloadLogFile).catch(() => null);
          if (st && st.size > 1_000_000) {
            await fs.rm(`${downloadLogFile}.old`, { force: true });
            await fs.rename(downloadLogFile, `${downloadLogFile}.old`);
          }
        }
        await fs.mkdir(dirname(downloadLogFile), { recursive: true });
        const line = `${new Date().toISOString()} [${item.sourceLabel}] ${item.track.title} | ${item.track.downloadUrl} | ${detail}\n`;
        await fs.appendFile(downloadLogFile, line);
      } catch {
        // Never let logging affect downloads.
      }
    })();
  }

  /** Sleep that resolves early if the signal aborts (so pause/cancel is snappy). */
  private abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async run(item: QueueItem): Promise<void> {
    // Already in the library (a stale/restored item, or a dup enqueued before
    // its twin finished): skip instantly without touching the network, so a
    // re-run never re-sifts songs you already have.
    if (this.library.has(libId(item.source, item.track.id, item.track.owner))) {
      item.status = "downloading";
      this.emit("update");
      try {
        await this.healMissingTitle(item);
        item.status = (await this.materializeExisting(item)) ? "done" : "skipped";
        item.percent = 100;
      } catch (e) {
        item.status = "error";
        item.error = e instanceof Error ? e.message : String(e);
        this.logFailure(item, item.error);
      }
      this.clearIfFinished(item);
      this.emit("update");
      this.scheduleSave();
      return;
    }
    // Open a fresh ETA run window the moment work resumes from idle.
    if (this.runStartedAt === null) {
      this.runStartedAt = Date.now();
      this.runDoneBaseline = this.items.filter(
        (i) => i.status === "done",
      ).length;
    }
    this.active++;
    item.status = "downloading";
    this.emit("update");
    this.scheduleSave();

    // Hard gate: ffmpeg normally arrived in the background long before the
    // first download, but a fresh offline install may still be waiting on it.
    // A rejection is never the item's fault, so instead of failing it we park
    // the whole queue behind a waiting banner; resume re-enters run(), which
    // re-awaits a fresh ensure. (Marked "downloading" above first, so pump()
    // can't pick this item up a second time while we wait.)
    try {
      await this.ensureTools();
    } catch {
      this.active--;
      item.status = "paused";
      item.percent = 0;
      this.pausing.delete(item.id);
      this.onRateLimited(WAITING_FOR_TOOLS);
      if (this.activeCount === 0) this.runStartedAt = null;
      return;
    }

    const controller = new AbortController();
    this.controllers.set(item.id, controller);
    const isSpotify = item.source === "spotify";
    let lastEmit = 0;

    // Resolve the exact YouTube URL for Spotify tracks lazily, at download time
    // (like spotDL's search_and_download). On no confident match we fall back to
    // the stored ytsearch1: query and tag the item as an unverified match.
    let url = item.track.downloadUrl;
    if (isSpotify && !controller.signal.aborted) {
      try {
        const resolved = await resolveSpotifyDownloadUrl(item.track);
        if (resolved) {
          url = resolved;
          item.unverifiedMatch = false;
        } else {
          item.unverifiedMatch = true;
        }
      } catch {
        // Resolution failed entirely: keep the ytsearch1: fallback so a
        // download still happens, flagged as unverified.
        item.unverifiedMatch = true;
      }
    }

    try {
      const res = await this.downloadWithRetry(
        {
          url,
          config: this.config,
          sourceLabel: item.sourceLabel,
          fixedStem: isSpotify
            ? `${item.track.artist ?? "Unknown Artist"} - ${item.track.title}`
            : undefined,
          playlistName: isSpotify
            ? (item.track.playlistTitle ?? "Spotify")
            : item.track.playlistTitle,
          owner: item.track.owner,
          signal: controller.signal,
        },
        controller.signal,
        (p) => {
          if (p.percent !== undefined) item.percent = p.percent;
          if (p.speed !== undefined) item.speed = p.speed;
          if (p.eta !== undefined) item.eta = p.eta;
          const now = Date.now();
          if (now - lastEmit > 250) {
            lastEmit = now;
            this.emit("update");
          }
        },
      );

      if (res.status === "ratelimited") {
        // Don't fail it: keep it (with its .part) and pause the whole queue.
        item.status = "paused";
        this.onRateLimited(item.sourceLabel);
      } else if (res.status === "canceled") {
        // Distinguish a pause (keep it, resumable) from a real cancel.
        item.status = this.pausing.has(item.id) ? "paused" : "canceled";
        item.percent = item.status === "paused" ? item.percent : 0;
      } else if (res.status === "downloaded" && res.meta) {
        const m = res.meta;
        // Never index a song the player can't open: if the reported file isn't
        // actually on disk, surface it as a failure instead of a dead row. The
        // printed path can disagree with disk (a legacy-codepage pipe mangled
        // the name, or `-x` reported the source container's extension while the
        // kept file carries the extracted codec's), so resolve the real file
        // (exact → mangled-name → same-stem/any-audio-ext) before failing.
        // Yield so stdin/player keys can run before a heavy directory scan.
        await new Promise<void>((r) => setImmediate(r));
        const found = await findDownloadedFile(m.filepath, {
          title: m.track ?? m.title ?? item.track.title,
          artist: m.artist ?? m.uploader ?? item.track.artist,
        });
        if (!found) {
          item.status = "error";
          item.error = `finished but the file is missing on disk (${basename(m.filepath)})`;
          this.logFailure(item, `missing on disk; yt-dlp reported: ${m.filepath}`);
        } else {
          m.filepath = found;
          // Stamp addedAt at completion so the library (sorted newest-first)
          // always grows from the top: a finished song never lands mid-list.
          const addedAt = new Date().toISOString();
          const track: Track = isSpotify
            ? {
                id: libId(item.source, item.track.id, item.track.owner),
                source: "spotify",
                sourceTrackId: item.track.id,
                title: item.track.title,
                artist: item.track.artist,
                album: item.track.album,
                durationSec: item.track.duration ?? m.duration,
                filePath: m.filepath,
                webpageUrl: m.webpage_url,
                playlist: item.track.playlistTitle,
                playlistPos: item.track.position,
                owner: item.track.owner,
                addedAt,
                spotifyId: item.track.id,
              }
            : {
                id: libId(item.source, m.id, item.track.owner),
                source: item.source,
                sourceTrackId: m.id,
                // Meta can echo a bare track id (or nothing) for api-v2
                // stubs; never index that when the enqueued entry knows the
                // real name. Last resort stays as-is so a finished download
                // is never dropped over naming.
                title:
                  healthyTitle(m.track, m.title, item.track.title) ??
                  m.track ??
                  m.title,
                artist: m.artist ?? m.uploader ?? item.track.artist,
                album: m.album,
                durationSec: m.duration,
                filePath: m.filepath,
                webpageUrl: m.webpage_url,
                playlist: m.playlist_title ?? item.track.playlistTitle,
                playlistPos: item.track.position,
                owner: item.track.owner,
                addedAt,
              };
          await this.library.upsert(track);
          item.percent = 100;
          item.status = "done";
          this.consecutiveErrors = 0;
          this.noteSourceSuccess(item.sourceLabel);
        }
      } else {
        item.percent = 100;
        item.status = "skipped";
        this.consecutiveErrors = 0;
        this.noteSourceSuccess(item.sourceLabel);
      }
    } catch (e) {
      item.status = "error";
      item.error = e instanceof Error ? e.message : String(e);
      this.logFailure(item, item.error);
      // A run of TRANSIENT failures almost always means we're being throttled
      // or blocked, so pause the whole queue (resumable) instead of failing
      // the rest silently. Permanently dead tracks say nothing about the
      // platform, so they neither count toward nor reset the streak; they
      // feed their own per-source streak instead, which raises the
      // stale-downloader notice without ever pausing.
      if (!isPermanentTrackError(item.error)) {
        this.consecutiveErrors++;
        if (this.consecutiveErrors >= failureStreakLimit() && !this.rateLimited) {
          this.onRateLimited("repeated errors");
        }
      } else if (!/drm/i.test(item.error)) {
        // DRM is the platform telling the truth about the track, not a sign
        // of a stale extractor, so it never feeds the out-of-date hint.
        this.notePermanentFailure(item.sourceLabel);
      }
    } finally {
      this.controllers.delete(item.id);
      this.pausing.delete(item.id);
      this.active--;
      item.speed = undefined;
      item.eta = undefined;
      this.clearIfFinished(item);
      this.emit("update");
      this.scheduleSave();
      this.pump();
      // Close the ETA run window once nothing is in-flight or waiting.
      if (this.activeCount === 0) this.runStartedAt = null;
    }
  }
}
