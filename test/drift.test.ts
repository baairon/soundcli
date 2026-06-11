import { describe, it, expect } from "vitest";
import { findDuplicates, trackSignature } from "../src/library/drift";
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
