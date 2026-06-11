import { promises as fs } from "node:fs";
import type { Library } from "./library";
import { fileExists, findDuplicates } from "./drift";

export interface ReconcileResult {
  /** Dead index entries removed (file was gone from disk). */
  prunedMissing: number;
  /** Duplicate entries removed (same song saved more than once). */
  mergedDuplicates: number;
  /** Redundant audio files deleted from disk. */
  deletedFiles: number;
}

/**
 * Silent library hygiene: drop entries whose audio file is gone, and collapse
 * duplicate songs down to a single copy (deleting the redundant files). Mutates
 * the library in place; never touches the network.
 */
export async function reconcileLibrary(
  library: Library,
  existsCache?: Map<string, boolean>,
): Promise<ReconcileResult> {
  let prunedMissing = 0;
  let mergedDuplicates = 0;
  let deletedFiles = 0;

  // 1) Prune entries whose file no longer exists on disk.
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

  return { prunedMissing, mergedDuplicates, deletedFiles };
}
