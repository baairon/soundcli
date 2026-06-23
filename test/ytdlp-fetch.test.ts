import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detectSystemYtDlp,
  downloadYtDlp,
  resolveYtDlp,
  resolvedYtDlpPath,
  ytDlpPath,
} from "../src/bin/ytdlp-fetch";
import { USER_AGENT, type FetchImpl } from "../src/util/net";

describe("detectSystemYtDlp", () => {
  it("returns the path when found and runnable", async () => {
    const found = await detectSystemYtDlp(
      async () => "/usr/bin/yt-dlp",
      async () => true,
    );
    expect(found).toBe("/usr/bin/yt-dlp");
  });

  it("returns null when nothing is on PATH", async () => {
    expect(
      await detectSystemYtDlp(
        async () => null,
        async () => true,
      ),
    ).toBeNull();
  });

  it("returns null when found but it will not run", async () => {
    expect(
      await detectSystemYtDlp(
        async () => "/usr/bin/yt-dlp",
        async () => false,
      ),
    ).toBeNull();
  });
});

describe("resolveYtDlp", () => {
  it("uses the bundled binary untouched when present", async () => {
    let detected = false;
    let downloaded = false;
    const out = await resolveYtDlp(undefined, {
      dest: "/bundled/yt-dlp",
      exists: async () => true,
      detect: async () => {
        detected = true;
        return "/usr/bin/yt-dlp";
      },
      download: async () => {
        downloaded = true;
      },
    });
    expect(out).toBe("/bundled/yt-dlp");
    expect(detected).toBe(false);
    expect(downloaded).toBe(false);
  });

  it("downloads our own binary on first run and never detects when it works", async () => {
    let detected = false;
    let downloaded = false;
    const out = await resolveYtDlp(undefined, {
      dest: "/bundled/yt-dlp",
      exists: async () => false,
      detect: async () => {
        detected = true;
        return "/usr/bin/yt-dlp";
      },
      download: async () => {
        downloaded = true;
      },
    });
    expect(out).toBe("/bundled/yt-dlp");
    expect(downloaded).toBe(true);
    expect(detected).toBe(false);
  });

  it("falls back to a system binary only when the download is blocked", async () => {
    const msgs: string[] = [];
    const out = await resolveYtDlp((m) => msgs.push(m), {
      dest: "/bundled/yt-dlp",
      exists: async () => false,
      detect: async () => "/usr/bin/yt-dlp",
      download: async () => {
        throw new Error("403 Forbidden");
      },
    });
    expect(out).toBe("/usr/bin/yt-dlp");
    expect(msgs.some((m) => /system/i.test(m))).toBe(true);
  });

  it("surfaces the real download error when blocked and no system binary exists", async () => {
    await expect(
      resolveYtDlp(undefined, {
        dest: "/bundled/yt-dlp",
        exists: async () => false,
        detect: async () => null,
        download: async () => {
          throw new Error("403 Forbidden");
        },
      }),
    ).rejects.toThrow(/403/);
  });
});

describe("resolvedYtDlpPath", () => {
  it("defaults to the bundled path before any resolution", () => {
    expect(resolvedYtDlpPath()).toBe(ytDlpPath());
  });
});

describe("downloadYtDlp", () => {
  it("sends a User-Agent on the GitHub fetch", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "soundcli-yt-"));
    const dest = path.join(dir, "yt-dlp-ua");
    let seenUA: unknown;
    const impl: FetchImpl = async (_url, init) => {
      seenUA = (init?.headers as Record<string, string> | undefined)?.[
        "User-Agent"
      ];
      return new Response(new Uint8Array([1, 2, 3]));
    };
    try {
      await downloadYtDlp(dest, impl);
      expect(seenUA).toBe(USER_AGENT);
      const onDisk = await fs.readFile(dest);
      expect(onDisk.length).toBe(3);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
