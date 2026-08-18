import path from "node:path";

/**
 * yt-dlp audio extraction args. Every download lands as .m4a, with no setting
 * to get that wrong: one folder that plays in the app, in Apple Music, and on
 * a phone beats a faster download nobody can open.
 *
 * Nothing is ever re-encoded. The selector does all the real work, because
 * every source we pull from already serves AAC alongside its default: YouTube
 * offers it next to Opus, Spotify resolves through YouTube, and SoundCloud
 * offers it next to mp3. Asking for that stream is selection, not conversion.
 *
 * --audio-format is the guard rail behind it, not a transcoder. On all three
 * sources yt-dlp reports "already in target format" and passes the file
 * through untouched; it would only convert for some future source that serves
 * no AAC at all, and it is there so such a source cannot quietly put Opus
 * back in the library.
 *
 * Bare `-x` used to be the whole function: it took whatever yt-dlp ranked
 * best, which on YouTube is Opus, and left libraries full of files Apple
 * Music refuses.
 */
export function audioFormatArgs(): string[] {
  return ["-f", "bestaudio[ext=m4a]/bestaudio", "-x", "--audio-format", "m4a"];
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
