import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

const spawned: FakeChild[] = [];

class FakeChild extends EventEmitter {
  unref = vi.fn();
}

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    const child = new FakeChild();
    spawned.push(child);
    return child;
  }),
}));

import { openPath } from "../src/util/open-path";

describe("openPath", () => {
  beforeEach(() => {
    spawned.length = 0;
  });

  it("survives an async spawn error (missing opener binary)", () => {
    openPath("somewhere");
    expect(spawned).toHaveLength(1);
    const child = spawned[0]!;
    // Without an "error" listener this emit throws (Node's unhandled error
    // event), which is exactly how a missing xdg-open used to kill the app.
    expect(() =>
      child.emit("error", new Error("spawn xdg-open ENOENT")),
    ).not.toThrow();
  });

  it("detaches from the child so the app never waits on it", () => {
    openPath("somewhere");
    expect(spawned[0]!.unref).toHaveBeenCalled();
  });
});
