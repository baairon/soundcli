import { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { Select, Spinner, StatusMessage } from "@inkjs/ui";
import { useStore, useQueueItems, type CaptureMode } from "../store";
import { wrapStep } from "../move";
import { TextField } from "../components/TextField";
import { Header } from "../components/Header";
import { GradientBar } from "../components/GradientBar";
import { detectInput, detectPasteLink, isLinkInput } from "../../sources/detect";
import { tracksFromUrl } from "../../sources/enqueue-url";
import { persistableHandle } from "../../sources/persist-handle";
import { makeYoutube } from "../../sources/youtube";
import { makeSoundcloud } from "../../sources/soundcloud";
import { makeSpotify } from "../../sources/spotify/adapter";
import {
  clearPartials,
  getPartials,
  type PartialNotice,
} from "../../sources/partials";
import { COLOR, ICON } from "../theme";
import {
  cleanText,
  displayUrl,
  formatBytesPerSec,
  formatEtaShort,
  linkCollectionTitle,
  trackDisplayTitle,
} from "../../util/format";
import { WAITING_FOR_TOOLS, type QueueItem } from "../../download/queue";
import type { SourceAdapter, SourcePlaylist } from "../../sources/types";
import { SOURCE_LABELS, type SourceId } from "../../library/types";

type Step =
  /** The landing view: pick a source to browse. */
  | { name: "pick-source" }
  | { name: "need-handle"; source: SourceId }
  | { name: "loading"; message: string; source?: SourceId }
  | { name: "pick-lists"; adapter: SourceAdapter; lists: SourcePlaylist[] }
  | {
      name: "adding";
      /** Progress while gathering each selected list's tracks (before enqueue). */
      gather: { done: number; total: number };
    }
  | { name: "queue" }
  | { name: "empty"; label: string; source: SourceId }
  | { name: "info"; message: string }
  | { name: "error"; message: string; source?: SourceId };

const SOURCES: {
  id: SourceId;
  name: string;
  desc: string;
}[] = [
  { id: "youtube", name: "YouTube", desc: "Your public playlists" },
  { id: "soundcloud", name: "SoundCloud", desc: "Your likes & playlists" },
  { id: "spotify", name: "Spotify", desc: "Your public playlists" },
];

const PROMPTS: Record<
  Exclude<SourceId, "link">,
  { title: string; hint: string; placeholder: string }
> = {
  youtube: {
    title: "YouTube channel or playlist",
    hint: "Enter an @handle, or paste a full link",
    placeholder: "e.g. @username or https://youtube.com/...",
  },
  soundcloud: {
    title: "SoundCloud profile or playlist",
    hint: "Enter a username, or paste a full link",
    placeholder: "e.g. username or https://soundcloud.com/...",
  },
  spotify: {
    title: "Spotify profile or playlist",
    hint: "Enter a username, or paste a full link",
    placeholder: "e.g. username or https://open.spotify.com/...",
  },
};

/** Title + dim subtext as one block — same spacing as Welcome's intro. */
function PageIntro({
  title,
  hint,
  focused,
}: {
  title: string;
  hint: string;
  focused?: boolean;
}) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color={focused ? COLOR.accent : COLOR.text}>
        {title}
      </Text>
      {hint ? (
        <Text dimColor wrap="truncate-end">
          {hint}
        </Text>
      ) : null}
    </Box>
  );
}

/** Key hints pinned under the main content — same spacing everywhere. */
function FooterHint({ children }: { children: string }) {
  return (
    <Box marginTop={1}>
      <Text dimColor wrap="truncate-end">
        {children}
      </Text>
    </Box>
  );
}

/** Pointer row with an aligned label column and inline description. */
function MenuRow({
  label,
  desc,
  here,
  focused,
  nameWidth,
}: {
  label: string;
  desc: string;
  here: boolean;
  focused: boolean;
  nameWidth: number;
}) {
  const active = here && focused;
  return (
    <Box>
      <Text color={COLOR.accent}>{active ? `${ICON.pointer} ` : "  "}</Text>
      <Text
        color={active ? COLOR.accent : undefined}
        dimColor={!active}
        bold={active}
      >
        {label.padEnd(nameWidth)}
      </Text>
      <Text dimColor>{`   ${desc}`}</Text>
    </Box>
  );
}

function menuNameWidth(): number {
  return Math.max(...SOURCES.map((s) => s.name.length));
}

// ── Queue item rendering ────────────────────────────────────────────────

// Partial on purpose: if the queue gains a new status later, we fall back to a
// neutral dot instead of failing to compile.
const MARK: Partial<Record<QueueItem["status"], string>> = {
  done: ICON.done,
  error: ICON.error,
  canceled: ICON.canceled,
  skipped: ICON.skipped,
  paused: ICON.pause,
  pending: ICON.pending,
  downloading: ICON.play,
};

const MARK_COLOR: Partial<Record<QueueItem["status"], string>> = {
  downloading: COLOR.accent,
  done: COLOR.good,
  error: COLOR.bad,
  paused: COLOR.warn,
};

/**
 * A calm, human reason for the row's right edge. Raw tool output (exit codes,
 * stderr dumps) never reaches the screen: we bucket the few causes a user can
 * actually do something about and fall back to a generic phrase, since "f
 * Retry" is the answer to almost all of them anyway.
 */
function shortError(e?: string): string {
  if (!e) return "couldn't save";
  const m = e.toLowerCase();
  if (m.includes("missing on disk")) return "file didn't save";
  if (m.includes("drm")) return "DRM protected";
  if (
    m.includes("unavailable") ||
    m.includes("private") ||
    m.includes("removed") ||
    m.includes("not exist") ||
    m.includes("404")
  )
    return "track unavailable";
  if (m.includes("sign in") || m.includes("login") || m.includes("age"))
    return "needs sign-in";
  if (m.includes("403") || m.includes("forbidden")) return "blocked, retry later";
  if (
    m.includes("timed out") ||
    m.includes("timeout") ||
    m.includes("network") ||
    m.includes("connection") ||
    m.includes("getaddrinfo")
  )
    return "network hiccup";
  return "couldn't save";
}

/**
 * One queue row, always exactly one line: a colored status mark, the title
 * truncated to whatever space is left, and a right-aligned detail that never
 * shrinks. Errors stay short so nothing ever wraps.
 */
function QueueRow({ item }: { item: QueueItem }) {
  let detail = "";
  let detailColor: string | undefined;
  let detailDim = true;
  switch (item.status) {
    case "downloading": {
      const speed = formatBytesPerSec(item.speed);
      detail =
        item.percent > 0 || speed
          ? `${Math.round(item.percent)}%${speed ? `  ${speed}` : ""}`
          : "starting…";
      detailDim = false;
      break;
    }
    case "pending":
      detail = "queued";
      break;
    case "paused":
      detail =
        item.percent > 0 ? `paused ${Math.round(item.percent)}%` : "paused";
      break;
    case "done":
      detail = item.unverifiedMatch ? "saved, unverified" : "saved";
      break;
    case "skipped":
      detail = "already saved";
      break;
    case "error":
      // Failed rows stay quiet: a dimmed rose mark and reason, not a wall of
      // red. The header's failed count + "f Retry" carry the call to action.
      detail = shortError(item.error);
      detailColor = COLOR.bad;
      break;
    case "canceled":
      detail = "canceled";
      break;
  }
  const active = item.status === "downloading";
  const quiet = item.status === "error";
  return (
    <Box>
      <Text
        color={MARK_COLOR[item.status]}
        dimColor={quiet || !MARK_COLOR[item.status]}
      >
        {`${MARK[item.status] ?? ICON.pending} `}
      </Text>
      <Box flexGrow={1} minWidth={0}>
        <Text wrap="truncate-end" dimColor={!active}>
          {trackDisplayTitle(item.track)}
        </Text>
      </Box>
      <Box flexShrink={0} marginLeft={2}>
        <Text color={detailColor} dimColor={detailDim}>
          {detail}
        </Text>
      </Box>
    </Box>
  );
}

// ── Queue view ──────────────────────────────────────────────────────────

/** One calm line summarizing any playlists a source returned cut short. */
function partialNoticeText(partials: PartialNotice[]): string {
  const p = partials[0]!;
  const label = SOURCE_LABELS[p.source];
  const lead = `${ICON.dot} ${label} gave ${p.got.toLocaleString()} of ${p.total.toLocaleString()} tracks for "${p.title}"`;
  const more = partials.length - 1;
  return more > 0 ? `${lead}  ${ICON.dot}  +${more} more cut short` : lead;
}

function QueueView() {
  const { queue, region, listRows } = useStore();
  const items = useQueueItems(queue);
  const s = queue.stats();
  const focused = region === "content";
  const [offset, setOffset] = useState(0);

  // Live rows sort to the top so at offset 0 the list follows the action;
  // failures sink to the bottom (the header count, f Retry, and the banner
  // carry them) instead of burying the queue under red rows.
  const STATUS_ORDER: Record<QueueItem["status"], number> = {
    downloading: 0,
    paused: 1,
    pending: 2,
    done: 3,
    skipped: 3,
    error: 4,
    canceled: 5,
  };

  const sortedItems = [...items].sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status],
  );

  // Exact row budget so the body never overflows (which corrupts Ink's
  // redraw): listRows already covers the standard 2-row header; our chrome
  // beyond that is the progress block (2 extra rows), the rate-limit banner,
  // and the command hints, which we shed first on squashed terminals.
  const showCmds = listRows >= 6;
  // At most one banner renders at a time (rate-limit wins), so both share
  // the same 2-row reservation.
  const banner = s.rateLimited || Boolean(s.failingSource);
  // A cut-short note shares the banner's 2-row reservation: the rate-limit /
  // failing-source banner wins when both could show, so the note only appears
  // when no banner is up, and the row budget never needs a third slot.
  const partials = getPartials();
  const showPartials = !banner && partials.length > 0;
  const height = Math.max(
    1,
    listRows - 2 - (banner || showPartials ? 2 : 0) - (showCmds ? 2 : 0),
  );
  const maxOffset = Math.max(0, sortedItems.length - height);
  const start = Math.min(offset, maxOffset);
  const windowed = sortedItems.slice(start, start + height);

  // Every command acts on the whole queue (never a single track, which confused
  // people). Each key is a no-op unless it would do something. These avoid the
  // global player keys handled in App (space k, j l ← →, n p r s, + - , .).
  useInput(
    (input, key) => {
      if (input === "[") {
        if (s.downloading + s.pending > 0) queue.pauseAll();
      } else if (input === "]") {
        if (s.paused > 0) queue.resumeAll();
      } else if (input === "c") {
        if (s.downloading + s.pending + s.paused > 0) queue.cancelAll();
      } else if (key.return) {
        // A settled batch's summary is dismissed with ↵: clearing it empties
        // the queue, which lands back on the add-music view.
        if (s.downloading + s.pending + s.paused === 0) queue.clearFinished();
      } else if (input === "f") {
        if (s.failed > 0) queue.retryFailed();
      } else if (key.upArrow) {
        setOffset(Math.max(0, start - 1));
      } else if (key.downArrow) {
        setOffset(Math.min(maxOffset, start + 1));
      } else if (key.pageUp) {
        setOffset(Math.max(0, start - height));
      } else if (key.pageDown) {
        setOffset(Math.min(maxOffset, start + height));
      }
    },
    { isActive: focused },
  );

  if (s.total === 0) {
    return null;
  }

  const active = s.downloading > 0 || s.pending > 0;
  const title = active
    ? "Downloading"
    : s.paused
      ? "Paused"
      : s.failed
        ? "Done, some failed"
        : s.canceled > 0 && s.done + s.skipped === 0
          ? "Canceled"
          : "All done";
  const saved = s.done + s.skipped;

  // Only surface commands that would actually do something right now, so the
  // footer stays a short contextual hint instead of a wall of every key. Nav
  // keys (esc / ? keys) live in the global footer, so we don't repeat them here.
  const cmds: { key: string; label: string }[] = [];
  if (s.downloading + s.pending > 0) cmds.push({ key: "[", label: "Pause" });
  if (s.paused > 0) cmds.push({ key: "]", label: "Resume" });
  if (s.failed > 0) cmds.push({ key: "f", label: "Retry" });
  if (s.downloading + s.pending + s.paused > 0)
    cmds.push({ key: "c", label: "Cancel" });
  else cmds.push({ key: "↵", label: "Done" });

  return (
    <Box flexDirection="column">
      {s.rateLimited ? (
        <Box marginBottom={1}>
          <Text color={COLOR.warn} wrap="truncate-end">
            {`${ICON.warn} ${
              s.rateLimitReason === WAITING_FOR_TOOLS
                ? "Waiting for the audio engine (install ffmpeg if this persists)"
                : "Rate-limited, wait a while"
            }  ${ICON.dot}  ] resumes`}
          </Text>
        </Box>
      ) : s.failingSource ? (
        // Many "track unavailable" rows in a row from one source usually
        // means the downloader broke, not the tracks; say so once, calmly.
        <Box marginBottom={1}>
          <Text color={COLOR.warn} wrap="truncate-end">
            {`${ICON.warn} ${s.failingSource} downloads keep failing  ${ICON.dot}  the downloader may be out of date  ${ICON.dot}  restart soundcli to update it`}
          </Text>
        </Box>
      ) : null}

      {showPartials ? (
        // A source handed back fewer tracks than the playlist really holds
        // (e.g. Spotify's very long lists): say so once, calmly, never silently.
        <Box marginBottom={1}>
          <Text dimColor wrap="truncate-end">
            {partialNoticeText(partials)}
          </Text>
        </Box>
      ) : null}

      {/* One flowed line: the title must never lose letters, so the dim
          stats at the right truncate first on narrow terminals. */}
      <Box>
        <Text wrap="truncate-end">
          <Text bold color={focused ? COLOR.accent : undefined}>
            {title}
          </Text>
          <Text dimColor>
            {`  ${ICON.dot}  ${saved.toLocaleString()} of ${s.total.toLocaleString()} saved`}
          </Text>
          {s.paused ? (
            <Text color={COLOR.warn}>{`  ${ICON.dot}  ${s.paused.toLocaleString()} paused`}</Text>
          ) : null}
          {s.failed ? (
            <Text color={COLOR.bad} dimColor>
              {`  ${ICON.dot}  ${s.failed} failed`}
            </Text>
          ) : null}
          {s.canceled ? (
            <Text dimColor>{`  ${ICON.dot}  ${s.canceled} canceled`}</Text>
          ) : null}
        </Text>
      </Box>

      <Box marginTop={1} marginBottom={1}>
        <Box width={24}>
          <GradientBar pct={s.overallPercent} width={24} />
        </Box>
        <Text dimColor>
          {`  ${s.overallPercent}%${
            active
              ? s.etaSeconds !== undefined
                ? `  ${ICON.dot}  ~${formatEtaShort(s.etaSeconds)} left`
                : `  ${ICON.dot}  estimating…`
              : ""
          }`}
        </Text>
      </Box>

      <Box flexDirection="column">
        {windowed.map((item) => (
          <QueueRow key={item.id} item={item} />
        ))}
      </Box>

      {showCmds ? (
        <Box marginTop={1}>
          <Text wrap="truncate-end">
            {cmds.map((c, i) => (
              <Text key={c.key}>
                {i > 0 ? <Text dimColor>{`  ${ICON.dot}  `}</Text> : null}
                <Text color={COLOR.alt}>{c.key}</Text>
                <Text dimColor>{` ${c.label}`}</Text>
              </Text>
            ))}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

// ── Grouped playlist picker ─────────────────────────────────────────────

/**
 * Point-and-shoot picker for the "what should we grab?" step: ↵ downloads
 * whatever the cursor is on (the "everything new" row at the top grabs it
 * all, a playlist row grabs just that one). Space optionally hand-picks a few
 * first (then ↵ downloads the picked set). One flat list — no group headers —
 * rendered ourselves for two-tone rows and a scroll window for long lists.
 *
 * Shows track counts and "N saved" badges using library data so users can
 * see at a glance which sets are already fully downloaded.
 */
function isDirectLink(item: SourcePlaylist): boolean {
  return item.id === "single";
}

function playlistRowLabel(item: SourcePlaylist): string {
  if (item.title && item.title !== "URL") return cleanText(item.title);
  return linkCollectionTitle(item.url);
}

/** One link or playlist: skip the multi-picker chrome (filter, "download all"). */
function SingleListConfirm({
  item,
  focused,
  onSubmit,
}: {
  item: SourcePlaylist;
  focused: boolean;
  onSubmit: (ids: string[]) => void;
}) {
  // A pasted link has no real name until it's fetched, so show the clean link
  // itself rather than a guessed "YouTube playlist" abstraction.
  const label = isDirectLink(item)
    ? displayUrl(item.url)
    : playlistRowLabel(item);
  const detail =
    item.count !== undefined
      ? `${item.count} ${item.count === 1 ? "song" : "songs"}`
      : "";

  useInput(
    (_input, key) => {
      if (key.return) onSubmit([item.id]);
    },
    { isActive: focused },
  );

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={COLOR.accent}>{focused ? `${ICON.pointer} ` : "  "}</Text>
        <Box flexGrow={1} minWidth={0}>
          <Text
            wrap="truncate-end"
            color={focused ? COLOR.accent : undefined}
            bold={focused}
          >
            {label}
          </Text>
        </Box>
        {detail ? (
          <Box flexShrink={0} marginLeft={2}>
            <Text dimColor>{detail}</Text>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}

// Exported for tests: the height invariant (never taller than the rows the
// body has left) is what keeps Ink's redraw from corrupting on squashed
// terminals, so it's pinned by test/ui.test.tsx.
export function PlaylistPicker({
  lists,
  sourceId,
  owner,
  onSubmit,
  filtering,
  setFiltering,
  reserveRows = 0,
}: {
  lists: SourcePlaylist[];
  sourceId: SourceId;
  owner?: string;
  onSubmit: (ids: string[]) => void;
  filtering: boolean;
  setFiltering: (b: boolean) => void;
  /** Lines the parent renders around this picker (e.g. its hint legend), so
   *  the scroll window never overflows the body (see SongList). */
  reserveRows?: number;
}) {
  const { region, listRows, library } = useStore();
  const focused = region === "content";
  // Nothing starts selected: picking is the optional path, not homework.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [cursor, setCursor] = useState(0);
  const [q, setQ] = useState("");

  // Count how many songs we already own per playlist name so we can show
  // "N saved" next to each set. Uses library data only, no extra network calls.
  const ownedByPlaylist = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of library.all()) {
      if (t.source !== sourceId) continue;
      if ((t.owner ?? "") !== (owner ?? "")) continue;
      const name = t.playlist ?? "";
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return counts;
  }, [library, sourceId, owner]);

  // One flat list, no category headers: the order the source gave us already
  // reads naturally (likes first, then sets), and a header per bucket costs
  // rows and visual noise this picker doesn't need.
  const searching = q.trim().length > 0;
  const qLower = q.toLowerCase();

  const ordered: SourcePlaylist[] = [];
  for (const item of lists) {
    if (searching && !item.title.toLowerCase().includes(qLower)) continue;

    ordered.push(item);
  }

  // Cursor space: row 0 is the "everything new" action, then every list.
  const selectableCount = ordered.length + 1;

  useEffect(() => {
    if (cursor >= selectableCount) setCursor(Math.max(0, selectableCount - 1));
  }, [cursor, selectableCount]);

  // Display rows: the action row, every list, then the hidden-saved summary.
  // Item idx is its cursor position (1-based, since the action row owns 0).
  type Row = { kind: "action" } | { kind: "item"; item: SourcePlaylist; idx: number };
  const rows: Row[] = [{ kind: "action" }];
  ordered.forEach((item, i) => rows.push({ kind: "item", item, idx: i + 1 }));

  useInput(
    (input, key) => {
      if (input === "/") {
        setFiltering(true);
        return;
      }
      if (key.upArrow) setCursor((c) => wrapStep(c, -1, selectableCount));
      else if (key.downArrow) setCursor((c) => wrapStep(c, 1, selectableCount));
      else if (input === " ") {
        if (cursor === 0) {
          // Space on the action row flips between all picked and none.
          setSelected((s) =>
            s.size === ordered.length
              ? new Set()
              : new Set(ordered.map((l) => l.id)),
          );
          return;
        }
        const id = ordered[cursor - 1]?.id;
        if (id)
          setSelected((s) => {
            const n = new Set(s);
            if (n.has(id)) n.delete(id);
            else n.add(id);
            return n;
          });
      } else if (key.return) {
        if (cursor === 0) onSubmit(ordered.map((l) => l.id));
        else if (selected.size > 0) onSubmit([...selected]);
        else {
          const id = ordered[cursor - 1]?.id;
          if (id) onSubmit([id]);
        }
      }
    },
    { isActive: focused && !filtering },
  );

  useInput(
    (_input, key) => {
      if (key.escape) setFiltering(false);
    },
    { isActive: focused && filtering },
  );

  // Scroll window so long lists stay on screen, keeping the cursor centered.
  // Rows render exactly one line each (no margins), so the window height is
  // the rendered height: overflowing the body corrupts Ink's redraw (rows
  // merge and drop). listRows already covers the standard 2-row header; our
  // chrome beyond that is the status line (shed first when squashed), the
  // filter line and its margin, and whatever the parent reserved.
  const showStatus = listRows >= 6;
  const height = Math.max(
    1,
    listRows - (showStatus ? 1 : 0) - 2 - reserveRows,
  );
  const cursorRow =
    cursor === 0
      ? 0
      : rows.findIndex((r) => r.kind === "item" && r.idx === cursor);
  const start = Math.min(
    Math.max(0, cursorRow - Math.floor(height / 2)),
    Math.max(0, rows.length - height),
  );
  const visible = rows.slice(start, start + height);

  // The action row's detail: total songs when every list reports a count.
  const totalSongs = ordered.reduce((acc, l) => acc + (l.count ?? 0), 0);
  const setsLabel = `${ordered.length} ${ordered.length === 1 ? "playlist" : "playlists"}`;
  const everythingDetail =
    totalSongs > 0 && ordered.every((l) => l.count !== undefined)
      ? `${totalSongs.toLocaleString()} songs  ${ICON.dot}  ${setsLabel}`
      : setsLabel;

  const statusLine =
    selected.size > 0
      ? `${selected.size} picked  ${ICON.dot}  ↵ Download them`
      : `↵ Download highlighted  ${ICON.dot}  Space picks several`;

  return (
    <Box flexDirection="column">
      {/* Truncate, never wrap: a wrapped line adds a row the height budget
          didn't reserve, which overflows the body and corrupts the redraw. */}
      {showStatus ? (
        <Text dimColor wrap="truncate-end">
          {statusLine}
        </Text>
      ) : null}
      <Box marginBottom={1}>
        <Text dimColor>{`${ICON.pointer} `}</Text>
        {focused && filtering ? (
          <TextField
            defaultValue={q}
            placeholder="Search playlists…"
            onChange={setQ}
            onSubmit={() => setFiltering(false)}
          />
        ) : (
          <Box flexGrow={1} minWidth={0}>
            <Text dimColor wrap="truncate-end">
              {q || "Press / to search playlists"}
            </Text>
          </Box>
        )}
      </Box>
      {visible.map((r, i) => {
        if (r.kind === "action") {
          const hereAction = cursor === 0 && focused;
          return (
            <Box key="__everything__">
              <Text color={COLOR.accent}>
                {hereAction ? `${ICON.pointer} ` : "  "}
              </Text>
              <Box flexGrow={1} minWidth={0}>
                <Text
                  wrap="truncate-end"
                  color={hereAction ? COLOR.accent : undefined}
                  bold={hereAction}
                >
                  ↓ Download all
                </Text>
              </Box>
              <Box flexShrink={0} marginLeft={2}>
                <Text dimColor>{everythingDetail}</Text>
              </Box>
            </Box>
          );
        }
        const on = selected.has(r.item.id);
        const here = r.idx === cursor && focused;
        const label = cleanText(r.item.title);
        const owned = ownedByPlaylist.get(r.item.title) ?? 0;
        const total = r.item.count;
        const allSaved = total !== undefined && total > 0 && owned >= total;

        // Right-edge detail, mirroring the queue rows: song count, then how
        // much of it is already saved.
        const detail = allSaved
          ? `${ICON.done} all ${total} saved`
          : total !== undefined
            ? owned > 0
              ? `${owned} of ${total} saved`
              : `${total} ${total === 1 ? "song" : "songs"}`
            : owned > 0
              ? `${owned} saved`
              : "";

        return (
          <Box key={r.item.id}>
            <Text color={COLOR.accent}>{here ? `${ICON.pointer} ` : "  "}</Text>
            <Text color={on ? COLOR.good : undefined} dimColor={!on}>
              {on ? `${ICON.done} ` : `${ICON.dot} `}
            </Text>
            <Box flexGrow={1} minWidth={0}>
              <Text
                wrap="truncate-end"
                color={here ? COLOR.accent : undefined}
                dimColor={!here && allSaved}
                bold={here}
              >
                {label}
              </Text>
            </Box>
            <Box flexShrink={0} marginLeft={2}>
              <Text color={allSaved ? COLOR.good : undefined} dimColor>
                {detail}
              </Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

// ── Landing hub ─────────────────────────────────────────────────────────

/**
 * Download landing: pick a source to browse your playlists.
 */
function DownloadHub({
  onPickSource,
  onPaste,
}: {
  onPickSource: (id: SourceId) => void;
  onPaste: (raw: string) => void;
}) {
  const { region } = useStore();
  const focused = region === "content";
  const [cursor, setCursor] = useState(0);
  const count = SOURCES.length;
  const nameWidth = menuNameWidth();

  useInput(
    (input, key) => {
      if (!key.ctrl && !key.meta) {
        const text = input
          .replace(/\x1b?\[<\d+;\d+;\d+[Mm]/g, "")
          .replace(/[\r\n]+/g, " ")
          .trim();
        if (text.length > 1) {
          onPaste(text);
          return;
        }
      }
      if (key.upArrow) setCursor((c) => wrapStep(c, -1, count));
      else if (key.downArrow) setCursor((c) => wrapStep(c, 1, count));
      else if (key.return) {
        onPickSource(SOURCES[cursor]!.id);
      }
    },
    { isActive: focused },
  );

  return (
    <Box flexDirection="column">
      {SOURCES.map((s, i) => (
        <MenuRow
          key={s.id}
          label={s.name}
          desc={s.desc}
          here={cursor === i}
          focused={focused}
          nameWidth={nameWidth}
        />
      ))}
    </Box>
  );
}

// ── Source picker (removed — browse sources via DownloadHub) ────────────

// ── Main Download component ─────────────────────────────────────────────

export function Download() {
  const {
    config,
    setConfig,
    queue,
    region,
    setCaptureMode,
    listRows,
    pendingAdd,
    setPendingAdd,
  } = useStore();
  const focused = region === "content";
  // Subscribe to queue updates so the stats snapshot below stays fresh.
  useQueueItems(queue);
  const total = queue.stats().total;
  // Any queue at all (even a finished one) is worth landing on: a completed
  // batch shows its "all done" summary until the user clears it or moves on,
  // instead of bouncing back to the source picker mid-glance.
  const hasItems = total > 0;
  const [step, setStep] = useState<Step>(() =>
    hasItems ? { name: "queue" } : { name: "pick-source" },
  );
  const [filtering, setFiltering] = useState(false);

  // Welcome pastes and CLI links land here once; consume and clear immediately.
  useEffect(() => {
    if (!pendingAdd) return;
    const raw = pendingAdd;
    setPendingAdd(null);
    void handleIncomingLink(raw);
    // handleIncomingLink closes over the latest step helpers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAdd, setPendingAdd]);

  // Only an emptied-out queue (x clear, wipe-all) leaves nothing to show, so
  // fall back to the source picker then.
  useEffect(() => {
    if (step.name === "queue" && total === 0) {
      setStep({ name: "pick-source" });
    } else if (step.name === "adding" && total > 0) {
      setStep({ name: "queue" });
    }
  }, [step.name, total]);

  // The handle prompt is a text field (owns the whole keyboard); the
  // playlist picker only claims space + esc, so the player keys stay live on it.
  const capture: CaptureMode = !focused
    ? "none"
    : step.name === "need-handle"
      ? "text"
      : step.name === "pick-lists" && filtering
        ? "text"
        : step.name === "pick-lists"
          ? "picker"
          : "none";
  useEffect(() => {
    setCaptureMode(capture);
    return () => setCaptureMode("none");
  }, [capture, setCaptureMode]);

  useInput(
    (input, key) => {
      if (key.escape) {
        if (hasItems) setStep({ name: "queue" });
        else setStep({ name: "pick-source" });
      } else if (input === "e" && step.name === "pick-lists")
        setStep({ name: "need-handle", source: step.adapter.id });
    },
    { isActive: capture !== "none" },
  );

  function adapterFor(source: SourceId, value: string): SourceAdapter {
    if (source === "youtube") return makeYoutube(value);
    if (source === "soundcloud") return makeSoundcloud(value);
    return makeSpotify(value);
  }

  function savedValue(source: SourceId): string | undefined {
    if (source === "youtube") return config.youtubeHandle;
    if (source === "soundcloud") return config.soundcloudHandle;
    return config.spotifyHandle;
  }

  async function loadLists(adapter: SourceAdapter, handle: string): Promise<void> {
    setFiltering(false);
    const message =
      adapter.id === "spotify"
        ? "Reading your Spotify playlist…"
        : `Loading ${handle.startsWith("http") ? "link" : `@${handle}`}…`;
    setStep({ name: "loading", message, source: adapter.id });
    try {
      const lists = await adapter.listPlaylists();
      if (lists.length === 0)
        setStep({ name: "empty", label: adapter.label, source: adapter.id });
      else setStep({ name: "pick-lists", adapter, lists });
    } catch (e) {
      setStep({
        name: "error",
        message: e instanceof Error ? e.message : String(e),
        source: adapter.id,
      });
    }
  }

  async function enqueuePaste(source: SourceId, url: string): Promise<void> {
    setFiltering(false);
    setStep({ name: "loading", message: "Reading link…", source });
    clearPartials();
    try {
      const tracks = await tracksFromUrl(source, url);
      if (tracks.length === 0) {
        setStep({
          name: "error",
          message: "Couldn't read that link.",
          source,
        });
        return;
      }
      const r = queue.enqueue(
        tracks.map((t) => ({
          source,
          sourceLabel: SOURCE_LABELS[source],
          track: t,
        })),
      );
      if (r.added > 0) setStep({ name: "queue" });
      else setStep({ name: "info", message: "Nothing new to download." });
    } catch (e) {
      setStep({
        name: "error",
        message: e instanceof Error ? e.message : String(e),
        source,
      });
    }
  }

  async function handleIncomingLink(raw: string): Promise<void> {
    const s = raw.trim();
    if (!s) return;

    const d = detectInput(s);
    if (d?.ok && (d.kind === "collection" || d.kind === "profile")) {
      const adapter = adapterFor(d.source, s);
      await loadLists(adapter, s);
      return;
    }

    const paste = detectPasteLink(s);
    if (paste.ok && paste.action === "download") {
      await enqueuePaste(paste.source, paste.url);
      return;
    }
    if (d?.ok && d.kind === "track") {
      await enqueuePaste(d.source, d.value);
      return;
    }
    if (d && !d.ok) {
      setStep({ name: "error", message: d.reason, source: d.source });
      return;
    }
    if (!paste.ok && isLinkInput(s)) {
      setStep({
        name: "error",
        message: paste.reason,
        source: paste.source,
      });
      return;
    }

    setStep({
      name: "error",
      message: "Paste a full link, or pick a source and enter a handle.",
    });
  }

  function onPickSource(value: string): void {
    const source = value as SourceId;
    const saved = savedValue(source);
    if (!saved) {
      setStep({ name: "need-handle", source });
      return;
    }
    void loadLists(adapterFor(source, saved), saved);
  }

  function onHandle(source: SourceId, value: string): void {
    const v = value.trim();
    if (!v) return;

    const saved = persistableHandle(source, v);
    if (saved !== undefined) {
      if (source === "youtube") setConfig({ ...config, youtubeHandle: saved });
      else if (source === "soundcloud")
        setConfig({ ...config, soundcloudHandle: saved });
      else if (source === "spotify")
        setConfig({ ...config, spotifyHandle: saved });
    }

    const paste = detectPasteLink(v);
    if (paste.ok && paste.action === "download") {
      void enqueuePaste(paste.source, paste.url);
      return;
    }

    void loadLists(adapterFor(source, v), v);
  }

  async function onSubmitLists(
    adapter: SourceAdapter,
    lists: SourcePlaylist[],
    selectedIds: string[],
  ): Promise<void> {
    const sel = selectedIds
      .map((id) => lists.find((l) => l.id === id))
      .filter((l): l is SourcePlaylist => Boolean(l));
    if (sel.length === 0) {
      setStep({ name: "pick-source" });
      return;
    }
    setStep({
      name: "adding",
      gather: { done: 0, total: sel.length },
    });

    // Enumerate the selected lists concurrently and enqueue each one's tracks the
    // moment they're ready, so downloads start within seconds instead of waiting
    // for every list to be fetched first. The queue view takes over as soon as the
    // first songs land; the remaining lists keep streaming in behind it.
    //
    // The gather runs in the background after the UI moves on to the queue, so a
    // mid-gather Cancel must stop it: otherwise each set that finishes loading
    // would re-enqueue (and revive) the just-canceled queue. The queue hands us
    // an abort signal; cancelAll/clearAll trip it and we bail before enqueuing.
    const signal = queue.beginGather();
    clearPartials();
    let gathered = 0;
    let addedAny = false;
    let firstError: string | undefined;
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < sel.length) {
        if (signal.aborted) return;
        const pl = sel[cursor++]!;
        try {
          const tracks = await adapter.listTracks(pl);
          if (signal.aborted) return; // canceled mid-fetch: don't revive the queue
          if (tracks.length > 0) {
            const r = queue.enqueue(
              tracks.map((t) => ({
                source: adapter.id,
                sourceLabel: adapter.label,
                track: t,
              })),
            );
            if (r.added > 0) addedAny = true;
          }
        } catch (e) {
          firstError ??= e instanceof Error ? e.message : String(e);
        }
        gathered++;
        setStep((prev) =>
          prev.name === "adding"
            ? { name: "adding", gather: { done: gathered, total: sel.length } }
            : prev
        );
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(5, sel.length) }, () => worker()),
    );

    if (signal.aborted) return; // canceled: leave the queue view's state alone
    if (queue.stats().total === 0) {
      // Nothing landed in the queue: everything was a duplicate, or every list
      // failed to enumerate.
      setStep(
        firstError && !addedAny
          ? { name: "error", message: firstError, source: adapter.id }
          : { name: "info", message: "Nothing new to download." },
      );
    }
  }

  /** Options that turn a dead-end (empty/error) into something actionable. */
  function retryOptions(source?: SourceId) {
    const opts: { label: string; value: string }[] = [];
    if (source)
      opts.push({
        label: "Try a different handle",
        value: "handle",
      });
    opts.push({ label: "Pick another source", value: "source" });
    return opts;
  }

  function onRetry(value: string, source?: SourceId): void {
    if (value === "handle" && source)
      setStep({ name: "need-handle", source });
    else setStep({ name: "pick-source" });
  }

  // ── Queue step ──────────────────────────────────────────────────────

  if (step.name === "queue") {
    return <QueueView />;
  }

  // ── Source wizard steps ─────────────────────────────────────────────

  if (step.name === "loading") {
    return <Spinner label={step.message} />;
  }

  if (step.name === "adding") {
    const pct =
      step.gather.total > 0 ? (step.gather.done / step.gather.total) * 100 : 0;
    return (
      <Box flexDirection="column">
        <Spinner label="Gathering your songs…" />
        {step.gather.total > 1 ? (
          <Box marginTop={1}>
            <GradientBar pct={pct} width={24} />
            <Text dimColor>{`  ${step.gather.done} of ${step.gather.total} lists`}</Text>
          </Box>
        ) : null}
      </Box>
    );
  }


  if (step.name === "need-handle") {
    // Generic links have no handle, so "link" never reaches this step; the
    // narrowing is structural only.
    const p = PROMPTS[step.source as Exclude<SourceId, "link">];
    return (
      <Box flexDirection="column">
        <PageIntro title={p.title} hint={p.hint} focused={focused} />
        <Box>
          <Text color={COLOR.accent}>{`${ICON.pointer} `}</Text>
          <TextField
            isDisabled={!focused}
            placeholder={p.placeholder}
            onSubmit={(v) => onHandle(step.source, v)}
          />
        </Box>
        <FooterHint>{`↵ Continue  ${ICON.dot}  esc Back`}</FooterHint>
      </Box>
    );
  }

  if (step.name === "pick-lists") {
    const singleOnly = step.lists.length === 1;
    // The hint legend is the first thing to go on a squashed terminal, so
    // the sets themselves keep their rows (`?` still has every key).
    const showHints = listRows >= 9 && !singleOnly;
    const only = step.lists[0];
    const introHint = only
      ? isDirectLink(only)
        ? ""
        : only.count !== undefined
          ? `${only.count} ${only.count === 1 ? "song" : "songs"}`
          : ""
      : "";
    return (
      <Box flexDirection="column">
        {singleOnly ? (
          <PageIntro
            title="Ready to download"
            hint={introHint}
            focused={focused}
          />
        ) : (
          <Header title="What should we grab?" focused={focused} />
        )}
        {singleOnly ? (
          <SingleListConfirm
            item={step.lists[0]!}
            focused={focused}
            onSubmit={(ids) =>
              void onSubmitLists(step.adapter, step.lists, ids)
            }
          />
        ) : (
          <PlaylistPicker
            key={`${step.adapter.id}-${step.lists.length}`}
            lists={step.lists}
            sourceId={step.adapter.id}
            owner={step.adapter.owner}
            onSubmit={(ids) =>
              void onSubmitLists(step.adapter, step.lists, ids)
            }
            filtering={filtering}
            setFiltering={setFiltering}
            reserveRows={showHints ? 2 : 0}
          />
        )}
        {singleOnly ? (
          <FooterHint>{`↵ Download  ${ICON.dot}  esc Back`}</FooterHint>
        ) : showHints ? (
          <FooterHint>{`↵ Download  ${ICON.dot}  space Pick  ${ICON.dot}  / Search  ${ICON.dot}  e Change handle`}</FooterHint>
        ) : null}
      </Box>
    );
  }

  if (step.name === "empty") {
    return (
      <Box flexDirection="column">
        <StatusMessage variant="warning">
          Couldn&apos;t find anything public for {step.label}. Check the handle.
        </StatusMessage>
        <Box marginTop={1}>
          <Select
            isDisabled={!focused}
            options={retryOptions(step.source)}
            onChange={(v) => onRetry(v, step.source)}
          />
        </Box>
      </Box>
    );
  }

  if (step.name === "info") {
    return (
      <Box flexDirection="column">
        <StatusMessage variant="success">{step.message}</StatusMessage>
        <Box marginTop={1}>
          <Select
            isDisabled={!focused}
            options={retryOptions()}
            onChange={(v) => onRetry(v)}
          />
        </Box>
      </Box>
    );
  }

  if (step.name === "error") {
    return (
      <Box flexDirection="column">
        <StatusMessage variant="warning">{step.message}</StatusMessage>
        <Box marginTop={1}>
          <Select
            isDisabled={!focused}
            options={retryOptions(step.source)}
            onChange={(v) => onRetry(v, step.source)}
          />
        </Box>
      </Box>
    );
  }

  // ── Default: source picker ────────────────────────────────────────

  return (
    <Box flexDirection="column">
      <PageIntro
        title="Download"
        hint={`No login  ${ICON.dot}  everything stays local`}
        focused={focused}
      />
      <DownloadHub
        onPickSource={onPickSource}
        onPaste={(raw) => void handleIncomingLink(raw)}
      />
      <FooterHint>{`↑↓ Move  ${ICON.dot}  ↵ Choose`}</FooterHint>
    </Box>
  );
}
