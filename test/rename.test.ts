import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { renamePlaylist, renameTrack } from "../src/library/rename";
import type { Track } from "../src/library/types";

function track(id: string, filePath: string, extra?: Partial<Track>): Track {
  return {
    id,
    source: "soundcloud",
    sourceTrackId: id,
    title: id,
    filePath,
    addedAt: new Date().toISOString(),
    ...extra,
  };
}

/** Records upserts instead of touching the user's real index file. */
class FakeLibrary {
  upserted: Track[] = [];
  async upsert(t: Track): Promise<void> {
    this.upserted.push(t);
  }
  async upsertMany(ts: Track[]): Promise<void> {
    this.upserted.push(...ts);
  }
}

const exists = (p: string) =>
  fs.access(p).then(
    () => true,
    () => false,
  );

async function makeSet(): Promise<{ root: string; dir: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "soundcli-ren-"));
  const dir = path.join(root, "SoundCloud", "flume", "Old Mix");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "Flume - First.m4a"), "1");
  await fs.writeFile(path.join(dir, "Flume - Second.m4a"), "2");
  return { root, dir };
}

describe("renameTrack", () => {
  it("moves the file, keeps the Artist - Title shape, and updates the index", async () => {
    const { dir } = await makeSet();
    const lib = new FakeLibrary();
    const t = track("sc:1", path.join(dir, "Flume - First.m4a"), {
      title: "First",
      artist: "Flume",
    });
    expect(await renameTrack(lib, t, "Opening Song")).toBe("renamed");
    const moved = path.join(dir, "Flume - Opening Song.m4a");
    expect(await exists(moved)).toBe(true);
    expect(await exists(t.filePath)).toBe(false);
    expect(lib.upserted[0]).toMatchObject({
      title: "Opening Song",
      filePath: moved,
    });
  });

  it("sanitizes characters that are illegal in filenames", async () => {
    const { dir } = await makeSet();
    const lib = new FakeLibrary();
    const t = track("sc:1", path.join(dir, "Flume - First.m4a"), {
      title: "First",
    });
    expect(await renameTrack(lib, t, 'Say: "why?" <now>')).toBe("renamed");
    const moved = path.join(dir, "Say_ _why__ _now_.m4a");
    expect(await exists(moved)).toBe(true);
    // The display title keeps its punctuation; only the filename is sanitized.
    expect(lib.upserted[0]?.title).toBe('Say: "why?" <now>');
  });

  it("refuses to overwrite another track's file on collision", async () => {
    const { dir } = await makeSet();
    const lib = new FakeLibrary();
    const t = track("sc:1", path.join(dir, "Flume - First.m4a"), {
      title: "First",
      artist: "Flume",
    });
    expect(await renameTrack(lib, t, "Second")).toBe("collision");
    // Both files intact, nothing written to the index.
    expect(await exists(path.join(dir, "Flume - First.m4a"))).toBe(true);
    expect(await fs.readFile(path.join(dir, "Flume - Second.m4a"), "utf8")).toBe(
      "2",
    );
    expect(lib.upserted).toEqual([]);
  });

  it("leaves the index untouched when the move fails", async () => {
    const { dir } = await makeSet();
    const lib = new FakeLibrary();
    const t = track("sc:x", path.join(dir, "Flume - Gone.m4a"), {
      title: "Gone",
      artist: "Flume",
    });
    expect(await renameTrack(lib, t, "Still Gone")).toBe("failed");
    expect(lib.upserted).toEqual([]);
  });

  it("is a noop for an empty or unchanged title", async () => {
    const { dir } = await makeSet();
    const lib = new FakeLibrary();
    const t = track("sc:1", path.join(dir, "Flume - First.m4a"), {
      title: "First",
    });
    expect(await renameTrack(lib, t, "   ")).toBe("noop");
    expect(await renameTrack(lib, t, "First")).toBe("noop");
    expect(lib.upserted).toEqual([]);
  });
});

describe("renamePlaylist", () => {
  it("renames the folder in one move and re-points every track", async () => {
    const { root, dir } = await makeSet();
    const lib = new FakeLibrary();
    const ts = [
      track("sc:1", path.join(dir, "Flume - First.m4a"), { playlist: "Old Mix" }),
      track("sc:2", path.join(dir, "Flume - Second.m4a"), { playlist: "Old Mix" }),
    ];
    expect(await renamePlaylist(lib, ts, "New Mix")).toBe("renamed");
    const newDir = path.join(root, "SoundCloud", "flume", "New Mix");
    expect(await exists(newDir)).toBe(true);
    // The old folder is gone entirely, not left behind empty.
    expect(await exists(dir)).toBe(false);
    expect(lib.upserted.map((t) => t.filePath).sort()).toEqual([
      path.join(newDir, "Flume - First.m4a"),
      path.join(newDir, "Flume - Second.m4a"),
    ]);
    expect(lib.upserted.every((t) => t.playlist === "New Mix")).toBe(true);
  });

  it("refuses to merge into an existing playlist folder", async () => {
    const { root, dir } = await makeSet();
    await fs.mkdir(path.join(root, "SoundCloud", "flume", "Taken"), {
      recursive: true,
    });
    const lib = new FakeLibrary();
    const ts = [
      track("sc:1", path.join(dir, "Flume - First.m4a"), { playlist: "Old Mix" }),
    ];
    expect(await renamePlaylist(lib, ts, "Taken")).toBe("collision");
    expect(await exists(dir)).toBe(true);
    expect(lib.upserted).toEqual([]);
  });

  it("sanitizes the new folder name", async () => {
    const { root, dir } = await makeSet();
    const lib = new FakeLibrary();
    const ts = [
      track("sc:1", path.join(dir, "Flume - First.m4a"), { playlist: "Old Mix" }),
    ];
    expect(await renamePlaylist(lib, ts, "A/B: Sides?")).toBe("renamed");
    expect(
      await exists(path.join(root, "SoundCloud", "flume", "A_B_ Sides_")),
    ).toBe(true);
    // The display name keeps its punctuation; only the folder is sanitized.
    expect(lib.upserted[0]?.playlist).toBe("A/B: Sides?");
  });
});
