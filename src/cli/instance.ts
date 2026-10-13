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
  | { kind: "add"; links: string[]; all: boolean }
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
 * The process that currently owns the library, or null. A pid alone is not
 * proof: the OS reuses them, so the claim also has to have been touched
 * recently, which only a live owner's tick does.
 */
export async function liveOwner(dir: string = paths.data): Promise<Owner | null> {
  try {
    const file = claimFile(dir);
    const [raw, stat] = await Promise.all([
      fs.readFile(file, "utf8"),
      fs.stat(file),
    ]);
    const owner = JSON.parse(raw) as Owner;
    if (typeof owner.pid !== "number") return null;
    if (Date.now() - stat.mtimeMs > STALE_MS) return null;
    return isRunning(owner.pid) ? owner : null;
  } catch {
    return null;
  }
}

export interface Claim {
  /** Prove the owner is still alive; call every TICK_MS. */
  touch(): Promise<void>;
  /** Give the claim up. Safe to call twice, and from an exit handler. */
  release(): void;
}

/**
 * Become the owner, or return null when a live process already is. The claim
 * is an exclusive create, so of two processes starting together only one gets
 * it. A claim left behind by a crash is cleared and taken over.
 */
export async function claimInstance(
  kind: OwnerKind,
  dir: string = paths.data,
): Promise<Claim | null> {
  await fs.mkdir(dir, { recursive: true });
  const file = claimFile(dir);
  const owner: Owner = {
    pid: process.pid,
    kind,
    startedAt: new Date().toISOString(),
  };

  let held = false;
  for (let attempt = 0; attempt < 2 && !held; attempt++) {
    try {
      await fs.writeFile(file, JSON.stringify(owner), { flag: "wx" });
      held = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (await liveOwner(dir)) return null;
      await fs.rm(file, { force: true });
    }
  }
  if (!held) return null;

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    process.off("exit", release);
    try {
      // Only our own claim: after a long freeze another process may have
      // judged it stale and taken over.
      const current = JSON.parse(readFileSync(file, "utf8")) as Owner;
      if (current.pid === process.pid) rmSync(file, { force: true });
    } catch {
      // already gone
    }
  };
  process.on("exit", release);

  return {
    touch: async () => {
      const now = new Date();
      await fs.utimes(file, now, now).catch(() => {});
    },
    release,
  };
}

/**
 * Leave a request for the owner. Written under a temp name and renamed, so
 * the owner never reads half a file.
 */
export async function submitRequest(
  request: InboxRequest,
  dir: string = paths.data,
): Promise<void> {
  const inbox = inboxDir(dir);
  await fs.mkdir(inbox, { recursive: true });
  const name = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const tmp = path.join(inbox, `${name}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(request), "utf8");
  await fs.rename(tmp, path.join(inbox, `${name}.json`));
}

function parseRequest(raw: string): InboxRequest | null {
  try {
    const r = JSON.parse(raw) as Partial<InboxRequest> & Record<string, unknown>;
    if (r.kind === "yield") return { kind: "yield" };
    if (
      r.kind === "add" &&
      Array.isArray(r.links) &&
      r.links.every((l) => typeof l === "string")
    ) {
      return { kind: "add", links: r.links, all: r.all === true };
    }
  } catch {
    // not JSON
  }
  return null;
}

/**
 * Take the oldest request the owner is ready for, or null. A request `accept`
 * turns down stays in the inbox for a later tick; one that cannot be read is
 * dropped so it never blocks the ones behind it.
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
    if (request && !accept(request)) continue;
    await fs.rm(file, { force: true });
    if (request) return request;
  }
  return null;
}

/**
 * An owner's side of the inbox, one call per tick: prove liveness, then take
 * at most one request. A yield is always taken; an add only while `canAdd()`
 * says the owner is free to start listing another batch. Ticks never overlap
 * inside the inbox, so two of them can't each take an add.
 */
export function ownerInbox(
  claim: Claim,
  dir: string = paths.data,
): (canAdd: () => boolean) => Promise<InboxRequest | null> {
  let taking = false;
  return async (canAdd) => {
    await claim.touch();
    if (taking) return null;
    taking = true;
    try {
      return await takeRequest(dir, (r) => r.kind === "yield" || canAdd());
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
