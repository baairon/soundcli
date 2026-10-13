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
    expect(HELP_TEXT).toContain("sndcli <link>");
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
    const bare = {
      kind: "invalid",
      arg: "add",
      in: "add",
      why: "add needs at least one link",
    };
    expect(parseCliArgs(["add"])).toEqual(bare);
    expect(parseCliArgs(["add", "--json"])).toEqual(bare);
  });

  it("rejects a flag add does not know", () => {
    expect(parseCliArgs(["add", "https://youtu.be/abc123", "--fast"])).toEqual({
      kind: "invalid",
      arg: "--fast",
      in: "add",
    });
  });

  it("reads --into as a folder name, in either spelling", () => {
    const link = "https://soundcloud.com/vesper/tracks";
    expect(parseCliArgs(["add", link, "--into", "Liked Songs"])).toEqual({
      kind: "add",
      links: [link],
      all: false,
      json: false,
      into: "Liked Songs",
    });
    expect(parseCliArgs(["add", "--into=Drops", link])).toMatchObject({
      links: [link],
      into: "Drops",
    });
  });

  it("refuses an --into that is a path, a flag or nothing", () => {
    const link = "https://youtu.be/abc123";
    for (const bad of [
      ["--into"],
      ["--into", "a/b"],
      ["--into", "..\\x"],
      ["--into", ".."],
      ["--into", "--json"],
    ]) {
      expect(parseCliArgs(["add", link, ...bad])).toEqual({
        kind: "invalid",
        arg: "--into",
        in: "add",
        why: "--into needs a folder name, not a path",
      });
    }
  });

  it("answers --help after add with the help, not a usage error", () => {
    expect(parseCliArgs(["add", "--help"])).toEqual({ kind: "help" });
    expect(parseCliArgs(["add", "https://youtu.be/abc123", "-h"])).toEqual({
      kind: "help",
    });
  });

  it("help text documents add", () => {
    expect(HELP_TEXT).toContain("sndcli add <link>...");
    expect(HELP_TEXT).toContain("--all");
    expect(HELP_TEXT).toContain("--json");
    expect(HELP_TEXT).toContain("--into <folder>");
    // npm installs the command as sndcli, so the usage names no other.
    expect(HELP_TEXT).not.toMatch(/^ {2}soundcli/m);
    for (const code of [0, 1, 2, 75, 130, 143]) {
      expect(HELP_TEXT).toMatch(new RegExp(`^ {2}${code}\\s`, "m"));
    }
  });
});

describe("parseCliArgs watch, unwatch and sync", () => {
  const link = "https://soundcloud.com/vesper/tracks";

  it("remembers links with their folder", () => {
    expect(parseCliArgs(["watch", link, "--into", "Liked Songs"])).toEqual({
      kind: "watch",
      links: [link],
      all: false,
      into: "Liked Songs",
    });
    expect(parseCliArgs(["watch", "--all", link])).toEqual({
      kind: "watch",
      links: [link],
      all: true,
    });
  });

  it("lists what is watched when given no link", () => {
    expect(parseCliArgs(["watch"])).toEqual({
      kind: "watch",
      links: [],
      all: false,
    });
  });

  it("needs a link to stop watching", () => {
    expect(parseCliArgs(["unwatch", link])).toEqual({
      kind: "unwatch",
      links: [link],
    });
    expect(parseCliArgs(["unwatch"])).toEqual({
      kind: "invalid",
      arg: "unwatch",
      in: "unwatch",
      why: "unwatch needs at least one link",
    });
  });

  it("gives sync --json and nothing else", () => {
    expect(parseCliArgs(["sync"])).toEqual({ kind: "sync", json: false });
    expect(parseCliArgs(["sync", "--json"])).toEqual({ kind: "sync", json: true });
    expect(parseCliArgs(["sync", link])).toEqual({
      kind: "invalid",
      arg: link,
      in: "sync",
    });
    expect(parseCliArgs(["sync", "--all"])).toEqual({
      kind: "invalid",
      arg: "--all",
      in: "sync",
    });
  });

  it("refuses a flag that belongs to another command", () => {
    expect(parseCliArgs(["watch", link, "--json"])).toEqual({
      kind: "invalid",
      arg: "--json",
      in: "watch",
    });
    expect(parseCliArgs(["unwatch", link, "--into", "Drops"])).toEqual({
      kind: "invalid",
      arg: "--into",
      in: "unwatch",
    });
  });

  it("help text documents them", () => {
    expect(HELP_TEXT).toContain("sndcli watch <link>...");
    expect(HELP_TEXT).toContain("sndcli unwatch <link>...");
    expect(HELP_TEXT).toContain("sndcli sync");
  });
});
