// Shared placeholder data for the preview scripts. Everything here is
// deliberately generic ("Song Title · Artist Name"): previews showcase the
// layout, never anyone's actual library. None of these fakes touch disk.

import { EventEmitter } from "node:events";
import { defaultConfig } from "../src/config/config";
import { PlayHistory } from "../src/player/history";
import type { Store } from "../src/ui/store";
import type { Track } from "../src/library/types";
import type { DownloadQueue, QueueItem } from "../src/download/queue";
import type { Playback, PlaybackState } from "../src/player/playback";
import type { Library } from "../src/library/library";

const OWNER = "yourhandle";

function track(
  n: number,
  source: "youtube" | "soundcloud",
  title: string,
  artist: string,
  playlist: string,
  durationSec: number,
): Track {
  return {
    id: `${source}:${OWNER}:t${n}`,
    source,
    sourceTrackId: `t${n}`,
    title,
    artist,
    durationSec,
    filePath: `/music/soundcli/${source}/${OWNER}/song-${n}.mp3`,
    playlist,
    owner: OWNER,
    // Descending so library order (newest first) is stable.
    addedAt: new Date(Date.UTC(2026, 0, 30 - n)).toISOString(),
  };
}

/** Generic tracks across two sources, so the Library shows group headers. */
export const PLACEHOLDER_TRACKS: Track[] = [
  track(1, "youtube", "Song Title", "Artist Name", "liked songs", 233),
  track(2, "youtube", "Another Song", "Artist Name", "liked songs", 187),
  track(3, "youtube", "A Longer Song Title", "Another Artist", "playlist one", 251),
  track(4, "youtube", "Late Night Song", "Another Artist", "playlist one", 174),
  track(5, "youtube", "Morning Song", "Third Artist", "playlist one", 205),
  track(6, "soundcloud", "Third Song", "Artist Name", "liked songs", 196),
  track(7, "soundcloud", "Quiet Song", "Third Artist", "playlist two", 242),
  track(8, "soundcloud", "Closing Song", "Another Artist", "playlist two", 165),
];

/**
 * A read-only stand-in for the Library. Never use the real class here:
 * `Library.empty().upsert(...)` persists to the user's actual index file.
 */
export function makeFakeLibrary(tracks: Track[] = PLACEHOLDER_TRACKS): Library {
  const q = (s: string) => s.toLowerCase();
  const fake = {
    all: () => tracks,
    get: (id: string) => tracks.find((t) => t.id === id),
    has: (id: string) => tracks.some((t) => t.id === id),
    search: (query: string) =>
      tracks.filter((t) =>
        `${t.title} ${t.artist ?? ""}`.toLowerCase().includes(q(query)),
      ),
    onChange: () => () => {},
    getVersion: () => 0,
  };
  return fake as unknown as Library;
}

/** An inert queue with fixed items, for queue views and sidebar badges. */
export class FakeQueue extends EventEmitter {
  constructor(
    private items: QueueItem[] = [],
    private limited = false,
    private failing: string | null = null,
  ) {
    super();
  }
  getItems() {
    return this.items;
  }
  get activeCount() {
    return this.items.filter(
      (i) => i.status === "pending" || i.status === "downloading",
    ).length;
  }
  get doneCount() {
    return this.items.filter((i) => i.status === "done").length;
  }
  stats() {
    const c = (s: string) => this.items.filter((i) => i.status === s).length;
    const total = this.items.length;
    const finished = c("done") + c("skipped") + c("error") + c("canceled");
    const downloading = c("downloading");
    return {
      total,
      finished,
      done: c("done"),
      skipped: c("skipped"),
      failed: c("error"),
      canceled: c("canceled"),
      downloading,
      pending: c("pending"),
      paused: c("paused"),
      rateLimited: this.limited,
      rateLimitReason: this.limited ? "YouTube" : "",
      failingSource: this.failing,
      overallPercent: total ? Math.round((finished / total) * 100) : 0,
      etaSeconds: downloading > 0 ? 252 : undefined,
    };
  }
  pause() {}
  resume() {}
  pauseAll() {}
  resumeAll() {}
  cancelAll() {}
  clearFinished() {}
  retryFailed() {}
}

export function asQueue(fake: FakeQueue): DownloadQueue {
  return fake as unknown as DownloadQueue;
}

/** Mid-song playback state for the now-playing bar (badges on). */
export function makeFakePlayback(
  overrides: Partial<PlaybackState> = {},
): Playback {
  const state = {
    track: PLACEHOLDER_TRACKS[0],
    list: PLACEHOLDER_TRACKS,
    index: 0,
    paused: false,
    position: 83,
    duration: 215,
    volume: 80,
    engine: "mpv" as const,
    mpvAvailable: true,
    repeat: "all" as const,
    shuffle: true,
    loading: false,
    canControl: true,
    ...overrides,
  };
  return { getState: () => state, on: () => {}, off: () => {} } as unknown as Playback;
}

/** A complete Store over the fakes; geometry matches an 80x24 terminal. */
export function makeStore(overrides: Partial<Store> = {}): Store {
  return {
    config: { ...defaultConfig, firstRunComplete: true, libraryDir: "~/Music/soundcli" },
    setConfig: () => {},
    library: makeFakeLibrary(),
    binaries: { ffmpeg: "", ffprobe: "", ytDlp: "", mpv: null },
    queue: asQueue(new FakeQueue()),
    playback: makeFakePlayback(),
    history: PlayHistory.empty(),
    section: "library",
    setSection: () => {},
    region: "content",
    setRegion: () => {},
    captureMode: "none",
    setCaptureMode: () => {},
    playlistsDepth: "sets",
    setPlaylistsDepth: () => {},
    pendingSearch: false,
    setPendingSearch: () => {},
    pendingAdd: null,
    setPendingAdd: () => {},
    mpvStatus: null,
    listRows: 14,
    compact: false,
    contentWidth: 52,
    cols: 80,
    rows: 24,
    playTrack: () => {},
    ...overrides,
  };
}
