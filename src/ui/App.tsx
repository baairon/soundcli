import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout, useStdin } from "ink";
import { Spinner } from "@inkjs/ui";
import { ensureBinaries, type Binaries } from "../bin/binaries";
import { ensureFfmpeg } from "../bin/ffmpeg-fetch";
import { ensureMpvInstalled } from "../bin/mpv-install";
import { finalizeStagedYtDlp } from "../bin/ytdlp-fetch";
import { maybeUpdateYtDlp } from "../bin/ytdlp-update";
import { loadConfig, saveConfig, type Config } from "../config/config";
import { promises as fs } from "node:fs";
import { DownloadQueue } from "../download/queue";
import { loadQueue } from "../download/persist";
import { Library as LibraryStore } from "../library/library";
import { migrateOwnerLayout } from "../library/migrate";
import { reconcileLibrary } from "../library/reconcile";
import { legacyArchiveFile } from "../config/paths";
import type { Track } from "../library/types";
import { Playback, type PlaybackState } from "../player/playback";
import { PlayHistory } from "../player/history";
import {
  StoreContext,
  type CaptureMode,
  type Region,
  type Section,
  type Store,
} from "./store";
import { Sidebar } from "./components/Sidebar";
import { NowPlayingBar } from "./components/NowPlayingBar";
import { Rule } from "./components/Rule";
import { Footer } from "./components/Footer";
import { HelpOverlay } from "./components/HelpOverlay";
import { Logo } from "./components/Logo";
import { LOGO_LINES } from "./logo";
import { footerHints, sectionForDigit } from "./keymap";
import {
  handlePlayerMode,
  handlePlayerTransport,
  playerCanControl,
  shouldBlockPlayerSpace,
} from "./player-keys";
import { COLOR, ICON, RULE } from "./theme";
import { Library as LibrarySection } from "./sections/Library";
import { Playlists } from "./sections/Playlists";
import { History } from "./sections/History";
import { Download } from "./sections/Download";
import { Settings } from "./sections/Settings";
import { Welcome } from "./views/Welcome";
import { useMouseWheel } from "./hooks/useMouseWheel";

interface Boot {
  library: LibraryStore;
  binaries: Binaries;
  queue: DownloadQueue;
  playback: Playback;
  history: PlayHistory;
}

function Content({ section }: { section: Section }) {
  switch (section) {
    case "library":
      return <LibrarySection />;
    case "playlists":
      return <Playlists />;
    case "history":
      return <History />;
    case "download":
      return <Download />;
    case "settings":
      return <Settings />;
  }
}

export function App({ initialAdd }: { initialAdd?: string } = {}) {
  useMouseWheel();
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();
  const { stdout } = useStdout();
  const [size, setSize] = useState({
    rows: stdout?.rows ?? 24,
    cols: stdout?.columns ?? 80,
  });
  useEffect(() => {
    if (!stdout) return;
    let last = { rows: stdout.rows ?? 24, cols: stdout.columns ?? 80 };
    const onResize = (): void => {
      const next = { rows: stdout.rows ?? 24, cols: stdout.columns ?? 80 };
      if (next.rows === last.rows && next.cols === last.cols) return;
      // Shrinking strands rows outside the new viewport that Ink can no
      // longer erase (Ink only self-clears when the width drops, and ConPTY
      // reflow leaves similar junk), and they linger as mangled lines.
      // Hard-clear so the repaint that follows starts from a blank screen.
      if (next.rows < last.rows || next.cols < last.cols) {
        stdout.write("\x1b[2J\x1b[H");
      }
      last = next;
      setSize(next);
    };
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);
  const rows = size.rows;
  const cols = size.cols;
  // Fit the whole layout inside the terminal so content never gets clipped.
  // On very short terminals we shed the hints line, then the rules, to keep
  // the sidebar + content + now-playing bar all visible.
  const showTopRule = rows >= 12;
  const showDivider = rows >= 12;
  const showFooter = rows >= 14;
  // The block wordmark needs a couple of rows and some width; on a cramped
  // terminal we fall back to a one-line text mark so nothing gets squeezed.
  const showLogo = rows >= 16 && cols >= 34;
  const brandHeight = showLogo ? LOGO_LINES.length : 1;
  const chrome =
    brandHeight +
    (showTopRule ? 1 : 0) +
    1 + // body's marginTop
    (showDivider ? 1 : 0) +
    1 + // now-playing bar
    (showFooter ? 1 : 0);
  const bodyH = Math.max(6, rows - 1 - chrome);
  const listRows = Math.max(3, Math.min(30, bodyH - 2));
  // Root padding (2) + sidebar (20) + its margin (1) + the content rail (1)
  // + its padding (2), with 2 columns of slack.
  const contentWidth = Math.max(20, cols - 28);

  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("Getting your music ready…");
  const [mpvStatus, setMpvStatus] = useState<string | null>(null);
  const [boot, setBoot] = useState<Boot | null>(null);
  const [config, setConfigState] = useState<Config | null>(null);
  // Bumped by `r` on the setup-failed screen to re-run the whole bootstrap.
  const [bootAttempt, setBootAttempt] = useState(0);
  // Guards the bootstrap effect against overlapping runs across retries.
  const booting = useRef(false);
  // Clears the transient "couldn't set up the player" line; cleaned on unmount.
  const mpvStatusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (mpvStatusTimer.current) clearTimeout(mpvStatusTimer.current);
    },
    [],
  );

  const [section, setSection] = useState<Section>("library");
  // Launch with the sidebar menu focused so the first thing you meet is the
  // app's map; the song list is one tab/enter away.
  const [region, setRegion] = useState<Region>("sidebar");
  const [captureMode, setCaptureMode] = useState<CaptureMode>("none");
  const [showHelp, setShowHelp] = useState(false);
  const [pendingSearch, setPendingSearch] = useState(false);
  const [pendingAdd, setPendingAdd] = useState<string | null>(null);

  useEffect(() => {
    if (booting.current) return;
    booting.current = true;
    void (async () => {
      const cfg = await loadConfig();
      // A link passed on the command line means the user has self-onboarded:
      // skip the welcome tour and drop straight into downloading it (the
      // saveConfig below persists the flag).
      if (initialAdd) cfg.firstRunComplete = true;
      const library = await LibraryStore.load();
      // One-time layout migration (pre-owner files move into their handle
      // folder), then silent drift hygiene: drop dead entries + dupes. Both
      // passes share one existence cache so each file is stat'd once per boot.
      const exists = new Map<string, boolean>();
      await migrateOwnerLayout(library, cfg, exists);
      await reconcileLibrary(library, exists);
      lastReconcile.current = Date.now();
      // Library is now the source of truth, so drop the legacy yt-dlp archive.
      void fs.rm(legacyArchiveFile, { force: true }).catch(() => {});
      const binaries = await ensureBinaries(setStatus);
      const playback = new Playback(binaries.mpv);

      // Recently played: record every track the player actually starts,
      // including auto-advance and next/prev, not just explicit picks.
      const history = await PlayHistory.load();
      let lastPlayedId: string | undefined;

      const lastId = history.ids()[0];
      if (lastId) {
        const lastTrack = library.all().find((t) => t.id === lastId);
        if (lastTrack) {
          lastPlayedId = lastTrack.id;
          void playback.play(lastTrack, [lastTrack], 0, true).catch(() => {});
        }
      }

      playback.on("state", (s: PlaybackState) => {
        const id = s.track?.id;
        if (id && id !== lastPlayedId) {
          lastPlayedId = id;
          history.record(id);
        }
      });

      // Auto-install mpv in the background so the rich player "just works".
      // Retried on every launch while it's missing: a one-time flag here once
      // left playback silently broken forever after a single failed attempt.
      if (!binaries.mpv) {
        const failed = (): void => {
          // One calm line, then quiet again: the NowPlayingBar hint stays the
          // durable nudge while songs keep opening in the OS default app.
          setMpvStatus(
            "Couldn't set up the player, songs open in your default app",
          );
          if (mpvStatusTimer.current) clearTimeout(mpvStatusTimer.current);
          mpvStatusTimer.current = setTimeout(() => setMpvStatus(null), 8000);
        };
        void ensureMpvInstalled(setMpvStatus)
          .then((p) => {
            if (p) {
              setMpvStatus(null);
              playback.enableMpv(p);
            } else if (process.platform === "linux") {
              // Linux never auto-installs (needs sudo); the install hint is
              // the durable surface there, so saying "couldn't set up" about
              // an attempt we never made would just be noise.
              setMpvStatus(null);
            } else {
              failed();
            }
          })
          .catch(failed);
      }

      // Downloads hard-gate on the audio engine (fetched in the background by
      // ensureBinaries); undefined keeps the default concurrency.
      const queue = new DownloadQueue(cfg, library, undefined, () =>
        ensureFfmpeg(),
      );
      // Bring back last session's queue; pending items resume from their .part.
      queue.restore(await loadQueue());

      // Check for a newer yt-dlp on every boot (a stale extractor turns every
      // download from a source into "failed"). Async and silent: a newer
      // binary is staged, then promoted right away unless a download is
      // already running the current one (then it applies next launch).
      // Offline stays completely normal.
      if (cfg.ytdlpAutoUpdate !== false) {
        void maybeUpdateYtDlp()
          .then(async (staged) => {
            if (staged && queue.stats().downloading === 0) {
              await finalizeStagedYtDlp();
            }
          })
          .catch(() => {});
      }
      setConfigState(cfg);
      setBoot({ library, binaries, queue, playback, history });
      if (initialAdd) {
        setSection("download");
        setRegion("content");
        setPendingAdd(initialAdd);
      }
      void saveConfig(cfg);
    })()
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => {
        booting.current = false;
      });
    // Boot once per attempt (r on the setup-failed screen bumps bootAttempt);
    // initialAdd is fixed for the process lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bootAttempt]);

  useEffect(
    () => () => {
      boot?.queue.suspend();
      boot?.playback.quit();
    },
    [boot],
  );

  // Re-run drift hygiene when the user lands on a library-backed section, so
  // the library stays in sync as they browse. Guarded so navigations don't
  // stack, and throttled: rapid tab-hopping shouldn't restat the whole
  // library when nothing on disk had time to change.
  const reconciling = useRef(false);
  const lastReconcile = useRef(0);
  useEffect(() => {
    const library = boot?.library;
    if (!library || reconciling.current) return;
    if (section !== "library" && section !== "playlists" && section !== "history") {
      return;
    }
    if (Date.now() - lastReconcile.current < 30_000) return;
    reconciling.current = true;
    void reconcileLibrary(library)
      .then(() => {
        // Keep recently-played in step: drop entries whose track was pruned.
        boot.history.retain((id) => library.has(id));
      })
      .finally(() => {
        lastReconcile.current = Date.now();
        reconciling.current = false;
      });
  }, [section, boot]);

  const quitAll = useCallback(() => {
    boot?.queue.suspend();
    boot?.playback.quit();
    exit();
  }, [boot, exit]);

  const welcome = config ? !config.firstRunComplete : true;

  useInput(
    (input, key) => {
      if (key.ctrl && input === "c") {
        quitAll();
        return;
      }
      // A TextField owns the whole keyboard while the user is typing.
      if (captureMode === "text") return;
      // While the cheatsheet is up, any key dismisses it and nothing else fires.
      if (showHelp) {
        setShowHelp(false);
        return;
      }
      if (input === "?") {
        setShowHelp(true);
        return;
      }
      const pb = boot?.playback;
      // Player transport runs before pane/section keys so downloads never
      // steal space/k, j/l, n/p, etc. (text capture already returned above).
      if (pb) {
        // k pauses everywhere space does, including pickers (where space is
        // busy toggling rows): that's the point of having two pause keys.
        const transport =
          input === " " || input === "k"
            ? input === "k" || !shouldBlockPlayerSpace(captureMode)
            : playerCanControl(pb) &&
              (input === "n" ||
                input === "p" ||
                input === "0" ||
                input === "," ||
                input === "." ||
                input === "+" ||
                input === "=" ||
                input === "-" ||
                input === "_" ||
                input === "j" ||
                input === "l" ||
                key.leftArrow ||
                key.rightArrow);
        if (transport) {
          if (input === " " || input === "k") void pb.togglePause();
          else handlePlayerTransport(pb, input, key);
          return;
        }
        if (
          handlePlayerMode(
            pb,
            input,
            playTrack,
            boot?.library.all() ?? [],
          )
        ) {
          return;
        }
      }
      if (key.tab) {
        setRegion(region === "sidebar" ? "content" : "sidebar");
        return;
      }
      if (key.escape) {
        // Pickers and drill-down views run their own esc (back one step), so
        // the global one stays out.
        if (captureMode === "picker" || captureMode === "esc") return;
        if (region === "content") setRegion("sidebar");
        return;
      }
      // q quits from anywhere (typing is excluded by the text-capture return
      // above): no picker or drill-down uses the letter, and quitting is
      // always safe since the queue suspends and persists.
      if (input === "q") {
        quitAll();
        return;
      }
      if (captureMode === "none") {
        // Digits jump straight to a section, no sidebar round-trip.
        const jump = sectionForDigit(input);
        if (jump) {
          setSection(jump);
          setRegion("content");
          return;
        }
        // Search is one key away from anywhere: land in the Library with the
        // search box already open. (Inside the playlist picker, "/" keeps its
        // local filter meaning, hence the capture gate.)
        if (input === "/") {
          setSection("library");
          setRegion("content");
          setPendingSearch(true);
          return;
        }
      }
    },
    { isActive: isRawModeSupported && !welcome && !!boot },
  );

  // First-run setup can fail before anything exists (no network yet): r
  // retries the whole bootstrap, q quits. Only live on that error screen, so
  // it never overlaps the main handler above.
  useInput(
    (input) => {
      if (input === "r") {
        setError(null);
        setStatus("Getting your music ready…");
        setBootAttempt((n) => n + 1);
      } else if (input === "q") {
        exit();
      }
    },
    { isActive: isRawModeSupported && error !== null && !boot },
  );

  const setConfig = useCallback(
    (c: Config) => {
      setConfigState(c);
      boot?.queue.updateConfig(c);
      void saveConfig(c);
    },
    [boot],
  );

  const playTrack = useCallback(
    (t: Track, list?: Track[]) => {
      void boot?.playback.play(t, list ?? [t]);
    },
    [boot],
  );

  const store: Store | null = useMemo(() => {
    if (!boot || !config) return null;
    return {
      config,
      setConfig,
      library: boot.library,
      binaries: boot.binaries,
      queue: boot.queue,
      playback: boot.playback,
      history: boot.history,
      section,
      setSection,
      // While the cheatsheet is up, no pane owns the keyboard: every handler
      // gated on "content"/"sidebar" goes inactive without per-component edits.
      region: showHelp ? "help" : region,
      setRegion,
      captureMode,
      setCaptureMode,
      pendingSearch,
      setPendingSearch,
      pendingAdd,
      setPendingAdd,
      mpvStatus,
      listRows,
      contentWidth,
      cols,
      rows,
      playTrack,
    };
  }, [
    boot,
    config,
    section,
    region,
    showHelp,
    captureMode,
    pendingSearch,
    pendingAdd,
    mpvStatus,
    listRows,
    contentWidth,
    cols,
    rows,
    setConfig,
    playTrack,
  ]);

  if (error) {
    // Almost always a first run with no network: stay calm, offer a retry.
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <Text color={COLOR.warn}>
          Couldn&apos;t finish setup, check your internet
        </Text>
        <Box marginTop={1}>
          <Text wrap="truncate-end">
            <Text color={COLOR.alt}>r</Text>
            <Text dimColor> Try again</Text>
            <Text dimColor>{`  ${ICON.dot}  `}</Text>
            <Text color={COLOR.alt}>q</Text>
            <Text dimColor> Quit</Text>
          </Text>
        </Box>
      </Box>
    );
  }

  if (!store) {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        {showLogo ? (
          <Logo />
        ) : (
          <Text bold color={COLOR.accent}>
            soundcli
          </Text>
        )}
        <Box marginTop={1}>
          <Spinner label={status} />
        </Box>
      </Box>
    );
  }

  const ruleWidth = Math.max(10, cols - 2);

  return (
    <StoreContext.Provider value={store}>
      <Box flexDirection="column" paddingX={1}>
        <Box justifyContent="space-between">
          {showLogo ? (
            <Logo />
          ) : (
            <Text bold color={COLOR.accent}>
              soundcli
            </Text>
          )}
          {mpvStatus ? <Text dimColor>{mpvStatus}</Text> : null}
        </Box>
        {showTopRule ? <Rule width={ruleWidth} /> : null}

        {welcome ? (
          <Box marginTop={1}>
            <Welcome />
          </Box>
        ) : (
          <>
            {showHelp ? (
              // A self-sizing modal: rendered outside the fixed-height body so
              // it is never vertically compressed. The body below stays mounted
              // (display none) so in-progress state (fetched playlists, a
              // half-made selection) survives opening the cheatsheet.
              <Box marginTop={1}>
                <HelpOverlay />
              </Box>
            ) : null}
            <Box
              height={bodyH}
              marginTop={1}
              display={showHelp ? "none" : "flex"}
            >
              <Sidebar />
              <Box
                flexGrow={1}
                flexDirection="column"
                borderStyle={region === "content" ? "bold" : "single"}
                borderColor={region === "content" ? COLOR.accent : RULE}
                borderTop={false}
                borderRight={false}
                borderBottom={false}
                paddingLeft={2}
              >
                <Content section={section} />
              </Box>
            </Box>
            <Box
              flexDirection="column"
              display={showHelp ? "none" : "flex"}
            >
            {showDivider ? <Rule width={ruleWidth} /> : null}
            <NowPlayingBar />
            {showFooter ? <Footer hints={footerHints(region, section)} /> : null}
            </Box>
          </>
        )}
      </Box>
    </StoreContext.Provider>
  );
}
