import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import {
  parseUserShellFolders,
  expandWindowsEnv,
  resolveDefaultLibraryDir,
} from "../src/config/music-dir";
import { APP_NAME, defaultLibraryDir } from "../src/config/paths";

/** A realistic `reg query ... /v "My Music"` transcript around `line`. */
function regOut(line: string): string {
  return [
    "",
    "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders",
    line,
    "",
  ].join("\r\n");
}

describe("parseUserShellFolders", () => {
  it("reads a REG_EXPAND_SZ value", () => {
    const out = regOut("    My Music    REG_EXPAND_SZ    %USERPROFILE%\\Music");
    expect(parseUserShellFolders(out)).toBe("%USERPROFILE%\\Music");
  });

  it("reads a plain REG_SZ value", () => {
    const out = regOut("    My Music    REG_SZ    D:\\Tunes");
    expect(parseUserShellFolders(out)).toBe("D:\\Tunes");
  });

  it("keeps spaces inside the path, trims around it", () => {
    const out = regOut(
      "    My Music    REG_EXPAND_SZ    C:\\Users\\Test\\OneDrive\\My Music  ",
    );
    expect(parseUserShellFolders(out)).toBe(
      "C:\\Users\\Test\\OneDrive\\My Music",
    );
  });

  it("returns null for garbage, empty output, or a missing value", () => {
    expect(parseUserShellFolders("")).toBeNull();
    expect(parseUserShellFolders("ERROR: The system was unable to find it"))
      .toBeNull();
    expect(parseUserShellFolders(regOut("    Desktop    REG_SZ    C:\\x")))
      .toBeNull();
    expect(parseUserShellFolders(regOut("    My Music    REG_BINARY    0a")))
      .toBeNull();
  });
});

describe("expandWindowsEnv", () => {
  it("expands %VAR% case-insensitively", () => {
    const env = { USERPROFILE: "C:\\Users\\Test" };
    expect(expandWindowsEnv("%USERPROFILE%\\Music", env)).toBe(
      "C:\\Users\\Test\\Music",
    );
    expect(expandWindowsEnv("%userprofile%\\Music", env)).toBe(
      "C:\\Users\\Test\\Music",
    );
  });

  it("leaves unknown vars untouched", () => {
    expect(expandWindowsEnv("%NOPE%\\Music", { USERPROFILE: "C:\\u" })).toBe(
      "%NOPE%\\Music",
    );
  });

  it("expands several references in one value", () => {
    const env = { A: "1", b: "2" };
    expect(expandWindowsEnv("%A%-%B%", env)).toBe("1-2");
  });
});

describe("resolveDefaultLibraryDir", () => {
  it("appends the app folder to the registry's Music dir on win32", async () => {
    const exec = vi.fn(async () => ({
      stdout: regOut(
        "    My Music    REG_SZ    C:\\Users\\Test\\OneDrive\\Music",
      ),
    }));
    await expect(resolveDefaultLibraryDir("win32", exec)).resolves.toBe(
      path.join("C:\\Users\\Test\\OneDrive\\Music", APP_NAME),
    );
    expect(exec).toHaveBeenCalledOnce();
  });

  it("falls back when reg query throws", async () => {
    const exec = vi.fn(async () => {
      throw new Error("reg not found");
    });
    await expect(resolveDefaultLibraryDir("win32", exec)).resolves.toBe(
      defaultLibraryDir,
    );
  });

  it("falls back on unparseable output", async () => {
    const exec = vi.fn(async () => ({ stdout: "what even is this" }));
    await expect(resolveDefaultLibraryDir("win32", exec)).resolves.toBe(
      defaultLibraryDir,
    );
  });

  it("falls back when a %VAR% would survive expansion", async () => {
    const exec = vi.fn(async () => ({
      stdout: regOut("    My Music    REG_EXPAND_SZ    %NOT_A_REAL_VAR%\\m"),
    }));
    await expect(resolveDefaultLibraryDir("win32", exec)).resolves.toBe(
      defaultLibraryDir,
    );
  });

  it("short-circuits off win32 without spawning anything", async () => {
    const exec = vi.fn(async () => ({ stdout: "" }));
    await expect(resolveDefaultLibraryDir("linux", exec)).resolves.toBe(
      defaultLibraryDir,
    );
    expect(exec).not.toHaveBeenCalled();
  });
});
