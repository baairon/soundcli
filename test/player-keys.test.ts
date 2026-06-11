import { describe, it, expect } from "vitest";
import {
  handlePlayerMode,
  handlePlayerTransport,
  playerCanControl,
  shouldBlockPlayerSpace,
} from "../src/ui/player-keys";
import { Playback } from "../src/player/playback";
import type { Track } from "../src/library/types";

function track(id: string): Track {
  return {
    id,
    source: "youtube",
    sourceTrackId: id,
    title: id,
    filePath: `/tmp/${id}.mp3`,
    addedAt: new Date().toISOString(),
  };
}

describe("player-keys", () => {
  it("blocks space in picker mode", () => {
    expect(shouldBlockPlayerSpace("picker")).toBe(true);
    expect(shouldBlockPlayerSpace("none")).toBe(false);
  });

  it("reports canControl only for mpv with a loaded track", async () => {
    const ext = new Playback(null, () => {});
    await ext.play(track("a"));
    expect(playerCanControl(ext)).toBe(false);

    const mpv = new Playback("mpv", () => {});
    expect(playerCanControl(mpv)).toBe(true);
  });

  it("handlePlayerTransport recognizes transport bindings", () => {
    const p = new Playback("mpv", () => {});
    expect(handlePlayerTransport(p, "n")).toBe(true);
    // j/l scrub and k pauses alongside space; ←/→ scrub too.
    expect(handlePlayerTransport(p, "j")).toBe(true);
    expect(handlePlayerTransport(p, "l")).toBe(true);
    expect(handlePlayerTransport(p, "", { leftArrow: true })).toBe(true);
    expect(handlePlayerTransport(p, "", { rightArrow: true })).toBe(true);
    expect(handlePlayerTransport(p, "k")).toBe(true);
    expect(handlePlayerTransport(p, " ")).toBe(true);
    expect(handlePlayerTransport(p, "q")).toBe(false);
  });

  it("handlePlayerMode toggles repeat and starts shuffle from library", () => {
    const p = new Playback(null, () => {});
    const played: Track[] = [];
    expect(handlePlayerMode(p, "r", () => {}, [])).toBe(true);
    expect(p.getState().repeat).toBe("all");
    expect(
      handlePlayerMode(p, "s", (t) => played.push(t), [track("a"), track("b")]),
    ).toBe(true);
    expect(played).toHaveLength(1);
  });
});
