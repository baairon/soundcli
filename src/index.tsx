import { render } from "ink";
import { ThemeProvider } from "@inkjs/ui";
import { App } from "./ui/App";
import { uiTheme } from "./ui/theme";
import { parseCliArgs, HELP_TEXT } from "./cli/args";

const ALT_ENTER = "\x1b[?1049h\x1b[H"; // enter alternate screen buffer, home cursor
const ALT_LEAVE = "\x1b[?1049l"; // restore the normal screen

// Terminal tab title: save the shell's title on the xterm title stack, set
// ours, and pop the old one back on exit. Terminals without the stack just
// ignore the push/pop and keep our title, which is still the right look.
const TITLE_PUSH = "\x1b[22;0t";
const TITLE_SET = "\x1b]0;♪ soundcli\x07";
const TITLE_POP = "\x1b[23;0t";

// A music TUI must never die from a stray background async error (e.g. an mpv
// IPC command that rejected after the file unloaded). Swallow unhandled
// rejections and keep playing; writing to stderr would corrupt the Ink render.
process.on("unhandledRejection", () => {});

// A truly-uncaught sync error is fatal, but at least leave the terminal usable
// (restore the normal screen) instead of a garbled alternate buffer.
process.on("uncaughtException", (err) => {
  try {
    if (process.stdout.isTTY) process.stdout.write(ALT_LEAVE);
  } catch {
    // ignore
  }
  console.error(err);
  process.exit(1);
});

async function runGui(port: number | undefined, open: boolean): Promise<void> {
  const path = await import("node:path");
  const fs = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { createRequire } = await import("node:module");
  const { createApp } = await import("./core/createApp");
  const { startGuiServer } = await import("./gui/server");
  const { openPath } = await import("./util/open-path");

  // Built page: next to the bundle when installed, ../dist/web when run from src.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const webRoot = [path.join(here, "web"), path.join(here, "..", "dist", "web")].find(
    (d) => fs.existsSync(path.join(d, "index.html")),
  );
  if (!webRoot) {
    console.error("GUI files not found. Run `npm run build:web` first.");
    process.exitCode = 1;
    return;
  }
  const version = (
    createRequire(import.meta.url)("../package.json") as { version: string }
  ).version;

  let gui: Awaited<ReturnType<typeof startGuiServer>> | null = null;
  let app: Awaited<ReturnType<typeof createApp>>;
  try {
    app = await createApp({
      onStatus: (t) => console.log(t),
      onMpvStatus: (t) => gui?.setMpvStatus(t),
      browserAudio: true,
    });
  } catch (e) {
    console.error(
      `Couldn't set up: ${e instanceof Error ? e.message : String(e)}`,
    );
    process.exitCode = 1;
    return;
  }
  app.startBackgroundReconcile();
  gui = await startGuiServer({ app, webRoot, version, port });

  console.log(`soundcli GUI running at\n  ${gui.url}\nPress ctrl-c to quit.`);
  if (open) openPath(gui.url);

  const server = gui;
  await new Promise<void>((resolve) => {
    const stop = (): void => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await server.close();
  app.dispose();
  process.exit(0);
}

async function main(): Promise<void> {
  const command = parseCliArgs(process.argv.slice(2));

  if (command.kind === "version") {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version: string };
    console.log(pkg.version);
    return;
  }

  if (command.kind === "help") {
    console.log(HELP_TEXT);
    return;
  }

  if (command.kind === "invalid") {
    console.error(`unknown argument: ${command.arg}\n`);
    console.error(HELP_TEXT);
    process.exitCode = 1;
    return;
  }

  if (command.kind === "gui") {
    await runGui(command.port, command.open);
    return;
  }

  // Run the dashboard in the alternate screen so it updates in place like a
  // real TUI (no scrollback, no snapping to the bottom on each keystroke).
  const useAlt = Boolean(process.stdout.isTTY);
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    if (useAlt) {
      try {
        process.stdout.write(ALT_LEAVE + TITLE_POP);
      } catch {
        // ignore
      }
    }
  };

  if (useAlt) {
    process.stdout.write(TITLE_PUSH + TITLE_SET + ALT_ENTER);
    process.on("exit", restore);
  }

  try {
    const { waitUntilExit } = render(
      <ThemeProvider theme={uiTheme}>
        <App initialAdd={command.initialAdd} />
      </ThemeProvider>,
    );
    await waitUntilExit();
  } finally {
    restore();
  }

  // Force-exit so dangling handles (timers, mpv, watcher) don't hang the terminal
  process.exit(0);
}

main().catch((err: unknown) => {
  try {
    if (process.stdout.isTTY) process.stdout.write(ALT_LEAVE);
  } catch {
    // ignore
  }
  console.error(err);
  process.exit(1);
});
