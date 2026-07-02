import { describe, it, expect } from "vitest";
import { footerHints, sectionForDigit } from "../src/ui/keymap";

describe("sectionForDigit", () => {
  it("maps 1-6 to the sidebar's display order", () => {
    expect(sectionForDigit("1")).toBe("library");
    expect(sectionForDigit("2")).toBe("playlists");
    expect(sectionForDigit("3")).toBe("history");
    expect(sectionForDigit("4")).toBe("download");
    expect(sectionForDigit("5")).toBe("progress");
    expect(sectionForDigit("6")).toBe("settings");
  });

  it("ignores everything else", () => {
    expect(sectionForDigit("0")).toBeNull();
    expect(sectionForDigit("7")).toBeNull();
    expect(sectionForDigit("a")).toBeNull();
    expect(sectionForDigit("")).toBeNull();
    expect(sectionForDigit("12")).toBeNull();
  });
});

describe("footerHints", () => {
  it("lists source tabs for library and playlists sets view", () => {
    for (const section of ["library", "playlists"] as const) {
      const keys = footerHints("content", section).map((h) => h.keys);
      expect(keys).toContain("[ ]");
      expect(keys).toContain("/");
    }
  });

  it("drops set-only keys on playlists drill-down", () => {
    const keys = footerHints("content", "playlists", "songs").map((h) => h.keys);
    expect(keys).toContain("↵");
    expect(keys).toContain("esc");
    expect(keys).toContain("/");
    expect(keys).not.toContain("[ ]");
  });
});
