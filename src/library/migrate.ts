import { promises as fs } from "node:fs";
import path from "node:path";
import type { Config } from "../config/config";
import type { Library } from "./library";
import { SOURCE_LABELS, libId } from "./types";
import { fileExists } from "./drift";
import { ownerFromHandle } from "../sources/handle";
import { sanitizeName } from "../ytdlp/args";

export interface MigrateResult {
  /** Entries re-keyed to the canonical owner-qualified id (incl. backfills). */
  backfilled: number;
  /** Files relocated into their handle-scoped folder. */
  moved: number;
}

/**
 * One-time, idempotent layout migration: tracks downloaded before collections
 * were handle-scoped get their owner backfilled from the configured handle,
 * and their files moved into <lib>/<Source>/<owner>/<Set>/. Runs at boot only
 * (before mpv exists, so no file is ever locked by playback) and converges by
 * path comparison: once everything is canonical, every pass is a no-op. A file
 * that can't move (locked, gone, destination taken) keeps its old path and is
 * simply retried next boot.
 */
export async function migrateOwnerLayout(
  library: Library,
  config: Config,
  existsCache?: Map<string, boolean>,
): Promise<MigrateResult> {
  let backfilled = 0;
  let moved = 0;

  for (const t of library.all()) {
    // Spotify collections are pasted links, not handles: never owner-scoped.
    if (t.source === "spotify") continue;

    let owner = t.owner;
    if (!owner) {
      const handle =
        t.source === "youtube" ? config.youtubeHandle : config.soundcloudHandle;
      // No handle to attribute the legacy track to, so leave it untouched.
      if (!handle) continue;
      owner = ownerFromHandle(handle);
    }
    // Canonical id: also re-keys entries saved before ids were owner-qualified.
    // Always upsert the new entry before removing the old one: a crash between
    // the two leaves a duplicate (reconcile collapses it next boot) instead of
    // dropping the track from the index with its file orphaned on disk.
    const newId = libId(t.source, t.sourceTrackId, owner);
    const idChanged = newId !== t.id;
    const backfillOnly = async (): Promise<void> => {
      if (idChanged) {
        await library.upsert({ ...t, id: newId, owner });
        await library.remove(t.id);
        backfilled++;
      }
    };

    // Only relocate files living inside the current music folder; anything
    // else (changed libraryDir, cross-drive leftovers) gets the owner stamp
    // but stays where it is.
    const rel = path.relative(config.libraryDir, t.filePath);
    const inside = rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);

    const canonical = path.join(
      config.libraryDir,
      SOURCE_LABELS[t.source],
      sanitizeName(owner),
      // "Singles" matches where %(playlist_title|Singles)s placed loose tracks.
      sanitizeName(t.playlist ?? "Singles"),
      path.basename(t.filePath),
    );

    if (!inside || canonical === t.filePath) {
      await backfillOnly();
      continue;
    }
    if (!(await fileExists(t.filePath, existsCache))) {
      // Dead entry; reconcile prunes it right after this runs.
      await backfillOnly();
      continue;
    }
    if (await fileExists(canonical, existsCache)) {
      // Never overwrite (fs.rename replaces existing files on Windows).
      await backfillOnly();
      continue;
    }

    try {
      await fs.mkdir(path.dirname(canonical), { recursive: true });
      await fs.rename(t.filePath, canonical);
      existsCache?.set(t.filePath, false);
      existsCache?.set(canonical, true);
      await library.upsert({ ...t, id: newId, owner, filePath: canonical });
      if (idChanged) {
        await library.remove(t.id);
        backfilled++;
      }
      moved++;
      // Best-effort tidy-up: a non-recursive rmdir only removes the old set
      // folder if this was its last file.
      await fs.rmdir(path.dirname(t.filePath)).catch(() => {});
    } catch {
      await backfillOnly();
    }
  }

  return { backfilled, moved };
}
