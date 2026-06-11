// YouTube candidate search, the first half of spotDL's audio provider flow
// (spotify-downloader/spotdl/providers/audio/base.py -> get_results/search).
// spotDL asks yt-dlp for several candidates, then scores them; here we just
// gather the candidates (scoring lives in spotify/match.ts).

import { enumerate } from "./ytdlp";

/** A YouTube search hit we can score and download. */
export interface YouTubeCandidate {
  id: string;
  title: string;
  uploader?: string;
  /** Duration in seconds, if yt-dlp reported it in the flat listing. */
  duration?: number;
  /** Canonical watch URL we hand to the downloader. */
  url: string;
}

/** Build a watch URL from a video id (flat search results give bare ids). */
function watchUrl(idOrUrl: string | undefined, id: string): string {
  if (idOrUrl && idOrUrl.startsWith("http")) return idOrUrl;
  return `https://www.youtube.com/watch?v=${id}`;
}

/**
 * Search YouTube for up to `n` candidates for a free-text query, reusing the
 * existing flat `enumerate()` (ytsearchN: target). Mirrors spotDL asking the
 * provider for a handful of results before matching.
 *
 * @param query - Free text, e.g. "Daft Punk Get Lucky".
 * @param n - How many candidates to request (spotDL-style small N, e.g. 5).
 * @returns Candidates with id, title, uploader, duration, and a watch URL.
 */
export async function searchYouTube(
  query: string,
  n = 5,
): Promise<YouTubeCandidate[]> {
  const clean = query.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const count = Math.max(1, Math.floor(n));
  const col = await enumerate(`ytsearch${count}:${clean}`, { flat: true });
  return col.entries
    .filter((e) => e.id)
    .map((e) => ({
      id: e.id,
      title: e.title,
      uploader: e.uploader,
      duration: e.duration,
      url: watchUrl(e.url, e.id),
    }));
}
