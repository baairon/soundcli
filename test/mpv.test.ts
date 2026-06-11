import { describe, it, expect } from "vitest";
import { MpvPlayer } from "../src/player/mpv";

describe("MpvPlayer idle-command gating", () => {
  // The crash was an mpv "error running command" reply to a seek/pause sent
  // while no file was loaded. With the `loaded` gate those commands must return
  // early, never spawning mpv (here a bogus path) and never rejecting.
  it("seek and pause are safe no-ops when nothing is loaded", async () => {
    const player = new MpvPlayer("/no/such/mpv/binary");
    await expect(player.seekRelative(5)).resolves.toBeUndefined();
    await expect(player.seekAbsolute(10)).resolves.toBeUndefined();
    await expect(player.togglePause()).resolves.toBeUndefined();
    player.quit();
  });
});
