import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import {
  browserInvocation,
  validateInvocation,
} from '../src/services/browser-mcp.js'

/** The failure an invocation reports, or null when it is accepted. */
const rejection = (
  operation: Parameters<typeof validateInvocation>[0],
  values: Record<string, unknown>
) =>
  Effect.runSync(
    validateInvocation(operation, browserInvocation(values)).pipe(
      Effect.as(null),
      Effect.catch((error) => Effect.succeed(error.message))
    )
  )

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

  // The advertised parameter schemas carry no checks, because the JSON Schema
  // emitter renders each one as an `allOf` fragment that MCP clients drop
  // along with the property. These are the rules that moved here instead.
  it('enforces the rules its advertised schema no longer carries', () => {
    expect(rejection('navigate', { url: 'https://example.dev' })).toBeNull()
    expect(rejection('navigate', { url: '   ' })).toContain('url')
    expect(
      rejection('navigate', { timeout_ms: 60_001, url: 'https://example.dev' })
    ).toContain('timeout_ms')
    expect(rejection('click', { locator: 'button', timeout_ms: 0 })).toContain(
      'timeout_ms'
    )

    expect(
      rejection('resize', { height: 800, mode: 'freeform', width: 1200 })
    ).toBeNull()
    // Dimensions below the supported viewport, a half-supplied pair, and a
    // preset in the wrong mode were all accepted before this check existed.
    expect(
      rejection('resize', { height: 800, mode: 'freeform', width: 10 })
    ).toContain('width')
    expect(rejection('resize', { mode: 'freeform', width: 1200 })).toContain(
      'width and height'
    )
    expect(rejection('resize', { mode: 'fill', preset: 'ipad-air' })).toContain(
      'Fill mode'
    )

    // A tab cannot be named and refused in the same open.
    expect(
      rejection('open', { reuse_existing_tab: false, tab_id: 'tab-1' })
    ).toContain('reuseExistingTab')
    expect(
      rejection('open', { reuse_existing_tab: false, url: 'https://x.dev' })
    ).toBeNull()
  })
})
