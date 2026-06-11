import { Box, Text } from "ink";
import { COLOR } from "../theme";

interface HeaderProps {
  title: string;
  /** Dim text shown after the title, e.g. a count. */
  subtitle?: string;
  /** Accent the title when this pane currently owns the keyboard. */
  focused?: boolean;
}

/** A consistent section title used across every content pane. */
export function Header({ title, subtitle, focused }: HeaderProps) {
  return (
    <Box marginBottom={1}>
      <Text bold color={focused ? COLOR.accent : COLOR.text}>
        {title}
      </Text>
      {subtitle ? <Text dimColor>{`  ${subtitle}`}</Text> : null}
    </Box>
  );
}
