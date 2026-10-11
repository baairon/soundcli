// Tiny argv parser for the few things soundcli accepts beyond "just open the
// dashboard". Kept as a pure function so it's trivially testable.

export type CliCommand =
  | { kind: "version" }
  | { kind: "help" }
  | { kind: "run"; initialAdd?: string }
  | { kind: "gui"; port?: number; open: boolean }
  | { kind: "invalid"; arg: string };

export function parseCliArgs(argv: string[]): CliCommand {
  const args = argv.filter((a) => a.trim() !== "");
  if (args.length === 0) return { kind: "run" };
  if (args[0] === "--gui") return parseGuiArgs(args.slice(1));
  if (args.length > 1) return { kind: "invalid", arg: args[1]! };
  const a = args[0]!;
  if (a === "--version" || a === "-v") return { kind: "version" };
  if (a === "--help" || a === "-h") return { kind: "help" };
  if (a.startsWith("-")) return { kind: "invalid", arg: a };
  // A link or handle: jump straight into downloading it.
  return { kind: "run", initialAdd: a };
}

function parseGuiArgs(rest: string[]): CliCommand {
  let port: number | undefined;
  let open = true;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--no-open") {
      open = false;
    } else if (a === "--port") {
      const v = rest[++i];
      const n = v === undefined || !/^\d+$/.test(v) ? NaN : Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        return { kind: "invalid", arg: v === undefined ? a : `${a} ${v}` };
      }
      port = n;
    } else {
      return { kind: "invalid", arg: a };
    }
  }
  return { kind: "gui", port, open };
}

export const HELP_TEXT = `soundcli, own your music

usage
  soundcli                  open the dashboard
  soundcli <link>           download that song on launch
  soundcli --gui            open the dashboard in your browser
                            (--port <n>, --no-open)
  soundcli --version        print the version

tip: quote links that contain & (e.g. "https://...?list=...")
`;
