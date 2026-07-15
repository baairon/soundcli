import { describe, it, expect } from "vitest";
import stringWidth from "string-width";
import { cleanText, formatBytes, truncate } from "../src/util/format";
import { trackSignature } from "../src/library/drift";

describe("cleanText renders titles 1:1", () => {
  it("keeps emoji and symbols", () => {
    expect(cleanText("🔥 Song")).toBe("🔥 Song");
    expect(cleanText("🥹 ok")).toBe("🥹 ok");
    expect(cleanText("A → B ★")).toBe("A → B ★");
    expect(cleanText("☠ raw")).toBe("☠ raw"); // BMP text symbol stays narrow
    expect(cleanText("🇺🇸 anthem")).toBe("🇺🇸 anthem"); // flags measure 2
  });

  it("stabilizes emoji whose width lies to the terminal", () => {
    // Bare U+1F578 measures 1 but renders 2 cells: forced to emoji
    // presentation (VS16) so Ink and the terminal agree.
    const web = cleanText("(dj demo) 🕸");
    expect(web).toContain("🕸️");
    expect(stringWidth(web)).toBe(stringWidth("(dj demo) ") + 2);
    // ZWJ sequences shrink to their lead emoji (2 cells everywhere).
    expect(cleanText("family 👨‍👩‍👧")).toBe("family 👨");
    // Skin tones drop to the base emoji.
    expect(cleanText("ok 👍🏽")).toBe("ok 👍");
  });

  it("still strips what breaks a terminal row", () => {
    expect(cleanText("badbeep")).toBe("badbeep"); // control char
    expect(cleanText("a‮evil")).toBe("aevil"); // bidi override
    expect(cleanText("two lines")).toBe("twolines"); // line separator
    expect(cleanText("JA�-Z")).toBe("JA-Z"); // replacement-char junk
  });

  it("strips zero-measured chars that terminals still draw", () => {
    // U+3164 Hangul filler measures 0 but Windows Terminal draws 2 cells:
    // the row draws wider than Ink measured, wraps, and corrupts the frame.
    expect(cleanText("ㅤ")).toBe("Untitled");
    expect(cleanText("aㅤb")).toBe("ab");
    // Other default-ignorables in the same class (ZWSP, WJ, BOM, SHY).
    expect(cleanText("a​b⁠c﻿d­e")).toBe("abcde");
    // Combining marks also measure 0 but compose onto their base: kept.
    expect(cleanText("•̀ x")).toBe("•̀ x");
    // ZWJ and VS16 survive the scan for the grapheme stabilizer to consume.
    expect(cleanText("family 👨‍👩‍👧")).toBe("family 👨");
    expect(cleanText("☠️ vs16 stays")).toBe("☠️ vs16 stays");
  });

  it("emits only terminal-agreeing widths for real library titles", () => {
    // Regression set from the misaligned-timestamp report: after cleaning,
    // no code point may measure 0 unless it composes (marks, ZWJ, VS16).
    const titles = [
      "9. 𝔡𝔲𝔪 - 2 𝔡𝔲𝔪 𝔡𝔲𝔪 𝔡𝔲𝔪 [@demo3x] ⚰️☠️",
      "(dj demo)🧛🏿‍♂️🤞🏿🕷",
      "demoh (@xdemoh)☆ﾟdemoword",
      "ㅤ",
      "murmurlin - ☥demo r𖤐dio☥",
    ];
    for (const t of titles) {
      for (const ch of cleanText(t)) {
        const ok =
          stringWidth(ch) > 0 || /[\p{M}‍︎️]/u.test(ch);
        expect(ok, `U+${ch.codePointAt(0)!.toString(16)} in ${t}`).toBe(true);
      }
    }
  });

  it("collapses inner whitespace so a name stays one line", () => {
    expect(cleanText("a\n b\t c")).toBe("a b c");
    expect(cleanText("   ")).toBe("Untitled");
  });
});

describe("truncate is code-point safe", () => {
  it("never splits a surrogate pair", () => {
    const t = truncate("ab🔥cd", 4);
    expect(t).toBe("ab🔥…");
    expect(t).not.toContain("�");
  });
});

describe("formatBytes", () => {
  it("walks the units with one decimal under 10", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(4.7 * 1024 ** 3)).toBe("4.7 GB");
    expect(formatBytes(120 * 1024 ** 3)).toBe("120 GB");
    expect(formatBytes(3 * 1024 ** 4)).toBe("3.0 TB");
  });

  it("returns empty for missing or zero sizes", () => {
    expect(formatBytes(undefined)).toBe("");
    expect(formatBytes(0)).toBe("");
    expect(formatBytes(-5)).toBe("");
    expect(formatBytes(Number.NaN)).toBe("");
  });
});

describe("trackSignature keeps the strict emoji-insensitive fold", () => {
  it("dedupes an emoji variant against the plain title", () => {
    const a = trackSignature({ title: "🔥 Song", artist: "Artist" });
    const b = trackSignature({ title: "Song", artist: "Artist" });
    expect(a).toBe(b);
  });
});
