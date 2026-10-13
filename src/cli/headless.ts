// `sndcli add`: the download engine with no dashboard, for an agent, a
// scheduler, or someone's script. It runs the same queue the dashboard does,
// so dedupe, folders, retries and pacing all behave identically; the only new
// decisions are who owns the library right now and what to tell the caller.

import { ensureFfmpeg } from "../bin/ffmpeg-fetch";
import { ensureYtDlp, finalizeStagedYtDlp } from "../bin/ytdlp-fetch";
import { maybeUpdateYtDlp } from "../bin/ytdlp-update";
import { loadConfig } from "../config/config";
import { paths } from "../config/paths";
import { enqueueTarget } from "../download/gather";
import { loadQueue } from "../download/persist";
import {
  DownloadQueue,
  isPermanentTrackError,
  type QueueItem,
} from "../download/queue";
import { shortError } from "../download/reason";
import { Library } from "../library/library";
import { migrateOwnerLayout } from "../library/migrate";
import { reconcileLibrary } from "../library/reconcile";
import type { Track } from "../library/types";
import { resolveLink, type LinkTarget } from "../sources/resolve-link";
import {
  claimInstance,
  liveOwner,
  ownerInbox,
  submitRequest,
  TICK_MS,
  type OwnerKind,
} from "./instance";

export interface AddCommand {
  links: string[];
  all: boolean;
  json: boolean;
}

/**
 * What the process exits with. 75 is sysexits' EX_TEMPFAIL: nothing is wrong
 * with the request, the platform (or an opening dashboard) stopped the run,
 * the queue is saved, and running the same command later carries on. 130 is
 * the shell's own convention for ctrl-c.
 */
export const EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  tryLater: 75,
  interrupted: 130,
} as const;

/**
 * Everything `--json` prints, one object per line. This is a public contract:
 * fields are only ever added, never renamed or removed.
 */
export type HeadlessEvent =
  | {
      event: "link";
      link: string;
      tracks: number;
      new: number;
      saved: number;
      error?: string;
    }
  | {
      event: "track";
      status: "saved" | "exists" | "failed";
      source: string;
      title: string;
      artist?: string;
      file?: string;
      reason?: string;
      detail?: string;
      permanent?: boolean;
    }
  | { event: "handoff"; owner: OwnerKind }
  | {
      event: "done";
      saved: number;
      exists: number;
      failed: number;
      halted: string | null;
      exit: number;
    };

export interface Engine {
  queue: DownloadQueue;
  library: Pick<Library, "flushSync">;
}

/** The seams a test replaces; the defaults are the real machine. */
export interface HeadlessDeps {
  /** Where the instance claim and the inbox live. */
  dataDir: string;
  tickMs: number;
  /** Results, on stdout. */
  out: (line: string) => void;
  /** Setup chatter and errors, on stderr, so stdout stays parseable. */
  note: (line: string) => void;
  boot: (note: (message: string) => void) => Promise<Engine>;
}

/** Bring up the engine the way the dashboard does, minus everything it draws. */
async function bootEngine(note: (message: string) => void): Promise<Engine> {
  const config = await loadConfig();
  const library = await Library.load();
  const exists = new Map<string, boolean>();
  await migrateOwnerLayout(library, config, exists);
  await ensureYtDlp(note);
  // Nothing is running the binary yet, so a newer one applies before the
  // first download instead of waiting for the next launch.
  if (config.ytdlpAutoUpdate !== false) {
    const staged = await maybeUpdateYtDlp().catch(() => false);
    if (staged) await finalizeStagedYtDlp().catch(() => false);
  }
  // "Already saved" has to be true before anything is skipped on its word.
  await reconcileLibrary(library, exists, config.libraryDir).catch(() => {});
  const queue = new DownloadQueue(config, library, undefined, () =>
    ensureFfmpeg(note),
  );
  // Whatever an earlier run left unfinished comes along; nobody is here to
  // press resume, so held rows start again too.
  queue.restore(await loadQueue());
  queue.resumeAll();
  return { queue, library };
}

function defaultDeps(): HeadlessDeps {
  return {
    dataDir: paths.data,
    tickMs: TICK_MS,
    out: (line) => process.stdout.write(`${line}\n`),
    note: (line) => process.stderr.write(`${line}\n`),
    boot: bootEngine,
  };
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
}

/** The plain-text line for an event, for a person reading the terminal. */
function describe(e: HeadlessEvent): string {
  switch (e.event) {
    case "link":
      if (e.error && e.tracks === 0) return `${e.link}: ${e.error}`;
      return (
        `${e.link}: ${plural(e.tracks, "track")}, ${e.new.toLocaleString()} to download, ` +
        `${e.saved.toLocaleString()} already saved` +
        (e.error ? ` (some lists failed: ${e.error})` : "")
      );
    case "track": {
      const name = e.artist ? `${e.artist} - ${e.title}` : e.title;
      if (e.status === "failed") return `failed  ${name} (${e.reason})`;
      return `${e.status === "saved" ? "saved " : "exists"}  ${name}`;
    }
    case "handoff":
      return e.owner === "tui"
        ? "Handed to the open soundcli, which downloads it from there."
        : "Handed to the soundcli download already running.";
    case "done": {
      const line = `done: ${e.saved.toLocaleString()} saved, ${e.exists.toLocaleString()} already saved, ${e.failed.toLocaleString()} failed`;
      return e.halted
        ? `${line}\nstopped early (${e.halted}). The queue is saved: run this again later to resume.`
        : line;
    }
  }
}

type OkTarget = Extract<LinkTarget, { ok: true }>;

/**
 * Download the links with no dashboard and return the exit code.
 *
 * When soundcli is already running (a dashboard, or another `add`), the links
 * are handed to it and this returns at once: one process owns the library.
 */
export async function runAdd(
  cmd: AddCommand,
  deps: HeadlessDeps = defaultDeps(),
): Promise<number> {
  const emit = (e: HeadlessEvent): void =>
    deps.out(cmd.json ? JSON.stringify(e) : describe(e));

  // Every link is checked before anything is claimed or fetched, so a typo
  // fails in milliseconds and changes nothing.
  const targets: { link: string; target: OkTarget }[] = [];
  for (const link of cmd.links) {
    const target = resolveLink(link, { all: cmd.all });
    if (!target.ok) {
      deps.note(`${link}: ${target.reason}`);
      return EXIT.usage;
    }
    targets.push({ link, target });
  }

  const claim = await claimInstance("headless", deps.dataDir);
  if (!claim) {
    const owner = await liveOwner(deps.dataDir);
    await submitRequest(
      { kind: "add", links: cmd.links, all: cmd.all },
      deps.dataDir,
    );
    emit({ event: "handoff", owner: owner?.kind ?? "tui" });
    return EXIT.ok;
  }

  let engine: Engine | undefined;
  const tally = { saved: 0, exists: 0, failed: 0, retryable: 0 };
  let linkErrors = 0;
  // Links still being read. The queue cannot see these yet, so "nothing
  // pending" alone would end the run under them.
  let busy = 0;
  let recheck: (() => void) | undefined;

  const onItem = (item: QueueItem, track?: Track, owned = false): void => {
    const name = {
      source: item.source,
      title: track?.title ?? item.track.title,
      artist: track?.artist ?? item.track.artist,
    };
    if (item.status === "error") {
      const permanent = isPermanentTrackError(item.error ?? "");
      tally.failed++;
      if (!permanent) tally.retryable++;
      emit({
        event: "track",
        status: "failed",
        ...name,
        reason: shortError(item.error),
        detail: item.error,
        permanent,
      });
    } else if (item.status === "done" && !owned) {
      tally.saved++;
      emit({ event: "track", status: "saved", ...name, file: track?.filePath });
    } else if (item.status === "done" || item.status === "skipped") {
      // A song the library held before this run. Those the link's own count
      // already covers (`owned`) are named here but not tallied twice.
      if (!owned) tally.exists++;
      emit({ event: "track", status: "exists", ...name, file: track?.filePath });
    }
    // A canceled row means the run is stopping; it resumes from the saved queue.
  };

  const add = async (link: string, target: OkTarget): Promise<void> => {
    busy++;
    try {
      const r = await enqueueTarget(engine!.queue, target);
      if (r.firstError) linkErrors++;
      tally.exists += r.alreadySaved;
      emit({
        event: "link",
        link,
        tracks: r.total,
        new: r.newTracks,
        saved: r.alreadySaved,
        // yt-dlp repeats the whole message inside a trailing "(caused by ...)".
        error: r.firstError?.split(" (caused by ")[0],
      });
    } finally {
      busy--;
      recheck?.();
    }
  };

  let stop!: (why: "yielded" | "interrupted") => void;
  const stopped = new Promise<"yielded" | "interrupted">((resolve) => {
    stop = resolve;
  });

  // The claim is touched from the first moment: setup can spend a minute
  // fetching tools, and a claim that went stale meanwhile would let a second
  // process start beside this one.
  const inbox = ownerInbox(claim, deps.dataDir);
  const onTick = async (): Promise<void> => {
    const request = await inbox(
      () =>
        engine !== undefined && busy === 0 && !engine.queue.stats().gathering,
    );
    if (!request) return;
    if (request.kind === "yield") {
      stop("yielded");
      return;
    }
    // Links from a later `add` join this run rather than waiting for it.
    for (const link of request.links) {
      const target = resolveLink(link, { all: request.all });
      if (target.ok) await add(link, target);
      else deps.note(`${link}: ${target.reason}`);
    }
  };
  const tick = setInterval(() => void onTick().catch(() => {}), deps.tickMs);
  const onSigint = (): void => stop("interrupted");
  process.once("SIGINT", onSigint);

  const cleanup = (): void => {
    clearInterval(tick);
    process.off("SIGINT", onSigint);
    // Kills the children and writes the unfinished queue, so the next run (or
    // the dashboard) picks it up from the .part files.
    engine?.queue.suspend();
    engine?.library.flushSync();
    claim.release();
  };

  const work = async (): Promise<"settled"> => {
    engine = await deps.boot(deps.note);
    const queue = engine.queue;
    queue.on("item", onItem);
    for (const { link, target } of targets) await add(link, target);
    await new Promise<void>((resolve) => {
      const check = (): void => {
        const s = queue.stats();
        if (busy > 0 || s.gathering || s.pending > 0 || s.downloading > 0) return;
        queue.off("update", check);
        recheck = undefined;
        resolve();
      };
      recheck = check;
      queue.on("update", check);
      check();
    });
    return "settled";
  };

  let outcome: "settled" | "yielded" | "interrupted";
  try {
    const working = work();
    // Once a stop wins the race nobody is left to hear a late failure.
    working.catch(() => {});
    outcome = await Promise.race([working, stopped]);
  } catch (e) {
    cleanup();
    deps.note(`soundcli: ${e instanceof Error ? e.message : String(e)}`);
    return EXIT.failed;
  }

  // A platform halt leaves rows on hold; read it before suspend() stops the
  // queue for our own reasons.
  const s = engine?.queue.stats();
  const halted =
    outcome === "yielded"
      ? "dashboard opened"
      : outcome === "interrupted"
        ? "interrupted"
        : s && s.rateLimited && s.paused > 0
          ? s.rateLimitReason
          : null;
  cleanup();

  const exit =
    outcome === "interrupted"
      ? EXIT.interrupted
      : halted
        ? EXIT.tryLater
        : tally.retryable > 0 || linkErrors > 0
          ? EXIT.failed
          : EXIT.ok;
  emit({
    event: "done",
    saved: tally.saved,
    exists: tally.exists,
    failed: tally.failed,
    halted,
    exit,
  });
  return exit;
}
