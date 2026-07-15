import { promises as fs } from "node:fs";
import path from "node:path";
import type { Track } from "./types";

export interface MoveProgress {
  movedFiles: number;
  totalFiles: number;
}

export interface MoveResult {
  movedFiles: number;
  totalFiles: number;
  /** Paths that could not be moved; they stay behind in the old folder. */
  failures: string[];
}

export interface MoveOptions {
  onProgress?: (p: MoveProgress) => void;
  /** Injectable so tests can force the cross-device (EXDEV) fallback. */
  rename?: (from: string, to: string) => Promise<void>;
}

// APFS defaults to case-insensitive like NTFS, but node's path.relative
// folds case only on win32, so darwin must fold here too. False-rejecting a
// rare case-sensitive mac volume is safer than letting a same-folder-in-
// another-case move recurse into its own destination.
const foldsCase =
  process.platform === "win32" || process.platform === "darwin";

function foldPath(p: string): string {
  return foldsCase ? p.toLowerCase() : p;
}

/** True when the two resolved paths name the same location. */
export function samePath(a: string, b: string): boolean {
  return path.relative(foldPath(a), foldPath(b)) === "";
}

/** True when `child` sits at or under `parent`. */
function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(foldPath(parent), foldPath(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Sanity-check a folder move before any disk work. Both paths must already be
 * resolved absolute. Returns a user-facing error line, or null when the pair
 * is safe to move between.
 */
export function validateMoveRoots(
  oldRoot: string,
  newRoot: string,
): string | null {
  if (samePath(oldRoot, newRoot)) {
    return "That's already the music folder";
  }
  if (isWithin(oldRoot, newRoot)) {
    return "The new folder can't be inside the current one";
  }
  if (isWithin(newRoot, oldRoot)) {
    return "The new folder can't contain the current one";
  }
  return null;
}

/** Count the files under `p` (a file counts as 1, dirs recurse). */
async function countFiles(p: string): Promise<number> {
  const stat = await fs.lstat(p);
  if (!stat.isDirectory()) return 1;
  const entries = await fs.readdir(p, { withFileTypes: true });
  let n = 0;
  for (const e of entries) n += await countFiles(path.join(p, e.name));
  return n;
}

/**
 * Move every entry of `oldRoot` into `newRoot`, then remove `oldRoot` if it
 * emptied. Each top-level entry first tries a plain rename (instant on the
 * same volume); any rename failure (EXDEV across drives, ENOTEMPTY/EPERM when
 * the target already exists) falls back to a per-file copy+delete so the move
 * still works across devices and merges into non-empty folders. Copies
 * overwrite, so re-running an interrupted move converges. Per-file errors are
 * collected in `failures` and never abort the rest of the move.
 */
export async function moveLibraryDir(
  oldRoot: string,
  newRoot: string,
  opts: MoveOptions = {},
): Promise<MoveResult> {
  const rename = opts.rename ?? ((from: string, to: string) => fs.rename(from, to));
  const result: MoveResult = { movedFiles: 0, totalFiles: 0, failures: [] };
  const tick = (): void =>
    opts.onProgress?.({
      movedFiles: result.movedFiles,
      totalFiles: result.totalFiles,
    });

  await fs.mkdir(newRoot, { recursive: true });
  let entries;
  try {
    entries = await fs.readdir(oldRoot, { withFileTypes: true });
  } catch {
    return result; // old folder never existed: nothing to move
  }

  // Count first so the progress label can show "Moving N/M" from tick one.
  const counts = new Map<string, number>();
  for (const e of entries) {
    const src = path.join(oldRoot, e.name);
    counts.set(e.name, await countFiles(src).catch(() => 0));
    result.totalFiles += counts.get(e.name)!;
  }
  tick();

  /** Copy+delete one file or dir, recursing; the slow but universal path. */
  async function moveTree(src: string, dst: string): Promise<void> {
    let stat;
    try {
      stat = await fs.lstat(src);
    } catch {
      result.failures.push(src);
      return;
    }
    if (stat.isSymbolicLink()) {
      // Recreate the link instead of copying through it (a dir target would
      // EISDIR, a file target would silently duplicate its bytes).
      try {
        const target = await fs.readlink(src);
        await fs.rm(dst, { force: true }).catch(() => {});
        await fs.symlink(target, dst);
      } catch {
        result.failures.push(src);
        return;
      }
      result.movedFiles++;
      tick();
      await fs.rm(src, { force: true }).catch(() => result.failures.push(src));
      return;
    }
    if (stat.isDirectory()) {
      // Snapshot the source BEFORE creating the destination: if the two ever
      // alias (case-insensitive volumes), the snapshot must not contain the
      // fresh destination or the recursion would never bottom out.
      const kids = await fs.readdir(src).catch(() => null);
      if (kids === null) {
        result.failures.push(src);
        return;
      }
      try {
        await fs.mkdir(dst, { recursive: true });
      } catch {
        result.failures.push(src);
        return;
      }
      for (const name of kids) {
        await moveTree(path.join(src, name), path.join(dst, name));
      }
      await fs.rmdir(src).catch(() => {}); // only removes if emptied
      return;
    }
    try {
      await fs.copyFile(src, dst);
    } catch {
      result.failures.push(src);
      return;
    }
    result.movedFiles++;
    tick();
    // The copy landed; a stuck source file is a leftover, not a lost move.
    await fs.rm(src, { force: true }).catch(() => result.failures.push(src));
  }

  for (const e of entries) {
    const src = path.join(oldRoot, e.name);
    const dst = path.join(newRoot, e.name);
    try {
      await rename(src, dst);
      result.movedFiles += counts.get(e.name) ?? 0;
      tick();
    } catch {
      await moveTree(src, dst);
    }
  }

  await fs.rmdir(oldRoot).catch(() => {}); // only removes if emptied
  return result;
}

/**
 * Re-point tracks that lived under `oldRoot` to `newRoot`, keeping the same
 * relative layout. A track is only retargeted when its file actually exists
 * at the new path: a file the move failed to carry keeps its still-valid old
 * path, so nothing gets pruned by the next scan. Returns changed tracks only.
 */
export async function retargetTracks(
  tracks: readonly Track[],
  oldRoot: string,
  newRoot: string,
): Promise<Track[]> {
  // Fold-aware prefix check ending at a separator boundary (displayPath's
  // idiom): path.relative would miss case-variant paths on darwin, and the
  // slice keeps the track's original casing for the rebuilt path.
  const root = oldRoot.replace(/[\\/]+$/, "");
  const foldedRoot = foldPath(root);
  const changed: Track[] = [];
  for (const t of tracks) {
    if (!foldPath(t.filePath).startsWith(foldedRoot)) continue;
    const boundary = t.filePath[root.length];
    if (boundary !== "/" && boundary !== "\\") continue;
    const rel = t.filePath.slice(root.length + 1);
    if (!rel) continue;
    const candidate = path.join(newRoot, rel);
    try {
      await fs.access(candidate);
    } catch {
      continue;
    }
    changed.push({ ...t, filePath: candidate });
  }
  return changed;
}
