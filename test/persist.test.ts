import { describe, it, expect } from "vitest";
import { snapshotItems, restorableItems } from "../src/download/persist";
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

  it("drops SoundCloud tombstones persisted before the enumeration filter", () => {
    const library = { has: () => false } as unknown as Library;
    const stub = qitem("900000001", "pending");
    stub.source = "soundcloud";
    stub.track.title = "900000001";
    stub.track.downloadUrl = "https://api-v2.soundcloud.com/tracks/900000001";
    const real = qitem("fresh", "pending");
    real.source = "soundcloud";
    real.track.downloadUrl = "https://soundcloud.com/artist/fresh";
    const out = restorableItems(snapshotItems([stub, real]), library);
    expect(out.map((p) => p.track.id)).toEqual(["fresh"]);
  });
});
