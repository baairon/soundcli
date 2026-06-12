// Config persistence policy for source handle fields.
//
// Rule: only store inputs that represent a *source identity* — something
// makeYoutube() / makeSoundcloud() can call listPlaylists() on repeatedly to
// discover the user's library. Never store *resource pointers* (one track,
// one playlist, one set) that only make sense for a single download session.
//
// Classification comes from detectInput() + effectiveKind():
//   profile   → identity (save normalized handle)
//   collection → resource (use now, don't save)
//   track     → resource (use now, don't save)
//
// Sources with a stored identity (youtube, soundcloud, spotify) use this
// policy; link has no handle field.

import type { SourceId } from "../library/types";
import {
  detectInput,
  effectiveKind,
  isLinkInput,
  sourceSupportsIdentity,
} from "./detect";
import { normalizeHandle } from "./handle";
import { normalizeSpotifyHandle } from "./spotify/handle";
import { parseSpotifyInput } from "./spotify/public";

export type PersistDecision =
  | { persist: true; value: string }
  | { persist: false; reason: PersistRejectReason };

export type PersistRejectReason =
  | "empty"
  | "no_identity_field"
  | "wrong_source"
  | "resource"
  | "invalid"
  | "unrecognized_url"
  | "bare_text";

/** Explain why an input would or would not be written to config. */
export function persistDecision(
  source: SourceId,
  raw: string,
): PersistDecision {
  const v = raw.trim();
  if (!v) return { persist: false, reason: "empty" };

  if (!sourceSupportsIdentity(source)) {
    return { persist: false, reason: "no_identity_field" };
  }

  const d = detectInput(v);
  if (d?.ok === false) {
    return {
      persist: false,
      reason: d.source !== source ? "wrong_source" : "invalid",
    };
  }
  if (d?.ok === true && d.source !== source) {
    return { persist: false, reason: "wrong_source" };
  }

  const kind = d?.ok === true ? effectiveKind(v, d) : null;
  if (kind === "track" || kind === "collection") {
    return { persist: false, reason: "resource" };
  }

  if (isLinkInput(v)) {
    if (d?.ok === true && kind === "profile") {
      return { persist: true, value: d.value };
    }
    return { persist: false, reason: "unrecognized_url" };
  }

  if (d?.ok === true && kind === "profile") {
    return {
      persist: true,
      value:
        source === "spotify" ? normalizeSpotifyHandle(d.value) : d.value,
    };
  }

  if (!/[a-z0-9]/i.test(v)) {
    return { persist: false, reason: "bare_text" };
  }

  if (source === "spotify") {
    const ref = parseSpotifyInput(v);
    if (ref.type === "playlist" || ref.type === "album" || ref.type === "track") {
      return { persist: false, reason: "resource" };
    }
    return { persist: true, value: normalizeSpotifyHandle(v) };
  }

  return { persist: true, value: normalizeHandle(v) };
}

/** User-facing copy when a handle field refuses to save an input. */
export function persistRejectMessage(reason: PersistRejectReason): string {
  switch (reason) {
    case "resource":
      return "That's a playlist or song link · enter a handle instead";
    case "wrong_source":
      return "That link is for another source";
    case "invalid":
      return "That link isn't usable as a handle";
    case "unrecognized_url":
      return "Paste a profile link, or type a handle";
    case "bare_text":
      return "Enter a handle with letters or numbers";
    default:
      return "Couldn't save that";
  }
}

/**
 * Return the handle to store in config, or `undefined` when the input should
 * not be persisted. An empty string clears the field (`undefined`).
 */
export function persistableHandle(
  source: SourceId,
  raw: string,
): string | undefined {
  const d = persistDecision(source, raw);
  return d.persist ? d.value : undefined;
}
