import path from "node:path";

/** yt-dlp audio extraction args: always extract best-available, no re-encode. */
export function audioFormatArgs(): string[] {
  return ["-x"];
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
): string {
  return path.join(
    libraryDir,
    sourceLabel,
    ...(owner ? [sanitizeName(owner)] : []),
    "%(playlist_title|Singles)s",
    "%(artist,uploader|Unknown Artist)s - %(track,title)s.%(ext)s",
  );
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
): string {
  return path.join(
    libraryDir,
    sourceLabel,
    ...(owner ? [sanitizeName(owner)] : []),
    sanitizeName(playlist),
    "%(artist,uploader|Unknown Artist)s - %(track,title)s.%(ext)s",
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
    libraryDir,
    sourceLabel,
    sanitizeName(playlist),
    `${sanitizeName(stem)}.%(ext)s`,
  );
}
