import { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { Select } from "@inkjs/ui";
import { useStore, useHistory, useLibrary, usePlayback } from "../store";
import { Header } from "../components/Header";
import { SongList } from "../components/SongList";
import { COLOR, ICON } from "../theme";
import { cleanText, formatDuration } from "../../util/format";
import { deleteTracks } from "../../library/delete";
import type { Track } from "../../library/types";

/**
 * Recently played, newest first. Replays float a track back to the top
 * rather than stacking duplicates; entries whose track left the library are
 * silently dropped. Playing from here scopes next/prev to the history list.
 */
export function History() {
  const { library, config, history, playback, playTrack, region, setSection, setCaptureMode } =
    useStore();
  const histVersion = useHistory(history);
  const libVersion = useLibrary(library);
  const playingId = usePlayback(playback).track?.id;
  const focused = region === "content";

  // Pending one-song delete, shown as a y/esc confirm above the list.
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

  // A pending delete confirm owns esc so the global one doesn't bounce to
  // the sidebar.
  useEffect(() => {
    setCaptureMode(focused && confirm ? "esc" : "none");
    return () => setCaptureMode("none");
  }, [focused, confirm, setCaptureMode]);

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

  return (
    <Box flexDirection="column">
      <Header
        title="Recently played"
        subtitle={`${tracks.length} song${tracks.length === 1 ? "" : "s"}`}
        focused={focused}
      />
      {confirm ? (
        <Text color={COLOR.warn} wrap="truncate-end">
          {`Delete '${cleanText(confirm.title)}'?  y Delete  ${ICON.dot}  esc Keep`}
        </Text>
      ) : null}
      <SongList
        groups={[
          {
            items: tracks.map((t) => ({
              value: t.id,
              title: t.title,
              artist: t.artist,
              meta: formatDuration(t.durationSec),
            })),
          },
        ]}
        playingId={playingId}
        focused={focused && !confirm}
        reserveRows={confirm ? 1 : 0}
        deleteTargetsPlaying
        onDelete={(value) => {
          const t = library.get(value);
          if (t) setConfirm({ id: t.id, title: t.title });
        }}
        onSelect={(value) => {
          const t = library.get(value);
          if (t) playTrack(t, tracks);
        }}
      />
    </Box>
  );
}
