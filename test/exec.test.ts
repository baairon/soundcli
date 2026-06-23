import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { executableNames, findOnPath } from "../src/util/exec";

describe("executableNames", () => {
  it("returns the bare name unchanged on posix", () => {
    expect(executableNames("yt-dlp", "linux")).toEqual(["yt-dlp"]);
    expect(executableNames("ffmpeg", "darwin")).toEqual(["ffmpeg"]);
  });

  it("expands a bare name through PATHEXT on win32", () => {
    expect(executableNames("mpv", "win32", ".EXE;.CMD;.BAT")).toEqual([
      "mpv.EXE",
      "mpv.CMD",
      "mpv.BAT",
    ]);
  });

  it("leaves a win32 name that already has an extension verbatim", () => {
    expect(executableNames("ffmpeg.exe", "win32", ".EXE;.CMD")).toEqual([
      "ffmpeg.exe",
    ]);
  });
});

describe("findOnPath", () => {
  // The function resolves against the real process.platform, so the fixture
  // matches what executableNames() will look for on each OS.
  const isWin = process.platform === "win32";
  const fixtureName = (base: string): string => (isWin ? `${base}.EXE` : base);

  async function withToolDir(
    base: string,
    run: (dir: string, file: string) => Promise<void>,
  ): Promise<void> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "soundcli-which-"));
    const file = path.join(dir, fixtureName(base));
    await fs.writeFile(file, "#!/bin/sh\n");
    if (!isWin) await fs.chmod(file, 0o755);
    try {
      await run(dir, file);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  it("returns the absolute path of an executable found on PATH", async () => {
    await withToolDir("mytool", async (dir, file) => {
      const env = { PATH: dir, PATHEXT: ".EXE" } as NodeJS.ProcessEnv;
      expect(await findOnPath("mytool", env)).toBe(file);
    });
  });

  it("returns null when the command is not on PATH", async () => {
    await withToolDir("present", async (dir) => {
      const env = { PATH: dir, PATHEXT: ".EXE" } as NodeJS.ProcessEnv;
      expect(await findOnPath("definitely-not-here", env)).toBeNull();
    });
  });

  it("reads Path when PATH is absent (Windows-style env)", async () => {
    await withToolDir("tool2", async (dir, file) => {
      const env = { Path: dir, PATHEXT: ".EXE" } as NodeJS.ProcessEnv;
      expect(await findOnPath("tool2", env)).toBe(file);
    });
  });
});
