import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    maxWorkers: "25%",
    setupFiles: ["tests/support/global-config-root.ts"],
  },
});
