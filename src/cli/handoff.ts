// The dashboard's side of the hand-off (see instance.ts). Kept out of the
// React tree so it can be tested without a terminal: the component only wires
// these two calls to its boot and a timer.

import { paths } from "../config/paths";
import { enqueueTarget } from "../download/gather";
import type { DownloadQueue } from "../download/queue";
import { resolveLink } from "../sources/resolve-link";
import {
  claimInstance,
  liveOwner,
  ownerInbox,
  submitRequest,
  waitForRelease,
  type Claim,
} from "./instance";

/**
 * Take ownership for a dashboard that is starting. A background `sndcli add`
 * holding the library saves its queue and steps aside first, so the dashboard
 * restores that queue and carries the same downloads on in plain sight.
 *
 * Null when another dashboard already owns it. That second dashboard then runs
 * exactly as it always has, just without an inbox.
 */
export async function claimForDashboard(
  dir: string = paths.data,
  yieldTimeoutMs?: number,
): Promise<Claim | null> {
  const owner = await liveOwner(dir);
  if (owner?.kind === "headless") {
    await submitRequest({ kind: "yield" }, dir);
    await waitForRelease(dir, yieldTimeoutMs);
  }
  return claimInstance("tui", dir);
}

/**
 * The dashboard's inbox tick. Links another process handed over join the
 * queue quietly: they show up in Downloads without pulling the user off
 * whatever they were doing. One request at a time, and never while lists are
 * still loading, since the queue tracks a single gather.
 */
export function serveHandoffs(
  claim: Claim,
  queue: DownloadQueue,
  dir: string = paths.data,
): () => Promise<void> {
  const inbox = ownerInbox(claim, dir);
  let busy = false;
  return async () => {
    const request = await inbox(() => !busy && !queue.stats().gathering);
    // A yield is meant for a background run; a dashboard keeps its queue.
    if (request?.kind !== "add") return;
    busy = true;
    try {
      for (const link of request.links) {
        const target = resolveLink(link, { all: request.all });
        if (target.ok) await enqueueTarget(queue, target);
      }
    } finally {
      busy = false;
    }
  };
}
