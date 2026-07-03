import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { useStore } from "../store";
import { wrapStep } from "../move";
import { cleanText } from "../../util/format";
import { COLOR, ICON } from "../theme";

export interface SongItem {
  /** Stable id used for selection + the now-playing match. */
  value: string;
  title: string;
  artist?: string;
  /** Right-aligned dim detail (e.g. a duration, or a set's song count). */
  meta?: string;
}

export interface SongGroup {
  /** Optional dim section header; omit for a flat list. */
  title?: string;
  items: SongItem[];
}

interface SongListProps {
  groups: SongGroup[];
  /** Optional leading action row (e.g. "Shuffle all"), always selectable. */
  action?: { value: string; label: string };
  /** Track id currently playing, marked with ▶. */
  playingId?: string;
  focused: boolean;
  /** Lines the section renders above this list (its header / filter tabs), so
   *  the window never overflows the body box (which corrupts Ink's redraw). */
  reserveRows?: number;
  onSelect: (value: string) => void;
  /** When set, `d` on an item row (never the action row) asks to delete it. */
  onDelete?: (value: string) => void;
  /** When true, `d` always targets the playing track (playingId) rather than
   *  the cursor row, matching how scrub keys act on the playing song. Use in
   *  Library and History where the playing song should be deletable without
   *  moving the cursor to it. */
  deleteTargetsPlaying?: boolean;
  /** Show 1-based track numbers before each item (the drill-in playlist look). */
  numbered?: boolean;
  /** Insert a blank line between the leading action row and the first item. */
  actionGap?: boolean;
  /** When set, `t` on an item row (never the action row) asks to rename it. */
  onRename?: (value: string) => void;
}

type Row =
  | { kind: "header"; title: string }
  | { kind: "spacer" }
  | { kind: "action"; value: string; label: string; idx: number }
  | { kind: "item"; item: SongItem; idx: number; no: number };

/** Section header row directly above `rowIndex`, if any. */
function headerAbove(rows: Row[], rowIndex: number): number {
  for (let i = rowIndex; i >= 0; i--) {
    if (rows[i]?.kind === "header") return i;
  }
  return -1;
}

/**
 * Scroll offset that keeps the cursor on screen, centred when possible, and
 * pins the active section header into the window when both still fit (short
 * terminals otherwise centre past the header and it vanishes).
 */
function scrollStart(rows: Row[], cursorRow: number, height: number): number {
  if (cursorRow < 0 || rows.length === 0) return 0;
  const maxStart = Math.max(0, rows.length - height);
  const preferred = Math.min(
    Math.max(0, cursorRow - Math.floor(height / 2)),
    maxStart,
  );

  const headerRow = headerAbove(rows, cursorRow);
  if (headerRow < 0) return preferred;

  const minStart = Math.max(0, cursorRow - height + 1);
  const maxStartForHeader = Math.min(headerRow, maxStart);
  if (minStart <= maxStartForHeader) {
    return Math.max(minStart, Math.min(preferred, maxStartForHeader));
  }
  return Math.max(minStart, Math.min(preferred, maxStart));
}

/**
 * A scrollable, keyboard-driven single-select song list. We render it ourselves
 * (instead of @inkjs/ui Select) so the cursor never resets when the now-playing
 * row changes, and every row is truncated to exactly one line. The cursor moves
 * over selectable rows only, skipping section headers.
 */
export function SongList({
  groups,
  action,
  playingId,
  focused,
  reserveRows = 0,
  onSelect,
  onDelete,
  deleteTargetsPlaying,
  numbered,
  actionGap,
  onRename,
}: SongListProps) {
  const { listRows } = useStore();
  const [cursor, setCursor] = useState(0);

  // Flatten to display rows, numbering only the selectable ones.
  const rows: Row[] = [];
  let idx = 0;
  let no = 0;
  if (action) {
    rows.push({ kind: "action", value: action.value, label: action.label, idx });
    idx++;
    if (actionGap) rows.push({ kind: "spacer" });
  }
  for (const g of groups) {
    if (g.items.length === 0) continue;
    if (g.title) rows.push({ kind: "header", title: g.title });
    for (const item of g.items) {
      no++;
      rows.push({ kind: "item", item, idx, no });
      idx++;
    }
  }
  const selectableCount = idx;
  // Width of the widest track number, so the index column stays aligned.
  const numWidth = String(no).length;
  const values: string[] = rows
    .filter(
      (r): r is Extract<Row, { idx: number }> =>
        r.kind === "action" || r.kind === "item",
    )
    .map((r) => (r.kind === "action" ? r.value : r.item.value));

  // Keep the cursor in range if the list shrank between renders.
  const clamped = Math.min(cursor, Math.max(0, selectableCount - 1));

  // A page-jump moves by roughly a visible screenful.
  const page = Math.max(1, listRows - reserveRows - 1);

  useInput(
    (input, key) => {
      // Single steps wrap around the edges; page jumps still clamp.
      if (key.upArrow) setCursor(wrapStep(clamped, -1, selectableCount));
      else if (key.downArrow)
        setCursor(wrapStep(clamped, 1, selectableCount));
      else if (key.pageUp) setCursor(Math.max(0, clamped - page));
      else if (key.pageDown)
        setCursor(Math.min(selectableCount - 1, clamped + page));
      else if (key.return) {
        const v = values[clamped];
        if (v) onSelect(v);
      } else if (input === "d" && onDelete) {
        // deleteTargetsPlaying: 'd' acts on the playing song (like scrub keys)
        // rather than the cursor row. Falls back to cursor when nothing plays.
        if (deleteTargetsPlaying && playingId) {
          onDelete(playingId);
        } else {
          const row = rows.find((r) => r.kind === "item" && r.idx === clamped);
          if (row?.kind === "item") onDelete(row.item.value);
        }
      } else if (input === "t" && onRename) {
        const row = rows.find((r) => r.kind === "item" && r.idx === clamped);
        if (row?.kind === "item") onRename(row.item.value);
      }
    },
    { isActive: focused && selectableCount > 0 },
  );

  // Scroll window: keep the cursor row visible, centred when possible. The
  // window must fit within the lines the section left us, or the body overflows
  // the terminal and Ink's incremental redraw mangles rows (merged / dropped).
  const height = Math.max(1, listRows - reserveRows);
  const cursorRow = rows.findIndex(
    (r) => (r.kind === "action" || r.kind === "item") && r.idx === clamped,
  );
  const start = scrollStart(rows, cursorRow, height);
  const visible = rows.slice(start, start + height);

  return (
    <Box flexDirection="column">
      {visible.map((r, i) => {
        if (r.kind === "header") {
          return (
            <Box key={`h-${start + i}`}>
              <Text color={COLOR.alt}>{r.title}</Text>
            </Box>
          );
        }
        if (r.kind === "spacer") {
          return (
            <Box key={`sp-${start + i}`}>
              <Text> </Text>
            </Box>
          );
        }
        const here = r.idx === clamped && focused;
        const value = r.kind === "action" ? r.value : r.item.value;
        const playing = playingId !== undefined && value === playingId;
        // Right-aligned dim detail (duration / set size). Action rows have none.
        const meta = r.kind === "item" ? r.item.meta : undefined;
        // The title leads in warm text and takes the orange accent when it's
        // the cursor row or the playing song; the artist trails dim. That gentle
        // contrast gives each row an anchor instead of one flat grey blur.
        const titleColor = here || playing ? COLOR.accent : COLOR.text;
        return (
          <Box key={value}>
            <Text color={COLOR.accent}>{here ? `${ICON.pointer} ` : "  "}</Text>
            <Text color={COLOR.good}>{playing ? `${ICON.play} ` : "  "}</Text>
            {numbered && r.kind === "item" ? (
              <Box flexShrink={0} marginRight={1}>
                <Text dimColor>{String(r.no).padStart(numWidth)}</Text>
              </Box>
            ) : null}
            <Box flexGrow={1} minWidth={0}>
              {r.kind === "action" ? (
                <Text
                  wrap="truncate-end"
                  color={here ? COLOR.accent : undefined}
                  dimColor={!here}
                  bold={here}
                >
                  {r.label}
                </Text>
              ) : (
                <Text wrap="truncate-end">
                  <Text color={titleColor} bold={here}>
                    {cleanText(r.item.title)}
                  </Text>
                  {r.item.artist ? (
                    <Text dimColor>{`  ${ICON.dot}  ${cleanText(r.item.artist)}`}</Text>
                  ) : null}
                </Text>
              )}
            </Box>
            {meta ? (
              <Box flexShrink={0} marginLeft={2}>
                <Text dimColor>{meta}</Text>
              </Box>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}
