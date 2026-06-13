import { describe, it, expect } from "vitest";
import { gidFromId } from "../src/sources/spotify/gid";

describe("gidFromId", () => {
  it("decodes a base62 track id to its 32-char hex gid (computed vector)", () => {
    // a synthetic vector, computed against the real gidFromId implementation.
    expect(gidFromId("0fAkEtRaCk1D0000000abc")).toBe(
      "08428230d7ce24860143a3c2e112acde",
    );
  });

  it("zero-pads short ids to a full 16-byte hex string", () => {
    expect(gidFromId("0")).toBe("0".repeat(32));
    expect(gidFromId("1")).toHaveLength(32);
  });

  it("throws on a non-base62 character", () => {
    expect(() => gidFromId("not!valid")).toThrow();
  });
});
