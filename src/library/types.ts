export type SourceId = "youtube" | "soundcloud" | "spotify" | "link";

/** Human label and top-level library folder name per source. */
export const SOURCE_LABELS: Record<SourceId, string> = {
  youtube: "YouTube",
  soundcloud: "SoundCloud",
  spotify: "Spotify",
  link: "Links",
};

/**
 * The canonical library id for a track: owner-qualified when the track came
 * from someone's collection so the same song from two handles stays two
 * entries. Every writer (queue upsert, restore dedupe, migration) must build
 * ids through this so they agree.
 */
export function libId(
  source: SourceId,
  trackId: string,
  owner?: string,
): string {
  return owner ? `${source}:${owner}:${trackId}` : `${source}:${trackId}`;
}

export interface Track {
  /** Stable id, e.g. "youtube:dQw4w9WgXcQ". */
  id: string;
  source: SourceId;
  sourceTrackId: string;
  title: string;
  artist?: string;
  album?: string;
  durationSec?: number;
  /** Absolute path to the downloaded audio file. */
  filePath: string;
  /** Byte size of the audio file, recorded so a renamed file can be re-linked. */
  fileSize?: number;
  webpageUrl?: string;
  /** Playlist this track was downloaded under, if any. */
  playlist?: string;
  /**
   * Normalized lowercase handle whose collection this came from (unset for
   * Spotify and for pre-owner downloads awaiting migration).
   */
  owner?: string;
  /** ISO timestamp of when it entered the library. */
  addedAt: string;
  /** For Spotify-sourced tracks: the original Spotify id we matched from. */
  spotifyId?: string;
}

export interface LibraryIndex {
  version: 1;
  tracks: Record<string, Track>;
}
