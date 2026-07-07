import { useEffect } from "react";

/**
 * Enable mouse wheel scrolling in the terminal. Translates SGR mouse wheel
 * events into arrow key sequences so every arrow-driven list (@inkjs/ui
 * Select and our SongList) scrolls naturally with the wheel. Call once in App.
 */
export function useMouseWheel(): void {
  useEffect(() => {
    const { stdout, stdin } = process;

    // Enable SGR extended mouse tracking (button events + SGR encoding).
    // This tells the terminal to report mouse button presses (including wheel)
    // as escape sequences on stdin.
    stdout.write("\x1b[?1000h\x1b[?1006h");

    const handler = (data: Buffer): void => {
      const str = data.toString("utf8");
      // SGR mouse wheel up:   \x1b[<64;col;rowM
      // SGR mouse wheel down: \x1b[<65;col;rowM
      const re = /\x1b\[<(64|65);\d+;\d+[Mm]/g;
      let arrows = "";
      let match: RegExpExecArray | null;
      while ((match = re.exec(str)) !== null) {
        arrows += match[1] === "64" ? "\x1b[A" : "\x1b[B";
      }
      if (arrows.length === 0) return;
      // Ink 7 consumes stdin via 'readable' + read() into its own parser, so
      // a manual emit("data") never reaches it. unshift puts the arrows back
      // in the stream buffer (the same re-feed mechanism Ink itself uses),
      // and the read loop that just delivered this chunk drains them in the
      // same pass, split into one arrow event per notch. One chunk per wheel
      // burst keeps React folding the cursor updates into a single render.
      const buf = Buffer.from(arrows);
      if (typeof stdin.unshift === "function") stdin.unshift(buf);
      else stdin.emit("data", buf);
    };

    // Prepend so we see the raw data before Ink's parser. Ink ignores the
    // unknown mouse sequences; our re-emitted arrow keys it handles normally.
    stdin.prependListener("data", handler);

    return () => {
      stdout.write("\x1b[?1000l\x1b[?1006l");
      stdin.removeListener("data", handler);
    };
  }, []);
}
