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
  runSync,
  runUnwatch,
  runWatch,
  type HeadlessDeps,
  type HeadlessEvent,
  type StopSignal,
} from "../src/cli/headless";
import { loadWatches } from "../src/cli/watches";
import { listTarget } from "../src/download/gather";
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
    list: (target) => listTarget(target),
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

describe("--into, watch and sync", () => {
  const UPLOADS = "https://soundcloud.com/vesper/tracks";
  const SINGLE = "https://soundcloud.com/vesper/low-tide";

  /** What the artist has posted so far, as their uploads tab lists it. */
  function uploads(...ids: string[]): void {
    enumerateMock.mockImplementation(async (url: string) => {
      if (url !== UPLOADS) {
        const slug = url.split("/").pop()!;
        return { entries: [{ id: slug, title: slug, url }] };
      }
      return {
        title: "Vesper (Tracks)",
        entries: ids.map((id) => ({
          id,
          title: `Song ${id}`,
          url: `https://soundcloud.com/vesper/song-${id}`,
        })),
      };
    });
  }

  /** A run whose user has this SoundCloud handle configured. */
  const as = (soundcloudHandle?: string): Partial<HeadlessDeps> => ({
    boot: async () => {
      const library = {
        has: () => false,
        get: () => undefined,
        all: () => [],
        upsert: async () => {},
        flushSync: () => {},
      } as unknown as Library;
      queue = new DownloadQueue({ ...defaultConfig, soundcloudHandle }, library, 2);
      return { queue, library };
    },
  });

  const downloaded = () =>
    vi.mocked(downloadTrack).mock.calls.map(([p]) => ({
      url: p.url,
      owner: p.owner,
      folder: p.playlistName,
    }));

  it("saves into a folder of your own collection", async () => {
    downloadsSucceed();
    const code = await runAdd(
      { links: [SINGLE], all: false, json: true, into: "Drops" },
      deps(as("Lumen")),
    );
    expect(code).toBe(EXIT.ok);
    // Yours, not the artist's the link names: a like of the same song later
    // is this same library entry.
    expect(downloaded()).toEqual([{ url: SINGLE, owner: "lumen", folder: "Drops" }]);
  });

  it("uses a plain folder when no handle says whose collection it is", async () => {
    downloadsSucceed();
    await runAdd(
      { links: [SINGLE], all: false, json: true, into: "Drops" },
      deps(as(undefined)),
    );
    expect(downloaded()).toEqual([{ url: SINGLE, owner: undefined, folder: "Drops" }]);
  });

  it("reads an artist's uploads as one list", async () => {
    downloadsSucceed();
    uploads("1", "2");
    const code = await runAdd({ links: [UPLOADS], all: false, json: true }, deps());
    expect(code).toBe(EXIT.ok);
    expect(events()[0]).toEqual({
      event: "link",
      link: UPLOADS,
      tracks: 2,
      new: 2,
      saved: 0,
    });
  });

  it("leaves alone what a link held when it was watched, and takes what came after", async () => {
    uploads("1", "2");
    expect(
      await runWatch({ links: [UPLOADS], all: false, into: "Liked Songs" }, deps()),
    ).toBe(EXIT.ok);
    expect(await loadWatches(dir)).toMatchObject([
      { link: UPLOADS, all: false, into: "Liked Songs", seen: ["1", "2"] },
    ]);

    out = [];
    downloadsSucceed();
    uploads("3", "1", "2");
    const code = await runSync({ json: true }, deps(as("lumen")));

    expect(code).toBe(EXIT.ok);
    expect(events()[0]).toEqual({
      event: "link",
      link: UPLOADS,
      tracks: 1,
      new: 1,
      saved: 0,
    });
    expect(downloaded()).toEqual([
      {
        url: "https://soundcloud.com/vesper/song-3",
        owner: "lumen",
        folder: "Liked Songs",
      },
    ]);
    expect(events().at(-1)).toMatchObject({ event: "done", saved: 1, exit: 0 });
  });

  it("keeps what a watch has seen when it is watched again", async () => {
    uploads("1");
    await runWatch({ links: [UPLOADS], all: false }, deps());
    uploads("1", "2");
    await runWatch({ links: [`${UPLOADS}/`], all: false, into: "Drops" }, deps());

    // Only where it saves changed: song 2 was posted since and still counts.
    expect(await loadWatches(dir)).toMatchObject([
      { link: UPLOADS, into: "Drops", seen: ["1"] },
    ]);
  });

  it("watches nothing when the link can't be read", async () => {
    enumerateMock.mockRejectedValue(new Error("HTTP Error 404: Not Found"));
    const code = await runWatch({ links: [UPLOADS], all: false }, deps());
    expect(code).toBe(EXIT.failed);
    expect(notes.join("\n")).toContain("404");
    expect(await loadWatches(dir)).toEqual([]);
  });

  it("refuses to watch a bad link before reading anything", async () => {
    const code = await runWatch({ links: ["lumen"], all: false }, deps());
    expect(code).toBe(EXIT.usage);
    expect(enumerateMock).not.toHaveBeenCalled();
  });

  it("lists and forgets watches", async () => {
    uploads("1");
    await runWatch({ links: [UPLOADS], all: false, into: "Drops" }, deps());
    out = [];
    expect(await runWatch({ links: [], all: false }, deps())).toBe(EXIT.ok);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain(UPLOADS);
    expect(out[0]).toContain('"Drops"');

    expect(await runUnwatch({ links: [UPLOADS] }, deps())).toBe(EXIT.ok);
    expect(await loadWatches(dir)).toEqual([]);
    // Nothing by that link any more: say so, and say it with the exit code.
    expect(await runUnwatch({ links: [UPLOADS] }, deps())).toBe(EXIT.failed);
  });

  it("syncs to a clean finish when nothing is watched", async () => {
    const code = await runSync({ json: true }, deps());
    expect(code).toBe(EXIT.ok);
    expect(events()).toEqual([
      { event: "done", saved: 0, exists: 0, failed: 0, halted: null, exit: 0 },
    ]);
    expect(notes.join("\n")).toContain("Nothing is watched");
  });

  it("hands a sync to a running soundcli as a sync, not as its links", async () => {
    uploads("1");
    await runWatch({ links: [UPLOADS], all: false }, deps());
    out = [];
    const owner = await claimInstance("tui", dir);
    const reader = setInterval(() => void owner!.touch(), 20);
    const run = runSync({ json: true }, deps({ tickMs: 30 }));
    await vi.waitFor(async () =>
      expect(await fs.readdir(path.join(dir, "inbox"))).toHaveLength(1),
    );
    // The owner reads the watch list itself when it serves the request.
    expect(await takeRequest(dir)).toEqual({ kind: "sync" });
    expect(await run).toBe(EXIT.ok);
    expect(events()[0]).toEqual({ event: "handoff", owner: "tui" });
    clearInterval(reader);
    owner!.release();
  });

  it("serves a sync handed over mid-run from the watch list", async () => {
    uploads("1");
    await runWatch({ links: [UPLOADS], all: false, into: "Drops" }, deps());
    out = [];
    downloadsSucceed();
    uploads("2", "1");
    // A run busy with its own link when another process asks for a sync.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    vi.mocked(downloadTrack).mockImplementation(async (p) => {
      if (p.url === SONG) await held;
      return {
        status: "downloaded",
        meta: { id: p.url.split("/").pop()!, title: "t", artist: "a", filepath: "/f.m4a" },
      };
    });
    const run = runAdd({ links: [SONG], all: false, json: true }, deps());
    await vi.waitFor(() => expect(events().some((e) => e.event === "link")).toBe(true));
    await submitRequest({ kind: "sync" }, dir);
    await vi.waitFor(() =>
      expect(events().filter((e) => e.event === "link")).toHaveLength(2),
    );
    release();

    expect(await run).toBe(EXIT.ok);
    expect(events().filter((e) => e.event === "link")[1]).toMatchObject({
      link: UPLOADS,
      tracks: 1,
    });
    expect(downloaded().map((d) => d.folder)).toContain("Drops");
  });
});

describe("watch, on a link that cannot change", () => {
  it("refuses a single song and points at add", async () => {
    const code = await runWatch({ links: [SONG], all: false }, deps());
    expect(code).toBe(EXIT.usage);
    expect(notes.join("\n")).toContain("sndcli add");
    expect(await loadWatches(dir)).toEqual([]);
  });
});

describe("the word of a run that is stopped or let down", () => {
  it("prints nothing after done, whatever was still in flight", async () => {
    // A link still being read when ctrl-c lands: its line must not follow done.
    let finish: (() => void) | undefined;
    enumerateMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ entries: [{ id: "a", title: "a", url: SONG }] });
        }),
    );
    const run = runAdd({ links: [SONG], all: false, json: true }, deps());
    await vi.waitFor(() => expect(finish).toBeDefined());
    signal("SIGINT");
    expect(await run).toBe(EXIT.interrupted);
    finish!();
    await new Promise((r) => setTimeout(r, 40));
    expect(events().at(-1)).toMatchObject({ event: "done", exit: 130 });
  });

  it("exits 130 when the interrupt that broke setup lands a moment after it", async () => {
    // Ctrl-C reaches the tools soundcli started too, so setup can fail from
    // the very interrupt whose signal has not been heard yet.
    const code = await runAdd(
      { links: [SONG], all: false, json: true },
      deps({
        boot: () =>
          new Promise((_, reject) =>
            setTimeout(() => {
              reject(new Error("Command was killed with SIGINT"));
              setTimeout(() => signal("SIGINT"), 5);
            }, 5),
          ),
      }),
    );
    expect(code).toBe(EXIT.interrupted);
    expect(events().at(-1)).toMatchObject({
      event: "done",
      halted: "interrupted",
      exit: 130,
    });
  });

  it("counts a link that failed without saying why", async () => {
    enumerateMock.mockRejectedValue(new Error(""));
    const code = await runAdd({ links: [SONG], all: false, json: true }, deps());
    expect(code).toBe(EXIT.failed);
    expect((events()[0] as { error?: string }).error).toBeTruthy();
  });

  it("waits for a claim that is still being written instead of giving up", async () => {
    // An owner's create and its write are two steps, and a loaded machine can
    // sit between them: the claim is there and still empty.
    const claim = path.join(dir, "instance.json");
    await fs.writeFile(claim, "");
    setTimeout(
      () =>
        void fs.writeFile(
          claim,
          JSON.stringify({ pid: process.pid, kind: "tui", startedAt: "x" }),
        ),
      60,
    );
    const code = await runAdd({ links: [SONG], all: false, json: true }, deps());
    expect(notes).toEqual([]);
    expect(code).toBe(EXIT.ok);
    expect(events()[0]).toEqual({ event: "handoff", owner: "tui" });
  });
});
