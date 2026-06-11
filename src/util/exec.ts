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
