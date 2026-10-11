import { useCallback, useEffect, useRef, useState } from "react";
import type { Snapshot } from "../../src/gui/protocol";
import { useConnection, type Connection } from "./connection";
import { Library, Playlists, History } from "./sections/Songs";
import { Download } from "./sections/Download";
import { Settings } from "./sections/Settings";
import { NowPlaying } from "./NowPlaying";

const SECTIONS = [
  ["library", "Library"],
  ["playlists", "Playlists"],
  ["history", "History"],
  ["download", "Download"],
  ["settings", "Settings"],
] as const;
type Section = (typeof SECTIONS)[number][0];

export interface Ctx {
  s: Snapshot;
  /** Run a command and show its outcome in the toast. */
  run: Connection["send"];
}

export function App() {
  const { state, online, send } = useConnection();
  const [section, setSection] = useState<Section>("library");
  const [toast, setToast] = useState<{ text: string; bad: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const run = useCallback<Connection["send"]>(
    async (c) => {
      try {
        const msg = await send(c);
        if (msg) show(msg, false);
        return msg;
      } catch (e) {
        show(e instanceof Error ? e.message : String(e), true);
        throw e;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [send],
  );
  function show(text: string, bad: boolean): void {
    setToast({ text, bad });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  }

  // Space toggles play/pause unless the user is typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, button")) return;
      if (e.key === " ") {
        e.preventDefault();
        void run({ cmd: "togglePause" }).catch(() => {});
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [run]);

  if (!state) {
    return <div className="boot">{online ? "Loading…" : "Connecting…"}</div>;
  }
  const ctx: Ctx = { s: state, run };
  const active = state.stats.pending + state.stats.downloading;

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>♪ soundcli</h1>
        <nav>
          {SECTIONS.map(([id, label]) => (
            <button
              key={id}
              className={id === section ? "on" : ""}
              onClick={() => setSection(id)}
            >
              {label}
              {id === "download" && active > 0 ? <em>{active}</em> : null}
            </button>
          ))}
        </nav>
        <footer>v{state.version}</footer>
      </aside>
      <main>
        {!online && <div className="banner bad">Disconnected, retrying…</div>}
        {state.mpvStatus && <div className="banner">{state.mpvStatus}</div>}
        {!state.config.firstRunComplete && section !== "settings" && (
          <div className="banner">
            Welcome! Paste a song link under <b>Download</b> or set your
            YouTube / SoundCloud / Spotify handle in <b>Settings</b>.{" "}
            <button
              onClick={() =>
                void run({ cmd: "setConfig", patch: { firstRunComplete: true } })
              }
            >
              Got it
            </button>
          </div>
        )}
        {section === "library" && <Library {...ctx} />}
        {section === "playlists" && <Playlists {...ctx} />}
        {section === "history" && <History {...ctx} />}
        {section === "download" && <Download {...ctx} />}
        {section === "settings" && <Settings {...ctx} />}
      </main>
      <NowPlaying {...ctx} />
      {toast && <div className={`toast ${toast.bad ? "bad" : ""}`}>{toast.text}</div>}
    </div>
  );
}
