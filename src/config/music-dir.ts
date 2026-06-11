import path from "node:path";
import { execa } from "execa";
import { APP_NAME, defaultLibraryDir } from "./paths";

/** Minimal exec shape, so tests can inject a fake `reg query`. */
type ExecLike = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string }>;

const USER_SHELL_FOLDERS =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders";

/**
 * Pull the "My Music" data out of `reg query` output. The value name is
 * locale-invariant; the data is usually REG_EXPAND_SZ with %VAR% references,
 * but plain REG_SZ appears too. Returns null when the output looks wrong.
 */
export function parseUserShellFolders(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s*My Music\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/.exec(line);
    if (m?.[1]) return m[1];
  }
  return null;
}

/** Expand %VAR% references case-insensitively from env; unknown vars stay. */
export function expandWindowsEnv(
  value: string,
  env: NodeJS.ProcessEnv,
): string {
  return value.replace(/%([^%]+)%/g, (whole, name: string) => {
    const want = name.toLowerCase();
    for (const key of Object.keys(env)) {
      const v = env[key];
      if (key.toLowerCase() === want && v !== undefined) return v;
    }
    return whole;
  });
}

/**
 * Where the music library should live by default: the OS's real Music folder
 * plus the app folder. Windows keeps Music's location in the registry (OneDrive
 * setups redirect it away from ~\Music); everywhere else, and on any failure,
 * fall back to the static default.
 */
export async function resolveDefaultLibraryDir(
  platform: NodeJS.Platform = process.platform,
  execImpl: ExecLike = execa,
): Promise<string> {
  if (platform !== "win32") return defaultLibraryDir;
  try {
    const { stdout } = await execImpl("reg", [
      "query",
      USER_SHELL_FOLDERS,
      "/v",
      "My Music",
    ]);
    const raw = parseUserShellFolders(stdout);
    if (!raw) return defaultLibraryDir;
    const music = expandWindowsEnv(raw, process.env);
    // A %VAR% that didn't expand can't be a real path.
    if (music.includes("%")) return defaultLibraryDir;
    return path.join(music, APP_NAME);
  } catch {
    return defaultLibraryDir;
  }
}
