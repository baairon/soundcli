import { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { useStore, useLibrary, usePlayback } from "../store";
import { Header } from "../components/Header";
import { SongList, type SongGroup } from "../components/SongList";
import { COLOR, ICON } from "../theme";
import { formatDuration } from "../../util/format";
import { deleteTracks } from "../../library/delete";
import { type Track } from "../../library/types";
import { promises as fs } from "node:fs";
import path from "node:path";
import { execa } from "execa";

interface Mp3File {
  path: string;
  name: string;
  size: number;
}

export function Mp3() {
  const {
    library,
    config,
    playTrack,
    region,
    setSection,
    setCaptureMode,
    queue,
    playback,
    compact,
  } = useStore();
  useLibrary(library);
  const playbackState = usePlayback(playback);
  const playingId = playbackState.track?.id;
  const focused = region === "content";

  const [mp3Files, setMp3Files] = useState<Mp3File[]>([]);
  const [currentDir, setCurrentDir] = useState<string>("");
  const [confirm, setConfirm] = useState<{ path: string; name: string } | null>(null);

  useEffect(() => {
    loadMp3Files();
    // Reload when the library dir moves, and whenever this section gains
    // focus: a conversion run from Library/Playlists writes new files while
    // the MP3 section is hidden, and the only signal we get is the focus flip.
  }, [config.libraryDir, focused]);

  const loadMp3Files = async () => {
    try {
      const mp3Dir = path.join(config.libraryDir, "mp3");

      // Check if mp3 directory exists
      try {
        await fs.access(mp3Dir);
      } catch {
        setMp3Files([]);
        setCurrentDir(mp3Dir);
        return;
      }

      // Recursively walk mp3/ so the mirrored layout
      //   mp3/<Source>/<owner?>/<playlist>/<file>.mp3
      // shows up alongside the older flat / one-level forms.
      const files: Mp3File[] = [];
      const stack: string[] = [mp3Dir];
      while (stack.length > 0) {
        const dir = stack.pop()!;
        let entries: import("node:fs").Dirent[];
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            stack.push(fullPath);
          } else if (entry.isFile() && entry.name.endsWith(".mp3")) {
            try {
              const stats = await fs.stat(fullPath);
              files.push({ path: fullPath, name: entry.name, size: stats.size });
            } catch {
              // vanished between readdir and stat: skip
            }
          }
        }
      }

      // Newest first is more useful than readdir's arbitrary order.
      files.sort((a, b) => b.path.localeCompare(a.path));

      setMp3Files(files);
      setCurrentDir(mp3Dir);
    } catch (e) {
      console.error("Failed to load MP3 files:", e);
      setMp3Files([]);
    }
  };

  useEffect(() => {
    setCaptureMode(confirm ? "esc" : "none");
    return () => setCaptureMode("none");
  }, [confirm, setCaptureMode]);

  useInput(
    (input, key) => {
      if (key.escape) setConfirm(null);
      else if (input === "y" && confirm) {
        setConfirm(null);
        void (async () => {
          try {
            await fs.unlink(confirm.path);
            await loadMp3Files();
          } catch (e) {
            console.error("Failed to delete MP3:", e);
          }
        })();
      } else if (input === "o" && !confirm) {
        handleOpenFolder();
      }
    },
    { isActive: focused },
  );

  const handleOpenFolder = () => {
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    execa(command, [currentDir]).catch((e) => console.error("Failed to open folder:", e));
  };

  const handleDelete = (path: string, name: string) => {
    setConfirm({ path, name });
  };

  const toItem = (f: Mp3File) => ({
    value: f.path,
    title: f.name.replace(/\.mp3$/, ""),
    meta: `${(f.size / 1024 / 1024).toFixed(1)} MB`,
  });

  // Group by the immediate parent folder (the playlist dir in the mirrored
  // layout). Files sitting directly under mp3/ with no folder fall into a
 // headerless lead group so the flat-convert case still renders cleanly.
  const groups: SongGroup[] = useMemo(() => {
    const byGroup = new Map<string, Mp3File[]>();
    const flat: Mp3File[] = [];
    for (const f of mp3Files) {
      const parent = path.basename(path.dirname(f.path));
      if (parent === "mp3") {
        flat.push(f);
      } else {
        const list = byGroup.get(parent);
        if (list) list.push(f);
        else byGroup.set(parent, [f]);
      }
    }
    const sortedGroups = [...byGroup.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    );
    const out: SongGroup[] = [];
    if (flat.length > 0) out.push({ items: flat.map(toItem) });
    for (const [title, files] of sortedGroups) {
      out.push({ title, items: files.map(toItem) });
    }
    return out;
  }, [mp3Files]);

  const subtitle = `${mp3Files.length} file${mp3Files.length === 1 ? "" : "s"}`;

  if (mp3Files.length === 0) {
    return (
      <Box flexDirection="column">
        <Header title="MP3" subtitle={subtitle} focused={focused} />
        <Text dimColor>No MP3 files found.</Text>
        <Text dimColor>Convert tracks from Library or Playlists to create MP3s.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Header title="MP3" subtitle={subtitle} focused={focused} />
      <Box marginBottom={compact ? 0 : 1} flexShrink={0}>
        {confirm ? (
          <Text color={COLOR.warn} wrap="truncate-end">
            {`Delete '${confirm.name}'?  y Delete  ${ICON.dot}  esc Keep`}
          </Text>
        ) : (
          <Text dimColor wrap="truncate-end">
            {currentDir}  {ICON.dot}  Click to open folder
          </Text>
        )}
      </Box>
      <SongList
        groups={groups}
        playingId={playingId}
        focused={focused && !confirm}
        reserveRows={confirm ? 1 : 0}
        onDelete={(value) => {
          const file = mp3Files.find((f) => f.path === value);
          if (file) handleDelete(file.path, file.name);
        }}
        onSelect={(value) => {
          // For now, just open the folder on select
          // TODO: Add actual playback support for MP3 files
          handleOpenFolder();
        }}
      />
    </Box>
  );
}
