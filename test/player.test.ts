import { describe, it, expect } from "vitest";
import { linuxMpvHint, Playback } from "../src/player/playback";
import {
  onEndedDecision,
  shuffledOrder,
  stepIndex,
} from "../src/player/order";
import type { Track } from "../src/library/types";

function track(id: string): Track {
  return {
    id,
    source: "youtube",
    sourceTrackId: id,
    title: id.toUpperCase(),
    filePath: `/tmp/${id}.mp3`,
    addedAt: new Date().toISOString(),
  };
}

describe("Playback without mpv (external engine)", () => {
  it("plays a track and advances/rewinds through the list", async () => {
    const opened: string[] = [];
    const p = new Playback(null, (f) => opened.push(f));
    const list = [track("a"), track("b"), track("c")];

    await p.play(list[1]!, list);
    expect(p.getState().index).toBe(1);
    expect(p.getState().track?.id).toBe("b");
    expect(p.getState().engine).toBe("external");

    await p.next();
    expect(p.getState().track?.id).toBe("c");

    await p.next(); // already at the end: stays put
    expect(p.getState().index).toBe(2);

    await p.prev();
    expect(p.getState().track?.id).toBe("b");

    expect(opened).toContain("/tmp/b.mp3");
    expect(opened).toContain("/tmp/c.mp3");
  });

  it("derives the index when not given one", async () => {
    const p = new Playback(null, () => {});
    const list = [track("x"), track("y"), track("z")];
    await p.play(list[2]!, list);
    expect(p.getState().index).toBe(2);
  });

  it("reports mpv availability from the constructor", () => {
    expect(new Playback(null).getState().mpvAvailable).toBe(false);
    expect(new Playback("mpv").getState().mpvAvailable).toBe(true);
  });
});

describe("linuxMpvHint", () => {
  it("names the package manager that exists", () => {
    expect(linuxMpvHint((p) => p === "/usr/bin/dnf")).toBe(
      "sudo dnf install mpv",
    );
    expect(linuxMpvHint((p) => p === "/usr/bin/pacman")).toBe(
      "sudo pacman -S mpv",
    );
    expect(linuxMpvHint((p) => p === "/usr/bin/zypper")).toBe(
      "sudo zypper install mpv",
    );
    expect(linuxMpvHint((p) => p === "/usr/bin/apt")).toBe(
      "sudo apt install mpv",
    );
  });

  it("prefers apt when several exist, and falls back to apt when none do", () => {
    expect(linuxMpvHint(() => true)).toBe("sudo apt install mpv");
    expect(linuxMpvHint(() => false)).toBe("sudo apt install mpv");
  });
});

describe("Playback repeat", () => {
  it("cycles off → all → one → off", () => {
    const p = new Playback(null, () => {});
    expect(p.getState().repeat).toBe("off");
    p.cycleRepeat();
    expect(p.getState().repeat).toBe("all");
    p.cycleRepeat();
    expect(p.getState().repeat).toBe("one");
    p.cycleRepeat();
    expect(p.getState().repeat).toBe("off");
  });

  it("wraps to the first track on next() at the end when repeat is all", async () => {
    const p = new Playback(null, () => {});
    const list = [track("a"), track("b")];
    await p.play(list[1]!, list); // at the end
    await p.next(); // repeat off → stays
    expect(p.getState().index).toBe(1);
    p.cycleRepeat(); // → all
    await p.next(); // now wraps to start
    expect(p.getState().index).toBe(0);
    expect(p.getState().track?.id).toBe("a");
  });
});

describe("order helpers (pure)", () => {
  it("shuffledOrder is a permutation that pins the current track first", () => {
    // Deterministic rng so the assertion is stable.
    let n = 0;
    const seq = [0.1, 0.9, 0.4, 0.7, 0.2];
    const rng = () => seq[n++ % seq.length]!;
    const order = shuffledOrder(5, 2, rng);
    expect(order).toHaveLength(5);
    expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
    expect(order[0]).toBe(2); // current track stays current
  });

  it("shuffledOrder tolerates an out-of-range current (plain shuffle)", () => {
    const order = shuffledOrder(4, -1, () => 0);
    expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });

  it("stepIndex advances, wraps with repeat all, and stops with repeat off", () => {
    const linear = [0, 1, 2];
    expect(stepIndex(linear, 0, "off", 1)).toBe(1);
    expect(stepIndex(linear, 2, "off", 1)).toBe(null); // end, no wrap
    expect(stepIndex(linear, 2, "all", 1)).toBe(0); // wraps forward
    expect(stepIndex(linear, 2, "one", 1)).toBe(null); // one doesn't wrap (like off)
    expect(stepIndex(linear, 0, "off", -1)).toBe(null); // start, no wrap
    expect(stepIndex(linear, 0, "all", -1)).toBe(2); // wraps backward
  });

  it("stepIndex walks a shuffled order by position, not by raw index", () => {
    const order = [2, 0, 1];
    expect(stepIndex(order, 2, "off", 1)).toBe(0); // after pos 0 comes index 0
    expect(stepIndex(order, 0, "off", 1)).toBe(1);
    expect(stepIndex(order, 1, "off", 1)).toBe(null); // end of shuffle cycle
  });

  it("onEndedDecision advances, stops, wraps with all, locks with one", () => {
    const order = [0, 1, 2];
    expect(onEndedDecision(order, 0, "off")).toBe(1);
    expect(onEndedDecision(order, 2, "off")).toBe("stop"); // end of list
    expect(onEndedDecision(order, 2, "all")).toBe(0); // wraps
    expect(onEndedDecision(order, 1, "one")).toBe(1); // locks the current track
  });
});

describe("Playback shuffle (external engine)", () => {
  it("plays every track exactly once per shuffle cycle, then stops", async () => {
    const opened: string[] = [];
    const p = new Playback(null, (f) => opened.push(f));
    const list = [track("a"), track("b"), track("c"), track("d")];

    await p.play(list[0]!, list);
    expect(p.getState().shuffle).toBe(false);

    p.toggleShuffle();
    expect(p.getState().shuffle).toBe(true);
    // Current track stays current right after enabling shuffle.
    expect(p.getState().track?.id).toBe("a");

    // Walk the whole cycle. Each next() should yield a new track until the end.
    const order = [p.getState().track!.id];
    for (let i = 0; i < list.length - 1; i++) {
      await p.next();
      order.push(p.getState().track!.id);
    }
    // Exactly one of each id, no repeats within the cycle.
    expect([...order].sort()).toEqual(["a", "b", "c", "d"]);

    // Past the end with repeat off: stays on the last track.
    const last = p.getState().track?.id;
    await p.next();
    expect(p.getState().track?.id).toBe(last);
  });

  it("turning shuffle off resumes linear order from the current track", async () => {
    const p = new Playback(null, () => {});
    const list = [track("a"), track("b"), track("c")];
    await p.play(list[0]!, list);
    p.toggleShuffle();
    await p.next(); // somewhere in the shuffled cycle
    p.toggleShuffle(); // back to linear, current preserved
    expect(p.getState().shuffle).toBe(false);

    const cur = p.getState().index;
    if (cur < list.length - 1) {
      await p.next();
      expect(p.getState().index).toBe(cur + 1); // strictly linear step
    } else {
      await p.prev();
      expect(p.getState().index).toBe(cur - 1);
    }
  });
});

describe("Playback volume (external engine)", () => {
  it("setVolume clamps to 0..100", async () => {
    const p = new Playback(null, () => {});
    await p.setVolume(150);
    expect(p.getState().volume).toBe(100);
    await p.setVolume(-20);
    expect(p.getState().volume).toBe(0);
    await p.setVolume(42);
    expect(p.getState().volume).toBe(42);
  });

  it("changeVolume clamps when nudged past the bounds", async () => {
    const p = new Playback(null, () => {});
    await p.setVolume(98);
    await p.changeVolume(5); // 103 -> 100
    expect(p.getState().volume).toBe(100);
    await p.changeVolume(-130); // -30 -> 0
    expect(p.getState().volume).toBe(0);
    await p.changeVolume(10); // 0 + 10
    expect(p.getState().volume).toBe(10);
  });
});

describe("Playback restart (external engine)", () => {
  it("reloads the current track from the start when mpv is unavailable", async () => {
    const opened: string[] = [];
    const p = new Playback(null, (f) => opened.push(f));
    const list = [track("a"), track("b")];
    await p.play(list[1]!, list);
    opened.length = 0;
    await p.restart();
    expect(p.getState().track?.id).toBe("b");
    expect(p.getState().position).toBe(0);
    expect(opened).toEqual(["/tmp/b.mp3"]);
  });
});

describe("Playback stop (external engine)", () => {
  it("stop() clears the current track and list", async () => {
    const p = new Playback(null, () => {});
    const list = [track("a"), track("b")];
    await p.play(list[0]!, list);
    expect(p.getState().track?.id).toBe("a");
    await p.stop();
    expect(p.getState().track).toBe(null);
    expect(p.getState().index).toBe(-1);
    expect(p.getState().list).toHaveLength(0);
  });
});

describe("Playback optional state (external engine)", () => {
  it("exposes shuffle/loading/canControl with sensible defaults", async () => {
    const p = new Playback(null, () => {});
    const st = p.getState();
    expect(st.shuffle).toBe(false);
    expect(st.loading).toBe(false);
    // Without mpv, transport controls do not work.
    expect(st.canControl).toBe(false);
    await p.play(track("a"));
    expect(p.getState().canControl).toBe(false);
    expect(p.getState().loading).toBe(false);
  });
});

describe("Playback shuffle prev (heard-history back stack)", () => {
  it("walks back through the played sequence, not the order", async () => {
    const p = new Playback(null, () => {});
    const list = ["a", "b", "c", "d", "e"].map(track);
    await p.play(list[0]!, list);
    p.toggleShuffle();
    const heard = [p.getState().track!.id];
    await p.next();
    heard.push(p.getState().track!.id);
    await p.next();
    heard.push(p.getState().track!.id);
    await p.prev();
    expect(p.getState().track?.id).toBe(heard[1]);
    await p.prev();
    expect(p.getState().track?.id).toBe(heard[0]);
  });

  it("survives a mid-play reshuffle (s pressed again)", async () => {
    const p = new Playback(null, () => {});
    const list = ["a", "b", "c", "d", "e"].map(track);
    await p.play(list[0]!, list);
    p.toggleShuffle();
    await p.next();
    const before = p.getState().track!.id;
    // Off and on again: a fresh cycle pins the current track at its head,
    // where the order alone has no way back.
    p.toggleShuffle();
    p.toggleShuffle();
    await p.next();
    await p.prev();
    expect(p.getState().track?.id).toBe(before);
  });

  it("with nothing heard before, stays put on repeat off and wraps on all", async () => {
    const p = new Playback(null, () => {});
    const list = ["a", "b", "c"].map(track);
    await p.play(list[0]!, list);
    p.toggleShuffle();
    await p.prev(); // nothing heard before, repeat off: stays
    expect(p.getState().track?.id).toBe("a");
    p.cycleRepeat(); // → all
    await p.prev(); // wraps to the end of the shuffle cycle
    expect(p.getState().track?.id).not.toBe("a");
  });

  it("keeps linear prev strictly positional", async () => {
    const p = new Playback(null, () => {});
    const list = ["a", "b", "c", "d"].map(track);
    await p.play(list[0]!, list);
    await p.play(list[2]!, list, 2); // manual jump within the same list
    await p.prev(); // linear: previous row, not the jump source
    expect(p.getState().index).toBe(1);
  });
});

describe("Playback adoptList", () => {
  it("swaps in a bigger list around the current track without reopening it", async () => {
    const opened: string[] = [];
    const p = new Playback(null, (f) => opened.push(f));
    const all = ["a", "b", "c", "d"].map(track);
    await p.play(all[2]!); // resumed-style single-track list
    expect(p.getState().list).toHaveLength(1);
    opened.length = 0;
    p.adoptList(all, 2);
    expect(opened).toHaveLength(0); // audio untouched
    expect(p.getState().list).toHaveLength(4);
    expect(p.getState().index).toBe(2);
    expect(p.getState().track?.id).toBe("c");
    p.toggleShuffle();
    await p.next(); // somewhere to go now
    expect(p.getState().track?.id).not.toBe("c");
  });

  it("rejects an index that does not point at the current track", async () => {
    const p = new Playback(null, () => {});
    const all = ["a", "b", "c"].map(track);
    await p.play(all[0]!);
    p.adoptList(all, 2); // c is not what's playing
    expect(p.getState().list).toHaveLength(1);
  });
});
