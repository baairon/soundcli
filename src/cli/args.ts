// Tiny argv parser for the few things soundcli accepts beyond "just open the
// dashboard". Kept as a pure function so it's trivially testable.

/** The commands that run with no dashboard (see cli/headless). */
export type HeadlessVerb = "add" | "watch" | "unwatch" | "sync";

export type CliCommand =
  | { kind: "version" }
  | { kind: "help" }
  | { kind: "run"; initialAdd?: string }
  /** Download with no dashboard. */
  | { kind: "add"; links: string[]; all: boolean; json: boolean; into?: string }
  /** Remember links to keep current; with none, list what is watched. */
  | { kind: "watch"; links: string[]; all: boolean; into?: string }
  | { kind: "unwatch"; links: string[] }
  /** Download what is new on every watched link. */
  | { kind: "sync"; json: boolean }
  /**
   * `in` marks a mistake inside a headless command, which exits 2 like its
   * other usage errors. `why` says what was wrong when the argument alone
   * would not.
   */
  | { kind: "invalid"; arg: string; in?: HeadlessVerb; why?: string };

/** Which flags a headless command reads; anything else is a usage error. */
const FLAGS: Record<HeadlessVerb, readonly string[]> = {
  add: ["--all", "--json", "--into"],
  watch: ["--all", "--into"],
  unwatch: [],
  sync: ["--json"],
};

function parseHeadless(verb: HeadlessVerb, rest: string[]): CliCommand {
  const links: string[] = [];
  let all = false;
  let json = false;
  let into: string | undefined;
  const wrong = (arg: string, why?: string): CliCommand => ({
    kind: "invalid",
    arg,
    in: verb,
    ...(why ? { why } : {}),
  });

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--help" || a === "-h") return { kind: "help" };
    const flag = a.startsWith("--into=") ? "--into" : a;
    if (a.startsWith("-") && !FLAGS[verb].includes(flag)) return wrong(a);
    if (a === "--all") all = true;
    else if (a === "--json") json = true;
    else if (flag === "--into") {
      const value = (a === "--into" ? rest[++i] : a.slice("--into=".length))?.trim();
      // A name, not a route: the folder lives inside the user's own collection.
      if (!value || /^-|[\\/]|^\.+$/.test(value)) {
        return wrong("--into", "--into needs a folder name, not a path");
      }
      into = value;
    } else links.push(a);
  }

  if (verb === "sync") {
    return links.length > 0 ? wrong(links[0]!) : { kind: "sync", json };
  }
  if (verb === "watch") return { kind: "watch", links, all, ...(into ? { into } : {}) };
  // Neither has anything to do without a link.
  if (links.length === 0) return wrong(verb, `${verb} needs at least one link`);
  if (verb === "unwatch") return { kind: "unwatch", links };
  return { kind: "add", links, all, json, ...(into ? { into } : {}) };
}

export function parseCliArgs(argv: string[]): CliCommand {
  const args = argv.filter((a) => a.trim() !== "");
  if (args.length === 0) return { kind: "run" };
  const verb = args[0]!;
  if (verb === "add" || verb === "watch" || verb === "unwatch" || verb === "sync") {
    return parseHeadless(verb, args.slice(1));
  }
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
  sndcli watch <link>...    remember a link, to keep it current
  sndcli sync               download what is new on every watched link
  sndcli --version          print the version
  sndcli --help             print this

add
  <link>                    a song, playlist, set, album or SoundCloud likes,
                            or an artist's uploads (.../tracks, .../videos)
  --all                     take every playlist on a profile link
  --into <folder>           save into this folder of your own collection
  --json                    one JSON object per line: link, track, handoff, done
  hands the links over when soundcli is already open

watch
  <link>... [--into <folder>] [--all]
                            what is there today is left alone; sync takes
                            only what appears after. add takes the rest
  sndcli watch              list what is watched
  sndcli unwatch <link>...  stop watching; saved files stay
  sndcli sync [--json]      same output and exit codes as add

add and sync exit with
  0     done, or handed over
  1     something failed that another try could fix
  2     the command was wrong
  75    stopped early with the queue saved: run it again later
  130   ctrl-c
  143   killed by another program

tip: quote links that contain & (e.g. "https://...?list=...")
tip: run "sndcli sync" from Task Scheduler, cron or launchd
`;
