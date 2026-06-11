import { Text } from "ink";
import { ACCENT_RAMP, lerpHex } from "../theme";

/**
 * A progress fill that sweeps the accent ramp left→right, so progress reads
 * as a warm glow instead of a flat block. Filled cells get a per-cell color
 * along the ramp; the remainder stays a dim track. Always renders exactly
 * `width` cells so surrounding layout never shifts as it fills.
 */
export function GradientBar({ pct, width }: { pct: number; width: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  const last = Math.max(1, width - 1);
  return (
    <Text>
      {Array.from({ length: filled }, (_, i) => (
        <Text key={i} color={lerpHex(ACCENT_RAMP[0], ACCENT_RAMP[1], i / last)}>
          █
        </Text>
      ))}
      <Text dimColor>{"░".repeat(Math.max(0, width - filled))}</Text>
    </Text>
  );
}
