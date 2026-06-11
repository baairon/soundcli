import { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { Select } from "@inkjs/ui";
import { useStore, useQueueItems, useLibrary, usePlayback } from "../store";
import { Header } from "../components/Header";
import { SongList, type SongGroup } from "../components/SongList";
import { COLOR, ICON } from "../theme";
import { cleanText, formatDuration } from "../../util/format";
import { deleteTracks } from "../../library/delete";
import { SOURCE_LABELS, type SourceId, type Track } from "../../library/types";
import { shuffledOrder } from "../../player/order";

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
    queue,
    playback,
  } = useStore();
  useQueueItems(queue);
  const libVersion = useLibrary(library);
  const playingId = usePlayback(playback).track?.id;
  const focused = region === "content";
  const [view, setView] = useState<View>({ kind: "sets" });
  const [confirm, setConfirm] = useState<Confirm | null>(null);

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

  // Sources where more than one handle contributes sets: prefix the owner so
  // identically named collections (e.g. two "Liked Songs") stay tellable.
  const multiOwnerSources = useMemo(() => {
    const owners = new Map<SourceId, Set<string>>();
    for (const s of sets) {
      if (!s.owner) continue;
      let o = owners.get(s.source);
      if (!o) owners.set(s.source, (o = new Set()));
      o.add(s.owner);
    }
    return new Set(
      [...owners].filter(([, o]) => o.size > 1).map(([src]) => src),
    );
  }, [sets]);

  const setLabel = (s: SetInfo): string =>
    multiOwnerSources.has(s.source) && s.owner
      ? `${s.owner} ${ICON.dot} ${s.name}`
      : s.name;

  const active =
    view.kind === "songs" ? sets.find((s) => s.key === view.setKey) : undefined;

  // If the open set disappears (wipe, prune), fall back to the sets list.
  useEffect(() => {
    if (view.kind === "songs" && !active) setView({ kind: "sets" });
  }, [view, active]);

  // Inside a set, own esc so it backs out one level (player keys stay live).
  // A pending delete confirm owns esc too, taking priority over backing out.
  const inSongs = focused && view.kind === "songs";
  const confirming = focused && confirm !== null;
  useEffect(() => {
    setCaptureMode(inSongs || confirming ? "esc" : "none");
    return () => setCaptureMode("none");
  }, [inSongs, confirming, setCaptureMode]);

  useInput(
    (_input, key) => {
      if (key.escape) setView({ kind: "sets" });
    },
    { isActive: inSongs && !confirm },
  );

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

  const confirmLine = confirm ? (
    <Text color={COLOR.warn} wrap="truncate-end">
      {confirm.kind === "set"
        ? `Delete '${cleanText(confirm.label)}'  ${ICON.dot}  ${confirm.count} song${
            confirm.count === 1 ? "" : "s"
          }?  y Delete  ${ICON.dot}  esc Keep`
        : `Delete '${cleanText(confirm.label)}'?  y Delete  ${ICON.dot}  esc Keep`}
    </Text>
  ) : null;

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
    return (
      <Box flexDirection="column">
        <Header
          title={setLabel(active)}
          subtitle={`${n} song${n === 1 ? "" : "s"}`}
          focused={focused}
        />
        {confirmLine}
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
                  label: `${ICON.shuffle} Shuffle ${active.name} (${n})`,
                }
              : undefined
          }
          playingId={playingId}
          focused={focused && !confirm}
          reserveRows={confirm ? 1 : 0}
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
        />
      </Box>
    );
  }

  const presentSources = SOURCE_ORDER.filter((src) =>
    sets.some((s) => s.source === src),
  );
  const groups: SongGroup[] =
    presentSources.length > 1
      ? presentSources.map((src) => {
          const inSrc = sets.filter((s) => s.source === src);
          return {
            title: `${SOURCE_LABELS[src]}  ${ICON.dot}  ${inSrc.length}`,
            items: inSrc.map((s) => ({
              value: s.key,
              title: setLabel(s),
              meta: `${s.tracks.length} song${s.tracks.length === 1 ? "" : "s"}`,
            })),
          };
        })
      : [
          {
            items: sets.map((s) => ({
              value: s.key,
              title: setLabel(s),
              meta: `${s.tracks.length} song${s.tracks.length === 1 ? "" : "s"}`,
            })),
          },
        ];

  return (
    <Box flexDirection="column">
      <Header
        title="Playlists"
        subtitle={`${sets.length} set${sets.length === 1 ? "" : "s"}`}
        focused={focused}
      />
      {confirmLine}
      <SongList
        key="sets"
        groups={groups}
        focused={focused && !confirm}
        reserveRows={confirm ? 1 : 0}
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
      />
    </Box>
  );
}
