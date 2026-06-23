import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Return a copy of `env` with `dirs` prepended to PATH. Used so spawned tools
 * (yt-dlp) can locate the bundled ffmpeg + ffprobe binaries.
 */
export function withToolsOnPath(
  env: NodeJS.ProcessEnv,
  dirs: string[],
): NodeJS.ProcessEnv {
  const sep = path.delimiter;
  const extra = dirs.filter(Boolean).join(sep);
  const current = env.PATH ?? env.Path ?? "";
  return { ...env, PATH: extra ? `${extra}${sep}${current}` : current };
}

/**
 * Candidate filenames for a command. On Windows a bare name (no extension)
 * expands through PATHEXT (.EXE, .CMD, ...); a name that already carries an
 * extension, and any POSIX name, is used verbatim. Pure, exported for tests.
 */
export function executableNames(
  name: string,
  platform: NodeJS.Platform = process.platform,
  pathext: string | undefined = process.env.PATHEXT,
): string[] {
  if (platform !== "win32" || path.extname(name) !== "") return [name];
  const exts = (pathext ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean);
  return exts.map((ext) => name + ext);
}

/**
 * Resolve an executable's absolute path by scanning PATH, the way a shell's
 * `command -v` / `where` would, but without spawning a shell (so it behaves the
 * same on Termux, Windows, and macOS). Returns the first match that exists and
 * is executable, or null. Used to fall back to a system-installed yt-dlp /
 * ffmpeg / ffprobe when our own GitHub download is blocked.
 */
export async function findOnPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const dirs = (env.PATH ?? env.Path ?? "")
    .split(path.delimiter)
    .filter(Boolean);
  const names = executableNames(name, process.platform, env.PATHEXT);
  for (const dir of dirs) {
    for (const candidateName of names) {
      const candidate = path.join(dir, candidateName);
      try {
        // X_OK degrades to a plain existence check on Windows (no execute bit).
        await fs.access(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // not here; keep scanning
      }
    }
  }
  return null;
}
