import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// Run per-track retry backoffs with zero delay so timing assertions stay fast.
beforeAll(() => {
  process.env.SOUNDCLI_RETRY_BASE_MS = "0";
});

// Keep downloads from actually running: a never-resolving stub leaves items
// "downloading" so we can assert enqueue's dedupe accounting.
vi.mock("../src/ytdlp/ytdlp", () => ({
  downloadTrack: vi.fn(() => new Promise(() => {})),
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

import { downloadTrack } from "../src/ytdlp/ytdlp";
import {
  DownloadQueue,
  isPermanentTrackError,
  WAITING_FOR_TOOLS,
} from "../src/download/queue";
import { defaultConfig } from "../src/config/config";
import type { Library } from "../src/library/library";
import type { SourceId } from "../src/library/types";

function input(source: SourceId, id: string, title = id, artist?: string) {
  return {
    source,
    sourceLabel: source,
    track: { id, title, artist, downloadUrl: "x" },
  };
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
      filePath: src,
      playlist: "Liked Songs",
      owner: "owner1",
      addedAt: new Date().toISOString(),
    };
    const lib = {
      has: (id: string) => id === existing.id,
      get: (id: string) => (id === existing.id ? existing : undefined),
      all: () => [existing],
      upsert: vi.fn(async () => {}),
    } as unknown as Library;
    const q = new DownloadQueue({ ...defaultConfig, libraryDir: root }, lib, 1);
    vi.mocked(downloadTrack).mockClear();
    const r = q.enqueue([
      {
        source: "soundcloud",
        sourceLabel: "SoundCloud",
        track: {
          id: "sc1",
          title: "Song",
          artist: "Artist",
          downloadUrl: "https://soundcloud.com/a/song",
          owner: "owner1",
          playlistTitle: "Set A",
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
    await expect(fs.readFile(copied, "utf8")).resolves.toBe("audio");
    expect(vi.mocked(downloadTrack)).not.toHaveBeenCalled();
    expect(q.getItems().length).toBe(0);
    expect(q.stats().done).toBe(1);
    await fs.rm(root, { recursive: true, force: true });
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
    vi.mocked(downloadTrack).mockRejectedValue(new Error("HTTP Error 403"));
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
  });

  it("stays paused after a throttle pause until the user resumes", async () => {
    process.env.SOUNDCLI_FAILURE_STREAK = "3";
    vi.mocked(downloadTrack).mockRejectedValue(new Error("HTTP Error 403"));
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

  it("classifies permanent track errors vs transient platform errors", () => {
    expect(isPermanentTrackError("This video is unavailable")).toBe(true);
    expect(isPermanentTrackError("Private video")).toBe(true);
    expect(isPermanentTrackError("HTTP Error 404: Not Found")).toBe(true);
    expect(isPermanentTrackError("not available in your country")).toBe(true);
    expect(isPermanentTrackError("This video is DRM protected")).toBe(true);
    expect(isPermanentTrackError("HTTP Error 403: Forbidden")).toBe(false);
    expect(isPermanentTrackError("HTTP Error 429: Too Many Requests")).toBe(false);
    expect(isPermanentTrackError("read timed out")).toBe(false);
  });

  it("permanent failures (dead tracks) never trip the breaker", async () => {
    process.env.SOUNDCLI_FAILURE_STREAK = "3";
    vi.mocked(downloadTrack).mockRejectedValue(
      new Error("ERROR: This track is unavailable"),
    );
    const q = new DownloadQueue(defaultConfig, fakeLib, 1);
    q.enqueue([
      input("youtube", "a"),
      input("youtube", "b"),
      input("youtube", "c"),
      input("youtube", "d"),
    ]);
    await new Promise((r) => setTimeout(r, 120));
    // Every item fails individually; the queue never assumes throttling.
    expect(q.stats().rateLimited).toBe(false);
    expect(q.stats().failed).toBe(4);
    expect(q.stats().paused).toBe(0);
    // Dead tracks also skip the per-track retries: one attempt each.
    expect(vi.mocked(downloadTrack).mock.calls.length).toBe(4);
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

  it("a DRM burst never blames the downloader (it's the platform's truth)", async () => {
    vi.mocked(downloadTrack).mockRejectedValue(
      new Error("ERROR: [soundcloud] 900000008: This video is DRM protected"),
    );
    const q = new DownloadQueue(defaultConfig, fakeLib, 1);
    q.enqueue(["a", "b", "c", "d", "e"].map((id) => input("soundcloud", id)));
    await new Promise((r) => setTimeout(r, 150));
    const s = q.stats();
    expect(s.failed).toBe(5);
    expect(s.failingSource).toBe(null);
    expect(s.rateLimited).toBe(false);
    // Permanent: one attempt each, no retry burn.
    expect(vi.mocked(downloadTrack).mock.calls.length).toBe(5);
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
