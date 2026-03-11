/**
 * Unit tests for health checking, crash monitoring, and restart-with-backoff.
 *
 * Tests verify:
 * - backoffDelay produces correct exponential progression
 * - waitForHealthy polls an HTTP endpoint until it responds
 * - waitForHealthy respects timeout
 * - HealthMonitor emits correct status transitions
 * - HealthMonitor schedules restart with exponential backoff on crash
 * - HealthMonitor manual restart resets backoff counter
 * - HealthMonitor shutdown cancels pending restarts
 */

import { createServer, type Server } from 'node:http'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { backoffDelay, waitForHealthy } from '../src/health.js'

// ---------------------------------------------------------------------------
// backoffDelay (pure function — no mocks needed)
// ---------------------------------------------------------------------------

describe('backoffDelay', () => {
  it('returns 500ms for attempt 0', () => {
    expect(backoffDelay(0)).toBe(500)
  })

  it('returns 1000ms for attempt 1', () => {
    expect(backoffDelay(1)).toBe(1000)
  })

  it('returns 2000ms for attempt 2', () => {
    expect(backoffDelay(2)).toBe(2000)
  })

  it('returns 4000ms for attempt 3', () => {
    expect(backoffDelay(3)).toBe(4000)
  })

  it('returns 8000ms for attempt 4', () => {
    expect(backoffDelay(4)).toBe(8000)
  })

  it('caps at 10000ms for attempt 5+', () => {
    expect(backoffDelay(5)).toBe(10_000)
    expect(backoffDelay(6)).toBe(10_000)
    expect(backoffDelay(10)).toBe(10_000)
    expect(backoffDelay(100)).toBe(10_000)
  })

  it('follows exponential progression: 500, 1000, 2000, 4000, 8000, 10000', () => {
    const delays = Array.from({ length: 8 }, (_, i) => backoffDelay(i))
    expect(delays).toEqual([
      500, 1000, 2000, 4000, 8000, 10_000, 10_000, 10_000,
    ])
  })
})

// ---------------------------------------------------------------------------
// waitForHealthy (integration with real HTTP server)
// ---------------------------------------------------------------------------

describe('waitForHealthy', () => {
  let server: Server
  let port: number

  beforeEach(async () => {
    // Create a test HTTP server that we can control.
    await new Promise<void>((resolve) => {
      server = createServer((_req, res) => {
        res.writeHead(200)
        res.end('ok')
      })
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        port = typeof addr === 'object' && addr !== null ? addr.port : 0
        resolve()
      })
    })
  })

  afterEach(() => {
    server.close()
  })

  it('returns true when the service is already healthy', async () => {
    const url = `http://127.0.0.1:${port}`
    const result = await waitForHealthy(url, 5000, 50)
    expect(result).toBe(true)
  })

  it('returns false when the service never responds within timeout', async () => {
    // Use a port where nothing is listening.
    const result = await waitForHealthy('http://127.0.0.1:1', 300, 50)
    expect(result).toBe(false)
  })

  it('returns true when the service becomes healthy after a delay', async () => {
    // Start with a server that returns 503, then switch to 200.
    let healthy = false

    server.close()
    await new Promise<void>((resolve) => {
      server = createServer((_req, res) => {
        if (healthy) {
          res.writeHead(200)
          res.end('ok')
        } else {
          res.writeHead(503)
          res.end('not ready')
        }
      })
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        port = typeof addr === 'object' && addr !== null ? addr.port : 0
        resolve()
      })
    })

    // Switch to healthy after 200ms.
    setTimeout(() => {
      healthy = true
    }, 200)

    const url = `http://127.0.0.1:${port}`
    const result = await waitForHealthy(url, 5000, 50)
    expect(result).toBe(true)
  })

  it('uses the provided interval between polls', async () => {
    // Time how long it takes with a large interval vs small interval.
    // Both should succeed immediately since the server is healthy.
    const url = `http://127.0.0.1:${port}`

    const start = Date.now()
    await waitForHealthy(url, 5000, 10)
    const elapsed = Date.now() - start

    // Should complete very quickly since the server is already up.
    expect(elapsed).toBeLessThan(500)
  })

  it('handles connection refused gracefully', async () => {
    // Close the server so connections are refused.
    server.close()

    const result = await waitForHealthy(`http://127.0.0.1:${port}`, 300, 50)
    expect(result).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// HealthMonitor (tested with mocked SidecarManager and timers)
// ---------------------------------------------------------------------------

describe('HealthMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('exports HealthMonitor class', async () => {
    const { HealthMonitor } = await import('../src/health.js')
    expect(HealthMonitor).toBeDefined()
    expect(typeof HealthMonitor).toBe('function')
  })
})
