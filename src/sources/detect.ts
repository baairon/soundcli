// Figure out which source a pasted link or typed handle belongs to, so the
// Download flow can skip the "pick a source" step whenever the input already
// says where it's from.

import { normalizeHandle, ownerFromHandle } from "./handle";
import { parseSpotifyInput } from "./spotify/public";
import { sanitizeName } from "../ytdlp/args";
import type { SourceId } from "../library/types";

export type DetectKind = "profile" | "collection" | "track";

export type DetectResult =
  /** Recognized and usable. */
  | { ok: true; source: SourceId; kind: DetectKind; value: string }
  /** Recognized host, but a path we can't use. */
  | { ok: false; source: SourceId; reason: string }
  /** Not a recognized link: treat as a bare handle. */
  | null;

/** SoundCloud first path segments that are site pages, never user handles. */
const SOUNDCLOUD_RESERVED = new Set([
  "discover",
  "search",
  "stream",
  "you",
  "feed",
  "upload",
  "charts",
]);

/** SoundCloud second path segments that start a collection, not a single track. */
const SOUNDCLOUD_COLLECTION = new Set([
  "sets",
  "likes",
  "reposts",
  "followers",
  "following",
  "comments",
  "popular-tracks",
  "albums",
  "tracks",
]);

/** YouTube first path segments that aren't @handles (videos, playlists, raw
 *  channel ids): things our handle-based adapter can't enumerate. */
const YOUTUBE_NOT_A_HANDLE = new Set([
  "watch",
  "playlist",
  "shorts",
  "channel",
  "c",
  "user",
  "embed",
  "live",
  "results",
  "feed",
]);

const YOUTUBE_PROFILE_HINT =
  "Paste a channel link like youtube.com/@handle, or just type the handle.";

const YOUTUBE_TRACK_HINT =
  "Paste a video link like youtube.com/watch?v=… or youtu.be/…";

function withProtocol(raw: string): string {
  const s = raw.trim();
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}

function pathSegments(path: string): string[] {
  return path.replace(/^\//, "").split(/[/?#]/).filter(Boolean);
}

/**
 * Detect the source of a pasted link. Tolerates a missing protocol, `www.` /
 * `m.` prefixes, and mixed case. Returns null for anything that doesn't look
 * like a link from one of our sources (a bare handle, usually).
 */
export function detectInput(raw: string): DetectResult {
  const s = raw.trim();
  if (!s) return null;

  // Spotify URIs (spotify:playlist:...) have no host.
  if (/^spotify:/i.test(s)) {
    const ref = parseSpotifyInput(s);
    if (ref.type === "track") {
      return { ok: true, source: "spotify", kind: "track", value: s };
    }
    if (ref.type === "playlist" || ref.type === "album") {
      return { ok: true, source: "spotify", kind: "collection", value: s };
    }
    if (ref.type === "user") {
      return { ok: false, source: "spotify", reason: "Paste a playlist or track link from Spotify." };
    }
    return { ok: false, source: "spotify", reason: "That doesn't look like a Spotify link." };
  }

  const m = s.match(/^(?:https?:\/\/)?([^/\s?#]+)([/?#]\S*)?$/);
  if (!m) return null;
  const host = m[1]!.toLowerCase().replace(/^(?:www|m)\./, "");
  // No dot means it can't be a hostname: "flume" or "@flume" is a bare handle.
  if (!host.includes(".")) return null;
  const path = m[2] ?? "";
  const segments = pathSegments(path);
  const firstSegment = segments[0] ?? "";

  if (host === "open.spotify.com" || host === "spotify.com") {
    const ref = parseSpotifyInput(s);
    if (ref.type === "track") {
      return { ok: true, source: "spotify", kind: "track", value: withProtocol(s) };
    }
    if (ref.type === "playlist" || ref.type === "album") {
      return { ok: true, source: "spotify", kind: "collection", value: withProtocol(s) };
    }
    if (ref.type === "user") {
      return { ok: false, source: "spotify", reason: "Paste a playlist or track link from Spotify." };
    }
    return { ok: false, source: "spotify", reason: "That doesn't look like a Spotify link." };
  }

  if (host === "on.soundcloud.com") {
    return {
      ok: false,
      source: "soundcloud",
      reason:
        "Short links don't say whose profile that is. Paste the full song or profile link.",
    };
  }

  if (host === "soundcloud.com") {
    if (!firstSegment || SOUNDCLOUD_RESERVED.has(firstSegment.toLowerCase())) {
      return {
        ok: false,
        source: "soundcloud",
        reason: "Paste a song link or profile like soundcloud.com/artist/track.",
      };
    }
    const second = segments[1]?.toLowerCase() ?? "";
    if (
      segments.length >= 2 &&
      !SOUNDCLOUD_COLLECTION.has(second)
    ) {
      return {
        ok: true,
        source: "soundcloud",
        kind: "track",
        value: withProtocol(s),
      };
    }
    return { ok: true, source: "soundcloud", kind: "profile", value: normalizeHandle(s) };
  }

  if (host === "youtu.be") {
    const id = firstSegment;
    if (!id) {
      return { ok: false, source: "youtube", reason: YOUTUBE_TRACK_HINT };
    }
    return {
      ok: true,
      source: "youtube",
      kind: "track",
      value: `https://www.youtube.com/watch?v=${id}`,
    };
  }

  if (host === "youtube.com" || host === "music.youtube.com") {
    if (firstSegment === "watch" || path.includes("v=")) {
      return { ok: true, source: "youtube", kind: "track", value: withProtocol(s) };
    }
    if (firstSegment === "shorts" && segments[1]) {
      return { ok: true, source: "youtube", kind: "track", value: withProtocol(s) };
    }
    if (firstSegment.startsWith("@")) {
      return { ok: true, source: "youtube", kind: "profile", value: normalizeHandle(s) };
    }
    if (!firstSegment || YOUTUBE_NOT_A_HANDLE.has(firstSegment.toLowerCase())) {
      if (firstSegment === "playlist" && path.includes("list=")) {
        return {
          ok: true,
          source: "youtube",
          kind: "collection",
          value: withProtocol(s),
        };
      }
      return { ok: false, source: "youtube", reason: YOUTUBE_PROFILE_HINT };
    }
    return { ok: true, source: "youtube", kind: "profile", value: normalizeHandle(s) };
  }

  return null;
}

export type PasteLinkResult =
  /** A single-song link the queue can download (into its source's folder). */
  | { ok: true; action: "download"; source: SourceId; url: string }
  | { ok: false; reason: string; source?: SourceId };

function normalizeUrl(raw: string): string {
  const s = raw.trim();
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}

/** Lowercased hostname with www./m. stripped, or null for non-URL input. */
function hostOf(raw: string): string | null {
  const m = raw.trim().match(/^(?:https?:\/\/)?([^/\s?#]+)([/?#]\S*)?$/);
  if (!m) return null;
  return m[1]!.toLowerCase().replace(/^(?:www|m)\./, "");
}

/** True when the input looks like a URL (not a bare handle). */
export function isLinkInput(raw: string): boolean {
  const s = raw.trim();
  if (!s) return false;
  if (/^spotify:/i.test(s)) return true;
  return Boolean(hostOf(s)?.includes("."));
}

/** Site segment under Links/, e.g. "tiktok.com" or "bandcamp.com". */
export function siteFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^(?:www|m)\./, "");
    const parts = host.split(".").filter(Boolean);
    if (parts.length >= 2) return sanitizeName(parts.slice(-2).join("."));
    return sanitizeName(host);
  } catch {
    return "unknown";
  }
}

const NOT_A_LINK = "Not a link yet · paste a full URL.";

/**
 * Decide what a pasted link does. Paste takes exactly one song: known-source
 * track links download into their usual folders and unknown hosts go through
 * yt-dlp into Links/<site>. Anything bigger (a profile, a playlist, a raw
 * channel id) surfaces its reason instead of falling through, so a mistaken
 * paste never flat-downloads an entire library.
 */
export function detectPasteLink(raw: string): PasteLinkResult {
  const s = raw.trim();
  if (!s) return { ok: false, reason: "Paste a link first." };
  if (!isLinkInput(s)) return { ok: false, reason: NOT_A_LINK };

  const url = normalizeUrl(s);
  const d = detectInput(s);

  if (d?.ok && d.kind === "track") {
    return { ok: true, action: "download", source: d.source, url: d.value };
  }
  // A profile or playlist is a library, and libraries come in through the
  // source menu, never a flat paste.
  if (d?.ok && d.kind === "profile") {
    return {
      ok: false,
      reason: "That's a whole profile · paste one song's link.",
      source: d.source,
    };
  }
  if (d?.ok && d.kind === "collection") {
    return {
      ok: false,
      reason: "That's a whole playlist · paste one song's link.",
      source: d.source,
    };
  }
  if (d && !d.ok) {
    // Short links hide the path but resolve fine once yt-dlp follows them;
    // most shares are one track, and the enqueue guard rejects whole sets.
    if (d.source === "soundcloud" && hostOf(s) === "on.soundcloud.com") {
      return { ok: true, action: "download", source: "soundcloud", url };
    }
    return { ok: false, reason: d.reason, source: d.source };
  }

  return { ok: true, action: "download", source: "link", url };
}

export interface PasteLinkPreview {
  /** download = good, warn = warn, dim = gentle guidance. */
  tone: "download" | "warn" | "dim";
  text: string;
}

function firstSegmentOfUrl(url: string): string | undefined {
  try {
    return new URL(url).pathname.split("/").filter(Boolean)[0];
  } catch {
    return undefined;
  }
}

/**
 * One-line preview for the paste field, updated as the user types: what we
 * recognized and where it will save ("…" when the folder name is only known
 * after fetching). Pure string work, no network.
 */
export function describePasteLink(raw: string): PasteLinkPreview | null {
  const s = raw.trim();
  if (!s) return null;
  const d = detectPasteLink(s);

  if (!d.ok) {
    return { tone: isLinkInput(s) ? "warn" : "dim", text: d.reason };
  }
  if (d.source === "youtube") {
    return { tone: "download", text: "YouTube song · saves to YouTube/Singles" };
  }
  if (d.source === "soundcloud") {
    const owner =
      hostOf(s) === "on.soundcloud.com"
        ? undefined
        : firstSegmentOfUrl(d.url);
    return owner
      ? {
          tone: "download",
          text: `SoundCloud song · saves to SoundCloud/${ownerFromHandle(owner)}/Singles`,
        }
      : { tone: "download", text: "SoundCloud link · saves to SoundCloud/…" };
  }
  if (d.source === "spotify") {
    return { tone: "download", text: "Spotify song · saves to Spotify/…" };
  }
  const site = siteFromUrl(d.url);
  return { tone: "download", text: `One song · saves to Links/${site}` };
}
