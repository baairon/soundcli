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
      displayPath("C:\\Users\\Bairo\\Music\\soundcli", "c:\\users\\bairo"),
    ).toBe("~\\Music\\soundcli");
  });

  it("collapses the home prefix on unix, case-sensitively", () => {
    setPlatform("linux");
    expect(displayPath("/home/ale/Music/soundcli", "/home/ale")).toBe(
      "~/Music/soundcli",
    );
    // Unix paths are case-sensitive for real: no fold off win32.
    expect(displayPath("/home/Ale/Music", "/home/ale")).toBe("/home/Ale/Music");
  });

  it("shows exactly the home directory as ~", () => {
    setPlatform("win32");
    expect(displayPath("C:\\Users\\bairo", "C:\\Users\\bairo")).toBe("~");
  });

  it("leaves non-home paths alone", () => {
    setPlatform("linux");
    expect(displayPath("/srv/music", "/home/ale")).toBe("/srv/music");
  });

  it("passes already-tilde'd paths through", () => {
    expect(displayPath("~/Music/soundcli", "/home/ale")).toBe(
      "~/Music/soundcli",
    );
  });

  it("never collapses a prefix that isn't at a separator boundary", () => {
    setPlatform("win32");
    expect(displayPath("C:\\Users\\bairo\\x", "C:\\Users\\bai")).toBe(
      "C:\\Users\\bairo\\x",
    );
  });
});
