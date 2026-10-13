import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// The invariant behind every case here: a second sync right after a first has
// nothing left to do, across a library check, and nothing was deleted to get
// there. Songs that kept coming back all broke it the same way: something
// treated two tracks as one because of what they were called.

beforeAll(() => {
  process.env.SOUNDCLI_RETRY_BASE_MS = "0";
  process.env.SOUNDCLI_YT_GAP_MS = "0";
});

interface Served {
  id: string;
  artist: string;
  title: string;
  /** The id the downloader reports, when it is not the one the feed listed. */
  metaId?: string;
  /** A path to report instead of saving anything. */
  misreport?: string;
}

// What each download URL serves, and every id that was really fetched.
const net = vi.hoisted(() => ({
  songs: new Map<string, Served>(),
  fetched: [] as string[],
}));

// A stand-in for yt-dlp that behaves like it where it matters here: it names
// the file "<artist> - <title>", and when that file is already there it
// fetches nothing and reports the existing one as this download.
vi.mock("../src/ytdlp/ytdlp", async () => {
  const { existsSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { sanitizeName } = await import("../src/ytdlp/args");
  return {
    enumerate: vi.fn(async () => ({ entries: [] })),
    downloadTrack: vi.fn(
      async (p: {
        url: string;
        config: { libraryDir: string };
        sourceLabel: string;
        fixedStem?: string;
        playlistName?: string;
        owner?: string;
        distinct?: boolean;
      }) => {
        const song = net.songs.get(p.url);
        if (!song) throw new Error(`no such song: ${p.url}`);
        const meta = {
          id: song.metaId ?? song.id,
          title: song.title,
          artist: song.artist,
        };
        if (song.misreport) {
          return {
            status: "downloaded",
            meta: { ...meta, filepath: song.misreport },
          };
        }
        const folder = join(
          p.config.libraryDir,
          p.sourceLabel,
          ...(p.fixedStem || !p.owner ? [] : [sanitizeName(p.owner)]),
          sanitizeName(p.playlistName ?? "Singles"),
        );
        const stem =
          p.fixedStem ??
          `${song.artist} - ${song.title}${p.distinct ? ` [${song.id}]` : ""}`;
        const filepath = join(folder, `${sanitizeName(stem)}.m4a`);
        if (!existsSync(filepath)) {
          mkdirSync(folder, { recursive: true });
          // The audio is the track's id, so a test can tell whose file it is.
          writeFileSync(filepath, song.id);
          net.fetched.push(song.id);
        }
        return { status: "downloaded", meta: { ...meta, filepath } };
      },
    ),
  };
});

vi.mock("../src/sources/spotify/resolve", () => ({
  resolveSpotifyDownloadUrl: async (t: { downloadUrl: string }) => t.downloadUrl,
}));

import { DownloadQueue } from "../src/download/queue";
import { migrateOwnerLayout } from "../src/library/migrate";
import { reconcileLibrary } from "../src/library/reconcile";
import { defaultConfig } from "../src/config/config";
import type { Library } from "../src/library/library";
import { SOURCE_LABELS, type SourceId, type Track } from "../src/library/types";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "soundcli-id-"));
  net.songs.clear();
  net.fetched.length = 0;
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** An in-memory library: nothing here may reach the real index file. */
function memoryLibrary(seed: Track[] = []): Library {
  const map = new Map(seed.map((t) => [t.id, t]));
  let version = 0;
  return {
    getVersion: () => version,
    has: (id: string) => map.has(id),
    get: (id: string) => map.get(id),
    all: () => [...map.values()],
    upsert: async (t: Track) => {
      map.set(t.id, t);
      version++;
    },
    upsertMany: async (ts: Track[]) => {
      for (const t of ts) map.set(t.id, t);
      version++;
    },
    remove: async (id: string) => {
      map.delete(id);
      version++;
    },
  } as unknown as Library;
}

interface Where {
  /** Who uploaded it; the feed itself carries no artist unless told to. */
  artist: string;
  feedArtist?: string;
  owner?: string;
  playlist?: string;
  metaId?: string;
  misreport?: string;
}

/** One feed entry, also registered as something the platform serves. */
function listed(source: SourceId, id: string, title: string, at: Where) {
  const downloadUrl = `${source}:${id}`;
  net.songs.set(downloadUrl, {
    id,
    artist: at.artist,
    title,
    metaId: at.metaId,
    misreport: at.misreport,
  });
  return {
    source,
    sourceLabel: SOURCE_LABELS[source],
    track: {
      id,
      title,
      artist: at.feedArtist,
      downloadUrl,
      owner: at.owner,
      playlistTitle: at.playlist,
    },
  };
}

type Feed = ReturnType<typeof listed>[];

/** A user with handles configured, as anyone who lists their own likes has. */
const config = () => ({
  ...defaultConfig,
  libraryDir: root,
  soundcloudHandle: "lumen",
  youtubeHandle: "lumen",
});

/** A sync from a fresh start: list the feed, queue it, wait for it to settle. */
async function sync(lib: Library, feed: Feed) {
  const before = net.fetched.length;
  const queue = new DownloadQueue(config(), lib, 1);
  const r = queue.enqueue(feed);
  await vi.waitFor(
    () => {
      const s = queue.stats();
      expect(s.pending + s.downloading).toBe(0);
    },
    { timeout: 5000, interval: 5 },
  );
  return { ...r, fetched: net.fetched.slice(before), failed: queue.stats().failed };
}

async function audio(dir = root): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await audio(full)));
    else out.push(path.relative(root, full));
  }
  return out.sort();
}

/** What a start-up does to the library: the owner migration, then the check. */
async function check(lib: Library): Promise<void> {
  const seen = new Map<string, boolean>();
  await migrateOwnerLayout(lib, config(), seen);
  await reconcileLibrary(lib, seen, root);
}

/** Sync, check, sync, check: the second pass must find nothing to do. */
async function settles(lib: Library, feed: Feed) {
  const first = await sync(lib, feed);
  await check(lib);
  const files = await audio();
  const second = await sync(lib, feed);
  await check(lib);

  expect(second.added).toBe(0);
  expect(second.fetched).toEqual([]);
  expect(await audio()).toEqual(files);
  expect(first.failed + second.failed).toBe(0);
  // Every track's entry points at that track's own audio.
  for (const t of lib.all()) {
    if (t.source !== "local") {
      expect(readFileSync(t.filePath, "utf8")).toBe(t.sourceTrackId);
    }
  }
  return first;
}

const ids = (lib: Library): string[] =>
  lib
    .all()
    .filter((t) => t.source !== "local")
    .map((t) => t.id)
    .sort();

const LIKES = { owner: "lumen", playlist: "Liked Songs" };

describe("a track is known by its id, never by its name", () => {
  it("keeps songs whose whole title is an emoji", async () => {
    const lib = memoryLibrary();
    const first = await settles(lib, [
      listed("soundcloud", "1", "🕷", { artist: "Vesper", ...LIKES }),
      listed("soundcloud", "2", "🏰", { artist: "Vesper", ...LIKES }),
      listed("soundcloud", "3", "🥂🌙", { artist: "Vesper", ...LIKES }),
    ]);

    // All three in one pass: none hides behind another's "empty" name.
    expect(first.fetched).toEqual(["1", "2", "3"]);
    expect(ids(lib)).toEqual([
      "soundcloud:lumen:1",
      "soundcloud:lumen:2",
      "soundcloud:lumen:3",
    ]);
  });

  it("keeps titles that differ only by emoji, beside an entry that lost its own", async () => {
    // Saved long ago, when stored titles had their emoji stripped.
    const old = path.join(
      root,
      "SoundCloud",
      "lumen",
      "Liked Songs",
      "Vesper - (dj vesper) 🧠.m4a",
    );
    await fs.mkdir(path.dirname(old), { recursive: true });
    await fs.writeFile(old, "10");
    const lib = memoryLibrary([
      {
        id: "soundcloud:lumen:10",
        source: "soundcloud",
        sourceTrackId: "10",
        title: "(dj vesper) ",
        artist: "Vesper",
        owner: "lumen",
        playlist: "Liked Songs",
        filePath: old,
        addedAt: "2026-06-10T00:00:00.000Z",
      },
    ]);

    const first = await settles(lib, [
      listed("soundcloud", "10", "(dj vesper) 🧠", { artist: "Vesper", ...LIKES }),
      listed("soundcloud", "11", "(dj vesper) 🚑", { artist: "Vesper", ...LIKES }),
      listed("soundcloud", "12", "(dj vesper)", { artist: "Vesper", ...LIKES }),
    ]);

    expect(first.fetched).toEqual(["11", "12"]);
    expect(ids(lib)).toHaveLength(3);
  });

  it("gives two uploads with one name a file each", async () => {
    const lib = memoryLibrary();
    const first = await settles(lib, [
      listed("soundcloud", "20", "Glass Hours", { artist: "Vesper", ...LIKES }),
      listed("soundcloud", "21", "Glass Hours", { artist: "Vesper", ...LIKES }),
    ]);

    expect(first.fetched).toEqual(["20", "21"]);
    const folder = path.join("SoundCloud", "lumen", "Liked Songs");
    expect(await audio()).toEqual([
      path.join(folder, "Vesper - Glass Hours [21].m4a"),
      path.join(folder, "Vesper - Glass Hours.m4a"),
    ]);
  });

  it("queues every song of a feed that names no artists, same title or not", async () => {
    const lib = memoryLibrary();
    const first = await settles(lib, [
      listed("soundcloud", "30", "Intro", { artist: "Vesper", ...LIKES }),
      listed("soundcloud", "31", "Intro", { artist: "Tidewater", ...LIKES }),
    ]);

    expect(first.added).toBe(2);
    expect(first.fetched).toEqual(["30", "31"]);
  });

  it("copies a liked song into a set that already has another song by that name", async () => {
    const lib = memoryLibrary();
    const set = { owner: "lumen", playlist: "Night Drive" };
    const feed = [
      listed("soundcloud", "40", "Glass Hours", { artist: "Vesper", ...LIKES }),
      listed("soundcloud", "41", "Glass Hours", { artist: "Vesper", ...set }),
      listed("soundcloud", "40", "Glass Hours", { artist: "Vesper", ...set }),
    ];
    // The first pass saves both songs; the copy into the set comes with the
    // next one, as it always has.
    await sync(lib, feed);
    await check(lib);
    await settles(lib, feed);

    const inSet = path.join(root, "SoundCloud", "lumen", "Night Drive");
    expect(readFileSync(path.join(inSet, "Vesper - Glass Hours.m4a"), "utf8")).toBe("41");
    expect(
      readFileSync(path.join(inSet, "Vesper - Glass Hours [40].m4a"), "utf8"),
    ).toBe("40");
  });

  it("does not fetch a song it already has from another source, and deletes neither", async () => {
    const saved = path.join(root, "Spotify", "Mix", "Vesper - Glass Hours.m4a");
    await fs.mkdir(path.dirname(saved), { recursive: true });
    await fs.writeFile(saved, "s1");
    const lib = memoryLibrary([
      {
        id: "spotify:s1",
        source: "spotify",
        sourceTrackId: "s1",
        title: "Glass Hours",
        artist: "Vesper",
        playlist: "Mix",
        filePath: saved,
        addedAt: "2026-06-10T00:00:00.000Z",
      },
    ]);

    const first = await settles(lib, [
      listed("youtube", "y1", "Glass Hours", { artist: "Vesper", feedArtist: "Vesper" }),
    ]);

    expect(first.added).toBe(0);
    expect(first.alreadySaved).toBe(1);
    expect(first.fetched).toEqual([]);
  });

  it("fetches a Spotify recording once, whichever of its ids a playlist lists", async () => {
    const lib = memoryLibrary();
    const mix = { artist: "Vesper", feedArtist: "Vesper", playlist: "Mix" };
    const first = await settles(lib, [
      listed("spotify", "single", "Glass Hours", mix),
      listed("spotify", "album", "Glass Hours", mix),
    ]);

    expect(first.fetched).toEqual(["single"]);
    expect(ids(lib)).toEqual(["spotify:single"]);
  });

  it("files a song under the id its feed lists, whatever the downloader calls it", async () => {
    const lib = memoryLibrary();
    await settles(lib, [
      listed("soundcloud", "50", "Low Tide", {
        artist: "Vesper",
        metaId: "9050",
        ...LIKES,
      }),
    ]);

    expect(ids(lib)).toEqual(["soundcloud:lumen:50"]);
  });

  it("never credits a download with another track's file", async () => {
    const lib = memoryLibrary();
    await sync(lib, [
      listed("soundcloud", "60", "Low Tide", { artist: "Vesper", ...LIKES }),
    ]);
    const folder = path.join(root, "SoundCloud", "lumen", "Liked Songs");

    // Reported under an extension that is not on disk: the only file with
    // that stem is the other song's.
    const r = await sync(lib, [
      listed("soundcloud", "61", "Low Tide", {
        artist: "Vesper",
        misreport: path.join(folder, "Vesper - Low Tide.opus"),
        ...LIKES,
      }),
    ]);

    expect(r.failed).toBe(1);
    expect(ids(lib)).toEqual(["soundcloud:lumen:60"]);
    expect(readFileSync(path.join(folder, "Vesper - Low Tide.m4a"), "utf8")).toBe("60");
  });
});

describe("a pasted link belongs to no handle", () => {
  it("leaves a pasted playlist where it was saved, start-up after start-up", async () => {
    const lib = memoryLibrary();
    const pasted = { artist: "Tidewater", playlist: "Salt Lines" };
    const first = await settles(lib, [
      listed("soundcloud", "70", "One", pasted),
      listed("soundcloud", "71", "Two", pasted),
    ]);

    expect(first.fetched).toEqual(["70", "71"]);
    // The configured handle did not ask for these, so it does not claim them:
    // claimed, they were downloaded again by every later run.
    expect(ids(lib)).toEqual(["soundcloud:70", "soundcloud:71"]);
    expect(await audio()).toEqual([
      path.join("SoundCloud", "Salt Lines", "Tidewater - One.m4a"),
      path.join("SoundCloud", "Salt Lines", "Tidewater - Two.m4a"),
    ]);
  });

  it("leaves a pasted song where it was saved too", async () => {
    const lib = memoryLibrary();
    await settles(lib, [
      listed("youtube", "v1", "Glass Hours", { artist: "Vesper", feedArtist: "Vesper" }),
    ]);

    expect(ids(lib)).toEqual(["youtube:v1"]);
  });
});

describe("the owner migration", () => {
  const legacy = (source: SourceId, id: string, filePath: string): Track => ({
    id: `${source}:${id}`,
    source,
    sourceTrackId: id,
    title: "Low Tide",
    artist: "Vesper",
    playlist: "Night Drive",
    filePath,
    addedAt: "2026-01-10T00:00:00.000Z",
  });

  it("still files a track from before owners under the configured handle", async () => {
    const old = path.join(root, "SoundCloud", "Night Drive", "Vesper - Low Tide.m4a");
    await fs.mkdir(path.dirname(old), { recursive: true });
    await fs.writeFile(old, "80");
    const lib = memoryLibrary([legacy("soundcloud", "80", old)]);

    await check(lib);

    expect(ids(lib)).toEqual(["soundcloud:lumen:80"]);
    expect(await audio()).toEqual([
      path.join("SoundCloud", "lumen", "Night Drive", "Vesper - Low Tide.m4a"),
    ]);
  });

  it("never files a generic link's track under a handle", async () => {
    const file = path.join(root, "Links", "Night Drive", "Vesper - Low Tide.m4a");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "81");
    const lib = memoryLibrary([legacy("link", "81", file)]);

    await check(lib);

    // Links are filed by site: neither handle says anything about them.
    expect(ids(lib)).toEqual(["link:81"]);
    expect(lib.get("link:81")!.owner).toBeUndefined();
  });
});
