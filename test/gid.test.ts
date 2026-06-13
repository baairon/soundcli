import { describe, it, expect } from "vitest";
import { gidFromId } from "../src/sources/spotify/gid";

describe("gidFromId", () => {
  it("decodes a base62 track id to its 32-char hex gid (live-verified vector)", () => {
    // "190jyVPHYjAqEaOGmMzdyk" -> metadata/4 returned "Beauty And A Beat".
    expect(gidFromId("190jyVPHYjAqEaOGmMzdyk")).toBe(
      "25a10c749bd64f24b9d58ebded472f2c",
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
