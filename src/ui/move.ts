/**
 * Step a list cursor with wrap-around: moving up from the first row lands on
 * the last, moving down from the last lands on the first. Used by every
 * keyboard-driven list so no list ever has a hard stop at its edges.
 */
export function wrapStep(current: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return (((current + delta) % length) + length) % length;
}
