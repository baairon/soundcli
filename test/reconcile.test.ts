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
    remove: async (id: string) => {
      map.delete(id);
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

    expect(r).toEqual({ prunedMissing: 0, mergedDuplicates: 0, deletedFiles: 0 });
    expect(library.all()).toHaveLength(1);

    await fs.rm(dir, { recursive: true, force: true });
  });
});
