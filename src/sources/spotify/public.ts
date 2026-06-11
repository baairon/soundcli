// Tokenless reading of public Spotify data via the open.spotify.com embed page,
// which ships the full track list in a <script id="__NEXT_DATA__"> JSON blob.
// No login, no app, no cookies.
//
// Hardened the way spotDL hardens its Spotify reads (spotdl/utils/spotify.py):
// requests go through fetchResilient (urllib3 Retry equivalent: retry on
// 429/5xx and network errors, honor Retry-After) and GET responses are cached
// in-memory so the same entity is never fetched twice (spotipy's _get cache).

import { fetchResilient } from "../../util/net";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0 Safari/537.36";

export interface SpotifyPublicTrack {
  id: string;
  title: string;
  artist: string;
  durationMs?: number;
}

export interface SpotifyPublicPlaylist {
  id: string;
  name: string;
  tracks: SpotifyPublicTrack[];
}

/** Embeddable entity types that expose a trackList on open.spotify.com/embed. */
export type SpotifyEntityType = "playlist" | "album" | "track";

export type SpotifyLink =
  | { type: "playlist"; id: string }
  | { type: "album"; id: string }
  | { type: "track"; id: string }
  | { type: "user"; id: string }
  | { type: "unknown" };

/** Parse a Spotify URL, URI, or bare id into a typed reference. */
export function parseSpotifyInput(input: string): SpotifyLink {
  const s = input.trim();
  const m = s.match(/(playlist|album|track|user)[/:]([A-Za-z0-9._-]+)/i);
  if (m?.[1] && m[2]) {
    const type = m[1].toLowerCase() as SpotifyLink["type"];
    return { type, id: m[2] } as SpotifyLink;
  }
  if (/^[A-Za-z0-9]{22}$/.test(s)) return { type: "playlist", id: s };
  return { type: "unknown" };
}

interface Entity {
  title?: string;
  name?: string;
  trackList?: unknown[];
}

/** Recursively find the object carrying a `trackList` array. */
function findEntity(node: unknown): Entity | null {
  if (!node || typeof node !== "object") return null;
  const obj = node as Record<string, unknown>;
  if (Array.isArray(obj.trackList)) return obj as Entity;
  for (const key of Object.keys(obj)) {
    const found = findEntity(obj[key]);
    if (found) return found;
  }
  return null;
}

function extractNextData(html: string): unknown {
  const m = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/,
  );
  if (!m?.[1]) throw new Error("no __NEXT_DATA__");
  return JSON.parse(m[1]) as unknown;
}

// In-memory TTL cache keyed by `${type}:${id}`, mirroring spotipy's GET cache.
// A playlist enumerated then downloaded is fetched once, not twice.
const CACHE_TTL_MS = 5 * 60 * 1000;
interface CacheEntry {
  at: number;
  value: SpotifyPublicPlaylist;
}
const cache = new Map<string, CacheEntry>();

/** Clear the embed cache (used by tests; harmless otherwise). */
export function clearSpotifyCache(): void {
  cache.clear();
}

function cacheKey(type: SpotifyEntityType, id: string): string {
  return `${type}:${id}`;
}

/**
 * Read any public Spotify entity that exposes a trackList (playlist, album, or
 * track) from its open.spotify.com/embed page, with retry + caching. Albums and
 * single tracks reuse the exact same __NEXT_DATA__ / trackList / findEntity
 * extraction as playlists.
 *
 * @param type - "playlist" | "album" | "track".
 * @param id - The Spotify id.
 * @returns The entity's name and tracks.
 */
export async function readPublicEntity(
  type: SpotifyEntityType,
  id: string,
): Promise<SpotifyPublicPlaylist> {
  const key = cacheKey(type, id);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return hit.value;
  }

  const res = await fetchResilient(
    `https://open.spotify.com/embed/${type}/${id}`,
    { headers: { "User-Agent": UA } },
  );
  if (!res.ok) {
    throw new Error(`Spotify returned ${res.status} for this ${type}.`);
  }
  const data = extractNextData(await res.text());
  const entity = findEntity(data);
  if (!entity || !Array.isArray(entity.trackList)) {
    throw new Error(`Couldn't read this Spotify ${type} (it may be private).`);
  }
  const tracks: SpotifyPublicTrack[] = [];
  for (const raw of entity.trackList) {
    if (!raw || typeof raw !== "object") continue;
    const t = raw as Record<string, unknown>;
    const uri = String(t.uri ?? "");
    const title = typeof t.title === "string" ? t.title : "";
    if (!title) continue;
    tracks.push({
      id: uri.split(":").pop() ?? uri,
      title,
      artist: typeof t.subtitle === "string" ? t.subtitle : "",
      durationMs: typeof t.duration === "number" ? t.duration : undefined,
    });
  }
  const fallbackName =
    type === "album"
      ? "Spotify album"
      : type === "track"
        ? "Spotify track"
        : "Spotify playlist";
  const name = entity.title ?? entity.name ?? fallbackName;
  const value: SpotifyPublicPlaylist = { id, name, tracks };
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Read a public playlist's name + tracks with no authentication. */
export async function readPublicPlaylist(
  id: string,
): Promise<SpotifyPublicPlaylist> {
  return readPublicEntity("playlist", id);
}

/** Read a public album's name + tracks with no authentication. */
export async function readPublicAlbum(
  id: string,
): Promise<SpotifyPublicPlaylist> {
  return readPublicEntity("album", id);
}

/** Read a single public track (returned as a one-item collection). */
export async function readPublicTrack(
  id: string,
): Promise<SpotifyPublicPlaylist> {
  return readPublicEntity("track", id);
}
