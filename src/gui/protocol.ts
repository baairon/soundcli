// Messages between the local GUI server and the web page. Types only, so the
// web bundle can import this without pulling in any Node code.

import type { Config } from "../config/config";
import type { QueueItem, QueueStats } from "../download/queue";
import type { Track } from "../library/types";
import type { PlaybackState } from "../player/playback";

export interface Snapshot {
  tracks: Track[];
  queue: QueueItem[];
  stats: QueueStats;
  playback: PlaybackState;
  /** Recently played track ids, newest first. */
  history: string[];
  config: Config;
  mpvStatus: string | null;
  version: string;
}

/** Server -> page. */
export type ServerEvent =
  | { type: "snapshot"; data: Snapshot }
  | { type: "playback"; data: PlaybackState }
  | { type: "queue"; data: { queue: QueueItem[]; stats: QueueStats } }
  | { type: "library"; data: { tracks: Track[]; history: string[] } }
  | { type: "mpv"; data: string | null }
  | { type: "result"; id: number; ok: boolean; message?: string };

/** Page -> server. `id` is echoed back in a `result` event. */
export type ClientCommand = { id: number } & (
  | { cmd: "play"; trackId: string; listIds?: string[] }
  | { cmd: "togglePause" }
  | { cmd: "report"; trackId: string; position: number; duration: number }
  | { cmd: "ended"; trackId: string }
  | { cmd: "seek"; seconds: number }
  | { cmd: "setVolume"; volume: number }
  | { cmd: "next" }
  | { cmd: "prev" }
  | { cmd: "cycleRepeat" }
  | { cmd: "toggleShuffle" }
  | { cmd: "stop" }
  | { cmd: "enqueueUrl"; url: string }
  | { cmd: "queuePause"; itemId: string }
  | { cmd: "queueResume"; itemId: string }
  | { cmd: "queueCancel"; itemId: string }
  | { cmd: "queuePauseAll" }
  | { cmd: "queueResumeAll" }
  | { cmd: "queueRetryFailed" }
  | { cmd: "queueClearFinished" }
  | { cmd: "deleteTracks"; trackIds: string[] }
  | { cmd: "renameTrack"; trackId: string; title: string }
  | { cmd: "setConfig"; patch: Partial<Config> }
);

export type CommandName = ClientCommand["cmd"];
