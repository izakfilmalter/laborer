import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

const port = z.coerce.number().int().min(1).max(65_535)

export const env = createEnv({
  server: {
    PORT: port.default(3000),
    TERMINAL_PORT: port.default(3002),
    TERMINAL_GRACE_PERIOD_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(60_000),
    PORT_RANGE_START: port.default(3100),
    PORT_RANGE_END: port.default(3999),
    EDITOR_COMMAND: z
      .enum(['cursor', 'code', 'vim', 'nvim', 'emacs'])
      .default('cursor'),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
})
