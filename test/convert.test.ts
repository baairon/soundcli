import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// The real binary never runs: the mock writes whatever ffmpeg was told to
// write, which is what makes the rename-then-delete ordering testable.
vi.mock("execa", () => ({ execa: vi.fn() }));
vi.mock("../src/bin/ffmpeg-fetch", () => ({
  resolvedFfmpegPath: () => "ffmpeg",
}));

import { execa } from "execa";
import {
  convertLibrary,
  needsConversion,
  targetPath,
} from "../src/library/convert";
import type { Track } from "../src/library/types";

let root: string;

function track(name: string, ext: string): Track {
  return {
    id: `youtube:${name}`,
    source: "youtube",
    sourceTrackId: name,
    title: name,
    filePath: path.join(root, "YouTube", "Set A", `${name}.${ext}`),
    addedAt: new Date().toISOString(),
  };
}

/** Put a real file on disk where a track claims to live. */
async function place(t: Track, bytes = "original"): Promise<Track> {
  await fs.mkdir(path.dirname(t.filePath), { recursive: true });
  await fs.writeFile(t.filePath, bytes);
  return t;
}

const exists = (p: string) =>
  fs.access(p).then(
    () => true,
    () => false,
  );

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sndcli-convert-"));
  // The default ffmpeg: write the output file it was handed, then exit clean.
  vi.mocked(execa).mockImplementation((async (_bin: string, args: string[]) => {
    await fs.writeFile(args[args.length - 1]!, "converted");
    return {} as never;
  }) as never);
});

afterEach(async () => {
  vi.mocked(execa).mockReset();
  await fs.rm(root, { recursive: true, force: true });
});

describe("convert paths", () => {
  it("keeps the folder and swaps only the extension", () => {
    const t = track("Song One", "m4a");
    expect(targetPath(t.filePath, "mp3")).toBe(
      path.join(root, "YouTube", "Set A", "Song One.mp3"),
    );
  });

  it("reads an extension case-insensitively", () => {
    // Windows and macOS hand back whatever case the file was created with, so
    // a .MP3 is already mp3 and must not be re-encoded onto itself.
    expect(needsConversion(track("Song One", "MP3"), "mp3")).toBe(false);
    expect(needsConversion(track("Song One", "m4a"), "mp3")).toBe(true);
  });
});

describe("convertLibrary", () => {
  it("replaces each song in place and reports the new path", async () => {
    const t = await place(track("Song One", "m4a"));
    const { result, changed } = await convertLibrary([t], "mp3");

    const target = path.join(root, "YouTube", "Set A", "Song One.mp3");
    expect(result.converted).toBe(1);
    expect(result.failed).toEqual([]);
    expect(await exists(target)).toBe(true);
    // The original is gone and no second copy of the library appeared.
    expect(await exists(t.filePath)).toBe(false);
    expect(await exists(path.join(root, "mp3"))).toBe(false);
    expect(changed[0]!.filePath).toBe(target);
    expect(changed[0]!.fileSize).toBe("converted".length);
  });

  it("leaves songs that are already in the target format alone", async () => {
    const already = await place(track("Song One", "mp3"));
    const other = await place(track("Song Two", "m4a"));
    const { result } = await convertLibrary([already, other], "mp3");

    expect(result.converted).toBe(1);
    // Skips are not counted as conversions, and ffmpeg never saw the mp3.
    expect(vi.mocked(execa).mock.calls.length).toBe(1);
    expect(await fs.readFile(already.filePath, "utf8")).toBe("original");
  });

  it("never reports a failed song as a converted one", async () => {
    // The progress line says "N converted", so N has to mean exactly that:
    // counting failures into it would announce work that did not happen.
    const tracks = await Promise.all([
      place(track("Song One", "m4a")),
      place(track("Song Two", "m4a")),
    ]);
    let calls = 0;
    vi.mocked(execa).mockImplementation((async (_bin: string, args: string[]) => {
      calls++;
      if (calls === 1) throw new Error("ffmpeg exited with code 1");
      await fs.writeFile(args[args.length - 1]!, "converted");
      return {} as never;
    }) as never);

    const ticks: { converted: number; failed: number; total: number }[] = [];
    await convertLibrary(tracks, "mp3", {
      onProgress: (p) => ticks.push({ ...p }),
    });

    expect(ticks.at(-1)).toEqual({ converted: 1, failed: 1, total: 2 });
  });

  it("keeps the original when ffmpeg fails, and cleans up after itself", async () => {
    const t = await place(track("Song One", "m4a"));
    vi.mocked(execa).mockRejectedValue(new Error("ffmpeg exited with code 1"));

    const { result, changed } = await convertLibrary([t], "mp3");

    expect(result.failed).toEqual([t.filePath]);
    expect(result.converted).toBe(0);
    expect(changed).toEqual([]);
    // The song the user already had is untouched, and no half-written temp
    // file is left sitting in their music folder.
    expect(await fs.readFile(t.filePath, "utf8")).toBe("original");
    const target = path.join(root, "YouTube", "Set A", "Song One.mp3");
    expect(await exists(`${target}.tmp`)).toBe(false);
    expect(await exists(target)).toBe(false);
  });

  it("stops the whole run when this ffmpeg cannot make the format", async () => {
    // ffmpeg-static repackages a different upstream build per OS, so a missing
    // encoder is a real possibility; repeating it 400 times is not an answer.
    const tracks = await Promise.all([
      place(track("Song One", "m4a")),
      place(track("Song Two", "m4a")),
      place(track("Song Three", "m4a")),
    ]);
    vi.mocked(execa).mockRejectedValue(new Error("Unknown encoder 'libmp3lame'"));

    const { result } = await convertLibrary(tracks, "mp3");

    expect(result.missingEncoder).toBe(true);
    expect(vi.mocked(execa).mock.calls.length).toBe(1);
    // One clear answer, not three failures the user has to interpret.
    expect(result.failed).toEqual([]);
    expect(result.converted).toBe(0);
  });

  it("stops between songs when asked, leaving both sides consistent", async () => {
    const tracks = await Promise.all([
      place(track("Song One", "m4a")),
      place(track("Song Two", "m4a")),
      place(track("Song Three", "m4a")),
    ]);
    const controller = new AbortController();
    vi.mocked(execa).mockImplementation((async (_bin: string, args: string[]) => {
      await fs.writeFile(args[args.length - 1]!, "converted");
      controller.abort(); // one song in, the user hits stop
      return {} as never;
    }) as never);

    const { result, changed } = await convertLibrary(tracks, "mp3", {
      signal: controller.signal,
    });

    expect(result.stopped).toBe(true);
    expect(result.converted).toBe(1);
    expect(changed.length).toBe(1);
    // Song one is converted, the rest are exactly as they were: re-running
    // picks up where this left off instead of starting over.
    expect(await exists(path.join(root, "YouTube", "Set A", "Song One.mp3"))).toBe(true);
    expect(await exists(tracks[1]!.filePath)).toBe(true);
    expect(await exists(tracks[2]!.filePath)).toBe(true);
  });

  it("counts progress without ever double-counting a song", async () => {
    const tracks = await Promise.all([
      place(track("Song One", "m4a")),
      place(track("Song Two", "mp3")),
      place(track("Song Three", "m4a")),
    ]);
    const ticks: { converted: number; failed: number; total: number }[] = [];
    const { result } = await convertLibrary(tracks, "mp3", {
      onProgress: (p) => ticks.push({ ...p }),
    });

    // Already-mp3 songs are outside the total, so the bar measures the work
    // that is actually happening.
    expect(ticks.every((t) => t.total === 2)).toBe(true);
    expect(ticks.at(-1)).toEqual({ converted: 2, failed: 0, total: 2 });
    expect(result.converted).toBe(2);
  });
});
