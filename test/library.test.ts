import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs, readFileSync, rmSync } from "node:fs";

// The index file is a constant, so the suite points it at a temp folder: no
// test here may write the user's own library.
const tmp = await vi.hoisted(async () => {
  const os = await import("node:os");
  const path = await import("node:path");
  const { mkdtempSync } = await import("node:fs");
  const dir = mkdtempSync(path.join(os.tmpdir(), "soundcli-lib-"));
  return { dir, file: path.join(dir, "library.json") };
});
vi.mock("../src/config/paths", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/paths")>()),
  libraryIndexFile: tmp.file,
}));

import { Library } from "../src/library/library";
import type { Track } from "../src/library/types";

const track = (id: string): Track => ({
  id: `youtube:${id}`,
  source: "youtube",
  sourceTrackId: id,
  title: `Song ${id}`,
  filePath: `/music/${id}.m4a`,
  addedAt: "2026-01-01T00:00:00.000Z",
});

const onDisk = (): string[] =>
  Object.keys(JSON.parse(readFileSync(tmp.file, "utf8")).tracks).sort();

/** Past the 500 ms the library waits before it writes a burst of changes. */
const afterTheTimer = () => new Promise((r) => setTimeout(r, 560));

beforeEach(() => {
  rmSync(tmp.file, { force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Library, writing its index", () => {
  it("has everything on disk at quit while an earlier write is still on its way", async () => {
    const real = fs.writeFile.bind(fs);
    // A slow disk: the write the timer starts takes a while to land.
    vi.spyOn(fs, "writeFile").mockImplementation((async (...args: unknown[]) => {
      await new Promise((r) => setTimeout(r, 200));
      return (real as (...a: unknown[]) => Promise<void>)(...args);
    }) as never);

    const library = await Library.load();
    await library.upsert(track("a"));
    await afterTheTimer();
    // The timer has started its write and nothing has changed since, which is
    // how a run that had just saved its last song looked when it quit.
    library.flushSync();

    expect(onDisk()).toEqual(["youtube:a"]);
  });

  it("never lets a slow older write land over a newer one", async () => {
    const real = fs.writeFile.bind(fs);
    vi.spyOn(fs, "writeFile").mockImplementation((async (...args: unknown[]) => {
      await new Promise((r) => setTimeout(r, 200));
      return (real as (...a: unknown[]) => Promise<void>)(...args);
    }) as never);

    const library = await Library.load();
    await library.upsert(track("a"));
    await afterTheTimer();
    await library.upsert(track("b"));
    library.flushSync();
    expect(onDisk()).toEqual(["youtube:a", "youtube:b"]);

    // The earlier write finishes now, holding only the first song.
    await new Promise((r) => setTimeout(r, 400));
    expect(onDisk()).toEqual(["youtube:a", "youtube:b"]);
  });

  it("keeps writing after one write fails", async () => {
    const real = fs.rename.bind(fs);
    let failed = false;
    vi.spyOn(fs, "rename").mockImplementation((async (from: string, to: string) => {
      if (!failed) {
        failed = true;
        throw Object.assign(new Error("EPERM: operation not permitted, rename"), {
          code: "EPERM",
        });
      }
      return real(from, to);
    }) as never);

    const library = await Library.load();
    await library.upsert(track("a"));
    await afterTheTimer();
    await library.upsert(track("b"));

    // However long the disk takes: the second write is what has to land.
    await vi.waitFor(
      () => expect(onDisk()).toEqual(["youtube:a", "youtube:b"]),
      { timeout: 5000, interval: 25 },
    );
  });
});
