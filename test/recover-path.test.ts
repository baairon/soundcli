import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findDownloadedFile,
  mangledNameToRegex,
  recoverMangledPath,
} from "../src/util/recover-path";

describe("mangledNameToRegex", () => {
  it("matches the real name behind ?-mangled characters, astral included", () => {
    const re = mangledNameToRegex("@axxturel ?? matrona horror ??.opus");
    expect(re.test("@axxturel \u{16910}\u{16910} matrona horror \u{16910}\u{16910}.opus")).toBe(true);
    expect(re.test("@axxturel ab matrona horror cd.opus")).toBe(true);
    expect(re.test("@axxturel abc matrona horror de.opus")).toBe(false);
  });

  it("treats U+FFFD the same as ?", () => {
    const re = mangledNameToRegex("d�j� vu.opus");
    expect(re.test("déjà vu.opus")).toBe(true);
    expect(re.test("dej vu.opus")).toBe(false);
  });

  it("escapes regex metacharacters in the literal parts", () => {
    const re = mangledNameToRegex("a+b (c) [d]?.opus");
    expect(re.test("a+b (c) [d]x.opus")).toBe(true);
    expect(re.test("aab (c) [d]x.opus")).toBe(false);
  });
});

describe("recoverMangledPath", () => {
  const win32 = process.platform === "win32";

  it("returns undefined when the basename has no mangled characters", async () => {
    expect(await recoverMangledPath(path.join("nowhere", "clean.opus"))).toBe(
      undefined,
    );
  });

  it.runIf(win32)(
    "recovers the single matching file in the directory",
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "soundcli-rec-"));
      try {
        const real = path.join(dir, "song é mix.opus");
        await fs.writeFile(real, "x");
        const got = await recoverMangledPath(path.join(dir, "song ? mix.opus"));
        expect(got).toBe(real);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    },
  );

  it.runIf(win32)("refuses when more than one file matches", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "soundcli-rec-"));
    try {
      await fs.writeFile(path.join(dir, "song a.opus"), "x");
      await fs.writeFile(path.join(dir, "song b.opus"), "x");
      const got = await recoverMangledPath(path.join(dir, "song ?.opus"));
      expect(got).toBe(undefined);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("findDownloadedFile", () => {
  it("returns the exact path when the file is right where reported", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "soundcli-find-"));
    try {
      const real = path.join(dir, "Artist - Song.opus");
      await fs.writeFile(real, "x");
      expect(await findDownloadedFile(real)).toBe(real);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("recovers the same stem under a different audio extension (-x mismatch)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "soundcli-find-"));
    try {
      const real = path.join(dir, "Artist - Song.opus");
      await fs.writeFile(real, "x");
      // yt-dlp printed the pre-extraction container extension.
      const got = await findDownloadedFile(path.join(dir, "Artist - Song.m4a"));
      expect(got).toBe(real);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("ignores non-audio siblings with the same stem", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "soundcli-find-"));
    try {
      await fs.writeFile(path.join(dir, "Artist - Song.jpg"), "x"); // thumbnail
      const got = await findDownloadedFile(path.join(dir, "Artist - Song.m4a"));
      expect(got).toBe(undefined);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses when two audio files share the stem (never mis-assign)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "soundcli-find-"));
    try {
      await fs.writeFile(path.join(dir, "Song.opus"), "x");
      await fs.writeFile(path.join(dir, "Song.mp3"), "x");
      const got = await findDownloadedFile(path.join(dir, "Song.m4a"));
      expect(got).toBe(undefined);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined when nothing matches", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "soundcli-find-"));
    try {
      const got = await findDownloadedFile(path.join(dir, "Missing.opus"));
      expect(got).toBe(undefined);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("matches by title when yt-dlp dropped the artist from the reported path", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "soundcli-find-"));
    try {
      const real = path.join(
        dir,
        "𝔜𝔜𝔜ℜ𝔑ℑ - s1nt6n6 tf u gon do.mp166 MYYXX.m4a",
      );
      await fs.writeFile(real, "x");
      const got = await findDownloadedFile(
        path.join(dir, "- s1nt6n6 tf u gon do.mp166 MYYXX.m4a"),
        { title: "s1nt6n6 tf u gon do.mp166 MYYXX" },
      );
      expect(got).toBe(real);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("matches by title when unicode symbols were stripped from the reported stem", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "soundcli-find-"));
    try {
      const real = path.join(
        dir,
        "Islurwhenitalk Archive 5 - 𖤐Dj X_Xlurr𖤐 Playtyme ＊2020＊.m4a",
      );
      await fs.writeFile(real, "x");
      const got = await findDownloadedFile(
        path.join(dir, "Islurwhenitalk Archive 5 - Dj X_Xlurr Playtyme 2020.m4a"),
        { title: "𖤐Dj X_Xlurr𖤐 Playtyme *2020*" },
      );
      expect(got).toBe(real);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
