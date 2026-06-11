import { describe, it, expect } from "vitest";
import {
  ratio,
  slugify,
  forbiddenWordsIn,
  timeMatch,
  scoreCandidate,
  pickBest,
  FORBIDDEN_WORDS,
  type MatchCandidate,
} from "../src/sources/spotify/match";

describe("slugify", () => {
  it("lowercases, strips punctuation, folds accents", () => {
    expect(slugify("Beyoncé - Déjà Vu!")).toBe("beyonce-deja-vu");
    expect(slugify("  Hello,   World  ")).toBe("hello-world");
  });
});

describe("ratio", () => {
  it("is 100 for identical strings and high for near matches", () => {
    expect(ratio("get lucky", "get lucky")).toBe(100);
    expect(ratio("Get Lucky", "get lucky")).toBe(100); // slug-normalized
    expect(ratio("get lucky", "get luckyy")).toBeGreaterThan(85);
  });
  it("is low for unrelated strings", () => {
    expect(ratio("get lucky", "bohemian rhapsody")).toBeLessThan(45);
  });
  it("ignores word order via token sort", () => {
    expect(ratio("daft punk get lucky", "get lucky daft punk")).toBe(100);
  });
});

describe("forbiddenWordsIn", () => {
  it("flags a forbidden word in the candidate but not the target", () => {
    expect(forbiddenWordsIn("Get Lucky (Live)", "Get Lucky")).toContain("live");
  });
  it("does not flag a word the target itself contains", () => {
    // A song actually titled "... Remix" should not be penalized for "remix".
    expect(forbiddenWordsIn("Song Title Remix", "Song Title Remix")).toEqual([]);
  });
  it("covers the called-out altered-version words", () => {
    for (const w of ["remix", "live", "slowed", "nightcore", "sped up", "8d"]) {
      expect(FORBIDDEN_WORDS).toContain(w);
    }
  });
});

describe("timeMatch", () => {
  it("is 100 at zero difference and falls off with distance", () => {
    expect(timeMatch(200, 200)).toBe(100);
    expect(timeMatch(200, 210)).toBeLessThan(timeMatch(200, 205));
    // Steep penalty: 60s off (an extended/loop edit) is near zero.
    expect(timeMatch(200, 260)).toBeLessThan(1);
  });
  it("is 0 when a duration is unknown", () => {
    expect(timeMatch(undefined, 200)).toBe(0);
    expect(timeMatch(200, undefined)).toBe(0);
  });
});

describe("scoreCandidate", () => {
  const target = { title: "Get Lucky", artist: "Daft Punk", durationSec: 248 };

  it("scores the clean studio upload highly", () => {
    const clean: MatchCandidate = {
      title: "Daft Punk - Get Lucky (Official Audio)",
      uploader: "Daft Punk",
      durationSec: 248,
    };
    expect(scoreCandidate(target, clean)).toBeGreaterThan(80);
  });

  it("rejects an hour-long loop on duration", () => {
    const loop: MatchCandidate = {
      title: "Daft Punk - Get Lucky (1 hour)",
      uploader: "Loops",
      durationSec: 3600,
    };
    expect(scoreCandidate(target, loop)).toBe(0);
  });

  it("penalizes a live version below the clean one", () => {
    const clean: MatchCandidate = {
      title: "Daft Punk - Get Lucky",
      uploader: "Daft Punk",
      durationSec: 248,
    };
    const live: MatchCandidate = {
      title: "Daft Punk - Get Lucky (Live at Coachella)",
      uploader: "Daft Punk",
      durationSec: 250,
    };
    expect(scoreCandidate(target, clean)).toBeGreaterThan(
      scoreCandidate(target, live),
    );
  });
});

describe("pickBest", () => {
  const target = { title: "Get Lucky", artist: "Daft Punk", durationSec: 248 };

  it("picks the clean studio version over remix / live / sped-up", () => {
    const candidates: MatchCandidate[] = [
      {
        title: "Get Lucky (Sped Up)",
        uploader: "Speed Songs",
        durationSec: 190,
      },
      {
        title: "Daft Punk - Get Lucky (PNAU Remix)",
        uploader: "Remixes",
        durationSec: 300,
      },
      {
        title: "Daft Punk - Get Lucky (Official Audio)",
        uploader: "Daft Punk",
        durationSec: 248,
      },
      {
        title: "Get Lucky (Live)",
        uploader: "Daft Punk",
        durationSec: 251,
      },
    ];
    const best = pickBest(target, candidates);
    expect(best?.title).toBe("Daft Punk - Get Lucky (Official Audio)");
  });

  it("respects duration proximity when titles tie", () => {
    const candidates: MatchCandidate[] = [
      {
        title: "Daft Punk - Get Lucky",
        uploader: "Daft Punk",
        durationSec: 248, // exact
      },
      {
        title: "Daft Punk - Get Lucky",
        uploader: "Daft Punk",
        durationSec: 268, // 20s long -> worse time match
      },
    ];
    const best = pickBest(target, candidates);
    expect(best?.durationSec).toBe(248);
  });

  it("returns null when nothing clears the floor", () => {
    const candidates: MatchCandidate[] = [
      {
        title: "Completely Different Song",
        uploader: "Someone Else",
        durationSec: 248,
      },
      {
        title: "Another Unrelated Track",
        uploader: "Nobody",
        durationSec: 248,
      },
    ];
    expect(pickBest(target, candidates)).toBeNull();
  });

  it("returns null for an empty candidate list", () => {
    expect(pickBest(target, [])).toBeNull();
  });

  it("matches even when the channel is a topic/VEVO and artist is only in the title", () => {
    const candidates: MatchCandidate[] = [
      {
        title: "Daft Punk - Get Lucky (Official Audio)",
        uploader: "DaftPunkVEVO",
        durationSec: 248,
      },
    ];
    expect(pickBest(target, candidates)?.title).toContain("Get Lucky");
  });
});
