import { Box, Text } from "ink";
import { LOGO_LINES } from "../logo";
import { ACCENT_RAMP, lerpHex } from "../theme";

// Top row catches the light, bottom row falls into shadow: a deep-ember emboss
// swept left→right across the wordmark. The top row runs the shared accent
// ramp (sunlit amber → brand flame) so the logo and the progress fills glow
// with the same material.
const GRADIENT: readonly [string, string][] = [
  [ACCENT_RAMP[1], ACCENT_RAMP[0]], // top: sunlit amber → brand flame
  ["#e0501f", "#9e3608"], // bottom: deep ember → char shadow
];

/** The block wordmark, shaded with a per-character deep-ember gradient. */
export function Logo() {
  return (
    <Box flexDirection="column">
      {LOGO_LINES.map((line, row) => {
        const [from, to] = GRADIENT[Math.min(row, GRADIENT.length - 1)]!;
        const chars = [...line];
        const last = Math.max(1, chars.length - 1);
        return (
          <Box key={row}>
            {chars.map((ch, i) => (
              <Text key={i} bold color={lerpHex(from, to, i / last)}>
                {ch}
              </Text>
            ))}
          </Box>
        );
      })}
    </Box>
  );
}
