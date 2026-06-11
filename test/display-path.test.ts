import { describe, it, expect, afterEach } from "vitest";
import { displayPath } from "../src/util/format";

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
