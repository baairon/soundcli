import { describe, it, expect } from "vitest";
import { footerHints, sectionForDigit } from "../src/ui/keymap";

describe("sectionForDigit", () => {
  it("maps 1-5 to the sidebar's display order", () => {
    expect(sectionForDigit("1")).toBe("library");
    expect(sectionForDigit("2")).toBe("playlists");
    expect(sectionForDigit("3")).toBe("history");
    expect(sectionForDigit("4")).toBe("download");
    expect(sectionForDigit("5")).toBe("settings");
  });

  it("ignores everything else", () => {
    expect(sectionForDigit("0")).toBeNull();
    expect(sectionForDigit("6")).toBeNull();
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

  it("includes rename key for library and playlists", () => {
    const libraryKeys = footerHints("content", "library").map((h) => h.keys);
    expect(libraryKeys).toContain("t");

    const playlistsKeys = footerHints("content", "playlists", "sets").map((h) => h.keys);
    expect(playlistsKeys).toContain("t");

    const songsKeys = footerHints("content", "playlists", "songs").map((h) => h.keys);
    expect(songsKeys).toContain("t");
  });

  it("drops set-only keys on playlists drill-down", () => {
    const keys = footerHints("content", "playlists", "songs").map((h) => h.keys);
    expect(keys).toContain("↵");
    expect(keys).toContain("esc");
    expect(keys).toContain("/");
    expect(keys).not.toContain("[ ]");
  });

  it("advertises tab pane switching in every variant", () => {
    const sidebarKeys = footerHints("sidebar", "library").map((h) => h.keys);
    expect(sidebarKeys).toContain("tab");
    for (const section of [
      "library",
      "playlists",
      "history",
      "download",
      "settings",
    ] as const) {
      const keys = footerHints("content", section).map((h) => h.keys);
      expect(keys).toContain("tab");
    }
    const songsKeys = footerHints("content", "playlists", "songs").map(
      (h) => h.keys,
    );
    expect(songsKeys).toContain("tab");
  });

  it("hints esc only where it isn't just a pane switch", () => {
    // In these sections esc mirrors tab (back to sidebar), so the slot is tab's.
    for (const section of ["library", "download", "settings"] as const) {
      const keys = footerHints("content", section).map((h) => h.keys);
      expect(keys).not.toContain("esc");
    }
    // Songs depth keeps esc: there it steps back to the sets list.
    const songsKeys = footerHints("content", "playlists", "songs").map(
      (h) => h.keys,
    );
    expect(songsKeys).toContain("esc");
  });
});
