/**
 * Unit tests for ephemeral port reservation and auth token generation.
 *
 * Tests verify:
 * - reservePort returns valid port numbers
 * - reserveServicePorts returns two distinct ports and an auth token
 * - Ports are in the valid ephemeral range
 * - Auth token has expected length and format
 */

import { createServer } from 'node:net'

import { describe, expect, it } from 'vitest'

import { reservePort, reserveServicePorts } from '../src/ports.js'

/** Matches a 48-character lowercase hex string (24 random bytes). */
const HEX_TOKEN_PATTERN = /^[0-9a-f]{48}$/

describe('reservePort', () => {
  it('returns a positive port number', async () => {
    const port = await reservePort()
    expect(port).toBeGreaterThan(0)
  })

  it('returns a port in the valid range (1-65535)', async () => {
    const port = await reservePort()
    expect(port).toBeGreaterThanOrEqual(1)
    expect(port).toBeLessThanOrEqual(65_535)
  })

  it('returns distinct ports on successive calls', async () => {
    const ports = await Promise.all([
      reservePort(),
      reservePort(),
      reservePort(),
    ])

    const unique = new Set(ports)
    expect(unique.size).toBe(3)
  })

  it('returns a port that can be bound to', async () => {
    const port = await reservePort()

    // Verify we can actually bind to the returned port
    const canBind = await new Promise<boolean>((resolve) => {
      const server = createServer()
      server.once('error', () => resolve(false))
      server.listen(port, '127.0.0.1', () => {
        server.close(() => resolve(true))
      })
    })

    expect(canBind).toBe(true)
  })
})

describe('reserveServicePorts', () => {
  it('returns two distinct ports', async () => {
    const result = await reserveServicePorts()
    expect(result.serverPort).toBeGreaterThan(0)
    expect(result.terminalPort).toBeGreaterThan(0)
    expect(result.serverPort).not.toBe(result.terminalPort)
  })

  it('returns a valid auth token', async () => {
    const result = await reserveServicePorts()

    // 24 random bytes = 48 hex characters
    expect(result.authToken).toHaveLength(48)
    expect(result.authToken).toMatch(HEX_TOKEN_PATTERN)
  })

  it('generates unique auth tokens on successive calls', async () => {
    const [a, b] = await Promise.all([
      reserveServicePorts(),
      reserveServicePorts(),
    ])
    expect(a.authToken).not.toBe(b.authToken)
  })
})
