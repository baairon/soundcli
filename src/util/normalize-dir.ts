import os from "node:os";

/**
 * Clean a user-entered folder path: trim, strip one pair of surrounding
 * quotes (dragging a folder onto a terminal pastes it quoted), and expand a
 * leading `~` to the home directory. Pure string work, no filesystem access.
 */
export function normalizeDir(raw: string): string {
  let s = raw.trim();
  const first = s[0];
  if ((first === '"' || first === "'") && s.endsWith(first) && s.length >= 2) {
    s = s.slice(1, -1).trim();
  }
  if (s === "~") return os.homedir();
  if (s.startsWith("~/") || s.startsWith("~\\")) {
    return os.homedir() + s.slice(1);
  }
  return s;
}
