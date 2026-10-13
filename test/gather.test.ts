import { describe, it, expect, vi } from "vitest";

// Downloads never run here: the stub leaves rows "downloading" so the tests
// see exactly what the gather queued.
vi.mock("../src/ytdlp/ytdlp", () => ({
  downloadTrack: vi.fn(() => new Promise(() => {})),
}));

import { gatherLists } from "../src/download/gather";
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
