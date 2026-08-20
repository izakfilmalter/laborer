import { defaultExclude, defineConfig } from 'vitest/config'

// Tests that start long-lived child processes — ACP and MCP transports, the
// pinned OpenCode CLI, supervised host process groups — or that poll for when
// one becomes live or dies. Their assertions are about real process lifetimes,
// so they measure how fast and how loaded the host is as much as whether the
// behaviour is right, and a shared runner fails them for reasons the code does
// not control. The default run leaves them out and `test:process-backed` runs
// them serially as a local gate.
//
// Tests that only shell out to git and read the result are deterministic and
// stay in the default run.
const PROCESS_BACKED_TESTS = [
  'tests/acp-process-supervisor.test.ts',
  'tests/acp-runtime-matrix.test.ts',
  'tests/acp-session-resume.test.ts',
  'tests/action-mcp.test.ts',
  'tests/cold-root-runtime-recovery.test.ts',
  'tests/conversation-client-replacement.test.ts',
  'tests/local-command-action.test.ts',
  'tests/opencode-acp-compatibility.test.ts',
  'tests/opencode-config-preflight.test.ts',
  'tests/opencode-permission-policy.test.ts',
  'tests/opencode-v1-source-policy.test.ts',
  'tests/sandcastle-host-command.test.ts',
  'tests/sandcastle-opencode2-agent.test.ts',
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
