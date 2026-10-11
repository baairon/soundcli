import { useState } from "react";
import type { Config } from "../../../src/config/config";
import type { Ctx } from "../App";

type TextKey = "youtubeHandle" | "soundcloudHandle" | "spotifyHandle";
const HANDLES: [TextKey, string][] = [
  ["youtubeHandle", "YouTube handle"],
  ["soundcloudHandle", "SoundCloud handle"],
  ["spotifyHandle", "Spotify username"],
];

export function Settings({ s, run }: Ctx) {
  const c = s.config;
  const [draft, setDraft] = useState<Partial<Config>>({});
  const val = <K extends keyof Config>(k: K): Config[K] =>
    (k in draft ? draft[k] : c[k]) as Config[K];
  const dirty = Object.keys(draft).length > 0;

  return (
    <section>
      <header><h2>Settings</h2></header>
      <form
        className="settings"
        onSubmit={(e) => {
          e.preventDefault();
          void run({ cmd: "setConfig", patch: draft })
            .then(() => setDraft({}))
            .catch(() => {});
        }}
      >
        {HANDLES.map(([k, label]) => (
          <label key={k}>
            {label}
            <input
              value={val(k) ?? ""}
              onChange={(e) => setDraft({ ...draft, [k]: e.target.value || undefined })}
            />
          </label>
        ))}
        <label>
          Download format
          <select
            value={val("audioFormat") ?? "m4a"}
            onChange={(e) =>
              setDraft({ ...draft, audioFormat: e.target.value as Config["audioFormat"] })
            }
          >
            <option value="m4a">m4a: never re-encoded</option>
            <option value="mp3">mp3: maximum compatibility</option>
            <option value="opus">opus: smallest</option>
          </select>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={val("ytdlpAutoUpdate") !== false}
            onChange={(e) => setDraft({ ...draft, ytdlpAutoUpdate: e.target.checked })}
          />
          Keep yt-dlp up to date
        </label>
        <p className="hint">
          Library folder: <code>{c.libraryDir}</code> (change it from the terminal
          app, which can move your files safely).
        </p>
        <button disabled={!dirty}>Save</button>
      </form>
    </section>
  );
}
