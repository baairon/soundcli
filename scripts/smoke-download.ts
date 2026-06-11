// Manual end-to-end check (not published). Downloads one track through the real
// pipeline and records it in the library.
//   npx tsx scripts/smoke-download.ts [url]
import { ensureFfmpeg } from "../src/bin/ffmpeg-fetch";
import { loadConfig } from "../src/config/config";
import { Library } from "../src/library/library";
import { downloadTrack } from "../src/ytdlp/ytdlp";

const url =
  process.argv[2] ?? "https://www.youtube.com/watch?v=jNQXAC9IVRw";

const config = await loadConfig();
const lib = await Library.load();
await ensureFfmpeg();

console.log("library dir:", config.libraryDir);
console.log("downloading:", url, "\n");

const res = await downloadTrack(
  { url, config, sourceLabel: "YouTube" },
  (p) => {
    if (p.percent !== undefined) {
      process.stdout.write(`\r  ${p.status} ${p.percent.toFixed(0)}%        `);
    } else {
      process.stdout.write(`\r  ${p.status}        `);
    }
  },
);

console.log("\n\nresult:", res.status);
if (res.meta) {
  console.log("title: ", res.meta.track ?? res.meta.title);
  console.log("artist:", res.meta.artist ?? res.meta.uploader ?? "(unknown)");
  console.log("file:  ", res.meta.filepath);
  await lib.upsert({
    id: `youtube:${res.meta.id}`,
    source: "youtube",
    sourceTrackId: res.meta.id,
    title: res.meta.track ?? res.meta.title,
    artist: res.meta.artist ?? res.meta.uploader,
    album: res.meta.album,
    durationSec: res.meta.duration,
    filePath: res.meta.filepath,
    webpageUrl: res.meta.webpage_url,
    playlist: res.meta.playlist_title,
    addedAt: new Date().toISOString(),
  });
  console.log("\nlibrary now holds", lib.all().length, "track(s)");
}
