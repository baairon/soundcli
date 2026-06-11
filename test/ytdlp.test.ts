import { describe, it, expect } from "vitest";
import { isRateLimitError } from "../src/ytdlp/ytdlp";

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
});
