import type { RepeatMode } from "./playback";

/**
 * Pure playback-ordering helpers, factored out of Playback so the shuffle and
 * next/prev decisions can be unit-tested without spawning mpv.
 */

/**
 * Build a shuffled permutation of [0..length) using Fisher-Yates, pinned so that
 * `current` sits first. Pinning keeps the now-playing track current when shuffle
 * is toggled on, and guarantees every track plays exactly once per shuffle cycle.
 *
 * @param length number of tracks in the list
 * @param current index of the track that should stay current (its position in the
 *   returned order is 0); pass < 0 or out of range for a plain shuffle
 * @param rng random source in [0,1) (injectable for deterministic tests)
 */
export function shuffledOrder(
  length: number,
  current: number,
  rng: () => number = Math.random,
): number[] {
  const order = Array.from({ length }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = order[i]!;
    const b = order[j]!;
    order[i] = b;
    order[j] = a;
  }
  if (current >= 0 && current < length) {
    const at = order.indexOf(current);
    if (at > 0) {
      const head = order[0]!;
      order[0] = current;
      order[at] = head;
    }
  }
  return order;
}

/**
 * Resolve the next track index given the current play order.
 *
 * @param order the play order (linear [0,1,2,...] or a shuffled permutation)
 * @param index the list index currently playing
 * @param repeat repeat mode ('all' wraps around; otherwise stop at the end)
 * @param dir +1 for next, -1 for previous
 * @returns the next list index, or null when there is nowhere to go (end/start with repeat off)
 */
export function stepIndex(
  order: number[],
  index: number,
  repeat: RepeatMode,
  dir: 1 | -1,
): number | null {
  if (order.length === 0) return null;
  const pos = order.indexOf(index);
  // If the current index is not in the order (defensive), start from an edge.
  const cur = pos < 0 ? (dir === 1 ? -1 : order.length) : pos;
  let np = cur + dir;
  if (np >= order.length) {
    if (repeat === "all") np = 0;
    else return null;
  } else if (np < 0) {
    if (repeat === "all") np = order.length - 1;
    else return null;
  }
  return order[np]!;
}

/**
 * Decide what should happen when a track ends naturally: advance like next();
 * with repeat 'all' the list wraps, otherwise 'stop' at the end.
 *
 * @returns the next list index, or 'stop'
 */
export function onEndedDecision(
  order: number[],
  index: number,
  repeat: RepeatMode,
): "stop" | number {
  // Repeat-one locks the current track: replay the same index on a natural end.
  if (repeat === "one") return index;
  const ni = stepIndex(order, index, repeat, 1);
  return ni === null ? "stop" : ni;
}
