// Single source of truth for keyboard shortcuts. The footer shows a tiny
// context-relevant subset; the `?` overlay shows everything. Defining them once
// here means the quick hint and the full cheatsheet can never drift apart, and
// the UI never has to dump a wall of commands at the user.

import type { PlaylistsDepth, Region, Section } from "./store";

export interface Hint {
  keys: string;
  label: string;
}

interface HelpGroup {
  title: string;
  hints: Hint[];
}

/** Sidebar sections in display order, so digit keys can jump straight to one. */
const SECTION_ORDER: Section[] = [
  "library",
  "playlists",
  "history",
  "download",
  "progress",
  "settings",
];

/** Map "1".."6" to its section (the sidebar's display order); null otherwise. */
export function sectionForDigit(input: string): Section | null {
  if (!/^[1-6]$/.test(input)) return null;
  return SECTION_ORDER[Number(input) - 1] ?? null;
}

/** The full cheatsheet, shown in the `?` overlay, grouped by intent. */
export const HELP_GROUPS: HelpGroup[] = [
  {
    title: "Navigate",
    hints: [
      { keys: "↑ ↓", label: "Move" },
      { keys: "PgUp PgDn", label: "Jump a page" },
      { keys: "↵", label: "Open / play" },
      { keys: "1-5", label: "Jump section" },
      { keys: "/", label: "Search" },
      { keys: "d", label: "Delete" },
      { keys: "tab", label: "Switch pane" },
      { keys: "esc", label: "Back" },
      { keys: "q", label: "Quit" },
    ],
  },
  {
    title: "Player",
    hints: [
      { keys: "space", label: "Play / pause" },
      { keys: "← →", label: "Seek 15s" },
      { keys: ", .", label: "Seek 5s" },
      { keys: "0", label: "Restart song" },
      { keys: "n p", label: "Next / prev" },
      { keys: "r", label: "Repeat" },
      { keys: "s", label: "Shuffle" },
      { keys: "+ -", label: "Volume" },
    ],
  },
  {
    title: "Downloads",
    hints: [
      { keys: "[ ]", label: "Pause / resume all" },
      { keys: "c", label: "Cancel all" },
      { keys: "↵", label: "Dismiss done" },
      { keys: "f", label: "Retry failed" },
      { keys: "space", label: "Pick: toggle row" },
    ],
  },
];

const ALWAYS: Hint = { keys: "?", label: "Keys" };

/**
 * The handful of hints worth showing inline for the current focus. Always ends
 * with "? Keys" so the full set is one keystroke away without crowding the bar.
 */
export function footerHints(
  region: Region,
  section: Section,
  playlistsDepth: PlaylistsDepth = "sets",
): Hint[] {
  if (region === "sidebar") {
    return [
      { keys: "↑↓", label: "Move" },
      { keys: "↵", label: "Open" },
      ALWAYS,
      { keys: "q", label: "Quit" },
    ];
  }
  switch (section) {
    case "settings":
      return [
        { keys: "↵", label: "Choose" },
        { keys: "esc", label: "Back" },
        ALWAYS,
      ];
    case "download":
      // Download explains ↵ contextually in-section (choose / pause-resume), so
      // the footer stays neutral and never contradicts the in-list legend.
      return [
        { keys: "esc", label: "Back" },
        ALWAYS,
      ];
    case "progress":
      return [
        { keys: "r", label: "Resume now" },
        { keys: "esc", label: "Back" },
        ALWAYS,
      ];
    case "playlists":
      if (playlistsDepth === "songs") {
        return [
          { keys: "↵", label: "Play" },
          { keys: "/", label: "Search" },
          { keys: "d", label: "Delete" },
          { keys: "esc", label: "Back" },
          ALWAYS,
        ];
      }
      return [
        { keys: "↵", label: "Open" },
        { keys: "/", label: "Search" },
        { keys: "[ ]", label: "Source" },
        { keys: "d", label: "Delete" },
        ALWAYS,
      ];
    case "history":
      return [
        { keys: "↵", label: "Play" },
        { keys: "/", label: "Search" },
        { keys: "[ ]", label: "Source" },
        { keys: "d", label: "Delete" },
        ALWAYS,
      ];
    case "library":
      return [
        { keys: "↵", label: "Play" },
        { keys: "/", label: "Search" },
        { keys: "[ ]", label: "Source" },
        { keys: "d", label: "Delete" },
        { keys: "esc", label: "Back" },
        ALWAYS,
      ];
  }
}
