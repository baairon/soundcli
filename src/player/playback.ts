import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import type { Track } from "../library/types";
import { MpvPlayer } from "./mpv";
import { onEndedDecision, shuffledOrder, stepIndex } from "./order";
import { openPath } from "../util/open-path";

export type Engine = "mpv" | "external";
/**
 * Repeat: "all" loops the whole list when it reaches the end; "one" locks the
 * current track so it replays every time it ends.
 */
export type RepeatMode = "off" | "all" | "one";

export interface PlaybackState {
  track: Track | null;
  list: Track[];
  index: number;
  paused: boolean;
  position: number; // seconds (integer)
  duration: number; // seconds (integer)
  volume: number; // 0..100
  engine: Engine;
  mpvAvailable: boolean;
  repeat: RepeatMode;
  /** Whether the list is being played in a shuffled order. */
  shuffle?: boolean;
  /** True while a file is loading (mpv engine only). */
  loading?: boolean;
  /** True when transport controls actually work (engine === 'mpv'). */
  canControl?: boolean;
}

export type Opener = (file: string) => void;

function defaultOpener(file: string): void {
  openPath(file);
}

/** Clamp a volume into the valid 0..100 range as an integer. */
function clampVolume(v: number): number {
  if (Number.isNaN(v)) return 0;
  return Math.max(0, Math.min(100, Math.round(v)));
}

/** First package manager found wins; apt stays the fallback for everything else. */
const LINUX_PM_HINTS: ReadonlyArray<readonly [string, string]> = [
  ["/usr/bin/apt", "sudo apt install mpv"],
  ["/usr/bin/dnf", "sudo dnf install mpv"],
  ["/usr/bin/pacman", "sudo pacman -S mpv"],
  ["/usr/bin/zypper", "sudo zypper install mpv"],
];

/**
 * The linux hint names the distro's own package manager (we only ever print
 * it, sudo is the user's call to run). Injectable detection for tests.
 */
export function linuxMpvHint(
  exists: (p: string) => boolean = existsSync,
): string {
  for (const [bin, hint] of LINUX_PM_HINTS) {
    if (exists(bin)) return hint;
  }
  return "sudo apt install mpv";
}

let cachedLinuxHint: string | null = null;

/** Per-OS one-liner to install mpv for the rich in-app player. */
export function mpvInstallHint(): string {
  if (process.platform === "win32") return "winget install mpv";
  if (process.platform === "darwin") return "brew install mpv";
  // The existsSync sweep runs once per process; the answer can't change
  // underneath a running app in any way we care about.
  cachedLinuxHint ??= linuxMpvHint();
  return cachedLinuxHint;
}

/**
 * High-level playback controller. Prefers mpv (full transport controls via
 * IPC); falls back to opening the file in the OS default audio app.
 */
export class Playback extends EventEmitter {
  private mpvPath: string | null;
  private readonly opener: Opener;
  private mpv: MpvPlayer | null = null;
  private state: PlaybackState;
  /**
   * Play order: a permutation of list indices. Linear ([0,1,2,...]) normally,
   * a shuffled permutation while shuffle is on. next()/prev() walk this.
   */
  private order: number[] = [];
  /**
   * Indices actually played within the current list, oldest first. Shuffle's
   * prev() walks this instead of the order: it survives reshuffles and works
   * from the head of a cycle, where the order has no "before".
   */
  private backStack: number[] = [];
  /** True while prev() replays a popped entry, so it isn't pushed back. */
  private popping = false;

  constructor(mpvPath: string | null, opener: Opener = defaultOpener) {
    super();
    this.mpvPath = mpvPath;
    this.opener = opener;
    const engine: Engine = mpvPath ? "mpv" : "external";
    this.state = {
      track: null,
      list: [],
      index: -1,
      paused: false,
      position: 0,
      duration: 0,
      volume: 100,
      engine,
      mpvAvailable: Boolean(mpvPath),
      repeat: "off",
      shuffle: false,
      loading: false,
      canControl: engine === "mpv",
    };
  }

  getState(): PlaybackState {
    return this.state;
  }

  /** Enable mpv after construction (e.g. once it finishes auto-installing). */
  enableMpv(mpvPath: string): void {
    this.mpvPath = mpvPath;
    const engine: Engine = this.state.track ? this.state.engine : "mpv";
    this.update({
      mpvAvailable: true,
      engine,
      canControl: engine === "mpv",
    });
  }

  private update(patch: Partial<PlaybackState>): void {
    this.state = { ...this.state, ...patch };
    this.emit("state", this.state);
  }

  private ensureMpv(): MpvPlayer | null {
    if (!this.mpvPath) return null;
    if (this.mpv) return this.mpv;
    const m = new MpvPlayer(this.mpvPath);
    m.setInitialVolume(this.state.volume);
    m.on("property", (name: string, data: unknown) => {
      if (name === "time-pos" && typeof data === "number") {
        const pos = Math.floor(data);
        if (pos !== this.state.position) this.update({ position: pos });
      } else if (name === "duration" && typeof data === "number") {
        this.update({ duration: Math.floor(data) });
      } else if (name === "pause" && typeof data === "boolean") {
        this.update({ paused: data });
      } else if (name === "volume" && typeof data === "number") {
        const vol = clampVolume(data);
        if (vol !== this.state.volume) this.update({ volume: vol });
      }
    });
    m.on("ended", () => void this.onEnded());
    // If mpv dies unexpectedly mid-session, drop our handle so the next play()
    // spins up a fresh process (MpvPlayer also resets its own socket state).
    m.on("quit", () => {
      if (this.mpv === m) this.mpv = null;
    });
    this.mpv = m;
    return m;
  }

  /** Rebuild the play order to match the current list and shuffle setting. */
  private rebuildOrder(): void {
    const len = this.state.list.length;
    if (this.state.shuffle) {
      this.order = shuffledOrder(len, this.state.index);
    } else {
      this.order = Array.from({ length: len }, (_, i) => i);
    }
  }

  /** A track finished on its own: honor repeat/shuffle via the pure decision. */
  private async onEnded(): Promise<void> {
    const decision = onEndedDecision(
      this.order,
      this.state.index,
      this.state.repeat,
    );
    if (decision === "stop") {
      // Nothing left to play. Clear cleanly so the now-playing bar returns to
      // its idle "pick a song" state. Without this, mpv idles at EOF (it stays
      // up with --idle=yes), the bar freezes at 100%, and every transport key
      // silently no-ops because mpv reports the file as unloaded, which reads
      // as a softlock, especially with a single-song list.
      await this.stop();
      return;
    }
    await this.play(this.state.list[decision]!, this.state.list, decision);
  }

  /** Cycle repeat: off → all (loop the list) → one (lock current track) → off. */
  cycleRepeat(): void {
    const next: RepeatMode =
      this.state.repeat === "off"
        ? "all"
        : this.state.repeat === "all"
          ? "one"
          : "off";
    this.update({ repeat: next });
  }

  /**
   * Toggle shuffle. Turning it on reshuffles the list while keeping the current
   * track current; turning it off resumes linear order from the current track.
   * The underlying list is never mutated.
   */
  toggleShuffle(): void {
    const shuffle = !this.state.shuffle;
    this.update({ shuffle });
    this.rebuildOrder();
  }

  /**
   * Swap in a bigger list around the track that is already playing, without
   * touching the audio: only next/prev gain somewhere to go. Used when a
   * resumed single-track session turns shuffle on over the whole library.
   */
  adoptList(list: Track[], index: number): void {
    const cur = this.state.track;
    if (!cur || index < 0 || index >= list.length) return;
    if (list[index]!.id !== cur.id) return;
    this.backStack = [];
    this.update({ list, index });
    this.rebuildOrder();
  }

  async play(track: Track, list: Track[] = [track], index = -1, startPaused = false): Promise<void> {
    const idx = index >= 0 ? index : list.findIndex((t) => t.id === track.id);
    const safeIdx = idx < 0 ? 0 : idx;
    // A continuation of the same list (e.g. from next()/prev()) keeps the
    // existing order so an in-progress shuffle cycle is preserved; a new list
    // (or a stale order length) rebuilds it for the current shuffle setting.
    const newList = list !== this.state.list || this.order.length !== list.length;
    const fromIndex = this.state.index;
    if (newList) {
      this.backStack = [];
    } else if (!this.popping && fromIndex >= 0 && safeIdx !== fromIndex) {
      this.backStack.push(fromIndex);
      if (this.backStack.length > 500) this.backStack.shift();
    }
    this.update({
      track,
      list,
      index: safeIdx,
      position: 0,
      duration: track.durationSec ?? 0,
      paused: startPaused,
      loading: Boolean(this.mpvPath),
    });
    if (newList) this.rebuildOrder();

    const m = this.ensureMpv();
    if (m) {
      try {
        await m.loadFile(track.filePath, startPaused);
        this.update({
          engine: "mpv",
          canControl: true,
          loading: false,
          volume: clampVolume(await m.getVolume()),
        });
        return;
      } catch {
        // mpv failed to start or load: fall through to the external opener.
        // The failed instance may still own a live process, its IPC socket,
        // and our listeners; quit() tears all of that down (it is safe on an
        // already-dead process) so nothing lingers orphaned when the next
        // play() spawns a fresh mpv. Drop our handle first so the "quit"
        // event this fires finds it already cleared.
        if (this.mpv === m) this.mpv = null;
        m.quit();
      }
    }
    this.update({ engine: "external", canControl: false, loading: false });
    this.opener(track.filePath);
  }

  async togglePause(): Promise<void> {
    if (!this.mpv) return;
    const was = this.state.paused;
    this.update({ paused: !was });
    try {
      await this.mpv.togglePause();
    } catch {
      this.update({ paused: was });
    }
  }

  /** Relative seek by `seconds` (mpv engine only). */
  async seek(seconds: number): Promise<void> {
    if (!this.mpv) return;
    const prev = this.state.position;
    const dur = this.state.duration;
    let next = Math.max(0, prev + seconds);
    if (dur > 0) next = Math.min(next, dur);
    this.update({ position: next });
    try {
      await this.mpv.seekRelative(seconds);
    } catch {
      this.update({ position: prev });
    }
  }

  /** Jump back to the start of the current track. */
  async restart(): Promise<void> {
    const { track, list, index } = this.state;
    if (!track) return;
    try {
      if (this.mpv) {
        await this.mpv.seekAbsolute(0);
        this.update({ position: 0, paused: false });
        return;
      }
    } catch {
      // fall through to reload
    }
    if (list.length && index >= 0) {
      await this.play(track, list, index);
    }
  }

  /** Nudge the volume by `delta`, clamped to 0..100. */
  async changeVolume(delta: number): Promise<void> {
    await this.setVolume(this.state.volume + delta);
  }

  /** Set the absolute volume, clamped to 0..100. */
  async setVolume(v: number): Promise<void> {
    const vol = clampVolume(v);
    this.update({ volume: vol });
    this.mpv?.setInitialVolume(vol);
    if (this.mpv) {
      try {
        await this.mpv.setVolume(vol);
        this.update({ volume: clampVolume(await this.mpv.getVolume()) });
      } catch {
        // keep the optimistic value if mpv is momentarily unavailable
      }
    }
  }

  /**
   * Stop playback and clear the current track. The engine stays selectable so a
   * later play() resumes normally; for mpv this unloads the file too.
   */
  async stop(): Promise<void> {
    if (this.mpv) {
      try {
        await this.mpv.stop();
      } catch {
        // ignore, we still clear our own state below
      }
    }
    this.order = [];
    this.backStack = [];
    this.update({
      track: null,
      list: [],
      index: -1,
      position: 0,
      duration: 0,
      paused: false,
      loading: false,
    });
  }

  async next(): Promise<void> {
    if (!this.state.list.length) return;
    const ni = stepIndex(this.order, this.state.index, this.state.repeat, 1);
    if (ni === null) return; // end of the list
    await this.play(this.state.list[ni]!, this.state.list, ni);
  }

  async prev(): Promise<void> {
    if (!this.state.list.length) return;
    if (this.state.shuffle) {
      let back: number | undefined;
      while ((back = this.backStack.pop()) !== undefined) {
        if (
          back >= 0 &&
          back < this.state.list.length &&
          back !== this.state.index
        ) {
          break;
        }
      }
      if (back !== undefined) {
        this.popping = true;
        try {
          await this.play(this.state.list[back]!, this.state.list, back);
        } finally {
          this.popping = false;
        }
        return;
      }
      // Nothing heard before in this list; the order walk below still lets
      // repeat 'all' wrap to the end of the cycle.
    }
    const pi = stepIndex(this.order, this.state.index, this.state.repeat, -1);
    if (pi === null) return; // start of the list
    await this.play(this.state.list[pi]!, this.state.list, pi);
  }

  quit(): void {
    this.mpv?.quit();
    this.mpv = null;
  }
}
