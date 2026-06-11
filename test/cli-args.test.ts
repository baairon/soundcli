import { describe, it, expect } from "vitest";
import { parseCliArgs, HELP_TEXT } from "../src/cli/args";

describe("parseCliArgs", () => {
  it("runs the dashboard with no args", () => {
    expect(parseCliArgs([])).toEqual({ kind: "run" });
  });

  it("recognizes version flags", () => {
    expect(parseCliArgs(["--version"])).toEqual({ kind: "version" });
    expect(parseCliArgs(["-v"])).toEqual({ kind: "version" });
  });

  it("recognizes help flags", () => {
    expect(parseCliArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseCliArgs(["-h"])).toEqual({ kind: "help" });
  });

  it("treats a single positional as a link or handle to add", () => {
    expect(parseCliArgs(["https://soundcloud.com/somehandle"])).toEqual({
      kind: "run",
      initialAdd: "https://soundcloud.com/somehandle",
    });
    expect(parseCliArgs(["somehandle"])).toEqual({
      kind: "run",
      initialAdd: "somehandle",
    });
  });

  it("rejects unknown flags and extra args", () => {
    expect(parseCliArgs(["-x"])).toEqual({ kind: "invalid", arg: "-x" });
    expect(parseCliArgs(["a", "b"])).toEqual({ kind: "invalid", arg: "b" });
  });

  it("help text mentions the link pass-through", () => {
    expect(HELP_TEXT).toContain("soundcli <link>");
  });
});
