import { useEffect, useMemo, useState, type ReactNode } from "react";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Box, Text, useInput } from "ink";
import { Select } from "@inkjs/ui";
import { useStore, useLibrary } from "../store";
import { TextField } from "../components/TextField";
import { Header } from "../components/Header";
import { openPath } from "../../util/open-path";
import { wrapStep } from "../move";
import { displayPath, truncate } from "../../util/format";
import { persistableHandle } from "../../sources/persist-handle";
import { COLOR, ICON } from "../theme";
import { findDuplicates } from "../../library/drift";
import { reconcileLibrary, type ReconcileResult } from "../../library/reconcile";

type Mode =
  | "menu"
  | "youtube"
  | "soundcloud"
  | "spotify"
  | "duplicate-doctor"
  | "wipe-all";

export function Settings() {
  const { config, setConfig, library, queue, region, setCaptureMode } =
    useStore();
  const focused = region === "content";
  const libVersion = useLibrary(library);
  const duplicateGroups = useMemo(
    () => findDuplicates(library.all().filter((t) => t.source !== "local")),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [library, libVersion],
  );
  const duplicateTracks = duplicateGroups.reduce(
    (sum, g) => sum + Math.max(0, g.tracks.length - 1),
    0,
  );
  const [doctorResult, setDoctorResult] = useState<ReconcileResult | null>(null);
  const [doctorRunning, setDoctorRunning] = useState(false);
  const [mode, setMode] = useState<Mode>("menu");
  const [cursor, setCursor] = useState(0);

  const entries: {
    value: Mode | "open-folder";
    name: string;
    detail: string;
    set?: boolean;
    danger?: boolean;
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
    },
    {
      value: "duplicate-doctor",
      name: "Duplicate doctor",
      detail:
        duplicateTracks > 0
          ? `${duplicateTracks} duplicate ${duplicateTracks === 1 ? "track" : "tracks"}`
          : "library looks clean",
      set: duplicateTracks === 0,
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
  // can't toggle the player mid-confirmation.
  const inSubPage = focused && mode !== "menu";
  const isTextPage =
    mode === "youtube" || mode === "soundcloud" || mode === "spotify";
  useEffect(() => {
    setCaptureMode(!inSubPage ? "none" : isTextPage ? "text" : "picker");
    return () => setCaptureMode("none");
  }, [inSubPage, isTextPage, setCaptureMode]);

  useInput(
    (_input, key) => {
      if (key.escape) setMode("menu");
    },
    { isActive: inSubPage },
  );

  function runDuplicateDoctor(): void {
    if (doctorRunning) return;
    setDoctorRunning(true);
    void reconcileLibrary(library, new Map<string, boolean>(), config.libraryDir)
      .then(setDoctorResult)
      .finally(() => setDoctorRunning(false));
  }

  useInput(
    (_input, key) => {
      if (key.return) runDuplicateDoctor();
    },
    { isActive: focused && mode === "duplicate-doctor" },
  );

  // Every settings sub-page is rendered through frame(), so the back hint lives
  // here once and stays identical across pages. esc always goes back one level.
  function frame(title: string, node: ReactNode) {
    return (
      <Box flexDirection="column">
        <Header title={title} focused={focused} />
        <Box>{node}</Box>
        <Box marginTop={1}>
          <Text>
            <Text color={COLOR.alt}>esc</Text>
            <Text dimColor> Back</Text>
          </Text>
        </Box>
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

  if (mode === "duplicate-doctor") {
    const preview = duplicateGroups.slice(0, 5);
    const fixed = doctorResult
      ? doctorResult.mergedDuplicates + doctorResult.deletedFiles + doctorResult.prunedMissing + doctorResult.relinked + doctorResult.adopted + doctorResult.healedOwners
      : 0;
    return frame(
      "Duplicate doctor",
      <Box flexDirection="column">
        <Text dimColor wrap="truncate-end">
          {duplicateTracks > 0
            ? `${duplicateGroups.length} duplicate groups, ${duplicateTracks} extra tracks found.`
            : "No duplicate downloaded tracks found."}
        </Text>
        {preview.map((g) => {
          const first = g.tracks[0]!;
          return (
            <Text key={g.signature} dimColor wrap="truncate-end">
              {`${ICON.dot} ${first.artist ? `${first.artist} - ` : ""}${first.title}  ${ICON.dot}  ${g.tracks.length} copies`}
            </Text>
          );
        })}
        {duplicateGroups.length > preview.length ? (
          <Text dimColor>{`${ICON.dot} +${duplicateGroups.length - preview.length} more groups`}</Text>
        ) : null}
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>{`${ICON.dot} ↵ runs the same safe library cleanup used at startup`}</Text>
          <Text dimColor>{`${ICON.dot} it removes duplicate index entries and redundant downloaded files`}</Text>
        </Box>
        {doctorResult ? (
          <Box marginTop={1}>
            <Text color={fixed > 0 ? COLOR.good : undefined} dimColor={fixed === 0}>
              {`Fixed: ${doctorResult.mergedDuplicates} duplicate entries, ${doctorResult.deletedFiles} files, ${doctorResult.prunedMissing} missing, ${doctorResult.relinked} relinked, ${doctorResult.adopted} adopted`}
            </Text>
          </Box>
        ) : null}
        <Box marginTop={1}>
          <Text>
            <Text color={COLOR.alt}>↵</Text>
            <Text dimColor>{doctorRunning ? " Running…" : " Run cleanup"}</Text>
          </Text>
        </Box>
      </Box>,
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
            <Box key={it.value} marginTop={it.danger ? 1 : 0}>
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
    </Box>
  );
}
