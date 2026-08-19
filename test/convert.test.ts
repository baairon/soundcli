import { describe, it, expect } from "vitest";
import path from "node:path";
import { mp3MirroredPath } from "../src/library/convert";
import type { Track } from "../src/library/types";

function track(filePath: string): Track {
  return {
    id: "youtube:test",
    source: "youtube",
    sourceTrackId: "test",
    title: "Test",
    filePath,
    addedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("mp3MirroredPath", () => {
  it("mirrors the source/owner/playlist folder structure under mp3/", () => {
    const lib = path.posix.join("/lib");
    const t = track(
      path.posix.join(lib, "YouTube", "@nasa", "My Playlist", "Song.opus"),
    );
    expect(mp3MirroredPath(lib, t)).toBe(
      path.posix.join(lib, "mp3", "YouTube", "@nasa", "My Playlist", "Song.mp3"),
    );
  });

  it("mirrors a Singles track without a playlist folder", () => {
    const lib = path.posix.join("/lib");
    const t = track(path.posix.join(lib, "SoundCloud", "lumen", "Singles", "Track.m4a"));
    expect(mp3MirroredPath(lib, t)).toBe(
      path.posix.join(lib, "mp3", "SoundCloud", "lumen", "Singles", "Track.mp3"),
    );
  });

  it("falls back to a flat basename when the file is outside the library", () => {
    const lib = path.posix.join("/lib");
    const t = track(path.posix.join("/elsewhere", "Song.opus"));
    expect(mp3MirroredPath(lib, t)).toBe(
      path.posix.join(lib, "mp3", "Song.mp3"),
    );
  });

  it("swaps any extension to .mp3", () => {
    const lib = path.posix.join("/lib");
    const t = track(path.posix.join(lib, "YouTube", "Singles", "Song.webm"));
    expect(mp3MirroredPath(lib, t).endsWith("Song.mp3")).toBe(true);
  });
});
