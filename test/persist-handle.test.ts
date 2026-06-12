import { describe, it, expect } from "vitest";
import {
  persistableHandle,
  persistDecision,
} from "../src/sources/persist-handle";
import { effectiveKind } from "../src/sources/detect";

describe("effectiveKind", () => {
  it("treats SoundCloud set paths as collections for persistence", () => {
    const d = {
      ok: true as const,
      source: "soundcloud" as const,
      kind: "profile" as const,
      value: "flume",
    };
    expect(
      effectiveKind("https://soundcloud.com/flume/sets/my-set", d),
    ).toBe("collection");
    expect(effectiveKind("https://soundcloud.com/flume/likes", d)).toBe(
      "profile",
    );
  });
});

describe("persistDecision", () => {
  it("accepts identities for handle-based sources", () => {
    expect(persistDecision("youtube", "NASA")).toEqual({
      persist: true,
      value: "NASA",
    });
    expect(persistDecision("youtube", "https://www.youtube.com/@NASA")).toEqual(
      { persist: true, value: "NASA" },
    );
    expect(
      persistDecision("soundcloud", "https://soundcloud.com/flume/likes"),
    ).toEqual({ persist: true, value: "flume" });
    expect(
      persistDecision("spotify", "https://open.spotify.com/user/spotify"),
    ).toEqual({ persist: true, value: "spotify" });
    expect(persistDecision("spotify", "@myuser")).toEqual({
      persist: true,
      value: "myuser",
    });
  });

  it("rejects resource pointers", () => {
    for (const [source, url] of [
      ["youtube", "https://www.youtube.com/playlist?list=PLabc"],
      ["youtube", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
      ["soundcloud", "https://soundcloud.com/flume/sets/my-set"],
      ["soundcloud", "https://soundcloud.com/artist/cool-track"],
      ["spotify", "https://open.spotify.com/playlist/abc"],
    ] as const) {
      expect(persistDecision(source, url)).toMatchObject({
        persist: false,
        reason: "resource",
      });
    }
  });

  it("rejects link-only sources", () => {
    expect(persistDecision("link", "https://example.com/song")).toEqual({
      persist: false,
      reason: "no_identity_field",
    });
  });

  it("rejects cross-source paste into the wrong field", () => {
    expect(
      persistDecision(
        "soundcloud",
        "https://www.youtube.com/playlist?list=PLabc",
      ),
    ).toEqual({ persist: false, reason: "wrong_source" });
    expect(
      persistDecision("youtube", "https://soundcloud.com/flume"),
    ).toEqual({ persist: false, reason: "wrong_source" });
  });

  it("rejects invalid and unrecognized URLs", () => {
    expect(persistDecision("youtube", "https://on.soundcloud.com/x")).toEqual({
      persist: false,
      reason: "wrong_source",
    });
    expect(persistDecision("youtube", "https://not-a-real-host.foo/bar")).toEqual(
      { persist: false, reason: "unrecognized_url" },
    );
  });
});

describe("persistableHandle", () => {
  it("matches persistDecision", () => {
    expect(persistableHandle("youtube", "@flume")).toBe("flume");
    expect(persistableHandle("soundcloud", "@flume")).toBe("flume");
    expect(persistableHandle("spotify", "@flume")).toBe("flume");
    expect(persistableHandle("youtube", "")).toBeUndefined();
  });
});
