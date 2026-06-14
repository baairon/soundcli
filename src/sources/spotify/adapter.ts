import type { SourceAdapter, SourcePlaylist, SourceTrack } from "../types";
import { detectInput } from "../detect";
import { normalizeSpotifyHandle } from "./handle";
import {
  parseSpotifyInput,
  readPublicEntity,
  type SpotifyEntityType,
  type SpotifyPublicTrack,
} from "./public";
import { readFullPlaylist, readPlaylistTotal } from "./full";
import { readPublicUserProfile } from "./user";

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

/** Entity types we can read tokenlessly from the embed (have a trackList). */
const READABLE: ReadonlyArray<SpotifyEntityType> = ["playlist", "album", "track"];

type SpotifyLinkType = ReturnType<typeof parseSpotifyInput>["type"];

function isReadable(type: SpotifyLinkType): type is SpotifyEntityType {
  return (READABLE as ReadonlyArray<string>).includes(type);
}

function playlistIdFromUri(uri: string): string {
  return uri.split(":").pop() ?? uri;
}

/**
 * Spotify reads public playlists, albums, and single tracks with no login, app,
 * or cookies, via the open.spotify.com embed. User handles enumerate public
 * playlists on their profile. Each track is matched to YouTube at download time.
 */
export function makeSpotify(input?: string): SourceAdapter {
  const d = input ? detectInput(input) : null;
  let user: string | undefined;
  let owner: string | undefined;
  let singleInput: string | undefined;

  if (d?.ok && d.source === "spotify") {
    if (d.kind === "profile") {
      user = d.value;
      owner = d.value.toLowerCase();
    } else {
      singleInput = d.value;
    }
  } else if (input) {
    const ref = parseSpotifyInput(input);
    if (ref.type === "user") {
      user = ref.id;
      owner = ref.id.toLowerCase();
    } else if (isReadable(ref.type)) {
      singleInput = input;
    } else {
      user = normalizeSpotifyHandle(input);
      owner = user.toLowerCase();
    }
  }

  return {
    id: "spotify",
    label: "Spotify",
    owner,

    async listPlaylists(): Promise<SourcePlaylist[]> {
      if (user) {
        const profile = await readPublicUserProfile(user);
        if (profile.playlists.length === 0) {
          throw new Error(
            `No public playlists found for @${user}. Check the username.`,
          );
        }
        return profile.playlists.map((p) => ({
          id: playlistIdFromUri(p.uri),
          title: p.name,
          url: p.uri,
          kind: "playlist" as const,
        }));
      }

      if (!singleInput) {
        throw new Error("enter your Spotify username or paste a playlist link.");
      }
      const ref = parseSpotifyInput(singleInput);
      if (!isReadable(ref.type)) {
        throw new Error("that doesn't look like a Spotify playlist link.");
      }
      const id = (ref as { id: string }).id;
      const entity = await readPublicEntity(ref.type, id);
      const kind = ref.type === "album" ? "album" : "playlist";
      // Playlists can exceed the embed's 100-track cap, so the picker's count
      // must be the true total (a cheap spclient length read), not the capped
      // embed count. Albums and single tracks stay on the exact embed count.
      const count =
        ref.type === "playlist"
          ? await readPlaylistTotal(id, entity.tracks.length)
          : entity.tracks.length;
      return [
        {
          id: `spotify-${ref.type}-${id}`,
          title: entity.name,
          url: `spotify:${ref.type}:${id}`,
          kind,
          count,
        },
      ];
    },

    async listTracks(playlist: SourcePlaylist): Promise<SourceTrack[]> {
      const parts = playlist.url.split(":");
      const type = (parts.length === 3 ? parts[1] : "playlist") as string;
      const id = parts[parts.length - 1] ?? "";
      const entityType: SpotifyEntityType = isReadable(type as SpotifyLinkType)
        ? (type as SpotifyEntityType)
        : "playlist";
      // Playlists can exceed the embed's 100-track cap, so read them in full
      // (spclient, with a graceful fallback to the embed). Albums and single
      // tracks stay on the embed reader (rarely over 100).
      const entity =
        entityType === "playlist"
          ? await readFullPlaylist(id)
          : await readPublicEntity(entityType, id);
      return entity.tracks.map((t) => toSourceTrack(t, entity.name));
    },
  };
}
