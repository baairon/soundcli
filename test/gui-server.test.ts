import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { App } from "../src/core/createApp";
import {
  hostAllowed,
  originAllowed,
  startGuiServer,
  tokenMatches,
  type GuiServer,
} from "../src/gui/server";
import type { ServerEvent } from "../src/gui/protocol";

const audioDir = mkdtempSync(path.join(os.tmpdir(), "gui-audio-"));
const audioFile = path.join(audioDir, "a.mp3");
writeFileSync(audioFile, Buffer.from("0123456789"));
const track = { id: "youtube:a", title: "Song", filePath: audioFile };

function fakeApp() {
  const playback = Object.assign(new EventEmitter(), {
    getState: () => ({ track: null, paused: true, position: 0, duration: 0, volume: 50, repeat: "off" }),
    togglePause: vi.fn(async () => {}),
    seek: vi.fn(async () => {}),
    play: vi.fn(async () => {}),
    reportBrowser: vi.fn(),
    browserEnded: vi.fn(async () => {}),
  });
  const queue = Object.assign(new EventEmitter(), {
    getItems: () => [],
    stats: () => ({ total: 0 }),
    pause: vi.fn(),
  });
  const library = {
    all: () => [track],
    get: (id: string) => (id === track.id ? track : undefined),
    onChange: () => () => {},
  };
  const app = {
    config: { libraryDir: "/x", firstRunComplete: true },
    library,
    queue,
    playback,
    history: { ids: () => ["youtube:a"] },
  };
  return { app: app as unknown as App, playback, queue };
}

let server: GuiServer | null = null;
const sockets: WebSocket[] = [];

async function open(url: string, origin?: string): Promise<WebSocket> {
  const ws = new WebSocket(url, origin ? { origin } : undefined);
  sockets.push(ws);
  await new Promise<void>((res, rej) => {
    ws.once("open", () => res());
    ws.once("error", rej);
    ws.once("unexpected-response", (_r, resp) => rej(new Error(`HTTP ${resp.statusCode}`)));
  });
  return ws;
}

function nextMsg(ws: WebSocket, pred: (e: ServerEvent) => boolean): Promise<ServerEvent> {
  return new Promise((res) => {
    const on = (d: WebSocket.RawData) => {
      const e = JSON.parse(d.toString()) as ServerEvent;
      if (pred(e)) {
        ws.off("message", on);
        res(e);
      }
    };
    ws.on("message", on);
  });
}

let webRoot: string;
beforeEach(() => {
  webRoot = mkdtempSync(path.join(os.tmpdir(), "gui-web-"));
  writeFileSync(path.join(webRoot, "index.html"), "<html>hi</html>");
});
afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await server?.close();
  server = null;
});

describe("guards", () => {
  it("compares tokens", () => {
    expect(tokenMatches("abc", "abc")).toBe(true);
    expect(tokenMatches("abd", "abc")).toBe(false);
    expect(tokenMatches(null, "abc")).toBe(false);
    expect(tokenMatches("ab", "abc")).toBe(false);
  });
  it("only allows our own loopback origin and host", () => {
    expect(originAllowed(undefined, 5)).toBe(true);
    expect(originAllowed("http://127.0.0.1:5", 5)).toBe(true);
    expect(originAllowed("http://evil.com", 5)).toBe(false);
    expect(originAllowed("http://127.0.0.1:6", 5)).toBe(false);
    expect(hostAllowed("127.0.0.1:5", 5)).toBe(true);
    expect(hostAllowed("evil.com:5", 5)).toBe(false);
  });
});

describe("gui server", () => {
  it("serves the page only with the token", async () => {
    const { app } = fakeApp();
    server = await startGuiServer({ app, webRoot, version: "1" });
    const base = `http://127.0.0.1:${server.port}`;
    expect((await fetch(`${base}/`)).status).toBe(403);
    const ok = await fetch(`${base}/?token=${server.token}`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("hi");
    expect((await fetch(`${base}/../../etc/passwd`)).status).not.toBe(200);
  });

  it("rejects websockets with a bad token or foreign origin", async () => {
    const { app } = fakeApp();
    server = await startGuiServer({ app, webRoot, version: "1" });
    const base = `ws://127.0.0.1:${server.port}/ws`;
    await expect(open(`${base}?token=nope`)).rejects.toThrow();
    await expect(
      open(`${base}?token=${server.token}`, "http://evil.com"),
    ).rejects.toThrow();
  });

  it("sends a snapshot, then forwards playback and runs commands", async () => {
    const { app, playback } = fakeApp();
    server = await startGuiServer({ app, webRoot, version: "9" });
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${server.token}`);
    sockets.push(ws);
    const snap = await nextMsg(ws, (e) => e.type === "snapshot");
    expect(snap).toMatchObject({ data: { version: "9", history: ["youtube:a"] } });

    const pb = nextMsg(ws, (e) => e.type === "playback");
    playback.emit("state");
    expect(await pb).toMatchObject({ type: "playback" });

    const res = nextMsg(ws, (e) => e.type === "result");
    ws.send(JSON.stringify({ id: 7, cmd: "togglePause" }));
    expect(await res).toEqual({ type: "result", id: 7, ok: true });
    expect(playback.togglePause).toHaveBeenCalled();

    const bad = nextMsg(ws, (e) => e.type === "result");
    ws.send(JSON.stringify({ id: 8, cmd: "play", trackId: "missing" }));
    expect(await bad).toMatchObject({ id: 8, ok: false });
    expect(playback.play).not.toHaveBeenCalled();
  });

  it("throttles queue updates into one broadcast", async () => {
    const { app, queue } = fakeApp();
    server = await startGuiServer({ app, webRoot, version: "1", queueThrottleMs: 30 });
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${server.token}`);
    sockets.push(ws);
    await nextMsg(ws, (e) => e.type === "snapshot");
    let count = 0;
    ws.on("message", (d) => {
      if ((JSON.parse(d.toString()) as ServerEvent).type === "queue") count++;
    });
    for (let i = 0; i < 20; i++) queue.emit("update");
    await new Promise((r) => setTimeout(r, 120));
    expect(count).toBe(1);
  });

  it("streams audio with ranges, only with the token and a library id", async () => {
    const { app } = fakeApp();
    server = await startGuiServer({ app, webRoot, version: "1" });
    const base = `http://127.0.0.1:${server.port}/audio/${encodeURIComponent(track.id)}`;
    const t = `?token=${server.token}`;
    expect((await fetch(base)).status).toBe(403);
    expect((await fetch(`http://127.0.0.1:${server.port}/audio/nope${t}`)).status).toBe(404);

    const full = await fetch(base + t);
    expect(full.status).toBe(200);
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    expect(await full.text()).toBe("0123456789");

    const part = await fetch(base + t, { headers: { range: "bytes=2-4" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 2-4/10");
    expect(await part.text()).toBe("234");

    const tail = await fetch(base + t, { headers: { range: "bytes=-3" } });
    expect(await tail.text()).toBe("789");
    const bad = await fetch(base + t, { headers: { range: "bytes=50-" } });
    expect(bad.status).toBe(416);
  });

  it("routes the page's position reports and end-of-track to playback", async () => {
    const { app, playback } = fakeApp();
    server = await startGuiServer({ app, webRoot, version: "1" });
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${server.token}`);
    sockets.push(ws);
    await nextMsg(ws, (e) => e.type === "snapshot");
    const r1 = nextMsg(ws, (e) => e.type === "result");
    ws.send(JSON.stringify({ id: 1, cmd: "report", trackId: "youtube:a", position: 3.5, duration: 10 }));
    await r1;
    expect(playback.reportBrowser).toHaveBeenCalledWith("youtube:a", 3.5, 10);
    const r2 = nextMsg(ws, (e) => e.type === "result");
    ws.send(JSON.stringify({ id: 2, cmd: "ended", trackId: "youtube:a" }));
    await r2;
    expect(playback.browserEnded).toHaveBeenCalledWith("youtube:a");
  });
});
