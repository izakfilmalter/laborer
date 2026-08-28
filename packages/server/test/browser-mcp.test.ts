import { describe, expect, it } from 'vitest'
import { browserInvocation } from '../src/services/browser-mcp.js'

describe('browser MCP adapter', () => {
  it('maps MCP arguments to the desktop automation contract', () => {
    expect(
      browserInvocation({
        await_promise: true,
        return_by_value: false,
        tab_id: 'tab-1',
        timeout_ms: 2500,
        url_includes: '/ready',
      })
    ).toEqual({
      input: {
        awaitPromise: true,
        returnByValue: false,
        timeoutMs: 2500,
        urlIncludes: '/ready',
      },
      tabId: 'tab-1',
      timeoutMs: 2500,
    })
  })
})
