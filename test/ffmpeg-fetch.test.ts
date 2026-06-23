import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import {
  FFBIN_TAG,
  detectSystemFf,
  downloadFfTool,
  ffAssetName,
  ffDownloadUrl,
  ffmpegBinPath,
  ffprobeBinPath,
  needsFfFetch,
  resolveFfFetch,
  resolvedFfmpegPath,
  resolvedFfprobePath,
} from "../src/bin/ffmpeg-fetch";
import { USER_AGENT, type FetchImpl } from "../src/util/net";

describe("ffAssetName", () => {
  it("maps windows to the x64 asset on every arch (arm64 emulates it)", () => {
    expect(ffAssetName("ffmpeg", "win32", "x64")).toBe("ffmpeg-win32-x64");
    expect(ffAssetName("ffmpeg", "win32", "arm64")).toBe("ffmpeg-win32-x64");
    expect(ffAssetName("ffprobe", "win32", "ia32")).toBe("ffprobe-win32-x64");
  });

  it("maps darwin arm64 and x64", () => {
    expect(ffAssetName("ffmpeg", "darwin", "arm64")).toBe(
      "ffmpeg-darwin-arm64",
    );
    expect(ffAssetName("ffprobe", "darwin", "x64")).toBe("ffprobe-darwin-x64");
  });

  it("maps the linux arch spread with x64 as the fallback", () => {
    expect(ffAssetName("ffmpeg", "linux", "arm64")).toBe("ffmpeg-linux-arm64");
    expect(ffAssetName("ffmpeg", "linux", "arm")).toBe("ffmpeg-linux-arm");
    expect(ffAssetName("ffmpeg", "linux", "ia32")).toBe("ffmpeg-linux-ia32");
    expect(ffAssetName("ffmpeg", "linux", "x64")).toBe("ffmpeg-linux-x64");
    expect(ffAssetName("ffprobe", "linux", "riscv64")).toBe(
      "ffprobe-linux-x64",
    );
  });
});

describe("ffDownloadUrl", () => {
  it("points at the pinned tag's gzipped asset", () => {
    expect(ffDownloadUrl("ffmpeg", "win32", "x64")).toBe(
      `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFBIN_TAG}/ffmpeg-win32-x64.gz`,
    );
    expect(ffDownloadUrl("ffprobe", "darwin", "arm64")).toBe(
      `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFBIN_TAG}/ffprobe-darwin-arm64.gz`,
    );
  });
});

describe("needsFfFetch", () => {
  it("a missing binary refetches both", () => {
    expect(needsFfFetch(false, true, FFBIN_TAG)).toBe(true);
    expect(needsFfFetch(true, false, FFBIN_TAG)).toBe(true);
    expect(needsFfFetch(false, false, FFBIN_TAG)).toBe(true);
  });

  it("a stamp from another tag (or none) refetches both", () => {
    expect(needsFfFetch(true, true, "b5.0.1")).toBe(true);
    expect(needsFfFetch(true, true, null)).toBe(true);
  });

  it("present pair plus matching stamp means nothing to fetch", () => {
    expect(needsFfFetch(true, true, FFBIN_TAG)).toBe(false);
  });
});

describe("downloadFfTool", () => {
  it("gunzips the asset to the final path via temp + rename", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "soundcli-ff-"));
    const dest = path.join(dir, "ffmpeg-test.bin");
    const payload = Buffer.from("not really ffmpeg, but bytes all the same");
    const urls: string[] = [];
    const impl: FetchImpl = async (url) => {
      urls.push(url);
      return new Response(new Uint8Array(zlib.gzipSync(payload)));
    };
    try {
      await downloadFfTool("ffmpeg", dest, impl);
      expect(urls[0]).toBe(ffDownloadUrl("ffmpeg"));
      const onDisk = await fs.readFile(dest);
      expect(onDisk.equals(payload)).toBe(true);
      // The temp file never survives a successful rename.
      await expect(fs.access(`${dest}.tmp`)).rejects.toThrow();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("surfaces a clear error on a failed response", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "soundcli-ff-"));
    const dest = path.join(dir, "ffprobe-test.bin");
    const impl: FetchImpl = async () =>
      new Response("missing", { status: 404, statusText: "Not Found" });
    try {
      await expect(downloadFfTool("ffprobe", dest, impl)).rejects.toThrow(
        /Failed to download ffprobe/,
      );
      await expect(fs.access(dest)).rejects.toThrow();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("sends a User-Agent on the GitHub fetch", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "soundcli-ff-"));
    const dest = path.join(dir, "ffmpeg-ua.bin");
    let seenUA: unknown;
    const impl: FetchImpl = async (_url, init) => {
      seenUA = (init?.headers as Record<string, string> | undefined)?.[
        "User-Agent"
      ];
      return new Response(new Uint8Array(zlib.gzipSync(Buffer.from("x"))));
    };
    try {
      await downloadFfTool("ffmpeg", dest, impl);
      expect(seenUA).toBe(USER_AGENT);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("detectSystemFf", () => {
  const runs = async (): Promise<boolean> => true;

  it("returns the pair when both are found and runnable", async () => {
    const find = async (name: string) =>
      name === "ffmpeg" ? "/usr/bin/ffmpeg" : "/usr/bin/ffprobe";
    expect(await detectSystemFf(find, runs)).toEqual({
      ffmpeg: "/usr/bin/ffmpeg",
      ffprobe: "/usr/bin/ffprobe",
    });
  });

  it("returns null when either tool is missing", async () => {
    const find = async (name: string) =>
      name === "ffmpeg" ? "/usr/bin/ffmpeg" : null;
    expect(await detectSystemFf(find, runs)).toBeNull();
  });

  it("returns null when a found tool will not run", async () => {
    const find = async (name: string) =>
      name === "ffmpeg" ? "/usr/bin/ffmpeg" : "/usr/bin/ffprobe";
    const probe = async (p: string): Promise<boolean> => p.endsWith("ffmpeg");
    expect(await detectSystemFf(find, probe)).toBeNull();
  });
});

describe("resolveFfFetch", () => {
  it("downloads our own pair and never detects when it works", async () => {
    let downloaded = false;
    let detected = false;
    const pair = await resolveFfFetch(
      undefined,
      async () => {
        downloaded = true;
      },
      async () => {
        detected = true;
        return { ffmpeg: "/usr/bin/ffmpeg", ffprobe: "/usr/bin/ffprobe" };
      },
    );
    expect(downloaded).toBe(true);
    expect(detected).toBe(false);
    expect(pair).toEqual({
      ffmpeg: ffmpegBinPath(),
      ffprobe: ffprobeBinPath(),
    });
  });

  it("falls back to a system pair only when the download is blocked", async () => {
    const msgs: string[] = [];
    const pair = await resolveFfFetch(
      (m) => msgs.push(m),
      async () => {
        throw new Error("403 Forbidden");
      },
      async () => ({ ffmpeg: "/usr/bin/ffmpeg", ffprobe: "/usr/bin/ffprobe" }),
    );
    expect(pair).toEqual({
      ffmpeg: "/usr/bin/ffmpeg",
      ffprobe: "/usr/bin/ffprobe",
    });
    expect(msgs.some((m) => /system/i.test(m))).toBe(true);
  });

  it("surfaces the real download error when blocked and no system pair exists", async () => {
    await expect(
      resolveFfFetch(
        undefined,
        async () => {
          throw new Error("403 Forbidden");
        },
        async () => null,
      ),
    ).rejects.toThrow(/403/);
  });
});

describe("resolved ff paths", () => {
  it("default to the bundled location before any resolution", () => {
    expect(resolvedFfmpegPath()).toBe(ffmpegBinPath());
    expect(resolvedFfprobePath()).toBe(ffprobeBinPath());
  });
});
