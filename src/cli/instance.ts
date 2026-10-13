// One process owns the library and the queue at a time. Both are whole files
// rewritten from memory, so two writers would each undo the other's work. A
// second process hands its request to the owner through an inbox directory
// instead: nothing listens on a port, and a request written while the owner is
// busy simply waits for its next tick.

import { promises as fs, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { paths } from "../config/paths";

export type OwnerKind = "tui" | "headless";

export interface Owner {
  pid: number;
  kind: OwnerKind;
  startedAt: string;
}

export type InboxRequest =
  /** Links for the owner to queue, as `sndcli add` received them. */
  | { kind: "add"; links: string[]; all: boolean; into?: string }
  /** Check every watched link, as `sndcli sync` would (see cli/watches). */
  | { kind: "sync" }
  /** A dashboard is opening and wants the queue: save it and step aside. */
  | { kind: "yield" };

/** How often an owner proves it is alive and looks for requests. */
export const TICK_MS = 2_000;

/** A claim untouched for this long belongs to a process that is gone. */
const STALE_MS = 15_000;

function claimFile(dir: string): string {
  return path.join(dir, "instance.json");
}

function inboxDir(dir: string): string {
  return path.join(dir, "inbox");
}

/**
 * Create the claim, or throw EEXIST when there is one. Windows answers EPERM
 * or EBUSY instead to a create that lands while another process is still
 * deleting the file, which clears within moments, so those are tried again.
 */
async function createExclusive(file: string, owner: Owner): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.writeFile(file, JSON.stringify(owner), { flag: "wx" });
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if ((code !== "EPERM" && code !== "EBUSY") || attempt === 4) throw e;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

/**
 * Clear a claim just judged abandoned. Judging and removing are two steps,
 * and another process can put its own claim there in between, so the file is
 * moved aside and judged again: one that turns out to be live goes back.
 * False when the claim was not ours to clear.
 */
async function clearAbandoned(file: string): Promise<boolean> {
  const aside = `${file}.${process.pid}.old`;
  try {
    await fs.rename(file, aside);
  } catch (e) {
    // Already gone is as good as cleared.
    return (e as NodeJS.ErrnoException).code === "ENOENT";
  }
  const live = await readClaimAt(aside);
  if (live) await fs.link(aside, file).catch(() => {});
  await fs.rm(aside, { force: true }).catch(() => {});
  return !live;
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Who the claim names: its live owner, null when nobody holds it, or
 * "unreadable" for a fresh claim that does not parse. A claim is created empty
 * and then written, so that one is most likely being made this instant.
 */
async function readClaim(dir: string): Promise<Owner | "unreadable" | null> {
  return readClaimAt(claimFile(dir));
}

async function readClaimAt(
  file: string,
): Promise<Owner | "unreadable" | null> {
  try {
    // Either way from now: a claim dated in the future (a clock set back) was
    // never touched "recently" and must not pass for a live one until then.
    if (Math.abs(Date.now() - (await fs.stat(file)).mtimeMs) > STALE_MS) {
      return null;
    }
    const owner = JSON.parse(await fs.readFile(file, "utf8")) as Owner | null;
    if (typeof owner?.pid !== "number") return "unreadable";
    return isRunning(owner.pid) ? owner : null;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? null : "unreadable";
  }
}

/**
 * The process that currently owns the library, or null. A pid alone is not
 * proof: the OS reuses them, so the claim also has to have been touched
 * recently, which only a live owner's tick does.
 */
export async function liveOwner(dir: string = paths.data): Promise<Owner | null> {
  const claim = await readClaim(dir);
  return claim === "unreadable" ? null : claim;
}

export interface Claim {
  /**
   * Prove the owner is still alive; call every TICK_MS. False when the claim
   * now names another process (one that took over after a long freeze), and
   * the caller has to stop acting as the owner.
   */
  touch(): Promise<boolean>;
  /** Give the claim up. Safe to call twice, and from an exit handler. */
  release(): void;
}

function sameOwner(a: Owner, b: Owner): boolean {
  return a.pid === b.pid && a.startedAt === b.startedAt;
}

/**
 * Become the owner, or return null when a live process already is. The claim
 * is an exclusive create, so of two processes starting together only one gets
 * it. A claim left behind by a crash is cleared and taken over.
 */
export async function claimInstance(
  kind: OwnerKind,
  dir: string = paths.data,
  settleMs = 50,
): Promise<Claim | null> {
  await fs.mkdir(dir, { recursive: true });
  const file = claimFile(dir);
  const owner: Owner = {
    pid: process.pid,
    kind,
    startedAt: new Date().toISOString(),
  };

  let held = false;
  let tookOver = false;
  for (let attempt = 0; attempt < 2 && !held; attempt++) {
    try {
      await createExclusive(file, owner);
      held = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // Live, or being written this instant: either way not ours to remove.
      if (await readClaim(dir)) return null;
      if (!(await clearAbandoned(file))) return null;
      tookOver = true;
    }
  }
  if (!held) return null;

  /** Whether the claim file still names this process. */
  const ours = async (): Promise<boolean> => {
    try {
      return sameOwner(JSON.parse(await fs.readFile(file, "utf8")), owner);
    } catch (e) {
      // Gone or half-written means taken over. Any other error is a hiccup.
      const code = (e as NodeJS.ErrnoException).code;
      return code !== undefined && code !== "ENOENT";
    }
  };

  // Two processes can each judge a claim abandoned, and the slower one's
  // cleanup then deletes the faster one's fresh claim. That lands within
  // milliseconds, so a moment later the file names whoever really won.
  if (tookOver) {
    await new Promise((r) => setTimeout(r, settleMs));
    if (!(await ours())) return null;
  }

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    process.off("exit", release);
    try {
      // Only our own claim: after a long freeze another process may have
      // judged it stale and taken over.
      const current = JSON.parse(readFileSync(file, "utf8")) as Owner;
      if (sameOwner(current, owner)) rmSync(file, { force: true });
    } catch {
      // already gone
    }
  };
  process.on("exit", release);

  return {
    touch: async () => {
      if (released || !(await ours())) return false;
      const now = new Date();
      await fs.utimes(file, now, now).catch(() => {});
      return true;
    },
    release,
  };
}

/**
 * Leave a request for the owner and return its file. Written under a temp
 * name and renamed, so the owner never reads half a file.
 */
export async function submitRequest(
  request: InboxRequest,
  dir: string = paths.data,
): Promise<string> {
  const inbox = inboxDir(dir);
  await fs.mkdir(inbox, { recursive: true });
  const name = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const tmp = path.join(inbox, `${name}.tmp`);
  const file = path.join(inbox, `${name}.json`);
  await fs.writeFile(tmp, JSON.stringify(request), "utf8");
  await fs.rename(tmp, file);
  return file;
}

/**
 * Watch a request until the owner takes it, for up to `timeoutMs`. False when
 * the owner went away first: the request is withdrawn, so a later owner cannot
 * run it a second time, and the work is the sender's again.
 */
export async function awaitPickup(
  file: string,
  dir: string = paths.data,
  timeoutMs = 3 * TICK_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const waiting = await fs.access(file).then(
      () => true,
      () => false,
    );
    if (!waiting || Date.now() >= deadline) return true;
    if (!(await liveOwner(dir))) {
      // Already gone means someone took it after all.
      return fs.rm(file).then(
        () => false,
        (e: NodeJS.ErrnoException) => e.code === "ENOENT",
      );
    }
    await new Promise((r) => setTimeout(r, Math.min(100, timeoutMs)));
  }
}

function parseRequest(raw: string): InboxRequest | null {
  try {
    const r = JSON.parse(raw) as Partial<InboxRequest> & Record<string, unknown>;
    if (r.kind === "yield") return { kind: "yield" };
    if (r.kind === "sync") return { kind: "sync" };
    if (
      r.kind === "add" &&
      Array.isArray(r.links) &&
      r.links.every((l) => typeof l === "string")
    ) {
      return {
        kind: "add",
        links: r.links,
        all: r.all === true,
        into: typeof r.into === "string" ? r.into : undefined,
      };
    }
  } catch {
    // not JSON
  }
  return null;
}

/** The file each taken request is kept in until it is settled. */
const heldFiles = new WeakMap<InboxRequest, string>();

/**
 * Take the oldest request the owner is ready for, or null. A request `accept`
 * turns down stays in the inbox for a later tick; one that cannot be read is
 * dropped so it never blocks the ones behind it.
 *
 * Links are not removed when they are taken, only moved to a name no take
 * reads: their sender has already been told they were handed over, so an owner
 * that dies before queueing them must leave them behind (see settleRequest).
 */
export async function takeRequest(
  dir: string = paths.data,
  accept: (request: InboxRequest) => boolean = () => true,
): Promise<InboxRequest | null> {
  const inbox = inboxDir(dir);
  let names: string[];
  try {
    names = await fs.readdir(inbox);
  } catch {
    return null;
  }
  // Names start with a millisecond timestamp, so name order is arrival order.
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    const file = path.join(inbox, name);
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    const request = parseRequest(raw);
    // A yield is for the run holding the library when a dashboard opens. One
    // nobody read in time (that run had just finished) would otherwise stop
    // the next, unrelated run.
    const stale =
      request?.kind === "yield" &&
      Date.now() - Number.parseInt(name, 10) > STALE_MS;
    if (request && !stale && !accept(request)) continue;
    const taken = request && !stale ? request : null;
    // A yield is acted on at once and never wanted twice.
    const held =
      taken && taken.kind !== "yield"
        ? `${file.slice(0, -".json".length)}.held`
        : null;
    // A file that cannot be moved or removed (held open by a scanner) is not
    // taken, or the next tick would take it again; it must not block the ones
    // behind it.
    try {
      if (held) await fs.rename(file, held);
      else await fs.rm(file, { force: true });
    } catch {
      continue;
    }
    if (!taken) continue;
    if (held) heldFiles.set(taken, held);
    return taken;
  }
  return null;
}

/**
 * Let go of a taken request, once its links are in a queue that is on disk.
 * Until then they exist nowhere else.
 */
export async function settleRequest(request: InboxRequest): Promise<void> {
  const file = heldFiles.get(request);
  if (!file) return;
  heldFiles.delete(request);
  await fs.rm(file, { force: true }).catch(() => {});
}

/**
 * Put back every request an earlier owner took and never settled. Only the
 * owner calls this, before it takes anything, so whatever is held then was
 * left by a process that is gone. Queueing a link twice changes nothing, so a
 * request served a second time costs one more listing at worst.
 */
export async function releaseHeld(dir: string = paths.data): Promise<void> {
  const inbox = inboxDir(dir);
  let names: string[];
  try {
    names = await fs.readdir(inbox);
  } catch {
    return;
  }
  for (const name of names.filter((n) => n.endsWith(".held"))) {
    const file = path.join(inbox, name);
    // Back under the name it arrived with, which keeps its place in line.
    await fs
      .rename(file, `${file.slice(0, -".held".length)}.json`)
      .catch(() => {});
  }
}

/** A tick's find. "displaced": the claim is no longer this process's. */
export type InboxTick = InboxRequest | { kind: "displaced" } | null;

/**
 * An owner's side of the inbox, one call per tick: prove liveness, then take
 * at most one request. A yield is always taken; an add only while `canAdd()`
 * says the owner is free to start listing another batch. Ticks never overlap
 * inside the inbox, so two of them can't each take an add. A displaced owner
 * takes nothing: the requests are the new owner's to read. The first tick
 * also brings back what the owner before this one left unfinished.
 */
export function ownerInbox(
  claim: Claim,
  dir: string = paths.data,
): (canAdd: () => boolean) => Promise<InboxTick> {
  let taking = false;
  let recovered = false;
  return async (canAdd) => {
    if (!(await claim.touch())) return { kind: "displaced" };
    if (taking) return null;
    taking = true;
    try {
      if (!recovered) {
        recovered = true;
        await releaseHeld(dir);
      }
      // A yield first, whatever arrived before it: an opening dashboard only
      // waits so long for the library.
      return (
        (await takeRequest(dir, (r) => r.kind === "yield")) ??
        (await takeRequest(dir, (r) => r.kind === "yield" || canAdd()))
      );
    } finally {
      taking = false;
    }
  };
}

/** Wait for the current owner to let go. False when it is still there. */
export async function waitForRelease(
  dir: string = paths.data,
  timeoutMs = 8_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!(await liveOwner(dir))) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
}
