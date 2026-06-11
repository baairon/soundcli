// Resolve a pasted link into queue-ready tracks.

import { enumerate } from "../ytdlp/ytdlp";
import { slugTitle } from "../util/format";
import { ownerFromHandle } from "./handle";
import { siteFromUrl } from "./detect";
import type { SourceId } from "../library/types";
import { SOURCE_LABELS } from "../library/types";
import type { SourceTrack } from "./types";
import { makeSpotify } from "./spotify/adapter";
import { isSoundcloudTombstone } from "./soundcloud";
import { youtubeVideoUrl } from "./youtube";

/**
 * Owner folder for a pasted single-track link. Only SoundCloud carries the
 * artist in the URL path (soundcloud.com/artist/track); YouTube watch/shorts
 * paths say nothing about the uploader, Spotify singles have no collection
 * owner, and generic links use the site segment instead.
 */
export function ownerFromTrackUrl(
  source: SourceId,
  url: string,
): string | undefined {
  if (source !== "soundcloud") return undefined;
  try {
    const seg = new URL(url).pathname.split("/").filter(Boolean)[0];
    return seg ? ownerFromHandle(seg) : undefined;
  } catch {
    return undefined;
  }
}

function entryToTrack(
  e: {
    id: string;
    title: string;
    url?: string;
    uploader?: string;
    duration?: number;
  },
  source: SourceId,
  fallbackUrl: string,
  playlistTitle: string,
  owner?: string,
): SourceTrack {
  const downloadUrl =
    source === "youtube"
      ? youtubeVideoUrl(e.url ?? e.id)
      : (e.url as string) ?? fallbackUrl;

  const title =
    e.title && !/^\d+$/.test(e.title)
      ? e.title
      : slugTitle(downloadUrl) || e.title;

  return {
    id: e.id,
    title,
    artist: e.uploader,
    duration: e.duration,
    downloadUrl,
    playlistTitle,
    owner,
  };
}

/** Read metadata for a pasted link and return one or more SourceTracks. */
export async function tracksFromUrl(
  source: SourceId,
  url: string,
): Promise<SourceTrack[]> {
  if (source === "spotify") {
    const adapter = makeSpotify(url);
    const lists = await adapter.listPlaylists();
    const list = lists[0];
    if (!list) return [];
    return adapter.listTracks(list);
  }

  const multi = source === "link";
  const col = await enumerate(url, { flat: multi ? true : false });
  let entries = col.entries.filter((e) => e.id);
  // Deleted SoundCloud tracks linger in pasted feeds as bare api-v2 stubs
  // that 404 forever; never enqueue them.
  if (source === "soundcloud") {
    entries = entries.filter((e) => !isSoundcloudTombstone(e));
  }
  if (entries.length === 0) return [];

  const site = source === "link" ? siteFromUrl(url) : undefined;
  const playlistTitle =
    entries.length > 1 && col.title ? col.title : "Singles";

  return entries.map((e) =>
    entryToTrack(
      e,
      source,
      url,
      playlistTitle,
      source === "link" ? site : ownerFromTrackUrl(source, url),
    ),
  );
}

export function sourceLabel(source: SourceId): string {
  return SOURCE_LABELS[source];
}
