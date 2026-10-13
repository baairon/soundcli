import { describe, it, expect } from "vitest";
import { listingError } from "../src/download/reason";

describe("listingError", () => {
  it("swaps yt-dlp's line for a calm one and leaves our own messages alone", () => {
    const blip =
      "900000001: Unable to download JSON metadata: HTTP Error 500: Internal Server Error (caused by <HTTPError 500: Internal Server Error>)";
    expect(listingError(blip, "SoundCloud")).toBe(
      "SoundCloud isn't answering right now. Try again in a moment.",
    );
    expect(listingError("HTTP Error 404: Not Found", "YouTube")).toBe(
      "Couldn't find that on YouTube. Check the link or handle.",
    );
    expect(listingError("That playlist is private (caused by X)", "Spotify")).toBe(
      "That playlist is private",
    );
  });
});
