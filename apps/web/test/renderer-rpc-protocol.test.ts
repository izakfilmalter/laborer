import { describe, expect, it } from 'vitest'
import {
  daemonWebSocketUrl,
  isLiveProtocolGeneration,
} from '../src/atoms/renderer-rpc-protocol'

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

  it('reports a disconnect from the transport the supervisor still owns', () => {
    expect(isLiveProtocolGeneration(3, 3)).toBe(true)
  })

  it('stays silent when an older transport is torn down after a reconnect', () => {
    expect(isLiveProtocolGeneration(2, 3)).toBe(false)
  })
})
