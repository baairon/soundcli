import { promises as fs } from "node:fs";
import path from "node:path";
import { libraryIndexFile } from "../config/paths";
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
    return Object.values(this.index.tracks).sort((a, b) =>
      b.addedAt.localeCompare(a.addedAt),
    );
  }

  get(id: string): Track | undefined {
    return this.index.tracks[id];
  }

  has(id: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.index.tracks, id);
  }

  search(query: string): Track[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.all();
    return this.all().filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        (t.artist?.toLowerCase().includes(q) ?? false) ||
        (t.album?.toLowerCase().includes(q) ?? false) ||
        (t.playlist?.toLowerCase().includes(q) ?? false),
    );
  }

  async upsert(track: Track): Promise<void> {
    this.index.tracks[track.id] = track;
    this.notify();
    await this.persist();
  }

  /** Apply many track updates with a single notify + persist. */
  async upsertMany(tracks: Track[]): Promise<void> {
    if (tracks.length === 0) return;
    for (const track of tracks) this.index.tracks[track.id] = track;
    this.notify();
    await this.persist();
  }

  async remove(id: string): Promise<void> {
    delete this.index.tracks[id];
    this.notify();
    await this.persist();
  }

  async clear(): Promise<void> {
    this.index.tracks = {};
    this.notify();
    await this.persist();
  }

  private persist(): Promise<void> {
    this.chain = this.chain.then(async () => {
      await fs.mkdir(path.dirname(libraryIndexFile), { recursive: true });
      const tmp = `${libraryIndexFile}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(this.index, null, 2), "utf8");
      await fs.rename(tmp, libraryIndexFile);
    });
    return this.chain;
  }
}
