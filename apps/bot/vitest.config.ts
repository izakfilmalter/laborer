import { defaultExclude, defineConfig } from 'vitest/config'

// Integration tests that drive real child processes: ACP and MCP transports,
// the pinned OpenCode CLI, and supervised host process groups. They cost far
// more wall time than the deterministic suites and assert against real process
// lifetimes, so their results track how fast and how loaded the host is rather
// than whether the behaviour is correct. The default run leaves them out and
// `test:process-backed` runs them serially as a local gate.
const PROCESS_BACKED_TESTS = [
  'tests/acp-session-resume.test.ts',
  'tests/action-mcp.test.ts',
  'tests/conversation-client-replacement.test.ts',
  'tests/opencode-acp-compatibility.test.ts',
  'tests/opencode-config-preflight.test.ts',
  'tests/opencode-permission-policy.test.ts',
  'tests/sandcastle-host-command.test.ts',
]

const runsProcessBacked = process.env.LABORER_PROCESS_BACKED === '1'

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
    exclude: runsProcessBacked
      ? defaultExclude
      : [...defaultExclude, ...PROCESS_BACKED_TESTS],
    include: runsProcessBacked
      ? PROCESS_BACKED_TESTS
      : ['tests/**/*.test.{ts,tsx}'],
    maxWorkers: maxWorkers(),
    setupFiles: ['tests/support/global-config-root.ts'],
  },
})
