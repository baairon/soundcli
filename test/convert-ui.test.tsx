import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "ink-testing-library";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ReactNode } from "react";

// ffmpeg never runs: the stub writes whatever it was told to write, which is
// what lets the whole Settings flow run end to end in a test.
vi.mock("execa", () => ({ execa: vi.fn() }));
vi.mock("../src/bin/ffmpeg-fetch", () => ({
  resolvedFfmpegPath: () => "ffmpeg",
}));

import { execa } from "execa";
import { StoreContext, type Store } from "../src/ui/store";
import { defaultConfig } from "../src/config/config";
import { DownloadQueue } from "../src/download/queue";
import { Playback } from "../src/player/playback";
import { PlayHistory } from "../src/player/history";
import { Settings } from "../src/ui/sections/Settings";
import { ICON } from "../src/ui/theme";
import type { Library } from "../src/library/library";
import type { Track } from "../src/library/types";

const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

/** Wait for the screen to say something, rather than guessing at a delay. */
async function waitFor(
  lastFrame: () => string | undefined,
  text: string,
  timeoutMs = 4000,
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if ((lastFrame() ?? "").includes(text)) return;
    await tick(10);
  }
  throw new Error("timed out waiting for: " + text);
}
const DOWN = "[B";
const ENTER = "\r";

let root: string;

function songs(): Track[] {
  return ["Song One", "Song Two", "Song Three"].map((title, i) => ({
    id: `youtube:${i}`,
    source: "youtube" as const,
    sourceTrackId: String(i),
    title,
    artist: "Artist A",
    filePath: path.join(root, "YouTube", "Set A", `${title}.m4a`),
    fileSize: 4_000_000,
    addedAt: new Date().toISOString(),
  }));
}

/** A library that answers reads and accepts the conversion's path rewrites. */
function fakeLibrary(list: Track[]): Library {
  return {
    all: () => list,
    get: (id: string) => list.find((t) => t.id === id),
    has: (id: string) => list.some((t) => t.id === id),
    search: () => list,
    onChange: () => () => {},
    getVersion: () => 0,
    upsertMany: async (next: Track[]) => {
      for (const t of next) {
        const i = list.findIndex((x) => x.id === t.id);
        if (i >= 0) list[i] = t;
      }
    },
    flushSync: () => {},
  } as unknown as Library;
}

function makeStore(library: Library): Store {
  const config = { ...defaultConfig };
  return {
    config,
    setConfig: () => {},
    library,
    binaries: { ffmpeg: "", ffprobe: "", ytDlp: "", mpv: null },
    queue: new DownloadQueue(config, library),
    playback: new Playback(null, () => {}),
    history: PlayHistory.empty(),
    section: "settings",
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
    contentWidth: 60,
    cols: 90,
    rows: 26,
    playTrack: () => {},
  };
}

const wrap = (node: ReactNode, store: Store) => (
  <StoreContext.Provider value={store}>{node}</StoreContext.Provider>
);

/** Menu → Convert library → pick mp3 → confirm → run. */
async function convertToMp3(
  stdin: { write: (s: string) => void },
  lastFrame: () => string | undefined,
) {
  await tick();
  for (
    let i = 0;
    i < 20 &&
    !(lastFrame() ?? "").includes(`${ICON.pointer} Convert library`);
    i++
  ) {
    stdin.write(DOWN);
    await tick();
  }
  stdin.write(ENTER); // open the picker, cursor already on mp3
  await tick();
  stdin.write(ENTER); // choose mp3
  await tick();
  stdin.write(DOWN); // off Cancel, onto Convert everything
  await tick();
  stdin.write(ENTER);
  // The run is asynchronous; the result screen is the signal that it finished,
  // and a fixed delay races it under a loaded suite.
  await waitFor(lastFrame, "↵ Done");
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sndcli-convert-ui-"));
  await fs.mkdir(path.join(root, "YouTube", "Set A"), { recursive: true });
  for (const t of songs()) await fs.writeFile(t.filePath, "original");
  vi.mocked(execa).mockImplementation((async (_bin: string, args: string[]) => {
    await fs.writeFile(args[args.length - 1]!, "converted");
    return {} as never;
  }) as never);
});

afterEach(async () => {
  vi.mocked(execa).mockReset();
  await fs.rm(root, { recursive: true, force: true });
});

describe("converting the library, end to end", () => {
  it("reports what it did instead of dropping straight back to the menu", async () => {
    const { stdin, lastFrame } = render(
      wrap(<Settings />, makeStore(fakeLibrary(songs()))),
    );
    await convertToMp3(stdin, lastFrame);

    const frame = lastFrame() ?? "";
    // The download screen's settled grammar: title, dot-joined counts, a full
    // bar, and one hint.
    expect(frame).toContain("Converted to mp3");
    expect(frame).toContain("3 of 3 converted");
    expect(frame).toContain("100%");
    expect(frame).toContain("↵ Done");
    // Nothing failed, so no zero-valued segment rides along.
    expect(frame).not.toContain("failed");

    // The frame arrives one render before Ink binds that screen's useInput,
    // so give the effect a tick before pressing anything.
    await tick(20);
    stdin.write(ENTER);
    await waitFor(lastFrame, "Open music folder");
  });

  it("stops on the first unknown encoder and says the build cannot do it", async () => {
    // ffmpeg-static repackages a different upstream build per OS, so this is a
    // real possibility rather than a hypothetical.
    vi.mocked(execa).mockRejectedValue(
      new Error("Unknown encoder 'libmp3lame'"),
    );
    const { stdin, lastFrame } = render(
      wrap(<Settings />, makeStore(fakeLibrary(songs()))),
    );
    await convertToMp3(stdin, lastFrame);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Nothing converted");
    expect(frame).toContain("can't make mp3 files");
    // One answer, not one per song.
    expect(vi.mocked(execa).mock.calls.length).toBe(1);
  });

  it("counts the ones ffmpeg refused, and keeps their originals", async () => {
    vi.mocked(execa).mockRejectedValue(new Error("ffmpeg exited with code 1"));
    const list = songs();
    const { stdin, lastFrame } = render(
      wrap(<Settings />, makeStore(fakeLibrary(list))),
    );
    await convertToMp3(stdin, lastFrame);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("0 of 3 converted");
    expect(frame).toContain("3 failed");
    // However full the bar looks, a run where nothing landed must not claim
    // to have converted anything.
    expect(frame).toContain("Nothing converted");
    expect(frame).not.toContain("Converted to mp3");
    // The songs the user already had are still exactly where they were.
    for (const t of list) {
      expect(await fs.readFile(t.filePath, "utf8")).toBe("original");
    }
  });
});
