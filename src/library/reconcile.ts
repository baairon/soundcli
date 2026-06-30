import { promises as fs } from "node:fs";
import path from "node:path";
import type { Library } from "./library";
import type { Track } from "./types";
import {
  fileExists,
  fileSizeOf,
  findDuplicates,
  indexAudioByBasename,
} from "./drift";

export interface ReconcileResult {
  /** Dead index entries removed (file was gone from disk). */
  prunedMissing: number;
  /** Duplicate entries removed (same song saved more than once). */
  mergedDuplicates: number;
  /** Redundant audio files deleted from disk. */
  deletedFiles: number;
  /** Entries whose moved/reorganized file was re-found and re-linked. */
  relinked: number;
}

/**
 * Silent library hygiene: drop entries whose audio file is gone, and collapse
 * duplicate songs down to a single copy (deleting the redundant files). Mutates
 * the library in place; never touches the network.
 */
export async function reconcileLibrary(
  library: Library,
  existsCache?: Map<string, boolean>,
  libraryDir?: string,
): Promise<ReconcileResult> {
  let prunedMissing = 0;
  let mergedDuplicates = 0;
  let deletedFiles = 0;
  let relinked = 0;

  // 0) Re-link first: a track whose file was moved, reorganized, or renamed
  //    inside the library folder should be re-found, not dropped as missing.
  const missing: Track[] = [];
  for (const t of library.all()) {
    if (!(await fileExists(t.filePath, existsCache))) missing.push(t);
  }
  if (missing.length > 0 && libraryDir) {
    const byBasename = await indexAudioByBasename(libraryDir);
    const missingIds = new Set(missing.map((t) => t.id));
    // Files a present track already points at are off-limits, and each found
    // file is claimed once so two drifted entries never grab the same path.
    const claimed = new Set(
      library
        .all()
        .filter((t) => !missingIds.has(t.id))
        .map((t) => t.filePath),
    );
    const relink = async (t: Track, next: string): Promise<void> => {
      // Merge onto the live entry so a concurrent download upsert isn't clobbered.
      const live = library.get(t.id) ?? t;
      await library.upsert({ ...live, filePath: next });
      existsCache?.set(t.filePath, false);
      existsCache?.set(next, true);
      claimed.add(next);
      relinked++;
    };

    // Pass 1 — same filename: a plain move or folder reorganize.
    const stillMissing: Track[] = [];
    for (const t of missing) {
      const next = (byBasename.get(path.basename(t.filePath)) ?? []).find(
        (p) => !claimed.has(p),
      );
      if (next) await relink(t, next);
      else stillMissing.push(t);
    }

    // Pass 2 — same content size: a rename (possibly + move). Only the
    // unclaimed "orphan" files are stat'd, and only when an entry with a
    // recorded size is actually still missing, so the common case stays free.
    const renameable = stillMissing.filter(
      (t) => typeof t.fileSize === "number",
    );
    if (renameable.length > 0) {
      const bySize = new Map<number, string[]>();
      for (const p of [...byBasename.values()].flat()) {
        if (claimed.has(p)) continue;
        const size = await fileSizeOf(p);
        if (size === undefined) continue;
        const arr = bySize.get(size);
        if (arr) arr.push(p);
        else bySize.set(size, [p]);
      }
      for (const t of renameable) {
        const next = bySize.get(t.fileSize!)?.find((p) => !claimed.has(p));
        if (next) await relink(t, next);
      }
    }
  }

  // 1) Prune entries whose file is still gone after the re-link pass.
  for (const t of library.all()) {
    if (!(await fileExists(t.filePath, existsCache))) {
      await library.remove(t.id);
      prunedMissing++;
    }
  }

  // 2) Collapse duplicate songs among the survivors (all still on disk).
  for (const group of findDuplicates(library.all())) {
    const sorted = [...group.tracks].sort((a, b) =>
      a.addedAt.localeCompare(b.addedAt),
    );
    const keptPath = sorted[0]!.filePath;
    for (const dup of sorted.slice(1)) {
      // Don't delete a file the kept copy also points to.
      if (dup.filePath && dup.filePath !== keptPath) {
        try {
          await fs.rm(dup.filePath, { force: true });
          existsCache?.set(dup.filePath, false);
          deletedFiles++;
        } catch {
          // locked or undeletable; the index entry still goes.
        }
      }
      await library.remove(dup.id);
      mergedDuplicates++;
    }
  }

  // Record file sizes for present tracks so a future rename can be matched by
  // content, not name. Stat first (slow), then apply against the live entries in
  // one synchronous pass, so a download upserting the same track mid-stat is
  // never clobbered. One stat per not-yet-recorded track, then none.
  if (libraryDir) {
    const sizes = new Map<string, number>();
    for (const t of library.all()) {
      if (typeof t.fileSize === "number") continue;
      const size = await fileSizeOf(t.filePath);
      if (size !== undefined) sizes.set(t.id, size);
    }
    const updates: Track[] = [];
    for (const [id, size] of sizes) {
      const live = library.get(id);
      if (live && typeof live.fileSize !== "number") {
        updates.push({ ...live, fileSize: size });
      }
    }
    if (updates.length > 0) await library.upsertMany(updates);
  }

  return { prunedMissing, mergedDuplicates, deletedFiles, relinked };
}
