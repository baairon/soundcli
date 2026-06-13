import { fetchResilient } from "../../util/net";
import { getWebPlayerToken } from "./token";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export interface SpotifyProfilePlaylist {
  uri: string;
  name: string;
  owner_uri?: string;
  followers_count?: number;
}

export interface SpotifyUserProfile {
  name: string;
  playlists: SpotifyProfilePlaylist[];
}

/**
 * List public playlists on a user's profile (tokenless via web-player token).
 * Only playlists owned by that user are returned.
 */
export async function readPublicUserProfile(
  userId: string,
  playlistLimit = 200,
): Promise<SpotifyUserProfile> {
  const { accessToken, clientId } = await getWebPlayerToken();
  const url =
    `https://spclient.wg.spotify.com/user-profile-view/v3/profile/` +
    `${encodeURIComponent(userId)}` +
    `?playlist_limit=${playlistLimit}&artist_limit=0&episode_limit=0&market=from_token`;

  const res = await fetchResilient(url, {
    headers: {
      "User-Agent": UA,
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      "Client-Id": clientId,
      "App-Platform": "WebPlayer",
      Referer: "https://open.spotify.com/",
    },
  });
  if (!res.ok) {
    throw new Error(
      res.status === 404
        ? `Couldn't find a public Spotify profile for @${userId}.`
        : `Spotify returned ${res.status} for @${userId}.`,
    );
  }

  const data = (await res.json()) as {
    name?: string;
    public_playlists?: SpotifyProfilePlaylist[];
  };
  const ownerUri = `spotify:user:${userId}`;
  const playlists = (data.public_playlists ?? []).filter(
    (p) => p.owner_uri === ownerUri,
  );
  return {
    name: data.name ?? userId,
    playlists,
  };
}
