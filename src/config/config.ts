import { promises as fs } from "node:fs";
import path from "node:path";
import { configFile, defaultLibraryDir } from "./paths";
import { resolveDefaultLibraryDir } from "./music-dir";

export interface Config {
  /** Where downloaded audio files live. */
  libraryDir: string;
  /** The user's YouTube handle (public playlists). */
  youtubeHandle?: string;
  /** The user's SoundCloud handle (public likes + sets). */
  soundcloudHandle?: string;
  /** A Spotify playlist link the user pasted; read tokenlessly. */
  spotifyProfile?: string;
  /** Whether the first-run wizard has completed. */
  firstRunComplete: boolean;
  /** Check for yt-dlp updates at every launch (staged, applied when idle). */
  ytdlpAutoUpdate?: boolean;
}

export const defaultConfig: Config = {
  libraryDir: defaultLibraryDir,
  youtubeHandle: undefined,
  soundcloudHandle: undefined,
  spotifyProfile: undefined,
  firstRunComplete: false,
  ytdlpAutoUpdate: true,
};

export async function loadConfig(): Promise<Config> {
  let raw: string;
  try {
    raw = await fs.readFile(configFile, "utf8");
  } catch {
    // True first run (no config yet): ask the OS where Music really lives.
    // Once a config file exists this never runs again, so the registry is
    // queried at most once per machine.
    return { ...defaultConfig, libraryDir: await resolveDefaultLibraryDir() };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Config>;
    return { ...defaultConfig, ...parsed };
  } catch {
    return { ...defaultConfig };
  }
}

export async function saveConfig(config: Config): Promise<void> {
  await fs.mkdir(path.dirname(configFile), { recursive: true });
  await fs.writeFile(configFile, JSON.stringify(config, null, 2), "utf8");
  // Pre-create the music folder so downloads and "open folder" always land
  // somewhere real; a bad path must never break a config save.
  await fs.mkdir(config.libraryDir, { recursive: true }).catch(() => {});
}
