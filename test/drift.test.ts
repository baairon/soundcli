import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  displaySource,
  findDuplicates,
  indexAudioByBasename,
  ownerFolderOf,
  playlistFromPath,
  setFolderKey,
  titleFromFilename,
  trackSignature,
} from "../src/library/drift";
import type { Track } from "../src/library/types";

function track(over: Partial<Track>): Track {
  return {
    id: "youtube:x",
    source: "youtube",
    sourceTrackId: "x",
    title: "Say It",
    artist: "Flume",
    filePath: "/nope.mp3",
    addedAt: "2024-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("trackSignature", () => {
  it("is case-insensitive", () => {
    expect(trackSignature({ artist: "Flume", title: "Say It" })).toBe(
      trackSignature({ artist: "flume", title: "say it" }),
    );
  });
  it("ignores the source (same song matches across platforms)", () => {
    const a = track({ source: "youtube" });
    const b = track({ source: "soundcloud" });
    expect(trackSignature(a)).toBe(trackSignature(b));
  });
  it("strips emoji/symbols so decorated titles still match", () => {
    expect(trackSignature({ artist: "Flume", title: "Say It 🔥" })).toBe(
      trackSignature({ artist: "Flume", title: "Say It" }),
    );
  });
  it("distinguishes different songs", () => {
    expect(
      trackSignature({ artist: "Flume", title: "Never Be Like You" }),
    ).not.toBe(trackSignature({ artist: "Flume", title: "Say It" }));
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

describe("playlistFromPath", () => {
  const lib = path.join(os.tmpdir(), "lib");
  const p = (...segs: string[]) => path.join(lib, ...segs);

  it("uses the immediate parent folder", () => {
    expect(playlistFromPath(p("My Mix", "song.mp3"), lib)).toBe("My Mix");
    expect(playlistFromPath(p("a", "Deep", "song.mp3"), lib)).toBe("Deep");
  });
  it("steps past the source root and its owner segment", () => {
    expect(playlistFromPath(p("YouTube", "Chill", "s.mp3"), lib)).toBe("Chill");
    expect(
      playlistFromPath(p("YouTube", "someone", "Chill", "s.mp3"), lib, "someone"),
    ).toBe("Chill");
  });
  it("treats the library root, source roots, and Singles as no playlist", () => {
    expect(playlistFromPath(p("song.mp3"), lib)).toBeUndefined();
    expect(playlistFromPath(p("YouTube", "song.mp3"), lib)).toBeUndefined();
    expect(
      playlistFromPath(p("YouTube", "Singles", "song.mp3"), lib),
    ).toBeUndefined();
  });
  it("leaves files outside the library alone", () => {
    expect(
      playlistFromPath(path.join(os.tmpdir(), "x", "song.mp3"), lib),
    ).toBeUndefined();
  });
});

describe("displaySource", () => {
  const lib = path.join(os.tmpdir(), "lib");
  const at = (...segs: string[]) =>
    track({ filePath: path.join(lib, ...segs) });

  it("follows the top-level folder, not download provenance", () => {
    expect(displaySource(at("YouTube", "Chill", "s.mp3"), lib)).toBe("youtube");
    // A youtube download moved under SoundCloud/ re-tabs as soundcloud.
    expect(displaySource(at("SoundCloud", "Chill", "s.mp3"), lib)).toBe(
      "soundcloud",
    );
    expect(displaySource(at("Links", "s.mp3"), lib)).toBe("link");
  });
  it("reads unrecognized folders and the library root as local", () => {
    expect(displaySource(at("My Mix", "s.mp3"), lib)).toBe("local");
    expect(displaySource(at("s.mp3"), lib)).toBe("local");
  });
  it("falls back to provenance outside the library or without one", () => {
    const outside = track({ filePath: path.join(os.tmpdir(), "x", "s.mp3") });
    expect(displaySource(outside, lib)).toBe("youtube");
    expect(displaySource(at("SoundCloud", "s.mp3"), undefined)).toBe("youtube");
  });
});

describe("ownerFolderOf", () => {
  const lib = path.join(os.tmpdir(), "lib");
  const p = (...segs: string[]) => path.join(lib, ...segs);

  it("names the segment the download layout reserves for the owner", () => {
    expect(ownerFolderOf(p("SoundCloud", "flume", "Liked Songs", "s.m4a"), lib)).toBe("flume");
    expect(ownerFolderOf(p("SoundCloud", "flume", "s.m4a"), lib)).toBe("flume");
  });
  it("is undefined outside a source root or too shallow", () => {
    expect(ownerFolderOf(p("My Mix", "s.mp3"), lib)).toBeUndefined();
    expect(ownerFolderOf(p("SoundCloud", "s.mp3"), lib)).toBeUndefined();
    expect(ownerFolderOf(p("s.mp3"), lib)).toBeUndefined();
    expect(
      ownerFolderOf(path.join(os.tmpdir(), "x", "s.mp3"), lib),
    ).toBeUndefined();
  });
});

describe("setFolderKey", () => {
  const lib = path.join(os.tmpdir(), "lib");
  const at = (...segs: string[]) =>
    track({ filePath: path.join(lib, ...segs) });

  it("groups by the containing folder, ignoring metadata", () => {
    const a = track({
      filePath: path.join(lib, "SoundCloud", "flume", "Liked Songs", "a.m4a"),
      owner: "flume",
    });
    const b = track({
      // Same folder, no owner, other source: still the same set.
      filePath: path.join(lib, "SoundCloud", "flume", "Liked Songs", "b.opus"),
      source: "youtube",
    });
    expect(setFolderKey(a, lib)).toBe(setFolderKey(b, lib));
    expect(setFolderKey(a, lib)).not.toBe(
      setFolderKey(at("SoundCloud", "other", "Liked Songs", "c.m4a"), lib),
    );
  });
  it("folds case so Windows path variants agree", () => {
    expect(setFolderKey(at("Mix", "a.mp3"), lib)).toBe(
      setFolderKey(at("mix", "b.mp3"), lib),
    );
  });
  it("is undefined outside the library or without a library dir", () => {
    const outside = track({ filePath: path.join(os.tmpdir(), "x", "s.mp3") });
    expect(setFolderKey(outside, lib)).toBeUndefined();
    expect(setFolderKey(at("Mix", "a.mp3"), undefined)).toBeUndefined();
  });
});

describe("titleFromFilename", () => {
  it("splits 'Artist - Title' the way downloads write it", () => {
    expect(titleFromFilename("Flume - Say It.mp3")).toEqual({
      title: "Say It",
      artist: "Flume",
    });
  });
  it("keeps later separators inside the title", () => {
    expect(titleFromFilename("A - B - C.opus")).toEqual({
      title: "B - C",
      artist: "A",
    });
  });
  it("falls back to the whole stem", () => {
    expect(titleFromFilename("ambient loop.flac")).toEqual({
      title: "ambient loop",
    });
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
