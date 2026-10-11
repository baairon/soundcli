import { useMemo, useState } from "react";
import type { Track } from "../../../src/library/types";
import type { Ctx } from "../App";
import { formatDuration, matches } from "../format";

function SongTable({
  s,
  run,
  tracks,
  empty,
}: Ctx & { tracks: Track[]; empty: string }) {
  const playingId = s.playback.track?.id;
  const ids = tracks.map((t) => t.id);
  const go = (c: Parameters<Ctx["run"]>[0]) => void run(c).catch(() => {});
  if (tracks.length === 0) return <p className="empty">{empty}</p>;
  return (
    <ul className="songs">
      {tracks.map((t) => (
        <li key={t.id} className={t.id === playingId ? "playing" : ""}>
          <button
            className="row"
            onDoubleClick={() => go({ cmd: "play", trackId: t.id, listIds: ids })}
            onClick={() => {
              if (t.id !== playingId) go({ cmd: "play", trackId: t.id, listIds: ids });
              else go({ cmd: "togglePause" });
            }}
          >
            <span className="mark">{t.id === playingId ? "▶" : ""}</span>
            <span className="title">{t.title}</span>
            <span className="artist">{t.artist ?? ""}</span>
            <span className="dur">{formatDuration(t.durationSec)}</span>
          </button>
          <span className="actions">
            <button
              title="Rename"
              onClick={() => {
                const title = window.prompt("New title", t.title);
                if (title) go({ cmd: "renameTrack", trackId: t.id, title });
              }}
            >
              ✎
            </button>
            <button
              title="Delete file"
              onClick={() => {
                if (window.confirm(`Delete "${t.title}" from disk?`))
                  go({ cmd: "deleteTracks", trackIds: [t.id] });
              }}
            >
              🗑
            </button>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function Library(ctx: Ctx) {
  const [q, setQ] = useState("");
  const tracks = useMemo(
    () =>
      ctx.s.tracks.filter((t) => matches(q, t.title, t.artist, t.album, t.playlist)),
    [ctx.s.tracks, q],
  );
  return (
    <section>
      <header>
        <h2>Library <small>{ctx.s.tracks.length} songs</small></h2>
        <input
          type="search"
          placeholder="Search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </header>
      <SongTable {...ctx} tracks={tracks} empty="No songs yet. Add some under Download." />
    </section>
  );
}

export function Playlists(ctx: Ctx) {
  const [open, setOpen] = useState<string | null>(null);
  const groups = useMemo(() => {
    const m = new Map<string, Track[]>();
    for (const t of ctx.s.tracks) {
      const key = t.playlist ?? "Singles";
      const k = `${t.source}:${t.owner ?? ""}:${key}`;
      (m.get(k) ?? m.set(k, []).get(k)!).push(t);
    }
    for (const list of m.values())
      list.sort((a, b) => (a.playlistPos ?? 1e9) - (b.playlistPos ?? 1e9));
    return [...m.entries()];
  }, [ctx.s.tracks]);

  const sel = groups.find(([k]) => k === open);
  if (sel) {
    return (
      <section>
        <header>
          <h2>
            <button className="link" onClick={() => setOpen(null)}>← Playlists</button>{" "}
            {sel[1][0]?.playlist ?? "Singles"}
          </h2>
        </header>
        <SongTable {...ctx} tracks={sel[1]} empty="Empty." />
      </section>
    );
  }
  return (
    <section>
      <header><h2>Playlists</h2></header>
      {groups.length === 0 ? (
        <p className="empty">No playlists yet.</p>
      ) : (
        <ul className="sets">
          {groups.map(([k, list]) => (
            <li key={k}>
              <button className="row" onClick={() => setOpen(k)}>
                <span className="title">{list[0]?.playlist ?? "Singles"}</span>
                <span className="artist">{list[0]?.owner ?? list[0]?.source}</span>
                <span className="dur">{list.length}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function History(ctx: Ctx) {
  const byId = new Map(ctx.s.tracks.map((t) => [t.id, t]));
  const tracks = ctx.s.history.flatMap((id) => (byId.get(id) ? [byId.get(id)!] : []));
  return (
    <section>
      <header><h2>Recently played</h2></header>
      <SongTable {...ctx} tracks={tracks} empty="Nothing played yet." />
    </section>
  );
}
