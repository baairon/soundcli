import readline from "node:readline";
import { execa } from "execa";
import { ffmpegPath, jsRuntimeArgs, toolEnv } from "../bin/binaries";
import { resolvedYtDlpPath } from "../bin/ytdlp-fetch";
import type { Config } from "../config/config";
import {
  audioFormatArgs,
  outputTemplate,
  outputTemplateFixed,
  outputTemplateInFolder,
} from "./args";
import { parseProgress, type DownloadProgress } from "./progress";

const META_FIELDS = [
  "id",
  "title",
  "track",
  "artist",
  "album",
  "duration",
  "uploader",
  "webpage_url",
  "playlist_title",
  "ext",
  "filepath",
] as const;

export interface TrackMeta {
  id: string;
  title: string;
  track?: string;
  artist?: string;
  album?: string;
  duration?: number;
  uploader?: string;
  webpage_url?: string;
  playlist_title?: string;
  ext?: string;
  filepath: string;
}

function val(s: string | undefined): string | undefined {
  return !s || s === "NA" ? undefined : s;
}

function parseMeta(line: string): TrackMeta | undefined {
  const parts = line.split("\t");
  const map: Partial<Record<(typeof META_FIELDS)[number], string>> = {};
  META_FIELDS.forEach((f, i) => {
    map[f] = val(parts[i + 1]);
  });
  if (!map.filepath || !map.id) return undefined;
  return {
    id: map.id,
    title: map.title ?? map.track ?? "Unknown",
    track: map.track,
    artist: map.artist,
    album: map.album,
    duration: map.duration ? Number(map.duration) : undefined,
    uploader: map.uploader,
    webpage_url: map.webpage_url,
    playlist_title: map.playlist_title,
    ext: map.ext,
    filepath: map.filepath,
  };
}

// ---------------------------------------------------------------------------
// Enumeration (listing playlists / tracks without downloading)
// ---------------------------------------------------------------------------

export interface YtEntry {
  id: string;
  title: string;
  url?: string;
  uploader?: string;
  duration?: number;
}

export interface YtCollection {
  id?: string;
  title?: string;
  uploader?: string;
  entries: YtEntry[];
}

function toEntry(e: Record<string, unknown>): YtEntry {
  return {
    id: String(e.id ?? ""),
    title: String(e.title ?? e.id ?? "Untitled"),
    url: (e.url as string) ?? (e.webpage_url as string) ?? undefined,
    uploader:
      (e.uploader as string) ?? (e.uploader_id as string) ?? undefined,
    duration: typeof e.duration === "number" ? e.duration : undefined,
  };
}

export interface EnumerateOptions {
  /** Flat listing (don't resolve each entry fully), fast. Default true. */
  flat?: boolean;
}

/** List a collection (playlist / channel / likes feed) or a single item. */
export async function enumerate(
  url: string,
  opts: EnumerateOptions = {},
): Promise<YtCollection> {
  const args = ["-J", "--ignore-config", "--no-warnings", "--encoding", "utf-8", ...jsRuntimeArgs()];
  if (opts.flat ?? true) args.push("--flat-playlist");
  args.push(url);

  let stdout: string;
  try {
    ({ stdout } = await execa(resolvedYtDlpPath(), args, { env: toolEnv() }));
  } catch (e) {
    // Surface yt-dlp's own "ERROR: ..." line instead of the raw execa dump.
    const err = e as { stderr?: string };
    const match = err.stderr?.match(/ERROR:\s*(.+)/);
    if (match) throw new Error(match[1]?.trim());
    throw e;
  }
  const data = JSON.parse(stdout) as Record<string, unknown>;
  const entries = data.entries;
  if (Array.isArray(entries)) {
    return {
      id: data.id as string | undefined,
      title: data.title as string | undefined,
      uploader: (data.uploader as string) ?? (data.uploader_id as string),
      entries: entries
        .filter((e): e is Record<string, unknown> => Boolean(e))
        .map(toEntry),
    };
  }
  return {
    id: data.id as string | undefined,
    title: data.title as string | undefined,
    entries: [toEntry(data)],
  };
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

export interface DownloadParams {
  url: string;
  config: Config;
  /** Top-level folder name, e.g. "YouTube" | "SoundCloud" | "Spotify". */
  sourceLabel: string;
  /** Force the output filename stem (e.g. "Artist - Title"). For Spotify. */
  fixedStem?: string;
  /** Force the playlist folder name. For Spotify. */
  playlistName?: string;
  /** Normalized handle owning this collection (its folder segment). */
  owner?: string;
  /** Abort the download (kills the yt-dlp child process). */
  signal?: AbortSignal;
}

export interface DownloadResult {
  status: "downloaded" | "already" | "canceled" | "ratelimited";
  meta?: TrackMeta;
}

/** Whether an error looks like the platform rate-limiting / bot-gating us. */
export function isRateLimitError(text: string): boolean {
  return /HTTP Error 429|Too Many Requests|rate.?limit|sign in to confirm|not a bot|temporarily blocked/i.test(
    text,
  );
}

/** Download a single track with yt-dlp, streaming progress as it runs. */
export async function downloadTrack(
  params: DownloadParams,
  onProgress?: (p: DownloadProgress) => void,
): Promise<DownloadResult> {
  const { url, config, sourceLabel, fixedStem, playlistName, owner } = params;

  const outTpl = fixedStem
    ? outputTemplateFixed(
        config.libraryDir,
        sourceLabel,
        playlistName ?? "Singles",
        fixedStem,
      )
    : playlistName
      ? outputTemplateInFolder(config.libraryDir, sourceLabel, playlistName, owner)
      : outputTemplate(config.libraryDir, sourceLabel, owner);

  const progTpl =
    "download:SCPROG\t%(progress.status)s\t%(progress.downloaded_bytes)s\t%(progress.total_bytes)s\t%(progress.total_bytes_estimate)s\t%(progress.speed)s\t%(progress.eta)s";
  const metaTpl =
    "after_move:SCMETA\t" + META_FIELDS.map((f) => `%(${f})s`).join("\t");

  const args: string[] = [
    ...jsRuntimeArgs(),
    "--ffmpeg-location",
    ffmpegPath(),
    "--encoding",
    "utf-8",
    "--no-colors",
    "--newline",
    "--no-playlist",
    "--no-simulate",
    "--ignore-config",
    "--continue",
    // Gentle pacing so big batches are far less likely to get rate-limited.
    "--retries",
    "5",
    "--retry-sleep",
    "5",
    "--sleep-interval",
    "1",
    "--max-sleep-interval",
    "3",
    "--embed-metadata",
    "--embed-thumbnail",
    ...audioFormatArgs(),
    "-o",
    outTpl,
    "--progress-template",
    progTpl,
    "--print",
    metaTpl,
    url,
  ];

  const subprocess = execa(resolvedYtDlpPath(), args, {
    env: toolEnv(),
    buffer: false,
    reject: false,
    cancelSignal: params.signal,
  });

  let meta: TrackMeta | undefined;
  const errLines: string[] = [];
  const handle = (line: string): void => {
    if (line.startsWith("SCPROG\t")) {
      const p = parseProgress(line);
      if (p && onProgress) onProgress(p);
    } else if (line.startsWith("SCMETA\t")) {
      meta = parseMeta(line);
    } else if (line.trim()) {
      errLines.push(line);
    }
  };

  const rlOut = readline.createInterface({
    input: subprocess.stdout!,
    crlfDelay: Infinity,
  });
  const rlErr = readline.createInterface({
    input: subprocess.stderr!,
    crlfDelay: Infinity,
  });
  rlOut.on("line", handle);
  rlErr.on("line", handle);

  let result;
  try {
    result = await subprocess;
  } catch (e) {
    rlOut.close();
    rlErr.close();
    if (params.signal?.aborted) return { status: "canceled" };
    throw e;
  }
  rlOut.close();
  rlErr.close();

  if (params.signal?.aborted) {
    return { status: "canceled" };
  }
  if (result.exitCode !== 0) {
    const msg = errLines.slice(-5).join(" | ");
    if (isRateLimitError(msg)) return { status: "ratelimited" };
    throw new Error(`yt-dlp failed (exit ${result.exitCode}): ${msg}`);
  }
  if (meta) {
    onProgress?.({ status: "done", percent: 100 });
    return { status: "downloaded", meta };
  }
  return { status: "already" };
}
