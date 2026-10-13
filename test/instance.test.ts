import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  awaitPickup,
  claimInstance,
  liveOwner,
  ownerInbox,
  submitRequest,
  takeRequest,
  waitForRelease,
} from "../src/cli/instance";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "soundcli-inst-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const claimFile = (): string => path.join(dir, "instance.json");

/** A claim some other process wrote. */
const rival = JSON.stringify({ pid: 2 ** 30, kind: "headless", startedAt: "" });

describe("claimInstance", () => {
  it("makes this process the live owner until released", async () => {
    expect(await liveOwner(dir)).toBeNull();
    const claim = await claimInstance("tui", dir);
    expect(claim).not.toBeNull();
    expect(await liveOwner(dir)).toMatchObject({
      pid: process.pid,
      kind: "tui",
    });
    claim!.release();
    expect(await liveOwner(dir)).toBeNull();
    claim!.release(); // a second release is a no-op
  });

  it("refuses a second claim while the first is live", async () => {
    const first = await claimInstance("headless", dir);
    expect(await claimInstance("tui", dir)).toBeNull();
    first!.release();
    const second = await claimInstance("tui", dir);
    expect(second).not.toBeNull();
    second!.release();
  });

  it("takes over a claim whose process is gone", async () => {
    // A pid far past any real one: the claim's owner crashed without cleanup.
    await fs.writeFile(
      claimFile(),
      JSON.stringify({ pid: 2 ** 30, kind: "tui", startedAt: "" }),
    );
    expect(await liveOwner(dir)).toBeNull();
    const claim = await claimInstance("headless", dir);
    expect(claim).not.toBeNull();
    expect(await liveOwner(dir)).toMatchObject({ kind: "headless" });
    claim!.release();
  });

  it("treats a claim nobody has touched lately as abandoned", async () => {
    // The pid is alive (it is ours) but the heartbeat stopped: a reused pid
    // must not pass for the owner.
    await fs.writeFile(
      claimFile(),
      JSON.stringify({ pid: process.pid, kind: "tui", startedAt: "" }),
    );
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(claimFile(), old, old);
    expect(await liveOwner(dir)).toBeNull();
  });

  it("stays live as long as it is touched", async () => {
    const claim = await claimInstance("tui", dir);
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(claimFile(), old, old);
    expect(await liveOwner(dir)).toBeNull();
    await claim!.touch();
    expect(await liveOwner(dir)).not.toBeNull();
    claim!.release();
  });

  it("leaves a claim another process took over alone on release", async () => {
    const claim = await claimInstance("tui", dir);
    await fs.writeFile(
      claimFile(),
      JSON.stringify({ pid: 2 ** 30, kind: "headless", startedAt: "" }),
    );
    claim!.release();
    await expect(fs.access(claimFile())).resolves.toBeUndefined();
  });

  it("reports a claim another process now holds instead of keeping it warm", async () => {
    const claim = await claimInstance("tui", dir);
    expect(await claim!.touch()).toBe(true);
    // After a long freeze another process judged the claim abandoned.
    await fs.writeFile(claimFile(), rival);
    expect(await claim!.touch()).toBe(false);
    claim!.release();
  });

  it("gives a takeover up when a second process took the same claim over", async () => {
    // Both judged the old claim abandoned, and the slower one's cleanup
    // replaced our fresh claim with its own a moment after we wrote it.
    await fs.writeFile(claimFile(), rival);
    const taking = claimInstance("tui", dir, 800);
    await vi.waitFor(async () =>
      expect(await fs.readFile(claimFile(), "utf8")).toContain("tui"),
    );
    await fs.writeFile(claimFile(), rival);
    expect(await taking).toBeNull();
    expect(await fs.readFile(claimFile(), "utf8")).toBe(rival);
  });

  it("leaves a claim that is being written this instant alone", async () => {
    // Created empty, then written: read in between it names nobody, and
    // deleting it would knock out an owner that is just starting.
    await fs.writeFile(claimFile(), "");
    expect(await claimInstance("headless", dir)).toBeNull();
    expect(await fs.readFile(claimFile(), "utf8")).toBe("");
    // Left that way by a crash, it goes stale and is taken over like any other.
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(claimFile(), old, old);
    const claim = await claimInstance("headless", dir);
    expect(claim).not.toBeNull();
    claim!.release();
  });
});

describe("inbox", () => {
  it("hands requests over oldest first, each exactly once", async () => {
    await submitRequest({ kind: "add", links: ["a"], all: false }, dir);
    await new Promise((r) => setTimeout(r, 5));
    await submitRequest({ kind: "add", links: ["b"], all: true }, dir);
    expect(await takeRequest(dir)).toEqual({
      kind: "add",
      links: ["a"],
      all: false,
    });
    expect(await takeRequest(dir)).toEqual({
      kind: "add",
      links: ["b"],
      all: true,
    });
    expect(await takeRequest(dir)).toBeNull();
  });

  it("returns null when there is no inbox yet", async () => {
    expect(await takeRequest(dir)).toBeNull();
  });

  it("leaves a request the owner is not ready for", async () => {
    await submitRequest({ kind: "add", links: ["a"], all: false }, dir);
    await new Promise((r) => setTimeout(r, 5));
    await submitRequest({ kind: "yield" }, dir);
    // Busy listing: the add waits, the yield behind it still gets through.
    expect(await takeRequest(dir, (r) => r.kind === "yield")).toEqual({
      kind: "yield",
    });
    expect(await takeRequest(dir, (r) => r.kind === "yield")).toBeNull();
    expect(await takeRequest(dir)).toMatchObject({ kind: "add", links: ["a"] });
  });

  it("drops a file it cannot read instead of stalling behind it", async () => {
    const inbox = path.join(dir, "inbox");
    await fs.mkdir(inbox, { recursive: true });
    await fs.writeFile(path.join(inbox, "0000000000000-junk.json"), "{nope");
    await fs.writeFile(
      path.join(inbox, "0000000000001-shape.json"),
      JSON.stringify({ kind: "add", links: "not-a-list" }),
    );
    await submitRequest({ kind: "add", links: ["a"], all: false }, dir);
    expect(await takeRequest(dir)).toMatchObject({ links: ["a"] });
    expect(await fs.readdir(inbox)).toEqual([]);
  });

  it("ignores a request that is still being written", async () => {
    const inbox = path.join(dir, "inbox");
    await fs.mkdir(inbox, { recursive: true });
    await fs.writeFile(path.join(inbox, "0000000000000-half.tmp"), "{");
    expect(await takeRequest(dir)).toBeNull();
    expect(await fs.readdir(inbox)).toEqual(["0000000000000-half.tmp"]);
  });

  it("drops a yield nobody read in time", async () => {
    // It was for a run that had just finished. Left in the inbox it would stop
    // the next, unrelated run as if a dashboard were opening.
    const inbox = path.join(dir, "inbox");
    await fs.mkdir(inbox, { recursive: true });
    await fs.writeFile(
      path.join(inbox, `${Date.now() - 60_000}-1-old.json`),
      JSON.stringify({ kind: "yield" }),
    );
    expect(await takeRequest(dir)).toBeNull();
    expect(await fs.readdir(inbox)).toEqual([]);
  });
});

describe("ownerInbox", () => {
  it("touches the claim and gates adds on the owner being free", async () => {
    const claim = await claimInstance("tui", dir);
    const tick = ownerInbox(claim!, dir);
    await submitRequest({ kind: "add", links: ["a"], all: false }, dir);

    const old = new Date(Date.now() - 60_000);
    await fs.utimes(claimFile(), old, old);
    expect(await tick(() => false)).toBeNull();
    // The tick itself is the heartbeat, even when it takes nothing.
    expect(await liveOwner(dir)).not.toBeNull();

    expect(await tick(() => true)).toMatchObject({ kind: "add" });
    claim!.release();
  });

  it("takes a yield ahead of the adds queued before it", async () => {
    const claim = await claimInstance("headless", dir);
    const tick = ownerInbox(claim!, dir);
    await submitRequest({ kind: "add", links: ["a"], all: false }, dir);
    await new Promise((r) => setTimeout(r, 5));
    await submitRequest({ kind: "yield" }, dir);

    expect(await tick(() => true)).toEqual({ kind: "yield" });
    expect(await tick(() => true)).toMatchObject({ links: ["a"] });
    claim!.release();
  });

  it("takes nothing once the claim is someone else's", async () => {
    const claim = await claimInstance("tui", dir);
    const tick = ownerInbox(claim!, dir);
    await submitRequest({ kind: "add", links: ["a"], all: false }, dir);
    await fs.writeFile(claimFile(), rival);
    expect(await tick(() => true)).toEqual({ kind: "displaced" });
    // The request is the new owner's to read.
    expect(await takeRequest(dir)).toMatchObject({ links: ["a"] });
    claim!.release();
  });
});

describe("awaitPickup", () => {
  const request = (): Promise<string> =>
    submitRequest({ kind: "add", links: ["a"], all: false }, dir);

  it("returns once the owner takes the request", async () => {
    const claim = await claimInstance("tui", dir);
    const file = await request();
    setTimeout(() => void takeRequest(dir), 30);
    expect(await awaitPickup(file, dir, 2_000)).toBe(true);
    claim!.release();
  });

  it("withdraws the request when the owner goes away first", async () => {
    const claim = await claimInstance("tui", dir);
    const file = await request();
    setTimeout(() => claim!.release(), 30);
    expect(await awaitPickup(file, dir, 2_000)).toBe(false);
    // So the next owner cannot run it a second time.
    expect(await takeRequest(dir)).toBeNull();
  });
});

describe("waitForRelease", () => {
  it("returns once the owner lets go", async () => {
    const claim = await claimInstance("headless", dir);
    setTimeout(() => claim!.release(), 50);
    expect(await waitForRelease(dir, 2_000)).toBe(true);
  });

  it("gives up on an owner that stays", async () => {
    const claim = await claimInstance("headless", dir);
    expect(await waitForRelease(dir, 100)).toBe(false);
    claim!.release();
  });
});

describe("claimInstance, when two start together", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("tries again when the create meets a delete still in progress", async () => {
    // Windows answers EPERM, not EEXIST, while another process is deleting
    // the file. That clears within moments and must not fail the run.
    const real = fs.writeFile.bind(fs);
    let first = true;
    vi.spyOn(fs, "writeFile").mockImplementation(((
      file: string,
      data: string,
      opts: unknown,
    ) => {
      if (first && (opts as { flag?: string })?.flag === "wx") {
        first = false;
        return Promise.reject(
          Object.assign(new Error("EPERM: operation not permitted, open"), {
            code: "EPERM",
          }),
        );
      }
      return real(file, data, opts as never);
    }) as never);

    const claim = await claimInstance("headless", dir);
    expect(claim).not.toBeNull();
    claim!.release();
  });

  it("never lets two takeovers of one dead claim both win", async () => {
    await fs.writeFile(claimFile(), rival);
    const realRm = fs.rm.bind(fs);
    const realRename = fs.rename.bind(fs);
    let calls = 0;
    // The first to judge the claim abandoned stalls before clearing it, long
    // enough for the second to take over in between.
    const stall = async (): Promise<void> => {
      if (calls++ === 0) await new Promise((r) => setTimeout(r, 200));
    };
    vi.spyOn(fs, "rm").mockImplementation((async (f: string, o: never) => {
      await stall();
      return realRm(f, o);
    }) as never);
    vi.spyOn(fs, "rename").mockImplementation((async (a: string, b: string) => {
      await stall();
      return realRename(a, b);
    }) as never);

    const slow = claimInstance("headless", dir);
    await new Promise((r) => setTimeout(r, 20));
    const quick = claimInstance("headless", dir);
    const [a, b] = await Promise.all([quick, slow]);

    // Never both. (Neither is allowed: on a slow disk each can find the other
    // mid-step and stand down, and the next run simply claims.)
    expect([a, b].filter(Boolean).length).toBeLessThanOrEqual(1);
    a?.release();
    b?.release();
  });

  it("does not take a claim dated in the future for a live one forever", async () => {
    await fs.writeFile(
      claimFile(),
      JSON.stringify({ pid: process.pid, kind: "tui", startedAt: "" }),
    );
    const future = new Date(Date.now() + 3_600_000);
    await fs.utimes(claimFile(), future, future);
    expect(await liveOwner(dir)).toBeNull();
  });
});
