import { describe, it, expect } from "vitest";
import { adapterFor, resolveLink } from "../src/sources/resolve-link";

describe("resolveLink", () => {
  it("sends a single song straight to a download", () => {
    expect(resolveLink("https://www.youtube.com/watch?v=abc123")).toEqual({
      ok: true,
      kind: "track",
      source: "youtube",
      url: "https://www.youtube.com/watch?v=abc123",
    });
    expect(resolveLink("soundcloud.com/lumen/velvet-signal")).toEqual({
      ok: true,
      kind: "track",
      source: "soundcloud",
      url: "https://soundcloud.com/lumen/velvet-signal",
    });
    expect(
      resolveLink("https://open.spotify.com/track/abc123xyz"),
    ).toMatchObject({ ok: true, kind: "track", source: "spotify" });
  });

  it("sends an unknown site through as a generic link", () => {
    expect(resolveLink("https://example.com/audio/demo")).toEqual({
      ok: true,
      kind: "track",
      source: "link",
      url: "https://example.com/audio/demo",
    });
  });

  it("takes a playlist, set or album as that one collection", () => {
    for (const [link, source] of [
      ["https://www.youtube.com/playlist?list=PLdemo123", "youtube"],
      ["https://www.youtube.com/watch?v=abc123&list=PLdemo123", "youtube"],
      ["https://soundcloud.com/lumen/sets/night-drive", "soundcloud"],
      ["https://open.spotify.com/album/abc", "spotify"],
      ["https://open.spotify.com/playlist/00000000000000000000AA", "spotify"],
    ] as const) {
      expect(resolveLink(link)).toEqual({
        ok: true,
        kind: "lists",
        source,
        input: link,
        pick: "single",
      });
    }
  });

  it("takes a likes link as the liked list alone, with or without --all", () => {
    const want = {
      ok: true,
      kind: "lists",
      source: "soundcloud",
      input: "https://soundcloud.com/lumen/likes",
      pick: "liked",
    };
    expect(resolveLink("https://soundcloud.com/lumen/likes")).toEqual(want);
    expect(
      resolveLink("https://soundcloud.com/lumen/likes", { all: true }),
    ).toEqual(want);
  });

  it("refuses a whole profile until --all says so", () => {
    for (const link of [
      "https://soundcloud.com/lumen",
      "https://www.youtube.com/@NASA",
      "https://open.spotify.com/user/lumen",
    ]) {
      const refused = resolveLink(link);
      expect(refused.ok).toBe(false);
      expect(!refused.ok && refused.reason).toMatch(/--all/);
      expect(resolveLink(link, { all: true })).toMatchObject({
        ok: true,
        kind: "lists",
        pick: "all",
        input: link,
      });
    }
  });

  it("reads an artist's uploads as the one list they are", async () => {
    for (const [source, link, url] of [
      [
        "soundcloud",
        "soundcloud.com/vesper/tracks",
        "https://soundcloud.com/vesper/tracks",
      ],
      [
        "youtube",
        "https://www.youtube.com/@Vesper/videos?view=0",
        "https://www.youtube.com/@Vesper/videos",
      ],
    ] as const) {
      // No --all needed: it is one list, not the whole profile.
      expect(resolveLink(link)).toEqual({
        ok: true,
        kind: "lists",
        source,
        input: link,
        pick: "single",
      });
      const lists = await adapterFor(source, link).listPlaylists();
      expect(lists.map((l) => l.url)).toEqual([url]);
    }
  });

  it("refuses a bare handle, which names no site", () => {
    const r = resolveLink("lumen");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/full URL/);
    expect(resolveLink("   ").ok).toBe(false);
  });

  it("passes on the reason for a link it recognizes but cannot use", () => {
    const r = resolveLink("https://www.youtube.com/channel/UCdemo");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/channel link/);
  });
});

describe("adapterFor", () => {
  it("picks the adapter for each source", () => {
    expect(adapterFor("youtube", "NASA").id).toBe("youtube");
    expect(adapterFor("soundcloud", "lumen").id).toBe("soundcloud");
    expect(adapterFor("spotify", "lumen").id).toBe("spotify");
  });

  it("gives Spotify no owner, since no Spotify track is ever filed under one", () => {
    // The picker counts what is saved under the adapter's owner, and found
    // nothing when this named one the tracks never carry.
    expect(adapterFor("spotify", "lumen").owner).toBeUndefined();
    expect(
      adapterFor("spotify", "https://open.spotify.com/user/lumen_fm").owner,
    ).toBeUndefined();
  });
});
