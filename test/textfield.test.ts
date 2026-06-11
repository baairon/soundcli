import { describe, it, expect } from "vitest";
import {
  deleteBefore,
  deleteWordBefore,
  insertAt,
  killToEnd,
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
});
