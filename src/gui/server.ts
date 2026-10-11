// Local web GUI server: serves the built web page and a WebSocket that mirrors
// the core (library, queue, playback) to the browser and applies its commands.
// Bound to loopback with a per-launch token, because it drives a process that
// spawns downloaders and a player.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { saveConfig, type Config } from "../config/config";
import type { App } from "../core/createApp";
import { deleteTracks } from "../library/delete";
import { renameTrack } from "../library/rename";
import { detectPasteLink } from "../sources/detect";
import { sourceLabel, tracksFromUrl } from "../sources/enqueue-url";
import type {
  ClientCommand,
  ServerEvent,
  Snapshot,
} from "./protocol";

export interface GuiServerOptions {
  app: App;
  /** Directory holding the built web page (index.html + assets). */
  webRoot: string;
  version: string;
  port?: number;
  /** Min ms between queue broadcasts (download progress is chatty). */
  queueThrottleMs?: number;
}

export interface GuiServer {
  /** URL to open, including the access token. */
  url: string;
  port: number;
  token: string;
  close(): Promise<void>;
  /** Push a status line (mpv install progress) to connected pages. */
  setMpvStatus(text: string | null): void;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const AUDIO_MIME: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".mp4": "audio/mp4",
  ".aac": "audio/aac",
  ".opus": "audio/ogg; codecs=opus",
  ".ogg": "audio/ogg",
  ".webm": "audio/webm",
  ".flac": "audio/flac",
  ".wav": "audio/wav",
};

export function tokenMatches(given: string | null, token: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Origin must be our own loopback origin (or absent, for non-browser clients). */
export function originAllowed(
  origin: string | undefined,
  port: number,
): boolean {
  if (!origin) return true;
  return (
    origin === `http://127.0.0.1:${port}` ||
    origin === `http://localhost:${port}`
  );
}

export function hostAllowed(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

export async function startGuiServer(
  opts: GuiServerOptions,
): Promise<GuiServer> {
  const { app, webRoot, version } = opts;
  const token = randomBytes(24).toString("hex");
  const throttle = opts.queueThrottleMs ?? 150;
  let port = 0;
  let mpvStatus: string | null = null;

  const snapshot = (): Snapshot => ({
    tracks: app.library.all(),
    queue: app.queue.getItems(),
    stats: app.queue.stats(),
    playback: app.playback.getState(),
    history: app.history.ids(),
    config: app.config,
    mpvStatus,
    version,
  });

  const clients = new Set<WebSocket>();
  const send = (ws: WebSocket, ev: ServerEvent): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(ev));
  };
  const broadcast = (ev: ServerEvent): void => {
    if (clients.size === 0) return;
    const raw = JSON.stringify(ev);
    for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(raw);
  };

  // Core -> pages.
  const onPlayback = (): void =>
    broadcast({ type: "playback", data: app.playback.getState() });
  app.playback.on("state", onPlayback);

  let queueTimer: ReturnType<typeof setTimeout> | null = null;
  const flushQueue = (): void => {
    queueTimer = null;
    broadcast({
      type: "queue",
      data: { queue: app.queue.getItems(), stats: app.queue.stats() },
    });
  };
  const onQueue = (): void => {
    if (!queueTimer) queueTimer = setTimeout(flushQueue, throttle);
  };
  app.queue.on("update", onQueue);

  let libTimer: ReturnType<typeof setTimeout> | null = null;
  const unsubLibrary = app.library.onChange(() => {
    if (libTimer) return;
    libTimer = setTimeout(() => {
      libTimer = null;
      broadcast({
        type: "library",
        data: { tracks: app.library.all(), history: app.history.ids() },
      });
    }, throttle);
  });

  const trackList = (ids: string[] | undefined) =>
    (ids ?? []).flatMap((id) => {
      const t = app.library.get(id);
      return t ? [t] : [];
    });

  async function run(c: ClientCommand): Promise<string | void> {
    const pb = app.playback;
    switch (c.cmd) {
      case "play": {
        const t = app.library.get(c.trackId);
        if (!t) throw new Error("That song isn't in the library.");
        const list = trackList(c.listIds);
        await pb.play(t, list.length ? list : [t]);
        return;
      }
      case "togglePause":
        return pb.togglePause();
      case "report":
        return pb.reportBrowser(c.trackId, Number(c.position), Number(c.duration));
      case "ended":
        return pb.browserEnded(c.trackId);
      case "seek":
        return pb.seek(c.seconds);
      case "setVolume":
        return pb.setVolume(c.volume);
      case "next":
        return pb.next();
      case "prev":
        return pb.prev();
      case "stop":
        return pb.stop();
      case "cycleRepeat":
        return pb.cycleRepeat();
      case "toggleShuffle":
        return pb.toggleShuffle();
      case "enqueueUrl": {
        const d = detectPasteLink(c.url);
        if (!d.ok) throw new Error(d.reason);
        const tracks = await tracksFromUrl(d.source, d.url);
        if (tracks.length === 0) throw new Error("Nothing found at that link.");
        if (tracks.length > 1) {
          throw new Error("That's a whole playlist · paste one song's link.");
        }
        const r = app.queue.enqueue(
          tracks.map((track) => ({
            source: d.source,
            sourceLabel: sourceLabel(d.source),
            track,
          })),
        );
        return r.added > 0 ? "Added to the queue." : "Already saved.";
      }
      case "queuePause":
        return app.queue.pause(c.itemId);
      case "queueResume":
        return app.queue.resume(c.itemId);
      case "queueCancel":
        return app.queue.cancel(c.itemId);
      case "queuePauseAll":
        return app.queue.pauseAll();
      case "queueResumeAll":
        return app.queue.resumeAll();
      case "queueRetryFailed":
        return app.queue.retryFailed();
      case "queueClearFinished":
        return app.queue.clearFinished();
      case "deleteTracks": {
        const victims = trackList(c.trackIds);
        const playing = pb.getState().track?.id;
        // mpv holds the file open; Windows refuses to unlink it.
        if (playing && victims.some((t) => t.id === playing)) await pb.stop();
        const r = await deleteTracks(app.library, victims, app.config.libraryDir);
        return r.failed
          ? `Removed ${r.removed}, ${r.failed} couldn't be deleted.`
          : `Removed ${r.removed}.`;
      }
      case "renameTrack": {
        const t = app.library.get(c.trackId);
        if (!t) throw new Error("That song isn't in the library.");
        const r = await renameTrack(app.library, t, c.title);
        if (r === "collision") throw new Error("A file with that name exists.");
        if (r === "failed") throw new Error("Couldn't rename the file.");
        return;
      }
      case "setConfig": {
        const next: Config = { ...app.config, ...c.patch };
        Object.assign(app.config, next);
        app.queue.updateConfig(app.config);
        await saveConfig(app.config);
        broadcast({ type: "snapshot", data: snapshot() });
        return;
      }
    }
  }

  async function onMessage(ws: WebSocket, raw: string): Promise<void> {
    let c: ClientCommand;
    try {
      c = JSON.parse(raw) as ClientCommand;
    } catch {
      return;
    }
    if (typeof c?.id !== "number" || typeof c.cmd !== "string") return;
    try {
      const message = await run(c);
      send(ws, { type: "result", id: c.id, ok: true, message: message || undefined });
    } catch (e) {
      send(ws, {
        type: "result",
        id: c.id,
        ok: false,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const root = path.resolve(webRoot);

  // Stream a library file to the page's <audio>. The path comes from the
  // library entry for the id, never from the request. Range support is what
  // makes seeking work.
  function serveAudio(req: IncomingMessage, res: ServerResponse, url: URL): void {
    if (!tokenMatches(url.searchParams.get("token"), token)) {
      res.writeHead(403).end();
      return;
    }
    let id: string;
    try {
      id = decodeURIComponent(url.pathname.slice("/audio/".length));
    } catch {
      res.writeHead(400).end();
      return;
    }
    const track = app.library.get(id);
    let size = 0;
    try {
      if (!track) throw new Error("unknown");
      const st = statSync(track.filePath);
      if (!st.isFile()) throw new Error("not a file");
      size = st.size;
    } catch {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
      return;
    }
    const type = AUDIO_MIME[path.extname(track!.filePath).toLowerCase()] ?? "application/octet-stream";
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    let start = 0;
    let end = size - 1;
    let status = 200;
    if (m && (m[1] || m[2])) {
      if (m[1]) {
        start = Number(m[1]);
        if (m[2]) end = Math.min(Number(m[2]), size - 1);
      } else {
        start = Math.max(0, size - Number(m[2]));
      }
      if (start > end || start >= size) {
        res.writeHead(416, { "content-range": `bytes */${size}` }).end();
        return;
      }
      status = 206;
    }
    res.writeHead(status, {
      "content-type": type,
      "content-length": end - start + 1,
      "accept-ranges": "bytes",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...(status === 206 ? { "content-range": `bytes ${start}-${end}/${size}` } : {}),
    });
    if (req.method === "HEAD" || size === 0) {
      res.end();
      return;
    }
    const stream = createReadStream(track!.filePath, { start, end });
    stream.on("error", () => res.destroy());
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  }

  function serveStatic(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
      return;
    }
    if (url.pathname.startsWith("/audio/")) {
      serveAudio(req, res, url);
      return;
    }
    // The page itself needs the token; assets are public but useless alone.
    if (url.pathname === "/" || url.pathname === "/index.html") {
      if (!tokenMatches(url.searchParams.get("token"), token)) {
        res.writeHead(403, { "content-type": "text/plain" });
        res.end("Open the link printed by sndcli --gui.");
        return;
      }
    }
    const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = path.resolve(root, rel);
    if (
      (file !== root && !file.startsWith(root + path.sep)) ||
      !existsSync(file) ||
      !statSync(file).isFile()
    ) {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    if (req.method === "HEAD") res.end();
    else createReadStream(file).pipe(res);
  }

  const server: Server = createServer((req, res) => {
    if (!hostAllowed(req.headers.host, port)) {
      res.writeHead(403).end();
      return;
    }
    serveStatic(req, res);
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://x");
    const ok =
      url.pathname === "/ws" &&
      hostAllowed(req.headers.host, port) &&
      originAllowed(req.headers.origin, port) &&
      tokenMatches(url.searchParams.get("token"), token);
    if (!ok) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      ws.on("close", () => clients.delete(ws));
      ws.on("error", () => clients.delete(ws));
      ws.on("message", (d) => void onMessage(ws, d.toString()));
      send(ws, { type: "snapshot", data: snapshot() });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", resolve);
  });
  port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/?token=${token}`,
    port,
    token,
    setMpvStatus(text) {
      mpvStatus = text;
      broadcast({ type: "mpv", data: text });
    },
    async close() {
      app.playback.off("state", onPlayback);
      app.queue.off("update", onQueue);
      unsubLibrary();
      if (queueTimer) clearTimeout(queueTimer);
      if (libTimer) clearTimeout(libTimer);
      for (const ws of clients) ws.terminate();
      wss.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
