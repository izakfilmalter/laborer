import { describe, expect, it } from 'vitest'
import { daemonWebSocketUrl } from '../src/atoms/renderer-rpc-protocol'

describe('renderer RPC protocol', () => {
  it('resolves an HTTP page to the same-origin daemon socket', () => {
    expect(daemonWebSocketUrl('http://localhost:2101/workspace/one')).toBe(
      'ws://localhost:2101/ws'
    )
  })

  it('uses a secure socket for an HTTPS page', () => {
    expect(daemonWebSocketUrl('https://laborer.test/some/path')).toBe(
      'wss://laborer.test/ws'
    )
  })
})
