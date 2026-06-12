import { enumerate, type YtEntry } from "../ytdlp/ytdlp";
import { linkCollectionTitle } from "../util/format";
import { normalizeHandle, ownerFromHandle } from "./handle";
import { detectInput } from "./detect";
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
export function makeYoutube(input?: string): SourceAdapter {
  const d = input ? detectInput(input) : null;
  let h: string | undefined;
  let owner: string | undefined;
  let singleUrl: string | undefined;

  if (d?.ok && d.source === "youtube") {
    if (d.kind === "profile") {
      h = d.value;
      owner = ownerFromHandle(d.value);
    } else {
      singleUrl = d.value;
    }
  } else if (input) {
    h = normalizeHandle(input);
    owner = ownerFromHandle(input);
  }
  return {
    id: "youtube",
    label: "YouTube",
    owner,

    async listPlaylists(): Promise<SourcePlaylist[]> {
      if (singleUrl) {
        return [{
          id: "single",
          title: linkCollectionTitle(singleUrl),
          url: singleUrl,
          kind: "playlist" as const,
        }];
      }
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
      // A pasted link starts with a guessed title (linkCollectionTitle); now
      // that we've fetched, yt-dlp's real collection name is the one to store.
      const playlistTitle =
        playlist.id === "single" ? col.title || playlist.title : playlist.title;
      return col.entries
        .filter((e) => e.id)
        .map((e) => ({
          id: e.id,
          title: e.title,
          artist: e.uploader,
          duration: e.duration,
          downloadUrl: youtubeVideoUrl(e.url ?? e.id),
          playlistTitle,
          owner,
        }));
    },
  };
}

