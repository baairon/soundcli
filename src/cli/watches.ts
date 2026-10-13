// The links a scheduler keeps current. `sndcli watch` remembers one, and
// `sndcli sync` checks them all and exits: soundcli stays a command that runs
// and ends, and the operating system's own scheduler decides how often.

import { promises as fs } from "node:fs";
import path from "node:path";
import { paths } from "../config/paths";
import type { InboxRequest } from "./instance";

export interface Watch {
  link: string;
  /** Take every playlist on a profile link. */
  all: boolean;
  /** A folder of the user's own collection to save into (see `--into`). */
  into?: string;
  /**
   * Ids the link listed when the watch was made. They are left alone: `add`
   * takes what is there, a watch takes what comes after.
   */
  seen: string[];
  addedAt: string;
}

/** One link to queue, however it was asked for. */
export type Asked = Pick<Watch, "link" | "all" | "into"> & {
  seen?: readonly string[];
};

function watchesFile(dir: string): string {
  return path.join(dir, "watches.json");
}

/** Two spellings of one link: surrounding space and a trailing slash aside. */
export function sameLink(a: string, b: string): boolean {
  const tidy = (s: string): string => s.trim().replace(/\/+$/, "");
  return tidy(a) === tidy(b);
}

export async function loadWatches(dir: string = paths.data): Promise<Watch[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(watchesFile(dir), "utf8")) as {
      version?: number;
      watches?: Watch[];
    };
    if (parsed?.version === 1 && Array.isArray(parsed.watches)) {
      return parsed.watches.filter(
        (w) => typeof w?.link === "string" && Array.isArray(w.seen),
      );
    }
  } catch {
    // missing or invalid: nothing is watched
  }
  return [];
}

export async function saveWatches(
  watches: Watch[],
  dir: string = paths.data,
): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const file = watchesFile(dir);
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ version: 1, watches }, null, 2), "utf8");
  await fs.rename(tmp, file);
}

/**
 * The links a request from the inbox stands for: its own, or every watched
 * one for a `sync`, which carries none so that it always means the list as it
 * is when it is served.
 */
export async function askedBy(
  request: Extract<InboxRequest, { kind: "add" | "sync" }>,
  dir: string = paths.data,
): Promise<Asked[]> {
  if (request.kind === "sync") return loadWatches(dir);
  return request.links.map((link) => ({
    link,
    all: request.all,
    into: request.into,
  }));
}
