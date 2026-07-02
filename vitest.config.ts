import { defineConfig } from "vitest/config";

// Ink colors its frames whenever the test process looks like a TTY, so the
// plain-text assertions in test/ui.test.tsx would pass or fail depending on
// the shell running the suite. Pin rendering to plain text everywhere.
export default defineConfig({
  test: {
    env: { FORCE_COLOR: "0" },
  },
});
