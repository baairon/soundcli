import { describe, it, expect, vi, afterEach } from "vitest";

// Downloads never run here: the stub leaves rows "downloading" so the tests
// see exactly what the gather queued.
const enumerateMock = vi.fn();
vi.mock("../src/ytdlp/ytdlp", () => ({
  downloadTrack: vi.fn(() => new Promise(() => {})),
  enumerate: (...a: unknown[]) => enumerateMock(...a),
}));

import { enqueueTarget, gatherLists } from "../src/download/gather";
import { DownloadQueue } from "../src/download/queue";
import { defaultConfig } from "../src/config/config";
import type { Library } from "../src/library/library";
import type {
  SourceAdapter,
  SourcePlaylist,
  SourceTrack,
} from "../src/sources/types";

const emptyLib = {
  has: () => false,
  get: () => undefined,
  all: () => [],
} as unknown as Library;

function list(id: string): SourcePlaylist {
  return { id, title: id, url: `https://example.com/${id}`, kind: "playlist" };
}

function track(id: string): SourceTrack {
  return { id, title: id, downloadUrl: id };
}

/** An adapter whose lists resolve to the given tracks, or throw. */
function adapter(
  tracks: Record<string, SourceTrack[] | Error>,
  lists: SourcePlaylist[] = Object.keys(tracks).map(list),
): SourceAdapter {
  return {
    id: "soundcloud",
    label: "SoundCloud",
    listPlaylists: async () => lists,
    listTracks: async (pl) => {
      const t = tracks[pl.id];
      if (t instanceof Error) throw t;
      return t ?? [];
    },
  };
}

afterEach(() => {
  enumerateMock.mockReset();
});

describe("gatherLists", () => {
  it("queues every list's tracks and reports the totals", async () => {
    const q = new DownloadQueue(defaultConfig, emptyLib, 1);
    const progress: string[] = [];
    const r = await gatherLists(
      q,
      adapter({ one: [track("a"), track("b")], two: [track("c")] }),
      [list("one"), list("two")],
      (done, total) => progress.push(`${done}/${total}`),
    );
    expect(r).toMatchObject({ total: 3, added: 3, newTracks: 3, aborted: false });
    expect(r.firstError).toBeUndefined();
    expect(q.getItems().map((i) => i.track.id).sort()).toEqual(["a", "b", "c"]);
    expect(progress.sort()).toEqual(["1/2", "2/2"]);
    // The batch stops counting as "still gathering" once every list is in.
    expect(q.stats().gathering).toBe(false);
    q.cancelAll();
  });

  it("keeps going past a list that fails and names the first failure", async () => {
    const q = new DownloadQueue(defaultConfig, emptyLib, 1);
    const r = await gatherLists(
      q,
      adapter({ bad: new Error("HTTP Error 404"), good: [track("a")] }),
      [list("bad"), list("good")],
    );
    expect(r.added).toBe(1);
    expect(r.firstError).toBe("HTTP Error 404");
    q.cancelAll();
  });

  it("stops feeding a queue that was canceled mid-gather", async () => {
    const q = new DownloadQueue(defaultConfig, emptyLib, 1);
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const slow: SourceAdapter = {
      id: "soundcloud",
      label: "SoundCloud",
      listPlaylists: async () => [list("slow")],
      listTracks: async () => {
        await held;
        return [track("late")];
      },
    };
    const pending = gatherLists(q, slow, [list("slow")]);
    expect(q.stats().gathering).toBe(true);
    q.cancelAll(); // the user cancels while the list is still loading
    release();
    const r = await pending;
    expect(r.aborted).toBe(true);
    expect(r.added).toBe(0);
    expect(q.getItems()).toEqual([]);
  });
});

describe("enqueueTarget", () => {
  it("reads one song and queues it under its source", async () => {
    enumerateMock.mockResolvedValue({
      entries: [
        {
          id: "101",
          title: "Velvet Signal",
          url: "https://soundcloud.com/lumen/velvet-signal",
          uploader: "Circuit Fauna",
        },
      ],
    });
    const q = new DownloadQueue(defaultConfig, emptyLib, 1);
    const r = await enqueueTarget(q, {
      ok: true,
      kind: "track",
      source: "soundcloud",
      url: "https://soundcloud.com/lumen/velvet-signal",
    });
    expect(r).toMatchObject({ total: 1, added: 1, newTracks: 1 });
    expect(q.getItems()[0]).toMatchObject({
      source: "soundcloud",
      sourceLabel: "SoundCloud",
      track: { id: "101", title: "Velvet Signal", owner: "lumen" },
    });
    q.cancelAll();
  });

  it("reports a link that reads as empty instead of throwing", async () => {
    enumerateMock.mockResolvedValue({ entries: [] });
    const q = new DownloadQueue(defaultConfig, emptyLib, 1);
    const r = await enqueueTarget(q, {
      ok: true,
      kind: "track",
      source: "link",
      url: "https://example.com/nothing",
    });
    expect(r.added).toBe(0);
    expect(r.firstError).toMatch(/Couldn't read/);
  });

  it("reports a link the source refuses instead of throwing", async () => {
    enumerateMock.mockRejectedValue(new Error("Unsupported URL"));
    const q = new DownloadQueue(defaultConfig, emptyLib, 1);
    const r = await enqueueTarget(q, {
      ok: true,
      kind: "track",
      source: "link",
      url: "https://example.com/nope",
    });
    expect(r.firstError).toBe("Unsupported URL");
  });

  it("takes only the liked list for a likes link", async () => {
    // The likes feed is listed once and shared by both adapter calls; the
    // created-sets listing comes back empty.
    enumerateMock.mockImplementation(async (url: string) =>
      url.endsWith("/likes")
        ? {
            entries: [
              {
                id: "1",
                title: "Velvet Signal",
                url: "https://soundcloud.com/lumen/velvet-signal",
              },
              {
                id: "2",
                title: "Night Drive",
                url: "https://soundcloud.com/lumen/sets/night-drive",
              },
            ],
          }
        : { entries: [] },
    );
    const q = new DownloadQueue(defaultConfig, emptyLib, 1);
    const r = await enqueueTarget(q, {
      ok: true,
      kind: "lists",
      source: "soundcloud",
      input: "https://soundcloud.com/lumen/likes",
      pick: "liked",
    });
    // The liked set is its own list, so a likes link leaves it alone.
    expect(r).toMatchObject({ total: 1, added: 1 });
    expect(q.getItems()[0]!.track).toMatchObject({
      id: "1",
      playlistTitle: "Liked Songs",
      owner: "lumen",
    });
    q.cancelAll();
  });
});
