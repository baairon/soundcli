/**
 * Reduce whatever the user pasted to a bare handle. Accepts a plain handle
 * ("flume"), an "@handle", or a full/partial URL ("soundcloud.com/flume/likes",
 * "https://www.youtube.com/@NASA") and returns just "flume" / "NASA".
 */
export function normalizeHandle(input: string): string {
  let s = input.trim();
  // If a URL (or host/path) was pasted, take the first path segment.
  const m = s.match(/^(?:https?:\/\/)?[^/\s]*\/(@?[^/?#\s]+)/);
  if (m?.[1]) s = m[1];
  return s.replace(/^@/, "").trim();
}

/**
 * The canonical owner key for a handle: normalized and lowercased, so
 * "Flume", "@flume", and "soundcloud.com/flume" all map to one collection.
 * Used for folder names, dedupe, and library grouping (never for URLs, which
 * keep the handle's original casing).
 */
export function ownerFromHandle(input: string): string {
  return normalizeHandle(input).toLowerCase();
}
