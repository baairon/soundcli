import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// A download that only ends when it is aborted, the way yt-dlp ends when it
// is killed: that is what a quit does to whatever is in flight.
vi.mock("../src/ytdlp/ytdlp", () => ({
  downloadTrack: vi.fn(
    (params: { signal?: AbortSignal }) =>
      new Promise((resolve) => {
        params.signal?.addEventListener("abort", () =>
          resolve({ status: "canceled" }),
        );
      }),
  ),
  enumerate: vi.fn(async () => ({ entries: [] })),
}));

import { downloadTrack } from "../src/ytdlp/ytdlp";
import { DownloadQueue } from "../src/download/queue";
import { defaultConfig } from "../src/config/config";
import type { Library } from "../src/library/library";

const emptyLib = {
  has: () => false,
  get: () => undefined,
  all: () => [],
  upsert: async () => {},
  flushSync: () => {},
} as unknown as Library;

const song = (id: string) => ({
  source: "soundcloud" as const,
  sourceLabel: "SoundCloud",
  track: { id, title: id, downloadUrl: `https://soundcloud.com/lumen/${id}` },
});

// Every queue here saves to a file of its own, so what these tests assert is
// what is on disk, and the user's saved queue is never touched.
let file: string;
const newQueue = (): DownloadQueue =>
  new DownloadQueue(defaultConfig, emptyLib, 1, undefined, file);

/** The rows the saved queue holds right now; null before any save. */
function onDisk(): string[] | null {
  try {
    const saved = JSON.parse(readFileSync(file, "utf8")) as {
      items: { track: { id: string }; status: string }[];
    };
    return saved.items.map((i) => `${i.track.id}:${i.status}`);
  } catch {
    return null;
  }
}

/** Past the 300 ms the queue waits before it writes a burst of changes. */
const afterTheTimer = () => new Promise((r) => setTimeout(r, 400));

const started = () =>
  vi.waitFor(() => expect(vi.mocked(downloadTrack)).toHaveBeenCalledTimes(1));

/**
 * Holds every write on its way to disk until `arrive` is called, and counts
 * how many are on their way at once.
 */
function slowDisk() {
  const real = fs.writeFile.bind(fs);
  const seen = { now: 0, most: 0 };
  let arrive!: () => void;
  const gate = new Promise<void>((r) => {
    arrive = r;
  });
  vi.spyOn(fs, "writeFile").mockImplementation((async (...args: unknown[]) => {
    seen.now++;
    seen.most = Math.max(seen.most, seen.now);
    await gate;
    seen.now--;
    return (real as (...a: unknown[]) => Promise<void>)(...args);
  }) as never);
  return { seen, arrive };
}

beforeEach(() => {
  file = path.join(
    mkdtempSync(path.join(os.tmpdir(), "soundcli-suspend-")),
    "queue.json",
  );
});

afterEach(async () => {
  // A queue a test left behind may still owe a write: let it land here, not
  // in the middle of the next test's count.
  await afterTheTimer();
  vi.restoreAllMocks();
  vi.mocked(downloadTrack).mockClear();
});

describe("a link queued a second time", () => {
  // What makes serving a handed-over request twice harmless.
  it("adds nothing while the first is waiting or downloading", async () => {
    const queue = newQueue();
    queue.enqueue([song("a"), song("b")]);
    await started();
    expect(queue.enqueue([song("a"), song("b")])).toMatchObject({ added: 0 });
    expect(queue.getItems()).toHaveLength(2);
    expect(vi.mocked(downloadTrack)).toHaveBeenCalledTimes(1);
    queue.cancelAll();
  });
});

describe("a queue writing itself to disk", () => {
  it("never has two writes on their way at once", async () => {
    const disk = slowDisk();
    const queue = newQueue();
    queue.enqueue([song("a")]);
    // The write the timer starts, held up on its way.
    await vi.waitFor(() => expect(disk.seen.now).toBe(1), { timeout: 2000 });

    // Asked for while that one is still going: both use one temp file.
    const asked = queue.saveNow();
    await new Promise((r) => setTimeout(r, 30));
    expect(disk.seen.most).toBe(1);
    disk.arrive();
    expect(await asked).toBe(true);
    expect(disk.seen.most).toBe(1);
    expect(onDisk()).toEqual(["a:pending"]);
    queue.cancelAll();
  });

  it("tells its caller when a write did not reach the disk, and writes the next", async () => {
    const queue = newQueue();
    queue.enqueue([song("a")]);
    vi.spyOn(fs, "writeFile").mockRejectedValueOnce(
      new Error("ENOSPC: no space left on device"),
    );
    // A caller waiting on this to let go of something else must not let go.
    await expect(queue.saveNow()).rejects.toThrow("ENOSPC");
    expect(onDisk()).toBeNull();

    expect(await queue.saveNow()).toBe(true);
    expect(onDisk()).toEqual(["a:pending"]);
    queue.cancelAll();
  });
});

describe("a queue that has been suspended", () => {
  it("writes once, with the download that was in flight, and never again", async () => {
    const queue = newQueue();
    queue.enqueue([song("a"), song("b")]);
    await started();

    expect(queue.suspend()).toBe(true);
    expect(onDisk()).toEqual(["a:pending", "b:pending"]);
    // The aborted download settles as canceled a moment later. A save taken
    // then would no longer hold it, and would replace the one above.
    await afterTheTimer();
    expect(onDisk()).toEqual(["a:pending", "b:pending"]);
  });

  it("starts nothing more, whatever is queued after", async () => {
    const queue = newQueue();
    queue.enqueue([song("a")]);
    await started();

    queue.suspend();
    // A list that was still loading when the quit came hands its tracks over.
    queue.enqueue([song("b")]);
    await new Promise((r) => setTimeout(r, 50));
    expect(vi.mocked(downloadTrack)).toHaveBeenCalledTimes(1);
  });

  it("answers a save asked for after that with false, and writes nothing", async () => {
    const queue = newQueue();
    queue.enqueue([song("a")]);
    await started();
    expect(await queue.saveNow()).toBe(true);
    expect(onDisk()).toEqual(["a:pending"]);

    queue.suspend();
    queue.enqueue([song("b")]);
    expect(await queue.saveNow()).toBe(false);
    expect(onDisk()).toEqual(["a:pending"]);
  });

  it("does not let a write it caught part-way go over the one it made", async () => {
    const disk = slowDisk();
    const queue = newQueue();
    queue.enqueue([song("a")]);
    await started();
    // On its way with only the first song, and slow.
    const asked = queue.saveNow();
    await vi.waitFor(() => expect(disk.seen.now).toBe(1));

    queue.enqueue([song("b")]);
    queue.suspend();
    disk.arrive();
    expect(await asked).toBe(false);
    expect(onDisk()).toEqual(["a:pending", "b:pending"]);
  });

  it("says so when it was told not to write", () => {
    const queue = newQueue();
    queue.enqueue([song("a")]);
    // A run that lost the library to another process: the file is theirs.
    expect(queue.suspend(false)).toBe(false);
    expect(onDisk()).toBeNull();
  });
});
