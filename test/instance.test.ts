import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
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
