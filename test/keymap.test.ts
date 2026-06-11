import { describe, it, expect } from "vitest";
import { sectionForDigit } from "../src/ui/keymap";

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
