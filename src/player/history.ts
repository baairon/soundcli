import { promises as fs } from "node:fs";
import path from "node:path";
import { historyFile } from "../config/paths";

interface HistoryEntry {
  /** Library track id, e.g. "youtube:dQw4w9WgXcQ". */
  id: string;
  /** ISO timestamp of when it last started playing. */
  at: string;
}

interface HistoryIndex {
  version: 1;
  entries: HistoryEntry[];
}

/** Replays move a track back to the top instead of stacking duplicates. */
const CAP = 500;

/**
 * Recently played tracks, newest first, backed by a JSON file. Same shape as
 * the Library store: serialized atomic writes, a version counter, and change
 * listeners for the UI.
 */
export class PlayHistory {
  private index: HistoryIndex;
  private chain: Promise<void> = Promise.resolve();
  private version = 0;
  private listeners = new Set<() => void>();

  private constructor(index: HistoryIndex) {
    this.index = index;
  }

  /** An empty in-memory history that is not backed by the user's data file. */
  static empty(): PlayHistory {
    return new PlayHistory({ version: 1, entries: [] });
  }

  static async load(): Promise<PlayHistory> {
    try {
      const raw = await fs.readFile(historyFile, "utf8");
      const parsed = JSON.parse(raw) as HistoryIndex;
      if (parsed && parsed.version === 1 && Array.isArray(parsed.entries)) {
        return new PlayHistory(parsed);
      }
    } catch {
      // missing or invalid: start fresh
    }
    return new PlayHistory({ version: 1, entries: [] });
  }

  /** A monotonically increasing counter bumped on every change. */
  getVersion(): number {
    return this.version;
  }

  /** Subscribe to history changes. Returns an unsubscribe fn. */
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

  /** Track ids, newest first. */
  ids(): string[] {
    return this.index.entries.map((e) => e.id);
  }

  /** Record a play: the track moves to (or enters at) the top of the list. */
  record(id: string): void {
    this.index.entries = [
      { id, at: new Date().toISOString() },
      ...this.index.entries.filter((e) => e.id !== id),
    ].slice(0, CAP);
    this.notify();
    void this.persist();
  }

  /** Drop entries for tracks that no longer exist (wipe, prune). */
  retain(existing: (id: string) => boolean): void {
    const kept = this.index.entries.filter((e) => existing(e.id));
    if (kept.length === this.index.entries.length) return;
    this.index.entries = kept;
    this.notify();
    void this.persist();
  }

  private persist(): Promise<void> {
    this.chain = this.chain.then(async () => {
      await fs.mkdir(path.dirname(historyFile), { recursive: true });
      const tmp = `${historyFile}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(this.index, null, 2), "utf8");
      await fs.rename(tmp, historyFile);
    });
    return this.chain;
  }
}
