// Validates the source-adapter -> enumerate -> download chain without needing a
// login, by using a yt-dlp search as a stand-in "playlist".
//   npx tsx scripts/smoke-adapter.ts ["ytsearch3:query"]
import { loadConfig } from "../src/config/config";
import { downloadTrack } from "../src/ytdlp/ytdlp";
import { makeYoutube } from "../src/sources/youtube";
import type { SourcePlaylist } from "../src/sources/types";

const youtube = makeYoutube("smoke");

const playlist: SourcePlaylist = {
  id: "smoke",
  title: "Search Test",
  url: process.argv[2] ?? "ytsearch2:creative commons instrumental",
  kind: "playlist",
};

console.log("listing tracks for:", playlist.url, "\n");
const tracks = await youtube.listTracks(playlist);
console.log(`found ${tracks.length} track(s):`);
for (const t of tracks) {
  console.log(`  - ${t.title}  |  ${t.artist ?? "?"}  |  ${t.downloadUrl}`);
}

const first = tracks[0];
if (first) {
  console.log("\ndownloading the first one...");
  const config = await loadConfig();
  const res = await downloadTrack(
    {
      url: first.downloadUrl,
      config,
      sourceLabel: "YouTube",
    },
    (p) => {
      if (p.percent !== undefined) {
        process.stdout.write(`\r  ${p.status} ${p.percent.toFixed(0)}%       `);
      }
    },
  );
  console.log("\n", res.status, "->", res.meta?.filepath);
}
