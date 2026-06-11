import { spawn } from "node:child_process";

/**
 * Open a file or folder with the OS default handler (Explorer, Finder, or
 * the desktop's file manager). Fire-and-forget: never throws, never blocks.
 */
export function openPath(target: string): void {
  try {
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", target], {
        detached: true,
        stdio: "ignore",
      }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [target], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [target], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    // best effort
  }
}
