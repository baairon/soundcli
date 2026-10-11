import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientCommand, ServerEvent, Snapshot } from "../../src/gui/protocol";

type Cmd = ClientCommand extends infer C
  ? C extends { id: number }
    ? Omit<C, "id">
    : never
  : never;

export interface Connection {
  state: Snapshot | null;
  online: boolean;
  /** Send a command; resolves with the server's message, rejects with its error. */
  send: (c: Cmd) => Promise<string | undefined>;
}

export const token = new URLSearchParams(location.search).get("token") ?? "";

/** Live mirror of the core over the WebSocket, reconnecting if it drops. */
export function useConnection(): Connection {
  const [state, setState] = useState<Snapshot | null>(null);
  const [online, setOnline] = useState(false);
  const ws = useRef<WebSocket | null>(null);
  const nextId = useRef(1);
  const pending = useRef(
    new Map<number, { ok: (m?: string) => void; fail: (e: Error) => void }>(),
  );

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = (): void => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const sock = new WebSocket(
        `${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`,
      );
      ws.current = sock;
      sock.onopen = () => setOnline(true);
      sock.onclose = () => {
        setOnline(false);
        for (const p of pending.current.values()) p.fail(new Error("Disconnected"));
        pending.current.clear();
        if (!closed) retry = setTimeout(connect, 1000);
      };
      sock.onmessage = (m) => {
        const ev = JSON.parse(m.data as string) as ServerEvent;
        if (ev.type === "result") {
          const p = pending.current.get(ev.id);
          pending.current.delete(ev.id);
          if (ev.ok) p?.ok(ev.message);
          else p?.fail(new Error(ev.message ?? "Failed"));
          return;
        }
        setState((s) => {
          if (ev.type === "snapshot") return ev.data;
          if (!s) return s;
          switch (ev.type) {
            case "playback":
              return { ...s, playback: ev.data };
            case "queue":
              return { ...s, queue: ev.data.queue, stats: ev.data.stats };
            case "library":
              return { ...s, tracks: ev.data.tracks, history: ev.data.history };
            case "mpv":
              return { ...s, mpvStatus: ev.data };
          }
        });
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      ws.current?.close();
    };
  }, []);

  const send = useCallback((c: Cmd) => {
    return new Promise<string | undefined>((resolve, reject) => {
      const sock = ws.current;
      if (!sock || sock.readyState !== WebSocket.OPEN) {
        reject(new Error("Not connected"));
        return;
      }
      const id = nextId.current++;
      pending.current.set(id, { ok: resolve, fail: reject });
      sock.send(JSON.stringify({ ...c, id }));
    });
  }, []);

  return { state, online, send };
}
