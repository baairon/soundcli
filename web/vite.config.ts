import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The page is served by `sndcli --gui` from dist/web, always at the server root.
export default defineConfig({
  root: import.meta.dirname,
  base: "./",
  plugins: [react()],
  build: { outDir: "../dist/web", emptyOutDir: true },
});
