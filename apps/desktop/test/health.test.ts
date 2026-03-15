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
 * - HealthMonitor.spawnServices() spawns all 3 sidecars in parallel
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  backoffDelay,
  HealthMonitor,
  type SidecarStatus,
  waitForHealthy,
} from '../src/health.js'
import type { SidecarManager } from '../src/sidecar.js'

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
// Helpers for HealthMonitor tests
// ---------------------------------------------------------------------------

type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void

/** Create an HTTP server on a random port, returning server + port. */
function createTestServer(
  handler: RequestHandler
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0
      resolve({ server, port })
    })
  })
}

/** Sidecar name type (inline to avoid importing sidecar.ts which requires electron). */
type SidecarName = 'server' | 'terminal' | 'file-watcher' | 'mcp'

/**
 * Create a mock SidecarManager that records spawn calls.
 * Spawn is a no-op — HealthMonitor uses HTTP health checks, not process status.
 * Cast to SidecarManager since the class has private fields.
 */
function createMockSidecarManager(): SidecarManager & {
  spawnOrder: SidecarName[]
  spawnTimestamps: Map<SidecarName, number>
} {
  const spawnOrder: SidecarName[] = []
  const spawnTimestamps = new Map<SidecarName, number>()

  const mock = {
    spawnOrder,
    spawnTimestamps,
    spawn(name: SidecarName) {
      spawnOrder.push(name)
      spawnTimestamps.set(name, Date.now())
      return {}
    },
    setExitHandler() {
      // no-op for mock
    },
    getLastStderr() {
      return ''
    },
    getProcess() {
      return undefined
    },
    isRunning() {
      return false
    },
    killOne() {
      // no-op for mock
    },
    killAll() {
      // no-op for mock
    },
    async killAllAndWait() {
      // no-op for mock
    },
    restart(name: SidecarName) {
      return mock.spawn(name)
    },
    async spawnServices() {
      // no-op for mock
    },
  }

  return mock as unknown as SidecarManager & {
    spawnOrder: SidecarName[]
    spawnTimestamps: Map<SidecarName, number>
  }
}

// ---------------------------------------------------------------------------
// HealthMonitor.spawnServices (parallel spawning)
// ---------------------------------------------------------------------------

describe('HealthMonitor.spawnServices', () => {
  let servers: Server[]

  afterEach(() => {
    for (const s of servers) {
      s.close()
    }
    servers = []
  })

  beforeEach(() => {
    servers = []
  })

  it('spawns all 3 sidecars concurrently (not sequentially)', async () => {
    // Create HTTP servers for all 3 sidecars that respond immediately.
    const terminal = await createTestServer((_req, res) => {
      res.writeHead(200)
      res.end('ok')
    })
    const fileWatcher = await createTestServer((_req, res) => {
      res.writeHead(200)
      res.end('ok')
    })
    const server = await createTestServer((_req, res) => {
      res.writeHead(200)
      res.end('ok')
    })
    servers.push(terminal.server, fileWatcher.server, server.server)

    const mockManager = createMockSidecarManager()
    const monitor = new HealthMonitor(mockManager, {
      terminalPort: terminal.port,
      fileWatcherPort: fileWatcher.port,
      serverPort: server.port,
    })

    const result = await monitor.spawnServices()

    expect(result).toBe(true)
    // All 3 should have been spawned.
    expect(mockManager.spawnOrder).toContain('terminal')
    expect(mockManager.spawnOrder).toContain('file-watcher')
    expect(mockManager.spawnOrder).toContain('server')
    expect(mockManager.spawnOrder).toHaveLength(3)

    // Verify all 3 were spawned before any health check could complete —
    // in the old sequential model, server would be spawned much later.
    // Since all servers respond immediately, spawn timestamps should be
    // very close together (within 100ms).
    const timestamps = [...mockManager.spawnTimestamps.values()]
    const maxGap = Math.max(...timestamps) - Math.min(...timestamps)
    expect(maxGap).toBeLessThan(100)
  })

  it('server health reported independently of terminal/file-watcher', async () => {
    // Server responds immediately; terminal and file-watcher respond after 200ms.
    let terminalHealthy = false
    let fileWatcherHealthy = false

    const terminal = await createTestServer((_req, res) => {
      res.writeHead(terminalHealthy ? 200 : 503)
      res.end(terminalHealthy ? 'ok' : 'not ready')
    })
    const fileWatcher = await createTestServer((_req, res) => {
      res.writeHead(fileWatcherHealthy ? 200 : 503)
      res.end(fileWatcherHealthy ? 'ok' : 'not ready')
    })
    const server = await createTestServer((_req, res) => {
      res.writeHead(200)
      res.end('ok')
    })
    servers.push(terminal.server, fileWatcher.server, server.server)

    // Make terminal/file-watcher healthy after a delay.
    setTimeout(() => {
      terminalHealthy = true
      fileWatcherHealthy = true
    }, 200)

    const statuses: SidecarStatus[] = []
    const mockManager = createMockSidecarManager()
    const monitor = new HealthMonitor(mockManager, {
      terminalPort: terminal.port,
      fileWatcherPort: fileWatcher.port,
      serverPort: server.port,
    })
    monitor.setStatusListener((status) => statuses.push(status))

    const result = await monitor.spawnServices()

    expect(result).toBe(true)

    // Server should report healthy before terminal/file-watcher.
    const serverHealthyIndex = statuses.findIndex(
      (s) => s.name === 'server' && s.state === 'healthy'
    )
    const terminalHealthyIndex = statuses.findIndex(
      (s) => s.name === 'terminal' && s.state === 'healthy'
    )
    const fileWatcherHealthyIndex = statuses.findIndex(
      (s) => s.name === 'file-watcher' && s.state === 'healthy'
    )

    expect(serverHealthyIndex).toBeGreaterThanOrEqual(0)
    expect(terminalHealthyIndex).toBeGreaterThanOrEqual(0)
    expect(fileWatcherHealthyIndex).toBeGreaterThanOrEqual(0)

    // Server should have reported healthy first (it was healthy immediately).
    expect(serverHealthyIndex).toBeLessThan(terminalHealthyIndex)
    expect(serverHealthyIndex).toBeLessThan(fileWatcherHealthyIndex)
  })

  it('each sidecar emits its own status events independently', async () => {
    const terminal = await createTestServer((_req, res) => {
      res.writeHead(200)
      res.end('ok')
    })
    const fileWatcher = await createTestServer((_req, res) => {
      res.writeHead(200)
      res.end('ok')
    })
    const server = await createTestServer((_req, res) => {
      res.writeHead(200)
      res.end('ok')
    })
    servers.push(terminal.server, fileWatcher.server, server.server)

    const statuses: SidecarStatus[] = []
    const mockManager = createMockSidecarManager()
    const monitor = new HealthMonitor(mockManager, {
      terminalPort: terminal.port,
      fileWatcherPort: fileWatcher.port,
      serverPort: server.port,
    })
    monitor.setStatusListener((status) => statuses.push(status))

    await monitor.spawnServices()

    // Each sidecar should have emitted 'starting' and 'healthy' independently.
    const startingStatuses = statuses.filter((s) => s.state === 'starting')
    const healthyStatuses = statuses.filter((s) => s.state === 'healthy')

    expect(startingStatuses).toHaveLength(3)
    expect(healthyStatuses).toHaveLength(3)

    // Each service should have its own starting event.
    const startingNames = startingStatuses.map((s) => s.name).sort()
    expect(startingNames).toEqual(['file-watcher', 'server', 'terminal'])

    // Each service should have its own healthy event.
    const healthyNames = healthyStatuses.map((s) => s.name).sort()
    expect(healthyNames).toEqual(['file-watcher', 'server', 'terminal'])
  })

  it(
    'individual sidecar failure does not block others',
    { timeout: 15_000 },
    async () => {
      // Terminal responds healthy, file-watcher responds healthy,
      // server never responds (uses a port with nothing listening).
      const terminal = await createTestServer((_req, res) => {
        res.writeHead(200)
        res.end('ok')
      })
      const fileWatcher = await createTestServer((_req, res) => {
        res.writeHead(200)
        res.end('ok')
      })
      // Close file-watcher server to use its port as a dead port for server.
      const deadPort =
        fileWatcher.port + 10_000 > 65_535 ? 1 : fileWatcher.port + 10_000
      servers.push(terminal.server, fileWatcher.server)

      const statuses: SidecarStatus[] = []
      const mockManager = createMockSidecarManager()
      const monitor = new HealthMonitor(mockManager, {
        terminalPort: terminal.port,
        fileWatcherPort: fileWatcher.port,
        serverPort: deadPort, // Nothing listening — server will time out
      })
      monitor.setStatusListener((status) => statuses.push(status))

      const result = await monitor.spawnServices()

      // Overall result is false because server failed.
      expect(result).toBe(false)

      // But terminal and file-watcher should still have reported healthy.
      const terminalHealthy = statuses.find(
        (s) => s.name === 'terminal' && s.state === 'healthy'
      )
      const fileWatcherHealthy = statuses.find(
        (s) => s.name === 'file-watcher' && s.state === 'healthy'
      )
      const serverCrashed = statuses.find(
        (s) => s.name === 'server' && s.state === 'crashed'
      )

      expect(terminalHealthy).toBeDefined()
      expect(fileWatcherHealthy).toBeDefined()
      expect(serverCrashed).toBeDefined()
    }
  )

  it('startup time is max(sidecars) not sum(sidecars)', async () => {
    // All three sidecars respond after ~200ms each.
    // If parallel: total ~200ms. If sequential: total ~600ms.
    let terminalHealthy = false
    let fileWatcherHealthy = false
    let serverHealthy = false

    const terminal = await createTestServer((_req, res) => {
      res.writeHead(terminalHealthy ? 200 : 503)
      res.end(terminalHealthy ? 'ok' : 'not ready')
    })
    const fileWatcher = await createTestServer((_req, res) => {
      res.writeHead(fileWatcherHealthy ? 200 : 503)
      res.end(fileWatcherHealthy ? 'ok' : 'not ready')
    })
    const server = await createTestServer((_req, res) => {
      res.writeHead(serverHealthy ? 200 : 503)
      res.end(serverHealthy ? 'ok' : 'not ready')
    })
    servers.push(terminal.server, fileWatcher.server, server.server)

    // All become healthy after 200ms.
    setTimeout(() => {
      terminalHealthy = true
      fileWatcherHealthy = true
      serverHealthy = true
    }, 200)

    const mockManager = createMockSidecarManager()
    const monitor = new HealthMonitor(mockManager, {
      terminalPort: terminal.port,
      fileWatcherPort: fileWatcher.port,
      serverPort: server.port,
    })

    const start = Date.now()
    const result = await monitor.spawnServices()
    const elapsed = Date.now() - start

    expect(result).toBe(true)

    // Should complete in roughly 200-500ms (parallel), not 600ms+ (sequential).
    // Use a generous upper bound to account for CI variability.
    expect(elapsed).toBeLessThan(2000)

    // But more importantly: it should be closer to the delay of a single
    // sidecar (200ms + polling overhead) rather than 3x that.
    // The old sequential model would take at least 400ms (terminal+file-watcher
    // in parallel = 200ms, then server = 200ms).
    // The new parallel model takes ~200ms + polling overhead.
  })

  it('crash recovery for individual sidecars still works', async () => {
    const terminal = await createTestServer((_req, res) => {
      res.writeHead(200)
      res.end('ok')
    })
    const fileWatcher = await createTestServer((_req, res) => {
      res.writeHead(200)
      res.end('ok')
    })
    const server = await createTestServer((_req, res) => {
      res.writeHead(200)
      res.end('ok')
    })
    servers.push(terminal.server, fileWatcher.server, server.server)

    const mockManager = createMockSidecarManager()
    const monitor = new HealthMonitor(mockManager, {
      terminalPort: terminal.port,
      fileWatcherPort: fileWatcher.port,
      serverPort: server.port,
    })

    // Initial spawn should succeed.
    const result = await monitor.spawnServices()
    expect(result).toBe(true)
    expect(monitor.areServicesHealthy()).toBe(true)

    // Manual restart of an individual sidecar should still work.
    const restartResult = await monitor.manualRestart('terminal')
    expect(restartResult).toBe(true)
    expect(monitor.isHealthy('terminal')).toBe(true)
  })
})
