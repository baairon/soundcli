import { describe, it, expect } from "vitest";
import {
  fetchLatestVersion,
  isNewerVersion,
  parseLatestFromLocation,
  shouldCheck,
  UPDATE_CHECK_INTERVAL_MS,
} from "../src/bin/ytdlp-update";
import { downloadVerified } from "../src/bin/ytdlp-fetch";
import type { FetchImpl } from "../src/util/net";

describe("isNewerVersion", () => {
  it("compares date-style versions numerically", () => {
    expect(isNewerVersion("2026.06.09", "2026.03.17")).toBe(true);
    expect(isNewerVersion("2026.03.17", "2026.03.17")).toBe(false);
    expect(isNewerVersion("2026.03.17", "2026.06.09")).toBe(false);
  });

  it("treats a longer nightly tag as newer than its base release", () => {
    expect(isNewerVersion("2026.06.09.123456", "2026.06.09")).toBe(true);
  });

  it("ignores leading zeros (no false update loops)", () => {
    expect(isNewerVersion("2026.6.9", "2026.06.09")).toBe(false);
  });

  it("treats an unreadable local binary as out of date (self-heal)", () => {
    expect(isNewerVersion("2026.06.09", null)).toBe(true);
    expect(isNewerVersion("2026.06.09", "not-a-version")).toBe(true);
  });

  it("never updates toward a garbage latest tag", () => {
    expect(isNewerVersion("definitely-not-a-tag", "2026.03.17")).toBe(false);
  });
});

describe("parseLatestFromLocation", () => {
  it("extracts the version from the releases/tag redirect", () => {
    expect(
      parseLatestFromLocation(
        "https://github.com/yt-dlp/yt-dlp/releases/tag/2026.06.09",
      ),
    ).toBe("2026.06.09");
    expect(
      parseLatestFromLocation(
        "https://github.com/yt-dlp/yt-dlp/releases/tag/2026.06.09/",
      ),
    ).toBe("2026.06.09");
  });

  it("returns null when there is no tag to read", () => {
    expect(parseLatestFromLocation(null)).toBe(null);
    expect(
      parseLatestFromLocation("https://github.com/yt-dlp/yt-dlp/releases"),
    ).toBe(null);
  });
});

describe("shouldCheck", () => {
  const now = Date.now();

  it("checks when the stamp is missing or malformed", () => {
    expect(shouldCheck(null, now)).toBe(true);
    expect(
      shouldCheck(
        { checkedAt: "yesterday" as unknown as number },
        now,
      ),
    ).toBe(true);
  });

  it("respects the daily interval", () => {
    expect(
      shouldCheck({ checkedAt: now - UPDATE_CHECK_INTERVAL_MS - 1 }, now),
    ).toBe(true);
    expect(shouldCheck({ checkedAt: now - 60_000 }, now)).toBe(false);
  });

  it("treats a future-dated stamp as needing a check", () => {
    expect(shouldCheck({ checkedAt: now + 60_000 }, now)).toBe(true);
  });
});

describe("fetchLatestVersion", () => {
  it("reads the version off a manual-redirect response", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const impl: FetchImpl = async (url, init) => {
      calls.push({ url, init });
      return {
        headers: new Headers({
          location: "https://github.com/yt-dlp/yt-dlp/releases/tag/2026.06.09",
        }),
      } as unknown as Response;
    };
    await expect(fetchLatestVersion(impl)).resolves.toBe("2026.06.09");
    // The redirect must NOT be followed: the Location header is the answer.
    expect(calls[0]!.init?.redirect).toBe("manual");
  });

  it("returns null on a network failure or a missing Location", async () => {
    const offline: FetchImpl = async () => {
      throw new Error("getaddrinfo ENOTFOUND github.com");
    };
    await expect(fetchLatestVersion(offline)).resolves.toBe(null);

    const noLocation: FetchImpl = async () =>
      ({ headers: new Headers() }) as unknown as Response;
    await expect(fetchLatestVersion(noLocation)).resolves.toBe(null);
  });
});

// The fresh-download self-heal: a downloaded binary that can't print
// --version is torn or antivirus-mangled, so it gets one delete-and-retry
// before the friendly give-up.
describe("downloadVerified", () => {
  it("downloads once when the probe passes", async () => {
    const calls: string[] = [];
    await downloadVerified(
      "/tmp/yt-dlp",
      async () => void calls.push("download"),
      async () => {
        calls.push("probe");
        return true;
      },
      async () => void calls.push("remove"),
    );
    expect(calls).toEqual(["download", "probe"]);
  });

  it("deletes and re-downloads once when the first probe fails", async () => {
    let probes = 0;
    const calls: string[] = [];
    await downloadVerified(
      "/tmp/yt-dlp",
      async () => void calls.push("download"),
      async () => {
        calls.push("probe");
        return ++probes >= 2;
      },
      async () => void calls.push("remove"),
    );
    expect(calls).toEqual(["download", "probe", "remove", "download", "probe"]);
  });

  it("throws plainly (and leaves no torn exe) when the retry also fails", async () => {
    const calls: string[] = [];
    await expect(
      downloadVerified(
        "/tmp/yt-dlp",
        async () => void calls.push("download"),
        async () => {
          calls.push("probe");
          return false;
        },
        async () => void calls.push("remove"),
      ),
    ).rejects.toThrow(/antivirus/);
    expect(calls).toEqual([
      "download",
      "probe",
      "remove",
      "download",
      "probe",
      "remove",
    ]);
  });
});
