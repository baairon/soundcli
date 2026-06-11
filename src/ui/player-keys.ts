// Global player shortcuts. Handled in App before section-specific keys so
// transport stays live during downloads, queue scrolling, etc.

import type { Playback } from "../player/playback";
import type { Track } from "../library/types";
import type { CaptureMode } from "./store";
import { shuffledOrder } from "../player/order";

/** True when mpv (or equivalent) can seek / pause the current file. */
export function playerCanControl(playback: Playback): boolean {
  return Boolean(playback.getState().canControl);
}

/**
 * Handle play/pause, seek, skip, volume, restart. Returns true when the key
 * was a player-transport binding (even if mpv is momentarily busy).
 * Seek: j / ← back 15s, l / → forward 15s (arrows are free everywhere
 * except text fields, which own captureMode "text").
 */
export function handlePlayerTransport(
  playback: Playback,
  input: string,
  key?: { leftArrow?: boolean; rightArrow?: boolean },
): boolean {
  if (input === " " || input === "k") {
    void playback.togglePause();
    return true;
  }
  if (input === "j" || key?.leftArrow) {
    void playback.seek(-15);
    return true;
  }
  if (input === "l" || key?.rightArrow) {
    void playback.seek(15);
    return true;
  }
  if (input === "n") {
    void playback.next();
    return true;
  }
  if (input === "p") {
    void playback.prev();
    return true;
  }
  if (input === "0") {
    void playback.restart();
    return true;
  }
  if (input === ",") {
    void playback.seek(-5);
    return true;
  }
  if (input === ".") {
    void playback.seek(5);
    return true;
  }
  if (input === "+" || input === "=") {
    void playback.changeVolume(5);
    return true;
  }
  if (input === "-" || input === "_") {
    void playback.changeVolume(-5);
    return true;
  }
  return false;
}

/** Repeat / shuffle and idle shuffle-start. Always safe to call. */
export function handlePlayerMode(
  playback: Playback,
  input: string,
  playTrack: (t: Track, list?: Track[]) => void,
  allTracks: Track[],
): boolean {
  if (input === "r") {
    playback.cycleRepeat();
    return true;
  }
  if (input === "s") {
    const st = playback.getState();
    if (st.track) {
      // A resumed session holds a single-track list; hand shuffle the whole
      // library to roam (audio untouched) before toggling it on.
      if (st.list.length <= 1 && allTracks.length > 1) {
        const at = allTracks.findIndex((t) => t.id === st.track!.id);
        if (at >= 0) playback.adoptList([...allTracks], at);
      }
      playback.toggleShuffle();
    } else if (allTracks.length > 0) {
      const shuffled = shuffledOrder(allTracks.length, -1).map((i) => allTracks[i]!);
      playTrack(shuffled[0]!, shuffled);
    }
    return true;
  }
  return false;
}

/** Space is owned by pickers; everything else here is player-only. */
export function shouldBlockPlayerSpace(captureMode: CaptureMode): boolean {
  return captureMode === "picker";
}
