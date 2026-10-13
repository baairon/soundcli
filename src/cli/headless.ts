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
  awaitPickup,
  claimInstance,
  liveOwner,
  ownerInbox,
  submitRequest,
  TICK_MS,
  type Claim,
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
 * the queue is saved, and running the same command later carries on. 130 and
 * 143 are the shell's own convention for ctrl-c and a plain kill.
 */
export const EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  tryLater: 75,
  interrupted: 130,
  terminated: 143,
} as const;

/**
 * The signals that end a run early with its place saved. SIGHUP is left
 * alone: a listener would undo `nohup`, which works by having it ignored.
 */
const SIGNAL_STOPS = {
  SIGINT: { halted: "interrupted", exit: EXIT.interrupted },
  SIGTERM: { halted: "terminated", exit: EXIT.terminated },
} as const;

export type StopSignal = keyof typeof SIGNAL_STOPS;

/**
 * Everything `--json` prints, one object per line. This is a public contract:
 * fields are only ever added, never renamed or removed. `done` is the last
 * line of every run whose links were accepted.
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
  /** Hear the signals that stop a run; returns how to stop listening. */
  signals: (onSignal: (signal: StopSignal) => void) => () => void;
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
    signals: (onSignal) => {
      const signals = Object.keys(SIGNAL_STOPS) as StopSignal[];
      const heard = signals.map((signal) => {
        const handler = (): void => onSignal(signal);
        process.once(signal, handler);
        return () => process.off(signal, handler);
      });
      return () => heard.forEach((off) => off());
    },
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

/** Why a run ended before its queue settled. */
type Stop = "yielded" | "displaced" | StopSignal;

/**
 * Become the owner, or hand the links to the process that is and return its
 * kind. An owner can exit between any two of these checks, so a miss is tried
 * again rather than answered with a hand-off to nobody.
 */
async function claimOrHandOff(
  cmd: AddCommand,
  deps: HeadlessDeps,
): Promise<Claim | OwnerKind> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const claim = await claimInstance("headless", deps.dataDir);
    if (claim) return claim;
    const owner = await liveOwner(deps.dataDir);
    if (!owner) continue;
    const request = await submitRequest(
      { kind: "add", links: cmd.links, all: cmd.all },
      deps.dataDir,
    );
    // False: the owner left before reading it, so the links are still ours.
    if (await awaitPickup(request, deps.dataDir, deps.tickMs * 3)) {
      return owner.kind;
    }
  }
  throw new Error("couldn't tell whether another soundcli is running");
}

/**
 * Download the links with no dashboard and return the exit code.
 *
 * When soundcli is already running (a dashboard, or another `add`), the links
 * are handed to it and this returns once it has them: one process owns the
 * library.
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

  const tally = { saved: 0, exists: 0, failed: 0, retryable: 0 };
  const done = (exit: number, halted: string | null = null): number => {
    emit({
      event: "done",
      saved: tally.saved,
      exists: tally.exists,
      failed: tally.failed,
      halted,
      exit,
    });
    return exit;
  };
  const fail = (e: unknown): number => {
    deps.note(`soundcli: ${e instanceof Error ? e.message : String(e)}`);
    return done(EXIT.failed);
  };

  let claim: Claim;
  try {
    const held = await claimOrHandOff(cmd, deps);
    if (typeof held === "string") {
      emit({ event: "handoff", owner: held });
      // A script reads `done` as the end of every run. For a person the line
      // above is the whole story, and "0 saved" under it reads as a failure.
      return cmd.json ? done(EXIT.ok) : EXIT.ok;
    }
    claim = held;
  } catch (e) {
    return fail(e);
  }

  let engine: Engine | undefined;
  let linkErrors = 0;
  // Links still being read. The queue cannot see these yet, so "nothing
  // pending" alone would end the run under them.
  let busy = 0;
  // Looks at the inbox in flight: a request leaves the inbox a moment before
  // its links reach the queue.
  let looking = 0;
  // Why the platform last parked the queue. Queueing another link clears the
  // queue's own flag while the rows it parked stay parked.
  let lastHalt = "";
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
      // Ahead of the backlog an earlier session left, which can run for hours.
      const r = await enqueueTarget(engine!.queue, target, { front: true });
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

  let stop!: (why: Stop) => void;
  const stopped = new Promise<Stop>((resolve) => {
    stop = resolve;
  });

  // The claim is touched from the first moment: setup can spend a minute
  // fetching tools, and a claim that went stale meanwhile would let a second
  // process start beside this one.
  const inbox = ownerInbox(claim, deps.dataDir);
  /** One look at the inbox: the heartbeat, plus at most one request. */
  const look = async (): Promise<"added" | "stopping" | "empty"> => {
    looking++;
    try {
      const request = await inbox(() => engine !== undefined && busy === 0);
      if (!request) return "empty";
      if (request.kind !== "add") {
        stop(request.kind === "yield" ? "yielded" : "displaced");
        return "stopping";
      }
      // Links from a later `add` join this run rather than waiting for it.
      for (const link of request.links) {
        const target = resolveLink(link, { all: request.all });
        if (target.ok) await add(link, target);
        else deps.note(`${link}: ${target.reason}`);
      }
      return "added";
    } finally {
      looking--;
      recheck?.();
    }
  };
  const tick = setInterval(() => void look().catch(() => {}), deps.tickMs);
  const unhear = deps.signals(stop);

  const cleanup = (save = true): void => {
    clearInterval(tick);
    unhear();
    // Kills the children and writes the unfinished queue, so the next run (or
    // the dashboard) picks it up from the .part files. A displaced run writes
    // nothing: the files are the new owner's now.
    engine?.queue.suspend(save);
    if (save) engine?.library.flushSync();
    claim.release();
  };

  const work = async (): Promise<"settled" | Stop> => {
    engine = await deps.boot(deps.note);
    const queue = engine.queue;
    queue.on("item", onItem);
    // Resolves the settle being waited on once nothing is left in motion.
    let settle: (() => void) | undefined;
    const watch = (): void => {
      const s = queue.stats();
      if (s.rateLimited) lastHalt = s.rateLimitReason;
      if (!settle || busy > 0 || looking > 0) return;
      if (s.gathering || s.pending > 0 || s.downloading > 0) return;
      settle();
      settle = undefined;
    };
    recheck = watch;
    queue.on("update", watch);
    for (const { link, target } of targets) await add(link, target);
    for (;;) {
      await new Promise<void>((resolve) => {
        settle = resolve;
        watch();
      });
      // One last look before letting go: links handed over since the previous
      // tick would otherwise wait in the inbox with nobody left to read them.
      // A file error here is not the run's failure; the request stays put.
      const found = await look().catch(() => "empty" as const);
      if (found === "stopping") return stopped;
      // A tick that began during that look may still be bringing links in.
      if (found === "empty" && looking === 0) return "settled";
    }
  };

  let outcome: "settled" | Stop;
  try {
    const working = work();
    // Once a stop wins the race nobody is left to hear a late failure.
    working.catch(() => {});
    outcome = await Promise.race([working, stopped]);
  } catch (e) {
    cleanup();
    return fail(e);
  }

  // Rows left on hold mean the platform stopped the run; read them before
  // suspend() stops the queue for our own reasons.
  const s = engine?.queue.stats();
  const platformHalt =
    s && s.paused > 0 ? s.rateLimitReason || lastHalt || "on hold" : null;
  cleanup(outcome !== "displaced");

  if (outcome === "yielded") return done(EXIT.tryLater, "dashboard opened");
  if (outcome === "displaced") {
    return done(EXIT.tryLater, "another soundcli took over");
  }
  if (outcome !== "settled") {
    return done(SIGNAL_STOPS[outcome].exit, SIGNAL_STOPS[outcome].halted);
  }
  if (platformHalt) return done(EXIT.tryLater, platformHalt);
  return done(tally.retryable > 0 || linkErrors > 0 ? EXIT.failed : EXIT.ok);
}
