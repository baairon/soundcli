import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.tsx"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  // Dependencies stay external (resolved from node_modules at runtime): the
  // remaining five are small pure-JS packages, and an unbundled build keeps
  // stack traces readable and the publish simple. One exception: @inkjs/ui
  // lives in devDependencies so tsup inlines it, because upstream imports
  // react without declaring it and pnpm's strict linking crashes on that
  // missing edge (issue #7); bundled, the broken import disappears from the
  // installed artifact while react/ink stay external and declared here.
  banner: { js: "#!/usr/bin/env node" },
  clean: true,
  sourcemap: false,
  dts: false,
  splitting: false,
  shims: false,
  minify: true,
  esbuildOptions(options) {
    options.jsx = "automatic";
    options.jsxImportSource = "react";
  },
});
