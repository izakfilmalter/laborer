import { defineConfig } from 'vitest/config'

// Process-backed tests spawn additional ACP and MCP children, so each worker
// costs far more than a Vitest thread. Four workers keeps the comprehensive
// gate reliable on a shared development host while finishing the suite in
// roughly two minutes; constrained machines and CI runners lower it through
// VITEST_MAX_WORKERS.
const DEFAULT_MAX_WORKERS = 4

const maxWorkers = () => {
  const configured = process.env.VITEST_MAX_WORKERS
  if (configured === undefined) {
    return DEFAULT_MAX_WORKERS
  }
  const parsed = Number(configured)
  if (!(Number.isInteger(parsed) && parsed > 0)) {
    throw new Error(
      `VITEST_MAX_WORKERS must be a positive integer, received ${configured}`
    )
  }
  return parsed
}

export default defineConfig({
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    maxWorkers: maxWorkers(),
    setupFiles: ['tests/support/global-config-root.ts'],
  },
})
