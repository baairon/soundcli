import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { changeWatches, loadWatches, type Watch } from "../src/cli/watches";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "soundcli-watch-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const watch = (n: number): Watch => ({
  link: `https://soundcloud.com/lumen/sets/tape-${n}`,
  all: false,
  seen: [],
  addedAt: "2026-01-01T00:00:00.000Z",
});

describe("changeWatches", () => {
  it("keeps every change when many commands write at once", async () => {
    // An agent or a script firing several `watch` lines together: each one
    // rewrites the whole list.
    await Promise.all(
      Array.from({ length: 12 }, (_, n) =>
        changeWatches((current) => [...current, watch(n)], dir),
      ),
    );
    expect((await loadWatches(dir)).map((w) => w.link).sort()).toEqual(
      Array.from({ length: 12 }, (_, n) => watch(n).link).sort(),
    );
    expect(await fs.readdir(dir)).toEqual(["watches.json"]);
  });

  it("takes over a lock left by a command that died", async () => {
    const lock = path.join(dir, "watches.json.lock");
    await fs.writeFile(lock, "1");
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(lock, old, old);
    await changeWatches((current) => [...current, watch(1)], dir);
    expect(await loadWatches(dir)).toHaveLength(1);
  });
});
