import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { deleteTracks } from "../src/library/delete";
import type { Track } from "../src/library/types";

function track(id: string, filePath: string): Track {
  return {
    id,
    source: "youtube",
    sourceTrackId: id,
    title: id,
    filePath,
    addedAt: new Date().toISOString(),
  };
}

/** Records removals instead of touching the user's real index file. */
class FakeLibrary {
  removed: string[] = [];
  async removeMany(ids: string[]): Promise<void> {
    this.removed.push(...ids);
  }
}

async function makeTree(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "soundcli-delete-"));
  await fs.mkdir(path.join(root, "YouTube", "Singles"), { recursive: true });
  await fs.mkdir(path.join(root, "SoundCloud", "lumen", "Liked Songs"), {
    recursive: true,
  });
  await fs.writeFile(path.join(root, "YouTube", "Singles", "a.m4a"), "a");
  await fs.writeFile(
    path.join(root, "SoundCloud", "lumen", "Liked Songs", "b.m4a"),
    "b",
  );
  await fs.writeFile(
    path.join(root, "SoundCloud", "lumen", "Liked Songs", "c.m4a"),
    "c",
  );
  return root;
}

const exists = (p: string) =>
  fs.access(p).then(
    () => true,
    () => false,
  );

describe("deleteTracks", () => {
  it("removes the file, prunes empty folders, and drops the index entry", async () => {
    const root = await makeTree();
    try {
      const lib = new FakeLibrary();
      const t = track("youtube:a", path.join(root, "YouTube", "Singles", "a.m4a"));
      const r = await deleteTracks(lib, [t], root);
      expect(r).toEqual({ removed: 1, failed: 0 });
      expect(await exists(t.filePath)).toBe(false);
      // The emptied Singles and YouTube folders are pruned; the root survives.
      expect(await exists(path.join(root, "YouTube"))).toBe(false);
      expect(await exists(root)).toBe(true);
      expect(lib.removed).toEqual(["youtube:a"]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps folders that still hold songs, then prunes once emptied", async () => {
    const root = await makeTree();
    try {
      const lib = new FakeLibrary();
      const dir = path.join(root, "SoundCloud", "lumen", "Liked Songs");
      await deleteTracks(lib, [track("b", path.join(dir, "b.m4a"))], root);
      expect(await exists(dir)).toBe(true);
      const r = await deleteTracks(lib, [track("c", path.join(dir, "c.m4a"))], root);
      expect(r).toEqual({ removed: 1, failed: 0 });
      expect(await exists(path.join(root, "SoundCloud"))).toBe(false);
      expect(lib.removed).toEqual(["b", "c"]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("deletes a whole set in one call", async () => {
    const root = await makeTree();
    try {
      const lib = new FakeLibrary();
      const dir = path.join(root, "SoundCloud", "lumen", "Liked Songs");
      const r = await deleteTracks(
        lib,
        [track("b", path.join(dir, "b.m4a")), track("c", path.join(dir, "c.m4a"))],
        root,
      );
      expect(r).toEqual({ removed: 2, failed: 0 });
      expect(await exists(path.join(root, "SoundCloud"))).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("treats an already-missing file as removed", async () => {
    const root = await makeTree();
    try {
      const lib = new FakeLibrary();
      const t = track(
        "youtube:gone",
        path.join(root, "YouTube", "Singles", "gone.m4a"),
      );
      const r = await deleteTracks(lib, [t], root);
      expect(r).toEqual({ removed: 1, failed: 0 });
      expect(lib.removed).toEqual(["youtube:gone"]);
      // a.m4a still lives there, so the folder stays.
      expect(await exists(path.join(root, "YouTube", "Singles"))).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("never prunes folders outside the library root", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "soundcli-out-"));
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "soundcli-root-"));
    try {
      const lib = new FakeLibrary();
      const f = path.join(outside, "x.m4a");
      await fs.writeFile(f, "x");
      const r = await deleteTracks(lib, [track("x", f)], root);
      expect(r).toEqual({ removed: 1, failed: 0 });
      expect(await exists(outside)).toBe(true);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
