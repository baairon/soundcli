import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { displayPath, expandTilde } from "../src/util/format";

// displayPath folds case on win32 only, so pin the platform per test.
const realPlatform = process.platform;
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}
afterEach(() => setPlatform(realPlatform));

describe("displayPath", () => {
  it("collapses the home prefix on windows, case-insensitively", () => {
    setPlatform("win32");
    expect(
      displayPath("C:\\Users\\Dustin\\Music\\soundcli", "c:\\users\\dustin"),
    ).toBe("~\\Music\\soundcli");
  });

  it("collapses the home prefix on unix, case-sensitively", () => {
    setPlatform("linux");
    expect(displayPath("/home/kip/Music/soundcli", "/home/kip")).toBe(
      "~/Music/soundcli",
    );
    // Unix paths are case-sensitive for real: no fold off win32.
    expect(displayPath("/home/Kip/Music", "/home/kip")).toBe("/home/Kip/Music");
  });

  it("shows exactly the home directory as ~", () => {
    setPlatform("win32");
    expect(displayPath("C:\\Users\\dustin", "C:\\Users\\dustin")).toBe("~");
  });

  it("leaves non-home paths alone", () => {
    setPlatform("linux");
    expect(displayPath("/srv/music", "/home/kip")).toBe("/srv/music");
  });

  it("passes already-tilde'd paths through", () => {
    expect(displayPath("~/Music/soundcli", "/home/kip")).toBe(
      "~/Music/soundcli",
    );
  });

  it("never collapses a prefix that isn't at a separator boundary", () => {
    setPlatform("win32");
    expect(displayPath("C:\\Users\\dustin\\x", "C:\\Users\\dust")).toBe(
      "C:\\Users\\dustin\\x",
    );
  });
});

describe("expandTilde", () => {
  const home = path.join("home", "kip");

  it("expands a bare ~ to the home directory", () => {
    expect(expandTilde("~", home)).toBe(home);
  });

  it("expands ~/rest against home", () => {
    expect(expandTilde("~/Music/soundcli", home)).toBe(
      path.join(home, "Music", "soundcli"),
    );
  });

  // The "~\" form only exists on Windows (displayPath emits it with native
  // separators there); this needs the real win32 path.join to assert.
  it.runIf(process.platform === "win32")(
    "expands ~\\rest against home on windows",
    () => {
      expect(expandTilde("~\\Music\\soundcli", home)).toBe(
        path.join(home, "Music", "soundcli"),
      );
    },
  );

  it("passes ~\\rest through on posix (backslash is a filename char)", () => {
    setPlatform("linux");
    expect(expandTilde("~\\Music\\soundcli", home)).toBe(
      "~\\Music\\soundcli",
    );
  });

  it("passes everything else through untouched", () => {
    expect(expandTilde("/srv/music", home)).toBe("/srv/music");
    expect(expandTilde("D:\\music", home)).toBe("D:\\music");
    // "~foo" is a literal name, not a home reference
    expect(expandTilde("~junk/x", home)).toBe("~junk/x");
    expect(expandTilde("~", "")).toBe("~"); // no home known: give it back
  });
});
