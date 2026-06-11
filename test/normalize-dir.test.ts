import { describe, it, expect } from "vitest";
import os from "node:os";
import { normalizeDir } from "../src/util/normalize-dir";

describe("normalizeDir", () => {
  it("passes plain paths through, trimmed", () => {
    expect(normalizeDir("C:\\Music")).toBe("C:\\Music");
    expect(normalizeDir("  /home/user/music  ")).toBe("/home/user/music");
  });

  it("strips the quotes drag-and-drop pastes", () => {
    expect(normalizeDir('"C:\\My Music"')).toBe("C:\\My Music");
    expect(normalizeDir("'/home/user/My Music'")).toBe("/home/user/My Music");
    expect(normalizeDir('  "C:\\Music"  ')).toBe("C:\\Music");
  });

  it("expands a leading ~ to the home directory", () => {
    expect(normalizeDir("~")).toBe(os.homedir());
    expect(normalizeDir("~/Music")).toBe(os.homedir() + "/Music");
    expect(normalizeDir("~\\Music")).toBe(os.homedir() + "\\Music");
  });

  it("leaves mid-path tildes and lone quotes alone", () => {
    expect(normalizeDir("/data/~archive")).toBe("/data/~archive");
    expect(normalizeDir('"unterminated')).toBe('"unterminated');
  });

  it("returns an empty string for blank input", () => {
    expect(normalizeDir("")).toBe("");
    expect(normalizeDir("   ")).toBe("");
    expect(normalizeDir('""')).toBe("");
  });
});
