import { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { Select } from "@inkjs/ui";
import { useStore, useQueueItems, useLibrary, usePlayback } from "../store";
import { Header } from "../components/Header";
import { SourceTabs, type SourceFilter } from "../components/SourceTabs";
import { TextField } from "../components/TextField";
import { SongList, type SongGroup } from "../components/SongList";
import { COLOR, ICON } from "../theme";
import { cleanText, formatDuration } from "../../util/format";
import { deleteTracks } from "../../library/delete";
import { displaySource } from "../../library/drift";
import { renameTrack } from "../../library/rename";
import { SOURCE_LABELS, type SourceId, type Track } from "../../library/types";

const SOURCE_ORDER: SourceId[] = [
  "youtube",
  "soundcloud",
  "spotify",
  "link",
  "local",
];

/** Fisher-Yates shuffle (returns a new array). */
function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * Every downloaded song in one place: a flat newest-first list with source
 * tabs and text search. Browsing by set lives in the Playlists section.
 */
export function Library() {
  const {
    library,
    config,
    playTrack,
    region,
    setSection,
    setCaptureMode,
    queue,
    playback,
    pendingSearch,
    setPendingSearch,
    compact,
  } = useStore();
  useQueueItems(queue);
  const libVersion = useLibrary(library);
  const playingId = usePlayback(playback).track?.id;
  const focused = region === "content";

  // Text search + a source tab filter.
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState(false);
  const [filter, setFilter] = useState<SourceFilter>("all");
  const searching = q.trim().length > 0;
  // Pending one-song delete, shown as a y/esc confirm in the search row.
  const [confirm, setConfirm] = useState<{ id: string; title: string } | null>(
    null,
  );
  // Pending track rename.
  const [renamingTrackId, setRenamingTrackId] = useState<string | null>(null);
  const [newTrackTitle, setNewTrackTitle] = useState("");

  const songs = useMemo(
    // library.all() is already newest-first (addedAt desc); recompute on new
    // downloads and on drift cleanup (prune/merge).
    () => library.all(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [library, queue.doneCount, libVersion],
  );

  // Tabs group by where each file sits on disk, not where it was downloaded
  // from, so re-sorting music between the top-level folders re-tabs it.
  const srcOf = useMemo(() => {
    const m = new Map<string, SourceId>();
    for (const t of songs) m.set(t.id, displaySource(t, config.libraryDir));
    return (t: Track): SourceId => m.get(t.id) ?? t.source;
  }, [songs, config.libraryDir]);

  // Sources that actually have songs, in canonical order, for the filter tabs.
  const presentSources = useMemo(() => {
    const set = new Set(songs.map(srcOf));
    return SOURCE_ORDER.filter((s) => set.has(s));
  }, [songs, srcOf]);
  const tabs = useMemo<SourceFilter[]>(
    () => ["all", ...presentSources],
    [presentSources],
  );

  // Per-source totals shown beside each tab, so the bar reads as a real
  // segmented control. Counts reflect the whole library, not the search.
  const countBySource = useMemo(() => {
    const m = new Map<SourceId, number>();
    for (const t of songs) {
      const s = srcOf(t);
      m.set(s, (m.get(s) ?? 0) + 1);
    }
    return m;
  }, [songs, srcOf]);
  const tabCount = (tb: SourceFilter): number =>
    tb === "all" ? songs.length : countBySource.get(tb) ?? 0;

  // If the active source disappears (e.g. its last song is removed), fall back.
  useEffect(() => {
    if (filter !== "all" && !presentSources.includes(filter)) setFilter("all");
  }, [filter, presentSources]);

  // Tracks narrowed to the active source tab.
  const inSource = useMemo(
    () => (filter === "all" ? songs : songs.filter((t) => srcOf(t) === filter)),
    [filter, songs, srcOf],
  );

  // Memoized: fuzzy search over the whole library must run on query/tab/data
  // changes only, never on playback-tick or cursor re-renders.
  const visible = useMemo(
    () =>
      searching
        ? library
            .search(q)
            .filter((t) => filter === "all" || srcOf(t) === filter)
        : inSource,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [searching, q, filter, inSource, srcOf],
  );

  // Take over the keyboard only while typing in the search box; a pending
  // delete confirm owns esc so the global one doesn't bounce to the sidebar.
  const renaming = focused && renamingTrackId !== null;
  useEffect(() => {
    setCaptureMode(
      focused && editing
        ? "text"
        : focused && confirm
          ? "esc"
          : renaming
            ? "text"
            : "none",
    );
    return () => setCaptureMode("none");
  }, [focused, editing, confirm, renaming, setCaptureMode]);

  // Consume the global "/" intent: arrive with the search box already open.
  useEffect(() => {
    if (pendingSearch && focused) {
      setPendingSearch(false);
      setEditing(true);
    }
  }, [pendingSearch, focused, setPendingSearch]);

  // Browsing keys:
  //   "/" opens search
  //   "[" / "]" step the source tabs
  useInput(
    (input) => {
      if (input === "/") {
        setEditing(true);
        return;
      }
      if (input === "[" || input === "]") {
        const dir = input === "]" ? 1 : -1;
        const i = tabs.indexOf(filter);
        setFilter(tabs[(i + dir + tabs.length) % tabs.length]!);
      }
    },
    { isActive: focused && !editing && !confirm && !renaming },
  );

  // esc closes the search box (back to browsing), without leaving the section.
  useInput(
    (_input, key) => {
      if (key.escape) setEditing(false);
    },
    { isActive: focused && editing },
  );

  // esc cancels rename.
  useInput(
    (_input, key) => {
      if (key.escape) {
        setRenamingTrackId(null);
        setNewTrackTitle("");
      }
    },
    { isActive: renaming },
  );

  const handleRenameSubmit = async () => {
    const track = renamingTrackId ? library.get(renamingTrackId) : undefined;
    if (track) {
      const result = await renameTrack(library, track, newTrackTitle);
      // The new name is already taken on disk: keep the field open so it can
      // be adjusted (esc cancels) instead of silently dropping the rename.
      if (result === "collision") return;
    }
    setRenamingTrackId(null);
    setNewTrackTitle("");
  };

  // y commits the pending delete, esc keeps the song. Playback stops first
  // when it's the one playing: the player holds the file handle open and
  // Windows refuses to unlink it.
  useInput(
    (input, key) => {
      if (key.escape) setConfirm(null);
      else if (input === "y" && confirm) {
        const t = library.get(confirm.id);
        setConfirm(null);
        if (!t) return;
        void (async () => {
          if (playingId === t.id) await playback.stop();
          await deleteTracks(library, [t], config.libraryDir);
        })();
      }
    },
    { isActive: focused && confirm !== null },
  );

  if (songs.length === 0) {
    return (
      <Box flexDirection="column">
        <Header title="Library" focused={focused} />
        <Text dimColor>Nothing here yet.</Text>
        <Box marginTop={1}>
          <Select
            isDisabled={!focused}
            options={[{ label: "Download ›", value: "download" }]}
            onChange={() => setSection("download")}
          />
        </Box>
      </Box>
    );
  }

  const toItem = (t: Track) => ({
    value: t.id,
    title: t.title,
    artist: t.artist,
    meta: formatDuration(t.durationSec),
  });

  let groups: SongGroup[];
  if (searching) {
    groups = [{ items: visible.map(toItem) }];
  } else if (filter === "all" && presentSources.length > 1) {
    groups = presentSources
      .map((src) => {
        const tracks = inSource.filter((t) => srcOf(t) === src);
        return {
          title: `${SOURCE_LABELS[src]}  ${ICON.dot}  ${tracks.length}`,
          items: tracks.map(toItem),
        };
      })
      .filter((g) => g.items.length > 0);
  } else {
    groups = [{ items: visible.map(toItem) }];
  }

  const subtitle = `${visible.length.toLocaleString()} song${visible.length === 1 ? "" : "s"}`;

  // Shuffle action for the browse view only; search results play in order.
  const shuffleLabel = `${ICON.shuffle} Shuffle ${
    filter === "all" ? "all" : SOURCE_LABELS[filter]
  } (${visible.length})`;

  const action =
    !searching && visible.length > 1
      ? { value: "__shuffle__", label: shuffleLabel }
      : undefined;

  // The search/hint row carries content only while typing, confirming a
  // delete, or showing an active query; when compact and idle, drop it so the
  // list gets the row back.
  const showSearchRow =
    !compact || editing || confirm !== null || searching || renaming;
  // Rows above the list beyond the standard header (which listRows already
  // accounts for): tabs (1) + the search row when shown (2 normally, 1 compact
  // since its margin goes too).
  const reserveRows = 1 + (showSearchRow ? (compact ? 1 : 2) : 0);

  return (
    <Box flexDirection="column">
      <Header title="Library" subtitle={subtitle} focused={focused} />
      <SourceTabs tabs={tabs} active={filter} count={tabCount} />
      {/* The search row doubles as the delete confirm: same single row, so
          the list's height budget never moves. Hidden when compact + idle. */}
      {showSearchRow ? (
        <Box marginBottom={compact ? 0 : 1}>
          {confirm ? (
            <Text color={COLOR.warn} wrap="truncate-end">
              {`Delete '${cleanText(confirm.title)}'?  y Delete  ${ICON.dot}  esc Keep`}
            </Text>
          ) : renaming ? (
            <>
              <Text dimColor>{`${ICON.pointer} `}</Text>
              <TextField
                defaultValue={newTrackTitle}
                placeholder="New title…"
                onChange={setNewTrackTitle}
                onSubmit={handleRenameSubmit}
              />
            </>
          ) : (
            <>
              <Text dimColor>{`${ICON.pointer} `}</Text>
              {focused && editing ? (
                <TextField
                  defaultValue={q}
                  placeholder="Search by name…"
                  onChange={setQ}
                  onSubmit={() => setEditing(false)}
                />
              ) : (
                <Text dimColor>{q || "Press / to search…"}</Text>
              )}
            </>
          )}
        </Box>
      ) : null}
      {searching && visible.length === 0 ? (
        <Text dimColor>No matches.</Text>
      ) : (
        <SongList
          groups={groups}
          action={action}
          playingId={playingId}
          focused={focused && !editing && !confirm && !renaming}
          reserveRows={reserveRows}
          deleteTargetsPlaying
          onDelete={(value) => {
            const t = library.get(value);
            if (t) setConfirm({ id: t.id, title: t.title });
          }}
          onSelect={(value) => {
            if (value === "__shuffle__") {
              const shuffled = shuffle(visible);
              if (shuffled.length > 0) playTrack(shuffled[0]!, shuffled);
              return;
            }
            const t = library.get(value);
            if (t) playTrack(t, visible);
          }}
          onRename={(value) => {
            const t = library.get(value);
            if (t) {
              setRenamingTrackId(t.id);
              setNewTrackTitle(t.title);
            }
          }}
        />
      )}
    </Box>
  );
}
