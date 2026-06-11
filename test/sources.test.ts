import { describe, it, expect, vi, beforeEach } from "vitest";

// enumerate is the adapters' only network touchpoint; a url-keyed fake
// drives the whole listing flow. (Lazy deref so hoisting stays happy.)
const enumerateMock = vi.fn();
vi.mock("../src/ytdlp/ytdlp", () => ({
  enumerate: (...a: unknown[]) => enumerateMock(...a),
}));

import { youtubeVideoUrl } from "../src/sources/youtube";
import { normalizeHandle } from "../src/sources/handle";
import {
  isSoundcloudTombstone,
  makeSoundcloud,
} from "../src/sources/soundcloud";
import { tracksFromUrl } from "../src/sources/enqueue-url";

describe("youtubeVideoUrl", () => {
  it("passes through full URLs", () => {
    expect(youtubeVideoUrl("https://www.youtube.com/watch?v=abc")).toBe(
      "https://www.youtube.com/watch?v=abc",
    );
  });
  it("builds a watch URL from a bare id", () => {
    expect(youtubeVideoUrl("dQw4w9WgXcQ")).toBe(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );
  });
});

describe("normalizeHandle", () => {
  it("keeps a bare handle", () => {
    expect(normalizeHandle("lumen")).toBe("lumen");
  });
  it("strips a leading @", () => {
    expect(normalizeHandle("@NASA")).toBe("NASA");
  });
  it("extracts the handle from a full URL", () => {
    expect(normalizeHandle("https://www.youtube.com/@NASA")).toBe("NASA");
    expect(normalizeHandle("https://www.youtube.com/@NASA/playlists")).toBe(
      "NASA",
    );
  });
  it("extracts the handle from a host/path", () => {
    expect(normalizeHandle("soundcloud.com/lumen")).toBe("lumen");
    expect(normalizeHandle("soundcloud.com/lumen/likes")).toBe("lumen");
  });
  it("trims whitespace", () => {
    expect(normalizeHandle("  lumen  ")).toBe("lumen");
  });
});

describe("isSoundcloudTombstone", () => {
  it("flags api-v2 stubs with numeric or missing titles", () => {
    expect(
      isSoundcloudTombstone({
        url: "https://api-v2.soundcloud.com/tracks/900000001",
        title: "900000001",
      }),
    ).toBe(true);
    expect(
      isSoundcloudTombstone({
        url: "https://api-v2.soundcloud.com/tracks/900000001",
        title: "",
      }),
    ).toBe(true);
    expect(
      isSoundcloudTombstone({ url: "https://api.soundcloud.com/tracks/123" }),
    ).toBe(true);
  });

  it("keeps anything with a real name or a real permalink", () => {
    expect(
      isSoundcloudTombstone({
        url: "https://api-v2.soundcloud.com/tracks/900000001",
        title: "Real Song",
      }),
    ).toBe(false);
    // A numeric title behind a normal permalink recovers its name from the
    // slug, so it is downloadable and stays.
    expect(
      isSoundcloudTombstone({
        url: "https://soundcloud.com/artist/123",
        title: "123",
      }),
    ).toBe(false);
    expect(isSoundcloudTombstone({ title: "123" })).toBe(false);
  });
});

describe("soundcloud tombstone filtering", () => {
  beforeEach(() => {
    enumerateMock.mockReset();
  });

  const likes = {
    title: "Likes",
    entries: [
      {
        id: "1",
        title: "Real Song",
        url: "https://soundcloud.com/artist/real-song",
        uploader: "artist",
        duration: 100,
      },
      {
        id: "900000001",
        title: "900000001",
        url: "https://api-v2.soundcloud.com/tracks/900000001",
      },
      {
        id: "2",
        title: "999",
        url: "https://soundcloud.com/artist/numeric-name",
        uploader: "artist",
      },
    ],
  };

  it("drops tombstones from Liked Songs and keeps slug-titled tracks", async () => {
    enumerateMock.mockImplementation(async (url: string) =>
      url.endsWith("/likes") ? likes : { title: "", entries: [] },
    );
    const sc = makeSoundcloud("user");
    const lists = await sc.listPlaylists();
    const liked = lists.find((l) => l.kind === "liked")!;
    expect(liked.count).toBe(2);

    const tracks = await sc.listTracks(liked);
    expect(tracks.map((t) => t.id)).toEqual(["1", "2"]);
    // The numeric-titled real track got its name back from the URL slug.
    expect(tracks[1]!.title.toLowerCase()).toContain("numeric");
  });

  it("drops tombstones from a pasted likes feed", async () => {
    enumerateMock.mockResolvedValue(likes);
    const tracks = await tracksFromUrl(
      "soundcloud",
      "https://soundcloud.com/user/likes",
    );
    expect(tracks.map((t) => t.id)).toEqual(["1", "2"]);
  });
});
