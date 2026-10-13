import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// Run per-track retry backoffs with zero delay so timing assertions stay fast.
// Most cases enqueue YouTube tracks, so the pacing gap is zeroed too; the
// pacing suite sets its own.
beforeAll(() => {
  process.env.SOUNDCLI_RETRY_BASE_MS = "0";
  process.env.SOUNDCLI_BLOCKED_SCALE = "0";
  process.env.SOUNDCLI_YT_GAP_MS = "0";
});

// Keep downloads from actually running: a never-resolving stub leaves items
// "downloading" so we can assert enqueue's dedupe accounting.
vi.mock("../src/ytdlp/ytdlp", () => ({
  downloadTrack: vi.fn(() => new Promise(() => {})),
  enumerate: vi.fn(async () => ({ entries: [] })),
}));

// Control Spotify lazy URL resolution so we can assert the resolved URL is
// used and the ytsearch1 fallback tags the item as an unverified match.
const resolveMock = vi.fn(async () => null as string | null);
vi.mock("../src/sources/spotify/resolve", () => ({
  resolveSpotifyDownloadUrl: (...args: unknown[]) => resolveMock(...args),
}));

const findDownloadedFileMock = vi.fn(async (p: string) => p as string | undefined);
vi.mock("../src/util/recover-path", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/util/recover-path")>();
  return {
    ...orig,
    findDownloadedFile: (p: string) => findDownloadedFileMock(p),
  };
});

import { downloadTrack, enumerate } from "../src/ytdlp/ytdlp";
import {
  blockedBackoffMs,
  deadWaitMs,
  DownloadQueue,
  isPermanentTrackError,
  SOURCE_BLOCKING,
  TOO_MANY_FAILURES,
  WAITING_FOR_TOOLS,
} from "../src/download/queue";
import { defaultConfig } from "../src/config/config";
import type { Library } from "../src/library/library";
import type { SourceId } from "../src/library/types";
import type { DownloadProgress } from "../src/ytdlp/progress";

function input(source: SourceId, id: string, title = id, artist?: string) {
  return {
    source,
    sourceLabel: source,
    track: { id, title, artist, downloadUrl: "x" },
  };
}

// The id doubles as the download URL, so a mock can fail one track by name.
function byUrl(id: string, source: SourceId = "youtube") {
  return { ...input(source, id), track: { id, title: id, downloadUrl: id } };
}

function spotifyInput(id: string) {
  return {
    source: "spotify" as SourceId,
    sourceLabel: "Spotify",
    track: {
      id,
      title: "Velvet Signal",
      artist: "Circuit Fauna",
      downloadUrl: "ytsearch1:Circuit Fauna Velvet Signal",
    },
  };
}

// Library that reports one track as already saved and is otherwise empty.
const fakeLib = {
  has: (id: string) => id === "youtube:already",
  get: () => undefined,
  all: () => [],
} as unknown as Library;

// Poll for a file the queue worker writes asynchronously instead of racing a
// fixed sleep: slow CI runners can take well over 60ms to finish the copy.
async function readFileEventually(
  file: string,
  encoding: BufferEncoding = "utf8",
  timeoutMs = 2000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await fs.readFile(file, encoding);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      if (Date.now() >= deadline) throw err;
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

describe("download queue dedupe", () => {
  it("skips library duplicates and in-batch duplicates", () => {
    const q = new DownloadQueue(defaultConfig, fakeLib, 1);
    const r = q.enqueue([
      input("youtube", "already"), // in library → skip
      input("youtube", "a"), // new
      input("youtube", "a"), // dup id → skip
      input("soundcloud", "b"), // distinct song → new
    ]);
    expect(r.added).toBe(2);
    expect(r.skipped).toBe(2);
    expect(r.total).toBe(4);
    expect(r.alreadySaved).toBe(1);
    expect(r.newTracks).toBe(2);
    expect(q.stats().inputTotal).toBe(4);
    expect(q.stats().alreadySaved).toBe(1);
    expect(q.stats().newTracks).toBe(2);
  });

  it("skips tracks already in the queue on a later enqueue", () => {
    const q = new DownloadQueue(defaultConfig, fakeLib);
    q.enqueue([input("youtube", "b")]);
    const r = q.enqueue([input("youtube", "b")]);
    expect(r.added).toBe(0);
    expect(r.skipped).toBe(1);
  });

  it("skips the same song from a different source (never two copies)", () => {
    const q = new DownloadQueue(defaultConfig, fakeLib, 1);
    const r = q.enqueue([
      input("youtube", "yt1", "Ember", "Lumen"),
      input("soundcloud", "sc1", "Ember", "Lumen"), // same song → skip
    ]);
    expect(r.added).toBe(1);
    expect(r.skipped).toBe(1);
  });

  it("downloads the same song under two owners twice", () => {
    const q = new DownloadQueue(defaultConfig, fakeLib, 1);
    const a = input("youtube", "yt1", "Song", "Artist");
    a.track.owner = "owner1";
    const b = input("youtube", "yt1", "Song", "Artist");
    b.track.owner = "owner2";
    const r = q.enqueue([a, b]);
    expect(r.added).toBe(2);
    expect(r.skipped).toBe(0);
  });

  it("dedupes same owner likes and set within the same batch", () => {
    const q = new DownloadQueue(defaultConfig, fakeLib, 1);
    const a = input("youtube", "yt1", "Song", "Artist");
    a.track.owner = "owner1";
    a.track.playlistTitle = "Liked Songs";
    const b = input("youtube", "yt1", "Song", "Artist");
    b.track.owner = "owner1";
    b.track.playlistTitle = "Set";
    const r = q.enqueue([a, b]);
    expect(r.added).toBe(1);
    expect(r.skipped).toBe(1);
  });

  it("leaves a track alone once its copy is in the requested folder", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "soundcli-q-"));
    const owned = path.join(root, "SoundCloud", "owner1");
    const existing = {
      id: "soundcloud:owner1:sc1",
      source: "soundcloud" as SourceId,
      sourceTrackId: "sc1",
      title: "Song",
      artist: "Artist",
      filePath: path.join(owned, "Liked Songs", "Artist - Song.m4a"),
      playlist: "Liked Songs",
      owner: "owner1",
      addedAt: new Date().toISOString(),
    };
    const copyPath = path.join(owned, "Set A", "Artist - Song.m4a");
    const copy = {
      ...existing,
      id: `local:${path.relative(root, copyPath)}`,
      source: "local" as SourceId,
      filePath: copyPath,
      playlist: "Set A",
      playlistPos: 4,
    };
    const byId = new Map<string, object>([
      [existing.id, existing],
      [copy.id, copy],
    ]);
    const upsertMany = vi.fn(async () => {});
    const lib = {
      has: (id: string) => byId.has(id),
      get: (id: string) => byId.get(id),
      all: () => [...byId.values()],
      upsertMany,
    } as unknown as Library;
    const q = new DownloadQueue({ ...defaultConfig, libraryDir: root }, lib, 1);
    const r = q.enqueue([
      {
        source: "soundcloud",
        sourceLabel: "SoundCloud",
        track: {
          id: "sc1",
          title: "Song",
          artist: "Artist",
          downloadUrl: "https://soundcloud.com/artist/song",
          owner: "owner1",
          playlistTitle: "Set A",
          position: 7,
        },
      },
    ]);
    // A re-sync used to queue it again, copy nothing, and report it saved.
    expect(r.added).toBe(0);
    expect(r.alreadySaved).toBe(1);
    // The copy still follows the feed's order.
    expect(upsertMany).toHaveBeenCalledWith([{ ...copy, playlistPos: 7 }]);
  });

  it("copies an already-downloaded track into a requested playlist folder", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "soundcli-q-"));
    const liked = path.join(root, "SoundCloud", "owner1", "Liked Songs");
    const src = path.join(liked, "Artist - Song.m4a");
    await fs.mkdir(liked, { recursive: true });
    await fs.writeFile(src, "audio");

    const existing = {
      id: "soundcloud:owner1:sc1",
      source: "soundcloud" as SourceId,
      sourceTrackId: "sc1",
      title: "Song",
      artist: "Artist",
      durationSec: 99,
      filePath: src,
      playlist: "Liked Songs",
      owner: "owner1",
      addedAt: new Date().toISOString(),
    };
    const upsert = vi.fn(async () => {});
    const lib = {
      has: (id: string) => id === existing.id,
      get: (id: string) => (id === existing.id ? existing : undefined),
      all: () => [existing],
      upsert,
    } as unknown as Library;
    const q = new DownloadQueue({ ...defaultConfig, libraryDir: root }, lib, 1);
    vi.mocked(downloadTrack).mockClear();
    // The set feed offers only a bare-id stub for this track: the copy's
    // metadata must come from the existing entry, never the stub.
    const r = q.enqueue([
      {
        source: "soundcloud",
        sourceLabel: "SoundCloud",
        track: {
          id: "sc1",
          title: "900000005",
          downloadUrl: "https://api-v2.soundcloud.com/tracks/900000005",
          owner: "owner1",
          playlistTitle: "Set A",
          position: 4,
        },
      },
    ]);
    expect(r.added).toBe(1);
    expect(r.skipped).toBe(0);
    expect(r.alreadySaved).toBe(1);
    expect(r.newTracks).toBe(0);
    expect(q.stats().inputTotal).toBe(1);
    expect(q.stats().alreadySaved).toBe(1);
    expect(q.stats().newTracks).toBe(0);
    await new Promise((res) => setTimeout(res, 60));

    const copied = path.join(root, "SoundCloud", "owner1", "Set A", "Artist - Song.m4a");
    await expect(readFileEventually(copied)).resolves.toBe("audio");
    expect(vi.mocked(downloadTrack)).not.toHaveBeenCalled();
    // The copy is indexed immediately as the "local" entry reconcile's
    // adoption would mint, but with the track's real metadata.
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: `local:${path.relative(root, copied)}`,
        source: "local",
        title: "Song",
        artist: "Artist",
        durationSec: 99,
        filePath: copied,
        playlist: "Set A",
        playlistPos: 4,
        owner: "owner1",
      }),
    );
    // The original keeps its own playlist's position: only the copy is stamped.
    expect(upsert).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: existing.id }),
    );
    expect(q.getItems().length).toBe(0);
    expect(q.stats().done).toBe(1);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("heals a bare id title on a redownload attempt", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "soundcli-q-"));
    const setDir = path.join(root, "SoundCloud", "owner1", "Set A");
    const src = path.join(setDir, "900000006.m4a");
    await fs.mkdir(setDir, { recursive: true });
    await fs.writeFile(src, "audio");

    const existing = {
      id: "soundcloud:owner1:900000006",
      source: "soundcloud" as SourceId,
      sourceTrackId: "900000006",
      title: "900000006",
      filePath: src,
      playlist: "Set A",
      owner: "owner1",
      addedAt: new Date().toISOString(),
    };
    const upsert = vi.fn(async () => {});
    const lib = {
      has: (id: string) => id === existing.id,
      get: (id: string) => (id === existing.id ? existing : undefined),
      all: () => [existing],
      upsert,
      upsertMany: vi.fn(async () => {}),
    } as unknown as Library;
    vi.mocked(enumerate).mockResolvedValue({
      entries: [
        {
          id: "900000006",
          title: "healed demo song",
          url: "https://soundcloud.com/demoartist/demo-track-one",
          uploader: "demo artist name",
        },
      ],
    });
    const q = new DownloadQueue({ ...defaultConfig, libraryDir: root }, lib, 1);
    vi.mocked(downloadTrack).mockClear();
    const r = q.enqueue([
      {
        source: "soundcloud",
        sourceLabel: "SoundCloud",
        track: {
          id: "900000006",
          title: "900000006",
          downloadUrl: "https://api-v2.soundcloud.com/tracks/900000006",
          owner: "owner1",
          playlistTitle: "Set A",
        },
      },
    ]);
    expect(r.added).toBe(1);
    await new Promise((res) => setTimeout(res, 60));

    // File and entry both carry the real name, in the layout's stem shape.
    const healed = path.join(setDir, "demo artist name - healed demo song.m4a");
    await expect(readFileEventually(healed)).resolves.toBe("audio");
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: existing.id,
        title: "healed demo song",
        artist: "demo artist name",
        filePath: healed,
      }),
    );
    expect(vi.mocked(downloadTrack)).not.toHaveBeenCalled();
    expect(q.stats().done).toBe(1);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("heals an empty title from the enqueued track without probing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "soundcli-q-"));
    const setDir = path.join(root, "SoundCloud", "owner1", "Set A");
    const src = path.join(setDir, "900000007.m4a");
    await fs.mkdir(setDir, { recursive: true });
    await fs.writeFile(src, "audio");

    const existing = {
      id: "soundcloud:owner1:900000007",
      source: "soundcloud" as SourceId,
      sourceTrackId: "900000007",
      title: "",
      filePath: src,
      playlist: "Set A",
      owner: "owner1",
      addedAt: new Date().toISOString(),
    };
    const upsert = vi.fn(async () => {});
    const lib = {
      has: (id: string) => id === existing.id,
      get: (id: string) => (id === existing.id ? existing : undefined),
      all: () => [existing],
      upsert,
      upsertMany: vi.fn(async () => {}),
    } as unknown as Library;
    vi.mocked(enumerate).mockClear();
    const q = new DownloadQueue({ ...defaultConfig, libraryDir: root }, lib, 1);
    q.enqueue([
      {
        source: "soundcloud",
        sourceLabel: "SoundCloud",
        track: {
          id: "900000007",
          title: "demo track two",
          artist: "demo artist name",
          downloadUrl: "https://soundcloud.com/demoartist/demo-track-two",
          owner: "owner1",
          playlistTitle: "Set A",
        },
      },
    ]);
    await new Promise((res) => setTimeout(res, 60));

    // The enqueued entry already knew the real name: no metadata probe.
    expect(vi.mocked(enumerate)).not.toHaveBeenCalled();
    const healed = path.join(setDir, "demo artist name - demo track two.m4a");
    await expect(readFileEventually(healed)).resolves.toBe("audio");
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: existing.id,
        title: "demo track two",
        artist: "demo artist name",
        filePath: healed,
      }),
    );
    await fs.rm(root, { recursive: true, force: true });
  });

  it("still skips owned in-folder tracks with real titles at enqueue", () => {
    const root = path.join(os.tmpdir(), "soundcli-fake-root");
    const existing = {
      id: "soundcloud:owner1:sc9",
      source: "soundcloud" as SourceId,
      sourceTrackId: "sc9",
      title: "Song",
      artist: "Artist",
      filePath: path.join(root, "SoundCloud", "owner1", "Set A", "Artist - Song.m4a"),
      playlist: "Set A",
      owner: "owner1",
      addedAt: new Date().toISOString(),
    };
    const lib = {
      has: (id: string) => id === existing.id,
      get: (id: string) => (id === existing.id ? existing : undefined),
      all: () => [existing],
    } as unknown as Library;
    const q = new DownloadQueue({ ...defaultConfig, libraryDir: root }, lib, 1);
    const r = q.enqueue([
      {
        source: "soundcloud",
        sourceLabel: "SoundCloud",
        track: {
          id: "sc9",
          title: "Song",
          artist: "Artist",
          downloadUrl: "https://soundcloud.com/a/song",
          owner: "owner1",
          playlistTitle: "Set A",
        },
      },
    ]);
    expect(r.added).toBe(0);
    expect(r.skipped).toBe(1);
    expect(r.alreadySaved).toBe(1);
  });

  it("re-stamps a stale playlist position on an in-folder skip", () => {
    const root = path.join(os.tmpdir(), "soundcli-fake-root");
    const existing = {
      id: "soundcloud:owner1:sc9",
      source: "soundcloud" as SourceId,
      sourceTrackId: "sc9",
      title: "Song",
      artist: "Artist",
      filePath: path.join(root, "SoundCloud", "owner1", "Set A", "Artist - Song.m4a"),
      playlist: "Set A",
      playlistPos: 7,
      owner: "owner1",
      addedAt: new Date().toISOString(),
    };
    const upsertMany = vi.fn(async () => {});
    const lib = {
      has: (id: string) => id === existing.id,
      get: (id: string) => (id === existing.id ? existing : undefined),
      all: () => [existing],
      upsertMany,
    } as unknown as Library;
    const q = new DownloadQueue({ ...defaultConfig, libraryDir: root }, lib, 1);
    const r = q.enqueue([
      {
        source: "soundcloud",
        sourceLabel: "SoundCloud",
        track: {
          id: "sc9",
          title: "Song",
          artist: "Artist",
          downloadUrl: "https://soundcloud.com/a/song",
          owner: "owner1",
          playlistTitle: "Set A",
          position: 2,
        },
      },
    ]);
    // Still a pure metadata heal: nothing enters the queue.
    expect(r.added).toBe(0);
    expect(r.skipped).toBe(1);
    expect(upsertMany).toHaveBeenCalledWith([
      expect.objectContaining({ id: existing.id, playlistPos: 2 }),
    ]);
  });

  it("leaves the library alone when the in-folder position already matches", () => {
    const root = path.join(os.tmpdir(), "soundcli-fake-root");
    const existing = {
      id: "soundcloud:owner1:sc9",
      source: "soundcloud" as SourceId,
      sourceTrackId: "sc9",
      title: "Song",
      artist: "Artist",
      filePath: path.join(root, "SoundCloud", "owner1", "Set A", "Artist - Song.m4a"),
      playlist: "Set A",
      playlistPos: 2,
      owner: "owner1",
      addedAt: new Date().toISOString(),
    };
    const upsertMany = vi.fn(async () => {});
    const lib = {
      has: (id: string) => id === existing.id,
      get: (id: string) => (id === existing.id ? existing : undefined),
      all: () => [existing],
      upsertMany,
    } as unknown as Library;
    const q = new DownloadQueue({ ...defaultConfig, libraryDir: root }, lib, 1);
    q.enqueue([
      {
        source: "soundcloud",
        sourceLabel: "SoundCloud",
        track: {
          id: "sc9",
          title: "Song",
          artist: "Artist",
          downloadUrl: "https://soundcloud.com/a/song",
          owner: "owner1",
          playlistTitle: "Set A",
          position: 2,
        },
      },
    ]);
    expect(upsertMany).not.toHaveBeenCalled();
  });
});

describe("download queue pause/resume", () => {
  // concurrency 1: first item downloads (mock hangs), the rest stay pending.
  function setup() {
    const q = new DownloadQueue(defaultConfig, fakeLib, 1);
    q.enqueue([input("youtube", "a"), input("youtube", "b"), input("youtube", "c")]);
    return q;
  }

  it("pauses and resumes a pending item", () => {
    const q = setup();
    const b = q.getItems().find((i) => i.track.id === "b")!;
    expect(b.status).toBe("pending");
    q.pause(b.id);
    expect(q.getItems().find((i) => i.id === b.id)!.status).toBe("paused");
    expect(q.stats().paused).toBe(1);
    q.resume(b.id);
    expect(q.getItems().find((i) => i.id === b.id)!.status).toBe("pending");
  });

  it("pauseAll holds the queued items", () => {
    const q = setup();
    q.pauseAll();
    // b and c (pending) become paused; a (downloading) is left to its abort.
    expect(q.stats().paused).toBe(2);
    q.resumeAll();
    expect(q.stats().paused).toBe(0);
  });

  it("paused items are excluded from activeCount and survive clearFinished", () => {
    const q = setup();
    const b = q.getItems().find((i) => i.track.id === "b")!;
    q.pause(b.id);
    expect(q.activeCount).toBe(2); // a downloading + c pending (not the paused b)
    q.clearFinished();
    expect(q.getItems().some((i) => i.id === b.id)).toBe(true);
  });

  it("never counts canceled tracks toward the bar", () => {
    // A stopped batch used to show a full bar: canceled counted as finished,
    // so cancelling everything read as 100% done.
    const q = setup();
    q.cancelAll();
    const s = q.stats();
    expect(s.canceled).toBe(2);
    expect(s.overallPercent).toBe(0);
  });

  it("stays gathering until the listing ends or is canceled", () => {
    // Between two playlists nothing may be in flight; that is not the batch
    // ending, so the screen needs to know more tracks can still land.
    const q = new DownloadQueue(defaultConfig, fakeLib, 1);
    const stale = q.beginGather();
    expect(q.stats().gathering).toBe(true);
    q.endGather(stale);
    expect(q.stats().gathering).toBe(false);

    // A finished older gather can't end a newer one; a cancel can.
    q.beginGather();
    q.endGather(stale);
    expect(q.stats().gathering).toBe(true);
    q.cancelAll();
    expect(q.stats().gathering).toBe(false);
  });

  it("tracks overlapping gathers and cancels them together", () => {
    // A hand-off and the user's own add can be listing at the same time.
    const q = new DownloadQueue(defaultConfig, fakeLib, 1);
    const first = q.beginGather();
    q.endGather(q.beginGather());
    expect(q.stats().gathering).toBe(true);
    q.cancelAll();
    expect(first.aborted).toBe(true);
    expect(q.stats().gathering).toBe(false);
  });

  it("puts front rows ahead of what is waiting, in the order they came", () => {
    const q = new DownloadQueue(defaultConfig, fakeLib, 1);
    // "a" starts at once; "b" and "c" are the backlog behind it.
    q.enqueue([byUrl("a"), byUrl("b"), byUrl("c")]);
    q.enqueue([byUrl("x"), byUrl("y")], { front: true });
    q.enqueue([byUrl("z")], { front: true });
    expect(q.getItems().map((i) => i.track.id).join("")).toBe("axyzbc");
    q.cancelAll();
  });
});

describe("download queue rate limiting", () => {
  afterEach(() => {
    vi.mocked(downloadTrack).mockReset();
    vi.mocked(downloadTrack).mockImplementation(() => new Promise(() => {}));
  });

  it("auto-pauses the whole queue when a download is rate-limited", async () => {
    vi.mocked(downloadTrack).mockResolvedValue({ status: "ratelimited" });
    const q = new DownloadQueue(defaultConfig, fakeLib, 2);
    q.enqueue([input("youtube", "a"), input("youtube", "b"), input("youtube", "c")]);
    await new Promise((r) => setTimeout(r, 30));

    const st = q.stats();
    expect(st.rateLimited).toBe(true);
    expect(st.downloading).toBe(0);
    expect(st.pending).toBe(0);
    expect(st.paused).toBeGreaterThan(0);

    q.resumeAll(); // user signals ready → banner clears (synchronously)
    expect(q.stats().rateLimited).toBe(false);
  });

  it("retryFailed re-attempts errored items", async () => {
    vi.mocked(downloadTrack).mockRejectedValue(new Error("boom"));
    const q = new DownloadQueue(defaultConfig, fakeLib, 1);
    q.enqueue([input("youtube", "a")]);
    await new Promise((r) => setTimeout(r, 60));
    expect(q.getItems()[0]!.status).toBe("error");

    q.retryFailed();
    await new Promise((r) => setTimeout(r, 60));
    expect(vi.mocked(downloadTrack).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("retries only the failures that could still work", async () => {
    // A DRM track fails identically on every try this session, so offering it
    // to f Retry only promised something that could never happen.
    const calls: string[] = [];
    vi.mocked(downloadTrack).mockImplementation(async (params) => {
      calls.push(params.url);
      if (params.url === "b")
        throw new Error("ERROR: [soundcloud] 900000008: This video is DRM protected");
      throw new Error("boom");
    });
    const q = new DownloadQueue(defaultConfig, fakeLib, 1);
    q.enqueue(["a", "b"].map((id) => byUrl(id)));
    await new Promise((r) => setTimeout(r, 60));
    expect(q.stats().failed).toBe(2);
    expect(q.stats().retryable).toBe(1);

    q.retryFailed();
    expect(q.getItems().find((i) => i.track.id === "b")!.status).toBe("error");
    await new Promise((r) => setTimeout(r, 60));
    // a: three attempts, then three more after the retry; b: its one attempt.
    expect(calls.filter((u) => u === "a").length).toBe(6);
    expect(calls.filter((u) => u === "b").length).toBe(1);
  });
});

describe("download queue YouTube pacing", () => {
  const started = (): string[] =>
    vi.mocked(downloadTrack).mock.calls.map((c) => c[0].url);

  // Every download lands at once, so only the pacing decides what starts.
  function finishInstantly(): void {
    vi.mocked(downloadTrack).mockImplementation(async (params) => ({
      status: "downloaded",
      meta: { id: params.url, title: params.url, filepath: `/x/${params.url}` },
    }));
  }

  const emptyLib = (): Library =>
    ({
      has: () => false,
      all: () => [],
      upsert: vi.fn(async () => {}),
    }) as unknown as Library;

  afterEach(() => {
    vi.mocked(downloadTrack).mockReset();
    vi.mocked(downloadTrack).mockImplementation(() => new Promise(() => {}));
    process.env.SOUNDCLI_YT_GAP_MS = "0";
    delete process.env.SOUNDCLI_YT_BURST;
  });

  // These wait on outcomes instead of sleeping a fixed time, and "must not
  // have started" is only ever asserted against a minute-long gap: a slow CI
  // runner can stretch a wait, and a short one would let the next row through.
  it("lets the burst through, then holds the rest", async () => {
    process.env.SOUNDCLI_YT_BURST = "2";
    process.env.SOUNDCLI_YT_GAP_MS = "60000";
    finishInstantly();
    const q = new DownloadQueue(defaultConfig, emptyLib(), 3);
    q.enqueue(["a", "b", "c", "d"].map((id) => byUrl(id)));
    await vi.waitFor(() => expect(q.stats().done).toBe(2));
    expect(started()).toEqual(["a", "b"]);
    expect(q.stats().pacing).toBe(true);
    q.cancelAll(); // drops the pacing timer so nothing outlives the test
  });

  it("releases one start per gap once the burst is spent", async () => {
    process.env.SOUNDCLI_YT_BURST = "2";
    process.env.SOUNDCLI_YT_GAP_MS = "100";
    const at: number[] = [];
    vi.mocked(downloadTrack).mockImplementation(async (params) => {
      at.push(Date.now());
      return {
        status: "downloaded",
        meta: { id: params.url, title: params.url, filepath: `/x/${params.url}` },
      };
    });
    const q = new DownloadQueue(defaultConfig, emptyLib(), 3);
    q.enqueue(["a", "b", "c", "d"].map((id) => byUrl(id)));
    await vi.waitFor(() => expect(q.stats().done).toBe(4), { timeout: 5000 });
    expect(started()).toEqual(["a", "b", "c", "d"]);
    // Lower bounds only: a slow runner can stretch a gap, never shrink it.
    expect(at[2]! - at[1]!).toBeGreaterThanOrEqual(90);
    expect(at[3]! - at[2]!).toBeGreaterThanOrEqual(90);
    expect(q.stats().pacing).toBe(false);
  });

  it("keeps other sources moving while YouTube waits", async () => {
    process.env.SOUNDCLI_YT_BURST = "1";
    process.env.SOUNDCLI_YT_GAP_MS = "60000";
    finishInstantly();
    const q = new DownloadQueue(defaultConfig, emptyLib(), 3);
    q.enqueue([
      byUrl("y1"),
      byUrl("y2"),
      byUrl("s1", "soundcloud"),
      byUrl("s2", "soundcloud"),
    ]);
    await vi.waitFor(() => expect(q.stats().done).toBe(3));
    expect(started().sort()).toEqual(["s1", "s2", "y1"]);
    q.cancelAll();
    expect(q.stats().pacing).toBe(false);
  });

  it("never promises a finish sooner than the pacing allows", async () => {
    process.env.SOUNDCLI_YT_BURST = "2";
    process.env.SOUNDCLI_YT_GAP_MS = "60000";
    finishInstantly();
    const q = new DownloadQueue(defaultConfig, emptyLib(), 3);
    q.enqueue(["a", "b", "c", "d", "e"].map((id) => byUrl(id)));
    await vi.waitFor(() => expect(q.stats().done).toBe(2));
    // Two rode the burst and finished in milliseconds, which on its own
    // would extrapolate to "done in a moment" for the three still waiting a
    // minute each.
    expect(started()).toEqual(["a", "b"]);
    expect(q.stats().etaSeconds).toBe(180);
    // Other sources are not paced, so they add nothing to the floor.
    q.enqueue([byUrl("s1", "soundcloud")]);
    await vi.waitFor(() => expect(q.stats().done).toBe(3));
    expect(q.stats().etaSeconds).toBe(180);
    q.cancelAll();
  });

  it("counts Spotify against the YouTube budget", async () => {
    process.env.SOUNDCLI_YT_BURST = "1";
    process.env.SOUNDCLI_YT_GAP_MS = "60000";
    finishInstantly();
    const q = new DownloadQueue(defaultConfig, emptyLib(), 3);
    q.enqueue([byUrl("y1"), byUrl("sp1", "spotify")]);
    await vi.waitFor(() => expect(q.stats().done).toBe(1));
    expect(started()).toEqual(["y1"]);
    q.cancelAll();
  });

  it("never spends budget on a track that is already saved", async () => {
    process.env.SOUNDCLI_YT_BURST = "1";
    process.env.SOUNDCLI_YT_GAP_MS = "60000";
    finishInstantly();
    // "old" is owned but under a bare id title, so it is queued to heal its
    // name: a local-only job that must neither wait nor use up the burst.
    const lib = {
      has: (id: string) => id === "youtube:old",
      get: (id: string) =>
        id === "youtube:old"
          ? { id, source: "youtube", title: "900000001", filePath: "/x/old" }
          : undefined,
      all: () => [],
      upsert: vi.fn(async () => {}),
    } as unknown as Library;
    const q = new DownloadQueue(defaultConfig, lib, 3);
    q.enqueue([byUrl("old"), byUrl("y1")]);
    await vi.waitFor(() => expect(q.stats().finished).toBe(2));
    expect(started()).toEqual(["y1"]);
    expect(q.stats().pacing).toBe(false);
  });

  it("carries the spent budget over from the saved queue", async () => {
    // Every `sndcli add` and every relaunch is a new process. Counted from
    // zero each time, a script adding songs one by one would never be paced.
    process.env.SOUNDCLI_YT_BURST = "2";
    process.env.SOUNDCLI_YT_GAP_MS = "60000";
    finishInstantly();
    const now = Date.now();
    const spent = new DownloadQueue(defaultConfig, emptyLib(), 3);
    spent.restore({ items: [], youtubeStarts: [now - 2_000, now - 1_000] });
    spent.enqueue([byUrl("a")]);
    // pump() decides inside enqueue, so the hold shows straight away.
    expect(spent.stats()).toMatchObject({ pending: 1, pacing: true });
    spent.cancelAll();

    // A start the hour no longer counts, or one stamped ahead of the clock
    // (which would never age out), is dropped.
    const fresh = new DownloadQueue(defaultConfig, emptyLib(), 3);
    fresh.restore({ items: [], youtubeStarts: [now - 7.2e6, now + 3.6e6] });
    fresh.enqueue([byUrl("b"), byUrl("c")]);
    await vi.waitFor(() => expect(fresh.stats().done).toBe(2));
  });

  it("falls back to the defaults when an override is not a number", async () => {
    // A NaN gap is neither "start now" nor "wait": rows would sit forever.
    process.env.SOUNDCLI_YT_BURST = "lots";
    process.env.SOUNDCLI_YT_GAP_MS = "soon";
    finishInstantly();
    const q = new DownloadQueue(defaultConfig, emptyLib(), 3);
    q.enqueue([byUrl("a"), byUrl("b")]);
    await vi.waitFor(() => expect(q.stats().done).toBe(2));
  });
});

describe("download queue dead tracks", () => {
  const DAY = 86_400_000;
  const drm = "ERROR: [soundcloud] 900000008: This video is DRM protected";
  const lib = (): Library =>
    ({ has: () => false, all: () => [], upsert: async () => {} }) as unknown as Library;
  /** A saved queue that remembers "a" failing for good `daysAgo` days back. */
  const remembering = (daysAgo: number) => ({
    items: [],
    youtubeStarts: [],
    dead: { "youtube:a": { fails: 1, last: Date.now() - daysAgo * DAY, error: drm } },
  });

  afterEach(() => {
    vi.mocked(downloadTrack).mockReset();
    vi.mocked(downloadTrack).mockImplementation(() => new Promise(() => {}));
  });

  it("waits a day, doubling: a month at most for a named reason, three days for a bare miss", () => {
    const days = (fails: number, error = drm): number =>
      deadWaitMs({ fails, last: 0, error }) / DAY;
    expect([1, 2, 3, 9].map((n) => days(n))).toEqual([1, 2, 4, 30]);
    expect(days(9, "HTTP Error 404: Not Found")).toBe(3);
  });

  it("leaves a remembered track alone until F asks for it", async () => {
    const q = new DownloadQueue(defaultConfig, lib(), 1);
    q.restore(remembering(0));
    expect(q.enqueue([byUrl("a")])).toMatchObject({ added: 0, unavailable: 1 });
    expect(q.getItems()[0]).toMatchObject({ status: "error", remembered: true });
    // Listed again in the same batch, it gets no second row.
    expect(q.enqueue([byUrl("a")])).toMatchObject({ unavailable: 0, skipped: 1 });

    q.retryFailed();
    expect(downloadTrack).not.toHaveBeenCalled();
    q.retryFailed(true);
    await vi.waitFor(() => expect(downloadTrack).toHaveBeenCalledTimes(1));
    q.cancelAll();
  });

  it("tries it again once the wait is up, and a success forgets it", async () => {
    vi.mocked(downloadTrack).mockRejectedValue(new Error(drm));
    const q = new DownloadQueue(defaultConfig, lib(), 1);
    q.restore(remembering(2));
    expect(q.enqueue([byUrl("a")])).toMatchObject({ added: 1, unavailable: 0 });
    await vi.waitFor(() => expect(q.stats().failed).toBe(1));
    q.clearFinished();
    // It failed again just now, so the next listing leaves it alone.
    expect(q.enqueue([byUrl("a")])).toMatchObject({ unavailable: 1 });

    vi.mocked(downloadTrack).mockResolvedValue({
      status: "downloaded",
      meta: { id: "a", title: "a", filepath: "/x/a" },
    });
    q.retryFailed(true);
    await vi.waitFor(() => expect(q.stats().done).toBe(1));
    q.clearFinished();
    expect(q.enqueue([byUrl("a")])).toMatchObject({ added: 1, unavailable: 0 });
    q.cancelAll();
  });

  it("stops remembering bare misses once the downloader looks stale", async () => {
    vi.mocked(downloadTrack).mockRejectedValue(new Error("HTTP Error 404: Not Found"));
    const q = new DownloadQueue(defaultConfig, lib(), 1);
    const batch = ["a", "b", "c", "d", "e", "f"].map((id) => byUrl(id));
    q.enqueue(batch);
    await vi.waitFor(() => expect(q.stats().failed).toBe(6));
    q.clearFinished();
    // The fifth miss in a row raised the notice: from there the tool is the
    // suspect, not the tracks.
    expect(q.enqueue(batch)).toMatchObject({ unavailable: 4, added: 2 });
    q.cancelAll();
  });
});

describe("download queue item event", () => {
  afterEach(() => {
    vi.mocked(downloadTrack).mockReset();
    vi.mocked(downloadTrack).mockImplementation(() => new Promise(() => {}));
  });

  it("reports each settled item with its saved track", async () => {
    vi.mocked(downloadTrack).mockImplementation(async (params) => {
      if (params.url === "bad") throw new Error("Private video");
      return {
        status: "downloaded",
        meta: { id: params.url, title: "Song", filepath: "/x/song.m4a" },
      };
    });
    const lib = {
      has: () => false,
      all: () => [],
      upsert: vi.fn(async () => {}),
    } as unknown as Library;
    const q = new DownloadQueue(defaultConfig, lib, 1);
    const seen: { status: string; file?: string; owned: boolean }[] = [];
    q.on("item", (item, track, owned) =>
      seen.push({ status: item.status, file: track?.filePath, owned }),
    );
    q.enqueue([byUrl("good"), byUrl("bad")]);
    await new Promise((r) => setTimeout(r, 60));
    expect(seen).toEqual([
      { status: "done", file: "/x/song.m4a", owned: false },
      { status: "error", file: undefined, owned: false },
    ]);
  });

  it("marks a song the library already held, so it is not counted as new", async () => {
    // Owned under a bare id title, so it is queued to heal the name: nothing
    // downloads, and the listener has to be able to tell.
    const lib = {
      has: (id: string) => id === "youtube:old",
      get: (id: string) =>
        id === "youtube:old"
          ? { id, source: "youtube", title: "900000001", filePath: "/x/old.m4a" }
          : undefined,
      all: () => [],
      upsert: vi.fn(async () => {}),
    } as unknown as Library;
    const q = new DownloadQueue(defaultConfig, lib, 1);
    const seen: { file?: string; owned: boolean }[] = [];
    q.on("item", (_item, track, owned) =>
      seen.push({ file: track?.filePath, owned }),
    );
    q.enqueue([byUrl("old")]);
    await new Promise((r) => setTimeout(r, 60));
    expect(seen).toEqual([{ file: "/x/old.m4a", owned: true }]);
    expect(vi.mocked(downloadTrack)).not.toHaveBeenCalled();
  });

  it("stays quiet for a row parked by a rate limit", async () => {
    vi.mocked(downloadTrack).mockResolvedValue({ status: "ratelimited" });
    const q = new DownloadQueue(defaultConfig, fakeLib, 1);
    const seen: string[] = [];
    q.on("item", (item) => seen.push(item.status));
    q.enqueue([input("youtube", "a")]);
    await new Promise((r) => setTimeout(r, 30));
    expect(q.stats().rateLimited).toBe(true);
    expect(seen).toEqual([]);
  });
});

describe("download queue per-track retry", () => {
  afterEach(() => {
    vi.mocked(downloadTrack).mockReset();
    vi.mocked(downloadTrack).mockImplementation(() => new Promise(() => {}));
    delete process.env.SOUNDCLI_FAILURE_STREAK;
  });

  it("retries a transient throw then succeeds without erroring", async () => {
    let calls = 0;
    vi.mocked(downloadTrack).mockImplementation(async () => {
      calls++;
      if (calls < 2) throw new Error("transient network blip");
      return { status: "downloaded", meta: { id: "a", title: "A", filepath: "/x" } };
    });
    const lib = {
      has: () => false,
      all: () => [],
      upsert: vi.fn(async () => {}),
    } as unknown as Library;
    const q = new DownloadQueue(defaultConfig, lib, 1);
    q.enqueue([input("youtube", "a")]);
    await new Promise((r) => setTimeout(r, 60));
    expect(q.getItems().length).toBe(0);
    expect(q.stats().done).toBe(1);
    expect(calls).toBe(2);
  });

  it("indexes a fresh download with the enqueued name when meta echoes a bare id", async () => {
    vi.mocked(downloadTrack).mockResolvedValue({
      status: "downloaded",
      meta: { id: "900000006", title: "900000006", filepath: "/x" },
    });
    const upsert = vi.fn(async () => {});
    const lib = {
      has: () => false,
      all: () => [],
      upsert,
    } as unknown as Library;
    const q = new DownloadQueue(defaultConfig, lib, 1);
    q.enqueue([
      {
        source: "soundcloud",
        sourceLabel: "soundcloud",
        track: {
          id: "900000006",
          title: "demo song",
          artist: "demo artist name",
          downloadUrl: "x",
          playlistTitle: "Set A",
          position: 3,
        },
      },
    ]);
    await new Promise((r) => setTimeout(r, 60));
    expect(q.stats().done).toBe(1);
    // A bare-id/empty meta title never lands in the library when the enqueued
    // entry knows the real name; the feed position rides into the entry.
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "demo song",
        artist: "demo artist name",
        playlistPos: 3,
      }),
    );
  });

  it("gives up after the bounded retries and marks error", async () => {
    vi.mocked(downloadTrack).mockRejectedValue(new Error("always fails"));
    const q = new DownloadQueue(defaultConfig, fakeLib, 1);
    q.enqueue([input("youtube", "a")]);
    await new Promise((r) => setTimeout(r, 60));
    expect(q.getItems()[0]!.status).toBe("error");
    // 1 initial + 2 retries = 3 attempts for the single item.
    expect(vi.mocked(downloadTrack).mock.calls.length).toBe(3);
  });

  it("auto-pauses the whole queue after a streak of failures", async () => {
    process.env.SOUNDCLI_FAILURE_STREAK = "3";
    vi.mocked(downloadTrack).mockRejectedValue(
      new Error(
        "yt-dlp failed (exit 1): ERROR: unable to download video data: The read operation timed out",
      ),
    );
    const q = new DownloadQueue(defaultConfig, fakeLib, 1);
    q.enqueue([
      input("youtube", "a"),
      input("youtube", "b"),
      input("youtube", "c"),
      input("youtube", "d"),
      input("youtube", "e"),
    ]);
    await new Promise((r) => setTimeout(r, 120));
    // 3 failures in a row trip the breaker → the queue pauses itself.
    expect(q.stats().rateLimited).toBe(true);
    expect(q.stats().failed).toBe(3);
    // The remaining items are parked as paused, not burned through as failed.
    expect(q.stats().paused).toBe(2);
    // Cancelling the parked rows ends the hold with them: nothing is on hold.
    q.cancelAll();
    expect(q.stats().rateLimited).toBe(false);
    expect(q.stats().paused).toBe(0);
  });

  it("stays paused after a throttle pause until the user resumes", async () => {
    process.env.SOUNDCLI_FAILURE_STREAK = "3";
    vi.mocked(downloadTrack).mockRejectedValue(
      new Error(
        "yt-dlp failed (exit 1): ERROR: unable to download video data: The read operation timed out",
      ),
    );
    const q = new DownloadQueue(defaultConfig, fakeLib, 1);
    q.enqueue([
      input("youtube", "a"),
      input("youtube", "b"),
      input("youtube", "c"),
      input("youtube", "d"),
      input("youtube", "e"),
    ]);
    await new Promise((r) => setTimeout(r, 120));
    expect(q.stats().rateLimited).toBe(true);
    // Nothing resumes on its own: still stopped well after the breaker tripped.
    await new Promise((r) => setTimeout(r, 100));
    expect(q.stats().rateLimited).toBe(true);
    expect(q.stats().paused).toBe(2);
    // Only the user's resume drains the rest.
    q.resumeAll();
    expect(q.stats().rateLimited).toBe(false);
    await new Promise((r) => setTimeout(r, 120));
    const s = q.stats();
    expect(s.paused).toBe(0);
    expect(s.failed).toBe(5); // every item was attempted after the resume
  });

  it("parks the queue on a run of source-blocked (403) tracks", async () => {
    // 403s cluster: a playlist heavy with official label uploads hits several
    // in a row, because those are served only to clients that can prove where
    // the request came from. The rest of the batch then fails the same way, so
    // grinding through it only wastes the user's evening before they cancel by
    // hand. Counting these toward the breaker was fine; announcing them as a
    // rate limit was the lie, so the halt names this one for what it is.
    process.env.SOUNDCLI_FAILURE_STREAK = "3";
    vi.mocked(downloadTrack).mockRejectedValue(
      new Error(
        "yt-dlp failed (exit 1): ERROR: unable to download video data: HTTP Error 403: Forbidden",
      ),
    );
    const q = new DownloadQueue(defaultConfig, fakeLib, 1);
    q.enqueue([
      input("youtube", "a"),
      input("youtube", "b"),
      input("youtube", "c"),
      input("youtube", "d"),
      input("youtube", "e"),
    ]);
    await new Promise((r) => setTimeout(r, 250));
    const s = q.stats();
    expect(s.rateLimited).toBe(true);
    expect(s.rateLimitReason).toBe(SOURCE_BLOCKING);
    expect(s.failed).toBe(3);
    // The rest wait as paused rows the user can resume, not as failures.
    expect(s.paused).toBe(2);
  });

  it("waits out a source block instead of sprinting through its cooldown", () => {
    // A 403 from the media host is YouTube's rate limit in its only shape: it
    // never arrives as a 429 and it clears within minutes. The old 500ms and
    // 1000ms retries spent every attempt inside that window.
    expect(blockedBackoffMs(0, () => 0)).toBe(3_000);
    expect(blockedBackoffMs(0, () => 1)).toBe(8_000);
    expect(blockedBackoffMs(1, () => 0)).toBe(15_000);
    expect(blockedBackoffMs(1, () => 1)).toBe(30_000);
    // Past the last window it holds, rather than growing without bound.
    expect(blockedBackoffMs(9, () => 0)).toBe(15_000);
  });

  it("jitters the wait so blocked workers don't come back in lockstep", () => {
    // Three workers are blocked together; identical backoffs would send them
    // all back at the same instant and rebuild the burst that blocked them.
    const waits = [0.1, 0.5, 0.9].map((r) => blockedBackoffMs(0, () => r));
    expect(new Set(waits).size).toBe(3);
    for (const w of waits) {
      expect(w).toBeGreaterThanOrEqual(3_000);
      expect(w).toBeLessThanOrEqual(8_000);
    }
  });

  it("classifies permanent track errors vs transient platform errors", () => {
    expect(isPermanentTrackError("This video is unavailable")).toBe(true);
    expect(isPermanentTrackError("Private video")).toBe(true);
    expect(isPermanentTrackError("HTTP Error 404: Not Found")).toBe(true);
    expect(isPermanentTrackError("not available in your country")).toBe(true);
    expect(isPermanentTrackError("This video is DRM protected")).toBe(true);
    expect(isPermanentTrackError("HTTP Error 403: Forbidden")).toBe(false);
    expect(isPermanentTrackError("HTTP Error 429: Too Many Requests")).toBe(false);
    expect(isPermanentTrackError("read timed out")).toBe(false);
    // The host's words, not the track's: these clear up, so they stay transient.
    expect(isPermanentTrackError("HTTP Error 503: Service Unavailable")).toBe(false);
    expect(isPermanentTrackError("[Errno 11] Resource temporarily unavailable")).toBe(false);
    // YouTube's actual region message never says "not available".
    expect(
      isPermanentTrackError("The uploader has not made this video available in your country"),
    ).toBe(true);
  });

  it("never parks the queue on a run of dead tracks", async () => {
    // Six DRM songs in a row once parked a hundred healthy ones under "Too many
    // missing tracks". Dead tracks are each their own fact, so the batch keeps
    // going; a burst of bare misses still raises the stale-downloader hint.
    process.env.SOUNDCLI_FAILURE_STREAK = "3";
    vi.mocked(downloadTrack).mockRejectedValue(
      new Error("ERROR: This track is unavailable"),
    );
    const q = new DownloadQueue(defaultConfig, fakeLib, 1);
    q.enqueue(["a", "b", "c", "d", "e"].map((id) => input("youtube", id)));
    await new Promise((r) => setTimeout(r, 150));
    const s = q.stats();
    expect(s.rateLimited).toBe(false);
    expect(s.paused).toBe(0);
    expect(s.failed).toBe(5);
    expect(s.failingSource).toBe("youtube");
    // Dead tracks still skip the per-track retries: one attempt each.
    expect(vi.mocked(downloadTrack).mock.calls.length).toBe(5);
  });

  it("a dead track neither feeds nor breaks a real failure streak", async () => {
    process.env.SOUNDCLI_FAILURE_STREAK = "3";
    vi.mocked(downloadTrack).mockImplementation(async (params) => {
      if (params.url === "b")
        throw new Error("ERROR: [soundcloud] 900000008: This video is DRM protected");
      throw new Error("ERROR: The read operation timed out");
    });
    const q = new DownloadQueue(defaultConfig, fakeLib, 1);
    q.enqueue(["a", "b", "c", "d", "e"].map((id) => byUrl(id)));
    await new Promise((r) => setTimeout(r, 150));
    const s = q.stats();
    // a, c and d time out: three in a row, with the DRM track b in between.
    expect(s.rateLimited).toBe(true);
    expect(s.rateLimitReason).toBe(TOO_MANY_FAILURES);
    expect(s.failed).toBe(4);
    expect(s.paused).toBe(1);
  });

  it("a canceled batch's streak never carries into the next one", async () => {
    process.env.SOUNDCLI_FAILURE_STREAK = "3";
    vi.mocked(downloadTrack).mockImplementation((params) =>
      params.url === "c"
        ? new Promise((_, reject) =>
            params.signal?.addEventListener("abort", () =>
              reject(new Error("aborted")),
            ),
          )
        : Promise.reject(new Error("ERROR: The read operation timed out")),
    );
    const q = new DownloadQueue(defaultConfig, fakeLib, 1);
    q.enqueue(["a", "b", "c"].map((id) => byUrl(id)));
    await new Promise((r) => setTimeout(r, 60));
    q.cancelAll(); // a and b failed in a row; c was mid-download
    q.enqueue([byUrl("d")]);
    await new Promise((r) => setTimeout(r, 60));
    // d is the new batch's first miss, not the old streak's third.
    expect(q.getItems().find((i) => i.track.id === "d")!.status).toBe("error");
    expect(q.stats().rateLimited).toBe(false);
  });

  it("keeps going when successes break up the failures", async () => {
    // The case the breaker must never touch: failures broken up by downloads
    // that work. One success resets the streak, so four failures spread
    // across five tracks park nothing.
    process.env.SOUNDCLI_FAILURE_STREAK = "3";
    vi.mocked(downloadTrack).mockImplementation(async (params) => {
      if (params.url === "c")
        return { status: "downloaded", meta: { id: "c", title: "C", filepath: "/x" } };
      throw new Error("ERROR: The read operation timed out");
    });
    const lib = {
      has: () => false,
      all: () => [],
      upsert: vi.fn(async () => {}),
    } as unknown as Library;
    const q = new DownloadQueue(defaultConfig, lib, 1);
    q.enqueue(["a", "b", "c", "d", "e"].map((id) => byUrl(id)));
    await new Promise((r) => setTimeout(r, 150));
    const s = q.stats();
    expect(s.rateLimited).toBe(false);
    expect(s.paused).toBe(0);
    expect(s.failed).toBe(4);
    expect(s.done).toBe(1);
  });

  it("estimates a finish time from failures, not only from downloads", async () => {
    // Sampling successes alone left a batch that fails everything sitting at
    // "estimating…" until the user gave up: a failed track still spends
    // wall-clock time, so it tells us just as much about the drain rate.
    process.env.SOUNDCLI_FAILURE_STREAK = "99";
    vi.mocked(downloadTrack).mockImplementation(
      () =>
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("ERROR: This track is unavailable")), 30),
        ),
    );
    const q = new DownloadQueue(defaultConfig, fakeLib, 1);
    q.enqueue([
      input("youtube", "a"),
      input("youtube", "b"),
      input("youtube", "c"),
      input("youtube", "d"),
      input("youtube", "e"),
    ]);
    await new Promise((r) => setTimeout(r, 45));
    const s = q.stats();
    // Sampled mid-run: something has failed and work is still queued.
    expect(s.failed).toBeGreaterThan(0);
    expect(s.downloading + s.pending).toBeGreaterThan(0);
    expect(s.etaSeconds).toBeDefined();
    expect(s.etaSeconds).toBeGreaterThan(0);
    // Sampled mid-flight on purpose, so stop the queue before the test ends:
    // a queue left pumping keeps calling the shared mock during later tests.
    q.cancelAll();
    await new Promise((r) => setTimeout(r, 40));
  });

  it("saves a blocked track that works on the next attempt", async () => {
    // The five tracks that failed on a real playlist run: refused once, fine
    // moments later. Retrying at all is not new; waiting long enough is.
    let calls = 0;
    vi.mocked(downloadTrack).mockImplementation(async () => {
      calls++;
      if (calls === 1)
        throw new Error(
          "yt-dlp failed (exit 1): ERROR: unable to download video data: HTTP Error 403: Forbidden",
        );
      return { status: "downloaded", meta: { id: "a", title: "A", filepath: "/x" } };
    });
    const lib = {
      has: () => false,
      all: () => [],
      upsert: vi.fn(async () => {}),
    } as unknown as Library;
    const q = new DownloadQueue(defaultConfig, lib, 1);
    q.enqueue([input("youtube", "a")]);
    await new Promise((r) => setTimeout(r, 120));
    const s = q.stats();
    expect(s.done).toBe(1);
    expect(s.failed).toBe(0);
    expect(calls).toBe(2);
  });

  it("says a track is retrying until its next attempt reports progress", async () => {
    // A source-block wait runs up to half a minute; the failed attempt's last
    // percent sat on the row for all of it and read as a hang.
    let progress: ((p: DownloadProgress) => void) | undefined;
    vi.mocked(downloadTrack)
      .mockRejectedValueOnce(
        new Error(
          "yt-dlp failed (exit 1): ERROR: unable to download video data: HTTP Error 403: Forbidden",
        ),
      )
      .mockImplementationOnce((_params, onProgress) => {
        progress = onProgress;
        return new Promise(() => {});
      });
    const q = new DownloadQueue(defaultConfig, fakeLib, 1);
    q.enqueue([input("youtube", "a")]);
    await new Promise((r) => setTimeout(r, 30));
    const item = q.getItems()[0]!;
    expect(item.retrying).toBe(true);
    progress?.({ status: "downloading", percent: 5 });
    expect(item.retrying).toBe(false);
    q.cancelAll();
  });

  it("narrows to one download at a time while the source is refusing", async () => {
    // Three workers crowding a host that is already refusing is what turns a
    // short cooldown into a batch of failures, so a block drops the queue to
    // one until something gets through.
    process.env.SOUNDCLI_FAILURE_STREAK = "99"; // don't halt mid-measurement
    const mk = (id: string) => ({
      source: "youtube" as SourceId,
      sourceLabel: "youtube",
      track: { id, title: id, downloadUrl: id },
    });
    let inFlight = 0;
    let maxDuringBlock = 0;
    let released = false;
    let q: DownloadQueue | undefined;
    vi.mocked(downloadTrack).mockImplementation(async (params) => {
      // The window that matters: after the queue has seen a block, and before
      // a success tells it the host is answering again.
      const duringBlock = !released && (q?.stats().failed ?? 0) > 0;
      inFlight++;
      if (duringBlock) maxDuringBlock = Math.max(maxDuringBlock, inFlight);
      try {
        if (["a", "b", "c"].includes(params.url)) {
          throw new Error(
            "yt-dlp failed (exit 1): ERROR: unable to download video data: HTTP Error 403: Forbidden",
          );
        }
        await new Promise((r) => setTimeout(r, 20));
        released = true;
        return {
          status: "downloaded",
          meta: { id: params.url, title: "X", filepath: "/x" },
        };
      } finally {
        inFlight--;
      }
    });
    const lib = {
      has: () => false,
      all: () => [],
      upsert: vi.fn(async () => {}),
    } as unknown as Library;
    q = new DownloadQueue(defaultConfig, lib, 3);
    q.enqueue([mk("a"), mk("b"), mk("c"), mk("d"), mk("e"), mk("f")]);
    await new Promise((r) => setTimeout(r, 300));
    // Nothing started alongside another one while the block stood.
    expect(maxDuringBlock).toBe(1);
    // The rest still land, so the throttle lifts rather than sticking.
    expect(q.stats().done).toBe(3);
    expect(q.stats().failed).toBe(3);
  });

  it("skips an item already in the library without downloading it", async () => {
    // has() is false at enqueue (so it queues) but true by the time run() picks
    // it up (its twin finished first), so the pre-download guard must skip it.
    let seen = 0;
    const lib = {
      has: (id: string) => {
        if (id !== "youtube:a") return false;
        seen++;
        return seen >= 2;
      },
      all: () => [],
    } as unknown as Library;
    vi.mocked(downloadTrack).mockRejectedValue(new Error("must not run"));
    const q = new DownloadQueue(defaultConfig, lib, 1);
    q.enqueue([input("youtube", "a")]);
    await new Promise((r) => setTimeout(r, 40));
    expect(q.getItems().length).toBe(0);
    expect(q.stats().skipped).toBe(1);
    expect(vi.mocked(downloadTrack)).not.toHaveBeenCalled();
  });
});

describe("download queue Spotify lazy resolution", () => {
  afterEach(() => {
    vi.mocked(downloadTrack).mockReset();
    vi.mocked(downloadTrack).mockImplementation(() => new Promise(() => {}));
    resolveMock.mockReset();
    resolveMock.mockResolvedValue(null);
  });

  it("downloads the resolved exact URL when matching succeeds", async () => {
    resolveMock.mockResolvedValue("https://www.youtube.com/watch?v=EXACT");
    let usedUrl = "";
    vi.mocked(downloadTrack).mockImplementation(async (params) => {
      usedUrl = params.url;
      return { status: "downloaded", meta: { id: "EXACT", title: "Velvet Signal", filepath: "/x" } };
    });
    const lib = {
      has: () => false,
      all: () => [],
      upsert: vi.fn(async () => {}),
    } as unknown as Library;
    const q = new DownloadQueue(defaultConfig, lib, 1);
    q.enqueue([spotifyInput("s1")]);
    await new Promise((r) => setTimeout(r, 60));
    expect(resolveMock).toHaveBeenCalled();
    expect(usedUrl).toBe("https://www.youtube.com/watch?v=EXACT");
    expect(q.getItems().length).toBe(0);
    expect(q.stats().done).toBe(1);
  });

  it("falls back to the ytsearch1 URL and tags unverified when no match", async () => {
    resolveMock.mockResolvedValue(null);
    let usedUrl = "";
    vi.mocked(downloadTrack).mockImplementation(async (params) => {
      usedUrl = params.url;
      return { status: "downloaded", meta: { id: "s1", title: "Velvet Signal", filepath: "/x" } };
    });
    const lib = {
      has: () => false,
      all: () => [],
      upsert: vi.fn(async () => {}),
    } as unknown as Library;
    const q = new DownloadQueue(defaultConfig, lib, 1);
    q.enqueue([spotifyInput("s2")]);
    await new Promise((r) => setTimeout(r, 60));
    expect(usedUrl).toBe("ytsearch1:Circuit Fauna Velvet Signal");
    expect(q.getItems()[0]!.unverifiedMatch).toBe(true);
  });

  it("falls back and tags unverified when resolution throws", async () => {
    resolveMock.mockRejectedValue(new Error("search failed"));
    let usedUrl = "";
    vi.mocked(downloadTrack).mockImplementation(async (params) => {
      usedUrl = params.url;
      return { status: "downloaded", meta: { id: "s3", title: "Velvet Signal", filepath: "/x" } };
    });
    const lib = {
      has: () => false,
      all: () => [],
      upsert: vi.fn(async () => {}),
    } as unknown as Library;
    const q = new DownloadQueue(defaultConfig, lib, 1);
    q.enqueue([spotifyInput("s3")]);
    await new Promise((r) => setTimeout(r, 60));
    expect(usedUrl).toBe("ytsearch1:Circuit Fauna Velvet Signal");
    expect(q.getItems()[0]!.unverifiedMatch).toBe(true);
  });
});

describe("download queue library indexing", () => {
  afterEach(() => {
    vi.mocked(downloadTrack).mockReset();
    vi.mocked(downloadTrack).mockImplementation(() => new Promise(() => {}));
    findDownloadedFileMock.mockReset();
    findDownloadedFileMock.mockImplementation(async (p) => p);
  });

  it("marks error instead of indexing when the finished file is missing", async () => {
    findDownloadedFileMock.mockResolvedValue(undefined);
    vi.mocked(downloadTrack).mockResolvedValue({
      status: "downloaded",
      meta: { id: "a", title: "A", filepath: "/gone" },
    });
    const upsert = vi.fn(async () => {});
    const lib = { has: () => false, all: () => [], upsert } as unknown as Library;
    const q = new DownloadQueue(defaultConfig, lib, 1);
    q.enqueue([input("youtube", "a")]);
    await new Promise((r) => setTimeout(r, 60));
    expect(q.getItems()[0]!.status).toBe("error");
    expect(upsert).not.toHaveBeenCalled();
  });

  it("stamps addedAt at completion time, so later finishes sort newer", async () => {
    const saved: { id: string; addedAt: string }[] = [];
    const upsert = vi.fn(async (t: { id: string; addedAt: string }) => {
      saved.push(t);
    });
    const lib = { has: () => false, all: () => [], upsert } as unknown as Library;

    // Two items, concurrency 2: the FIRST enqueued finishes LAST.
    let resolveA!: (r: {
      status: "downloaded";
      meta: { id: string; title: string; filepath: string };
    }) => void;
    vi.mocked(downloadTrack).mockImplementation((params) => {
      if (params.url === "url-a")
        return new Promise((res) => {
          resolveA = res;
        });
      return Promise.resolve({
        status: "downloaded" as const,
        meta: { id: "b", title: "B", filepath: "/x" },
      });
    });

    const q = new DownloadQueue(defaultConfig, lib, 2);
    q.enqueue([
      { source: "youtube", sourceLabel: "YouTube", track: { id: "a", title: "A", downloadUrl: "url-a" } },
      { source: "youtube", sourceLabel: "YouTube", track: { id: "b", title: "B", downloadUrl: "url-b" } },
    ]);
    await new Promise((r) => setTimeout(r, 40)); // b lands first
    resolveA({ status: "downloaded", meta: { id: "a", title: "A", filepath: "/x" } });
    await new Promise((r) => setTimeout(r, 40)); // a lands second

    expect(saved.map((t) => t.id)).toEqual(["youtube:b", "youtube:a"]);
    // The later finish gets the newer stamp, so it sorts to the top.
    expect(saved[1]!.addedAt.localeCompare(saved[0]!.addedAt)).toBeGreaterThan(0);
  });
});

describe("download queue auto-clear", () => {
  it("auto-clear empties items while totals accumulate", async () => {
    vi.mocked(downloadTrack).mockResolvedValue({
      status: "downloaded",
      meta: { id: "a", title: "A", filepath: "/x" },
    });
    const lib = { has: () => false, all: () => [], upsert: vi.fn(async () => {}) } as unknown as Library;
    const q = new DownloadQueue(defaultConfig, lib, 1);
    q.enqueue([input("youtube", "a")]);
    await new Promise((r) => setTimeout(r, 60));
    expect(q.getItems().length).toBe(0);
    const s = q.stats();
    expect(s.done).toBe(1);
    expect(s.total).toBe(1);
  });

  it("unverified-done survives auto-clear", async () => {
    resolveMock.mockResolvedValue(null);
    vi.mocked(downloadTrack).mockResolvedValue({
      status: "downloaded",
      meta: { id: "s1", title: "Velvet Signal", filepath: "/x" },
    });
    const lib = { has: () => false, all: () => [], upsert: vi.fn(async () => {}) } as unknown as Library;
    const q = new DownloadQueue(defaultConfig, lib, 1);
    q.enqueue([spotifyInput("s1")]);
    await new Promise((r) => setTimeout(r, 60));
    expect(q.getItems().length).toBe(1);
    expect(q.getItems()[0]!.status).toBe("done");
    expect(q.getItems()[0]!.unverifiedMatch).toBe(true);
    expect(q.stats().done).toBe(1);
  });

  it("clearFinished and clearAll zero counters, cancelAll preserves totals", async () => {
    vi.mocked(downloadTrack).mockResolvedValue({
      status: "downloaded",
      meta: { id: "a", title: "A", filepath: "/x" },
    });
    const lib = { has: () => false, all: () => [], upsert: vi.fn(async () => {}) } as unknown as Library;
    const q = new DownloadQueue(defaultConfig, lib, 1);
    q.enqueue([input("youtube", "a")]);
    await new Promise((r) => setTimeout(r, 60));

    q.cancelAll();
    expect(q.stats().total).toBe(1);
    expect(q.stats().done).toBe(1);

    q.clearFinished();
    expect(q.stats().total).toBe(0);
    expect(q.stats().done).toBe(0);

    q.enqueue([input("youtube", "b")]);
    await new Promise((r) => setTimeout(r, 60));
    q.clearAll();
    expect(q.stats().total).toBe(0);
    expect(q.stats().done).toBe(0);
  });

  it("enqueue-on-empty resets, enqueue-on-nonempty doesn't", async () => {
    vi.mocked(downloadTrack).mockResolvedValue({
      status: "downloaded",
      meta: { id: "a", title: "A", filepath: "/x" },
    });
    const lib = { has: () => false, all: () => [], upsert: vi.fn(async () => {}) } as unknown as Library;
    const q = new DownloadQueue(defaultConfig, lib, 1);

    q.enqueue([input("youtube", "a")]);
    await new Promise((r) => setTimeout(r, 60));
    // Queue is empty because item auto-cleared, but totals are kept until new enqueue
    expect(q.stats().total).toBe(1);

    // enqueue on empty queue -> resets totals
    q.enqueue([input("youtube", "b")]);
    expect(q.stats().total).toBe(1); // just the new item

    // pause it so it stays in queue
    q.pause(q.getItems()[0]!.id);
    expect(q.getItems().length).toBe(1);

    // enqueue on nonempty -> doesn't reset totals
    q.enqueue([input("youtube", "c")]);
    expect(q.stats().total).toBe(2);
  });
});

describe("download queue stale-downloader notice", () => {
  afterEach(() => {
    vi.mocked(downloadTrack).mockReset();
    vi.mocked(downloadTrack).mockImplementation(() => new Promise(() => {}));
  });

  // The real stderr a broken SoundCloud extractor produces for LIVE tracks:
  // classified permanent per-track, but a burst of them means the tool.
  const dead = new Error(
    "yt-dlp failed (exit 1): ERROR: [soundcloud] Unable to download JSON metadata: HTTP Error 404: Not Found",
  );

  it("flags the source after 5 permanent failures in a row, without pausing", async () => {
    vi.mocked(downloadTrack).mockRejectedValue(dead);
    const q = new DownloadQueue(defaultConfig, fakeLib, 1);
    q.enqueue(["a", "b", "c", "d", "e"].map((id) => input("soundcloud", id)));
    await new Promise((r) => setTimeout(r, 150));
    const s = q.stats();
    expect(s.failed).toBe(5);
    expect(s.failingSource).toBe("soundcloud");
    expect(s.rateLimited).toBe(false);
    expect(s.paused).toBe(0);
  });

  it("stays quiet below the threshold", async () => {
    vi.mocked(downloadTrack).mockRejectedValue(dead);
    const q = new DownloadQueue(defaultConfig, fakeLib, 1);
    q.enqueue(["a", "b", "c", "d"].map((id) => input("soundcloud", id)));
    await new Promise((r) => setTimeout(r, 120));
    expect(q.stats().failed).toBe(4);
    expect(q.stats().failingSource).toBe(null);
  });

  it("a success from that source clears the notice and resets the streak", async () => {
    vi.mocked(downloadTrack).mockRejectedValue(dead);
    const lib = {
      has: () => false,
      all: () => [],
      upsert: vi.fn(async () => {}),
    } as unknown as Library;
    const q = new DownloadQueue(defaultConfig, lib, 1);
    q.enqueue(["a", "b", "c", "d", "e"].map((id) => input("soundcloud", id)));
    await new Promise((r) => setTimeout(r, 150));
    expect(q.stats().failingSource).toBe("soundcloud");

    vi.mocked(downloadTrack).mockResolvedValue({
      status: "downloaded",
      meta: { id: "ok", title: "OK", filepath: "/x" },
    });
    q.enqueue([input("soundcloud", "ok")]);
    await new Promise((r) => setTimeout(r, 60));
    expect(q.stats().failingSource).toBe(null);

    // The streak reset too: four more dead tracks stay below the threshold.
    vi.mocked(downloadTrack).mockRejectedValue(dead);
    q.enqueue(["f", "g", "h", "i"].map((id) => input("soundcloud", id)));
    await new Promise((r) => setTimeout(r, 120));
    expect(q.stats().failingSource).toBe(null);
  });

  it("streaks are per source, so scattered dead tracks stay quiet", async () => {
    vi.mocked(downloadTrack).mockRejectedValue(dead);
    const q = new DownloadQueue(defaultConfig, fakeLib, 1);
    q.enqueue([
      input("soundcloud", "a"),
      input("youtube", "b"),
      input("soundcloud", "c"),
      input("youtube", "d"),
      input("soundcloud", "e"),
      input("youtube", "f"),
    ]);
    await new Promise((r) => setTimeout(r, 180));
    expect(q.stats().failed).toBe(6);
    expect(q.stats().failingSource).toBe(null);
  });

  it("clearAll clears the notice", async () => {
    vi.mocked(downloadTrack).mockRejectedValue(dead);
    const q = new DownloadQueue(defaultConfig, fakeLib, 1);
    q.enqueue(["a", "b", "c", "d", "e"].map((id) => input("soundcloud", id)));
    await new Promise((r) => setTimeout(r, 150));
    expect(q.stats().failingSource).toBe("soundcloud");
    q.clearAll();
    expect(q.stats().failingSource).toBe(null);
  });

  it("a burst of stated reasons never blames the downloader or parks the queue", async () => {
    // A platform naming why (DRM, private, removed, age, region) is telling the
    // truth about that one track, not hinting at a stale extractor. Eight runs
    // past the default streak limit of six.
    const reasons = [
      "ERROR: [soundcloud] 900000008: This video is DRM protected",
      "ERROR: Private video",
      "ERROR: Video unavailable. This video has been removed by the uploader",
      "ERROR: Sign in to confirm your age",
      "ERROR: The uploader has not made this video available in your country",
    ];
    const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];
    vi.mocked(downloadTrack).mockImplementation(async (params) => {
      throw new Error(reasons[ids.indexOf(params.url) % reasons.length]);
    });
    const q = new DownloadQueue(defaultConfig, fakeLib, 1);
    q.enqueue(ids.map((id) => byUrl(id, "soundcloud")));
    await new Promise((r) => setTimeout(r, 200));
    const s = q.stats();
    expect(s.failed).toBe(8);
    expect(s.failingSource).toBe(null);
    expect(s.rateLimited).toBe(false);
    // Permanent, the region message included: one attempt each, no retry burn.
    expect(vi.mocked(downloadTrack).mock.calls.length).toBe(8);
  });
});

describe("download queue tool gate", () => {
  afterEach(() => {
    vi.mocked(downloadTrack).mockReset();
    vi.mocked(downloadTrack).mockImplementation(() => new Promise(() => {}));
  });

  it("a failing ensureTools parks the queue waiting instead of failing items", async () => {
    let ensureOk = false;
    let ensureCalls = 0;
    const ensureTools = async (): Promise<void> => {
      ensureCalls++;
      if (!ensureOk) throw new Error("offline: no audio engine yet");
    };
    vi.mocked(downloadTrack).mockResolvedValue({
      status: "downloaded",
      meta: { id: "a", title: "A", filepath: "/x" },
    });
    const lib = {
      has: () => false,
      all: () => [],
      upsert: vi.fn(async () => {}),
    } as unknown as Library;
    const q = new DownloadQueue(defaultConfig, lib, 1, ensureTools);
    q.enqueue([input("youtube", "a")]);
    await new Promise((r) => setTimeout(r, 30));

    // The item is parked, not burned: a missing tool is never its fault.
    const s = q.stats();
    expect(s.rateLimited).toBe(true);
    expect(s.rateLimitReason).toBe(WAITING_FOR_TOOLS);
    expect(s.failed).toBe(0);
    expect(s.paused).toBe(1);
    expect(vi.mocked(downloadTrack)).not.toHaveBeenCalled();

    // The engine arrives; resume re-awaits a fresh ensure and proceeds.
    ensureOk = true;
    q.resumeAll();
    await new Promise((r) => setTimeout(r, 30));
    expect(q.stats().rateLimited).toBe(false);
    expect(q.stats().done).toBe(1);
    expect(ensureCalls).toBe(2);
  });
});

describe("download queue, the smaller truths", () => {
  afterEach(() => {
    vi.mocked(downloadTrack).mockReset();
    vi.mocked(downloadTrack).mockImplementation(() => new Promise(() => {}));
    findDownloadedFileMock.mockReset();
    findDownloadedFileMock.mockImplementation(async (p: string) => p);
  });

  it("keeps a missing file retryable whatever the song is called", async () => {
    // "private" in a title is not the platform saying the song is private.
    const q = new DownloadQueue(defaultConfig, fakeLib, 1);
    vi.mocked(downloadTrack).mockResolvedValueOnce({
      status: "downloaded",
      meta: { id: "a", title: "Private Dancer", filepath: "/music/Private Dancer.m4a" },
    });
    findDownloadedFileMock.mockResolvedValueOnce(undefined);
    q.enqueue([input("youtube", "a", "Private Dancer")]);
    await vi.waitFor(() => expect(q.stats().failed).toBe(1));
    expect(q.stats().retryable).toBe(1);
  });

  it("names a Spotify file after Unknown Artist when the artist is empty", async () => {
    const q = new DownloadQueue(defaultConfig, fakeLib, 1);
    const song = spotifyInput("s1");
    song.track.artist = "";
    q.enqueue([song]);
    await vi.waitFor(() => expect(vi.mocked(downloadTrack)).toHaveBeenCalled());
    expect(vi.mocked(downloadTrack).mock.calls.at(-1)![0].fixedStem).toBe(
      "Unknown Artist - Velvet Signal",
    );
  });

  it.runIf(process.platform === "win32")(
    "sees a playlist renamed only by letter case as the folder it already is",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "soundcli-q-"));
      const existing = {
        id: "soundcloud:owner1:sc1",
        source: "soundcloud" as SourceId,
        sourceTrackId: "sc1",
        title: "Song",
        artist: "Artist",
        filePath: path.join(root, "SoundCloud", "owner1", "Warm Up", "Artist - Song.m4a"),
        playlist: "Warm Up",
        owner: "owner1",
        addedAt: new Date().toISOString(),
      };
      const lib = {
        has: (id: string) => id === existing.id,
        get: (id: string) => (id === existing.id ? existing : undefined),
        all: () => [existing],
        upsertMany: async () => {},
      } as unknown as Library;
      const q = new DownloadQueue({ ...defaultConfig, libraryDir: root }, lib, 1);
      const r = q.enqueue([
        {
          source: "soundcloud",
          sourceLabel: "SoundCloud",
          track: {
            id: "sc1",
            title: "Song",
            downloadUrl: "x",
            owner: "owner1",
            playlistTitle: "warm up",
          },
        },
      ]);
      // On disk it is one folder: queueing a "copy" indexed the file twice.
      expect(r.added).toBe(0);
    },
  );
});
