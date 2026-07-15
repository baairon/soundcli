import { spawn } from "node:child_process";

/** Spawn fire-and-forget. A missing binary (e.g. no xdg-open on a minimal
 *  Linux) surfaces as an async "error" event on the child; with no listener
 *  Node crashes the whole process, so the no-op listener is load-bearing. */
function spawnDetached(cmd: string, args: string[]): void {
  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

/**
 * Open a file or folder with the OS default handler (Explorer, Finder, or
 * the desktop's file manager). Never throws, never blocks: sync failures are
 * caught here and async spawn failures die in spawnDetached's listener.
 */
export function openPath(target: string): void {
  try {
    if (process.platform === "win32") {
      spawnDetached("cmd", ["/c", "start", "", target]);
    } else if (process.platform === "darwin") {
      spawnDetached("open", [target]);
    } else {
      spawnDetached("xdg-open", [target]);
    }
  } catch {
    // best effort
  }
}
