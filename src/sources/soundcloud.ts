import { promises as fs } from "node:fs";
import path from "node:path";
import { downloadLogFile } from "../config/paths";
import { enumerate, type YtCollection } from "../ytdlp/ytdlp";
import { linkCollectionTitle, slugTitle } from "../util/format";
import { normalizeHandle, ownerFromHandle } from "./handle";
import { detectInput } from "./detect";
import type {
  SourceAdapter,
  SourcePlaylist,
  SourceTrack,
} from "./types";

/** A SoundCloud set/album URL looks like soundcloud.com/<user>/sets/<slug>. */
function isSetUrl(url: string): boolean {
  return /\/sets\//.test(url);
}

/**
 * A deleted track lingering in a likes feed: the flat entry points at the raw
 * api-v2 /tracks/<id> endpoint and carries no human metadata (no title, or a
 * bare numeric id). These 404 forever, even on a current yt-dlp, so they
 * never belong in the queue. A normal soundcloud.com/<artist>/<slug> URL with
 * a numeric title is NOT a tombstone (its slug recovers the name).
 */
export function isSoundcloudTombstone(e: {
  url?: string;
  title?: string;
}): boolean {
  if (!e.url) return false;
  if (!/^https?:\/\/api(-v2)?\.soundcloud\.com\/tracks\/\d+\/?$/.test(e.url)) {
    return false;
  }
  return !e.title || /^\d+$/.test(e.title.trim());
}

/** One log line so "why is the count short?" stays answerable after the fact. */
function logSkippedTombstones(count: number, playlistTitle: string): void {
  if (process.env.VITEST) return;
  void (async () => {
    await fs.mkdir(path.dirname(downloadLogFile), { recursive: true });
    await fs.appendFile(
      downloadLogFile,
      `${new Date().toISOString()} [SoundCloud] skipped ${count} removed track(s) in "${playlistTitle}"\n`,
    );
  })().catch(() => {});
}

/**
 * SoundCloud by handle: lists the user's public liked songs, liked sets, and
 * their own created sets (no auth/cookies). Likes are public by default.
 */
function asUrl(raw: string): string {
  const s = raw.trim();
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}

export function makeSoundcloud(input?: string): SourceAdapter {
  const d = input ? detectInput(input) : null;
  let user: string | undefined;
  let owner: string | undefined;
  let singleUrl: string | undefined;

  if (input && isSetUrl(asUrl(input))) {
    singleUrl = asUrl(input);
  } else if (d?.ok && d.source === "soundcloud") {
    if (d.kind === "profile") {
      user = d.value;
      owner = ownerFromHandle(d.value);
    } else {
      singleUrl = d.value;
    }
  } else if (input) {
    user = normalizeHandle(input);
    owner = ownerFromHandle(input);
  }

  // The likes feed can be large (thousands of items), so enumerate it once and
  // reuse it for both discovering liked sets (listPlaylists) and downloading
  // "Liked Songs" (listTracks), avoiding a double scan.
  let likesCache: YtCollection | undefined;
  async function getLikes(): Promise<YtCollection> {
    if (!user) throw new Error("enter your SoundCloud handle first.");
    if (!likesCache)
      likesCache = await enumerate(`https://soundcloud.com/${user}/likes`, {});
    return likesCache;
  }

  return {
    id: "soundcloud",
    label: "SoundCloud",
    owner,

    async listPlaylists(): Promise<SourcePlaylist[]> {
      if (singleUrl) {
        return [{
          id: "single",
          title: linkCollectionTitle(singleUrl),
          url: singleUrl,
          kind: "playlist",
        }];
      }
      if (!user) throw new Error("enter your SoundCloud handle first.");
      const likesUrl = `https://soundcloud.com/${user}/likes`;

      // Pre-fetch likes to get counts and discover liked sets in one pass.
      let likedSongCount: number | undefined;
      const lists: SourcePlaylist[] = [];

      try {
        const likes = await getLikes();
        const nonSetEntries = likes.entries.filter(
          (e) => e.id && e.url && !isSetUrl(e.url) && !isSoundcloudTombstone(e),
        );
        likedSongCount = nonSetEntries.length;

        // Liked sets/playlists live inside the likes feed (they're filtered out of
        // "Liked Songs"), so surface each one as its own downloadable entry.
        const seen = new Set<string>();
        for (const e of likes.entries) {
          if (!e.url || !isSetUrl(e.url) || seen.has(e.url)) continue;
          seen.add(e.url);
          lists.push({
            id: e.id || e.url,
            title: e.title,
            url: e.url,
            kind: "playlist",
          });
        }
      } catch {
        // likes feed unavailable: Liked Songs still works
      }

      // Insert Liked Songs at the front (after counting).
      lists.unshift({
        id: `sc-liked-${user}`,
        title: "Liked Songs",
        url: likesUrl,
        kind: "liked",
        count: likedSongCount,
      });

      // Sets the user created themselves (a short list, fast to fetch).
      try {
        const sets = await enumerate(`https://soundcloud.com/${user}/sets`, {});
        for (const e of sets.entries) {
          const url =
            e.url ??
            (e.id ? `https://soundcloud.com/${user}/sets/${e.id}` : undefined);
          if (!url) continue;
          lists.push({
            id: e.id || url,
            title: e.title,
            url,
            kind: "playlist",
          });
        }
      } catch {
        // no public created sets: likes still work
      }

      // Dedupe by url (a set you both liked and created can appear twice).
      const seenUrls = new Set<string>();
      return lists.filter((l) => {
        if (seenUrls.has(l.url)) return false;
        seenUrls.add(l.url);
        return true;
      });
    },

    async listTracks(playlist: SourcePlaylist): Promise<SourceTrack[]> {
      const col =
        playlist.kind === "liked"
          ? await getLikes()
          : await enumerate(playlist.url, {});
      let entries = col.entries.filter((e) => e.id && e.url);
      // "Liked Songs" enumerates the whole likes feed, so drop the liked sets
      // and keep only the standalone tracks (the sets are their own entries).
      if (playlist.kind === "liked") {
        entries = entries.filter((e) => !isSetUrl(e.url as string));
      }
      // Deleted tracks linger in feeds as bare api-v2 stubs; enqueueing them
      // only manufactures guaranteed failures.
      const beforeTombstones = entries.length;
      entries = entries.filter((e) => !isSoundcloudTombstone(e));
      if (entries.length < beforeTombstones) {
        logSkippedTombstones(beforeTombstones - entries.length, playlist.title);
      }
      // A pasted set link starts with a slug-guessed title; once fetched, the
      // feed's real set name is better. (Never for "liked" — that's our label.)
      const playlistTitle =
        playlist.id === "single" ? col.title || playlist.title : playlist.title;
      // The likes feed's flat entries often carry no title (or a bare numeric
      // ID); the track URL's slug holds the real name, so prefer it then.
      return entries.map((e) => ({
        id: e.id,
        title:
          e.title && !/^\d+$/.test(e.title)
            ? e.title
            : slugTitle(e.url) || e.title,
        artist: e.uploader,
        duration: e.duration,
        downloadUrl: e.url as string,
        playlistTitle,
        owner,
      }));
    },
  };
}
