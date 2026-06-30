import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findDuplicates,
  indexAudioByBasename,
  trackSignature,
} from "../src/library/drift";
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

describe("trackSignature", () => {
  it("is case-insensitive", () => {
    expect(trackSignature({ artist: "Lumen", title: "Ember" })).toBe(
      trackSignature({ artist: "lumen", title: "ember" }),
    );
  });
  it("ignores the source (same song matches across platforms)", () => {
    const a = track({ source: "youtube" });
    const b = track({ source: "soundcloud" });
    expect(trackSignature(a)).toBe(trackSignature(b));
  });
  it("strips emoji/symbols so decorated titles still match", () => {
    expect(trackSignature({ artist: "Lumen", title: "Ember 🔥" })).toBe(
      trackSignature({ artist: "Lumen", title: "Ember" }),
    );
  });
  it("distinguishes different songs", () => {
    expect(
      trackSignature({ artist: "Lumen", title: "Glass Harbor" }),
    ).not.toBe(trackSignature({ artist: "Lumen", title: "Ember" }));
  });
});

describe("findDuplicates", () => {
  it("groups two entries of the same song and ignores singletons", () => {
    const dupes = findDuplicates([
      track({ id: "youtube:a" }),
      track({ id: "soundcloud:b" }),
      track({ id: "youtube:c", title: "Different", artist: "Other" }),
    ]);
    expect(dupes).toHaveLength(1);
    expect(dupes[0]!.tracks).toHaveLength(2);
  });
});

describe("indexAudioByBasename", () => {
  it("groups nested audio by basename and skips non-audio files", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "soundcli-scan-"));
    await fs.mkdir(path.join(dir, "a", "b"), { recursive: true });
    await fs.writeFile(path.join(dir, "a", "song.mp3"), "x");
    await fs.writeFile(path.join(dir, "a", "b", "song.mp3"), "x");
    await fs.writeFile(path.join(dir, "a", "cover.jpg"), "x");
    await fs.writeFile(path.join(dir, "a", "notes.json"), "x");

    const map = await indexAudioByBasename(dir);
    expect(map.get("song.mp3")?.length).toBe(2);
    expect(map.has("cover.jpg")).toBe(false);
    expect(map.has("notes.json")).toBe(false);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns an empty map for a missing directory", async () => {
    const map = await indexAudioByBasename(
      path.join(os.tmpdir(), "soundcli-does-not-exist-zzz"),
    );
    expect(map.size).toBe(0);
  });
});
