import { Box, Text } from "ink";
import { COLOR } from "../theme";
import type { Hint } from "../keymap";

/**
 * The quiet hint line. Keys take the secondary accent (the same "this is a
 * key you can press" brass as the help overlay and inline command rows) and
 * labels are dimmed. Deliberately short, the `?` overlay carries the rest.
 */
export function Footer({ hints }: { hints: Hint[] }) {
  return (
    <Box>
      <Text>
        {hints.map((h, i) => (
          <Text key={h.keys + h.label}>
            {i > 0 ? <Text dimColor>{"   "}</Text> : null}
            <Text color={COLOR.alt}>{h.keys}</Text>
            <Text dimColor>{` ${h.label}`}</Text>
          </Text>
        ))}
      </Text>
    </Box>
  );
}
