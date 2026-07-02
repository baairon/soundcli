import { promises as fs } from "node:fs";
import path from "node:path";
import type { Library } from "./library";
import { libId, type Track } from "./types";
import {
  fileExists,
  fileSizeOf,
  findDuplicates,
  indexAudioByBasename,
  playlistFromPath,
  titleFromFilename,
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
  /** Hand-added audio files adopted into the library as "local" tracks. */
  adopted: number;
}

/**
 * Silent library hygiene: drop entries whose audio file is gone, collapse
 * duplicate songs down to a single copy (deleting the redundant files), and
 * adopt audio the user added by hand. Mutates the library in place; never
 * touches the network.
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
  let adopted = 0;

  // One walk of the music folder serves both the re-link pass and adoption.
  const byBasename = libraryDir
    ? await indexAudioByBasename(libraryDir)
    : undefined;

  // 0) Re-link first: a track whose file was moved, reorganized, or renamed
  //    inside the library folder should be re-found, not dropped as missing.
  const missing: Track[] = [];
  for (const t of library.all()) {
    if (!(await fileExists(t.filePath, existsCache))) missing.push(t);
  }
  if (missing.length > 0 && libraryDir && byBasename) {
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
      // Folders are the organizing truth: a re-found file takes its new parent
      // folder as its playlist, so renaming a playlist folder or moving songs
      // between folders in a file manager is what re-sorts them in the app.
      await library.upsert({
        ...live,
        filePath: next,
        playlist: playlistFromPath(next, libraryDir, live.owner),
      });
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
  //    Hand-added files never take part: the app manages what it downloaded,
  //    but it must never delete a file the user put there themselves.
  for (const group of findDuplicates(
    library.all().filter((t) => t.source !== "local"),
  )) {
    const sorted = [...group.tracks].sort((a, b) =>
      a.addedAt.localeCompare(b.addedAt),
    );
    const keptPath = sorted[0]!.filePath;
    for (const dup of sorted.slice(1)) {
      // Don't delete a file the kept copy also points to. Windows paths are
      // case-insensitive, so two case-variant strings can name that one file;
      // string equality alone would delete the song both entries share.
      const sameAsKept =
        process.platform === "win32"
          ? dup.filePath.toLowerCase() === keptPath.toLowerCase()
          : dup.filePath === keptPath;
      if (dup.filePath && !sameAsKept) {
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

  // 3) Adopt hand-added audio: any file in the library folder that no entry
  //    claims becomes a "local" track, titled from its filename and grouped by
  //    its folder, so music imported outside the downloader still renders.
  if (libraryDir && byBasename) {
    // A download that lands on a path an adopted track already holds (e.g. the
    // song was imported by hand first) wins: the richer entry keeps the file
    // and the local shadow goes, so the two never coexist.
    const downloadPaths = new Set(
      library
        .all()
        .filter((t) => t.source !== "local")
        .map((t) => t.filePath),
    );
    for (const t of library.all()) {
      if (t.source === "local" && downloadPaths.has(t.filePath)) {
        await library.remove(t.id);
      }
    }

    const claimed = new Set(library.all().map((t) => t.filePath));
    const adoptions: Track[] = [];
    for (const paths of byBasename.values()) {
      for (const p of paths) {
        if (claimed.has(p)) continue;
        // The stat doubles as the existence check: the walk predates this
        // run's prune/dedupe deletions, so a listed file may be gone by now.
        let stat;
        try {
          stat = await fs.stat(p);
        } catch {
          continue;
        }
        const rel = path.relative(libraryDir, p);
        // Ids are path-derived; if a moved track still holds this id (a new
        // file appeared at its old spot), salt with the size so the adoption
        // never overwrites the survivor's entry.
        let id = libId("local", rel);
        if (library.get(id)) id = libId("local", `${rel}#${stat.size}`);
        adoptions.push({
          id,
          source: "local",
          sourceTrackId: rel,
          ...titleFromFilename(path.basename(p)),
          filePath: p,
          fileSize: stat.size,
          playlist: playlistFromPath(p, libraryDir),
          addedAt: stat.mtime.toISOString(),
        });
        existsCache?.set(p, true);
      }
    }
    if (adoptions.length > 0) {
      await library.upsertMany(adoptions);
      adopted = adoptions.length;
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

  return { prunedMissing, mergedDuplicates, deletedFiles, relinked, adopted };
}
