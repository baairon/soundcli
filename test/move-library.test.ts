import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  moveLibraryDir,
  retargetTracks,
  validateMoveRoots,
  type MoveProgress,
} from "../src/library/move-library";
import type { Track } from "../src/library/types";

let base: string;
let oldRoot: string;
let newRoot: string;

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "sndcli-move-"));
  oldRoot = path.join(base, "old");
  newRoot = path.join(base, "new");
});

afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

async function seed(files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(oldRoot, rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content, "utf8");
  }
}

const exists = (p: string) =>
  fs.access(p).then(
    () => true,
    () => false,
  );

/** A rename that always fails, forcing the per-file copy+delete path. */
const noRename = async (): Promise<void> => {
  throw Object.assign(new Error("EXDEV: cross-device link"), {
    code: "EXDEV",
  });
};

const SEED = {
  "SetA/owner1/Song One.mp3": "one",
  "SetA/owner1/Song Two.mp3": "two",
  "SetB/Song Three.mp3": "three",
  "Song Four.mp3": "four",
};

describe("moveLibraryDir", () => {
  it("moves everything wholesale on the same volume", async () => {
    await seed(SEED);
    const ticks: MoveProgress[] = [];
    const result = await moveLibraryDir(oldRoot, newRoot, {
      onProgress: (p) => ticks.push(p),
    });
    expect(result.totalFiles).toBe(4);
    expect(result.movedFiles).toBe(4);
    expect(result.failures).toEqual([]);
    expect(await exists(path.join(newRoot, "SetA/owner1/Song One.mp3"))).toBe(
      true,
    );
    expect(await exists(path.join(newRoot, "Song Four.mp3"))).toBe(true);
    expect(await exists(oldRoot)).toBe(false); // emptied and removed
    expect(ticks.at(-1)).toEqual({ movedFiles: 4, totalFiles: 4 });
  });

  it("falls back to per-file copy+delete when rename fails (cross-device)", async () => {
    await seed(SEED);
    const ticks: MoveProgress[] = [];
    const result = await moveLibraryDir(oldRoot, newRoot, {
      rename: noRename,
      onProgress: (p) => ticks.push(p),
    });
    expect(result.movedFiles).toBe(4);
    expect(result.failures).toEqual([]);
    expect(
      await fs.readFile(path.join(newRoot, "SetB/Song Three.mp3"), "utf8"),
    ).toBe("three");
    expect(await exists(oldRoot)).toBe(false);
    // Per-file ticks are monotonic and end at the total.
    const counts = ticks.map((t) => t.movedFiles);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    expect(counts.at(-1)).toBe(4);
  });

  it("merges into a non-empty target, overwriting same-name files", async () => {
    await seed({ "SetA/Song One.mp3": "fresh" });
    await fs.mkdir(path.join(newRoot, "SetA"), { recursive: true });
    await fs.writeFile(path.join(newRoot, "SetA/Song One.mp3"), "stale");
    await fs.writeFile(path.join(newRoot, "Keep.mp3"), "keep");
    const result = await moveLibraryDir(oldRoot, newRoot);
    expect(result.movedFiles).toBe(1);
    expect(result.failures).toEqual([]);
    expect(
      await fs.readFile(path.join(newRoot, "SetA/Song One.mp3"), "utf8"),
    ).toBe("fresh");
    expect(await fs.readFile(path.join(newRoot, "Keep.mp3"), "utf8")).toBe(
      "keep",
    );
  });

  it("records failures and keeps going", async () => {
    await seed(SEED);
    // A plain FILE occupies the path where the "SetA" DIR must land, so that
    // entry can't move; everything else still must.
    await fs.mkdir(newRoot, { recursive: true });
    await fs.writeFile(path.join(newRoot, "SetA"), "roadblock");
    const result = await moveLibraryDir(oldRoot, newRoot, {
      rename: noRename,
    });
    expect(result.failures.length).toBeGreaterThan(0);
    expect(result.movedFiles).toBeLessThan(result.totalFiles);
    expect(await exists(path.join(newRoot, "Song Four.mp3"))).toBe(true);
    expect(await exists(oldRoot)).toBe(true); // not emptied, stays
  });

  it("treats a missing old folder as an empty move", async () => {
    const result = await moveLibraryDir(oldRoot, newRoot);
    expect(result).toEqual({ movedFiles: 0, totalFiles: 0, failures: [] });
  });
});

describe("retargetTracks", () => {
  const track = (id: string, filePath: string): Track => ({
    id: `local:${id}`,
    source: "local",
    sourceTrackId: id,
    title: `Sample ${id}`,
    filePath,
    addedAt: "2026-01-01T00:00:00.000Z",
  });

  it("retargets moved files, keeps unmoved and outside-root tracks", async () => {
    await fs.mkdir(path.join(newRoot, "SetA"), { recursive: true });
    await fs.writeFile(path.join(newRoot, "SetA", "Song One.mp3"), "x");
    const moved = track("900000001", path.join(oldRoot, "SetA", "Song One.mp3"));
    const unmoved = track("900000002", path.join(oldRoot, "SetA", "Gone.mp3"));
    const outside = track("900000003", path.join(base, "elsewhere", "Song.mp3"));
    const changed = await retargetTracks(
      [moved, unmoved, outside],
      oldRoot,
      newRoot,
    );
    expect(changed).toHaveLength(1);
    expect(changed[0]!.id).toBe("local:900000001");
    expect(changed[0]!.filePath).toBe(
      path.join(newRoot, "SetA", "Song One.mp3"),
    );
  });

  it("retargets when the old root carries a trailing separator", async () => {
    await fs.mkdir(path.join(newRoot, "SetA"), { recursive: true });
    await fs.writeFile(path.join(newRoot, "SetA", "Song One.mp3"), "x");
    const t = track("900000004", path.join(oldRoot, "SetA", "Song One.mp3"));
    const changed = await retargetTracks([t], oldRoot + path.sep, newRoot);
    expect(changed).toHaveLength(1);
    expect(changed[0]!.filePath).toBe(
      path.join(newRoot, "SetA", "Song One.mp3"),
    );
  });
});

describe("validateMoveRoots", () => {
  it("rejects the same folder and nesting in both directions", () => {
    const root = path.join(base, "music");
    expect(validateMoveRoots(root, root)).toMatch(/already/);
    expect(validateMoveRoots(root, path.join(root, "inner"))).toMatch(
      /inside/,
    );
    expect(validateMoveRoots(path.join(root, "inner"), root)).toMatch(
      /contain/,
    );
  });

  it("accepts siblings", () => {
    expect(
      validateMoveRoots(path.join(base, "a"), path.join(base, "b")),
    ).toBeNull();
  });

  it.runIf(process.platform === "win32")(
    "folds case on windows",
    () => {
      expect(
        validateMoveRoots("C:\\Music\\soundcli", "c:\\music\\SOUNDCLI\\sub"),
      ).toMatch(/inside/);
    },
  );

  // APFS is case-insensitive by default; the fold must catch this on a mac.
  it.runIf(process.platform === "darwin")("folds case on macOS", () => {
    expect(
      validateMoveRoots("/Users/kip/Music/soundcli", "/users/kip/music/SOUNDCLI/sub"),
    ).toMatch(/inside/);
    expect(
      validateMoveRoots("/Users/kip/Music/soundcli", "/users/kip/music/SOUNDCLI"),
    ).toMatch(/already/);
  });
});

describe("symlinks", () => {
  it.runIf(process.platform !== "win32")(
    "recreates links in the copy fallback instead of copying through them",
    async () => {
      await seed({ "SetA/Song One.mp3": "one" });
      const target = path.join(oldRoot, "SetA", "Song One.mp3");
      await fs.symlink(target, path.join(oldRoot, "Linked.mp3"));
      const result = await moveLibraryDir(oldRoot, newRoot, {
        rename: noRename,
      });
      expect(result.failures).toEqual([]);
      expect(result.movedFiles).toBe(2); // the file and the link
      expect(await fs.readlink(path.join(newRoot, "Linked.mp3"))).toBe(target);
      expect(await exists(oldRoot)).toBe(false);
    },
  );
});
