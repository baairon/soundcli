import { useEffect, useRef, useState } from "react";
import type { Ctx } from "./App";
import { token } from "./connection";
import { formatDuration } from "./format";

export function NowPlaying({ s, run }: Ctx) {
  const p = s.playback;
  const go = (c: Parameters<Ctx["run"]>[0]) => void run(c).catch(() => {});
  const t = p.track;
  const canControl = p.canControl ?? p.engine === "mpv";
  const audio = useRef<HTMLAudioElement>(null);
  const [blocked, setBlocked] = useState(false);
  const [failed, setFailed] = useState(false);
  // Always the latest state, for the audio element's event handlers.
  const live = useRef({ p, go });
  live.current = { p, go };

  const tryPlay = (): void => {
    void audio.current?.play().then(
      () => setBlocked(false),
      (e: unknown) => {
        // Autoplay can be refused before any click on the page.
        if (e instanceof DOMException && e.name === "NotAllowedError") setBlocked(true);
      },
    );
  };

  // Load the file when a track starts (playId also changes on a replay).
  useEffect(() => {
    const a = audio.current;
    if (!a || p.engine !== "browser") return;
    setFailed(false);
    if (!t) {
      a.pause();
      a.removeAttribute("src");
      a.load();
      return;
    }
    a.src = `/audio/${encodeURIComponent(t.id)}?token=${encodeURIComponent(token)}`;
    if (!live.current.p.paused) tryPlay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t?.id, p.playId, p.engine]);

  useEffect(() => {
    const a = audio.current;
    if (!a || p.engine !== "browser" || !t) return;
    if (p.paused) a.pause();
    else if (a.paused && a.src) tryPlay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.paused]);

  useEffect(() => {
    if (audio.current) audio.current.volume = p.volume / 100;
  }, [p.volume]);

  // The server moved the position (a seek): follow it. Our own reports stay
  // within a second of the element, so they never trigger this.
  useEffect(() => {
    const a = audio.current;
    if (a && p.engine === "browser" && t && Math.abs(a.currentTime - p.position) > 2) {
      a.currentTime = p.position;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.position]);

  // Hardware media keys and the browser's media widget.
  useEffect(() => {
    if (!("mediaSession" in navigator) || p.engine !== "browser") return;
    const ms = navigator.mediaSession;
    ms.metadata = t ? new MediaMetadata({ title: t.title, artist: t.artist ?? "", album: t.album ?? "" }) : null;
    ms.setActionHandler("play", () => go({ cmd: "togglePause" }));
    ms.setActionHandler("pause", () => go({ cmd: "togglePause" }));
    ms.setActionHandler("nexttrack", () => go({ cmd: "next" }));
    ms.setActionHandler("previoustrack", () => go({ cmd: "prev" }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t?.id, p.engine]);

  const lastReport = useRef(0);
  const seekTo = (sec: number): void => {
    const a = audio.current;
    if (p.engine === "browser" && a && t) {
      a.currentTime = sec;
      go({ cmd: "report", trackId: t.id, position: sec, duration: a.duration });
    } else {
      go({ cmd: "seek", seconds: sec - p.position });
    }
  };

  return (
    <footer className="now">
      {p.engine === "browser" && (
        <audio
          ref={audio}
          preload="auto"
          onTimeUpdate={(e) => {
            const cur = live.current.p.track;
            const now = Date.now();
            if (!cur || now - lastReport.current < 500) return;
            lastReport.current = now;
            const a = e.currentTarget;
            live.current.go({
              cmd: "report",
              trackId: cur.id,
              position: a.currentTime,
              duration: a.duration,
            });
          }}
          onLoadedMetadata={(e) => {
            const cur = live.current.p.track;
            if (cur) {
              live.current.go({
                cmd: "report",
                trackId: cur.id,
                position: 0,
                duration: e.currentTarget.duration,
              });
            }
          }}
          onEnded={() => {
            const cur = live.current.p.track;
            if (cur) live.current.go({ cmd: "ended", trackId: cur.id });
          }}
          onError={() => setFailed(true)}
        />
      )}
      <div className="meta">
        {t ? (
          <>
            <b>{t.title}</b>
            <span>
              {failed
                ? "This browser can't play this file."
                : blocked
                  ? "Press play to start the sound."
                  : (t.artist ?? "")}
            </span>
          </>
        ) : (
          <span>Nothing playing</span>
        )}
      </div>
      <div className="transport">
        <div className="buttons">
          <button title="Shuffle" className={p.shuffle ? "on" : ""} onClick={() => go({ cmd: "toggleShuffle" })}>⤨</button>
          <button title="Previous" disabled={!t} onClick={() => go({ cmd: "prev" })}>⏮</button>
          <button title="Play / pause (space)" disabled={!t} onClick={() => {
            if (blocked) tryPlay();
            else go({ cmd: "togglePause" });
          }}>
            {p.paused || !t ? "▶" : "⏸"}
          </button>
          <button title="Next" disabled={!t} onClick={() => go({ cmd: "next" })}>⏭</button>
          <button
            title={`Repeat: ${p.repeat}`}
            className={p.repeat !== "off" ? "on" : ""}
            onClick={() => go({ cmd: "cycleRepeat" })}
          >
            {p.repeat === "one" ? "🔂" : "🔁"}
          </button>
        </div>
        <div className="seek">
          <span>{formatDuration(p.position)}</span>
          <input
            type="range"
            min={0}
            max={Math.max(p.duration, 1)}
            value={Math.min(p.position, Math.max(p.duration, 1))}
            disabled={!t || !canControl}
            onChange={(e) => seekTo(Number(e.target.value))}
          />
          <span>{formatDuration(p.duration)}</span>
        </div>
      </div>
      <div className="volume">
        🔊
        <input
          type="range"
          min={0}
          max={100}
          value={p.volume}
          disabled={!canControl}
          onChange={(e) => go({ cmd: "setVolume", volume: Number(e.target.value) })}
        />
      </div>
    </footer>
  );
}
