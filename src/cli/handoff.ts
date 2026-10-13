// The dashboard's side of the hand-off (see instance.ts). Kept out of the
// React tree so it can be tested without a terminal: the component only wires
// a hold to its boot and a timer.

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
 * whatever they were doing. One request at a time. Resolves false once the
 * claim is no longer this dashboard's.
 */
export function serveHandoffs(
  claim: Claim,
  queue: DownloadQueue,
  dir: string = paths.data,
): () => Promise<boolean> {
  const inbox = ownerInbox(claim, dir);
  let busy = false;
  return async () => {
    const request = await inbox(() => !busy);
    if (request?.kind === "displaced") return false;
    // A yield is meant for a background run; a dashboard keeps its queue.
    if (request?.kind !== "add") return true;
    busy = true;
    try {
      for (const link of request.links) {
        const target = resolveLink(link, { all: request.all });
        if (target.ok) await enqueueTarget(queue, target);
      }
    } finally {
      busy = false;
    }
    return true;
  };
}

/**
 * A dashboard's hold on the library from start to quit. `tick` runs every
 * TICK_MS throughout: the claim's heartbeat while setup is still fetching
 * tools (a first run can outlast the stale limit), the inbox once `serve` has
 * a queue, and another try at the claim while someone else has it, so a later
 * `sndcli add` does not start beside this dashboard.
 */
export async function holdForDashboard(
  dir: string = paths.data,
  yieldTimeoutMs?: number,
) {
  let claim = await claimForDashboard(dir, yieldTimeoutMs);
  let queue: DownloadQueue | undefined;
  let handoffs: (() => Promise<boolean>) | undefined;
  return {
    get owns(): boolean {
      return claim !== null;
    },
    serve(q: DownloadQueue): void {
      queue = q;
      handoffs = undefined;
    },
    release(): void {
      claim?.release();
      claim = null;
    },
    async tick(): Promise<void> {
      if (!claim) {
        // No yield is asked for here: a background run is only told to step
        // aside at boot, when its saved queue can still be restored.
        claim = await claimInstance("tui", dir);
        handoffs = undefined;
        return;
      }
      const held = claim;
      const ours = queue
        ? await (handoffs ??= serveHandoffs(held, queue, dir))()
        : await held.touch();
      if (!ours && claim === held) {
        held.release();
        claim = null;
      }
    },
  };
}

export type DashboardHold = Awaited<ReturnType<typeof holdForDashboard>>;
