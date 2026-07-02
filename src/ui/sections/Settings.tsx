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
import { persistableHandle } from "../../sources/persist-handle";
import { COLOR, ICON } from "../theme";

type Mode =
  | "menu"
  | "youtube"
  | "soundcloud"
  | "spotify"
  | "rate-limits"
  | "batch-youtube"
  | "batch-soundcloud"
  | "batch-spotify"
  | "wipe-all";

export function Settings() {
  const { config, setConfig, library, queue, region, setCaptureMode } =
    useStore();
  const focused = region === "content";
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
      value: "rate-limits",
      name: "Rate limits",
      detail: "Per-source download limits",
    },
    {
      value: "batch-youtube",
      name: "YouTube batch",
      detail: config.batchLimits?.youtube?.toString() ?? "20 (default)",
    },
    {
      value: "batch-soundcloud",
      name: "SoundCloud batch",
      detail: config.batchLimits?.soundcloud?.toString() ?? "20 (default)",
    },
    {
      value: "batch-spotify",
      name: "Spotify batch",
      detail: config.batchLimits?.spotify?.toString() ?? "20 (default)",
    },
    {
      value: "open-folder",
      name: "Music folder",
      detail: displayPath(config.libraryDir),
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
    mode === "youtube" || mode === "soundcloud" || mode === "spotify" ||
    mode === "batch-youtube" || mode === "batch-soundcloud" || mode === "batch-spotify";
  const isPickerPage = mode === "rate-limits";
  useEffect(() => {
    setCaptureMode(!inSubPage ? "none" : isTextPage ? "text" : "picker");
    return () => setCaptureMode("none");
  }, [inSubPage, isTextPage, isPickerPage, setCaptureMode]);

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

  if (mode === "rate-limits") {
    return frame(
      "Rate limits",
      <Box flexDirection="column">
        <Box marginBottom={1} flexDirection="column">
          <Text dimColor>{`${ICON.dot} Downloads are paginated per source to avoid rate limits`}</Text>
          <Text dimColor>{`${ICON.dot} After the batch limit, downloads pause automatically`}</Text>
          <Text dimColor>{`${ICON.dot} Resume after the cooldown or press 'r' in Progress`}</Text>
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text bold color={COLOR.accent}>YouTube</Text>
          <Text dimColor>  Platform limit: ~100 requests/hour (unauthenticated)</Text>
          <Text dimColor>  Batch limit: 20 tracks</Text>
          <Text dimColor>  Cooldown: 30 minutes</Text>
          <Text dimColor>  Estimated: ~40 tracks/hour</Text>
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text bold color={COLOR.accent}>SoundCloud</Text>
          <Text dimColor>  Platform limit: ~200-300 requests/hour</Text>
          <Text dimColor>  Batch limit: 20 tracks</Text>
          <Text dimColor>  Cooldown: 15 minutes</Text>
          <Text dimColor>  Estimated: ~80 tracks/hour</Text>
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text bold color={COLOR.accent}>Spotify</Text>
          <Text dimColor>  Platform limit: ~100-200 requests/minute (Web API)</Text>
          <Text dimColor>  Batch limit: 20 tracks</Text>
          <Text dimColor>  Cooldown: 20 minutes</Text>
          <Text dimColor>  Estimated: ~60 tracks/hour</Text>
        </Box>
      </Box>,
    );
  }

  if (mode === "batch-youtube") {
    return frame(
      "YouTube batch limit",
      <Box flexDirection="column">
        <Box marginBottom={1} flexDirection="column">
          <Text dimColor>{`${ICON.dot} Maximum 80% of platform rate limit for safety`}</Text>
          <Text dimColor>{`${ICON.dot} Platform limit: ~100 requests/hour`}</Text>
          <Text dimColor>{`${ICON.dot} Maximum allowed: 80 tracks`}</Text>
          <Text dimColor>{`${ICON.dot} Leave empty to use default (20)`}</Text>
        </Box>
        <Box marginTop={1}>
          <TextField
            isDisabled={!focused}
            defaultValue={config.batchLimits?.youtube?.toString() ?? ""}
            placeholder="20"
            onSubmit={(v) => {
              const num = v.trim() ? parseInt(v, 10) : undefined;
              if (num !== undefined && (isNaN(num) || num < 1 || num > 80)) {
                return; // Invalid, don't save
              }
              setConfig({
                ...config,
                batchLimits: { ...config.batchLimits, youtube: num },
              });
              setMode("menu");
            }}
          />
        </Box>
      </Box>,
    );
  }

  if (mode === "batch-soundcloud") {
    return frame(
      "SoundCloud batch limit",
      <Box flexDirection="column">
        <Box marginBottom={1} flexDirection="column">
          <Text dimColor>{`${ICON.dot} Maximum 80% of platform rate limit for safety`}</Text>
          <Text dimColor>{`${ICON.dot} Platform limit: ~200-300 requests/hour`}</Text>
          <Text dimColor>{`${ICON.dot} Maximum allowed: 160 tracks`}</Text>
          <Text dimColor>{`${ICON.dot} Leave empty to use default (20)`}</Text>
        </Box>
        <Box marginTop={1}>
          <TextField
            isDisabled={!focused}
            defaultValue={config.batchLimits?.soundcloud?.toString() ?? ""}
            placeholder="20"
            onSubmit={(v) => {
              const num = v.trim() ? parseInt(v, 10) : undefined;
              if (num !== undefined && (isNaN(num) || num < 1 || num > 160)) {
                return;
              }
              setConfig({
                ...config,
                batchLimits: { ...config.batchLimits, soundcloud: num },
              });
              setMode("menu");
            }}
          />
        </Box>
      </Box>,
    );
  }

  if (mode === "batch-spotify") {
    return frame(
      "Spotify batch limit",
      <Box flexDirection="column">
        <Box marginBottom={1} flexDirection="column">
          <Text dimColor>{`${ICON.dot} Maximum 80% of platform rate limit for safety`}</Text>
          <Text dimColor>{`${ICON.dot} Platform limit: ~100-200 requests/minute`}</Text>
          <Text dimColor>{`${ICON.dot} Maximum allowed: 4800 tracks`}</Text>
          <Text dimColor>{`${ICON.dot} Leave empty to use default (20)`}</Text>
        </Box>
        <Box marginTop={1}>
          <TextField
            isDisabled={!focused}
            defaultValue={config.batchLimits?.spotify?.toString() ?? ""}
            placeholder="20"
            onSubmit={(v) => {
              const num = v.trim() ? parseInt(v, 10) : undefined;
              if (num !== undefined && (isNaN(num) || num < 1 || num > 4800)) {
                return;
              }
              setConfig({
                ...config,
                batchLimits: { ...config.batchLimits, spotify: num },
              });
              setMode("menu");
            }}
          />
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
