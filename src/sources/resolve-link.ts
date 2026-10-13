// Decide what a link means when nobody is there to pick from a list: the route
// `sndcli add` takes, and the one a running dashboard follows for a link
// another process handed it. Pure string work, no network.

import type { SourceId } from "../library/types";
import { detectInput, detectPasteLink, effectiveKind, isLinkInput } from "./detect";
import { makeSoundcloud } from "./soundcloud";
import { makeSpotify } from "./spotify/adapter";
import { makeYoutube } from "./youtube";
import type { SourceAdapter } from "./types";

/** The adapter that reads a source's playlists from a handle or link. */
export function adapterFor(source: SourceId, value: string): SourceAdapter {
  if (source === "youtube") return makeYoutube(value);
  if (source === "soundcloud") return makeSoundcloud(value);
  return makeSpotify(value);
}

/** Which of an adapter's lists a link asks for. */
export type ListPick = "single" | "liked" | "all";

export type LinkTarget =
  /** One song: read it and queue it, like a paste in the dashboard. */
  | { ok: true; kind: "track"; source: SourceId; url: string }
  /** One or more collections, listed through the source's adapter. */
  | { ok: true; kind: "lists"; source: SourceId; input: string; pick: ListPick }
  | { ok: false; reason: string };

/**
 * Route a link. A song or a playlist says exactly what to fetch, so it goes
 * straight through. A profile is a whole library, and in the dashboard it opens
 * a picker; with no picker it is refused unless the caller passes `all`, so a
 * mistyped link can never pull thousands of tracks.
 */
export function resolveLink(
  raw: string,
  opts: { all?: boolean } = {},
): LinkTarget {
  const s = raw.trim();
  if (!s) return { ok: false, reason: "Empty link." };
  if (!isLinkInput(s)) {
    return {
      ok: false,
      reason: "Not a link. Pass a full URL: a bare handle does not say which site it is on.",
    };
  }

  const d = detectInput(s);
  if (d?.ok) {
    const kind = effectiveKind(s, d);
    if (kind === "collection") {
      return { ok: true, kind: "lists", source: d.source, input: s, pick: "single" };
    }
    if (kind === "profile") {
      // A likes link names one list on the profile, not the whole thing.
      if (d.source === "soundcloud" && /\/likes\/?(?:[?#].*)?$/i.test(s)) {
        return { ok: true, kind: "lists", source: d.source, input: s, pick: "liked" };
      }
      if (opts.all) {
        return { ok: true, kind: "lists", source: d.source, input: s, pick: "all" };
      }
      return {
        ok: false,
        reason:
          "That is a whole profile. Pass --all to download every playlist on it, or pass one playlist or song link.",
      };
    }
  }

  const paste = detectPasteLink(s);
  if (paste.ok) {
    return { ok: true, kind: "track", source: paste.source, url: paste.url };
  }
  return { ok: false, reason: paste.reason };
}
