import { describe, expect, it } from 'vitest'

import { shouldReplaceDevHostRuntime } from '../src/services/pty-host-proxy.js'

describe('development PTY host runtime', () => {
  it('replaces a Bun host when the watched daemon runs under Node', () => {
    expect(
      shouldReplaceDevHostRuntime({
        devWatch: true,
        expectedExecPath: '/usr/local/bin/node',
        hostExecPath: '/Users/me/.bun/bin/bun',
      })
    ).toBe(true)
  })

  it('replaces an older host that does not report its runtime', () => {
    expect(
      shouldReplaceDevHostRuntime({
        devWatch: true,
        expectedExecPath: '/usr/local/bin/node',
      })
    ).toBe(true)
  })

  it('adopts the matching Node host across daemon hot reloads', () => {
    expect(
      shouldReplaceDevHostRuntime({
        devWatch: true,
        expectedExecPath: '/usr/local/bin/node',
        hostExecPath: '/usr/local/bin/node',
      })
    ).toBe(false)
  })

  it('does not replace durable production hosts based on runtime', () => {
    expect(
      shouldReplaceDevHostRuntime({
        devWatch: false,
        expectedExecPath: '/usr/local/bin/node',
        hostExecPath: '/Users/me/.bun/bin/bun',
      })
    ).toBe(false)
  })
})
