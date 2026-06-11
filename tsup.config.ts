import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.tsx"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  // Dependencies stay external (resolved from node_modules at runtime): the
  // remaining five are small pure-JS packages, and an unbundled build keeps
  // stack traces readable and the publish simple.
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
