/**
 * Publish-time startup guard, run by prepublishOnly after the build.
 *
 * 1. Import drift: every bare specifier the built dist still imports must be
 *    a declared dependency, so a user install can never hit
 *    ERR_MODULE_NOT_FOUND at startup. @inkjs/ui must NOT appear: it is
 *    deliberately bundled (it imports react without declaring it, which
 *    crashes pnpm's strict linking, issue #7).
 * 2. npm 12 guard: no production dependency may carry an install script.
 *    npm 12 skips dependency install scripts by default, so a package that
 *    needs one to run would install fine and then die at startup.
 */
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";

let failed = false;
const fail = (msg: string): void => {
  console.error(`check-dist-imports: ${msg}`);
  failed = true;
};

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
  dependencies?: Record<string, string>;
};
const declared = new Set(Object.keys(pkg.dependencies ?? {}));
const builtins = new Set(builtinModules);

const dist = readFileSync("dist/index.js", "utf8");
// The minified ESM output references externals only as string literals in
// import statements / dynamic import() calls.
const specifiers = new Set<string>();
for (const m of dist.matchAll(
  /(?:from\s*|import\s*\(?\s*)["']([^"']+)["']/g,
)) {
  specifiers.add(m[1]!);
}

for (const spec of specifiers) {
  if (spec.startsWith(".") || spec.startsWith("node:")) continue;
  const name = spec.startsWith("@")
    ? spec.split("/").slice(0, 2).join("/")
    : spec.split("/")[0]!;
  if (builtins.has(name)) continue;
  if (name === "@inkjs/ui") {
    fail("@inkjs/ui leaked into dist as an external import; it must be bundled");
    continue;
  }
  if (!declared.has(name)) {
    fail(`dist imports "${spec}" but "${name}" is not a declared dependency`);
  }
}

const lock = JSON.parse(readFileSync("package-lock.json", "utf8")) as {
  packages?: Record<string, { dev?: boolean; hasInstallScript?: boolean }>;
};
for (const [path, entry] of Object.entries(lock.packages ?? {})) {
  if (path && entry.hasInstallScript && !entry.dev) {
    fail(`production package ${path} has an install script (breaks npm 12)`);
  }
}

if (failed) process.exit(1);
console.log("check-dist-imports: dist externals and lockfile are clean");
