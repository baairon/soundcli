import { execFile } from "node:child_process";

/**
 * Opens a native OS folder-picker dialog and returns the chosen path, or
 * undefined if the user cancelled. On Windows this spawns PowerShell's
 * FolderBrowserDialog (STA is required for WinForms); on macOS it uses
 * osascript; on Linux, zenity or kdialog.
 */
export function pickFolder(initialDir?: string): Promise<string | undefined> {
  const platform = process.platform;

  if (platform === "win32") {
    const escapedDir = (initialDir ?? "").replace(/'/g, "''");
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
      `$d.SelectedPath = '${escapedDir}'`,
      "$d.Description = 'Choose where to save your music'",
      "$d.ShowNewFolderButton = $true",
      "if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath } else { '' }",
    ].join("; ");

    return new Promise((resolve) => {
      execFile(
        "powershell",
        // WinForms needs STA; without it ShowDialog() can hang forever.
        ["-STA", "-NoProfile", "-Command", script],
        { timeout: 120_000, windowsHide: false },
        (err, stdout) => {
          if (err) {
            resolve(undefined);
            return;
          }
          const chosen = stdout.trim();
          resolve(chosen || undefined);
        },
      );
    });
  }

  if (platform === "darwin") {
    const script =
      'tell application "Finder" to set f to POSIX path of (choose folder with prompt "Choose where to save your music")';
    return new Promise((resolve) => {
      execFile(
        "osascript",
        ["-e", script],
        { timeout: 120_000 },
        (err, stdout) => {
          if (err) {
            resolve(undefined);
            return;
          }
          const chosen = stdout.trim();
          resolve(chosen || undefined);
        },
      );
    });
  }

  return new Promise((resolve) => {
    const args = [
      "--file-selection",
      "--directory",
      "--title=Choose where to save your music",
    ];
    if (initialDir) args.push(`--filename=${initialDir}`);
    execFile("zenity", args, { timeout: 120_000 }, (err, stdout) => {
      if (!err && stdout.trim()) {
        resolve(stdout.trim());
        return;
      }
      execFile(
        "kdialog",
        [
          "--getexistingdirectory",
          initialDir ?? ".",
          "--title",
          "Choose where to save your music",
        ],
        { timeout: 120_000 },
        (err2, stdout2) => {
          if (err2) {
            resolve(undefined);
            return;
          }
          const chosen = stdout2.trim();
          resolve(chosen || undefined);
        },
      );
    });
  });
}
