import { describe, it, expect } from "vitest";
import { isRateLimitError } from "../src/ytdlp/ytdlp";
import { isPermanentTrackError } from "../src/download/queue";

describe("isRateLimitError", () => {
  it("matches rate-limit / bot-gate messages", () => {
    expect(isRateLimitError("ERROR: HTTP Error 429: Too Many Requests")).toBe(true);
    expect(
      isRateLimitError("Sign in to confirm you're not a bot"),
    ).toBe(true);
    expect(isRateLimitError("This IP is temporarily blocked")).toBe(true);
  });

  it("ignores ordinary failures", () => {
    expect(isRateLimitError("ERROR: Video unavailable")).toBe(false);
    expect(isRateLimitError("Private video")).toBe(false);
  });

  it("skips an age-restricted video instead of stopping the queue", () => {
    // The regression this split exists for: "Sign in to confirm your age" used
    // to match the same "sign in to confirm" pattern as the bot gate, so one
    // age-gated song paused every other download in the playlist and blamed
    // throttling for it.
    const aged = [
      "ERROR: [youtube] Sign in to confirm your age",
      "ERROR: [youtube] Sign in to confirm your age. This video may be inappropriate for some users.",
    ];
    for (const msg of aged) {
      expect(isRateLimitError(msg)).toBe(false);
      // It still has to land somewhere: permanent means the track fails its own
      // row, burns no retries, and the queue carries on to the next song.
      expect(isPermanentTrackError(msg)).toBe(true);
    }
  });

  it("keeps the bot gate a queue-wide stop", () => {
    // The mirror image: a bot gate is about this machine, not this song, so
    // skipping it and marching on would fail every remaining track in turn.
    const bot = "ERROR: [youtube] Sign in to confirm you're not a bot";
    expect(isRateLimitError(bot)).toBe(true);
    expect(isPermanentTrackError(bot)).toBe(false);
  });
});
