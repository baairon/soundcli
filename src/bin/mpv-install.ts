import { execa } from "execa";
import { detectMpv, writeMpvCache } from "./binaries";

/**
 * Make sure mpv is available, installing it automatically if we can. Returns the
 * mpv path/command if available afterwards, else null (caller falls back to the
 * OS default audio app). Best-effort and non-fatal: any failure returns null.
 */
export async function ensureMpvInstalled(
  onStatus?: (msg: string) => void,
): Promise<string | null> {
  const existing = await detectMpv();
  if (existing) {
    await writeMpvCache(existing);
    return existing;
  }

  try {
    if (process.platform === "win32") {
      onStatus?.("setting up the player…");
      await execa(
        "winget",
        [
          "install",
          "--id",
          "shinchiro.mpv",
          "-e",
          "--source",
          "winget",
          "--accept-source-agreements",
          "--accept-package-agreements",
          "--disable-interactivity",
          // --force reinstalls even if winget holds an orphaned "installed"
          // record whose files are missing (otherwise it exits without placing
          // the binary and mpv stays undetectable).
          "--force",
        ],
        { timeout: 300_000 },
      );
    } else if (process.platform === "darwin") {
      onStatus?.("setting up the player…");
      await execa("brew", ["install", "mpv"], { timeout: 300_000 });
    } else {
      // Linux installs typically need sudo; skip auto-install and fall back.
      return null;
    }
  } catch {
    return null;
  }

  const found = await detectMpv();
  // A successful install seeds the cache, so the next launch skips the sweep.
  if (found) await writeMpvCache(found);
  return found;
}
