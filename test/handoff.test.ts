import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// Downloads never finish here, so a run only ends when something stops it.
const enumerateMock = vi.fn();
vi.mock("../src/ytdlp/ytdlp", () => ({
  downloadTrack: vi.fn(() => new Promise(() => {})),
  enumerate: (...a: unknown[]) => enumerateMock(...a),
}));

import { claimForDashboard, serveHandoffs } from "../src/cli/handoff";
import { EXIT, runAdd } from "../src/cli/headless";
import { claimInstance, liveOwner, submitRequest } from "../src/cli/instance";
import { DownloadQueue } from "../src/download/queue";
import { defaultConfig } from "../src/config/config";
import type { Library } from "../src/library/library";

const SONG = "https://soundcloud.com/lumen/velvet-signal";

const emptyLib = {
  has: () => false,
  get: () => undefined,
  all: () => [],
  flushSync: () => {},
} as unknown as Library;

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "soundcli-hand-"));
  enumerateMock.mockImplementation(async (url: string) => {
    const slug = url.split("/").pop()!;
    return { entries: [{ id: slug, title: slug, url }] };
  });
});

afterEach(async () => {
  enumerateMock.mockReset();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("claimForDashboard", () => {
  it("claims the library when nothing else holds it", async () => {
    const claim = await claimForDashboard(dir);
    expect(await liveOwner(dir)).toMatchObject({ kind: "tui" });
    claim!.release();
  });

  it("makes a background add save its queue and step aside", async () => {
    const out: string[] = [];
    const run = runAdd(
      { links: [SONG], all: false, json: true },
      {
        dataDir: dir,
        tickMs: 20,
        out: (line) => out.push(line),
        note: () => {},
        boot: async () => ({
          queue: new DownloadQueue(defaultConfig, emptyLib, 1),
          library: emptyLib,
        }),
      },
    );
    await vi.waitFor(async () =>
      expect(await liveOwner(dir)).toMatchObject({ kind: "headless" }),
    );

    const claim = await claimForDashboard(dir, 2_000);
    // The background run is the one that ended, and it says it can resume.
    expect(await run).toBe(EXIT.tryLater);
    expect(JSON.parse(out.at(-1)!)).toMatchObject({
      event: "done",
      halted: "dashboard opened",
    });
    expect(claim).not.toBeNull();
    expect(await liveOwner(dir)).toMatchObject({ kind: "tui" });
    claim!.release();
  });

  it("leaves another dashboard's claim alone", async () => {
    const first = await claimForDashboard(dir);
    expect(await claimForDashboard(dir)).toBeNull();
    expect(await liveOwner(dir)).toMatchObject({ kind: "tui" });
    first!.release();
  });
});

describe("serveHandoffs", () => {
  it("queues a link another process handed over", async () => {
    const claim = await claimInstance("tui", dir);
    const queue = new DownloadQueue(defaultConfig, emptyLib, 1);
    const tick = serveHandoffs(claim!, queue, dir);

    await tick(); // nothing waiting: a no-op
    expect(queue.getItems()).toEqual([]);

    await submitRequest({ kind: "add", links: [SONG], all: false }, dir);
    await tick();
    expect(queue.getItems()).toHaveLength(1);
    expect(queue.getItems()[0]).toMatchObject({
      source: "soundcloud",
      track: { id: "velvet-signal", owner: "lumen" },
    });
    queue.cancelAll();
    claim!.release();
  });

  it("holds a hand-off while its own lists are still loading", async () => {
    const claim = await claimInstance("tui", dir);
    const queue = new DownloadQueue(defaultConfig, emptyLib, 1);
    const tick = serveHandoffs(claim!, queue, dir);
    await submitRequest({ kind: "add", links: [SONG], all: false }, dir);

    const signal = queue.beginGather(); // the user is mid-add in the dashboard
    await tick();
    expect(queue.getItems()).toEqual([]);

    queue.endGather(signal);
    await tick();
    expect(queue.getItems()).toHaveLength(1);
    queue.cancelAll();
    claim!.release();
  });

  it("drops a yield and a link it cannot route, and keeps its queue", async () => {
    const claim = await claimInstance("tui", dir);
    const queue = new DownloadQueue(defaultConfig, emptyLib, 1);
    const tick = serveHandoffs(claim!, queue, dir);

    await submitRequest({ kind: "yield" }, dir);
    await tick();
    await submitRequest(
      { kind: "add", links: ["https://soundcloud.com/lumen"], all: false },
      dir,
    );
    await tick();
    expect(queue.getItems()).toEqual([]);
    expect(await fs.readdir(path.join(dir, "inbox"))).toEqual([]);
    expect(await liveOwner(dir)).toMatchObject({ kind: "tui" });
    claim!.release();
  });
});
