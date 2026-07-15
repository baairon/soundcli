import { useEffect, useState, type ReactNode } from "react";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Box, Text, useInput } from "ink";
import { Select, Spinner } from "@inkjs/ui";
import { useQueueItems, useStore } from "../store";
import { TextField } from "../components/TextField";
import { Header } from "../components/Header";
import { openPath } from "../../util/open-path";
import { wrapStep } from "../move";
import {
  displayPath,
  expandTilde,
  formatBytes,
  truncate,
} from "../../util/format";
import { persistableHandle } from "../../sources/persist-handle";
import {
  moveLibraryDir,
  retargetTracks,
  samePath,
  validateMoveRoots,
  type MoveProgress,
} from "../../library/move-library";
import { defaultLibraryDir } from "../../config/paths";
import { COLOR, ICON } from "../theme";

type Mode =
  | "menu"
  | "youtube"
  | "soundcloud"
  | "spotify"
  | "folder"
  | "folder-confirm"
  | "moving"
  | "wipe-all";

/** Key hints pinned under the page content (Download's FooterHint idiom). */
function HintLine({ children }: { children: string }) {
  return (
    <Box marginTop={1}>
      <Text dimColor wrap="truncate-end">
        {children}
      </Text>
    </Box>
  );
}

export function Settings() {
  const { config, setConfig, library, queue, playback, region, setCaptureMode } =
    useStore();
  const focused = region === "content";
  const [mode, setMode] = useState<Mode>("menu");
  const [cursor, setCursor] = useState(0);
  const [folderDraft, setFolderDraft] = useState("");
  const [folderError, setFolderError] = useState<string | null>(null);
  const [moveProgress, setMoveProgress] = useState<MoveProgress | null>(null);
  const [moveNote, setMoveNote] = useState<string | null>(null);
  // Keeps the confirm page's downloads-running gate live while it's open.
  useQueueItems(queue);

  const entries: {
    value: Mode | "open-folder";
    name: string;
    detail: string;
    set?: boolean;
    danger?: boolean;
    /** Blank line above: opens a new visual cluster (handles / folder / danger). */
    gap?: boolean;
  }[] = [
    {
      value: "youtube",
      name: "YouTube handle",
      detail: config.youtubeHandle ? `@${config.youtubeHandle}` : "not set",
      set: Boolean(config.youtubeHandle),
    },
    {
      value: "soundcloud",
      name: "SoundCloud handle",
      detail: config.soundcloudHandle
        ? `@${config.soundcloudHandle}`
        : "not set",
      set: Boolean(config.soundcloudHandle),
    },
    {
      value: "spotify",
      name: "Spotify handle",
      detail: config.spotifyHandle
        ? `@${config.spotifyHandle}`
        : "not set",
      set: Boolean(config.spotifyHandle),
    },
    {
      value: "open-folder",
      name: "Music folder",
      detail: displayPath(config.libraryDir),
      gap: true,
    },
    {
      value: "folder",
      name: "Move music folder",
      detail: "Change where songs live",
    },
    {
      value: "wipe-all",
      name: "Wipe all",
      detail: "Delete every download",
      danger: true,
    },
  ];

  function openSetting(v: Mode | "open-folder"): void {
    if (v === "open-folder") {
      // The folder may not exist yet (fresh install, edited path): create it
      // first so the file manager always lands somewhere real.
      void fs
        .mkdir(config.libraryDir, { recursive: true })
        .catch(() => {})
        .then(() => openPath(config.libraryDir));
      return;
    }
    if (v === "folder") setFolderError(null);
    setMode(v);
  }

  // Menu navigation (the sub-pages own the keyboard via their own handlers).
  useInput(
    (_input, key) => {
      if (key.upArrow) setCursor((c) => wrapStep(c, -1, entries.length));
      else if (key.downArrow)
        setCursor((c) => wrapStep(c, 1, entries.length));
      else if (key.return) openSetting(entries[cursor]!.value);
    },
    { isActive: focused && mode === "menu" },
  );

  // Any sub-page (not the menu) owns esc while open, so esc backs up exactly
  // one level instead of jumping to the sidebar. Text sub-pages take the whole
  // keyboard; the wipe page only claims space + esc, so a stray space
  // can't toggle the player mid-confirmation. The moving page also claims the
  // whole keyboard ("text"): quitting or firing a download mid-move would
  // race the file shuffle, so only ctrl-c gets through.
  const inSubPage = focused && mode !== "menu";
  const isTextPage =
    mode === "youtube" ||
    mode === "soundcloud" ||
    mode === "spotify" ||
    mode === "folder" ||
    mode === "moving";
  useEffect(() => {
    setCaptureMode(!inSubPage ? "none" : isTextPage ? "text" : "picker");
    return () => setCaptureMode("none");
  }, [inSubPage, isTextPage, setCaptureMode]);

  useInput(
    (_input, key) => {
      if (key.escape) setMode("menu");
    },
    { isActive: inSubPage && mode !== "moving" },
  );

  // Every settings sub-page is rendered through frame(), so the hint line
  // lives here once and matches Download's in-section footer language. esc
  // always goes back one level.
  function frame(title: string, node: ReactNode, hint = "esc Back") {
    return (
      <Box flexDirection="column">
        <Header title={title} focused={focused} />
        <Box>{node}</Box>
        <HintLine>{hint}</HintLine>
      </Box>
    );
  }

  function handleField(
    title: string,
    value: string | undefined,
    placeholder: string,
    save: (v: string | undefined) => void,
  ) {
    return frame(
      title,
      <Box flexDirection="column">
        <Box>
          <Text color={COLOR.accent}>{`${ICON.pointer} `}</Text>
          <TextField
            isDisabled={!focused}
            defaultValue={value ?? ""}
            placeholder={placeholder}
            onSubmit={(v) => {
              save(v.trim() || undefined);
              setMode("menu");
            }}
          />
        </Box>
      </Box>,
      `↵ Save  ${ICON.dot}  esc Back`,
    );
  }

  function saveHandleField(
    source: "youtube" | "soundcloud" | "spotify",
    key: "youtubeHandle" | "soundcloudHandle" | "spotifyHandle",
    title: string,
    value: string | undefined,
  ) {
    return handleField(title, value, "@username", (v) => {
      const raw = v ?? "";
      const handle = persistableHandle(source, raw);
      if (handle !== undefined || !raw.trim()) {
        setConfig({ ...config, [key]: handle });
      }
    });
  }

  function submitFolder(raw: string): void {
    // Windows Explorer's "Copy as path" wraps the path in quotes; accept it.
    let typed = raw.trim().replace(/^"(.+)"$/, "$1").trim();
    if (!typed) {
      setMode("menu");
      return;
    }
    // A bare drive letter resolves to that drive's current directory, not
    // its root; someone typing "D:" means the root.
    if (/^[A-Za-z]:$/.test(typed)) typed += path.sep;
    const current = path.resolve(config.libraryDir);
    const next = path.resolve(expandTilde(typed));
    if (samePath(current, next)) {
      setMode("menu"); // typed the current folder back: nothing to do
      return;
    }
    const invalid = validateMoveRoots(current, next);
    if (invalid) {
      setFolderError(invalid);
      return;
    }
    // Creating the folder up front proves the path is real and writable
    // before the confirm page promises a move.
    void fs
      .mkdir(next, { recursive: true })
      .then(() => {
        setFolderDraft(next);
        setFolderError(null);
        setMode("folder-confirm");
      })
      .catch(() => setFolderError("Can't create that folder"));
  }

  function runMove(): void {
    const oldRoot = path.resolve(config.libraryDir);
    const newRoot = folderDraft;
    setMoveNote(null);
    setMoveProgress(null);
    setMode("moving");
    void (async () => {
      // Stop playback first: on Windows a folder rename fails while mpv
      // holds a file inside it open.
      await playback.stop();
      // Point config at the new root BEFORE moving files: if the app dies
      // mid-move, the next scan walks the new folder and relinks everything
      // that already moved (by basename, then size), while unmoved tracks
      // keep their still-valid old paths. Config-last would instead prune
      // every moved track on a hard interrupt.
      setConfig({ ...config, libraryDir: newRoot });
      let note: string | null = null;
      try {
        let lastTick = 0;
        const result = await moveLibraryDir(oldRoot, newRoot, {
          onProgress: (p) => {
            // Big libraries tick per file; ~10 updates a second is plenty.
            const now = Date.now();
            if (now - lastTick < 100 && p.movedFiles < p.totalFiles) return;
            lastTick = now;
            setMoveProgress(p);
          },
        });
        if (result.failures.length) {
          note = `Moved ${result.movedFiles} of ${result.totalFiles} files. The rest stayed in the old folder.`;
        }
      } catch {
        note = "Move interrupted. The library heals itself on the next scan.";
      }
      try {
        const changed = await retargetTracks(library.all(), oldRoot, newRoot);
        if (changed.length) await library.upsertMany(changed);
        library.flushSync();
      } catch {
        note ??= "Move interrupted. The library heals itself on the next scan.";
      }
      setMoveNote(note);
      setMoveProgress(null);
      setMode("menu");
    })();
  }

  if (mode === "youtube") {
    return saveHandleField(
      "youtube",
      "youtubeHandle",
      "Your YouTube handle",
      config.youtubeHandle,
    );
  }

  if (mode === "soundcloud") {
    return saveHandleField(
      "soundcloud",
      "soundcloudHandle",
      "Your SoundCloud handle",
      config.soundcloudHandle,
    );
  }

  if (mode === "spotify") {
    return saveHandleField(
      "spotify",
      "spotifyHandle",
      "Your Spotify handle",
      config.spotifyHandle,
    );
  }

  if (mode === "folder") {
    return frame(
      "Move music folder",
      <Box flexDirection="column">
        <Box>
          <Text color={COLOR.accent}>{`${ICON.pointer} `}</Text>
          <TextField
            isDisabled={!focused}
            defaultValue={displayPath(config.libraryDir)}
            placeholder={displayPath(defaultLibraryDir)}
            onSubmit={submitFolder}
          />
        </Box>
        {folderError && (
          <Box marginTop={1}>
            <Text color={COLOR.bad}>{folderError}</Text>
          </Box>
        )}
      </Box>,
      `↵ Continue  ${ICON.dot}  esc Back`,
    );
  }

  if (mode === "folder-confirm") {
    const busy = queue.activeCount > 0;
    const tracks = library.all();
    const size = formatBytes(
      tracks.reduce((n, t) => n + (t.fileSize ?? 0), 0),
    );
    return frame(
      "Move your music?",
      <Box flexDirection="column">
        {busy ? (
          <Text color={COLOR.bad}>
            Downloads are running. Wait for them to finish first.
          </Text>
        ) : (
          <>
            <Box marginBottom={1} flexDirection="column">
              <Text dimColor>
                {`${ICON.dot} ${tracks.length} song${
                  tracks.length === 1 ? "" : "s"
                }${size ? ` · ${size}` : ""}`}
              </Text>
              <Text dimColor>{`${ICON.dot} From ${displayPath(
                config.libraryDir,
              )}`}</Text>
              <Text dimColor>{`${ICON.dot} To ${displayPath(folderDraft)}`}</Text>
            </Box>
            <Select
              isDisabled={!focused}
              options={[
                { label: "‹ Cancel", value: "cancel" },
                { label: "Move everything", value: "confirm" },
              ]}
              onChange={(v) => {
                // A download may have started while the page sat open.
                if (v !== "confirm" || queue.activeCount > 0) {
                  setMode("menu");
                  return;
                }
                runMove();
              }}
            />
          </>
        )}
      </Box>,
      busy
        ? "esc Back"
        : `↑↓ Move  ${ICON.dot}  ↵ Choose  ${ICON.dot}  esc Back`,
    );
  }

  if (mode === "moving") {
    // Not frame(): its "esc Back" hint would lie, there is no backing out
    // of a move already writing files.
    return (
      <Box flexDirection="column">
        <Header title="Moving music folder" focused={focused} />
        <Box>
          <Spinner
            label={
              moveProgress && moveProgress.totalFiles > 0
                ? `Moving ${moveProgress.movedFiles}/${moveProgress.totalFiles} files…`
                : "Preparing move…"
            }
          />
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Keep the app open until this finishes.</Text>
        </Box>
      </Box>
    );
  }

  if (mode === "wipe-all") {
    return frame(
      "Wipe all songs?",
      <Box flexDirection="column">
        <Box marginBottom={1} flexDirection="column">
          <Text dimColor>{`${ICON.dot} Delete every downloaded file`}</Text>
          <Text dimColor>{`${ICON.dot} Clear the library`}</Text>
          <Text dimColor>{`${ICON.dot} Empty the download queue`}</Text>
          <Text dimColor>{`${ICON.dot} Keep your handles & folder`}</Text>
        </Box>
        <Select
          isDisabled={!focused}
          options={[
            { label: "‹ Cancel", value: "cancel" },
            { label: "Yes, wipe everything", value: "confirm" },
          ]}
          onChange={(v) => {
            if (v !== "confirm") {
              setMode("menu");
              return;
            }
            void (async () => {
              // Stop downloads first so nothing is mid-write while we delete.
              queue.clearAll();
              const tracked = library.all().map((t) => t.filePath);
              await library.clear();
              // Remove the folders soundcli creates (catches completed files,
              // .part partials, orphans, and empty dirs), plus any tracked files
              // that live outside the current music folder (e.g. an old folder).
              const targets = [
                ...["YouTube", "SoundCloud", "Spotify", "Links"].map((s) =>
                  path.join(config.libraryDir, s),
                ),
                ...tracked,
              ];
              await Promise.all(
                targets.map((p) =>
                  fs.rm(p, { recursive: true, force: true }).catch(() => {}),
                ),
              );
              setMode("menu");
            })();
          }}
        />
      </Box>,
      `↑↓ Move  ${ICON.dot}  ↵ Choose  ${ICON.dot}  esc Back`,
    );
  }

  // Label column + inline detail (same rhythm as Download source rows), not
  // edge-pinned with flex — that leaves an ugly dead zone in wide terminals.
  const nameWidth = Math.max(...entries.map((e) => e.name.length));
  const DETAIL_MAX = 48;

  return (
    <Box flexDirection="column">
      <Header title="Settings" focused={focused} />
      <Box flexDirection="column">
        {entries.map((it, i) => {
          const here = i === cursor && focused;
          const active = here && focused;
          const detailColor =
            it.danger ? COLOR.bad : it.set ? COLOR.alt : undefined;
          return (
            <Box key={it.value} marginTop={it.gap || it.danger ? 1 : 0}>
              <Text color={COLOR.accent}>
                {active ? `${ICON.pointer} ` : "  "}
              </Text>
              <Text
                color={
                  it.danger ? COLOR.bad : active ? COLOR.accent : undefined
                }
                bold={active}
                dimColor={!active && !it.danger}
              >
                {it.name.padEnd(nameWidth)}
              </Text>
              <Text
                color={detailColor}
                dimColor={!it.set && !it.danger}
              >
                {`   ${truncate(it.detail, DETAIL_MAX)}`}
              </Text>
            </Box>
          );
        })}
      </Box>
      {moveNote && (
        <Box marginTop={1}>
          <Text dimColor>{moveNote}</Text>
        </Box>
      )}
      <HintLine>{`↑↓ Move  ${ICON.dot}  ↵ Choose`}</HintLine>
    </Box>
  );
}
