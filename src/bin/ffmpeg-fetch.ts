import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import zlib from "node:zlib";
import { execa } from "execa";
import { binDir } from "../config/paths";
import { findOnPath } from "../util/exec";
import { fetchResilient, USER_AGENT, type FetchImpl } from "../util/net";

// ffmpeg + ffprobe, fetched on first need from the same static builds the
// ffmpeg-static npm package pins (eugeneware/ffmpeg-static), so installs stay
// light and every OS gets the pair from one source. The .gz asset variants
// roughly halve the transfer.
export const FFBIN_TAG = "b6.1.1";

const RELEASE_BASE =
  "https://github.com/eugeneware/ffmpeg-static/releases/download";

export type FfTool = "ffmpeg" | "ffprobe";

/** Name of the release asset that matches a platform/arch (exported for tests). */
export function ffAssetName(
  tool: FfTool,
  platform = process.platform,
  arch = process.arch,
): string {
  if (platform === "win32") {
    // Windows arm64 runs the x64 build via emulation; b6.1.1 ships no native
    // arm64 asset.
    return `${tool}-win32-x64`;
  }
  if (platform === "darwin") {
    return `${tool}-darwin-${arch === "arm64" ? "arm64" : "x64"}`;
  }
  // linux and other unix
  if (arch === "arm64") return `${tool}-linux-arm64`;
  if (arch === "arm") return `${tool}-linux-arm`;
  if (arch === "ia32") return `${tool}-linux-ia32`;
  return `${tool}-linux-x64`;
}

/** Download URL of a tool's gzipped asset under the pinned tag. */
export function ffDownloadUrl(
  tool: FfTool,
  platform = process.platform,
  arch = process.arch,
): string {
  return `${RELEASE_BASE}/${FFBIN_TAG}/${ffAssetName(tool, platform, arch)}.gz`;
}

/** Local path of the ffmpeg binary. Pure path math, never touches the disk. */
export function ffmpegBinPath(): string {
  const name = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  return path.join(binDir, name);
}

/** Local path of the ffprobe binary. Pure path math, never touches the disk. */
export function ffprobeBinPath(): string {
  const name = process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
  return path.join(binDir, name);
}

function stampFile(): string {
  return path.join(binDir, "ffmpeg-version.json");
}

/**
 * Whether a fetch is due: a missing binary or a stamp from another tag means
 * BOTH tools re-download (they ship as a pair, and bumping FFBIN_TAG later
 * upgrades installed machines through this same check). Pure, exported for
 * tests.
 */
export function needsFfFetch(
  haveFfmpeg: boolean,
  haveFfprobe: boolean,
  stampTag: string | null,
): boolean {
  return !haveFfmpeg || !haveFfprobe || stampTag !== FFBIN_TAG;
}

async function readStampTag(): Promise<string | null> {
  try {
    const raw = await fs.readFile(stampFile(), "utf8");
    const parsed = JSON.parse(raw) as { tag?: unknown };
    return typeof parsed.tag === "string" ? parsed.tag : null;
  } catch {
    return null;
  }
}

async function writeStamp(): Promise<void> {
  await fs.writeFile(stampFile(), JSON.stringify({ tag: FFBIN_TAG }));
}

async function present(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Download one tool's gzipped asset and decompress it straight to disk:
 * these binaries are tens of MB, so the whole thing never sits in memory.
 * Writes to a temp file and renames, the same crash-safety dance as the
 * yt-dlp fetch.
 */
export async function downloadFfTool(
  tool: FfTool,
  dest: string,
  fetchImpl: FetchImpl = fetch as FetchImpl,
): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const url = ffDownloadUrl(tool);
  const res = await fetchResilient(url, {
    fetchImpl,
    headers: { "User-Agent": USER_AGENT },
  });
  if (!res.ok || !res.body) {
    throw new Error(
      `Failed to download ${tool} from ${url}: ${res.status} ${res.statusText}`,
    );
  }
  const tmp = `${dest}.tmp`;
  // The cast bridges the fetch body type to the node:stream/web declaration
  // (same stream, two declaration homes).
  await pipeline(
    Readable.fromWeb(res.body as unknown as WebReadableStream),
    zlib.createGunzip(),
    createWriteStream(tmp),
  );
  if (process.platform !== "win32") {
    await fs.chmod(tmp, 0o755);
  }
  await fs.rename(tmp, dest);
}

/** Minimal exec signature so tests can probe without spawning anything. */
export type ExecImpl = (
  file: string,
  args: string[],
  opts: { timeout: number },
) => Promise<unknown>;

const realExec: ExecImpl = (file, args, opts) => execa(file, args, opts);

/** Whether the binary at `file` runs (prints its version). */
async function ffToolRuns(
  file: string,
  execImpl: ExecImpl = realExec,
): Promise<boolean> {
  try {
    await execImpl(file, ["-version"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

let resolvedFfmpeg: string | null = null;
let resolvedFfprobe: string | null = null;

/**
 * The ffmpeg / ffprobe we actually use: the bundled pair, or a detected system
 * pair when the bundled download was blocked. Fall back to the bundled-path
 * math until the first ensure resolves them.
 */
export function resolvedFfmpegPath(): string {
  return resolvedFfmpeg ?? ffmpegBinPath();
}
export function resolvedFfprobePath(): string {
  return resolvedFfprobe ?? ffprobeBinPath();
}

/**
 * A usable system ffmpeg + ffprobe pair on PATH, or null. Both are required:
 * they ship and are used together. The rescue when our own download is blocked
 * (some networks 403 GitHub release assets). Seams injected for tests.
 */
export async function detectSystemFf(
  find: (name: string) => Promise<string | null> = findOnPath,
  probe: (p: string) => Promise<boolean> = ffToolRuns,
): Promise<{ ffmpeg: string; ffprobe: string } | null> {
  const ffmpeg = await find("ffmpeg");
  const ffprobe = await find("ffprobe");
  if (ffmpeg && ffprobe && (await probe(ffmpeg)) && (await probe(ffprobe))) {
    return { ffmpeg, ffprobe };
  }
  return null;
}

/**
 * When a (re)fetch is due, download our own pair exactly as before, and only if
 * that download is blocked, fall back to a system pair. The download path is
 * untouched for everyone whose fetch works; detection runs only when it fails.
 * Seam-injected and free of module state, so the ordering is unit-testable.
 */
export async function resolveFfFetch(
  onStatus: ((msg: string) => void) | undefined,
  download: () => Promise<void>,
  detect: () => Promise<{ ffmpeg: string; ffprobe: string } | null>,
): Promise<{ ffmpeg: string; ffprobe: string }> {
  // Fetch our own pair, exactly as before.
  try {
    await download();
    return { ffmpeg: ffmpegBinPath(), ffprobe: ffprobeBinPath() };
  } catch (e) {
    // Blocked on some networks (GitHub 403 on mobile/CGNAT/datacenter/Termux).
    // Fall back to a system pair if the user has one; otherwise surface the
    // real failure.
    const system = await detect();
    if (system) {
      onStatus?.("using ffmpeg from your system");
      return system;
    }
    throw e;
  }
}

/**
 * One health probe per process: enough to catch a torn or antivirus-mangled
 * binary without paying a spawn on every ensure call.
 */
let probed = false;

async function probeOk(execImpl: ExecImpl): Promise<boolean> {
  return ffToolRuns(resolvedFfmpegPath(), execImpl);
}

async function downloadBoth(
  onStatus: ((msg: string) => void) | undefined,
  fetchImpl: FetchImpl,
): Promise<void> {
  onStatus?.("downloading the audio engine (one-time setup)…");
  await downloadFfTool("ffmpeg", ffmpegBinPath(), fetchImpl);
  await downloadFfTool("ffprobe", ffprobeBinPath(), fetchImpl);
  // Stamped only after both landed, so a crash between them refetches the pair.
  await writeStamp();
  onStatus?.("audio engine ready.");
}

async function removePair(): Promise<void> {
  await fs.rm(ffmpegBinPath(), { force: true }).catch(() => {});
  await fs.rm(ffprobeBinPath(), { force: true }).catch(() => {});
  await fs.rm(stampFile(), { force: true }).catch(() => {});
}

async function doEnsure(
  onStatus?: (msg: string) => void,
  fetchImpl: FetchImpl = fetch as FetchImpl,
  execImpl: ExecImpl = realExec,
  detect: () => Promise<{ ffmpeg: string; ffprobe: string } | null> = () =>
    detectSystemFf(findOnPath, (p) => ffToolRuns(p, execImpl)),
): Promise<void> {
  // Resolved already this process (bundled verified or system found): the
  // per-download queue gate can return without re-probing.
  if (resolvedFfmpeg && resolvedFfprobe) return;
  await fs.mkdir(binDir, { recursive: true });
  const haveFfmpeg = await present(ffmpegBinPath());
  const haveFfprobe = await present(ffprobeBinPath());
  if (needsFfFetch(haveFfmpeg, haveFfprobe, await readStampTag())) {
    const pair = await resolveFfFetch(
      onStatus,
      () => downloadBoth(onStatus, fetchImpl),
      detect,
    );
    resolvedFfmpeg = pair.ffmpeg;
    resolvedFfprobe = pair.ffprobe;
    return;
  }
  // Bundled pair present and stamped: adopt it, then health-probe once.
  resolvedFfmpeg = ffmpegBinPath();
  resolvedFfprobe = ffprobeBinPath();
  if (probed) return;
  probed = true;
  if (await probeOk(execImpl)) return;
  // On disk but can't even print its version: a torn write or an antivirus
  // quarantine. Wipe the pair, fetch fresh, and check the replacement runs.
  resolvedFfmpeg = null;
  resolvedFfprobe = null;
  await removePair();
  await downloadBoth(onStatus, fetchImpl);
  if (!(await probeOk(execImpl))) {
    // Stay unhealthy: the next ensure re-probes and re-heals, so a retry
    // genuinely retries instead of trusting a binary we know is broken.
    probed = false;
    throw new Error(
      "The audio engine isn't starting on this computer. Check that your antivirus isn't blocking soundcli, then try again.",
    );
  }
  resolvedFfmpeg = ffmpegBinPath();
  resolvedFfprobe = ffprobeBinPath();
}

let inflight: Promise<void> | null = null;

/**
 * Ensure ffmpeg + ffprobe are present and working, downloading them on first
 * run. Concurrent callers share one run, so the pair never downloads twice in
 * parallel; a failed run clears, so the next call retries fresh.
 */
export function ensureFfmpeg(
  onStatus?: (msg: string) => void,
  fetchImpl: FetchImpl = fetch as FetchImpl,
  execImpl: ExecImpl = realExec,
): Promise<void> {
  inflight ??= doEnsure(onStatus, fetchImpl, execImpl).finally(() => {
    inflight = null;
  });
  return inflight;
}
