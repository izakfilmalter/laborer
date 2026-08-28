import { describe, expect, it } from 'vitest'
import {
  isDaemonWebSocketRequestAllowed,
  makeDaemonWebSocketPolicy,
} from '../src/daemon-websocket-auth.js'

describe('daemon websocket authorization', () => {
  const policy = makeDaemonWebSocketPolicy('http://127.0.0.1:2100', '2101')

  it('allows production, Vite, and native client handshakes', () => {
    expect(
      isDaemonWebSocketRequestAllowed(policy, 'http://127.0.0.1:2100')
    ).toBe(true)
    expect(
      isDaemonWebSocketRequestAllowed(policy, 'http://localhost:2101')
    ).toBe(true)
    expect(
      isDaemonWebSocketRequestAllowed(policy, 'http://127.0.0.1:2101')
    ).toBe(true)
    expect(isDaemonWebSocketRequestAllowed(policy, undefined)).toBe(true)
  })

  it('denies asset pages, arbitrary sites, null, and malformed origins', () => {
    expect(
      isDaemonWebSocketRequestAllowed(policy, 'http://127.0.0.1:43210')
    ).toBe(false)
    expect(
      isDaemonWebSocketRequestAllowed(policy, 'https://attacker.example')
    ).toBe(false)
    expect(isDaemonWebSocketRequestAllowed(policy, 'null')).toBe(false)
    expect(isDaemonWebSocketRequestAllowed(policy, 2100)).toBe(false)
  })
})
