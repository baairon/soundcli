// Renders the welcome screen with placeholder data into preview/welcome.svg
// (the README hero). Mirrors App.tsx's chrome (logo + rule) above the real
// Welcome view at a fixed 80 cols. Data comes from fake-data.ts: layout only,
// no real song or artist names anywhere.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { render } from "ink-testing-library";
import { Box } from "ink";
import { ThemeProvider } from "@inkjs/ui";
import { StoreContext, type Store } from "../src/ui/store";
import { uiTheme, COLOR } from "../src/ui/theme";
import { Logo } from "../src/ui/components/Logo";
import { Rule } from "../src/ui/components/Rule";
import { HelpOverlay } from "../src/ui/components/HelpOverlay";
import { NowPlayingBar } from "../src/ui/components/NowPlayingBar";
import { Footer } from "../src/ui/components/Footer";
import { Sidebar } from "../src/ui/components/Sidebar";
import { Welcome } from "../src/ui/views/Welcome";
import { Library as LibrarySection } from "../src/ui/sections/Library";
import { footerHints } from "../src/ui/keymap";
import { ansiToSvg } from "./ansi-to-svg";
import { makeStore, makeFakePlayback, PLACEHOLDER_TRACKS } from "./fake-data";

const COLS = 80;
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "preview");
mkdirSync(OUT_DIR, { recursive: true });

function save(name: string, store: Store, node: React.ReactNode): void {
  const { lastFrame, unmount } = render(
    <ThemeProvider theme={uiTheme}>
      <StoreContext.Provider value={store}>{node}</StoreContext.Provider>
    </ThemeProvider>,
  );
  const frame = lastFrame() ?? "";
  unmount();
  if (!/\x1b\[/.test(frame)) {
    throw new Error(`${name}: frame has no ANSI colors (FORCE_COLOR didn't take)`);
  }
  const svg = ansiToSvg(frame, { cols: COLS, title: "soundcli" });
  writeFileSync(join(OUT_DIR, `${name}.svg`), svg);
  console.log(`preview/${name}.svg`);
}

// The first-run intro: logo, the pitch, and the source picker.
const welcomeStore = makeStore({
  binaries: { ffmpeg: "", ffprobe: "", ytDlp: "", mpv: "mpv" },
  // No playlist on the staged track: the bar line fits 80 cols untruncated.
  // Fully played, so the progress bar shows the whole gradient ramp.
  playback: makeFakePlayback({
    track: { ...PLACEHOLDER_TRACKS[0]!, playlist: undefined },
    position: 73,
    duration: 97,
  }),
});
save(
  "welcome",
  welcomeStore,
  <Box flexDirection="column" width={COLS} paddingX={1}>
    <Box>
      <Logo />
    </Box>
    <Rule width={COLS - 2} />
    <Box marginTop={1}>
      <Welcome />
    </Box>
    {/* The player bar mid-song, so the hero shows the app making music. */}
    <Box flexDirection="column" marginTop={1}>
      <Rule width={COLS - 2} />
      <NowPlayingBar />
    </Box>
  </Box>,
);

// The everyday view: sidebar, the library with group headers, and the player
// mid-song. Mirrors App.tsx's main chrome so the README shows the real app.
const libraryStore = makeStore({
  playback: makeFakePlayback({
    track: { ...PLACEHOLDER_TRACKS[2]!, playlist: undefined },
    position: 96,
    duration: 251,
  }),
});
save(
  "library",
  libraryStore,
  <Box flexDirection="column" width={COLS} paddingX={1}>
    <Box>
      <Logo />
    </Box>
    <Rule width={COLS - 2} />
    <Box height={14} marginTop={1}>
      <Sidebar />
      <Box
        flexGrow={1}
        flexDirection="column"
        borderStyle="bold"
        borderColor={COLOR.accent}
        borderTop={false}
        borderRight={false}
        borderBottom={false}
        paddingLeft={2}
      >
        <LibrarySection />
      </Box>
    </Box>
    <Box flexDirection="column">
      <Rule width={COLS - 2} />
      <NowPlayingBar />
      <Footer hints={footerHints("content", "library")} />
    </Box>
  </Box>,
);

// The `?` cheatsheet card on its own, for the README's keys section.
save(
  "keys",
  makeStore({}),
  <Box flexDirection="column" width={COLS} paddingX={1}>
    <HelpOverlay />
  </Box>,
);
