import { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { Select } from "@inkjs/ui";
import { useStore, useHistory, useLibrary, usePlayback } from "../store";
import { Header } from "../components/Header";
import { SourceTabs, type SourceFilter } from "../components/SourceTabs";
import { TextField } from "../components/TextField";
import { SongList } from "../components/SongList";
import { COLOR, ICON } from "../theme";
import { cleanText, formatDuration } from "../../util/format";
import { fuzzyFilter } from "../../util/fuzzy";
import { deleteTracks } from "../../library/delete";
import { displaySource } from "../../library/drift";
import { SOURCE_LABELS, type SourceId, type Track } from "../../library/types";

const SOURCE_ORDER: SourceId[] = [
  "youtube",
  "soundcloud",
  "spotify",
  "link",
  "local",
];

/**
 * Recently played, newest first. Replays float a track back to the top
 * rather than stacking duplicates; entries whose track left the library are
 * silently dropped. Playing from here scopes next/prev to the history list.
 * Source tabs + text search mirror the Library, but the list stays flat so
 * play-recency order is never reshuffled by grouping.
 */
export function History() {
  const {
    library,
    config,
    history,
    playback,
    playTrack,
    region,
    setSection,
    setCaptureMode,
    compact,
  } = useStore();
  const histVersion = useHistory(history);
  const libVersion = useLibrary(library);
  const playingId = usePlayback(playback).track?.id;
  const focused = region === "content";

  // Text search + a source tab filter, same controls as the Library.
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState(false);
  const [filter, setFilter] = useState<SourceFilter>("all");
  const searching = q.trim().length > 0;
  // Pending one-song delete, shown as a y/esc confirm in the search row.
  const [confirm, setConfirm] = useState<{ id: string; title: string } | null>(
    null,
  );

  const tracks = useMemo(
    () => {
      const out: Track[] = [];
      for (const id of history.ids()) {
        const t = library.get(id);
        if (t) out.push(t);
      }
      return out;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [history, histVersion, library, libVersion],
  );

  // Tabs group by where each file sits on disk, matching the Library.
  const srcOf = useMemo(() => {
    const m = new Map<string, SourceId>();
    for (const t of tracks) m.set(t.id, displaySource(t, config.libraryDir));
    return (t: Track): SourceId => m.get(t.id) ?? t.source;
  }, [tracks, config.libraryDir]);

  // Sources present in the history, in canonical order, for the filter tabs.
  const presentSources = useMemo(() => {
    const set = new Set(tracks.map(srcOf));
    return SOURCE_ORDER.filter((s) => set.has(s));
  }, [tracks, srcOf]);
  const tabs = useMemo<SourceFilter[]>(
    () => ["all", ...presentSources],
    [presentSources],
  );

  // Per-source totals beside each tab; counts reflect the whole history.
  const countBySource = useMemo(() => {
    const m = new Map<SourceId, number>();
    for (const t of tracks) {
      const s = srcOf(t);
      m.set(s, (m.get(s) ?? 0) + 1);
    }
    return m;
  }, [tracks, srcOf]);
  const tabCount = (tb: SourceFilter): number =>
    tb === "all" ? tracks.length : countBySource.get(tb) ?? 0;

  // If the active source disappears (its last play left the library), fall back.
  useEffect(() => {
    if (filter !== "all" && !presentSources.includes(filter)) setFilter("all");
  }, [filter, presentSources]);

  const inSource = useMemo(
    () =>
      filter === "all" ? tracks : tracks.filter((t) => srcOf(t) === filter),
    [filter, tracks, srcOf],
  );
  // Memoized: fuzzy search must run on query/tab/data changes only, never on
  // playback-tick or cursor re-renders.
  const visible = useMemo(
    () =>
      searching
        ? fuzzyFilter(q, inSource, (t) => [t.title, t.artist])
        : inSource,
    [searching, q, inSource],
  );

  // Take over the keyboard only while typing in the search box; a pending
  // delete confirm owns esc so the global one doesn't bounce to the sidebar.
  useEffect(() => {
    setCaptureMode(
      focused && editing ? "text" : focused && confirm ? "esc" : "none",
    );
    return () => setCaptureMode("none");
  }, [focused, editing, confirm, setCaptureMode]);

  // "/" opens search; "[" / "]" step the source tabs.
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
    { isActive: focused && !editing && !confirm },
  );

  // esc closes the search box (back to browsing), without leaving the section.
  useInput(
    (_input, key) => {
      if (key.escape) setEditing(false);
    },
    { isActive: focused && editing },
  );

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

  if (tracks.length === 0) {
    return (
      <Box flexDirection="column">
        <Header title="Recently played" focused={focused} />
        <Text dimColor>Nothing played yet.</Text>
        <Box marginTop={1}>
          <Select
            isDisabled={!focused}
            options={[{ label: "Library ›", value: "library" }]}
            onChange={() => setSection("library")}
          />
        </Box>
      </Box>
    );
  }

  const subtitle = `${visible.length} song${visible.length === 1 ? "" : "s"}`;
  // The search/hint row carries content only while typing, confirming a
  // delete, or showing an active query; when compact and idle, drop it.
  const showSearchRow = !compact || editing || confirm !== null || searching;
  // Rows above the list beyond the header: tabs (1) + the search row when shown
  // (2 normally, 1 compact since its margin goes too).
  const reserveRows = 1 + (showSearchRow ? (compact ? 1 : 2) : 0);

  return (
    <Box flexDirection="column">
      <Header title="Recently played" subtitle={subtitle} focused={focused} />
      <SourceTabs tabs={tabs} active={filter} count={tabCount} />
      {/* The search row doubles as the delete confirm: same single row, so
          the list's height budget never moves. Hidden when compact + idle. */}
      {showSearchRow ? (
        <Box marginBottom={compact ? 0 : 1}>
          {confirm ? (
            <Text color={COLOR.warn} wrap="truncate-end">
              {`Delete '${cleanText(confirm.title)}'?  y Delete  ${ICON.dot}  esc Keep`}
            </Text>
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
                <Text dimColor>{q || "Press / to search your history"}</Text>
              )}
            </>
          )}
        </Box>
      ) : null}
      {searching && visible.length === 0 ? (
        <Text dimColor>No matches.</Text>
      ) : (
        <SongList
          groups={[
            {
              items: visible.map((t) => ({
                value: t.id,
                title: t.title,
                artist: t.artist,
                meta: formatDuration(t.durationSec),
              })),
            },
          ]}
          playingId={playingId}
          focused={focused && !editing && !confirm}
          reserveRows={reserveRows}
          deleteTargetsPlaying
          onDelete={(value) => {
            const t = library.get(value);
            if (t) setConfirm({ id: t.id, title: t.title });
          }}
          onSelect={(value) => {
            const t = library.get(value);
            if (t) playTrack(t, visible);
          }}
        />
      )}
    </Box>
  );
}
