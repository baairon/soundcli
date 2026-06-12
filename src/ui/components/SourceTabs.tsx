import { Box, Text } from "ink";
import { SOURCE_LABELS, type SourceId } from "../../library/types";
import { COLOR } from "../theme";

export type SourceFilter = "all" | SourceId;

interface SourceTabsProps {
  tabs: SourceFilter[];
  active: SourceFilter;
  count: (tab: SourceFilter) => number;
}

/** Source filter bar shared by Library and Playlists (All · YouTube · …). */
export function SourceTabs({ tabs, active, count }: SourceTabsProps) {
  return (
    <Box flexShrink={0}>
      {tabs.map((tb, i) => {
        const here = tb === active;
        return (
          <Box key={tb}>
            {i > 0 ? <Text>{"   "}</Text> : null}
            <Text
              color={here ? COLOR.accent : undefined}
              dimColor={!here}
              bold={here}
            >
              {tb === "all" ? "All" : SOURCE_LABELS[tb]}
            </Text>
            <Text dimColor>{` ${count(tb)}`}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
