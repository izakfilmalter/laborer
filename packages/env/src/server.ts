import { homedir } from 'node:os'
import { join } from 'node:path'
import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

/**
 * Default data directory for LiveStore persistence.
 * Uses `~/.config/laborer/data` so all worktrees of the same repo share
 * the same database, consistent with how prdsDir defaults to
 * `~/.config/laborer/<project>/prds`.
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

    /**
     * Daytona API key for cloud sandbox provider.
     * Optional at the schema level — only required when the Daytona provider
     * is actually used. Validated at runtime by the DaytonaClient service.
     */
    DAYTONA_API_KEY: z.string().min(1).optional(),

    /**
     * Daytona API URL. Defaults to the hosted Daytona API.
     */
    DAYTONA_API_URL: z.string().url().default('https://app.daytona.io/api'),

    /**
     * Daytona target region. Defaults to US.
     */
    DAYTONA_TARGET: z.string().min(1).default('us'),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
})
