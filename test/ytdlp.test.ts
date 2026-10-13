import { describe, it, expect, vi, afterEach } from "vitest";

// The process call is the one thing enumerate reaches outside itself.
const execaMock = vi.fn();
vi.mock("execa", () => ({ execa: (...a: unknown[]) => execaMock(...a) }));

import { enumerate, isRateLimitError } from "../src/ytdlp/ytdlp";
import { isPermanentTrackError } from "../src/download/queue";

describe("isRateLimitError", () => {
  it("matches rate-limit / bot-gate messages", () => {
    expect(isRateLimitError("ERROR: HTTP Error 429: Too Many Requests")).toBe(true);
    expect(
      isRateLimitError("Sign in to confirm you're not a bot"),
    ).toBe(true);
    expect(isRateLimitError("This IP is temporarily blocked")).toBe(true);
    // YouTube's soft limit, worded like a dead track: it must still park the
    // queue rather than fail the batch row by row.
    expect(
      isRateLimitError(
        "ERROR: [youtube] abc: Video unavailable. This content isn't available, try again later.",
      ),
    ).toBe(true);
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

describe("enumerate", () => {
  const LIKES = "https://soundcloud.com/lumen/likes";
  const failing = (stderr: string): Error =>
    Object.assign(new Error("exit 1"), { stderr });

  afterEach(() => {
    execaMock.mockReset();
    delete process.env.SOUNDCLI_RETRY_BASE_MS;
  });

  it("tries a listing again when the site hiccups", async () => {
    process.env.SOUNDCLI_RETRY_BASE_MS = "0";
    const blip =
      "ERROR: 900000001: Unable to download JSON metadata: HTTP Error 500: Internal Server Error";
    const page = { entries: [{ id: "1", title: "Velvet Signal" }] };
    execaMock
      .mockRejectedValueOnce(failing(blip))
      .mockResolvedValueOnce({ stdout: JSON.stringify(page) });
    expect((await enumerate(LIKES)).entries).toHaveLength(1);
    expect(execaMock).toHaveBeenCalledTimes(2);
  });

  it("stops after three tries, and at once on an answer that will not change", async () => {
    process.env.SOUNDCLI_RETRY_BASE_MS = "0";
    execaMock.mockRejectedValue(failing("ERROR: HTTP Error 502: Bad Gateway"));
    await expect(enumerate(LIKES)).rejects.toThrow("502");
    expect(execaMock).toHaveBeenCalledTimes(3);

    execaMock.mockReset();
    execaMock.mockRejectedValue(failing("ERROR: HTTP Error 404: Not Found"));
    await expect(enumerate(LIKES)).rejects.toThrow("404");
    expect(execaMock).toHaveBeenCalledTimes(1);
  });
});

describe("enumerate, on a fully resolved song", () => {
  afterEach(() => {
    execaMock.mockReset();
  });

  it("keeps the song's page, not the stream yt-dlp picked for it", async () => {
    // A single item comes back resolved: `url` is the chosen format's signed
    // stream and the page is `webpage_url`. Downloading the stream saves a
    // song named after a CDN file, with no artist and the wrong id.
    execaMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        id: "240962018",
        title: "Low Tide",
        uploader: "Vesper",
        url: "https://cf-media.example/x0EI1oiZG8LK.128.mp3?Policy=abc",
        webpage_url: "https://soundcloud.com/vesper/low-tide",
      }),
    });
    const col = await enumerate("https://soundcloud.com/vesper/low-tide", {
      flat: false,
    });
    expect(col.entries[0]!.url).toBe("https://soundcloud.com/vesper/low-tide");
  });

  it("keeps a listed entry's own link", async () => {
    execaMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        id: "set1",
        title: "Night Drive",
        entries: [{ id: "1", url: "https://soundcloud.com/vesper/low-tide" }],
      }),
    });
    const col = await enumerate("https://soundcloud.com/vesper/sets/night-drive");
    expect(col.entries[0]!.url).toBe("https://soundcloud.com/vesper/low-tide");
  });
});
