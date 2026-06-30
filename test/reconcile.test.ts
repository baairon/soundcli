import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { reconcileLibrary } from "../src/library/reconcile";
import type { Library } from "../src/library/library";
import type { Track } from "../src/library/types";

function track(over: Partial<Track>): Track {
  return {
    id: "youtube:x",
    source: "youtube",
    sourceTrackId: "x",
    title: "Ember",
    artist: "Lumen",
    filePath: "/nope.mp3",
    addedAt: "2024-01-01T00:00:00.000Z",
    ...over,
  };
}

/** A minimal in-memory Library (no disk persistence) for testing reconcile. */
function fakeLibrary(tracks: Track[]): Library {
  const map = new Map(tracks.map((t) => [t.id, t]));
  return {
    all: () => [...map.values()],
    get: (id: string) => map.get(id),
    remove: async (id: string) => {
      map.delete(id);
    },
    upsert: async (t: Track) => {
      map.set(t.id, t);
    },
    upsertMany: async (ts: Track[]) => {
      for (const t of ts) map.set(t.id, t);
    },
  } as unknown as Library;
}

describe("reconcileLibrary", () => {
  it("prunes missing files, merges duplicates, and keeps one real copy", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "soundcli-recon-"));
    const kept = path.join(dir, "kept.mp3");
    const dup = path.join(dir, "dup.mp3");
    await fs.writeFile(kept, "audio");
    await fs.writeFile(dup, "audio");
    const gone = path.join(dir, "gone.mp3"); // never created

    const library = fakeLibrary([
      track({ id: "youtube:a", filePath: kept, addedAt: "2024-01-01T00:00:00Z" }),
      track({
        id: "soundcloud:b", // same song, added later → loses
        source: "soundcloud",
        filePath: dup,
        addedAt: "2024-02-01T00:00:00Z",
      }),
      track({ id: "youtube:c", title: "Gone", artist: "X", filePath: gone }),
    ]);

    const r = await reconcileLibrary(library);

    expect(r.prunedMissing).toBe(1);
    expect(r.mergedDuplicates).toBe(1);
    expect(r.deletedFiles).toBe(1);

    // Only the earliest copy survives.
    expect(library.all().map((t) => t.id)).toEqual(["youtube:a"]);
    // The kept file is intact; the redundant one is deleted.
    await expect(fs.access(kept)).resolves.toBeUndefined();
    await expect(fs.access(dup)).rejects.toThrow();

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("is a no-op for a tidy library", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "soundcli-recon-"));
    const f = path.join(dir, "song.mp3");
    await fs.writeFile(f, "audio");

    const library = fakeLibrary([track({ id: "youtube:a", filePath: f })]);
    const r = await reconcileLibrary(library);

    expect(r).toEqual({
      prunedMissing: 0,
      mergedDuplicates: 0,
      deletedFiles: 0,
      relinked: 0,
    });
    expect(library.all()).toHaveLength(1);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("re-links a file moved within the library instead of pruning it", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "soundcli-move-"));
    const moved = path.join(dir, "sub", "song.mp3");
    await fs.mkdir(path.dirname(moved), { recursive: true });
    await fs.writeFile(moved, "audio");
    // The index still points at the old location; only the moved file exists.
    const stale = path.join(dir, "song.mp3");

    const library = fakeLibrary([track({ id: "youtube:a", filePath: stale })]);
    const r = await reconcileLibrary(library, undefined, dir);

    expect(r.relinked).toBe(1);
    expect(r.prunedMissing).toBe(0);
    expect(library.all()[0]!.filePath).toBe(moved);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("still prunes a file that is genuinely gone", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "soundcli-gone-"));
    const library = fakeLibrary([
      track({ id: "youtube:a", filePath: path.join(dir, "ghost.mp3") }),
    ]);
    const r = await reconcileLibrary(library, undefined, dir);

    expect(r.relinked).toBe(0);
    expect(r.prunedMissing).toBe(1);
    expect(library.all()).toHaveLength(0);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("never steals a present track's file when re-linking", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "soundcli-claim-"));
    const present = path.join(dir, "song.mp3");
    await fs.writeFile(present, "audio"); // belongs to a, still on disk

    // b points at a missing path with the same basename; a's file is the only one.
    const library = fakeLibrary([
      track({ id: "youtube:a", filePath: present }),
      track({
        id: "youtube:b",
        title: "Other",
        artist: "Z",
        filePath: path.join(dir, "missing", "song.mp3"),
      }),
    ]);
    const r = await reconcileLibrary(library, undefined, dir);

    // b can't take a's file, so b is pruned and a survives untouched.
    expect(r.relinked).toBe(0);
    expect(r.prunedMissing).toBe(1);
    expect(library.all().map((t) => t.id)).toEqual(["youtube:a"]);
    expect(library.all()[0]!.filePath).toBe(present);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("re-links a renamed file by its recorded content size", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "soundcli-rename-"));
    const renamed = path.join(dir, "a totally different name.mp3");
    await fs.writeFile(renamed, "some audio bytes"); // 16 bytes
    const stale = path.join(dir, "original.mp3"); // gone, different basename

    const library = fakeLibrary([
      track({ id: "youtube:a", filePath: stale, fileSize: 16 }),
    ]);
    const r = await reconcileLibrary(library, undefined, dir);

    expect(r.relinked).toBe(1);
    expect(r.prunedMissing).toBe(0);
    expect(library.all()[0]!.filePath).toBe(renamed);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("prunes a renamed file when no size was ever recorded", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "soundcli-norec-"));
    await fs.writeFile(path.join(dir, "renamed.mp3"), "audio");
    const library = fakeLibrary([
      track({ id: "youtube:a", filePath: path.join(dir, "old.mp3") }), // no fileSize
    ]);
    const r = await reconcileLibrary(library, undefined, dir);

    expect(r.relinked).toBe(0);
    expect(r.prunedMissing).toBe(1);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("backfills file sizes for present tracks so future renames re-link", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "soundcli-size-"));
    const f = path.join(dir, "song.mp3");
    await fs.writeFile(f, "audio"); // 5 bytes
    const library = fakeLibrary([track({ id: "youtube:a", filePath: f })]);

    await reconcileLibrary(library, undefined, dir);

    expect(library.all()[0]!.fileSize).toBe(5);

    await fs.rm(dir, { recursive: true, force: true });
  });
});
