// Central visual vocabulary for the TUI: one place for accent colors and the
// small glyph set we trust to render in a terminal. Keeping these here means
// every section speaks the same visual language instead of each picking its own.

import { defaultTheme, extendTheme } from "@inkjs/ui";

export const COLOR = {
  /** Brand accent: deep flame orange. Used for focus, cursors, and progress. */
  accent: "#ff6a3d",
  /** Warm off-white for prominent body text, so it doesn't read as harsh
   *  default-white against the warm palette. */
  text: "#ece4da",
  /** Secondary accent (honey brass) for paths, inline keys, and group
   *  headers: a warm gold-sand that reads as hardware next to the flame
   *  accent, sandier than `warn` so warning banners still read hotter. */
  alt: "#e0b380",
  /** Now-playing / success: soft mint-green, kept clearly apart from the warm
   *  accent so the playing marker reads at a glance. */
  good: "#86d6a2",
  /** Warnings (rate limits, empty results): golden amber, nudged yellow so it
   *  reads as caution rather than melting into the orange accent. */
  warn: "#f0c560",
  /** Failures: rose, pushed pink/cool so errors never read as the accent. */
  bad: "#ee7d92",
  /** Sunlit amber: the bright end of the accent ramp, and the saves-to path
   *  on the Welcome screen. */
  amber: "#ffb163",
} as const;

/**
 * Glyphs known to render in Windows Terminal, macOS Terminal, and common Linux
 * emulators. Kept deliberately tiny.
 */
export const ICON = {
  play: "▶",
  pause: "⏸",
  done: "✓",
  error: "✗",
  canceled: "⊘",
  skipped: "•",
  pending: "·",
  pointer: "❯",
  dot: "·",
  warn: "⚠",
  shuffle: "⇄",
  repeat: "↻",
  /** Solid left edge used to mark the active nav row. */
  bar: "▌",
} as const;

/** A soft warm gray used for separators and rules so they recede behind content. */
export const RULE = "#6b635d";

/** Parse "#rrggbb" into [r, g, b]. */
function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Linear-interpolate two "#rrggbb" colors; t in [0, 1]. */
export function lerpHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = rgb(a);
  const [br, bg, bb] = rgb(b);
  const c = (x: number, y: number) =>
    Math.round(x + (y - x) * t)
      .toString(16)
      .padStart(2, "0");
  return `#${c(ar, br)}${c(ag, bg)}${c(ab, bb)}`;
}

/**
 * The accent's glow ramp (deep flame → sunlit amber). Progress fills and the
 * wordmark sweep this same pair, so the orange reads as one warm material
 * throughout the app instead of a flat fill.
 */
export const ACCENT_RAMP: readonly [string, string] = [
  COLOR.accent,
  COLOR.amber,
];

/**
 * @inkjs/ui theme override so its Select and Spinner share our orange accent
 * instead of their default green/blue. Without this the list cursor and
 * loading spinners would clash with the brand color.
 */
export const uiTheme = extendTheme(defaultTheme, {
  components: {
    Select: {
      styles: {
        focusIndicator: () => ({ color: COLOR.accent }),
        selectedIndicator: () => ({ color: COLOR.accent }),
        label: (props: { isFocused?: boolean; isSelected?: boolean } = {}) => ({
          color: props.isFocused || props.isSelected ? COLOR.accent : undefined,
        }),
      },
    },
    Spinner: {
      styles: {
        frame: () => ({ color: COLOR.accent }),
      },
    },
  },
});
