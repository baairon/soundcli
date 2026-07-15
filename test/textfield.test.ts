import { describe, it, expect } from "vitest";
import {
  deleteAt,
  deleteBefore,
  deleteWordAfter,
  deleteWordBefore,
  insertAt,
  killToEnd,
  wordLeft,
  wordRight,
} from "../src/ui/components/TextField";

describe("TextField editing helpers", () => {
  it("deleteBefore removes the char before the cursor", () => {
    expect(deleteBefore("lumen", 5)).toEqual({ value: "lume", cursor: 4 });
    expect(deleteBefore("lumen", 0)).toEqual({ value: "lumen", cursor: 0 });
  });

  it("deleteWordBefore removes the word before the cursor (Ctrl+W)", () => {
    expect(deleteWordBefore("hello world", 11)).toEqual({
      value: "hello ",
      cursor: 6,
    });
    // trailing spaces are eaten along with the word
    expect(deleteWordBefore("hello world   ", 14)).toEqual({
      value: "hello ",
      cursor: 6,
    });
    // keeps the tail after the cursor (only the word is removed, not the space after it)
    expect(deleteWordBefore("one two three", 7)).toEqual({
      value: "one  three",
      cursor: 4,
    });
  });

  it("killToEnd drops everything from the cursor onward (Ctrl+K)", () => {
    expect(killToEnd("hello world", 5)).toEqual({ value: "hello", cursor: 5 });
  });

  it("insertAt inserts text at the cursor", () => {
    expect(insertAt("ac", 1, "b")).toEqual({ value: "abc", cursor: 2 });
  });

  it("deleteAt removes the char under the cursor (Delete)", () => {
    expect(deleteAt("lumen", 0)).toEqual({ value: "umen", cursor: 0 });
    expect(deleteAt("lumen", 2)).toEqual({ value: "luen", cursor: 2 });
    // at the end there is nothing to delete
    expect(deleteAt("lumen", 5)).toEqual({ value: "lumen", cursor: 5 });
    expect(deleteAt("", 0)).toEqual({ value: "", cursor: 0 });
  });

  it("wordLeft jumps to the start of the word before the cursor", () => {
    expect(wordLeft("one two three", 13)).toBe(8);
    expect(wordLeft("one two three", 8)).toBe(4);
    // trailing spaces are skipped before the word
    expect(wordLeft("one two   ", 10)).toBe(4);
    expect(wordLeft("one", 0)).toBe(0);
  });

  it("wordRight jumps past the end of the word after the cursor", () => {
    expect(wordRight("one two three", 0)).toBe(3);
    expect(wordRight("one two three", 3)).toBe(7);
    // leading spaces are skipped before the word
    expect(wordRight("one   two", 3)).toBe(9);
    expect(wordRight("one", 3)).toBe(3);
  });

  it("deleteWordAfter removes the word after the cursor (Ctrl+Delete)", () => {
    expect(deleteWordAfter("one two three", 4)).toEqual({
      value: "one  three",
      cursor: 4,
    });
    // spaces between cursor and word are eaten with it
    expect(deleteWordAfter("one   two", 3)).toEqual({
      value: "one",
      cursor: 3,
    });
    expect(deleteWordAfter("one", 3)).toEqual({ value: "one", cursor: 3 });
  });
});
