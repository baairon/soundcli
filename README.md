<p align="center">
  <img src="preview/welcome.svg" width="780" alt="A terminal dashboard for downloading and playing your music">
</p>

Own your music. `soundcli` saves your YouTube, SoundCloud, and Spotify libraries as real audio files on your computer, then plays them offline. No account, no subscription, no cloud. The files are yours.

## Get started

You only need to do steps 1 and 2 once.

1. **Install Node** (the engine `soundcli` runs on). Go to [nodejs.org](https://nodejs.org), click the big download button, open the file it gives you, and click Next until it finishes.
2. **Open a terminal** (the window you type commands into).
   - Windows: press the Start key, type `terminal`, press Enter.
   - Mac: press Cmd and Space together, type `terminal`, press Enter.
3. **Paste this line and press Enter:**

```sh
npx soundcli
```

That's it. Everything else sets itself up on its own.

## Your first run

`soundcli` shows where your songs will be saved (a tidy folder inside your Music folder), then asks where your music comes from. Pick YouTube, SoundCloud, or Spotify, type your name on that platform or paste a link to any playlist, album, or song, and your library starts downloading right away. You can listen while it works, and you can move the music folder later from Settings.

<p align="center">
  <img src="preview/library.svg" width="780" alt="The library view: sidebar, your songs, and the player mid-song">
</p>

## What you get

Songs download in their native format at original quality, with the artwork and artist info already embedded, organized into tidy folders by source and playlist. You can paste almost anything: a profile, a playlist, an album, a likes feed, or a single track link. Public Spotify playlists and albums work without logging in; each track is matched to the right audio by checking duration and wording, so covers and sped-up edits don't sneak in.

Your library is the source of truth. Re-running a playlist only fetches what's new, the same song never downloads twice even across sources, and downloads pick up where they left off if you close the app. You can point the music folder anywhere from Settings; songs you already downloaded stay where they are and keep playing, while new downloads land in the new folder.

Playback works fully offline with all the usual controls: pause, seek, next and previous, shuffle, repeat, and volume.

## Keys

Press `?` in the app to see this anytime. The footer only ever shows the few keys that matter right now, so there's nothing to memorize.

<p align="center">
  <img src="preview/keys.svg" width="780" alt="The keyboard cheatsheet: navigate, player, and download keys">
</p>

<details>
<summary><b>How it works</b> (the technical bits)</summary>

`soundcli` keeps its npm install tiny and fetches its tools on first need, straight from their official releases:

- The download engine (yt-dlp) arrives on first run and is kept current automatically: updates stage in the background and apply when the queue is idle, because platforms change their APIs and a current engine is what keeps downloads working.
- The audio converter (ffmpeg and ffprobe) downloads once on first run and re-downloads itself if the binary ever goes bad.
- The player (mpv) installs automatically on Windows (winget) and macOS (brew). On Linux the app shows the one-line install command for your package manager; until then songs open in your system's default player.

Tool binaries land in your OS's standard cache folder, and your music lives in your real Music folder (`~/Music/soundcli` by default; on Windows the actual Music location is honored, including one that OneDrive has moved).

Requires Node 22 or newer.

</details>

## Privacy

Everything runs on your machine and stays there. There is no account, no login, no cookies, and no tracking of any kind. Nothing you download or play is ever reported anywhere.

The only things the app uses the internet for:
- Downloading the music you asked for
- A one-time setup of the underlying audio tools
- An occasional check to keep those tools up to date
- Installing the offline audio player if your computer doesn't have it

Any error logs stay strictly on your machine too.
