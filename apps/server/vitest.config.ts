import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only the server's own source tests. Agent workspaces created by the
    // browser replay demo may contain tests/*.test.ts files; those must never be
    // picked up as project tests.
    include: ["src/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "workspaces/**",
      ".demo-workspaces/**",
      ".data/**",
      ".demo-data/**",
    ],
  },
});
