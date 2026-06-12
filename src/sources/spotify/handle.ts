import { parseSpotifyInput } from "./public";

/** Bare username from a paste, URI, or profile URL. */
export function normalizeSpotifyHandle(input: string): string {
  const ref = parseSpotifyInput(input);
  if (ref.type === "user") return ref.id;
  return input.trim().replace(/^@/, "");
}
