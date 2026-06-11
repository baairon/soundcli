import { useEffect, useState, type ReactNode } from "react";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Box, Text, useInput } from "ink";
import { Select } from "@inkjs/ui";
import { useStore } from "../store";
import { TextField } from "../components/TextField";
import { Header } from "../components/Header";
import { openPath } from "../../util/open-path";
import { wrapStep } from "../move";
import { displayPath, truncate } from "../../util/format";
import { COLOR, ICON } from "../theme";

type Mode =
  | "menu"
  | "youtube"
  | "soundcloud"
  | "spotify"
  | "wipe-all";

export function Settings() {
  const { config, setConfig, library, queue, region, setCaptureMode, cols } =
    useStore();
  const focused = region === "content";
  const [mode, setMode] = useState<Mode>("menu");
  const [cursor, setCursor] = useState(0);

  // The settings list, rendered ourselves for a clean two-tone (name + current
  // value) layout, with the destructive "Wipe all" set apart at the bottom.
  // `set` marks a configured value (shown in warm sand) vs an unset placeholder.
  const entries: {
    value: Mode | "open-folder";
    name: string;
    detail: string;
    set?: boolean;
    action?: boolean;
    danger?: boolean;
  }[] = [
    {
      value: "youtube",
      name: "YouTube",
      detail: config.youtubeHandle ?? "not set",
      set: Boolean(config.youtubeHandle),
    },
    {
      value: "soundcloud",
      name: "SoundCloud",
      detail: config.soundcloudHandle ?? "not set",
      set: Boolean(config.soundcloudHandle),
    },
    {
      value: "spotify",
      name: "Spotify",
      detail: config.spotifyProfile ?? "not set",
      set: Boolean(config.spotifyProfile),
    },
    {
      value: "open-folder",
      name: "Music folder",
      detail: displayPath(config.libraryDir),
      action: true,
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
    mode === "youtube" ||
    mode === "soundcloud" ||
    mode === "spotify";
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

  if (mode === "youtube") {
    return handleField("Your YouTube handle", config.youtubeHandle, "NASA", (v) =>
      setConfig({ ...config, youtubeHandle: v }),
    );
  }

  if (mode === "soundcloud") {
    return handleField(
      "Your SoundCloud handle",
      config.soundcloudHandle,
      "lumen",
      (v) => setConfig({ ...config, soundcloudHandle: v }),
    );
  }

  if (mode === "spotify") {
    return handleField(
      "Your Spotify playlist link",
      config.spotifyProfile,
      "https://open.spotify.com/playlist/...",
      (v) => setConfig({ ...config, spotifyProfile: v }),
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

  const nameWidth = Math.max(...entries.map((e) => e.name.length));

  return (
    <Box flexDirection="column">
      <Header title="Settings" focused={focused} />
      <Box flexDirection="column">
        {entries.map((it, i) => {
          const here = i === cursor && focused;
          return (
            <Box key={it.value} marginTop={it.danger ? 1 : 0}>
              <Text color={COLOR.accent}>{here ? `${ICON.pointer} ` : "  "}</Text>
              <Text
                color={it.danger ? COLOR.bad : here ? COLOR.accent : undefined}
                bold={here}
                dimColor={!here && !it.danger}
              >
                {it.name.padEnd(nameWidth)}
              </Text>
              <Text
                color={
                  it.danger
                    ? COLOR.bad
                    : it.action
                      ? COLOR.alt
                      : it.set
                        ? COLOR.alt
                        : undefined
                }
                dimColor={!here && !it.danger && !it.action && !it.set}
              >
                {`   ${truncate(it.detail, Math.max(16, cols - 24))}`}
              </Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
