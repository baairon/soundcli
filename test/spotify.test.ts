import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the resilient fetch so the public reader hits an injected fake, never
// the network. We assert call counts to prove the TTL cache avoids re-fetching.
const fetchResilientMock = vi.fn();
vi.mock("../src/util/net", () => ({
  fetchResilient: (...args: unknown[]) => fetchResilientMock(...args),
}));

import { spotifySearchQuery, makeSpotify } from "../src/sources/spotify/adapter";
import {
  parseSpotifyInput,
  readPublicPlaylist,
  readPublicAlbum,
  readPublicTrack,
  readPublicEntity,
  clearSpotifyCache,
} from "../src/sources/spotify/public";
import { sanitizeName } from "../src/ytdlp/args";

/** Build an embed HTML page with the __NEXT_DATA__ trackList the reader parses. */
function embedHtml(
  name: string,
  tracks: Array<{ id: string; title: string; subtitle?: string; duration?: number }>,
): string {
  const next = {
    props: {
      pageProps: {
        state: {
          data: {
            entity: {
              name,
              title: name,
              trackList: tracks.map((t) => ({
                uri: `spotify:track:${t.id}`,
                title: t.title,
                subtitle: t.subtitle ?? "",
                duration: t.duration,
              })),
            },
          },
        },
      },
    },
  };
  return `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
    next,
  )}</script></body></html>`;
}

function okResponse(html: string): Response {
  return {
    ok: true,
    status: 200,
    text: async () => html,
  } as unknown as Response;
}

beforeEach(() => {
  fetchResilientMock.mockReset();
  clearSpotifyCache();
});

describe("parseSpotifyInput", () => {
  it("parses playlist URLs, URIs, and bare ids", () => {
    expect(
      parseSpotifyInput(
        "https://open.spotify.com/playlist/00000000000000000000AA?si=x",
      ),
    ).toEqual({ type: "playlist", id: "00000000000000000000AA" });
    expect(parseSpotifyInput("spotify:playlist:00000000000000000000AA")).toEqual(
      { type: "playlist", id: "00000000000000000000AA" },
    );
    expect(parseSpotifyInput("00000000000000000000AA")).toEqual({
      type: "playlist",
      id: "00000000000000000000AA",
    });
  });

  it("detects profile links", () => {
    expect(parseSpotifyInput("https://open.spotify.com/user/spotify")).toEqual({
      type: "user",
      id: "spotify",
    });
  });

  it("flags junk input", () => {
    expect(parseSpotifyInput("hello there").type).toBe("unknown");
  });
});

describe("spotifySearchQuery", () => {
  it("builds a ytsearch1 query from artist + title", () => {
    expect(spotifySearchQuery({ artist: "Circuit Fauna", title: "Velvet Signal" })).toBe(
      "ytsearch1:Circuit Fauna Velvet Signal",
    );
  });
});

describe("sanitizeName", () => {
  it("replaces illegal filename characters", () => {
    expect(sanitizeName('a/b:c*d?"e<f>g|h')).toBe("a_b_c_d__e_f_g_h");
  });
  it("falls back to a default for empty names", () => {
    expect(sanitizeName("   ")).toBe("track");
  });
});

describe("readPublicEntity (tokenless embed reader)", () => {
  it("reads a playlist's name and tracks via fetchResilient", async () => {
    fetchResilientMock.mockResolvedValue(
      okResponse(
        embedHtml("My Mix", [
          { id: "t1", title: "Song One", subtitle: "Artist A", duration: 200000 },
          { id: "t2", title: "Song Two", subtitle: "Artist B" },
        ]),
      ),
    );
    const pl = await readPublicPlaylist("PL123");
    expect(pl.name).toBe("My Mix");
    expect(pl.tracks).toHaveLength(2);
    expect(pl.tracks[0]).toMatchObject({
      id: "t1",
      title: "Song One",
      artist: "Artist A",
      durationMs: 200000,
    });
    // The embed URL is the playlist embed.
    expect(fetchResilientMock.mock.calls[0]?.[0]).toBe(
      "https://open.spotify.com/embed/playlist/PL123",
    );
  });

  it("caches by type:id so the same entity is fetched only once", async () => {
    fetchResilientMock.mockResolvedValue(
      okResponse(embedHtml("Cached", [{ id: "t1", title: "One" }])),
    );
    await readPublicPlaylist("SAME");
    await readPublicPlaylist("SAME"); // should hit the in-memory cache
    expect(fetchResilientMock).toHaveBeenCalledTimes(1);
  });

  it("reads album and track embeds with the right URL", async () => {
    fetchResilientMock.mockResolvedValue(
      okResponse(embedHtml("An Album", [{ id: "a1", title: "Track" }])),
    );
    await readPublicAlbum("ALB1");
    expect(fetchResilientMock.mock.calls[0]?.[0]).toBe(
      "https://open.spotify.com/embed/album/ALB1",
    );

    fetchResilientMock.mockResolvedValue(
      okResponse(embedHtml("A Single", [{ id: "s1", title: "Hit" }])),
    );
    const tr = await readPublicTrack("TRK1");
    expect(fetchResilientMock.mock.calls[1]?.[0]).toBe(
      "https://open.spotify.com/embed/track/TRK1",
    );
    expect(tr.tracks[0]?.title).toBe("Hit");
  });

  it("throws a typed error on a non-ok response", async () => {
    fetchResilientMock.mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => "",
    } as unknown as Response);
    await expect(readPublicEntity("playlist", "GONE")).rejects.toThrow(/404/);
  });
});

describe("makeSpotify adapter (album / track links + cache reuse)", () => {
  it("lists and reads an album link without a redundant fetch", async () => {
    fetchResilientMock.mockResolvedValue(
      okResponse(
        embedHtml("Nightform", [
          { id: "d1", title: "Solar Drift", subtitle: "Circuit Fauna", duration: 200000 },
        ]),
      ),
    );
    const adapter = makeSpotify("https://open.spotify.com/album/ALBUMID");
    const playlists = await adapter.listPlaylists();
    expect(playlists[0]).toMatchObject({
      title: "Nightform",
      kind: "album",
      url: "spotify:album:ALBUMID",
    });

    const tracks = await adapter.listTracks(playlists[0]!);
    expect(tracks[0]).toMatchObject({
      title: "Solar Drift",
      artist: "Circuit Fauna",
      downloadUrl: "ytsearch1:Circuit Fauna Solar Drift",
    });
    // listPlaylists + listTracks share the cache: only one fetch total.
    expect(fetchResilientMock).toHaveBeenCalledTimes(1);
  });

  it("handles a single-track link", async () => {
    fetchResilientMock.mockResolvedValue(
      okResponse(embedHtml("Solo", [{ id: "x1", title: "Solo Song", subtitle: "Artist" }])),
    );
    const adapter = makeSpotify("spotify:track:TRACKID");
    const playlists = await adapter.listPlaylists();
    expect(playlists[0]?.url).toBe("spotify:track:TRACKID");
    const tracks = await adapter.listTracks(playlists[0]!);
    expect(tracks[0]?.title).toBe("Solo Song");
  });
});
