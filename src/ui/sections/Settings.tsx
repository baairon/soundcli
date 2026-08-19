import { useEffect, useRef, useState, type ReactNode } from "react";
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
  formatEtaShort,
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
import {
  convertLibrary,
  needsConversion,
  type ConvertProgress,
} from "../../library/convert";
import {
  AUDIO_FORMATS,
  DEFAULT_AUDIO_FORMAT,
  type AudioFormat,
} from "../../ytdlp/args";
import type { Track } from "../../library/types";
import { GradientBar } from "../components/GradientBar";
import { defaultLibraryDir } from "../../config/paths";
import { COLOR, ICON } from "../theme";

type Mode =
  | "menu"
  | "youtube"
  | "soundcloud"
  | "spotify"
  | "format"
  | "convert-format"
  | "folder"
  | "folder-confirm"
  | "moving"
  | "convert-confirm"
  | "converting"
  | "convert-done"
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
  /** The one line the menu can carry, whichever operation last left it. */
  const [menuNote, setMenuNote] = useState<string | null>(null);
  const [formatCursor, setFormatCursor] = useState(0);
  const [convertProgress, setConvertProgress] =
    useState<ConvertProgress | null>(null);
  const [convertOutcome, setConvertOutcome] = useState<{
    target: AudioFormat;
    converted: number;
    failed: number;
    total: number;
    stopped: boolean;
    missingEncoder: boolean;
    interrupted: boolean;
  } | null>(null);
  const convertAbort = useRef<AbortController | null>(null);
  const convertStart = useRef(0);
  const format = config.audioFormat ?? DEFAULT_AUDIO_FORMAT;
  // What a conversion is aiming at. It starts as the download format but the
  // Convert page picks it, so "make my library mp3" is one action from one
  // place instead of a setting you have to change first.
  const [convertTarget, setConvertTarget] = useState<AudioFormat>(format);
  /** Songs a conversion to `target` would actually touch. */
  const pending = (target: AudioFormat): Track[] =>
    library.all().filter((t) => needsConversion(t, target));
  // Keeps the confirm page's downloads-running gate live while it's open.
  useQueueItems(queue);

  const entries: {
    value: Mode | "open-folder" | "convert";
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
      value: "format",
      name: "Download format",
      detail: format,
      set: true,
      gap: true,
    },
    {
      value: "convert",
      name: "Convert library",
      detail: library.all().length
        ? "Re-encode to another format"
        : "No songs yet",
    },
    {
      value: "open-folder",
      name: "Open music folder",
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

  function openSetting(v: Mode | "open-folder" | "convert"): void {
    if (v === "open-folder") {
      // The folder may not exist yet (fresh install, edited path): create it
      // first so the file manager always lands somewhere real.
      void fs
        .mkdir(config.libraryDir, { recursive: true })
        .catch(() => {})
        .then(() => openPath(config.libraryDir));
      return;
    }
    if (v === "convert") {
      // An empty library has nothing to aim at.
      if (library.all().length === 0) return;
      setMenuNote(null);
      // Start on the first format that is not the one they already have,
      // since picking the current one is usually a no-op.
      const first = AUDIO_FORMATS.findIndex((f) => f.id !== format);
      setFormatCursor(Math.max(0, first));
      setMode("convert-format");
      return;
    }
    if (v === "format") {
      setFormatCursor(
        Math.max(0, AUDIO_FORMATS.findIndex((f) => f.id === format)),
      );
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
    mode === "moving" ||
    mode === "converting";
  useEffect(() => {
    setCaptureMode(!inSubPage ? "none" : isTextPage ? "text" : "picker");
    return () => setCaptureMode("none");
  }, [inSubPage, isTextPage, setCaptureMode]);

  useInput(
    (_input, key) => {
      if (key.escape) setMode("menu");
    },
    { isActive: inSubPage && mode !== "moving" && mode !== "converting" },
  );

  useInput(
    (_input, key) => {
      if (key.return) setMode("menu");
    },
    { isActive: focused && mode === "convert-done" },
  );

  // Stopping is safe: each song is converted atomically, so a stop leaves the
  // library consistent and a re-run picks up whatever is still in the old
  // format. Saying so beats the Moving page's "there is no backing out".
  useInput(
    (input) => {
      if (input === "c") convertAbort.current?.abort();
    },
    { isActive: focused && mode === "converting" },
  );

  // Both format pages are the same small list, with the menu's movement; only
  // what ↵ does differs.
  useInput(
    (_input, key) => {
      if (key.upArrow)
        setFormatCursor((c) => wrapStep(c, -1, AUDIO_FORMATS.length));
      else if (key.downArrow)
        setFormatCursor((c) => wrapStep(c, 1, AUDIO_FORMATS.length));
      else if (key.return) {
        const chosen = AUDIO_FORMATS[formatCursor]?.id ?? DEFAULT_AUDIO_FORMAT;
        if (mode === "format") {
          setConfig({ ...config, audioFormat: chosen });
          setMode("menu");
          return;
        }
        // Converting: say so instead of opening a confirm for no work.
        if (pending(chosen).length === 0) {
          setMenuNote(`Everything is already ${chosen}.`);
          setMode("menu");
          return;
        }
        setConvertTarget(chosen);
        setMode("convert-confirm");
      }
    },
    { isActive: focused && (mode === "format" || mode === "convert-format") },
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
    setMenuNote(null);
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
      setMenuNote(note);
      setMoveProgress(null);
      setMode("menu");
    })();
  }

  function runConvert(): void {
    const target = convertTarget;
    const songs = pending(target);
    const controller = new AbortController();
    convertAbort.current = controller;
    convertStart.current = Date.now();
    const total = songs.length;
    // Converting to a format new downloads would not use guarantees a mixed
    // library on the very next download, so the choice moves both.
    if (target !== format) setConfig({ ...config, audioFormat: target });
    setMenuNote(null);
    setConvertProgress({ converted: 0, failed: 0, total });
    setMode("converting");
    void (async () => {
      let outcome = {
        target,
        converted: 0,
        failed: 0,
        total,
        stopped: false,
        missingEncoder: false,
        interrupted: false,
      };
      try {
        // mpv holds its file open and Windows refuses to replace an open file,
        // and this rewrites the library out from under the player. Inside the
        // try on purpose: esc is off on this page, so a player that refuses to
        // stop must still end at the menu with something to read.
        await playback.stop();
        let lastTick = 0;
        const { result, changed } = await convertLibrary(songs, target, {
          signal: controller.signal,
          onProgress: (p) => {
            // Big libraries tick per song; ~10 updates a second is plenty.
            const now = Date.now();
            if (now - lastTick < 100 && p.converted + p.failed < p.total) return;
            lastTick = now;
            setConvertProgress(p);
          },
        });
        if (changed.length) await library.upsertMany(changed);
        library.flushSync();
        outcome = {
          ...outcome,
          converted: result.converted,
          failed: result.failed.length,
          stopped: result.stopped,
          missingEncoder: result.missingEncoder,
        };
      } catch {
        outcome = { ...outcome, interrupted: true };
      }
      convertAbort.current = null;
      setConvertProgress(null);
      setConvertOutcome(outcome);
      setMode("convert-done");
    })();
  }

  if (mode === "format" || mode === "convert-format") {
    const converting = mode === "convert-format";
    const nameW = Math.max(...AUDIO_FORMATS.map((f) => f.id.length));
    return frame(
      converting ? "Convert library" : "Download format",
      <Box flexDirection="column">
        {AUDIO_FORMATS.map((f, i) => {
          const active = i === formatCursor && focused;
          const current = f.id === format;
          return (
            <Box key={f.id}>
              <Text color={COLOR.accent}>
                {active ? `${ICON.pointer} ` : "  "}
              </Text>
              <Text
                color={active ? COLOR.accent : current ? COLOR.alt : undefined}
                bold={active}
                dimColor={!active && !current}
              >
                {f.id.padEnd(nameW)}
              </Text>
              <Text dimColor>
                {`   ${converting && current ? "current" : f.detail}`}
              </Text>
            </Box>
          );
        })}
        {converting ? null : (
          <Box marginTop={1}>
            <Text dimColor wrap="truncate-end">
              {"Applies to new downloads. Songs you already have keep theirs."}
            </Text>
          </Box>
        )}
      </Box>,
      `↑↓ Move  ${ICON.dot}  ↵ Choose  ${ICON.dot}  esc Back`,
    );
  }

  if (mode === "convert-confirm") {
    const busy = queue.activeCount > 0;
    const songs = pending(convertTarget);
    const size = formatBytes(songs.reduce((n, t) => n + (t.fileSize ?? 0), 0));
    return frame(
      `Convert to ${convertTarget}?`,
      <Box flexDirection="column">
        {busy ? (
          <Text color={COLOR.bad}>
            Downloads are running. Wait for them to finish first.
          </Text>
        ) : (
          <>
            <Box marginBottom={1} flexDirection="column">
              <Text dimColor>
                {`${ICON.dot} ${songs.length} song${
                  songs.length === 1 ? "" : "s"
                }${size ? ` · ${size}` : ""}`}
              </Text>
              <Text dimColor>{`${ICON.dot} Replaced where they already live`}</Text>
              <Text dimColor>{`${ICON.dot} Re-encoded, which can't be undone`}</Text>
              {convertTarget !== format ? (
                <Text dimColor>
                  {`${ICON.dot} New downloads will be ${convertTarget} too`}
                </Text>
              ) : null}
            </Box>
            <Select
              isDisabled={!focused}
              options={[
                { label: "‹ Cancel", value: "cancel" },
                { label: "Convert everything", value: "confirm" },
              ]}
              onChange={(v) => {
                // A download may have started while the page sat open.
                if (v !== "confirm" || queue.activeCount > 0) {
                  setMode("menu");
                  return;
                }
                runConvert();
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

  if (mode === "converting") {
    const converted = convertProgress?.converted ?? 0;
    const failed = convertProgress?.failed ?? 0;
    const total = convertProgress?.total ?? 0;
    // The bar measures work resolved, which includes the ones that failed;
    // the line below it counts only the songs that actually landed, so a
    // failure is never reported as a conversion.
    const done = converted + failed;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const elapsed = (Date.now() - convertStart.current) / 1000;
    const left =
      done > 0 && done < total
        ? formatEtaShort((elapsed / done) * (total - done))
        : "";
    return (
      <Box flexDirection="column">
        <Header title="Converting library" focused={focused} />
        <Box marginTop={1} marginBottom={1}>
          <Box width={24}>
            <GradientBar pct={pct} width={24} />
          </Box>
          <Text dimColor>{`  ${pct}%`}</Text>
          {left ? (
            <Text dimColor>{`  ${ICON.dot}  ~${left} left`}</Text>
          ) : (
            // The download screen's idiom for the same moment: before there is
            // an estimate, the spinner stands in for one.
            <>
              <Text dimColor>{`  ${ICON.dot}  `}</Text>
              <Spinner />
            </>
          )}
        </Box>
        <Text>
          <Text dimColor>{`${converted} of ${total} converted`}</Text>
          {failed > 0 ? (
            <Text color={COLOR.bad} dimColor>
              {`  ${ICON.dot}  ${failed} failed`}
            </Text>
          ) : null}
        </Text>
        <Box marginTop={1}>
          <Text dimColor>Keep the app open until this finishes.</Text>
        </Box>
        <HintLine>{"c Stop"}</HintLine>
      </Box>
    );
  }

  if (mode === "convert-done" && convertOutcome) {
    const o = convertOutcome;
    const resolved = o.converted + o.failed;
    // The real fraction, so a clean run fills the bar and a stopped one shows
    // how far it actually got rather than claiming the whole batch.
    const pct = o.total > 0 ? Math.round((resolved / o.total) * 100) : 100;
    // Never claim a conversion that did not happen: a run where every song
    // failed is not "Converted to mp3", however full the bar looks.
    const nothingLanded = o.converted === 0 && o.failed > 0;
    const title = o.missingEncoder || nothingLanded
      ? "Nothing converted"
      : o.interrupted
        ? "Conversion interrupted"
        : o.stopped
          ? "Stopped"
          : `Converted to ${o.target}`;
    // One plain sentence when there is something to know beyond the tally.
    const aside = o.missingEncoder
      ? `This computer's audio engine can't make ${o.target} files.`
      : o.interrupted
        ? "Songs it didn't reach are untouched."
        : nothingLanded
          ? "The songs you had are untouched."
          : o.stopped
            ? "Run it again to carry on."
            : null;
    return frame(
      title,
      // Deliberately the converting page at rest: same bar in the same place,
      // same counts line under it, so finishing reads as that screen ending
      // rather than as a different one arriving.
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Box width={24}>
            <GradientBar pct={pct} width={24} />
          </Box>
          <Text dimColor>{`  ${pct}%`}</Text>
        </Box>
        <Text>
          <Text dimColor>{`${o.converted} of ${o.total} converted`}</Text>
          {o.failed > 0 ? (
            <Text color={COLOR.bad} dimColor>
              {`  ${ICON.dot}  ${o.failed} failed`}
            </Text>
          ) : null}
        </Text>
        {aside ? (
          <Box marginTop={1}>
            <Text dimColor wrap="truncate-end">
              {aside}
            </Text>
          </Box>
        ) : null}
      </Box>,
      "↵ Done",
    );
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
      {menuNote && (
        // Indented to the label column: at the left edge it reads as chrome
        // like the title and the hint, rather than as something about a row.
        <Box marginTop={1}>
          <Text dimColor>{`  ${menuNote}`}</Text>
        </Box>
      )}
      <HintLine>{`↑↓ Move  ${ICON.dot}  ↵ Choose`}</HintLine>
    </Box>
  );
}
