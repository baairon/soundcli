import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout, useStdin } from "ink";
import { Spinner } from "@inkjs/ui";
import { saveConfig, type Config } from "../config/config";
import { createApp, type App as Core } from "../core/createApp";
import type { Track } from "../library/types";
import {
  StoreContext,
  type CaptureMode,
  type PlaylistsDepth,
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

  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("Getting your music ready…");
  const [mpvStatus, setMpvStatus] = useState<string | null>(null);
  const [boot, setBoot] = useState<Core | null>(null);
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

  // Fit the whole layout inside the terminal so content never gets clipped.
  // Below ~20 rows we go "compact": shed the footer hint bar (the `?`
  // cheatsheet still has every key) and the body's top margin, and sections
  // drop their idle search hint, so every freed row goes to the song list. The
  // now-playing divider holds until even shorter terminals force it out.
  const compact = rows < 20;
  // The block wordmark stays in every height, compact included, so the app
  // never reads as bare chrome; it's width-gated only. Below 34 cols there is
  // no logo (no text fallback), reserving a row only for the transient mpv
  // line, and the thin top rule alone marks the header.
  const showLogo = cols >= 34;
  const showTopRule = compact || showLogo;
  const showDivider = rows >= 12;
  const showFooter = !compact;
  const brandHeight = showLogo ? LOGO_LINES.length : mpvStatus ? 1 : 0;
  const chrome =
    brandHeight +
    (showTopRule ? 1 : 0) +
    (compact ? 0 : 1) + // body's marginTop
    (showDivider ? 1 : 0) +
    1 + // now-playing bar
    (showFooter ? 1 : 0);
  const bodyH = Math.max(6, rows - 1 - chrome);
  // Let the list fill the body: it's a fixed-height box and SongList already
  // windows its rows, so the only bound we need is the body height itself
  // (minus the standard header + a slack row). No fixed cap, which used to
  // strand dead space below the list on tall terminals.
  const listRows = Math.max(3, bodyH - 2);
  // Root padding (2) + sidebar (20) + its margin (1) + the content rail (1)
  // + its padding (2), with 2 columns of slack.
  const contentWidth = Math.max(20, cols - 28);

  const [section, setSection] = useState<Section>("library");
  // Launch with the sidebar menu focused so the first thing you meet is the
  // app's map; the song list is one tab/enter away.
  const [region, setRegion] = useState<Region>("sidebar");
  const [captureMode, setCaptureMode] = useState<CaptureMode>("none");
  const [showHelp, setShowHelp] = useState(false);
  const [pendingSearch, setPendingSearch] = useState(false);
  const [pendingAdd, setPendingAdd] = useState<string | null>(null);
  const [playlistsDepth, setPlaylistsDepth] =
    useState<PlaylistsDepth>("sets");

  useEffect(() => {
    if (booting.current) return;
    booting.current = true;
    void (async () => {
      const core = await createApp({
        initialAdd,
        onStatus: setStatus,
        onMpvStatus: (text, o) => {
          setMpvStatus(text);
          if (o?.transient) {
            if (mpvStatusTimer.current) clearTimeout(mpvStatusTimer.current);
            mpvStatusTimer.current = setTimeout(() => setMpvStatus(null), 8000);
          }
        },
      });
      setConfigState(core.config);
      setBoot(core);
      core.startBackgroundReconcile();
      if (initialAdd) {
        setSection("download");
        setRegion("content");
        setPendingAdd(initialAdd);
      }
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
      boot?.dispose();
    },
    [boot],
  );

  // Keep the library in step with disk without a restart: re-link files the
  // user moved or reorganized inside the library folder, adopt hand-added
  // audio, prune real deletions, and dedupe. Runs when landing on a
  // library-backed section, guarded so runs never stack and coalesced so rapid
  // tab-hops don't restat. The folder rescan is readdir-only, so a run that
  // finds no drift stays cheap.
  const runReconcile = useCallback(() => {
    boot?.reconcile(config?.libraryDir);
  }, [boot, config]);

  useEffect(() => {
    if (
      section === "library" ||
      section === "playlists" ||
      section === "history"
    ) {
      runReconcile();
    }
  }, [section, runReconcile]);

  const quitAll = useCallback(() => {
    boot?.dispose();
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
        // search box already open. Sections with their own search (playlists,
        // history) or paste (download) keep "/" local via this guard.
        if (input === "/") {
          if (
            section === "playlists" ||
            section === "download" ||
            section === "history"
          )
            return;
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
      playlistsDepth,
      setPlaylistsDepth,
      pendingSearch,
      setPendingSearch,
      pendingAdd,
      setPendingAdd,
      mpvStatus,
      listRows,
      compact,
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
    playlistsDepth,
    pendingSearch,
    pendingAdd,
    mpvStatus,
    listRows,
    compact,
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
          Couldn&apos;t set up the audio tools. Check your connection, or
          install yt-dlp and ffmpeg with your package manager.
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
        {showLogo ? <Logo /> : null}
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
          {showLogo ? <Logo /> : null}
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
              marginTop={compact ? 0 : 1}
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
            {showFooter ? (
              <Footer
                hints={footerHints(region, section, playlistsDepth)}
              />
            ) : null}
            </Box>
          </>
        )}
      </Box>
    </StoreContext.Provider>
  );
}
