// Resolve a Spotify track to an exact YouTube watch URL, the way spotDL's
// search_and_download does (search providers/audio/base.py -> get_best_result).
// We search a handful of YouTube candidates, score them with the ported
// matching heuristics, and return the best video's URL (or null if none clears
// the floor, so the caller can fall back to the blind ytsearch1 query).

import type { SourceTrack } from "../types";
import { searchYouTube, type YouTubeCandidate } from "../../ytdlp/search";
import { pickBest, type MatchTarget } from "./match";

/** How many YouTube candidates to consider, mirroring spotDL's small N. */
const CANDIDATE_COUNT = 5;

/** Build the free-text query spotDL uses: "artist title". */
function searchText(track: SourceTrack): string {
  return `${track.artist ?? ""} ${track.title}`.replace(/\s+/g, " ").trim();
}

/**
 * Resolve a Spotify SourceTrack to an exact YouTube watch URL via candidate
 * search + scoring. Returns null when no candidate is a good enough match (the
 * download path then falls back to the stored ytsearch1: URL).
 *
 * @param track - The Spotify-sourced track (title, artist, duration).
 * @returns A watch URL string, or null if nothing matched well.
 */
export async function resolveSpotifyDownloadUrl(
  track: SourceTrack,
): Promise<string | null> {
  const query = searchText(track);
  if (!query) return null;

  let candidates: YouTubeCandidate[];
  try {
    candidates = await searchYouTube(query, CANDIDATE_COUNT);
  } catch {
    // A failed search is not fatal: let the caller fall back to ytsearch1.
    return null;
  }
  if (candidates.length === 0) return null;

  const target: MatchTarget = {
    title: track.title,
    artist: track.artist,
    durationSec: track.duration,
  };
  const best = pickBest(target, candidates);
  return best ? best.url : null;
}
