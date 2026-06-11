import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

/** How long to wait for the IPC socket/pipe before giving up on mpv. */
const CONNECT_TIMEOUT_MS = 5000;
/** Delay between connection retries while mpv is still warming up. */
const CONNECT_RETRY_MS = 100;

/**
 * Controls an mpv process over its JSON IPC channel (a Windows named pipe or a
 * unix socket). Emits:
 *   "property" (name, data): an observed property changed (time-pos/duration/pause/volume)
 *   "ended": current file reached its natural end
 *   "quit": mpv exited (after an unexpected mid-session exit, the next command respawns it)
 *
 * The process is started lazily on the first command and is auto-respawned if it
 * dies while we are still using it, so a crash does not permanently break playback.
 */
export class MpvPlayer extends EventEmitter {
  private proc: ChildProcess | null = null;
  private sock: net.Socket | null = null;
  private readonly mpvPath: string;
  private ipcPath: string;
  private reqId = 1;
  private readonly pending = new Map<number, Pending>();
  private buf = "";
  private ready: Promise<void> | null = null;
  /** Initial volume (0..100) applied every time mpv (re)starts. */
  private initialVolume = 100;
  /** Set once quit() runs so a stray exit event is not treated as a crash. */
  private quitting = false;
  /**
   * True only while a file is actually loaded. mpv replies "error running
   * command" if it gets a seek / pause while idle (between tracks, mid-load,
   * after the last track, after stop), so transport commands are gated on this.
   */
  private loaded = false;

  constructor(mpvPath: string) {
    super();
    this.mpvPath = mpvPath;
    this.ipcPath = MpvPlayer.makeIpcPath();
  }

  /** Build a fresh, unique IPC endpoint (named pipe on Windows, socket on unix). */
  private static makeIpcPath(): string {
    const tag = `${process.pid}-${Date.now()}`;
    return process.platform === "win32"
      ? `\\\\.\\pipe\\soundcli-mpv-${tag}`
      : path.join(os.tmpdir(), `soundcli-mpv-${tag}.sock`);
  }

  /**
   * Set the volume mpv should start at. Takes effect on the next (re)spawn and,
   * if mpv is already running, is applied immediately (best effort).
   */
  setInitialVolume(volume: number): void {
    this.initialVolume = Math.max(0, Math.min(100, Math.round(volume)));
    if (this.sock) void this.write(["set_property", "volume", this.initialVolume]).catch(() => undefined);
  }

  /**
   * Forget the current process/socket so the next command starts mpv fresh.
   * Used both on an unexpected exit (auto-respawn) and during teardown.
   */
  private resetConnection(): void {
    this.loaded = false;
    if (this.sock) {
      try {
        this.sock.destroy();
      } catch {
        // ignore
      }
    }
    this.sock = null;
    this.ready = null;
    this.buf = "";
    // Fail any in-flight requests so awaiters do not hang forever.
    for (const [, p] of this.pending) p.reject(new Error("mpv connection reset"));
    this.pending.clear();
    // On unix the socket file lingers; best-effort unlink before the next spawn.
    this.unlinkSocket();
    // Each respawn gets a brand-new endpoint to avoid colliding with a stale one.
    this.ipcPath = MpvPlayer.makeIpcPath();
  }

  /** Best-effort removal of the unix socket file (no-op on Windows pipes). */
  private unlinkSocket(): void {
    if (process.platform === "win32") return;
    try {
      fs.rmSync(this.ipcPath, { force: true });
    } catch {
      // ignore
    }
  }

  private ensureStarted(): Promise<void> {
    if (this.ready) return this.ready;
    this.quitting = false;
    this.ready = new Promise<void>((resolve, reject) => {
      let settled = false;
      const proc = spawn(
        this.mpvPath,
        [
          "--idle=yes",
          "--no-video",
          "--no-terminal",
          "--really-quiet",
          `--volume=${this.initialVolume}`,
          `--input-ipc-server=${this.ipcPath}`,
        ],
        { stdio: "ignore" },
      );
      this.proc = proc;
      proc.on("error", (err) => {
        if (settled) return;
        settled = true;
        reject(err instanceof Error ? err : new Error(String(err)));
      });
      proc.on("exit", () => {
        // Distinguish a clean shutdown from a mid-session crash.
        if (this.quitting) {
          this.emit("quit");
          return;
        }
        // Unexpected exit: drop state so the next command respawns mpv.
        this.resetConnection();
        this.emit("quit");
      });

      const deadline = Date.now() + CONNECT_TIMEOUT_MS;
      const tryConnect = (): void => {
        if (settled) return;
        const sock = net.connect(this.ipcPath);
        sock.on("connect", () => {
          if (settled) {
            sock.destroy();
            return;
          }
          settled = true;
          this.sock = sock;
          sock.setEncoding("utf8");
          sock.on("data", (d: string) => this.onData(d));
          sock.on("error", () => undefined);
          this.setupObservers();
          // Make sure the configured volume is honored even if --volume was ignored.
          void this.write(["set_property", "volume", this.initialVolume]).catch(
            () => undefined,
          );
          resolve();
        });
        sock.on("error", () => {
          sock.destroy();
          if (settled) return;
          if (Date.now() >= deadline) {
            settled = true;
            reject(new Error("could not connect to mpv IPC (timed out)"));
            return;
          }
          setTimeout(tryConnect, CONNECT_RETRY_MS);
        });
      };
      tryConnect();
    });
    // If the start fails, clear the cached promise so a later call can retry.
    this.ready.catch(() => {
      if (this.ready) this.ready = null;
    });
    return this.ready;
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof msg.event === "string") {
        if (msg.event === "property-change") {
          this.emit("property", msg.name as string, msg.data);
        } else if (
          msg.event === "end-file" &&
          (msg.reason === "eof" || msg.reason === "end")
        ) {
          this.loaded = false;
          this.emit("ended");
        }
      } else if (typeof msg.request_id === "number") {
        const p = this.pending.get(msg.request_id);
        if (p) {
          this.pending.delete(msg.request_id);
          if (msg.error && msg.error !== "success") {
            p.reject(new Error(String(msg.error)));
          } else {
            p.resolve(msg.data);
          }
        }
      }
    }
  }

  private setupObservers(): void {
    this.write(["observe_property", 1, "time-pos"]).catch(() => undefined);
    this.write(["observe_property", 2, "duration"]).catch(() => undefined);
    this.write(["observe_property", 3, "pause"]).catch(() => undefined);
    // Observe volume too, so external volume changes surface in the now-playing bar.
    this.write(["observe_property", 4, "volume"]).catch(() => undefined);
  }

  /** Low-level write without waiting on the start handshake. */
  private write(command: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.sock) {
        reject(new Error("mpv not connected"));
        return;
      }
      const id = this.reqId++;
      this.pending.set(id, { resolve, reject });
      this.sock.write(JSON.stringify({ command, request_id: id }) + "\n");
    });
  }

  async command(command: unknown[]): Promise<unknown> {
    await this.ensureStarted();
    return this.write(command);
  }

  async loadFile(file: string, startPaused = false): Promise<void> {
    await this.command(["loadfile", file, "replace"]);
    this.loaded = true;
    await this.command(["set_property", "pause", startPaused]);
  }

  async togglePause(): Promise<void> {
    if (!this.loaded) return; // nothing loaded → mpv would reject "cycle pause"
    await this.command(["cycle", "pause"]);
  }

  async seekRelative(seconds: number): Promise<void> {
    if (!this.loaded) return; // can't seek an idle player
    await this.command(["seek", seconds, "relative"]);
  }

  /** Absolute seek to a position in seconds (clamped by mpv to the file length). */
  async seekAbsolute(seconds: number): Promise<void> {
    if (!this.loaded) return;
    await this.command(["seek", seconds, "absolute"]);
  }

  /** Set the absolute volume (caller clamps to 0..100). */
  async setVolume(volume: number): Promise<void> {
    await this.command(["set_property", "volume", volume]);
  }

  async getVolume(): Promise<number> {
    const v = await this.command(["get_property", "volume"]);
    return typeof v === "number" ? v : 100;
  }

  /** Stop playback and unload the current file without killing the process. */
  async stop(): Promise<void> {
    this.loaded = false;
    await this.command(["stop"]);
  }

  /**
   * Tear down cleanly: tell mpv to quit, destroy the socket, kill the process,
   * and (on unix) unlink the socket file. Safe to call more than once.
   */
  quit(): void {
    this.quitting = true;
    this.loaded = false;
    try {
      this.sock?.write(JSON.stringify({ command: ["quit"] }) + "\n");
    } catch {
      // ignore
    }
    try {
      this.sock?.destroy();
    } catch {
      // ignore
    }
    this.sock = null;
    for (const [, p] of this.pending) p.reject(new Error("mpv quit"));
    this.pending.clear();
    try {
      this.proc?.kill();
    } catch {
      // ignore
    }
    this.proc = null;
    this.ready = null;
    this.buf = "";
    this.unlinkSocket();
  }
}
