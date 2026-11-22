// `sndcli add`: the download engine with no dashboard, for an agent, a
// scheduler, or someone's script. It runs the same queue the dashboard does,
// so dedupe, folders, retries and pacing all behave identically; the only new
// decisions are who owns the library right now and what to tell the caller.

import { ensureFfmpeg } from "../bin/ffmpeg-fetch";
import { isLinkInput } from "../sources/detect";
import { ensureYtDlp, finalizeStagedYtDlp } from "../bin/ytdlp-fetch";
import { maybeUpdateYtDlp } from "../bin/ytdlp-update";
import { searchYouTube } from "../ytdlp/search";
import { loadConfig } from "../config/config";
import { paths } from "../config/paths";
import { enqueueAsked, listTarget } from "../download/gather";
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
import type { SourceTrack } from "../sources/types";
import {
  awaitPickup,
  claimInstance,
  liveOwner,
  ownerInbox,
  settleRequest,
  submitRequest,
  TICK_MS,
  type Claim,
  type InboxRequest,
  type OwnerKind,
} from "./instance";
import {
  askedBy,
  changeWatches,
  loadWatches,
  sameLink,
  type Asked,
  type Watch,
} from "./watches";

export interface AddCommand {
  links: string[];
  all: boolean;
  json: boolean;
  /** A folder of the user's own collection to save into. */
  into?: string;
}

export interface WatchCommand {
  links: string[];
  all: boolean;
  into?: string;
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

/** How long a failure waits for the signal that may have caused it. */
const SIGNAL_GRACE_MS = 50;

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
      /** Songs left alone because they failed for good not long ago. */
      unavailable?: number;
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
  /** Read what a link lists right now, with no engine: a watch's baseline. */
  list: (
    target: OkTarget,
    note: (message: string) => void,
  ) => Promise<SourceTrack[]>;
  /** The URL of the top YouTube result for a search, if there is one. */
  search: (
    query: string,
    note: (message: string) => void,
  ) => Promise<string | undefined>;
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
    list: async (target, note) => {
      await ensureYtDlp(note);
      return listTarget(target);
    },
    search: async (query, note) => {
      await ensureYtDlp(note);
      return (await searchYouTube(query, 1))[0]?.url;
    },
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
        (e.unavailable ? `, ${e.unavailable.toLocaleString()} unavailable` : "") +
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

/** A link to queue, already routed. */
type Job = Asked & { target: OkTarget };

/** Why a run ended before its queue settled. */
type Stop = "yielded" | "displaced" | StopSignal;

/**
 * Become the owner, or hand the request to the process that is and return its
 * kind. An owner can exit between any two of these checks, so a miss is tried
 * again rather than answered with a hand-off to nobody.
 */
async function claimOrHandOff(
  handOff: InboxRequest,
  deps: HeadlessDeps,
): Promise<Claim | OwnerKind> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const claim = await claimInstance("headless", deps.dataDir);
    if (claim) return claim;
    const owner = await liveOwner(deps.dataDir);
    if (!owner) {
      // A claim being created is empty for a moment: give it time to fill.
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
      continue;
    }
    const request = await submitRequest(handOff, deps.dataDir);
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
  // Every link is checked before anything is claimed or fetched, so a typo
  // fails in milliseconds and changes nothing.
  const links: string[] = [];
  for (const arg of cmd.links) {
    // Words with a space in them can't be a handle, so they are a search; a
    // single bare word stays an error because it could be a handle on any site.
    if (isLinkInput(arg) || !/\s/.test(arg.trim())) {
      links.push(arg);
      continue;
    }
    const url = await deps.search(arg, deps.note);
    if (!url) {
      deps.note(`${arg}: no YouTube result.`);
      return EXIT.failed;
    }
    deps.note(`${arg}: ${url}`);
    links.push(url);
  }
  const jobs: Job[] = [];
  for (const link of links) {
    const target = resolveLink(link, { all: cmd.all });
    if (!target.ok) {
      deps.note(`${link}: ${target.reason}`);
      return EXIT.usage;
    }
    jobs.push({ link, all: cmd.all, into: cmd.into, target });
  }
  return run(
    jobs,
    { kind: "add", links, all: cmd.all, into: cmd.into },
    cmd.json,
    deps,
  );
}

const NOTHING_WATCHED = "Nothing is watched. Start with: sndcli watch <link>";

/**
 * Download what is new on every watched link and return the exit code: the
 * same run as `add`, over the links `watch` remembered. It also carries on
 * whatever an earlier run left in the queue, so one scheduled command keeps
 * everything moving.
 */
export async function runSync(
  cmd: { json: boolean },
  deps: HeadlessDeps = defaultDeps(),
): Promise<number> {
  const jobs: Job[] = [];
  for (const watch of await loadWatches(deps.dataDir)) {
    const target = resolveLink(watch.link, { all: watch.all });
    // Checked when it was made: one that no longer reads is passed over.
    if (target.ok) jobs.push({ ...watch, target });
    else deps.note(`${watch.link}: ${target.reason}`);
  }
  if (jobs.length === 0) deps.note(NOTHING_WATCHED);
  return run(jobs, { kind: "sync" }, cmd.json, deps);
}

/** The plain-text line for a watch, when it is made and when they are listed. */
function describeWatch(w: Watch): string {
  const where = w.into ? `"${w.into}"` : "its own folder";
  const before =
    w.seen.length > 0
      ? `, the ${plural(w.seen.length, "song")} there before are left alone`
      : "";
  return `${w.link}: new songs save into ${where}${before}`;
}

/**
 * Remember links for `sync` to keep current, or list them when given none.
 * What a link holds today is recorded and left alone: `add` takes what is
 * there, a watch takes what comes after, and the two can be run together.
 */
export async function runWatch(
  cmd: WatchCommand,
  deps: HeadlessDeps = defaultDeps(),
): Promise<number> {
  const watches = await loadWatches(deps.dataDir);
  if (cmd.links.length === 0) {
    if (watches.length === 0) deps.note(NOTHING_WATCHED);
    for (const w of watches) deps.out(describeWatch(w));
    return EXIT.ok;
  }

  const targets: { link: string; target: OkTarget }[] = [];
  for (const link of cmd.links) {
    const target = resolveLink(link, { all: cmd.all });
    if (!target.ok) {
      deps.note(`${link}: ${target.reason}`);
      return EXIT.usage;
    }
    // A generic site's link may still be a whole page of songs.
    if (target.kind === "track" && target.source !== "link") {
      deps.note(
        `${link}: that is one song, and a song does not change. Use: sndcli add <link>`,
      );
      return EXIT.usage;
    }
    targets.push({ link, target });
  }

  let failed = false;
  const wanted: Watch[] = [];
  for (const { link, target } of targets) {
    const known = watches.find((w) => sameLink(w.link, link));
    if (known) {
      // Already watched: where it saves can change, what it has seen cannot,
      // or everything posted since would be passed over.
      const again = { ...known, all: cmd.all, into: cmd.into };
      wanted.push(again);
      deps.out(describeWatch(again));
      continue;
    }
    try {
      const listed = await deps.list(target, deps.note);
      const watch: Watch = {
        link,
        all: cmd.all,
        into: cmd.into,
        seen: [...new Set(listed.map((t) => t.id))],
        addedAt: new Date().toISOString(),
      };
      wanted.push(watch);
      deps.out(describeWatch(watch));
    } catch (e) {
      failed = true;
      deps.note(`${link}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // Onto the list as it is now, not as it was read before the listings: a
  // watch another command made meanwhile stays.
  await changeWatches((current) => {
    for (const w of wanted) {
      const known = current.find((c) => sameLink(c.link, w.link));
      if (known) {
        known.all = w.all;
        known.into = w.into;
      } else current.push(w);
    }
    return current;
  }, deps.dataDir);
  return failed ? EXIT.failed : EXIT.ok;
}

/** Stop watching links. What they already saved stays. */
export async function runUnwatch(
  cmd: { links: string[] },
  deps: HeadlessDeps = defaultDeps(),
): Promise<number> {
  let missing = false;
  await changeWatches((watches) => {
    let kept = watches;
    for (const link of cmd.links) {
      const rest = kept.filter((w) => !sameLink(w.link, link));
      if (rest.length === kept.length) {
        missing = true;
        deps.note(`${link}: not watched`);
      } else {
        deps.out(`${link}: no longer watched, saved files stay`);
      }
      kept = rest;
    }
    return kept;
  }, deps.dataDir);
  return missing ? EXIT.failed : EXIT.ok;
}

/**
 * The run behind `add` and `sync`: queue the jobs, see them through, and
 * report. `handOff` is what a process that already owns the library is asked
 * to do instead.
 */
async function run(
  jobs: Job[],
  handOff: InboxRequest,
  json: boolean,
  deps: HeadlessDeps,
): Promise<number> {
  // Nothing follows `done`. A run that is stopped leaves listings and
  // downloads to finish in their own time, and their lines would trail it.
  let over = false;
  const emit = (e: HeadlessEvent): void => {
    if (over) return;
    deps.out(json ? JSON.stringify(e) : describe(e));
    over = e.event === "done";
  };

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
    const held = await claimOrHandOff(handOff, deps);
    if (typeof held === "string") {
      emit({ event: "handoff", owner: held });
      // A script reads `done` as the end of every run. For a person the line
      // above is the whole story, and "0 saved" under it reads as a failure.
      return json ? done(EXIT.ok) : EXIT.ok;
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
  // Handed-over requests not yet settled, each with what is left of it to
  // list. Their sender has gone, so a run stopped under them gives them back.
  const unlisted = new Set<{
    taken: InboxRequest;
    rest: () => InboxRequest | null;
  }>();

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

  const add = async (job: Job): Promise<void> => {
    busy++;
    try {
      // Ahead of the backlog an earlier session left, which can run for hours.
      const r = await enqueueAsked(engine!.queue, job.target, job, {
        front: true,
      });
      if (r.firstError) linkErrors++;
      tally.exists += r.alreadySaved;
      emit({
        event: "link",
        link: job.link,
        tracks: r.total,
        new: r.newTracks,
        saved: r.alreadySaved,
        unavailable: r.unavailable || undefined,
        // yt-dlp repeats the whole message inside a trailing "(caused by ...)".
        error: r.firstError?.split(" (caused by ")[0],
      });
    } finally {
      busy--;
      recheck?.();
    }
  };

  let stop!: (why: Stop) => void;
  /** The first stop asked for, readable where the promise can't be. */
  let asked: Stop | undefined;
  const stopped = new Promise<Stop>((resolve) => {
    stop = (why) => {
      asked ??= why;
      resolve(why);
    };
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
      if (request.kind === "yield" || request.kind === "displaced") {
        stop(request.kind === "yield" ? "yielded" : "displaced");
        return "stopping";
      }
      // Links from a later `add` or `sync` join this run rather than waiting
      // for it.
      const asked = await askedBy(request, deps.dataDir);
      const entry = {
        taken: request,
        rest: (): InboxRequest | null =>
          asked.length === 0
            ? null
            : request.kind === "sync"
              ? request
              : { ...request, links: asked.map((a) => a.link) },
      };
      unlisted.add(entry);
      while (asked.length > 0) {
        const next = asked[0]!;
        const target = resolveLink(next.link, { all: next.all });
        if (target.ok) await add({ ...next, target });
        else deps.note(`${next.link}: ${target.reason}`);
        asked.shift();
      }
      // Its links are in the queue; once that is on disk the request is done
      // with. A queue that is stopping has had its last write: giveBack sees
      // to the request then.
      if (await engine!.queue.saveNow()) {
        unlisted.delete(entry);
        await settleRequest(request);
      }
      return "added";
    } finally {
      looking--;
      recheck?.();
    }
  };
  const tick = setInterval(() => void look().catch(() => {}), deps.tickMs);
  const unhear = deps.signals(stop);

  /** Lets go of everything; true when the queue went to disk on the way. */
  const cleanup = (save = true): boolean => {
    clearInterval(tick);
    unhear();
    // Kills the children and writes the unfinished queue, so the next run (or
    // the dashboard) picks it up from the .part files. A displaced run writes
    // nothing: the files are the new owner's now.
    const saved = engine?.queue.suspend(save) ?? false;
    if (save) engine?.library.flushSync();
    claim.release();
    return saved;
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
    for (const job of jobs) await add(job);
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

  /**
   * Back in the inbox for whoever owns the library next. What was already
   * listed went out with the queue; when that did not reach the disk (`saved`
   * false) the request stays held as well, whole, for the owner after.
   */
  const giveBack = async (saved: boolean): Promise<void> => {
    for (const { taken, rest } of unlisted) {
      const request = rest();
      if (request) await submitRequest(request, deps.dataDir).catch(() => {});
      if (saved) await settleRequest(taken);
    }
  };

  let outcome: "settled" | Stop;
  try {
    const working = work();
    // Once a stop wins the race nobody is left to hear a late failure.
    working.catch(() => {});
    outcome = await Promise.race([working, stopped]);
  } catch (e) {
    // An interrupt reaches the tools this run started too, so the work can
    // fail from the very signal that has not been heard here yet. A moment
    // for it to arrive: that was ctrl-c, not a failure.
    if (!asked) await new Promise((r) => setTimeout(r, SIGNAL_GRACE_MS));
    if (asked !== "SIGINT" && asked !== "SIGTERM") {
      await giveBack(cleanup());
      return fail(e);
    }
    outcome = asked;
  }

  // Rows left on hold mean the platform stopped the run; read them before
  // suspend() stops the queue for our own reasons.
  const s = engine?.queue.stats();
  const platformHalt =
    s && s.paused > 0 ? s.rateLimitReason || lastHalt || "on hold" : null;
  await giveBack(cleanup(outcome !== "displaced"));

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
