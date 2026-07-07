import { Box, Text } from "ink";
import { useStore, usePlayback } from "../store";
import { mpvInstallHint } from "../../player/playback";
import { cleanText, formatDuration, truncate } from "../../util/format";
import { GradientBar } from "./GradientBar";
import { COLOR, ICON } from "../theme";

/** Bar width that breathes with the terminal, leaving room for the readout. */
function barWidth(cols: number): number {
  if (cols >= 100) return 18;
  if (cols >= 80) return 14;
  return 10;
}

export function NowPlayingBar() {
  const { playback, cols, mpvStatus } = useStore();
  const st = usePlayback(playback);

  if (!st.track) {
    // Be honest about player readiness instead of inviting a ↵ that appears
    // to do nothing: first runs install mpv in the background.
    if (!st.mpvAvailable && mpvStatus) {
      return (
        <Text dimColor>
          {ICON.pending} Setting up the player… {ICON.dot} downloads still work
        </Text>
      );
    }
    if (!st.mpvAvailable) {
      return (
        <Text dimColor>
          {ICON.warn} Player not ready {ICON.dot} {mpvInstallHint()} {ICON.dot}{" "}
          songs open in your default app
        </Text>
      );
    }
    return <Text dimColor>{ICON.play} Nothing playing</Text>;
  }

  const t = st.track;
  // Hard caps on top of the flexbox truncation: a single absurd title must
  // never crowd the time/volume readout off the line.
  const title = truncate(cleanText(t.title), 56);
  const who = t.artist ? truncate(cleanText(t.artist), 28) : "";
  const setName = t.playlist ? truncate(cleanText(t.playlist), 24) : "";

  // Small badges that only show when they're actually on, so the bar stays calm.
  const badges: string[] = [];
  if (st.shuffle) badges.push(ICON.shuffle);
  if (st.repeat === "all") badges.push(ICON.repeat);
  else if (st.repeat === "one") badges.push(`${ICON.repeat}1`);

  const left = (
    <Box flexGrow={1} minWidth={0}>
      <Text wrap="truncate-end">
        <Text color={st.paused ? COLOR.good : COLOR.warn}>
          {st.paused ? ICON.play : ICON.pause}{" "}
        </Text>
        <Text bold color={COLOR.text}>
          {title}
        </Text>
        {who ? <Text dimColor>{` ${ICON.dot} ${who}`}</Text> : null}
        {setName ? <Text dimColor>{` ${ICON.dot} ${setName}`}</Text> : null}
      </Text>
    </Box>
  );

  // No mpv: we can't track position, so keep it honest and minimal.
  if (st.engine === "external") {
    return (
      <Box>
        {left}
        <Box marginLeft={2} flexShrink={0}>
          <Text dimColor>Playing in your default app</Text>
        </Box>
      </Box>
    );
  }

  if (st.loading) {
    return (
      <Box>
        {left}
        <Box marginLeft={2} flexShrink={0}>
          <Text dimColor>loading…</Text>
        </Box>
      </Box>
    );
  }

  // Quantize progress to whole bar cells before it reaches GradientBar: its
  // React.memo then skips the per-second ticks that land on the same cell.
  const width = barWidth(cols);
  const rawPct = st.duration > 0 ? (st.position / st.duration) * 100 : 0;
  const filled = Math.round((Math.max(0, Math.min(100, rawPct)) / 100) * width);
  const pct = (filled / width) * 100;
  const clock = `${formatDuration(st.position)} / ${formatDuration(st.duration)}`;

  return (
    <Box>
      {left}
      <Box marginLeft={2} flexShrink={0}>
        <Text>
          <GradientBar pct={pct} width={width} />
          <Text dimColor>{`  ${clock}  ${ICON.dot} ${st.volume}%`}</Text>
          {badges.length ? <Text dimColor>{`  ${badges.join(" ")}`}</Text> : null}
        </Text>
      </Box>
    </Box>
  );
}
