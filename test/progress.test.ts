import { describe, it, expect } from "vitest";
import { parseProgress } from "../src/ytdlp/progress";

describe("parseProgress", () => {
  it("parses a normal downloading line", () => {
    const p = parseProgress("SCPROG\tdownloading\t500\t1000\tNA\t250\t2");
    expect(p).toBeDefined();
    expect(p!.status).toBe("downloading");
    expect(p!.downloadedBytes).toBe(500);
    expect(p!.totalBytes).toBe(1000);
    expect(p!.percent).toBe(50);
    expect(p!.speed).toBe(250);
    expect(p!.eta).toBe(2);
  });

  it("falls back to the size estimate when total is NA", () => {
    const p = parseProgress("SCPROG\tdownloading\t500\tNA\t2000\tNA\tNA");
    expect(p!.totalBytes).toBe(2000);
    expect(p!.percent).toBe(25);
    expect(p!.speed).toBeUndefined();
  });

  it("returns undefined for non-progress lines", () => {
    expect(parseProgress("just some yt-dlp log line")).toBeUndefined();
    expect(parseProgress("SCMETA\tabc\tTitle")).toBeUndefined();
  });
});
