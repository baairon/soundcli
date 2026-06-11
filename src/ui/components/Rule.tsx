import { Text } from "ink";
import { RULE } from "../theme";

/** A horizontal divider line in the muted rule gray. */
export function Rule({ width }: { width: number }) {
  return (
    <Text color={RULE}>
      {"─".repeat(Math.max(1, width))}
    </Text>
  );
}
