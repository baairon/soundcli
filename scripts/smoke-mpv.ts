// Verifies the real mpv IPC player: load a file, read position/duration, pause.
//   npx tsx scripts/smoke-mpv.ts
import { detectMpv } from "../src/bin/binaries";
import { Playback } from "../src/player/playback";
import type { Track } from "../src/library/types";

const mpv = await detectMpv();
console.log("detected mpv:", mpv ?? "(none)");
if (!mpv) process.exit(1);

const file =
  process.argv[2] ??
  "C:\\Users\\bairo\\Music\\soundcli\\YouTube\\Singles\\jawed - Me at the zoo.mp3";

const track: Track = {
  id: "t",
  source: "youtube",
  sourceTrackId: "t",
  title: "Me at the zoo",
  artist: "jawed",
  filePath: file,
  addedAt: new Date().toISOString(),
};

const pb = new Playback(mpv);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

await pb.play(track, [track]);
await pb.changeVolume(-100); // mute the verification blip
await wait(2000);

let s = pb.getState();
console.log(
  `engine=${s.engine} position=${s.position}s duration=${s.duration}s paused=${s.paused}`,
);

await pb.togglePause();
await wait(400);
s = pb.getState();
console.log(`after toggle -> paused=${s.paused}`);

pb.quit();
await wait(300);
console.log("mpv player OK");
process.exit(0);
