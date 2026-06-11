import { describe, it, expect } from "vitest";
import {
  describePasteLink,
  detectInput,
  detectPasteLink,
  isLinkInput,
  siteFromUrl,
} from "../src/sources/detect";
import { ownerFromTrackUrl } from "../src/sources/enqueue-url";

describe("detectInput", () => {
  it("detects YouTube @handle links as profiles", () => {
    for (const input of [
      "https://www.youtube.com/@NASA",
      "https://youtube.com/@NASA",
      "youtube.com/@NASA",
      "https://m.youtube.com/@NASA/playlists",
      "https://music.youtube.com/@NASA",
      "YOUTUBE.COM/@NASA",
    ]) {
      expect(detectInput(input)).toEqual({
        ok: true,
        source: "youtube",
        kind: "profile",
        value: "NASA",
      });
    }
  });

  it("accepts legacy bare YouTube vanity paths as profiles", () => {
    expect(detectInput("youtube.com/somename")).toEqual({
      ok: true,
      source: "youtube",
      kind: "profile",
      value: "somename",
    });
  });

  it("detects YouTube video and short links as single tracks", () => {
    expect(detectInput("https://www.youtube.com/watch?v=abc123")).toEqual({
      ok: true,
      source: "youtube",
      kind: "track",
      value: "https://www.youtube.com/watch?v=abc123",
    });
    expect(detectInput("youtube.com/watch?v=abc123")).toEqual({
      ok: true,
      source: "youtube",
      kind: "track",
      value: "https://youtube.com/watch?v=abc123",
    });
    expect(detectInput("https://youtu.be/abc123")).toEqual({
      ok: true,
      source: "youtube",
      kind: "track",
      value: "https://www.youtube.com/watch?v=abc123",
    });
    expect(detectInput("https://youtube.com/shorts/xyz")).toEqual({
      ok: true,
      source: "youtube",
      kind: "track",
      value: "https://youtube.com/shorts/xyz",
    });
  });

  it("detects YouTube playlist links as collections", () => {
    expect(detectInput("https://youtube.com/playlist?list=PLxyz")).toEqual({
      ok: true,
      source: "youtube",
      kind: "collection",
      value: "https://youtube.com/playlist?list=PLxyz",
    });
  });

  it("refuses raw YouTube channel links with a hint", () => {
    for (const input of [
      "https://www.youtube.com/channel/UCabc123",
      "https://youtube.com/c/somename",
      "https://youtube.com/user/somename",
      "https://www.youtube.com/",
      "https://youtube.com/playlist",
    ]) {
      const d = detectInput(input);
      expect(d).not.toBeNull();
      expect(d).toMatchObject({ ok: false, source: "youtube" });
    }
  });

  it("detects SoundCloud profile links as profiles", () => {
    for (const input of [
      "https://soundcloud.com/somehandle",
      "soundcloud.com/somehandle/likes",
      "https://www.soundcloud.com/somehandle/sets/some-set",
      "https://m.soundcloud.com/somehandle",
    ]) {
      expect(detectInput(input)).toEqual({
        ok: true,
        source: "soundcloud",
        kind: "profile",
        value: "somehandle",
      });
    }
  });

  it("detects SoundCloud song links as single tracks", () => {
    expect(
      detectInput("https://soundcloud.com/artist-name/cool-song"),
    ).toEqual({
      ok: true,
      source: "soundcloud",
      kind: "track",
      value: "https://soundcloud.com/artist-name/cool-song",
    });
    expect(detectInput("soundcloud.com/lumen/some-track")).toEqual({
      ok: true,
      source: "soundcloud",
      kind: "track",
      value: "https://soundcloud.com/lumen/some-track",
    });
  });

  it("refuses SoundCloud site pages and short links", () => {
    for (const input of [
      "https://soundcloud.com/discover",
      "https://soundcloud.com/search?q=x",
      "https://soundcloud.com/",
      "https://on.soundcloud.com/abc",
    ]) {
      const d = detectInput(input);
      expect(d).not.toBeNull();
      expect(d).toMatchObject({ ok: false, source: "soundcloud" });
    }
  });

  it("detects Spotify playlists, albums, and tracks", () => {
    const playlist = "https://open.spotify.com/playlist/00000000000000000000AA";
    expect(detectInput(playlist)).toEqual({
      ok: true,
      source: "spotify",
      kind: "collection",
      value: playlist,
    });
    expect(detectInput("open.spotify.com/album/abc")).toEqual({
      ok: true,
      source: "spotify",
      kind: "collection",
      value: "https://open.spotify.com/album/abc",
    });
    expect(detectInput("https://open.spotify.com/track/abc123xyz")).toEqual({
      ok: true,
      source: "spotify",
      kind: "track",
      value: "https://open.spotify.com/track/abc123xyz",
    });
    expect(detectInput("spotify:track:abc123xyz012345678901")).toEqual({
      ok: true,
      source: "spotify",
      kind: "track",
      value: "spotify:track:abc123xyz012345678901",
    });
    expect(detectInput("spotify:playlist:00000000000000000000AA")).toEqual({
      ok: true,
      source: "spotify",
      kind: "collection",
      value: "spotify:playlist:00000000000000000000AA",
    });
  });

  it("returns null for bare handles and unrecognized hosts", () => {
    expect(detectInput("somehandle")).toBeNull();
    expect(detectInput("@somehandle")).toBeNull();
    expect(detectInput("")).toBeNull();
    expect(detectInput("   ")).toBeNull();
    expect(detectInput("https://example.com/whatever")).toBeNull();
    expect(detectInput("bandcamp.com/artist")).toBeNull();
  });
});

describe("detectPasteLink", () => {
  it("rejects bare handles", () => {
    expect(detectPasteLink("lumen")).toEqual({
      ok: false,
      reason: "Not a link yet · paste a full URL.",
    });
    expect(isLinkInput("lumen")).toBe(false);
    expect(isLinkInput("https://soundcloud.com/a/b")).toBe(true);
  });

  it("downloads known single-track links into their source folder", () => {
    expect(detectPasteLink("https://youtu.be/abc123")).toEqual({
      ok: true,
      action: "download",
      source: "youtube",
      url: "https://www.youtube.com/watch?v=abc123",
    });
    expect(detectPasteLink("https://soundcloud.com/artist/cool-song")).toEqual({
      ok: true,
      action: "download",
      source: "soundcloud",
      url: "https://soundcloud.com/artist/cool-song",
    });
  });

  it("downloads unknown hosts as generic Links", () => {
    expect(detectPasteLink("https://bandcamp.com/artist/track")).toEqual({
      ok: true,
      action: "download",
      source: "link",
      url: "https://bandcamp.com/artist/track",
    });
    expect(siteFromUrl("https://www.tiktok.com/@x/video/1")).toBe("tiktok.com");
  });

  it("rejects profile links: paste is one song only", () => {
    expect(detectPasteLink("https://youtube.com/@NASA")).toMatchObject({
      ok: false,
      source: "youtube",
    });
    expect(detectPasteLink("soundcloud.com/somehandle/likes")).toMatchObject({
      ok: false,
      source: "soundcloud",
    });
  });

  it("rejects playlist and album links: paste is one song only", () => {
    expect(
      detectPasteLink("https://open.spotify.com/playlist/00000000000000000000AA"),
    ).toMatchObject({ ok: false, source: "spotify" });
    expect(detectPasteLink("open.spotify.com/album/abc")).toMatchObject({
      ok: false,
      source: "spotify",
    });
    expect(
      detectPasteLink("https://youtube.com/playlist?list=PLxyz"),
    ).toMatchObject({ ok: false, source: "youtube" });
  });

  it("surfaces known-host pages it can't use instead of falling through", () => {
    // A raw channel link must never flat-download a whole channel into Links/.
    expect(
      detectPasteLink("https://www.youtube.com/channel/UCabc"),
    ).toMatchObject({ ok: false, source: "youtube" });
    expect(detectPasteLink("https://soundcloud.com/discover")).toMatchObject({
      ok: false,
      source: "soundcloud",
    });
  });

  it("accepts SoundCloud short links and lets yt-dlp resolve them", () => {
    expect(detectPasteLink("https://on.soundcloud.com/abc")).toEqual({
      ok: true,
      action: "download",
      source: "soundcloud",
      url: "https://on.soundcloud.com/abc",
    });
  });
});

describe("describePasteLink", () => {
  it("previews known sources with their destination folder", () => {
    expect(describePasteLink("https://youtu.be/abc123")).toEqual({
      tone: "download",
      text: "YouTube song · saves to YouTube/Singles",
    });
    expect(
      describePasteLink("https://soundcloud.com/lumen/some-track"),
    ).toEqual({
      tone: "download",
      text: "SoundCloud song · saves to SoundCloud/lumen/Singles",
    });
    expect(describePasteLink("spotify:track:abc123xyz012345678901")).toEqual({
      tone: "download",
      text: "Spotify song · saves to Spotify/…",
    });
    expect(describePasteLink("https://on.soundcloud.com/abc")).toEqual({
      tone: "download",
      text: "SoundCloud link · saves to SoundCloud/…",
    });
  });

  it("previews unknown hosts as Links/<site>", () => {
    expect(describePasteLink("https://www.tiktok.com/@x/video/1")).toEqual({
      tone: "download",
      text: "One song · saves to Links/tiktok.com",
    });
  });

  it("warns on profile and playlist links", () => {
    expect(describePasteLink("https://youtube.com/@NASA")).toMatchObject({
      tone: "warn",
    });
    expect(
      describePasteLink("https://youtube.com/playlist?list=PLxyz"),
    ).toMatchObject({ tone: "warn" });
  });

  it("warns on unusable known-host pages and guides on non-links", () => {
    expect(
      describePasteLink("https://www.youtube.com/channel/UCabc"),
    ).toMatchObject({ tone: "warn" });
    expect(describePasteLink("lumen")).toEqual({
      tone: "dim",
      text: "Not a link yet · paste a full URL.",
    });
    expect(describePasteLink("")).toBeNull();
  });
});

describe("ownerFromTrackUrl", () => {
  it("reads the artist from SoundCloud track URLs only", () => {
    expect(
      ownerFromTrackUrl("soundcloud", "https://soundcloud.com/Lumen/some-track"),
    ).toBe("lumen");
    // YouTube watch/shorts paths carry no owner: "watch" must never become
    // a folder (the old YouTube/watch/Singles bug).
    expect(
      ownerFromTrackUrl("youtube", "https://www.youtube.com/watch?v=abc123"),
    ).toBeUndefined();
    expect(
      ownerFromTrackUrl("youtube", "https://youtube.com/shorts/xyz"),
    ).toBeUndefined();
    expect(
      ownerFromTrackUrl("spotify", "https://open.spotify.com/track/abc"),
    ).toBeUndefined();
    expect(
      ownerFromTrackUrl("link", "https://bandcamp.com/a/b"),
    ).toBeUndefined();
  });
});
