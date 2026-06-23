import { promises as fs } from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { binDir } from "../config/paths";
import { findOnPath } from "../util/exec";
import { fetchResilient, USER_AGENT, type FetchImpl } from "../util/net";

const RELEASE_BASE = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";

/** Name of the release asset that matches the current platform/arch. */
function assetName(): string {
  const { platform, arch } = process;
  if (platform === "win32") {
    return arch === "ia32" ? "yt-dlp_x86.exe" : "yt-dlp.exe";
  }
  if (platform === "darwin") {
    return "yt-dlp_macos"; // universal2 binary
  }
  // linux and other unix
  if (arch === "arm64") return "yt-dlp_linux_aarch64";
  if (arch === "arm") return "yt-dlp_linux_armv7l";
  return "yt-dlp_linux";
}

/** Local path where we store the yt-dlp binary. */
export function ytDlpPath(): string {
  const name = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
  return path.join(binDir, name);
}

/** Where a freshly downloaded update waits until the next launch promotes it. */
export function stagedYtDlpPath(): string {
  return `${ytDlpPath()}.new`;
}

/**
 * Download the latest release asset to `dest`. Writes to a temp file and
 * renames, so a crash mid-download can never leave a torn exe that later
 * looks installed.
 */
export async function downloadYtDlp(
  dest: string,
  fetchImpl: FetchImpl = fetch as FetchImpl,
): Promise<void> {
  await fs.mkdir(binDir, { recursive: true });
  const url = `${RELEASE_BASE}/${assetName()}`;
  const res = await fetchResilient(url, {
    fetchImpl,
    headers: { "User-Agent": USER_AGENT },
  });
  if (!res.ok) {
    throw new Error(
      `Failed to download yt-dlp from ${url}: ${res.status} ${res.statusText}`,
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const tmp = `${dest}.tmp`;
  await fs.writeFile(tmp, buf);
  if (process.platform !== "win32") {
    await fs.chmod(tmp, 0o755);
  }
  await fs.rename(tmp, dest);
}

/**
 * Promote a staged update to the live path. Runs before anything spawns the
 * binary, so this process never holds it; a second running soundcli instance
 * can (EBUSY/EPERM on Windows), in which case the old binary stays and we
 * retry next launch. The rename dance keeps a working binary on disk at
 * every instant.
 */
export async function finalizeStagedYtDlp(): Promise<boolean> {
  const staged = stagedYtDlpPath();
  const dest = ytDlpPath();
  try {
    await fs.access(staged);
  } catch {
    return false; // nothing staged
  }
  const old = `${dest}.old`;
  // A leftover .old from a previous locked run; clearing it is best-effort.
  await fs.rm(old, { force: true }).catch(() => {});
  let hadCurrent = true;
  try {
    await fs.rename(dest, old);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      hadCurrent = false; // no live binary yet; the staged one becomes it
    } else {
      return false; // live exe is in use by another instance
    }
  }
  try {
    await fs.rename(staged, dest);
  } catch {
    if (hadCurrent) await fs.rename(old, dest).catch(() => {});
    return false;
  }
  await fs.rm(old, { force: true }).catch(() => {});
  return true;
}

async function probeBinary(dest: string): Promise<boolean> {
  try {
    await execa(dest, ["--version"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * A usable yt-dlp already on the user's PATH, or null. The rescue when our own
 * download is blocked (some networks 403 GitHub release assets). Seams injected
 * for tests.
 */
export async function detectSystemYtDlp(
  find: (name: string) => Promise<string | null> = findOnPath,
  probe: (p: string) => Promise<boolean> = probeBinary,
): Promise<string | null> {
  const found = await find("yt-dlp");
  return found && (await probe(found)) ? found : null;
}

/**
 * Download to `dest`, then check the binary actually runs. A failed probe
 * means a torn or antivirus-mangled exe: delete it and retry once before
 * giving up, so a bad first download can't masquerade as installed forever.
 * The download/probe/remove seams are injectable for tests.
 */
export async function downloadVerified(
  dest: string,
  download: (dest: string) => Promise<void> = downloadYtDlp,
  probe: (dest: string) => Promise<boolean> = probeBinary,
  remove: (p: string) => Promise<void> = async (p) => {
    await fs.rm(p, { force: true });
  },
): Promise<void> {
  await download(dest);
  if (await probe(dest)) return;
  await remove(dest);
  await download(dest);
  if (await probe(dest)) return;
  // Leave no torn exe behind: it would pass the exists check next launch.
  await remove(dest);
  throw new Error(
    "yt-dlp downloaded but won't start on this computer. Check that your antivirus isn't blocking soundcli, then try again.",
  );
}

/**
 * Decide which yt-dlp to use: the bundled binary if present, else download our
 * own exactly as before, and only if that download is blocked, fall back to a
 * system yt-dlp on PATH. The download path is untouched for everyone whose
 * fetch works; detection runs only when it fails. Seam-injected and free of
 * module state, so the ordering is unit-testable.
 */
export async function resolveYtDlp(
  onStatus?: (msg: string) => void,
  deps: {
    dest?: string;
    exists?: (p: string) => Promise<boolean>;
    detect?: () => Promise<string | null>;
    download?: (dest: string) => Promise<void>;
  } = {},
): Promise<string> {
  const dest = deps.dest ?? ytDlpPath();
  const exists =
    deps.exists ??
    (async (p: string) => {
      try {
        await fs.access(p);
        return true;
      } catch {
        return false;
      }
    });
  const detect = deps.detect ?? (() => detectSystemYtDlp());
  const download = deps.download ?? downloadVerified;

  // Already installed: the normal path, completely unchanged.
  if (await exists(dest)) return dest;

  // First run: fetch our own binary, exactly as before.
  try {
    onStatus?.("downloading yt-dlp (one-time setup)…");
    await download(dest);
    onStatus?.("yt-dlp ready.");
    return dest;
  } catch (e) {
    // The download is blocked on some networks (GitHub 403 on mobile/CGNAT/
    // datacenter/Termux). A working system yt-dlp is the backup; with none,
    // surface the real download failure.
    const system = await detect();
    if (system) {
      onStatus?.("using yt-dlp from your system");
      return system;
    }
    throw e;
  }
}

let inflight: Promise<string> | null = null;
let resolvedYtDlp: string | null = null;

/**
 * The yt-dlp we actually spawn (enumeration + downloads): the bundled binary,
 * or a detected system one when the bundled download was blocked. Falls back to
 * the bundled-path math until the first ensure resolves it.
 */
export function resolvedYtDlpPath(): string {
  return resolvedYtDlp ?? ytDlpPath();
}

/**
 * Ensure a usable yt-dlp, downloading on first run only when neither a bundled
 * nor a system binary is available. Returns the resolved path. Concurrent
 * callers share one run; a failed run clears, so the next call retries fresh.
 */
export function ensureYtDlp(onStatus?: (msg: string) => void): Promise<string> {
  inflight ??= doEnsure(onStatus).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function doEnsure(onStatus?: (msg: string) => void): Promise<string> {
  if (resolvedYtDlp) return resolvedYtDlp;
  // A staged update (from the daily check) applies before first use.
  await finalizeStagedYtDlp().catch(() => false);
  resolvedYtDlp = await resolveYtDlp(onStatus);
  return resolvedYtDlp;
}
