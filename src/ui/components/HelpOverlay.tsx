import { Box, Text } from "ink";
import { HELP_GROUPS } from "../keymap";
import { useStore } from "../store";
import { COLOR, RULE, lerpHex } from "../theme";

/** The card border: divider gray warmed toward the accent, so the cheatsheet
 *  reads as part of the brand without shouting over its contents. */
const CARD_BORDER = lerpHex(COLOR.accent, RULE, 0.55);

// Column geometry derives from the hints themselves, so no key or label ever
// wraps: each key cell fits its group's longest chord, each column its
// longest label. Touching keymap.ts re-sizes the card automatically.
const KEY_GAP = 2;
const COL_GAP = 2;
const KEY_W = HELP_GROUPS.map(
  (g) => Math.max(...g.hints.map((h) => h.keys.length)) + KEY_GAP,
);
const COL_W = HELP_GROUPS.map(
  (g, i) => KEY_W[i]! + Math.max(...g.hints.map((h) => h.label.length)),
);
/** Width of the side-by-side card: columns + gaps + padding (2) + border (2). */
const CARD_W =
  COL_W.reduce((a, b) => a + b, 0) + (HELP_GROUPS.length - 1) * COL_GAP + 4;
/** Stacked mode shares one key cell so the groups align down the page. */
const KEY_W_STACKED = Math.max(...KEY_W);

/**
 * The full keyboard cheatsheet, shown only when the user presses `?`. Rendered
 * as a self-contained card: three columns on a roomy terminal, stacked when
 * narrow so nothing ever overlaps.
 */
export function HelpOverlay() {
  const { cols } = useStore();
  const columns = cols >= CARD_W;

  return (
    <Box
      flexDirection="column"
      alignSelf="flex-start"
      borderStyle="round"
      borderColor={CARD_BORDER}
      paddingX={columns ? 1 : 2}
      paddingY={1}
    >
      <Text bold color={COLOR.accent}>
        Keyboard
      </Text>
      <Box marginTop={1} flexDirection={columns ? "row" : "column"}>
        {HELP_GROUPS.map((group, gi) => (
          <Box
            key={group.title}
            flexDirection="column"
            width={columns ? COL_W[gi] : undefined}
            marginRight={columns && gi < HELP_GROUPS.length - 1 ? COL_GAP : 0}
            marginTop={!columns && gi > 0 ? 1 : 0}
          >
            <Text bold>{group.title}</Text>
            {group.hints.map((h) => (
              <Box key={h.keys + h.label}>
                <Box
                  width={columns ? KEY_W[gi] : KEY_W_STACKED}
                  flexShrink={0}
                >
                  <Text color={COLOR.alt}>{h.keys}</Text>
                </Box>
                <Text dimColor>{h.label}</Text>
              </Box>
            ))}
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Press ? or esc to close</Text>
      </Box>
    </Box>
  );
}
