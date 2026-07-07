import { promises as fs, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { libraryIndexFile } from "../config/paths";
import { fuzzyFilter } from "../util/fuzzy";
import type { LibraryIndex, Track } from "./types";

/**
 * In-memory library index backed by a JSON file. Writes are serialized and
 * atomic (tmp file + rename) so concurrent downloads can't corrupt the index.
 */
export class Library {
  private index: LibraryIndex;
  private chain: Promise<void> = Promise.resolve();
  private version = 0;
  private listeners = new Set<() => void>();
  /** Cached newest-first array; invalidated on every mutation. Callers treat
   *  the returned array as immutable, which also gives memo-friendly identity. */
  private sorted: Track[] | null = null;
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  private constructor(index: LibraryIndex) {
    this.index = index;
  }

  /** A monotonically increasing counter bumped on every change. */
  getVersion(): number {
    return this.version;
  }

  /** Subscribe to library changes (add/remove). Returns an unsubscribe fn. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private notify(): void {
    this.version++;
    this.sorted = null;
    for (const fn of this.listeners) fn();
  }

  /** An empty in-memory library that is not backed by the user's data file. */
  static empty(): Library {
    return new Library({ version: 1, tracks: {} });
  }

  static async load(): Promise<Library> {
    try {
      const raw = await fs.readFile(libraryIndexFile, "utf8");
      const parsed = JSON.parse(raw) as LibraryIndex;
      if (parsed && parsed.version === 1 && parsed.tracks) {
        return new Library(parsed);
      }
    } catch {
      // missing or invalid: start fresh
    }
    return new Library({ version: 1, tracks: {} });
  }

  all(): Track[] {
    if (!this.sorted) {
      this.sorted = Object.values(this.index.tracks).sort((a, b) =>
        b.addedAt.localeCompare(a.addedAt),
      );
    }
    return this.sorted;
  }

  get(id: string): Track | undefined {
    return this.index.tracks[id];
  }

  has(id: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.index.tracks, id);
  }

  search(query: string): Track[] {
    // Fuzzy: best match first; ties keep all()'s newest-first order.
    return fuzzyFilter(query, this.all(), (t) => [
      t.title,
      t.artist,
      t.album,
      t.playlist,
    ]);
  }

  async upsert(track: Track): Promise<void> {
    this.index.tracks[track.id] = track;
    this.notify();
    this.schedulePersist();
  }

  /** Apply many track updates with a single notify + persist. */
  async upsertMany(tracks: Track[]): Promise<void> {
    if (tracks.length === 0) return;
    for (const track of tracks) this.index.tracks[track.id] = track;
    this.notify();
    this.schedulePersist();
  }

  async remove(id: string): Promise<void> {
    delete this.index.tracks[id];
    this.notify();
    this.schedulePersist();
  }

  /** Remove many tracks with a single notify + persist. */
  async removeMany(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    for (const id of ids) delete this.index.tracks[id];
    this.notify();
    this.schedulePersist();
  }

  async clear(): Promise<void> {
    this.index.tracks = {};
    this.notify();
    this.schedulePersist();
  }

  /**
   * Coalesce bursts of mutations (download batches, playlist deletes) into one
   * whole-index write instead of one per track. A crash inside the window
   * loses only index entries, and reconcile re-links them from disk next boot.
   */
  private schedulePersist(): void {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (!this.dirty) return;
      this.dirty = false;
      void this.persist();
    }, 500);
    this.saveTimer.unref?.();
  }

  /** Write any pending index changes synchronously; called on app quit. */
  flushSync(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    try {
      mkdirSync(path.dirname(libraryIndexFile), { recursive: true });
      const tmp = `${libraryIndexFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.index), "utf8");
      renameSync(tmp, libraryIndexFile);
    } catch {
      // best effort on exit
    }
  }

  private persist(): Promise<void> {
    this.chain = this.chain.then(async () => {
      await fs.mkdir(path.dirname(libraryIndexFile), { recursive: true });
      const tmp = `${libraryIndexFile}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(this.index), "utf8");
      await fs.rename(tmp, libraryIndexFile);
    });
    return this.chain;
  }
}
