import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  ffmpegPath,
  ffprobePath,
  mpvResolutionStep,
  toolEnv,
} from "../src/bin/binaries";

describe("toolEnv", () => {
  it("forces UTF-8 output from spawned Python tools", () => {
    const env = toolEnv();
    expect(env.PYTHONUTF8).toBe("1");
    expect(env.PYTHONIOENCODING).toBe("utf-8");
  });

  it("keeps the bundled ffmpeg and ffprobe dirs on PATH", () => {
    const env = toolEnv();
    expect(env.PATH).toContain(path.dirname(ffmpegPath()));
    expect(env.PATH).toContain(path.dirname(ffprobePath()));
  });
});

describe("mpvResolutionStep", () => {
  it("env override always forces a full detect", () => {
    expect(mpvResolutionStep("/somewhere/mpv", "/usr/bin/mpv")).toBe("detect");
    expect(mpvResolutionStep("mpv.net", null)).toBe("detect");
  });

  it("a cached absolute path revalidates with fs.access only", () => {
    expect(mpvResolutionStep(undefined, "/usr/bin/mpv")).toBe(
      "revalidate-path",
    );
  });

  it("a cached bare command revalidates with one spawn", () => {
    expect(mpvResolutionStep(undefined, "mpv")).toBe("revalidate-command");
  });

  it("no cache means the full sweep", () => {
    expect(mpvResolutionStep(undefined, null)).toBe("detect");
  });
});
