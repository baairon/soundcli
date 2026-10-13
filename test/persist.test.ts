import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  saveQueue,
  saveQueueSync,
  snapshotItems,
  restorableItems,
} from "../src/download/persist";
import { SOUNDCLOUD_LIKED_TITLE } from "../src/sources/soundcloud";
import type { QueueItem, QueueStatus } from "../src/download/queue";
import type { Library } from "../src/library/library";

function qitem(id: string, status: QueueStatus): QueueItem {
  return {
    id: `q-${id}`,
    source: "youtube",
    sourceLabel: "YouTube",
    track: { id, title: id, downloadUrl: "x" },
    status,
    percent: 0,
  };
}

describe("snapshotItems", () => {
  it("keeps only unfinished items and maps downloading → pending", () => {
    const snap = snapshotItems([
      qitem("a", "pending"),
      qitem("b", "downloading"),
      qitem("c", "paused"),
      qitem("d", "done"),
      qitem("e", "error"),
      qitem("f", "canceled"),
      qitem("g", "skipped"),
    ]);
    expect(snap.map((s) => `${s.track.id}:${s.status}`)).toEqual([
      "a:pending",
      "b:pending",
      "c:paused",
    ]);
  });
});

describe("saveQueueSync, the write at quit", () => {
  const tmpFile = (): string =>
    path.join(mkdtempSync(path.join(os.tmpdir(), "soundcli-queue-")), "queue.json");
  const saved = (file: string): string[] =>
    (JSON.parse(readFileSync(file, "utf8")) as { items: { track: { id: string } }[] })
      .items.map((i) => i.track.id);

  it("replaces the saved queue whole and leaves nothing else behind", () => {
    const file = tmpFile();
    saveQueueSync([qitem("a", "pending")], { youtubeStarts: [] }, file);
    saveQueueSync(
      [qitem("a", "done"), qitem("b", "downloading")],
      { youtubeStarts: [] },
      file,
    );
    expect(saved(file)).toEqual(["b"]);
    expect(readdirSync(path.dirname(file))).toEqual(["queue.json"]);
  });

  it("still saves, in place, when the copy beside it cannot be used", () => {
    const file = tmpFile();
    saveQueueSync([qitem("a", "pending")], { youtubeStarts: [] }, file);
    // As when Windows refuses the rename because a scanner has the file open.
    mkdirSync(`${file}.quit.tmp`);
    writeFileSync(path.join(`${file}.quit.tmp`, "in-the-way"), "");
    saveQueueSync([qitem("b", "pending")], { youtubeStarts: [] }, file);
    expect(saved(file)).toEqual(["b"]);
  });

  it("is not gone over by an earlier write that finishes after it", async () => {
    const file = tmpFile();
    saveQueueSync([qitem("a", "pending")], { youtubeStarts: [] }, file);
    // A write that was on its way when the quit came, asked at the last step
    // whether the queue still wants it.
    await saveQueue([qitem("b", "pending")], { youtubeStarts: [] }, () => false, file);
    expect(saved(file)).toEqual(["a"]);
    await saveQueue([qitem("b", "pending")], { youtubeStarts: [] }, () => true, file);
    expect(saved(file)).toEqual(["b"]);
  });
});

describe("restorableItems", () => {
  it("drops items already in the library", () => {
    const library = {
      has: (id: string) => id === "youtube:owned",
    } as unknown as Library;
    const persisted = snapshotItems([
      qitem("owned", "pending"),
      qitem("fresh", "paused"),
    ]);
    const out = restorableItems(persisted, library);
    expect(out.map((p) => p.track.id)).toEqual(["fresh"]);
  });

  it("drops liked-feed tombstones but keeps api-v2 tracks from real sets", () => {
    const library = { has: () => false } as unknown as Library;
    const stub = qitem("900000001", "pending");
    stub.source = "soundcloud";
    stub.track.title = "900000001";
    stub.track.downloadUrl = "https://api-v2.soundcloud.com/tracks/900000001";
    stub.track.playlistTitle = SOUNDCLOUD_LIKED_TITLE;
    // Same bare api-v2 shape, but inside a real set: yt-dlp resolves these
    // during download, so a restart must not drop them from the queue.
    const inSet = qitem("900000002", "pending");
    inSet.source = "soundcloud";
    inSet.track.title = "900000002";
    inSet.track.downloadUrl = "https://api-v2.soundcloud.com/tracks/900000002";
    inSet.track.playlistTitle = "beach set";
    const real = qitem("fresh", "pending");
    real.source = "soundcloud";
    real.track.downloadUrl = "https://soundcloud.com/artist/fresh";
    const out = restorableItems(snapshotItems([stub, inSet, real]), library);
    expect(out.map((p) => p.track.id)).toEqual(["900000002", "fresh"]);
  });
});
