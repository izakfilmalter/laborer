import { homedir } from 'node:os'
import { join } from 'node:path'
import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

/**
 * Default data directory for LiveStore persistence.
 * Uses `~/.config/laborer/data` so all worktrees share the same database.
 */
const defaultDataDir = join(homedir(), '.config', 'laborer', 'data')

export const env = createEnv({
  server: {
    TERMINAL_GRACE_PERIOD_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(60_000),

    EDITOR_COMMAND: z
      .enum(['cursor', 'code', 'vim', 'nvim', 'emacs'])
      .default('cursor'),
    DATA_DIR: z.string().min(1).default(defaultDataDir),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
})
