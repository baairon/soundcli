// Tiny argv parser for the few things soundcli accepts beyond "just open the
// dashboard". Kept as a pure function so it's trivially testable.

export type CliCommand =
  | { kind: "version" }
  | { kind: "help" }
  | { kind: "run"; initialAdd?: string }
  /** Download with no dashboard (see cli/headless). */
  | { kind: "add"; links: string[]; all: boolean; json: boolean }
  /** `inAdd` marks a mistake inside `add`, which exits 2 like its other usage errors. */
  | { kind: "invalid"; arg: string; inAdd?: true };

function parseAdd(rest: string[]): CliCommand {
  const links: string[] = [];
  let all = false;
  let json = false;
  for (const a of rest) {
    if (a === "--help" || a === "-h") return { kind: "help" };
    if (a === "--all") all = true;
    else if (a === "--json") json = true;
    else if (a.startsWith("-")) return { kind: "invalid", arg: a, inAdd: true };
    else links.push(a);
  }
  // `add` alone has nothing to do.
  if (links.length === 0) return { kind: "invalid", arg: "add", inAdd: true };
  return { kind: "add", links, all, json };
}

export function parseCliArgs(argv: string[]): CliCommand {
  const args = argv.filter((a) => a.trim() !== "");
  if (args.length === 0) return { kind: "run" };
  if (args[0] === "add") return parseAdd(args.slice(1));
  if (args.length > 1) return { kind: "invalid", arg: args[1]! };
  const a = args[0]!;
  if (a === "--version" || a === "-v") return { kind: "version" };
  if (a === "--help" || a === "-h") return { kind: "help" };
  if (a.startsWith("-")) return { kind: "invalid", arg: a };
  // A link or handle: jump straight into downloading it.
  return { kind: "run", initialAdd: a };
}

export const HELP_TEXT = `soundcli, own your music

usage
  sndcli                    open the dashboard
  sndcli <link>             download that song on launch
  sndcli add <link>...      download with no dashboard, then exit
  sndcli --version          print the version
  sndcli --help             print this

add
  <link>                    a song, playlist, set, album or SoundCloud likes
  --all                     take every playlist on a profile link
  --json                    one JSON object per line: link, track, handoff, done
  hands the links over when soundcli is already open

add exits with
  0     done, or handed over
  1     something failed that another try could fix
  2     the command was wrong
  75    stopped early with the queue saved: run it again later
  130   ctrl-c
  143   killed by another program

tip: quote links that contain & (e.g. "https://...?list=...")
`;
