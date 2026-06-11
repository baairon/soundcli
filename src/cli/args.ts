// Tiny argv parser for the few things soundcli accepts beyond "just open the
// dashboard". Kept as a pure function so it's trivially testable.

export type CliCommand =
  | { kind: "version" }
  | { kind: "help" }
  | { kind: "run"; initialAdd?: string }
  | { kind: "invalid"; arg: string };

export function parseCliArgs(argv: string[]): CliCommand {
  const args = argv.filter((a) => a.trim() !== "");
  if (args.length === 0) return { kind: "run" };
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
  soundcli                  open the dashboard
  soundcli <link>           download that song on launch
  soundcli --version        print the version

tip: quote links that contain & (e.g. "https://...?list=...")
`;
