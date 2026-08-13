import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { assert, describe, it } from '@effect/vitest'

const DISABLED_AUTOUPDATE = "OPENCODE_DISABLE_AUTOUPDATE: '1'"

describe('OpenCode automatic update boundary', () => {
  it('prevents managed OpenCode servers from replacing the host CLI', async () => {
    const [adapter, preflight] = await Promise.all([
      readFile(
        resolve(process.cwd(), 'src/acp-runtime/opencode-v2-acp-adapter.ts'),
        'utf8'
      ),
      readFile(
        resolve(process.cwd(), 'src/acp-runtime/opencode-config-preflight.ts'),
        'utf8'
      ),
    ])

    assert.include(adapter, DISABLED_AUTOUPDATE)
    assert.include(preflight, DISABLED_AUTOUPDATE)
  })
})
