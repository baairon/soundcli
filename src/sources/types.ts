import type { SourceId } from "../library/types";

export interface SourcePlaylist {
  /** Adapter-specific id (used for React keys / dedupe). */
  id: string;
  title: string;
  /** URL yt-dlp enumerates and downloads from. */
  url: string;
  kind?: "liked" | "playlist" | "album";
  /** Track count, if known up front. */
  count?: number;
  /** Category this belongs to in the picker, e.g. "Liked Songs" / "Liked Sets". */
  group?: string;
}

export interface SourceTrack {
  id: string;
  title: string;
  artist?: string;
  album?: string;
  duration?: number;
  /** URL yt-dlp downloads to get the audio. */
  downloadUrl: string;
  playlistTitle?: string;
  /**
   * Normalized lowercase handle whose collection this track came from, so
   * likes/sets from different handles never merge (folders, dedupe, library
   * grouping). Unset for Spotify, where playlists are pasted by link.
   */
  owner?: string;
}

export interface SourceAdapter {
  id: SourceId;
  /** Human label and top-level library folder name. */
  label: string;
  /** Normalized lowercase handle this adapter reads from (unset for Spotify). */
  owner?: string;
  /** List the user's playlists + liked collections. */
  listPlaylists(): Promise<SourcePlaylist[]>;
  /** List the tracks inside a playlist/collection. */
  listTracks(playlist: SourcePlaylist): Promise<SourceTrack[]>;
}
