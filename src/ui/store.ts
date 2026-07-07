import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { Binaries } from "../bin/binaries";
import type { Config } from "../config/config";
import type { DownloadQueue, QueueItem } from "../download/queue";
import type { Library } from "../library/library";
import type { Track } from "../library/types";
import type { Playback, PlaybackState } from "../player/playback";
import type { PlayHistory } from "../player/history";

/** Sidebar sections. */
export type Section =
  | "library"
  | "playlists"
  | "history"
  | "download"
  | "settings";

/**
 * Which pane currently owns up/down/enter. "help" means the `?` cheatsheet is
 * up: the body stays mounted (hidden) but no section handler is active.
 */
export type Region = "sidebar" | "content" | "help";

/**
 * How much of the keyboard the focused widget claims. "text" = a TextField
 * owns everything (only ctrl-c gets through). "picker" = a list with its own
 * space/esc semantics owns those two keys, but the global player keys, tab,
 * and `?` stay live. "esc" = a drill-down view owns esc only (one level back)
 * while space and every other player key stay live. "none" = all global keys
 * are live.
 */
export type CaptureMode = "none" | "text" | "picker" | "esc";

/** Playlists section: browsing sets vs songs inside one set. */
export type PlaylistsDepth = "sets" | "songs";

export interface Store {
  config: Config;
  setConfig: (c: Config) => void;
  library: Library;
  binaries: Binaries;
  queue: DownloadQueue;
  playback: Playback;
  history: PlayHistory;

  section: Section;
  setSection: (s: Section) => void;
  region: Region;
  setRegion: (r: Region) => void;
  /** How much of the keyboard the focused widget claims (see CaptureMode). */
  captureMode: CaptureMode;
  setCaptureMode: (m: CaptureMode) => void;
  /** Playlists drill-down depth, so the footer can drop set-only keys. */
  playlistsDepth: PlaylistsDepth;
  setPlaylistsDepth: (d: PlaylistsDepth) => void;
  /** One-shot intent: open the Library search box on its next render (set by
   *  the global `/`); the consumer clears it. */
  pendingSearch: boolean;
  setPendingSearch: (b: boolean) => void;
  /** One-shot intent: a pasted or CLI-passed link/handle for the Download
   *  section to consume; the consumer clears it. */
  pendingAdd: string | null;
  setPendingAdd: (v: string | null) => void;
  /** Status line while mpv auto-installs in the background (null when idle). */
  mpvStatus: string | null;
  /** How many rows a scrolling list may use, so the layout fits the terminal. */
  listRows: number;
  /** Short-terminal mode: strip the wordmark + spacers so song rows win. */
  compact: boolean;
  /** How many columns the content pane has, for truncating long titles. */
  contentWidth: number;
  /** Full terminal width, for components that span it (now-playing bar). */
  cols: number;
  /** Full terminal height. */
  rows: number;

  /** Play a track, optionally within an ordered list for next/prev. */
  playTrack: (t: Track, list?: Track[]) => void;
}

export const StoreContext = createContext<Store | null>(null);

export function useStore(): Store {
  const s = useContext(StoreContext);
  if (!s) throw new Error("Store not available");
  return s;
}

/** Subscribe to the download queue, throttled, for re-rendering lists. */
export function useQueueItems(queue: DownloadQueue): QueueItem[] {
  const [items, setItems] = useState<QueueItem[]>(() => [...queue.getItems()]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onUpdate = (): void => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        setItems([...queue.getItems()]);
      }, 200);
    };
    queue.on("update", onUpdate);
    onUpdate();
    return () => {
      queue.off("update", onUpdate);
      if (timer) clearTimeout(timer);
    };
  }, [queue]);
  return items;
}

/** Subscribe to library changes (prune / merge), returning a version counter. */
export function useLibrary(library: Library): number {
  const [version, setVersion] = useState<number>(() => library.getVersion());
  useEffect(() => {
    const off = library.onChange(() => setVersion(library.getVersion()));
    setVersion(library.getVersion());
    return off;
  }, [library]);
  return version;
}

/** Subscribe to play-history changes, returning a version counter. */
export function useHistory(history: PlayHistory): number {
  const [version, setVersion] = useState<number>(() => history.getVersion());
  useEffect(() => {
    const off = history.onChange(() => setVersion(history.getVersion()));
    setVersion(history.getVersion());
    return off;
  }, [history]);
  return version;
}

/**
 * Subscribe to a single slice of playback state. Re-renders only when the
 * selected value changes (Object.is), so a 1 Hz position tick or a seek does
 * not wake list sections that only care about the playing track id.
 */
export function usePlaybackSelector<T>(
  playback: Playback,
  selector: (s: PlaybackState) => T,
): T {
  const selRef = useRef(selector);
  selRef.current = selector;
  const [value, setValue] = useState<T>(() => selector(playback.getState()));
  useEffect(() => {
    const on = (s: PlaybackState): void => {
      const next = selRef.current(s);
      setValue((prev) => (Object.is(prev, next) ? prev : next));
    };
    playback.on("state", on);
    on(playback.getState());
    return () => {
      playback.off("state", on);
    };
  }, [playback]);
  return value;
}

/**
 * Subscribe to the queue's completed-download count only. Progress ticks emit
 * "update" several times a second, but setState with an unchanged number
 * bails out, so subscribers re-render once per finished download, not per tick.
 */
export function useQueueDoneCount(queue: DownloadQueue): number {
  const [count, setCount] = useState<number>(() => queue.doneCount);
  useEffect(() => {
    const onUpdate = (): void => setCount(queue.doneCount);
    queue.on("update", onUpdate);
    onUpdate();
    return () => {
      queue.off("update", onUpdate);
    };
  }, [queue]);
  return count;
}

/** Subscribe to playback state (now-playing bar). */
export function usePlayback(playback: Playback): PlaybackState {
  const [state, setState] = useState<PlaybackState>(() => playback.getState());
  useEffect(() => {
    const on = (s: PlaybackState): void => setState(s);
    playback.on("state", on);
    setState(playback.getState());
    return () => {
      playback.off("state", on);
    };
  }, [playback]);
  return state;
}
