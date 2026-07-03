import { describe, it, expect } from "vitest";
import { fuzzyFilter, fuzzyScore } from "../src/util/fuzzy";

describe("fuzzyScore", () => {
  it("matches substrings and non-matches return null", () => {
    expect(fuzzyScore("love", "Lovebird")).not.toBeNull();
    expect(fuzzyScore("xyz", "Lovebird")).toBeNull();
  });

  it("matches in-order subsequences", () => {
    expect(fuzzyScore("lvr", "Lovebird")).not.toBeNull();
    expect(fuzzyScore("rvl", "Lovebird")).toBeNull(); // order matters
  });

  it("folds diacritics", () => {
    expect(fuzzyScore("renee", "Renée")).not.toBeNull();
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
        "(SHADOWFORGE REMIX) 3BLAZE & VIXNIGHT - RISE UP W/ (PROD. ECHO WAVE & MIRAGE) #DemoDrop",
      ),
    ).toBeNull();
    expect(
      fuzzyScore("xxnippet", "democreatorxyz - mixed out (1o) snipp extended"),
    ).toBeNull();
    // Tight typo-distance and initials still match.
    expect(fuzzyScore("xxnippet", "Dj Demo Beat xxnippetz 4")).not.toBeNull();
    expect(fuzzyScore("lvr", "Lovebird")).not.toBeNull();
    expect(fuzzyScore("bts", "Big Time Sadness")).not.toBeNull();
  });
});

describe("fuzzyFilter", () => {
  const items = [
    { title: "Closing Song", artist: "Another Artist" },
    { title: "Lovebird", artist: "Third Artist" },
    { title: "Quiet Song", artist: "Third Artist" },
  ];

  it("returns items untouched for an empty query", () => {
    expect(fuzzyFilter("", items, (t) => [t.title])).toEqual(items);
  });

  it("filters non-matches and puts the best match first", () => {
    const r = fuzzyFilter("lvr", items, (t) => [t.title]);
    expect(r.map((t) => t.title)).toEqual(["Lovebird"]);
  });

  it("scores across multiple keys (artist hits count)", () => {
    const r = fuzzyFilter("third", items, (t) => [t.title, t.artist]);
    expect(r.map((t) => t.title)).toEqual(["Lovebird", "Quiet Song"]);
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
