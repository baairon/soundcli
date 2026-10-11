import { useState } from "react";
import type { Ctx } from "../App";
import { formatSpeed } from "../format";

export function Download({ s, run }: Ctx) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const go = (c: Parameters<Ctx["run"]>[0]) => void run(c).catch(() => {});
  const st = s.stats;

  async function add(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!url.trim() || busy) return;
    setBusy(true);
    try {
      await run({ cmd: "enqueueUrl", url: url.trim() });
      setUrl("");
    } catch {
      // the toast already shows why
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <header><h2>Download</h2></header>
      <form className="add" onSubmit={add}>
        <input
          placeholder="Paste a YouTube, SoundCloud or Spotify song link"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <button disabled={busy || !url.trim()}>{busy ? "Resolving…" : "Add"}</button>
      </form>
      <div className="toolbar">
        <span>
          {st.downloading} downloading · {st.pending} waiting · {st.done} done
          {st.failed ? ` · ${st.failed} failed` : ""}
        </span>
        <button onClick={() => go({ cmd: "queuePauseAll" })}>Pause all</button>
        <button onClick={() => go({ cmd: "queueResumeAll" })}>Resume all</button>
        <button onClick={() => go({ cmd: "queueRetryFailed" })}>Retry failed</button>
        <button onClick={() => go({ cmd: "queueClearFinished" })}>Clear finished</button>
      </div>
      {s.queue.length === 0 ? (
        <p className="empty">Queue is empty.</p>
      ) : (
        <ul className="queue">
          {s.queue.map((it) => (
            <li key={it.id} className={it.status}>
              <span className="title">{it.track.title}</span>
              <span className="artist">{it.sourceLabel}</span>
              <span className="state">
                {it.status === "downloading"
                  ? `${Math.round(it.percent)}% ${formatSpeed(it.speed)}`
                  : (it.error ?? it.status)}
              </span>
              <progress max={100} value={it.status === "done" ? 100 : it.percent} />
              <span className="actions">
                {it.status === "downloading" && (
                  <button onClick={() => go({ cmd: "queuePause", itemId: it.id })}>⏸</button>
                )}
                {it.status === "paused" && (
                  <button onClick={() => go({ cmd: "queueResume", itemId: it.id })}>▶</button>
                )}
                {(it.status === "downloading" ||
                  it.status === "pending" ||
                  it.status === "paused") && (
                  <button onClick={() => go({ cmd: "queueCancel", itemId: it.id })}>✕</button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
