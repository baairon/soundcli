import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  audioFormatArgs,
  AUDIO_FORMATS,
  outputTemplateInFolder,
} from "../src/ytdlp/args";
import { AUDIO_EXTS } from "../src/library/drift";

describe("audioFormatArgs", () => {
  it("asks for the source's own AAC stream before falling back to converting", () => {
    const args = audioFormatArgs();
    // The selector has to come first: every source we pull from serves AAC
    // natively, so this is what makes --audio-format find nothing to convert.
    expect(args.slice(0, 2)).toEqual(["-f", "bestaudio[ext=m4a]/bestaudio"]);
    expect(args).toContain("-x");
    // The guard rail behind it: a future source serving no AAC still cannot
    // put a file the rest of the world refuses to open back in the library.
    expect(args.slice(-2)).toEqual(["--audio-format", "m4a"]);
  });

  it("defaults to m4a when the config predates the setting", () => {
    expect(audioFormatArgs()).toEqual(audioFormatArgs("m4a"));
  });

  it("prefers the source's own stream whichever format is chosen", () => {
    // The same selection-not-conversion property has to hold for every option
    // in the picker, or choosing one quietly re-encodes what a source already
    // serves (SoundCloud's mp3, YouTube's opus).
    for (const { id } of AUDIO_FORMATS) {
      const args = audioFormatArgs(id);
      expect(args.slice(0, 2)).toEqual(["-f", `bestaudio[ext=${id}]/bestaudio`]);
      expect(args.slice(-2)).toEqual(["--audio-format", id]);
    }
  });

  it("never offers a format the library walk would not recognize", () => {
    // A drift guard, not a restatement: the walk only sees extensions listed
    // in AUDIO_EXTS, so a format offered here without being added there would
    // download fine and then fail with "the file is missing on disk".
    for (const { id } of AUDIO_FORMATS) {
      const args = audioFormatArgs(id);
      const ext = args[args.indexOf("--audio-format") + 1];
      expect(AUDIO_EXTS.has(`.${ext}`)).toBe(true);
    }
  });
});

describe("outputTemplateInFolder", () => {
  it("places yt-dlp's filename inside the given folder without owner", () => {
    const p = outputTemplateInFolder(path.join("music"), "SoundCloud", "Liked Songs");
    expect(p).toBe(
      path.join(
        "music",
        "SoundCloud",
        "Liked Songs",
        "%(artist,uploader|Unknown Artist)s - %(track,title)s.%(ext)s",
      ),
    );
  });

  it("inserts the sanitized owner segment when provided", () => {
    const p = outputTemplateInFolder(path.join("music"), "YouTube", "Mix", "my/owner:name");
    expect(p).toBe(
      path.join(
        "music",
        "YouTube",
        "my_owner_name",
        "Mix",
        "%(artist,uploader|Unknown Artist)s - %(track,title)s.%(ext)s",
      ),
    );
  });

  it("sanitizes the folder name", () => {
    const p = outputTemplateInFolder(path.join("music"), "SoundCloud", "my/set:name");
    expect(p).toContain(path.join("music", "SoundCloud", "my_set_name"));
  });
});
