import { promises as fs } from "node:fs";
import type { Track } from "./types";
import { cleanText } from "../util/format";

/** A set of library entries that are all the same song. */
export interface DuplicateGroup {
  signature: string;
  tracks: Track[];
}

/**
 * A normalized "this is the same song in the same collection" key: lowercased
 * artist + title with emoji/symbols stripped, scoped to the (source, owner)
 * collection it belongs to. Within one collection a song never saves twice
 * (likes vs a set of the same handle still dedupe); different handles keep
 * complete, self-contained copies. Ownerless tracks (Spotify, legacy entries)
 * share one global bucket, preserving the old cross-source dedupe for them.
 */
export function trackSignature(
  t: Pick<Track, "artist" | "title" | "owner"> & { source?: Track["source"] },
): string {
  const artist = cleanText((t.artist ?? "").toLowerCase());
  const title = cleanText((t.title ?? "").toLowerCase());
  const collection = t.owner ? `${t.source ?? ""}:${t.owner.toLowerCase()}` : "";
  return `${collection}|${artist}|${title}`;
}

/** Group tracks by signature, returning only the groups with 2+ members. */
export function findDuplicates(tracks: Track[]): DuplicateGroup[] {
  const groups = new Map<string, Track[]>();
  for (const t of tracks) {
    const sig = trackSignature(t);
    const arr = groups.get(sig);
    if (arr) arr.push(t);
    else groups.set(sig, [t]);
  }
  const out: DuplicateGroup[] = [];
  for (const [signature, members] of groups) {
    if (members.length > 1) out.push({ signature, tracks: members });
  }
  return out;
}

/**
 * True if the file at `filePath` still exists on disk. An optional shared
 * cache lets boot-time passes (migrate + reconcile) stat each path once
 * instead of once per pass; writers must keep the cache honest on renames.
 */
export async function fileExists(
  filePath: string,
  cache?: Map<string, boolean>,
): Promise<boolean> {
  const hit = cache?.get(filePath);
  if (hit !== undefined) return hit;
  let exists: boolean;
  try {
    await fs.access(filePath);
    exists = true;
  } catch {
    exists = false;
  }
  cache?.set(filePath, exists);
  return exists;
}
