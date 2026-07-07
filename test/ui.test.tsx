import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import type { ReactNode } from "react";
import { Box } from "ink";
import { StoreContext, type Store } from "../src/ui/store";
import { defaultConfig } from "../src/config/config";
import { Library } from "../src/library/library";
import type { Track } from "../src/library/types";
import { DownloadQueue, type QueueItem } from "../src/download/queue";
import { FakeQueue, asQueue, makeFakeLibrary } from "../scripts/fake-data";
import { Playback } from "../src/player/playback";
import { PlayHistory } from "../src/player/history";
import { Library as LibrarySection } from "../src/ui/sections/Library";
import { Download, PlaylistPicker } from "../src/ui/sections/Download";
import { Playlists } from "../src/ui/sections/Playlists";
import { History as HistorySection } from "../src/ui/sections/History";
import { Settings } from "../src/ui/sections/Settings";
import { Sidebar } from "../src/ui/components/Sidebar";
import { SongList } from "../src/ui/components/SongList";
import { TextField } from "../src/ui/components/TextField";
import { NowPlayingBar } from "../src/ui/components/NowPlayingBar";
import { HelpOverlay } from "../src/ui/components/HelpOverlay";
import { Welcome } from "../src/ui/views/Welcome";

function makeStore(overrides?: Partial<Store>): Store {
  const config = { ...defaultConfig };
  const library = Library.empty();
  const queue = new DownloadQueue(config, library);
  return {
    config,
    setConfig: () => {},
    library,
    binaries: { ffmpeg: "", ffprobe: "", ytDlp: "", mpv: null },
    queue,
    playback: new Playback(null, () => {}),
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
    listRows: 10,
    compact: false,
    contentWidth: 48,
    cols: 80,
    rows: 24,
    playTrack: () => {},
    ...overrides,
  };
}

function wrap(node: ReactNode, store: Store) {
  return <StoreContext.Provider value={store}>{node}</StoreContext.Provider>;
}

/** One macrotask: lets Ink attach useInput handlers / flush a state update. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
/** Ink buffers a lone ESC for ~20ms before emitting it; wait that out in tests. */
const escTick = () => new Promise<void>((r) => setTimeout(r, 25));

const DOWN = "\u001b[B";
const ESC = "\u001b";

const HOME = `${ESC}[H`;
const END = `${ESC}[F`;

describe("single-page sections render", () => {
  it("library shows the empty state", () => {
    const { lastFrame } = render(wrap(<LibrarySection />, makeStore()));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Library");
    expect(frame).toContain("Nothing here yet");
  });

  it("library drops the idle search hint when compact, keeps it otherwise", () => {
    const full = render(
      wrap(<LibrarySection />, makeStore({ library: makeFakeLibrary() })),
    );
    expect(full.lastFrame() ?? "").toContain("Press / to search…");

    const tight = render(
      wrap(
        <LibrarySection />,
        makeStore({ library: makeFakeLibrary(), compact: true }),
      ),
    );
    expect(tight.lastFrame() ?? "").not.toContain("Press / to search…");
  });

  it("download shows the source picker when nothing is queued", () => {
    const { lastFrame } = render(wrap(<Download />, makeStore()));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Download");
    expect(frame).toContain("everything stays local");
    expect(frame).toContain("YouTube");
  });

  it("settings shows the music folder", () => {
    const store = makeStore();
    const { lastFrame } = render(wrap(<Settings />, store));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Music folder");
  });

  it("settings shows values inline after the label column", () => {
    const store = makeStore({
      region: "content",
      config: { ...defaultConfig, spotifyHandle: "spotify" },
    });
    const { lastFrame } = render(wrap(<Settings />, store));
    const row = (lastFrame() ?? "")
      .split("\n")
      .find((l) => l.includes("Spotify handle"));
    expect(row).toBeDefined();
    expect(row).toMatch(/Spotify handle\s+@spotify/);
  });

  it("sidebar lists the familiar music-app sections", () => {
    const { lastFrame } = render(
      wrap(<Sidebar />, makeStore({ region: "sidebar" })),
    );
    const frame = lastFrame() ?? "";
    for (const label of [
      "Library",
      "Playlists",
      "History",
      "Download",
      "Settings",
    ]) {
      expect(frame).toContain(label);
    }
  });

  it("now playing bar is honest when the player isn't ready", () => {
    // mpv is absent and no install is running → say so instead of inviting ↵.
    const { lastFrame } = render(wrap(<NowPlayingBar />, makeStore()));
    expect(lastFrame() ?? "").toContain("Player not ready");
  });

  it("now playing bar shows the idle state once the player is ready", () => {
    const store = makeStore();
    const ready = {
      ...store,
      playback: {
        getState: () => ({ ...store.playback.getState(), mpvAvailable: true }),
        on: () => {},
        off: () => {},
      } as unknown as Store["playback"],
    };
    const { lastFrame } = render(wrap(<NowPlayingBar />, ready));
    expect(lastFrame() ?? "").toContain("Nothing playing");
  });

  it("SongList truncates long titles to one line each (no two songs on a line)", () => {
    const longTitle =
      "((DEMO))xxplaceholderxx(000fake) a ridiculously long title that must be truncated not wrapped onto the next row";
    const groups = [
      {
        items: [
          { value: "1", title: longTitle, artist: "demoartistone" },
          { value: "2", title: "Sample Title", artist: "demoartisttwo" },
        ],
      },
    ];
    const { lastFrame } = render(
      wrap(
        <Box width={40}>
          <SongList groups={groups} focused={false} onSelect={() => {}} />
        </Box>,
        makeStore(),
      ),
    );
    const lines = (lastFrame() ?? "").split("\n").filter((l) => l.trim() !== "");
    // Exactly two rows: the long title is truncated (not wrapped into a 3rd
    // line) and never shares a line with the second song.
    expect(lines.length).toBe(2);
    expect(lines.some((l) => l.includes("Sample Title"))).toBe(true);
    expect(lines.some((l) => l.includes("Sample Title") && l.includes("xxplaceholderxx"))).toBe(false);
  });

  it("download queue stays within the body on a squashed terminal", () => {
    // Overflowing the fixed-height body corrupts Ink's redraw (rows merge),
    // so the queue must fit its row budget even when crowded and short.
    const items: QueueItem[] = Array.from({ length: 20 }, (_, i) => ({
      id: `q${i}`,
      source: "youtube",
      sourceLabel: "YouTube",
      track: { id: String(i), title: `Song number ${i}`, downloadUrl: "x" },
      status: "pending",
      percent: 0,
    }));
    const store = makeStore({
      region: "content",
      // listRows 5 = a body 7 rows tall (a ~15-row terminal).
      listRows: 5,
      queue: asQueue(new FakeQueue(items)),
    });
    const { lastFrame } = render(wrap(<Download />, store));
    const lines = (lastFrame() ?? "").split("\n");
    expect(lines.length).toBeLessThanOrEqual(7);
  });

  it("playlist picker stays within its row budget when squashed", () => {
    // The picker may use at most listRows - reserveRows lines; anything more
    // overflows the fixed-height body and corrupts Ink's redraw (the action
    // row and a set row end up mangled into one line).
    const pick = (listRows: number, listCount: number) => {
      const lists = Array.from({ length: listCount }, (_, i) => ({
        id: `l${i}`,
        title: `set number ${i}`,
        url: "x",
      }));
      const { lastFrame } = render(
        wrap(
          <PlaylistPicker
            lists={lists}
            sourceId="youtube"
            onSubmit={() => {}}
            filtering={false}
            setFiltering={() => {}}
          />,
          makeStore({ region: "content", listRows }),
        ),
      );
      return (lastFrame() ?? "").split("\n");
    };

    // A short panel (the VS Code terminal squash): everything still fits,
    // and the action row and the set keep their own separate lines.
    const squashed = pick(7, 1);
    expect(squashed.length).toBeLessThanOrEqual(7);
    const actionLine = squashed.findIndex((l) => l.includes("Download all"));
    const setLine = squashed.findIndex((l) => l.includes("set number 0"));
    expect(actionLine).toBeGreaterThanOrEqual(0);
    expect(setLine).toBeGreaterThanOrEqual(0);
    expect(actionLine).not.toBe(setLine);

    // Crowded and squashed: the scroll window absorbs the excess.
    expect(pick(7, 12).length).toBeLessThanOrEqual(7);
    // Tiny: the status line sheds before any row can overflow.
    expect(pick(4, 12).length).toBeLessThanOrEqual(4);
  });

  it("SongList asks the section to delete the highlighted song on d", async () => {
    const got: string[] = [];
    const { stdin } = render(
      wrap(
        <SongList
          groups={[{ items: [{ value: "t1", title: "Song" }] }]}
          focused
          onSelect={() => {}}
          onDelete={(v) => got.push(v)}
        />,
        makeStore(),
      ),
    );
    await tick();
    stdin.write("d");
    await tick();
    expect(got).toEqual(["t1"]);
  });

  it("library shows a y/esc confirm before deleting, esc keeps the song", async () => {
    const store = makeStore({ library: makeFakeLibrary() });
    const { stdin, lastFrame } = render(wrap(<LibrarySection />, store));
    await tick();
    stdin.write(DOWN); // step off the shuffle action row
    await tick();
    stdin.write("d");
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Delete '");
    expect(frame).toContain("esc Keep");
    stdin.write(ESC); // esc keeps the song
    await escTick();
    expect(lastFrame() ?? "").not.toContain("esc Keep");
  });




  it("SongList never renders more rows than the available height", () => {
    const items = Array.from({ length: 50 }, (_, i) => ({
      value: String(i),
      title: `Song number ${i}`,
      artist: "Artist",
    }));
    const { lastFrame } = render(
      wrap(
        <SongList
          groups={[{ items }]}
          focused={false}
          reserveRows={2}
          onSelect={() => {}}
        />,
        // listRows 5 − reserveRows 2 = 3 visible rows, so a 50-song list must
        // not overflow the body (which corrupts Ink's redraw).
        makeStore({ listRows: 5 }),
      ),
    );
    const lines = (lastFrame() ?? "").split("\n").filter((l) => l.trim() !== "");
    expect(lines.length).toBeLessThanOrEqual(3);
  });

  it("SongList keeps the active section header visible on short terminals", async () => {
    const groups = [
      {
        title: "SoundCloud · 2",
        items: [
          { value: "sc1", title: "SC One" },
          { value: "sc2", title: "SC Two" },
        ],
      },
      {
        title: "Spotify · 3",
        items: [
          { value: "sp1", title: "Playlist - Solstice Arc" },
          { value: "sp2", title: "Playlist - Marrow Fields" },
          { value: "sp3", title: "My Mix - Vantablue" },
        ],
      },
    ];
    const { stdin, lastFrame } = render(
      wrap(
        <SongList groups={groups} focused reserveRows={0} onSelect={() => {}} />,
        makeStore({ listRows: 3 }),
      ),
    );
    await tick();
    for (let i = 0; i < 3; i++) {
      stdin.write(DOWN);
      await tick();
    }
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Spotify");
    expect(frame).toContain("Marrow Fields");
  });

  it("numbers item rows when `numbered` is set", () => {
    const groups = [
      {
        items: [
          { value: "a", title: "First Track" },
          { value: "b", title: "Second Track" },
        ],
      },
    ];
    const { lastFrame } = render(
      wrap(
        <SongList groups={groups} numbered focused onSelect={() => {}} />,
        makeStore({ listRows: 10 }),
      ),
    );
    const frame = lastFrame() ?? "";
    expect(frame).toMatch(/1\s+First Track/);
    expect(frame).toMatch(/2\s+Second Track/);
  });

  it("SongList jumps to the last and first row on End/Home", async () => {
    const groups = [
      {
        items: [
          { value: "a", title: "Alpha Track" },
          { value: "b", title: "Beta Track" },
          { value: "c", title: "Gamma Track" },
          { value: "d", title: "Delta Track" },
          { value: "e", title: "Omega Track" },
        ],
      },
    ];
    const { stdin, lastFrame } = render(
      wrap(
        <SongList groups={groups} focused onSelect={() => {}} />,
        makeStore({ listRows: 3 }),
      ),
    );
    await tick();
    stdin.write(END);
    await tick();
    expect(lastFrame() ?? "").toContain("Omega Track");
    expect(lastFrame() ?? "").not.toContain("Alpha Track");
    stdin.write(HOME);
    await tick();
    expect(lastFrame() ?? "").toContain("Alpha Track");
    expect(lastFrame() ?? "").not.toContain("Omega Track");
  });

  it("TextField moves the cursor to the ends on Home/End", async () => {
    const got: string[] = [];
    const { stdin } = render(<TextField onChange={(v) => got.push(v)} />);
    await tick();
    stdin.write("abc");
    await tick();
    stdin.write(HOME);
    await tick();
    stdin.write("x"); // lands at the start only if Home moved the cursor
    await tick();
    stdin.write(END);
    await tick();
    stdin.write("z"); // and back at the end after End
    await tick();
    expect(got.at(-1)).toBe("xabcz");
  });
});

describe("queue copy, banner, overlay, welcome paste", () => {
  const errorItem = (id: string, title: string): QueueItem => ({
    id,
    source: "soundcloud",
    sourceLabel: "SoundCloud",
    track: { id: `t-${id}`, title, downloadUrl: "x" },
    status: "error",
    percent: 0,
    error:
      "yt-dlp failed (exit 1): ERROR: [soundcloud] Unable to download JSON metadata: HTTP Error 404: Not Found",
  });

  it("failed rows sink below the queue and the header says failed", () => {
    const items: QueueItem[] = [
      errorItem("e1", "Dead Track"),
      {
        id: "p1",
        source: "soundcloud",
        sourceLabel: "SoundCloud",
        track: { id: "t-p1", title: "Queued Track", downloadUrl: "y" },
        status: "pending",
        percent: 0,
      },
    ];
    const store = makeStore({ queue: asQueue(new FakeQueue(items)) });
    const { lastFrame } = render(wrap(<Download />, store));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("1 failed");
    expect(frame).not.toContain("to retry");
    expect(frame).toContain("Retry"); // f Retry stays the call to action
    const lines = frame.split("\n");
    const queued = lines.findIndex((l) => l.includes("Queued Track"));
    const failed = lines.findIndex((l) => l.includes("Dead Track"));
    expect(queued).toBeGreaterThanOrEqual(0);
    expect(failed).toBeGreaterThan(queued);
  });

  it("a permanent-failure burst shows the stale-downloader banner", () => {
    const store = makeStore({
      queue: asQueue(new FakeQueue([errorItem("e1", "Dead Track")], false, "SoundCloud")),
    });
    const { lastFrame } = render(wrap(<Download />, store));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("SoundCloud downloads keep failing");
    expect(frame).toContain("downloader may be out of date");
  });

  it("help overlay keeps every key and label on a single line", () => {
    const { lastFrame } = render(
      wrap(<HelpOverlay />, makeStore({ cols: 100 })),
    );
    const lines = (lastFrame() ?? "").split("\n");
    // The longest chord and labels sit intact on one row each; a wrapped
    // cell would split these strings across lines.
    expect(
      lines.some((l) => l.includes("PgUp PgDn") && l.includes("Jump a page")),
    ).toBe(true);
    expect(lines.some((l) => l.includes("Pause / resume all"))).toBe(true);
    expect(lines.some((l) => l.includes("Pick: toggle row"))).toBe(true);
  });

  it("help overlay keeps a complete bordered box when compact", () => {
    const { lastFrame } = render(
      wrap(<HelpOverlay />, makeStore({ cols: 100, compact: true })),
    );
    const lines = (lastFrame() ?? "").split("\n").filter((l) => l.trim() !== "");
    // The card must stay a closed box: a top corner on the first row and a
    // bottom corner on the last. If the compact card overflowed, the bottom
    // border (and footer) would be the part that clips off.
    expect(lines[0]).toContain("╭"); // ╭
    expect(lines[lines.length - 1]).toContain("╰"); // ╰
    // Still the same card: header, a sample chord, and the close hint (folded
    // into the header row in compact, not a separate footer line).
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Keyboard");
    expect(frame).toContain("PgUp PgDn");
    expect(frame).toContain("? esc to close");
  });

  it("help overlay keeps its standalone footer line when not compact", () => {
    const { lastFrame } = render(
      wrap(<HelpOverlay />, makeStore({ cols: 100, compact: false })),
    );
    expect(lastFrame() ?? "").toContain("Press ? or esc to close");
  });

  it("playlists / opens local filter instead of jumping to library", async () => {
    const sections: string[] = [];
    const store = makeStore({
      region: "content",
      section: "playlists",
      library: makeFakeLibrary(),
      setSection: (s) => sections.push(s),
    });
    const { stdin, lastFrame } = render(wrap(<Playlists />, store));
    await tick();
    stdin.write("/");
    await tick();
    expect(sections).not.toContain("library");
    expect(lastFrame() ?? "").toContain("Search playlists");
  });

  it("playlists shows source filter tabs like library", () => {
    const { lastFrame } = render(
      wrap(
        <Playlists />,
        makeStore({ region: "content", library: makeFakeLibrary() }),
      ),
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("All");
    expect(frame).toContain("YouTube");
    expect(frame).toContain("SoundCloud");
    const lines = frame.split("\n");
    const allLine = lines.findIndex((l) => l.includes("All") && l.includes("YouTube"));
    const filterLine = lines.findIndex((l) => l.includes("Press / to search…"));
    expect(allLine).toBeGreaterThanOrEqual(0);
    expect(filterLine).toBeGreaterThan(allLine);
  });

  it("playlists drill-down does not violate hook order", async () => {
    const store = makeStore({
      region: "content",
      library: makeFakeLibrary(),
    });
    const { stdin, lastFrame } = render(wrap(<Playlists />, store));
    expect(lastFrame() ?? "").toContain("playlist one");
    stdin.write("\r");
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Song Title");
    // Expanded drill-down keeps the idle search hint, same as Library.
    expect(frame).toContain("Press / to search…");
    expect(frame).toContain("Shuffle");
  });

  it("playlists drill-down shows runtime and numbered tracks", async () => {
    const store = makeStore({
      region: "content",
      library: makeFakeLibrary(),
    });
    const { stdin, lastFrame } = render(wrap(<Playlists />, store));
    await tick();
    stdin.write("\r");
    await tick();
    const frame = lastFrame() ?? "";
    // Coarse runtime sits in the subtitle…
    expect(frame).toMatch(/\d+\s*min/);
    // …and the first track is numbered.
    expect(frame).toMatch(/1\s+Song Title/);
  });

  it("playlists drill-down follows the source feed order, strays last", async () => {
    const mk = (n: number, title: string, playlistPos?: number): Track => ({
      id: `youtube:yourhandle:o${n}`,
      source: "youtube",
      sourceTrackId: `o${n}`,
      title,
      artist: "Artist Name",
      durationSec: 100,
      filePath: `/music/soundcli/youtube/yourhandle/order-${n}.mp3`,
      playlist: "ordered set",
      playlistPos,
      owner: "yourhandle",
      addedAt: new Date(Date.UTC(2026, 0, 30 - n)).toISOString(),
    });
    // Array order = addedAt newest-first, i.e. scrambled completion order.
    const store = makeStore({
      region: "content",
      library: makeFakeLibrary([
        mk(1, "Downloaded Last", 3),
        mk(2, "Downloaded Mid", 1),
        mk(3, "Downloaded First", 2),
        mk(4, "Adopted Stray"), // no feed position: stays at the end
      ]),
    });
    const { stdin, lastFrame } = render(wrap(<Playlists />, store));
    await tick();
    stdin.write("\r");
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toMatch(/1\s+Downloaded Mid/);
    expect(frame).toMatch(/2\s+Downloaded First/);
    expect(frame).toMatch(/3\s+Downloaded Last/);
    expect(frame).toMatch(/4\s+Adopted Stray/);
  });

  it("playlists sets view leaves captureMode none so esc reaches the sidebar", async () => {
    const modes: string[] = [];
    const store = makeStore({
      region: "content",
      library: makeFakeLibrary(),
      setCaptureMode: (m) => modes.push(m),
    });
    render(wrap(<Playlists />, store));
    await tick();
    // Browsing sets must not claim "picker": that swallows the global esc and
    // strands focus in the content pane (regression).
    expect(modes).not.toContain("picker");
    expect(modes.at(-1)).toBe("none");
  });

  it("history shows source tabs and a search prompt", () => {
    const history = {
      ids: () => ["youtube:yourhandle:t1", "soundcloud:yourhandle:t6"],
      onChange: () => () => {},
      getVersion: () => 0,
    } as unknown as PlayHistory;
    const { lastFrame } = render(
      wrap(
        <HistorySection />,
        makeStore({ region: "content", library: makeFakeLibrary(), history }),
      ),
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("All");
    expect(frame).toContain("YouTube");
    expect(frame).toContain("SoundCloud");
    expect(frame).toContain("Press / to search…");
    expect(frame).toContain("Song Title");
  });

  it("history / opens local search instead of jumping to library", async () => {
    const sections: string[] = [];
    const history = {
      ids: () => ["youtube:yourhandle:t1"],
      onChange: () => () => {},
      getVersion: () => 0,
    } as unknown as PlayHistory;
    const store = makeStore({
      region: "content",
      section: "history",
      library: makeFakeLibrary(),
      history,
      setSection: (s) => sections.push(s),
    });
    const { stdin, lastFrame } = render(wrap(<HistorySection />, store));
    await tick();
    stdin.write("/");
    await tick();
    expect(sections).not.toContain("library");
    expect(lastFrame() ?? "").not.toContain("Press / to search…");
  });

  it("download consumes a pasted playlist link", async () => {
    let cleared = false;
    const store = makeStore({
      region: "content",
      section: "download",
      pendingAdd: "https://www.youtube.com/playlist?list=PLtest123",
      setPendingAdd: (v) => {
        if (v === null) cleared = true;
      },
    });
    const { lastFrame } = render(wrap(<Download />, store));
    for (let i = 0; i < 8; i++) {
      await tick();
      if ((lastFrame() ?? "").includes("Ready to download")) break;
    }
    expect(cleared).toBe(true);
    expect(lastFrame() ?? "").toContain("Ready to download");
  });

  it("welcome pastes straight into the download flow", async () => {
    const got: (string | null)[] = [];
    const sections: string[] = [];
    const store = makeStore({
      setPendingAdd: (v) => got.push(v),
      setSection: (s) => sections.push(s),
    });
    const { stdin, lastFrame } = render(wrap(<Welcome />, store));
    await tick();
    expect(lastFrame() ?? "").toContain("Where's your music?");
    stdin.write("https://soundcloud.com/artist/track");
    await tick();
    expect(got).toEqual(["https://soundcloud.com/artist/track"]);
    expect(sections).toEqual(["download"]);
  });

  it("library: t opens rename on the cursor row, gated off the list", async () => {
    const played: string[] = [];
    const store = makeStore({
      region: "content",
      library: makeFakeLibrary(),
      playTrack: (t) => played.push(t.title),
    });
    const { stdin, lastFrame } = render(wrap(<LibrarySection />, store));
    await tick();
    // Step off the shuffle action row onto the first song, then rename it.
    stdin.write(DOWN);
    await tick();
    stdin.write("t");
    await tick();
    // The rename field (prefilled with the title) replaces the search hint.
    expect(lastFrame() ?? "").not.toContain("Press / to search…");
    // The list is unfocused while the field is open: enter submits the rename
    // (unchanged title = noop) instead of also playing the cursor row.
    stdin.write("\r");
    await tick();
    expect(played).toEqual([]);
    expect(lastFrame() ?? "").toContain("Press / to search…");
  });

  it("playlists: t opens the set rename prefilled with its name", async () => {
    const store = makeStore({
      region: "content",
      section: "playlists",
      library: makeFakeLibrary(),
    });
    const { stdin, lastFrame } = render(wrap(<Playlists />, store));
    await tick();
    stdin.write("t");
    await tick();
    // The rename field replaces the search hint row, prefilled with the name.
    expect(lastFrame() ?? "").not.toContain("Press / to search…");
    // esc cancels without renaming.
    stdin.write(ESC);
    await escTick();
    expect(lastFrame() ?? "").toContain("Press / to search…");
  });
});
