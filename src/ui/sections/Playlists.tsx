import { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { Select } from "@inkjs/ui";
import { useStore, useQueueItems, useLibrary, usePlayback } from "../store";
import { Header } from "../components/Header";
import { SourceTabs, type SourceFilter } from "../components/SourceTabs";
import { TextField } from "../components/TextField";
import { SongList, type SongGroup } from "../components/SongList";
import { COLOR, ICON } from "../theme";
import { cleanText, formatDuration, formatRuntime } from "../../util/format";
import { deleteTracks } from "../../library/delete";
import { SOURCE_LABELS, type SourceId, type Track } from "../../library/types";
import { shuffledOrder } from "../../player/order";
import { promises as fs } from "node:fs";
import path from "node:path";

const SOURCE_ORDER: SourceId[] = ["youtube", "soundcloud", "spotify", "link"];

interface SetInfo {
  key: string;
  source: SourceId;
  owner?: string;
  name: string;
  tracks: Track[];
}

type View = { kind: "sets" } | { kind: "songs"; setKey: string };

/** Pending delete: one song, or a whole set with everything in it. */
type Confirm =
  | { kind: "song"; id: string; label: string }
  | { kind: "set"; key: string; label: string; count: number };

/**
 * Browse the library by set (playlist / likes collection) instead of as one
 * big song list: a two-level drill-down. The sets level groups by source;
 * opening a set shows its songs with a set-scoped shuffle, and playing a song
 * scopes next/prev to that set.
 */
export function Playlists() {
  const {
    library,
    config,
    playTrack,
    region,
    setSection,
    setCaptureMode,
    setPlaylistsDepth,
    queue,
    playback,
    compact,
  } = useStore();
  useQueueItems(queue);
  const libVersion = useLibrary(library);
  const playingId = usePlayback(playback).track?.id;
  const focused = region === "content";
  const [view, setView] = useState<View>({ kind: "sets" });
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [q, setQ] = useState("");
  const [filtering, setFiltering] = useState(false);
  const [filter, setFilter] = useState<SourceFilter>("all");
  const [renamingSetKey, setRenamingSetKey] = useState<string | null>(null);
  const [newPlaylistName, setNewPlaylistName] = useState("");
  const [renamingTrackId, setRenamingTrackId] = useState<string | null>(null);
  const [newTrackTitle, setNewTrackTitle] = useState("");
  const [selectedSetKey, setSelectedSetKey] = useState<string | null>(null);
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);

  const songs = useMemo(
    // library.all() is already newest-first; recompute on new downloads and
    // on drift cleanup (prune/merge).
    () => library.all(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [library, queue.doneCount, libVersion],
  );

  // Bucket tracks into sets, preserving first-appearance (newest-first) order.
  const sets = useMemo(() => {
    const byKey = new Map<string, SetInfo>();
    const ordered: SetInfo[] = [];
    for (const t of songs) {
      const key = `${t.source}|${t.owner ?? ""}|${t.playlist ?? "Other"}`;
      let s = byKey.get(key);
      if (!s) {
        s = {
          key,
          source: t.source,
          owner: t.owner,
          name: t.playlist ?? "Other",
          tracks: [],
        };
        byKey.set(key, s);
        ordered.push(s);
      }
      s.tracks.push(t);
    }
    return ordered;
  }, [songs]);

  const searching = q.trim().length > 0;
  const qLower = q.toLowerCase();
  const filteredSets = useMemo(() => {
    if (!searching) return sets;
    return sets.filter(
      (s) =>
        s.name.toLowerCase().includes(qLower) ||
        (s.owner && s.owner.toLowerCase().includes(qLower)),
    );
  }, [sets, searching, qLower]);

  const presentSources = useMemo(() => {
    const set = new Set(sets.map((s) => s.source));
    return SOURCE_ORDER.filter((s) => set.has(s));
  }, [sets]);
  const tabs = useMemo<SourceFilter[]>(
    () => ["all", ...presentSources],
    [presentSources],
  );

  const countBySource = useMemo(() => {
    const m = new Map<SourceId, number>();
    for (const s of sets) m.set(s.source, (m.get(s.source) ?? 0) + 1);
    return m;
  }, [sets]);
  const tabCount = (tb: SourceFilter): number =>
    tb === "all" ? sets.length : countBySource.get(tb) ?? 0;

  useEffect(() => {
    if (filter !== "all" && !presentSources.includes(filter)) setFilter("all");
  }, [filter, presentSources]);

  const visibleSets = useMemo(() => {
    const base = searching ? filteredSets : sets;
    return filter === "all" ? base : base.filter((s) => s.source === filter);
  }, [sets, filteredSets, searching, filter]);

  const setLabel = (s: SetInfo): string => s.name;

  const active =
    view.kind === "songs" ? sets.find((s) => s.key === view.setKey) : undefined;

  // If the open set disappears (wipe, prune), fall back to the sets list.
  useEffect(() => {
    if (view.kind === "songs" && !active) setView({ kind: "sets" });
  }, [view, active]);

  useEffect(() => {
    setPlaylistsDepth(view.kind === "songs" ? "songs" : "sets");
    return () => setPlaylistsDepth("sets");
  }, [view.kind, setPlaylistsDepth]);

  const inSongs = focused && view.kind === "songs";
  const inSets = focused && view.kind === "sets";
  const confirming = focused && confirm !== null;
  const filteringSets = inSets && filtering;
  const renamingSet = inSets && renamingSetKey !== null;
  const renamingTrack = inSongs && renamingTrackId !== null;
  useEffect(() => {
    // The sets list claims no special mode: like Library, a plain esc falls
    // through to the global handler and returns focus to the sidebar. Only the
    // filter box (text) and the songs drill-down / delete confirm (esc, each
    // with its own handler) capture keys. ("picker" would swallow esc here.)
    setCaptureMode(
      confirming
        ? "esc"
        : filteringSets
          ? "text"
          : renamingSet
            ? "text"
            : renamingTrack
              ? "text"
              : inSongs
                ? "esc"
                : "none",
    );
    return () => setCaptureMode("none");
  }, [confirming, filteringSets, inSongs, renamingSet, renamingTrack, setCaptureMode]);

  function stepSourceTab(dir: -1 | 1): void {
    const i = tabs.indexOf(filter);
    setFilter(tabs[(i + dir + tabs.length) % tabs.length]!);
  }

  useInput(
    (_input, key) => {
      if (key.escape) setView({ kind: "sets" });
    },
    { isActive: inSongs && !confirm && !renamingTrack },
  );

  useInput(
    (input) => {
      if (input === "t" && !confirm && selectedTrackId) {
        const track = library.get(selectedTrackId);
        if (track) {
          setRenamingTrackId(track.id);
          setNewTrackTitle(track.title);
        }
        return;
      }
    },
    { isActive: inSongs && !confirm && !renamingTrack },
  );

  useInput(
    (_input, key) => {
      if (key.escape) {
        setRenamingTrackId(null);
        setNewTrackTitle("");
      }
    },
    { isActive: renamingTrack },
  );

  const handleTrackRenameSubmit = async () => {
    if (!renamingTrackId || !newTrackTitle.trim()) return;
    const track = library.get(renamingTrackId);
    if (!track) return;
    const newTitle = newTrackTitle.trim();
    if (track.title === newTitle) {
      setRenamingTrackId(null);
      setNewTrackTitle("");
      return;
    }

    // Move the file on disk to match the new title
    const oldPath = track.filePath;
    const oldDir = path.dirname(oldPath);
    const oldExt = path.extname(oldPath);
    const newPath = path.join(oldDir, `${cleanText(newTitle)}${oldExt}`);

    try {
      await fs.rename(oldPath, newPath);
      await library.upsert({ ...track, title: newTitle, filePath: newPath });
    } catch (e) {
      console.error("Failed to rename file:", e);
      // Still update metadata even if file move failed
      await library.upsert({ ...track, title: newTitle });
    }

    setRenamingTrackId(null);
    setNewTrackTitle("");
  };

  useInput(
    (input) => {
      if (inSets && input === "/") {
        setFiltering(true);
        return;
      }
      if (input === "t" && !filtering && !confirm && selectedSetKey) {
        const selectedSet = sets.find((s) => s.key === selectedSetKey);
        if (selectedSet) {
          setRenamingSetKey(selectedSet.key);
          setNewPlaylistName(selectedSet.name);
        }
        return;
      }
      if (input === "[") stepSourceTab(-1);
      else if (input === "]") stepSourceTab(1);
    },
    { isActive: focused && !confirm && !filtering && !renamingSet && inSets },
  );

  useInput(
    (_input, key) => {
      if (key.escape) setFiltering(false);
    },
    { isActive: inSets && filtering },
  );

  useInput(
    (_input, key) => {
      if (key.escape) {
        setRenamingSetKey(null);
        setNewPlaylistName("");
      }
    },
    { isActive: inSets && renamingSet },
  );

  const handleRenameSubmit = async () => {
    if (!renamingSetKey || !newPlaylistName.trim()) return;
    const targetSet = sets.find((s) => s.key === renamingSetKey);
    if (!targetSet) return;
    const oldName = targetSet.name;
    const newName = newPlaylistName.trim();
    if (oldName === newName) {
      setRenamingSetKey(null);
      setNewPlaylistName("");
      return;
    }

    // Move the folder on disk for each track
    const tracksToUpdate = [];
    for (const track of targetSet.tracks) {
      const oldPath = track.filePath;
      const oldDir = path.dirname(oldPath);
      const oldBaseName = path.basename(oldPath, path.extname(oldPath));
      const oldExt = path.extname(oldPath);
      
      // The folder structure is: libraryDir/source/owner/playlist/filename
      // We need to rename the playlist folder
      const pathParts = oldDir.split(path.sep);
      const playlistIndex = pathParts.findIndex((p) => p === cleanText(oldName));
      
      if (playlistIndex >= 0) {
        pathParts[playlistIndex] = cleanText(newName);
        const newDir = pathParts.join(path.sep);
        const newPath = path.join(newDir, `${oldBaseName}${oldExt}`);
        
        try {
          // Create new directory if it doesn't exist
          await fs.mkdir(newDir, { recursive: true });
          await fs.rename(oldPath, newPath);
          tracksToUpdate.push({ ...track, playlist: newName, filePath: newPath });
        } catch (e) {
          console.error(`Failed to move file for ${track.title}:`, e);
          // Still update metadata even if file move failed
          tracksToUpdate.push({ ...track, playlist: newName });
        }
      } else {
        // Fallback: just update metadata
        tracksToUpdate.push({ ...track, playlist: newName });
      }
    }

    await library.upsertMany(tracksToUpdate);
    setRenamingSetKey(null);
    setNewPlaylistName("");
  };

  // y commits the pending delete (one song, or a whole set and its folder),
  // esc keeps it. Playback stops first when the playing song is a victim:
  // the player holds the file handle open and Windows refuses the unlink.
  useInput(
    (input, key) => {
      if (key.escape) setConfirm(null);
      else if (input === "y" && confirm) {
        const victims =
          confirm.kind === "set"
            ? (sets.find((s) => s.key === confirm.key)?.tracks ?? [])
            : [library.get(confirm.id)].filter((t): t is Track => Boolean(t));
        setConfirm(null);
        if (victims.length === 0) return;
        void (async () => {
          if (victims.some((t) => t.id === playingId)) await playback.stop();
          await deleteTracks(library, victims, config.libraryDir);
        })();
      }
    },
    { isActive: confirming },
  );

  function confirmText(): string {
    if (!confirm) return "";
    return confirm.kind === "set"
      ? `Delete '${cleanText(confirm.label)}'  ${ICON.dot}  ${confirm.count} song${
          confirm.count === 1 ? "" : "s"
        }?  y Delete  ${ICON.dot}  esc Keep`
      : `Delete '${cleanText(confirm.label)}'?  y Delete  ${ICON.dot}  esc Keep`;
  }

  if (sets.length === 0) {
    return (
      <Box flexDirection="column">
        <Header title="Playlists" focused={focused} />
        <Text dimColor>No playlists yet.</Text>
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

  if (view.kind === "songs" && active) {
    const n = active.tracks.length;
    const totalSec = active.tracks.reduce(
      (sum, t) => sum + (t.durationSec ?? 0),
      0,
    );
    const subtitle = [
      `${n} song${n === 1 ? "" : "s"}`,
      formatRuntime(totalSec),
      SOURCE_LABELS[active.source],
    ]
      .filter(Boolean)
      .join(`  ${ICON.dot}  `);
    return (
      <Box flexDirection="column">
        <Header title={setLabel(active)} subtitle={subtitle} focused={focused} />
        {confirm ? (
          <Box marginBottom={compact ? 0 : 1} flexShrink={0}>
            <Text color={COLOR.warn} wrap="truncate-end">
              {confirmText()}
            </Text>
          </Box>
        ) : renamingTrack ? (
          <Box marginBottom={compact ? 0 : 1} flexShrink={0}>
            <TextField
              defaultValue={newTrackTitle}
              placeholder="New title…"
              onChange={setNewTrackTitle}
              onSubmit={handleTrackRenameSubmit}
            />
          </Box>
        ) : null}
        <SongList
          key={active.key}
          groups={[
            {
              items: active.tracks.map((t) => ({
                value: t.id,
                title: t.title,
                artist: t.artist,
                meta: formatDuration(t.durationSec),
              })),
            },
          ]}
          action={
            n > 1
              ? {
                  value: "__shuffle__",
                  label: `${ICON.shuffle} Shuffle`,
                }
              : undefined
          }
          numbered
          actionGap={n > 1}
          playingId={playingId}
          focused={focused && !confirm && !renamingTrack}
          reserveRows={confirm || renamingTrack ? 1 : 0}
          onDelete={(value) => {
            const t = library.get(value);
            if (t) setConfirm({ kind: "song", id: t.id, label: t.title });
          }}
          onSelect={(value) => {
            if (value === "__shuffle__") {
              const list = shuffledOrder(n, -1).map((i) => active.tracks[i]!);
              if (list.length > 0) playTrack(list[0]!, list);
              return;
            }
            const t = library.get(value);
            if (t) playTrack(t, active.tracks);
          }}
          getSelectedValue={setSelectedTrackId}
        />
      </Box>
    );
  }

  const toSetItem = (s: SetInfo) => ({
    value: s.key,
    title: setLabel(s),
    meta: `${s.tracks.length} song${s.tracks.length === 1 ? "" : "s"}`,
  });

  let groups: SongGroup[];
  if (searching || filter !== "all" || presentSources.length <= 1) {
    groups = [{ items: visibleSets.map(toSetItem) }];
  } else {
    groups = presentSources
      .map((src) => {
        const inSrc = visibleSets.filter((s) => s.source === src);
        return {
          title: `${SOURCE_LABELS[src]}  ${ICON.dot}  ${inSrc.length}`,
          items: inSrc.map(toSetItem),
        };
      })
      .filter((g) => g.items.length > 0);
  }

  const subtitle = `${visibleSets.length} playlist${visibleSets.length === 1 ? "" : "s"}`;
  // The filter/hint row carries content only while typing, confirming a
  // delete, or showing an active query; when compact and idle, drop it.
  const showSearchRow = !compact || filtering || confirm !== null || searching;
  // Rows above the list beyond the header: tabs (1) + the filter row when shown
  // (2 normally, 1 compact since its margin goes too).
  const reserveRows = 1 + (showSearchRow ? (compact ? 1 : 2) : 0);

  return (
    <Box flexDirection="column">
      <Header title="Playlists" subtitle={subtitle} focused={focused} />
      <SourceTabs tabs={tabs} active={filter} count={tabCount} />
      {showSearchRow ? (
        <Box marginBottom={compact ? 0 : 1} flexShrink={0}>
          {confirm ? (
            <Text color={COLOR.warn} wrap="truncate-end">
              {confirmText()}
            </Text>
          ) : renamingSet ? (
            <>
              <Text dimColor>{`${ICON.pointer} `}</Text>
              <TextField
                defaultValue={newPlaylistName}
                placeholder="New playlist name…"
                onChange={setNewPlaylistName}
                onSubmit={handleRenameSubmit}
              />
            </>
          ) : (
            <>
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
                    {q || "Press / to search your playlists"}
                  </Text>
                </Box>
              )}
            </>
          )}
        </Box>
      ) : null}
      {visibleSets.length === 0 ? (
        <Text dimColor>No matches.</Text>
      ) : (
        <SongList
          key="sets"
          groups={groups}
          focused={focused && !confirm && !filtering}
          reserveRows={reserveRows}
          onDelete={(value) => {
            const s = sets.find((x) => x.key === value);
            if (s)
              setConfirm({
                kind: "set",
                key: s.key,
                label: setLabel(s),
                count: s.tracks.length,
              });
          }}
          onSelect={(value) => setView({ kind: "songs", setKey: value })}
          getSelectedValue={setSelectedSetKey}
        />
      )}
    </Box>
  );
}
