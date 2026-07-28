import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    // Process-backed tests spawn additional ACP and MCP children. Keep the
    // comprehensive gate reliable when it shares a busy development host.
    maxWorkers: 2,
    setupFiles: ["tests/support/global-config-root.ts"],
  },
});
