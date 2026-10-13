import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// The network and yt-dlp never run: enumerate answers link lookups, and
// downloadTrack decides how each queued track ends.
const enumerateMock = vi.fn();
vi.mock("../src/ytdlp/ytdlp", () => ({
  downloadTrack: vi.fn(() => new Promise(() => {})),
  enumerate: (...a: unknown[]) => enumerateMock(...a),
}));
vi.mock("../src/util/recover-path", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/util/recover-path")>();
  return { ...orig, findDownloadedFile: async (p: string) => p };
});

import { downloadTrack } from "../src/ytdlp/ytdlp";
import {
  EXIT,
  runAdd,
  type HeadlessDeps,
  type HeadlessEvent,
  type StopSignal,
} from "../src/cli/headless";
import {
  claimInstance,
  liveOwner,
  submitRequest,
  takeRequest,
} from "../src/cli/instance";
import { DownloadQueue } from "../src/download/queue";
import { defaultConfig } from "../src/config/config";
import type { Library } from "../src/library/library";

const SONG = "https://soundcloud.com/lumen/velvet-signal";
const OTHER = "https://soundcloud.com/lumen/night-drive";

let dir: string;
let out: string[];
let notes: string[];
let flushed: number;
/** Delivers a signal to the run in flight, as the OS would. */
let signal: (s: StopSignal) => void;
/** The queue the latest run booted. */
let queue: DownloadQueue;

/** A real queue over an empty in-memory library, with fast inbox ticks. */
function deps(over: Partial<HeadlessDeps> = {}): HeadlessDeps {
  const library = {
    has: () => false,
    get: () => undefined,
    all: () => [],
    upsert: async () => {},
    flushSync: () => {
      flushed++;
    },
  } as unknown as Library;
  return {
    dataDir: dir,
    tickMs: 20,
    out: (line) => out.push(line),
    note: (line) => notes.push(line),
    boot: async () => {
      queue = new DownloadQueue(defaultConfig, library, 2);
      return { queue, library };
    },
    signals: (onSignal) => {
      signal = onSignal;
      return () => {};
    },
    ...over,
  };
}

const events = (): HeadlessEvent[] =>
  out.map((line) => JSON.parse(line) as HeadlessEvent);

/** Every single-song lookup resolves to one track named after its slug. */
function linksResolve(): void {
  enumerateMock.mockImplementation(async (url: string) => {
    const slug = url.split("/").pop()!;
    return {
      entries: [{ id: slug, title: slug, url, uploader: "Circuit Fauna" }],
    };
  });
}

function downloadsSucceed(): void {
  vi.mocked(downloadTrack).mockImplementation(async (params) => ({
    status: "downloaded",
    meta: {
      id: params.url.split("/").pop()!,
      title: "Velvet Signal",
      artist: "Circuit Fauna",
      filepath: "/music/SoundCloud/lumen/Singles/Circuit Fauna - Velvet Signal.m4a",
    },
  }));
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "soundcli-head-"));
  out = [];
  notes = [];
  flushed = 0;
  linksResolve();
});

afterEach(async () => {
  vi.mocked(downloadTrack).mockReset();
  vi.mocked(downloadTrack).mockImplementation(() => new Promise(() => {}));
  enumerateMock.mockReset();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("runAdd", () => {
  it("downloads a song, reports it, and exits 0", async () => {
    downloadsSucceed();
    const code = await runAdd({ links: [SONG], all: false, json: true }, deps());
    expect(code).toBe(EXIT.ok);
    expect(events()).toEqual([
      { event: "link", link: SONG, tracks: 1, new: 1, saved: 0 },
      {
        event: "track",
        status: "saved",
        source: "soundcloud",
        title: "Velvet Signal",
        artist: "Circuit Fauna",
        file: "/music/SoundCloud/lumen/Singles/Circuit Fauna - Velvet Signal.m4a",
      },
      { event: "done", saved: 1, exists: 0, failed: 0, halted: null, exit: 0 },
    ]);
    // The library index is flushed and the claim is gone when it returns.
    expect(flushed).toBe(1);
    expect(await liveOwner(dir)).toBeNull();
  });

  it("counts songs the library already holds, without downloading them", async () => {
    downloadsSucceed();
    const owned = {
      has: (id: string) => id === "soundcloud:lumen:velvet-signal",
      get: () => undefined,
      all: () => [],
      upsert: async () => {},
      flushSync: () => {},
    } as unknown as Library;
    const code = await runAdd(
      { links: [SONG, OTHER], all: false, json: true },
      deps({
        boot: async () => ({
          queue: new DownloadQueue(defaultConfig, owned, 2),
          library: owned,
        }),
      }),
    );
    expect(code).toBe(EXIT.ok);
    expect(events()[0]).toEqual({
      event: "link",
      link: SONG,
      tracks: 1,
      new: 0,
      saved: 1,
    });
    // The link's count and the closing tally agree on what was already there.
    expect(events().at(-1)).toEqual({
      event: "done",
      saved: 1,
      exists: 1,
      failed: 0,
      halted: null,
      exit: 0,
    });
    expect(vi.mocked(downloadTrack)).toHaveBeenCalledTimes(1);
  });

  it("drops the repeated tail yt-dlp adds to a link error", async () => {
    enumerateMock.mockRejectedValue(
      new Error(
        "Unable to download webpage: Failed to resolve (caused by TransportError('Failed to resolve'))",
      ),
    );
    await runAdd({ links: [SONG], all: false, json: true }, deps());
    expect(events()[0]).toMatchObject({
      event: "link",
      error: "Unable to download webpage: Failed to resolve",
    });
  });

  it("prints plain lines without --json", async () => {
    downloadsSucceed();
    await runAdd({ links: [SONG], all: false, json: false }, deps());
    expect(out).toEqual([
      `${SONG}: 1 track, 1 to download, 0 already saved`,
      "saved   Circuit Fauna - Velvet Signal",
      "done: 1 saved, 0 already saved, 0 failed",
    ]);
  });

  it("rejects a bad link before claiming or fetching anything", async () => {
    let booted = false;
    const code = await runAdd(
      { links: [SONG, "https://soundcloud.com/lumen"], all: false, json: true },
      deps({
        boot: async () => {
          booted = true;
          throw new Error("must not boot");
        },
      }),
    );
    expect(code).toBe(EXIT.usage);
    expect(booted).toBe(false);
    expect(out).toEqual([]);
    expect(notes.join("\n")).toMatch(/--all/);
    expect(enumerateMock).not.toHaveBeenCalled();
  });

  it("hands the links to a running soundcli instead of starting beside it", async () => {
    const owner = await claimInstance("tui", dir);
    let booted = false;
    const code = await runAdd(
      { links: [SONG, OTHER], all: true, json: true },
      deps({
        boot: async () => {
          booted = true;
          throw new Error("must not boot");
        },
      }),
    );
    expect(code).toBe(EXIT.ok);
    expect(booted).toBe(false);
    // A script reads `done` as the end of every run, a hand-off included.
    expect(events()).toEqual([
      { event: "handoff", owner: "tui" },
      { event: "done", saved: 0, exists: 0, failed: 0, halted: null, exit: 0 },
    ]);
    expect(await takeRequest(dir)).toEqual({
      kind: "add",
      links: [SONG, OTHER],
      all: true,
    });
    owner!.release();
  });

  it("runs the links itself when the owner leaves before reading them", async () => {
    downloadsSucceed();
    // An owner in its last moments: alive when the links are handed over,
    // gone before its next look at the inbox.
    const owner = await claimInstance("headless", dir);
    const run = runAdd(
      { links: [SONG], all: false, json: true },
      deps({ tickMs: 1_000 }),
    );
    await vi.waitFor(async () =>
      expect(await fs.readdir(path.join(dir, "inbox"))).toHaveLength(1),
    );
    owner!.release();
    expect(await run).toBe(EXIT.ok);
    expect(events().map((e) => e.event)).toEqual(["link", "track", "done"]);
    expect(await fs.readdir(path.join(dir, "inbox"))).toEqual([]);
  });

  it("queues its links ahead of the saved backlog", async () => {
    downloadsSucceed();
    const enqueue = vi.spyOn(DownloadQueue.prototype, "enqueue");
    await runAdd({ links: [SONG], all: false, json: true }, deps());
    expect(enqueue).toHaveBeenCalledWith(expect.any(Array), { front: true });
    enqueue.mockRestore();
  });

  it("leaves a remembered dead track alone and says so on the link line", async () => {
    const d = deps();
    const boot: HeadlessDeps["boot"] = async (note) => {
      const engine = await d.boot(note);
      const dead = { fails: 1, last: Date.now(), error: "This video is DRM protected" };
      engine.queue.restore({
        items: [],
        youtubeStarts: [],
        dead: { "soundcloud:lumen:velvet-signal": dead },
      });
      return engine;
    };
    const cmd = { links: [SONG], all: false, json: true };
    expect(await runAdd(cmd, { ...d, boot })).toBe(EXIT.ok);
    expect(events()).toEqual([
      { event: "link", link: SONG, tracks: 1, new: 0, saved: 0, unavailable: 1 },
      { event: "done", saved: 0, exists: 0, failed: 0, halted: null, exit: 0 },
    ]);
    expect(downloadTrack).not.toHaveBeenCalled();
  });

  it("exits 75 with the reason when the platform stops the queue", async () => {
    vi.mocked(downloadTrack).mockResolvedValue({
      status: "ratelimited",
      reason: "botgate",
    });
    const code = await runAdd({ links: [SONG], all: false, json: true }, deps());
    expect(code).toBe(EXIT.tryLater);
    expect(events().at(-1)).toEqual({
      event: "done",
      saved: 0,
      exists: 0,
      failed: 0,
      halted: "bot gate",
      exit: 75,
    });
    expect(await liveOwner(dir)).toBeNull();
  });

  it("exits 0 when the only failures are dead tracks", async () => {
    vi.mocked(downloadTrack).mockRejectedValue(
      new Error("ERROR: [soundcloud] 900000008: This video is DRM protected"),
    );
    const code = await runAdd({ links: [SONG], all: false, json: true }, deps());
    expect(code).toBe(EXIT.ok);
    expect(events()[1]).toMatchObject({
      event: "track",
      status: "failed",
      reason: "DRM protected",
      permanent: true,
    });
    expect(events().at(-1)).toMatchObject({ failed: 1, exit: 0 });
  });

  it("exits 1 when a failure could still work on another try", async () => {
    vi.mocked(downloadTrack).mockRejectedValue(new Error("connection reset"));
    const code = await runAdd({ links: [SONG], all: false, json: true }, deps());
    expect(code).toBe(EXIT.failed);
    expect(events()[1]).toMatchObject({
      status: "failed",
      reason: "network hiccup",
      permanent: false,
    });
  });

  it("exits 1 and says why when a link cannot be read", async () => {
    enumerateMock.mockRejectedValue(new Error("Unsupported URL"));
    const code = await runAdd({ links: [SONG], all: false, json: true }, deps());
    expect(code).toBe(EXIT.failed);
    expect(events()[0]).toEqual({
      event: "link",
      link: SONG,
      tracks: 0,
      new: 0,
      saved: 0,
      error: "Unsupported URL",
    });
  });

  it("exits 1 and releases the claim when setup fails", async () => {
    const code = await runAdd(
      { links: [SONG], all: false, json: true },
      deps({
        boot: async () => {
          throw new Error("yt-dlp downloaded but won't start");
        },
      }),
    );
    expect(code).toBe(EXIT.failed);
    expect(notes.join("\n")).toMatch(/won't start/);
    expect(events().at(-1)).toMatchObject({ event: "done", exit: 1 });
    expect(await liveOwner(dir)).toBeNull();
  });

  it("steps aside with exit 75 when a dashboard asks for the queue", async () => {
    // The download never finishes, so only the yield can end the run.
    const run = runAdd({ links: [SONG], all: false, json: true }, deps());
    await vi.waitFor(async () => expect(await liveOwner(dir)).not.toBeNull());
    await submitRequest({ kind: "yield" }, dir);
    expect(await run).toBe(EXIT.tryLater);
    expect(events().at(-1)).toMatchObject({
      event: "done",
      halted: "dashboard opened",
      exit: 75,
    });
    expect(await liveOwner(dir)).toBeNull();
  });

  it("takes in links a later add hands over mid-run", async () => {
    // The first song stays in flight until the second has been taken in, so
    // the run cannot settle before the handed-over link arrives.
    let finishFirst!: () => void;
    vi.mocked(downloadTrack).mockImplementation(async (params) => {
      const id = params.url.split("/").pop()!;
      if (id === "velvet-signal") {
        await new Promise<void>((r) => {
          finishFirst = r;
        });
      }
      return {
        status: "downloaded",
        meta: { id, title: id, filepath: `/music/${id}.m4a` },
      };
    });
    const d = deps();
    const first = runAdd({ links: [SONG], all: false, json: true }, d);
    await vi.waitFor(async () => expect(await liveOwner(dir)).not.toBeNull());

    const second = await runAdd({ links: [OTHER], all: false, json: true }, d);
    expect(second).toBe(EXIT.ok);
    await vi.waitFor(() =>
      expect(
        events().some((e) => e.event === "link" && e.link === OTHER),
      ).toBe(true),
    );
    finishFirst();

    expect(await first).toBe(EXIT.ok);
    expect(events().filter((e) => e.event === "handoff")).toEqual([
      { event: "handoff", owner: "headless" },
    ]);
    expect(events().at(-1)).toMatchObject({ event: "done", saved: 2, exit: 0 });
  });

  // A tick that never comes: only the look a run takes as it settles can find
  // a request, which is the moment a real one would be stranded.
  const noTicks = (): HeadlessDeps => deps({ tickMs: 600_000 });

  it("takes in links handed over after its last tick, before letting go", async () => {
    downloadsSucceed();
    await submitRequest({ kind: "add", links: [OTHER], all: false }, dir);
    const code = await runAdd({ links: [SONG], all: false, json: true }, noTicks());
    expect(code).toBe(EXIT.ok);
    expect(events().at(-1)).toMatchObject({ event: "done", saved: 2 });
    expect(await fs.readdir(path.join(dir, "inbox"))).toEqual([]);
  });

  it("finishes cleanly when that last look hits a file error", async () => {
    downloadsSucceed();
    await submitRequest({ kind: "add", links: [OTHER], all: false }, dir);
    const rm = vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("locked"));
    const code = await runAdd({ links: [SONG], all: false, json: true }, noTicks());
    rm.mockRestore();
    expect(code).toBe(EXIT.ok);
    // The request stays for its sender to run.
    expect(await fs.readdir(path.join(dir, "inbox"))).toHaveLength(1);
  });

  it.each([
    ["SIGTERM", EXIT.terminated, "terminated"],
    ["SIGINT", EXIT.interrupted, "interrupted"],
  ] as const)("saves its place and exits on %s", async (name, exit, halted) => {
    // The download never finishes, so only the signal can end the run.
    const run = runAdd({ links: [SONG], all: false, json: true }, deps());
    await vi.waitFor(() => expect(vi.mocked(downloadTrack)).toHaveBeenCalled());
    const suspend = vi.spyOn(queue, "suspend");
    signal(name);
    expect(await run).toBe(exit);
    expect(events().at(-1)).toMatchObject({ event: "done", halted, exit });
    expect(suspend).toHaveBeenCalledWith(true);
    expect(await liveOwner(dir)).toBeNull();
  });

  it("stops without writing when another process has taken the library", async () => {
    const run = runAdd({ links: [SONG], all: false, json: true }, deps());
    await vi.waitFor(() => expect(vi.mocked(downloadTrack)).toHaveBeenCalled());
    const suspend = vi.spyOn(queue, "suspend");
    // After a long freeze this run looked abandoned and was replaced.
    const claim = path.join(dir, "instance.json");
    const rival = JSON.stringify({ pid: 2 ** 30, kind: "tui", startedAt: "" });
    await fs.writeFile(claim, rival);
    expect(await run).toBe(EXIT.tryLater);
    expect(events().at(-1)).toMatchObject({ halted: "another soundcli took over" });
    // The saved queue, the library index and the claim are the new owner's.
    expect(suspend).toHaveBeenCalledWith(false);
    expect(flushed).toBe(0);
    expect(await fs.readFile(claim, "utf8")).toBe(rival);
  });

  it("exits 75 when a later link clears the halt an earlier one caused", async () => {
    // The first song is refused. The second is only queued after that, which
    // resets the queue's halt flag while the first row stays on hold.
    vi.mocked(downloadTrack).mockImplementation(async (params) =>
      params.url.endsWith("velvet-signal")
        ? { status: "ratelimited", reason: "botgate" }
        : { status: "downloaded", meta: { id: "n", title: "n", filepath: "/n" } },
    );
    enumerateMock.mockImplementation(async (url: string) => {
      const slug = url.split("/").pop()!;
      if (slug === "night-drive") {
        await vi.waitFor(() => expect(queue.stats().rateLimited).toBe(true));
      }
      return { entries: [{ id: slug, title: slug, url }] };
    });
    const code = await runAdd(
      { links: [SONG, OTHER], all: false, json: true },
      deps(),
    );
    expect(code).toBe(EXIT.tryLater);
    expect(events().at(-1)).toMatchObject({ saved: 1, halted: "bot gate" });
  });
});
