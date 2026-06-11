import type { SourceAdapter, SourcePlaylist, SourceTrack } from "../types";
import {
  parseSpotifyInput,
  readPublicEntity,
  type SpotifyEntityType,
  type SpotifyPublicTrack,
} from "./public";

/** Build the yt-dlp search target that finds this song on YouTube. */
export function spotifySearchQuery(t: { artist: string; title: string }): string {
  const query = `${t.artist} ${t.title}`.replace(/\s+/g, " ").trim();
  return `ytsearch1:${query}`;
}

function toSourceTrack(t: SpotifyPublicTrack, playlistTitle: string): SourceTrack {
  return {
    id: t.id,
    title: t.title,
    artist: t.artist,
    duration: t.durationMs ? Math.round(t.durationMs / 1000) : undefined,
    downloadUrl: spotifySearchQuery({ artist: t.artist, title: t.title }),
    playlistTitle,
  };
}

const PROFILE_HINT =
  "Spotify only lets apps list a whole profile with a key. open the playlist you want in Spotify, copy its link, and paste that instead.";

/** Entity types we can read tokenlessly from the embed (have a trackList). */
const READABLE: ReadonlyArray<SpotifyEntityType> = ["playlist", "album", "track"];

function isReadable(type: SpotifyLinkType): type is SpotifyEntityType {
  return (READABLE as ReadonlyArray<string>).includes(type);
}

type SpotifyLinkType = ReturnType<typeof parseSpotifyInput>["type"];

/**
 * Spotify reads public playlists, albums, and single tracks with no login, app,
 * or cookies, via the open.spotify.com embed. Each track is matched to YouTube
 * (lazily, at download time) and downloaded. Reads go through the cached,
 * retrying reader so an entity enumerated then downloaded is fetched once.
 */
export function makeSpotify(input?: string): SourceAdapter {
  return {
    id: "spotify",
    label: "Spotify",

    async listPlaylists(): Promise<SourcePlaylist[]> {
      if (!input) throw new Error("paste your Spotify playlist link first.");
      const ref = parseSpotifyInput(input);
      if (isReadable(ref.type)) {
        const id = (ref as { id: string }).id;
        const entity = await readPublicEntity(ref.type, id);
        const kind = ref.type === "album" ? "album" : "playlist";
        return [
          {
            id: `spotify-${ref.type}-${id}`,
            title: entity.name,
            url: `spotify:${ref.type}:${id}`,
            kind,
            count: entity.tracks.length,
          },
        ];
      }
      if (ref.type === "user") throw new Error(PROFILE_HINT);
      throw new Error("that doesn't look like a Spotify playlist link.");
    },

    async listTracks(playlist: SourcePlaylist): Promise<SourceTrack[]> {
      // url is "spotify:<type>:<id>"; default to playlist for older entries.
      const parts = playlist.url.split(":");
      const type = (parts.length === 3 ? parts[1] : "playlist") as string;
      const id = parts[parts.length - 1] ?? "";
      const entityType: SpotifyEntityType = isReadable(type as SpotifyLinkType)
        ? (type as SpotifyEntityType)
        : "playlist";
      const entity = await readPublicEntity(entityType, id);
      return entity.tracks.map((t) => toSourceTrack(t, entity.name));
    },
  };
}
