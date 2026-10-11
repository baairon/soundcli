// UI-agnostic bootstrap: builds the library, player, download queue and
// history and wires them together. Both front ends (the Ink dashboard and the
// local web GUI) start from here, so none of this may touch the terminal.

import { promises as fs } from "node:fs";
import { ensureBinaries, type Binaries } from "../bin/binaries";
import { ensureFfmpeg } from "../bin/ffmpeg-fetch";
import { ensureMpvInstalled } from "../bin/mpv-install";
import { finalizeStagedYtDlp } from "../bin/ytdlp-fetch";
import { maybeUpdateYtDlp } from "../bin/ytdlp-update";
import { loadConfig, saveConfig, type Config } from "../config/config";
import { legacyArchiveFile } from "../config/paths";
import { DownloadQueue } from "../download/queue";
import { loadQueue } from "../download/persist";
import { Library } from "../library/library";
import { migrateOwnerLayout } from "../library/migrate";
import { reconcileLibrary } from "../library/reconcile";
import { Playback, type PlaybackState } from "../player/playback";
import { PlayHistory } from "../player/history";

export interface CreateAppOptions {
  /** A link passed on the command line: counts as self-onboarded. */
  initialAdd?: string;
  /** Progress text while binaries are fetched on first boot. */
  onStatus?: (text: string) => void;
  /**
   * Status line while mpv auto-installs in the background (null clears it).
   * `transient` marks a failure message that the front end should clear itself
   * after a short while.
   */
  onMpvStatus?: (text: string | null, opts?: { transient?: boolean }) => void;
  /** The front end plays the audio itself (the GUI page): skip mpv entirely. */
  browserAudio?: boolean;
}

export interface App {
  config: Config;
  library: Library;
  binaries: Binaries;
  queue: DownloadQueue;
  playback: Playback;
  history: PlayHistory;
  /**
   * Silent drift hygiene (drop dead entries + dupes). Runs behind the first
   * paint so a full music-dir walk on a big library never holds up boot.
   * Call once after the front end is up.
   */
  startBackgroundReconcile(): void;
  /**
   * Re-sync the library with disk without a restart. Guarded so runs never
   * stack, and coalesced so rapid section hops don't restat. Pass the live
   * `libraryDir` since Settings can change it after boot.
   */
  reconcile(libraryDir?: string): void;
  /** Flush and stop everything; safe to call on exit. */
  dispose(): void;
}

export async function createApp(opts: CreateAppOptions = {}): Promise<App> {
  const { initialAdd, onStatus, onMpvStatus, browserAudio } = opts;

  const config = await loadConfig();
  // A link passed on the command line means the user has self-onboarded:
  // skip the welcome tour and drop straight into downloading it (the
  // saveConfig below persists the flag).
  if (initialAdd) config.firstRunComplete = true;
  const library = await Library.load();
  // One-time layout migration (pre-owner files move into their handle
  // folder) must finish before anything reads the library; the existence
  // cache it fills feeds the deferred reconcile below so each file is
  // still stat'd only once per boot.
  const exists = new Map<string, boolean>();
  await migrateOwnerLayout(library, config, exists);
  // Library is now the source of truth, so drop the legacy yt-dlp archive.
  void fs.rm(legacyArchiveFile, { force: true }).catch(() => {});
  const binaries = await ensureBinaries(onStatus);
  const playback = new Playback(browserAudio ? null : binaries.mpv);
  if (browserAudio) playback.enableBrowser();

  // Recently played: record every track the player actually starts,
  // including auto-advance and next/prev, not just explicit picks.
  const history = await PlayHistory.load();
  let lastPlayedId: string | undefined;

  const lastId = history.ids()[0];
  if (lastId) {
    const lastTrack = library.all().find((t) => t.id === lastId);
    if (lastTrack) {
      // Reconcile now runs behind the first paint, so a file deleted
      // while the app was closed hasn't been pruned yet; one stat keeps
      // the resume from loading a dead row (and feeds the exists cache
      // so the deferred reconcile doesn't stat it again).
      let present = exists.get(lastTrack.filePath);
      if (present === undefined) {
        present = await fs
          .access(lastTrack.filePath)
          .then(() => true)
          .catch(() => false);
        exists.set(lastTrack.filePath, present);
      }
      if (present) {
        lastPlayedId = lastTrack.id;
        void playback.play(lastTrack, [lastTrack], 0, true).catch(() => {});
      }
    }
  }

  playback.on("state", (s: PlaybackState) => {
    const id = s.track?.id;
    if (id && id !== lastPlayedId) {
      lastPlayedId = id;
      history.record(id);
    }
  });

  // Backfill durations the player discovers: adopted files never carry
  // one (adoption can't know it without probing audio), so their rows
  // render no time. mpv reports the real duration on load; teach the
  // library once per track and the row shows a time forever.
  let lastHealedId: string | undefined;
  playback.on("state", (s: PlaybackState) => {
    const id = s.track?.id;
    if (!id || s.duration <= 0 || id === lastHealedId) return;
    const entry = library.get(id);
    if (!entry || entry.durationSec !== undefined) return;
    lastHealedId = id;
    void library.upsert({ ...entry, durationSec: s.duration }).catch(() => {});
  });

  // Auto-install mpv in the background so the rich player "just works".
  // Retried on every launch while it's missing: a one-time flag here once
  // left playback silently broken forever after a single failed attempt.
  if (!binaries.mpv && !browserAudio) {
    const failed = (): void => {
      // One calm line, then quiet again: the NowPlayingBar hint stays the
      // durable nudge while songs keep opening in the OS default app.
      onMpvStatus?.("Couldn't set up the player, songs open in your default app", {
        transient: true,
      });
    };
    void ensureMpvInstalled((t) => onMpvStatus?.(t))
      .then((p) => {
        if (p) {
          onMpvStatus?.(null);
          playback.enableMpv(p);
        } else if (process.platform === "linux") {
          // Linux never auto-installs (needs sudo); the install hint is
          // the durable surface there, so saying "couldn't set up" about
          // an attempt we never made would just be noise.
          onMpvStatus?.(null);
        } else {
          failed();
        }
      })
      .catch(failed);
  }

  // Downloads hard-gate on the audio engine (fetched in the background by
  // ensureBinaries); undefined keeps the default concurrency.
  const queue = new DownloadQueue(config, library, undefined, () =>
    ensureFfmpeg(),
  );
  // Bring back last session's queue; pending items resume from their .part.
  queue.restore(await loadQueue());

  // Check for a newer yt-dlp on every boot (a stale extractor turns every
  // download from a source into "failed"). Async and silent: a newer
  // binary is staged, then promoted right away unless a download is
  // already running the current one (then it applies next launch).
  // Offline stays completely normal.
  if (config.ytdlpAutoUpdate !== false) {
    void maybeUpdateYtDlp()
      .then(async (staged) => {
        if (staged && queue.stats().downloading === 0) {
          await finalizeStagedYtDlp();
        }
      })
      .catch(() => {});
  }

  // Reconcile state. A failure stays silent: the app is fully usable with a
  // stale index and the next run retries anyway.
  let reconciling = false;
  let lastReconcile = 0;
  let firstCache: Map<string, boolean> | null = exists;
  const runReconcile = (force: boolean, libraryDir?: string): void => {
    if (reconciling) return;
    if (!force && Date.now() - lastReconcile < 5_000) return;
    reconciling = true;
    // A fresh cache per run so the missing-check and prune passes share stats
    // (one access per track, not two), while each run still sees current disk.
    // The first run reuses the boot cache so each file is stat'd once per boot.
    const cache = firstCache ?? new Map<string, boolean>();
    firstCache = null;
    void reconcileLibrary(library, cache, libraryDir ?? config.libraryDir)
      .then((r) => {
        // Only touch recently-played when a prune actually removed tracks, so
        // a reconcile that changed nothing writes nothing.
        if (r.prunedMissing > 0) history.retain((id) => library.has(id));
      })
      .catch(() => {})
      .finally(() => {
        lastReconcile = Date.now();
        reconciling = false;
      });
  };

  await saveConfig(config).catch(() => {});

  return {
    config,
    library,
    binaries,
    queue,
    playback,
    history,
    startBackgroundReconcile: () => runReconcile(true),
    reconcile: (libraryDir) => runReconcile(false, libraryDir),
    dispose: () => {
      queue.suspend();
      // Library writes are debounced; flush synchronously so a mutation made
      // in the last half second still lands before the process goes away.
      library.flushSync();
      playback.quit();
    },
  };
}
