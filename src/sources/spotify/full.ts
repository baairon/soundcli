// Read a public Spotify playlist in full, past the 100-track embed cap, with no
// login. It uses the anonymous web-player token the app already mints: the embed
// supplies the name plus the first up-to-100 tracks with metadata, spclient's
// playlist/v2 supplies every track uri plus the true length, and metadata/4
// fills in the names of the overflow. Any failure on the spclient path degrades
// gracefully to the embed (up to 100 tracks), so a Spotify-side change can never
// break downloading. All endpoints here are tokenless (no app keys, no cookies).

import { fetchResilient } from "../../util/net";
import { recordPartial } from "../partials";
import { gidFromId } from "./gid";
import {
  readPublicEntity,
  type SpotifyPublicPlaylist,
  type SpotifyPublicTrack,
} from "./public";
import { getWebPlayerToken } from "./token";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** How many overflow tracks to resolve at once (gentle on the endpoint). */
const META_CONCURRENCY = 10;

/** The embed returns at most this many tracks; fewer means the whole list. */
const EMBED_CAP = 100;

function spHeaders(
  accessToken: string,
  clientId: string,
): Record<string, string> {
  return {
    "User-Agent": UA,
    Accept: "application/json",
    Authorization: `Bearer ${accessToken}`,
    "Client-Id": clientId,
    "App-Platform": "WebPlayer",
    Referer: "https://open.spotify.com/",
  };
}

interface UriList {
  uris: string[];
  total: number;
}

/** Every track uri in playlist order, plus the playlist's true length. */
async function fetchAllUris(
  id: string,
  headers: Record<string, string>,
): Promise<UriList> {
  const res = await fetchResilient(
    `https://spclient.wg.spotify.com/playlist/v2/playlist/${id}`,
    { headers },
  );
  if (!res.ok) throw new Error(`playlist/v2 returned ${res.status}`);
  const data = (await res.json()) as {
    length?: number;
    contents?: { items?: Array<{ uri?: unknown }> };
  };
  const items = data.contents?.items ?? [];
  const uris = items
    .map((it) => (typeof it.uri === "string" ? it.uri : ""))
    .filter((u) => u.startsWith("spotify:track:"));
  const total = typeof data.length === "number" ? data.length : uris.length;
  return { uris, total };
}

/** Resolve one track's name/artist/duration via metadata/4 (null on failure). */
async function fetchTrackMeta(
  uri: string,
  headers: Record<string, string>,
): Promise<SpotifyPublicTrack | null> {
  const id = uri.split(":").pop() ?? "";
  let gid: string;
  try {
    gid = gidFromId(id);
  } catch {
    return null;
  }
  try {
    const res = await fetchResilient(
      `https://spclient.wg.spotify.com/metadata/4/track/${gid}?market=from_token`,
      { headers },
    );
    if (!res.ok) return null;
    const t = (await res.json()) as {
      name?: unknown;
      artist?: Array<{ name?: unknown }>;
      duration?: unknown;
    };
    const title = typeof t.name === "string" ? t.name : "";
    if (!title) return null;
    const artist =
      Array.isArray(t.artist) && typeof t.artist[0]?.name === "string"
        ? t.artist[0]!.name
        : "";
    return {
      id,
      title,
      artist,
      durationMs: typeof t.duration === "number" ? t.duration : undefined,
    };
  } catch {
    return null;
  }
}

/** Map over items with bounded concurrency, preserving input order. */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return out;
}

/**
 * Read a public playlist's full track list with no login. Falls back to the
 * embed reader (up to 100 tracks) on any spclient failure, and records a
 * cut-short notice when it knows the true total but couldn't fetch every track.
 *
 * @param id - The Spotify playlist id.
 * @returns The playlist name and every track we could resolve, in order.
 */
export async function readFullPlaylist(
  id: string,
): Promise<SpotifyPublicPlaylist> {
  const embed = await readPublicEntity("playlist", id);
  // Under the cap the embed already returned the whole playlist, so there is
  // nothing more to fetch: keep the pure-embed path (no token, no spclient).
  if (embed.tracks.length < EMBED_CAP) return embed;
  try {
    const { accessToken, clientId } = await getWebPlayerToken();
    const headers = spHeaders(accessToken, clientId);
    const { uris, total } = await fetchAllUris(id, headers);

    // Common case: a playlist within the embed's reach. Keep today's exact
    // behavior (the well-tested embed path), with no spclient metadata calls.
    if (total <= embed.tracks.length) return embed;

    // Reuse the embed's first up-to-100 (they already carry metadata); resolve
    // only the overflow uris the embed didn't cover.
    const byUri = new Map<string, SpotifyPublicTrack>();
    for (const t of embed.tracks) byUri.set(`spotify:track:${t.id}`, t);
    const overflow = uris.filter((u) => !byUri.has(u));
    const resolved = await mapPool(overflow, META_CONCURRENCY, (u) =>
      fetchTrackMeta(u, headers),
    );
    overflow.forEach((u, i) => {
      const m = resolved[i];
      if (m) byUri.set(u, m);
    });

    // Assemble in playlist order; drop any track we couldn't name (it can't be
    // matched to YouTube anyway).
    const tracks: SpotifyPublicTrack[] = [];
    for (const u of uris) {
      const t = byUri.get(u);
      if (t) tracks.push(t);
    }

    if (tracks.length < total) {
      recordPartial({
        source: "spotify",
        title: embed.name,
        got: tracks.length,
        total,
      });
    }
    return { id, name: embed.name, tracks };
  } catch {
    // spclient/token failed: degrade to the embed (up to 100). We can't know
    // whether more tracks exist, so we don't claim a total or a cut-short.
    return embed;
  }
}

/**
 * A playlist's true track count, read cheaply for the picker preview: under the
 * embed cap the embed already returned the whole list, so its count is exact;
 * at the cap we ask spclient for the real length (one request, no per-track
 * metadata). Any token/spclient failure degrades to the embed count, so it
 * never blocks and never claims more than we could see.
 *
 * @param id - The Spotify playlist id.
 * @param embedCount - How many tracks the embed returned (its capped count).
 * @returns The true total when we can read it, else the embed count.
 */
export async function readPlaylistTotal(
  id: string,
  embedCount: number,
): Promise<number> {
  if (embedCount < EMBED_CAP) return embedCount;
  try {
    const { accessToken, clientId } = await getWebPlayerToken();
    const { total } = await fetchAllUris(id, spHeaders(accessToken, clientId));
    return Math.max(total, embedCount);
  } catch {
    return embedCount;
  }
}
