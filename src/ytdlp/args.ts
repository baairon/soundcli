import path from "node:path";

/** Containers a library can live in. The whole library is always one of them. */
export type AudioFormat = "m4a" | "mp3" | "opus";

/**
 * The choice offered in Settings, in the order it is shown, each with the one
 * line that explains it. Kept beside the args so a new format cannot be added
 * to the picker without the selector and the drift guard seeing it.
 *
 * Lossless is deliberately absent. None of the sources serve it, so a .flac or
 * .wav here would be a large container wrapped around lossy audio, and wav
 * additionally drops the tags every player reads.
 */
export const AUDIO_FORMATS: readonly { id: AudioFormat; detail: string }[] = [
  { id: "m4a", detail: "Full Apple Music support, never re-encoded" },
  { id: "mp3", detail: "Maximum compatibility, re-encoded" },
  { id: "opus", detail: "Smallest at the same quality, no Apple Music support" },
];

export const DEFAULT_AUDIO_FORMAT: AudioFormat = "m4a";

/**
 * yt-dlp audio extraction args for the library's format, m4a unless the user
 * chose otherwise: one folder in one format that plays where they need it
 * beats a faster download nobody can open.
 *
 * The selector does the real work and comes first, because a source that
 * already serves the target format hands it over with nothing to re-encode:
 * YouTube offers AAC next to Opus, Spotify resolves through YouTube, and
 * SoundCloud offers mp3. Asking for that stream is selection, not conversion.
 *
 * --audio-format is the guard rail behind it, not a transcoder. Where the
 * source has the format natively yt-dlp reports "already in target format"
 * and passes the file through untouched; it converts only when the source
 * serves nothing matching, which is what keeps a format the rest of the world
 * refuses from quietly landing in the library.
 *
 * Bare `-x` used to be the whole function: it took whatever yt-dlp ranked
 * best, which on YouTube is Opus, and left libraries full of files Apple
 * Music refuses.
 */
export function audioFormatArgs(
  format: AudioFormat = DEFAULT_AUDIO_FORMAT,
): string[] {
  return ["-f", `bestaudio[ext=${format}]/bestaudio`, "-x", "--audio-format", format];
}

/**
 * Output filename template:
 *   <library>/<Source>/<owner?>/<Playlist or "Singles">/<Artist> - <Title>.<ext>
 * Uses yt-dlp field alternation (artist then uploader) with sensible defaults.
 * The owner segment (the normalized handle) keeps collections from different
 * handles apart on disk.
 */
export function outputTemplate(
  libraryDir: string,
  sourceLabel: string,
  owner?: string,
  distinct = false,
): string {
  return path.join(
    lit(libraryDir),
    lit(sourceLabel),
    ...(owner ? [lit(sanitizeName(owner))] : []),
    "%(playlist_title|Singles)s",
    fileTemplate(distinct),
  );
}

/**
 * Literal text for an output template, where yt-dlp reads "%" as the start of
 * a field: a playlist called "100% Hits" would otherwise break the path.
 */
function lit(text: string): string {
  return text.replace(/%/g, "%%");
}

/**
 * yt-dlp's own file name. `distinct` adds the track id, for a track whose
 * plain name another track already holds: one track, one file.
 */
function fileTemplate(distinct: boolean): string {
  return `%(artist,uploader|Unknown Artist)s - %(track,title)s${distinct ? " [%(id)s]" : ""}.%(ext)s`;
}

/** The same id-carrying name for a file soundcli places itself (a copy). */
export function distinctName(fileName: string, id: string): string {
  const ext = path.extname(fileName);
  return `${fileName.slice(0, fileName.length - ext.length)} [${sanitizeName(id)}]${ext}`;
}

/** Remove characters that are illegal in filenames across OSes. */
export function sanitizeName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return cleaned || "track";
}

/**
 * Output template with a caller-supplied folder but yt-dlp's own filename.
 * Used by YouTube/SoundCloud so a single-track download (which has no
 * playlist_title of its own under --no-playlist) still lands in the playlist /
 * "Liked Songs" folder it came from, instead of falling back to "Singles".
 */
export function outputTemplateInFolder(
  libraryDir: string,
  sourceLabel: string,
  playlist: string,
  owner?: string,
  distinct = false,
): string {
  return path.join(
    lit(libraryDir),
    lit(sourceLabel),
    ...(owner ? [lit(sanitizeName(owner))] : []),
    lit(sanitizeName(playlist)),
    fileTemplate(distinct),
  );
}

/**
 * Output template with caller-supplied playlist + filename (used by Spotify,
 * where names come from Spotify rather than the matched YouTube video).
 */
export function outputTemplateFixed(
  libraryDir: string,
  sourceLabel: string,
  playlist: string,
  stem: string,
): string {
  return path.join(
    lit(libraryDir),
    lit(sourceLabel),
    lit(sanitizeName(playlist)),
    `${lit(sanitizeName(stem))}.%(ext)s`,
  );
}
