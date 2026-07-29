import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    // Process-backed tests spawn additional ACP and MCP children, so cap the
    // worker count instead of letting Vitest scale to every core. Four workers
    // keeps the comprehensive gate reliable on a shared development host while
    // finishing the suite in roughly two minutes; override with
    // VITEST_MAX_WORKERS for constrained machines.
    maxWorkers: 4,
    setupFiles: ["tests/support/global-config-root.ts"],
  },
});
