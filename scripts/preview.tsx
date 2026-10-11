// Renders the single-page dashboard to stdout so we can eyeball it without a TTY.
//   npx tsx scripts/preview.tsx
// Uses the shared placeholder data (fake-data.ts): layout only, no real names.
import React from "react";
import { render } from "ink-testing-library";
import { Box, Text } from "ink";
import { ThemeProvider } from "@inkjs/ui";
import { StoreContext, type Store } from "../src/ui/store";
import { uiTheme } from "../src/ui/theme";
import { Sidebar } from "../src/ui/components/Sidebar";
import { NowPlayingBar } from "../src/ui/components/NowPlayingBar";
import { Logo } from "../src/ui/components/Logo";
import { Footer } from "../src/ui/components/Footer";
import { HelpOverlay } from "../src/ui/components/HelpOverlay";
import { footerHints } from "../src/ui/keymap";
import { Download } from "../src/ui/sections/Download";
import { Settings } from "../src/ui/sections/Settings";
import { Library as LibrarySection } from "../src/ui/sections/Library";
import {
  PLACEHOLDER_TRACKS,
  FakeQueue,
  asQueue,
  makeFakePlayback,
  makeStore,
} from "./fake-data";
import type { QueueItem } from "../src/download/queue";

const base: Store = makeStore({
  region: "sidebar",
  listRows: 10,
  contentWidth: 48,
  cols: 72,
});

function Frame({ section }: { section: React.ReactNode }) {
  const rule = "─".repeat(70);
  return (
    <Box flexDirection="column">
      <Logo />
      <Text dimColor>{rule}</Text>
      <Box marginTop={1}>
        <Sidebar />
        <Box
          flexGrow={1}
          flexDirection="column"
          borderStyle="round"
          borderColor="gray"
          borderTop={false}
          borderRight={false}
          borderBottom={false}
          paddingLeft={2}
        >
          {section}
        </Box>
      </Box>
      <Text dimColor>{rule}</Text>
      <NowPlayingBar />
    </Box>
  );
}

function show(label: string, store: Store, section: React.ReactNode) {
  const { lastFrame, unmount } = render(
    <ThemeProvider theme={uiTheme}>
      <StoreContext.Provider value={store}>
        <Frame section={section} />
      </StoreContext.Provider>
    </ThemeProvider>,
  );
  console.log(`\n=== ${label} ===`);
  console.log(lastFrame());
  unmount();
}

const libStore: Store = { ...base, section: "library", region: "content" };
show("LIBRARY (content focus)", libStore, <LibrarySection />);

const pickStore: Store = { ...base, section: "download", region: "content" };
show("DOWNLOAD (source picker)", pickStore, <Download />);

// The queue view with a live mix: downloading, retrying, paused, queued, done.
const qt = (n: number, title: string) => ({
  id: String(n),
  title,
  downloadUrl: "x",
});
const dlItems: QueueItem[] = [
  { id: "q1", source: "youtube", sourceLabel: "YouTube", track: qt(1, "Song Title"), status: "downloading", percent: 62, speed: 1_300_000, eta: 12 },
  { id: "q5", source: "youtube", sourceLabel: "YouTube", track: qt(5, "Late Night Song"), status: "downloading", percent: 30, retrying: true },
  { id: "q2", source: "soundcloud", sourceLabel: "SoundCloud", track: qt(2, "Another Song"), status: "paused", percent: 40 },
  { id: "q3", source: "youtube", sourceLabel: "YouTube", track: qt(3, "Third Song"), status: "pending", percent: 0 },
  { id: "q6", source: "youtube", sourceLabel: "YouTube", track: qt(6, "Morning Song"), status: "pending", percent: 0 },
  { id: "q4", source: "youtube", sourceLabel: "YouTube", track: qt(4, "Quiet Song"), status: "done", percent: 100 },
];
const dlStore: Store = {
  ...base,
  section: "download",
  region: "content",
  queue: asQueue(new FakeQueue(dlItems)),
};
show("DOWNLOAD (queue: downloading + retrying + paused + queued + done)", dlStore, <Download />);

const dlLimited: QueueItem[] = [
  { id: "r1", source: "youtube", sourceLabel: "YouTube", track: qt(1, "Song Title"), status: "paused", percent: 55 },
  { id: "r2", source: "youtube", sourceLabel: "YouTube", track: qt(2, "Another Song"), status: "error", percent: 0, error: "HTTP Error 403: Forbidden" },
];
const dlRate: Store = {
  ...base,
  section: "download",
  region: "content",
  queue: asQueue(new FakeQueue(dlLimited, true)),
};
show("DOWNLOAD (rate limited → stop banner)", dlRate, <Download />);

// A stopped batch: dead tracks state their reason once and offer no retry.
const drm = "ERROR: [soundcloud] 900000008: This video is DRM protected";
const dlStoppedItems: QueueItem[] = [
  { id: "s1", source: "soundcloud", sourceLabel: "SoundCloud", track: qt(1, "Song Title"), status: "error", percent: 0, error: drm },
  { id: "s2", source: "soundcloud", sourceLabel: "SoundCloud", track: qt(2, "Another Song"), status: "error", percent: 0, error: drm },
  { id: "s3", source: "soundcloud", sourceLabel: "SoundCloud", track: qt(3, "Third Song"), status: "error", percent: 0, error: drm },
  { id: "s4", source: "youtube", sourceLabel: "YouTube", track: qt(4, "Quiet Song"), status: "error", percent: 0, error: "ERROR: [youtube] x: Private video" },
  { id: "s5", source: "youtube", sourceLabel: "YouTube", track: qt(5, "Late Night Song"), status: "canceled", percent: 0 },
  { id: "s6", source: "youtube", sourceLabel: "YouTube", track: qt(6, "Morning Song"), status: "done", percent: 100 },
];
const dlStopped: Store = {
  ...base,
  section: "download",
  region: "content",
  queue: asQueue(new FakeQueue(dlStoppedItems)),
};
show("DOWNLOAD (stopped batch: dead tracks, no retry)", dlStopped, <Download />);

const settingsStore: Store = { ...base, section: "settings", region: "content" };
show("SETTINGS (content focus)", settingsStore, <Settings />);

// Standalone bits: the contextual footer and the `?` cheatsheet overlay.
function showRaw(label: string, node: React.ReactNode) {
  const { lastFrame, unmount } = render(
    <ThemeProvider theme={uiTheme}>{node}</ThemeProvider>,
  );
  console.log(`\n=== ${label} ===`);
  console.log(lastFrame());
  unmount();
}
showRaw(
  "FOOTER (sidebar / library / download contexts)",
  <Box flexDirection="column">
    <Footer hints={footerHints("sidebar", "library")} />
    <Footer hints={footerHints("content", "library")} />
    <Footer hints={footerHints("content", "download")} />
  </Box>,
);
showRaw(
  "HELP OVERLAY (press ?)",
  <StoreContext.Provider value={{ ...base, cols: 100 }}>
    <HelpOverlay />
  </StoreContext.Provider>,
);

// The mpv now-playing bar (progress + clock + volume + shuffle/repeat badges),
// which the empty-queue store above can't show.
const npStore: Store = {
  ...base,
  cols: 80,
  playback: makeFakePlayback({ track: PLACEHOLDER_TRACKS[0] }),
};
showRaw(
  "NOW PLAYING (mpv: progress, clock, volume, shuffle+repeat)",
  <StoreContext.Provider value={npStore}>
    <NowPlayingBar />
  </StoreContext.Provider>,
);
console.log();
