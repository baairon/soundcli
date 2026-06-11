import { enumerate, type YtEntry } from "../ytdlp/ytdlp";
import { normalizeHandle, ownerFromHandle } from "./handle";
import type {
  SourceAdapter,
  SourcePlaylist,
  SourceTrack,
} from "./types";

export function youtubeVideoUrl(idOrUrl: string): string {
  if (idOrUrl.startsWith("http")) return idOrUrl;
  return `https://www.youtube.com/watch?v=${idOrUrl}`;
}

function playlistUrlFromEntry(e: YtEntry): string {
  if (e.url && e.url.startsWith("http")) return e.url;
  return `https://www.youtube.com/playlist?list=${e.id}`;
}

/** YouTube by handle: lists the channel's public playlists (no auth/cookies). */
export function makeYoutube(handle?: string): SourceAdapter {
  const h = handle ? normalizeHandle(handle) : undefined;
  const owner = handle ? ownerFromHandle(handle) : undefined;
  return {
    id: "youtube",
    label: "YouTube",
    owner,

    async listPlaylists(): Promise<SourcePlaylist[]> {
      if (!h) throw new Error("enter your YouTube handle first.");
      const col = await enumerate(`https://www.youtube.com/@${h}/playlists`, {});
      return col.entries
        .filter((e) => e.id)
        .map((e) => ({
          id: e.id,
          title: e.title,
          url: playlistUrlFromEntry(e),
          kind: "playlist" as const,
          count: (e as unknown as Record<string, unknown>).n_entries as number | undefined,
        }));
    },

    async listTracks(playlist: SourcePlaylist): Promise<SourceTrack[]> {
      const col = await enumerate(playlist.url, {});
      return col.entries
        .filter((e) => e.id)
        .map((e) => ({
          id: e.id,
          title: e.title,
          artist: e.uploader,
          duration: e.duration,
          downloadUrl: youtubeVideoUrl(e.url ?? e.id),
          playlistTitle: playlist.title,
          owner,
        }));
    },
  };
}

