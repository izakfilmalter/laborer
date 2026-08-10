import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Point the Laborer global state root (and with it the shared task db at
// `$XDG_STATE_HOME/laborer/laborer.sqlite`) at a throwaway directory so tests
// that exercise production code paths — worktree reconciliation, PR task
// transitions, board reads — can never write into the developer's real
// state. Loaded via vitest `setupFiles`, once per worker fork.
process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), 'laborer-test-state-'))
