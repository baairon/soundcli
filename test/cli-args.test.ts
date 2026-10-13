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

describe("parseCliArgs add", () => {
  it("collects every link and defaults both flags off", () => {
    expect(
      parseCliArgs([
        "add",
        "https://soundcloud.com/lumen/velvet-signal",
        "https://youtu.be/abc123",
      ]),
    ).toEqual({
      kind: "add",
      links: [
        "https://soundcloud.com/lumen/velvet-signal",
        "https://youtu.be/abc123",
      ],
      all: false,
      json: false,
    });
  });

  it("reads the flags wherever they sit", () => {
    expect(
      parseCliArgs(["add", "--json", "https://soundcloud.com/lumen", "--all"]),
    ).toEqual({
      kind: "add",
      links: ["https://soundcloud.com/lumen"],
      all: true,
      json: true,
    });
  });

  it("rejects add with nothing to add", () => {
    expect(parseCliArgs(["add"])).toEqual({
      kind: "invalid",
      arg: "add",
      inAdd: true,
    });
    expect(parseCliArgs(["add", "--json"])).toEqual({
      kind: "invalid",
      arg: "add",
      inAdd: true,
    });
  });

  it("rejects a flag add does not know", () => {
    expect(parseCliArgs(["add", "https://youtu.be/abc123", "--fast"])).toEqual({
      kind: "invalid",
      arg: "--fast",
      inAdd: true,
    });
  });

  it("help text documents add", () => {
    expect(HELP_TEXT).toContain("soundcli add <link>...");
    expect(HELP_TEXT).toContain("--all");
    expect(HELP_TEXT).toContain("--json");
  });
});
