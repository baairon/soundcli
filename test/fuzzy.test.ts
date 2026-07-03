import { describe, it, expect } from "vitest";
import { fuzzyFilter, fuzzyScore } from "../src/util/fuzzy";

describe("fuzzyScore", () => {
  it("matches substrings and non-matches return null", () => {
    expect(fuzzyScore("love", "Lover")).not.toBeNull();
    expect(fuzzyScore("xyz", "Lover")).toBeNull();
  });

  it("matches in-order subsequences", () => {
    expect(fuzzyScore("lvr", "Lover")).not.toBeNull();
    expect(fuzzyScore("rvl", "Lover")).toBeNull(); // order matters
  });

  it("folds diacritics", () => {
    expect(fuzzyScore("beyonce", "Beyoncé")).not.toBeNull();
    expect(fuzzyScore("uber", "Über Song")).not.toBeNull();
  });

  it("ranks substring above scattered subsequence", () => {
    const sub = fuzzyScore("night", "Late Night Song")!;
    const seq = fuzzyScore("night", "Naiveight...")!;
    expect(sub).toBeGreaterThan(seq);
  });

  it("ranks a word-aligned hit above a mid-word hit", () => {
    const aligned = fuzzyScore("song", "Song Two")!;
    const midWord = fuzzyScore("song", "Birdsong")!;
    expect(aligned).toBeGreaterThan(midWord);
  });

  it("empty query matches everything neutrally", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
    expect(fuzzyScore("   ", "anything")).toBe(0);
  });

  it("rejects letters scattered across a long title", () => {
    // Every character of "xxnippet" appears in order somewhere in here, but
    // that is noise, not a match.
    expect(
      fuzzyScore(
        "xxnippet",
        "(TENEBRIXX XXILVAM MIX) 2SHANEZ & XHRIS2EAZY - PULL UP W/ (PROD. NIKO EAST & XANGANG) #TeamSonic",
      ),
    ).toBeNull();
    expect(
      fuzzyScore("xxnippet", "xaviersobased - mixed out (1o) snipp extended"),
    ).toBeNull();
    // Tight typo-distance and initials still match.
    expect(fuzzyScore("xxnippet", "Dj Slur Beat xxnippetz 4")).not.toBeNull();
    expect(fuzzyScore("lvr", "Lover")).not.toBeNull();
    expect(fuzzyScore("bts", "Big Time Sadness")).not.toBeNull();
  });
});

describe("fuzzyFilter", () => {
  const items = [
    { title: "Closing Song", artist: "Another Artist" },
    { title: "Lover", artist: "Third Artist" },
    { title: "Quiet Song", artist: "Third Artist" },
  ];

  it("returns items untouched for an empty query", () => {
    expect(fuzzyFilter("", items, (t) => [t.title])).toEqual(items);
  });

  it("filters non-matches and puts the best match first", () => {
    const r = fuzzyFilter("lvr", items, (t) => [t.title]);
    expect(r.map((t) => t.title)).toEqual(["Lover"]);
  });

  it("scores across multiple keys (artist hits count)", () => {
    const r = fuzzyFilter("third", items, (t) => [t.title, t.artist]);
    expect(r.map((t) => t.title)).toEqual(["Lover", "Quiet Song"]);
  });

  it("ranks earlier hits first, and keeps incoming order on true ties", () => {
    const r = fuzzyFilter("song", items, (t) => [t.title]);
    // "Quiet Song" hits at index 6, "Closing Song" at 8: earlier wins.
    expect(r.map((t) => t.title)).toEqual(["Quiet Song", "Closing Song"]);
    const tied = fuzzyFilter(
      "song",
      [{ title: "Song One" }, { title: "Song Two" }],
      (t) => [t.title],
    );
    expect(tied.map((t) => t.title)).toEqual(["Song One", "Song Two"]);
  });

  it("skips undefined keys", () => {
    const r = fuzzyFilter("x", [{ a: undefined }], () => [undefined]);
    expect(r).toEqual([]);
  });
});
