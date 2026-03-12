import { homedir } from 'node:os'
import { join } from 'node:path'
import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

const port = z.coerce.number().int().min(1).max(65_535)

/**
 * Default data directory for LiveStore persistence.
 * Uses `~/.config/laborer/data` so all worktrees of the same repo share
 * the same database, consistent with how prdsDir defaults to
 * `~/.config/laborer/<project>/prds`.
 */
const defaultDataDir = join(homedir(), '.config', 'laborer', 'data')

export const env = createEnv({
  server: {
    PORT: port.default(2100),
    TERMINAL_PORT: port.default(2102),
    FILE_WATCHER_PORT: port.default(2104),
    TERMINAL_GRACE_PERIOD_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(60_000),
    PORT_RANGE_START: port.default(2200),
    PORT_RANGE_END: port.default(2999),
    EDITOR_COMMAND: z
      .enum(['cursor', 'code', 'vim', 'nvim', 'emacs'])
      .default('cursor'),
    DATA_DIR: z.string().min(1).default(defaultDataDir),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
})
