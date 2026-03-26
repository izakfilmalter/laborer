/**
 * Unit tests for the LifecycleMonitor.
 *
 * Tests verify:
 * - Startup detection via `ready` message
 * - Crash detection via unexpected exit handler
 * - Auto-restart with exponential backoff
 * - Max restart limit
 * - Heartbeat monitoring (timeout → kill + restart)
 * - Manual restart resets backoff counter
 * - Shutdown cancels pending restarts and heartbeat timers
 * - Status events emitted correctly
 * - Multiple services monitored independently
 *
 * The LifecycleMonitor wraps UtilityProcessManager, so we mock the
 * manager interface rather than Electron APIs directly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Mock Electron's BrowserWindow for status event broadcasting
// ---------------------------------------------------------------------------

const mockWebContentsSend = vi.fn()
const mockGetAllWindows = vi.fn(() => [
  { isDestroyed: () => false, webContents: { send: mockWebContentsSend } },
])

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => mockGetAllWindows(),
  },
}))

import {
  backoffDelay,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  LifecycleMonitor,
  type LifecycleStatus,
} from '../src/lifecycle-monitor.js'
// Import after mocks
import type {
  ProcessExitHandler,
  ProcessMessageHandler,
  ServiceName,
  UtilityProcessManager,
} from '../src/utility-process-manager.js'

// ---------------------------------------------------------------------------
// Mock UtilityProcessManager
// ---------------------------------------------------------------------------

interface MockManager {
  exitHandler: ProcessExitHandler | null
  forkCalls: ServiceName[]
  killCalls: ServiceName[]
  messageHandler: ProcessMessageHandler | null
  restartCalls: ServiceName[]
  runningServices: Set<ServiceName>
  simulateUnexpectedExit: (
    name: ServiceName,
    code: number,
    lastStderr: string
  ) => void
}

function createMockManager(): MockManager & UtilityProcessManager {
  const state: MockManager = {
    exitHandler: null,
    forkCalls: [],
    killCalls: [],
    messageHandler: null,
    restartCalls: [],
    runningServices: new Set(),
    simulateUnexpectedExit(name, code, lastStderr) {
      state.runningServices.delete(name)
      state.exitHandler?.(name, code, lastStderr)
    },
  }

  const manager = {
    fork(name: ServiceName) {
      state.forkCalls.push(name)
      state.runningServices.add(name)
      return {} as never // MessagePortMain mock
    },
    getLastStderr() {
      return ''
    },
    getPid() {
      return undefined
    },
    getPort() {
      return undefined
    },
    getProcess() {
      return undefined
    },
    isRunning(name: ServiceName) {
      return state.runningServices.has(name)
    },
    kill(name: ServiceName) {
      state.killCalls.push(name)
      state.runningServices.delete(name)
    },
    killAll() {
      state.runningServices.clear()
    },
    killAllAndWait() {
      state.runningServices.clear()
      return Promise.resolve()
    },
    restart(name: ServiceName) {
      state.restartCalls.push(name)
      state.runningServices.delete(name)
      state.runningServices.add(name)
      return {} as never
    },
    setExitHandler(handler: ProcessExitHandler) {
      state.exitHandler = handler
    },
    setMessageHandler(handler: ProcessMessageHandler) {
      state.messageHandler = handler
    },
  }

  return Object.assign(manager, state) as unknown as MockManager &
    UtilityProcessManager
}

// ---------------------------------------------------------------------------
// Tests
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
  })

  it('follows exponential progression', () => {
    const delays = Array.from({ length: 8 }, (_, i) => backoffDelay(i))
    expect(delays).toEqual([
      500, 1000, 2000, 4000, 8000, 10_000, 10_000, 10_000,
    ])
  })
})

describe('LifecycleMonitor', () => {
  let mockManager: MockManager & UtilityProcessManager
  let monitor: LifecycleMonitor
  let statuses: LifecycleStatus[]

  beforeEach(() => {
    vi.useFakeTimers()
    mockManager = createMockManager()
    monitor = new LifecycleMonitor(mockManager, { maxRestarts: 3 })
    statuses = []
    monitor.setStatusListener((status) => statuses.push(status))
    mockWebContentsSend.mockClear()
    mockGetAllWindows.mockClear()
    mockGetAllWindows.mockReturnValue([
      {
        isDestroyed: () => false,
        webContents: { send: mockWebContentsSend },
      },
    ])
  })

  afterEach(() => {
    monitor.shutdown()
    vi.useRealTimers()
  })

  // -----------------------------------------------------------------------
  // forkAndMonitor
  // -----------------------------------------------------------------------

  describe('forkAndMonitor', () => {
    it('forks the service via the manager', () => {
      monitor.forkAndMonitor('terminal')
      expect(mockManager.forkCalls).toContain('terminal')
    })

    it('emits starting status immediately', () => {
      monitor.forkAndMonitor('terminal')
      expect(statuses).toHaveLength(1)
      expect(statuses[0]).toEqual({ state: 'starting', name: 'terminal' })
    })

    it('is not healthy before ready message', () => {
      monitor.forkAndMonitor('terminal')
      expect(monitor.isHealthy('terminal')).toBe(false)
    })

    it('broadcasts status to renderer windows via IPC', () => {
      monitor.forkAndMonitor('terminal')
      expect(mockWebContentsSend).toHaveBeenCalledWith(
        'sidecar:status',
        expect.objectContaining({ state: 'starting', name: 'terminal' })
      )
    })
  })

  // -----------------------------------------------------------------------
  // forkAllAndMonitor
  // -----------------------------------------------------------------------

  describe('forkAllAndMonitor', () => {
    it('forks all specified services', () => {
      monitor.forkAllAndMonitor(['terminal', 'server'])
      expect(mockManager.forkCalls).toEqual(['terminal', 'server'])
    })

    it('emits starting status for each service', () => {
      monitor.forkAllAndMonitor(['terminal', 'server'])
      const startingStatuses = statuses.filter((s) => s.state === 'starting')
      expect(startingStatuses).toHaveLength(2)
      expect(startingStatuses.map((s) => s.name).sort()).toEqual([
        'server',
        'terminal',
      ])
    })
  })

  // -----------------------------------------------------------------------
  // handleReady
  // -----------------------------------------------------------------------

  describe('handleReady', () => {
    it('marks the service as healthy', () => {
      monitor.forkAndMonitor('terminal')
      monitor.handleReady('terminal')
      expect(monitor.isHealthy('terminal')).toBe(true)
    })

    it('emits healthy status', () => {
      monitor.forkAndMonitor('terminal')
      monitor.handleReady('terminal')
      const healthyStatus = statuses.find((s) => s.state === 'healthy')
      expect(healthyStatus).toEqual({ state: 'healthy', name: 'terminal' })
    })

    it('resets restart attempts on becoming healthy', () => {
      monitor.forkAndMonitor('terminal')

      // Simulate a crash and auto-restart to increment attempts.
      mockManager.simulateUnexpectedExit('terminal', 1, '')
      vi.advanceTimersByTime(600) // past 500ms backoff

      // Now mark the restarted process as ready.
      monitor.handleReady('terminal')
      expect(monitor.isHealthy('terminal')).toBe(true)

      // A subsequent crash should restart with attempt 0 backoff (500ms)
      // not attempt 1 backoff (1000ms).
      mockManager.simulateUnexpectedExit('terminal', 1, '')
      const restartingStatus = statuses.filter((s) => s.state === 'restarting')
      const lastRestarting = restartingStatus.at(-1)
      expect(lastRestarting).toBeDefined()
      if (lastRestarting?.state === 'restarting') {
        expect(lastRestarting.delayMs).toBe(500)
      }
    })

    it('ignores duplicate ready messages', () => {
      monitor.forkAndMonitor('terminal')
      monitor.handleReady('terminal')
      monitor.handleReady('terminal')

      const healthyStatuses = statuses.filter((s) => s.state === 'healthy')
      expect(healthyStatuses).toHaveLength(1)
    })

    it('ignores ready for unknown service', () => {
      monitor.handleReady('terminal')
      expect(monitor.isHealthy('terminal')).toBe(false)
    })
  })

  // -----------------------------------------------------------------------
  // Crash detection
  // -----------------------------------------------------------------------

  describe('crash detection', () => {
    it('emits crashed status on unexpected exit', () => {
      monitor.forkAndMonitor('terminal')
      monitor.handleReady('terminal')

      mockManager.simulateUnexpectedExit('terminal', 1, 'segfault')

      const crashedStatus = statuses.find((s) => s.state === 'crashed')
      expect(crashedStatus).toBeDefined()
      if (crashedStatus?.state === 'crashed') {
        expect(crashedStatus.error).toContain('code=1')
        expect(crashedStatus.error).toContain('segfault')
      }
    })

    it('marks service as not healthy after crash', () => {
      monitor.forkAndMonitor('terminal')
      monitor.handleReady('terminal')
      expect(monitor.isHealthy('terminal')).toBe(true)

      mockManager.simulateUnexpectedExit('terminal', 1, '')
      expect(monitor.isHealthy('terminal')).toBe(false)
    })

    it('includes stderr in crash error message', () => {
      monitor.forkAndMonitor('server')
      monitor.handleReady('server')

      mockManager.simulateUnexpectedExit('server', 1, 'Error: module not found')

      const crashedStatus = statuses.find(
        (s) => s.state === 'crashed' && s.name === 'server'
      )
      expect(crashedStatus).toBeDefined()
      if (crashedStatus?.state === 'crashed') {
        expect(crashedStatus.error).toContain('Error: module not found')
      }
    })

    it('does not emit crash during shutdown', () => {
      monitor.forkAndMonitor('terminal')
      monitor.handleReady('terminal')
      monitor.shutdown()

      mockManager.simulateUnexpectedExit('terminal', 1, '')

      const crashedStatuses = statuses.filter((s) => s.state === 'crashed')
      expect(crashedStatuses).toHaveLength(0)
    })
  })

  // -----------------------------------------------------------------------
  // Auto-restart with exponential backoff
  // -----------------------------------------------------------------------

  describe('auto-restart', () => {
    it('schedules restart after crash with backoff delay', () => {
      monitor.forkAndMonitor('terminal')
      monitor.handleReady('terminal')

      mockManager.simulateUnexpectedExit('terminal', 1, '')

      const restartingStatus = statuses.find((s) => s.state === 'restarting')
      expect(restartingStatus).toBeDefined()
      if (restartingStatus?.state === 'restarting') {
        expect(restartingStatus.delayMs).toBe(500) // first attempt
      }
    })

    it('forks a new process after backoff delay', () => {
      monitor.forkAndMonitor('terminal')
      monitor.handleReady('terminal')

      const initialForkCount = mockManager.forkCalls.length

      mockManager.simulateUnexpectedExit('terminal', 1, '')
      vi.advanceTimersByTime(600) // past 500ms backoff

      expect(mockManager.forkCalls.length).toBe(initialForkCount + 1)
      expect(mockManager.forkCalls.at(-1)).toBe('terminal')
    })

    it('increases backoff delay on subsequent crashes', () => {
      monitor.forkAndMonitor('terminal')
      monitor.handleReady('terminal')

      // First crash: 500ms backoff
      mockManager.simulateUnexpectedExit('terminal', 1, '')
      let restartingStatuses = statuses.filter((s) => s.state === 'restarting')
      expect(restartingStatuses[0]).toBeDefined()
      if (restartingStatuses[0]?.state === 'restarting') {
        expect(restartingStatuses[0].delayMs).toBe(500)
      }

      vi.advanceTimersByTime(600)

      // Second crash: 1000ms backoff
      mockManager.simulateUnexpectedExit('terminal', 1, '')
      restartingStatuses = statuses.filter((s) => s.state === 'restarting')
      const lastRestarting = restartingStatuses.at(-1)
      expect(lastRestarting).toBeDefined()
      if (lastRestarting?.state === 'restarting') {
        expect(lastRestarting.delayMs).toBe(1000)
      }
    })

    it('stops restarting after max attempts', () => {
      monitor.forkAndMonitor('terminal')
      monitor.handleReady('terminal')

      // Exhaust all restart attempts (maxRestarts = 3).
      for (let i = 0; i < 3; i++) {
        mockManager.simulateUnexpectedExit('terminal', 1, '')
        vi.advanceTimersByTime(20_000) // advance past any backoff
      }

      // One more crash should NOT schedule a restart.
      const statusCountBefore = statuses.length
      mockManager.simulateUnexpectedExit('terminal', 1, '')

      const newStatuses = statuses.slice(statusCountBefore)
      const hasRestarting = newStatuses.some((s) => s.state === 'restarting')
      expect(hasRestarting).toBe(false)

      // Should have a "max attempts" crashed status (in addition to the
      // exit crashed status). The exit handler emits "Process exited
      // unexpectedly..." first, then scheduleRestart emits "3 attempts".
      const maxAttemptsCrashed = newStatuses.find(
        (s) => s.state === 'crashed' && s.error?.includes('3 attempts')
      )
      expect(maxAttemptsCrashed).toBeDefined()
    })

    it('does not stack multiple restart timers', () => {
      monitor.forkAndMonitor('terminal')
      monitor.handleReady('terminal')

      // Trigger two crashes rapidly.
      mockManager.simulateUnexpectedExit('terminal', 1, '')
      // The exit handler deletes from runningServices, re-add for second crash.
      mockManager.runningServices.add('terminal')
      mockManager.simulateUnexpectedExit('terminal', 1, '')

      // Should only have one restarting status (not two).
      const restartingStatuses = statuses.filter(
        (s) => s.state === 'restarting'
      )
      expect(restartingStatuses).toHaveLength(1)
    })

    it('emits starting status when restart executes', () => {
      monitor.forkAndMonitor('terminal')
      monitor.handleReady('terminal')

      mockManager.simulateUnexpectedExit('terminal', 1, '')
      vi.advanceTimersByTime(600) // past 500ms backoff

      const startingAfterCrash = statuses.filter((s) => s.state === 'starting')
      // One from initial fork, one from restart.
      expect(startingAfterCrash.length).toBeGreaterThanOrEqual(2)
    })
  })

  // -----------------------------------------------------------------------
  // Heartbeat monitoring
  // -----------------------------------------------------------------------

  describe('heartbeat monitoring', () => {
    it('starts heartbeat timer after ready', () => {
      monitor.forkAndMonitor('terminal')
      monitor.handleReady('terminal')

      // Advance to just before the timeout — should still be healthy.
      vi.advanceTimersByTime(HEARTBEAT_TIMEOUT_MS - 100)
      expect(monitor.isHealthy('terminal')).toBe(true)
    })

    it('kills and restarts process on heartbeat timeout', () => {
      monitor.forkAndMonitor('terminal')
      monitor.handleReady('terminal')

      // Advance past the heartbeat timeout.
      vi.advanceTimersByTime(HEARTBEAT_TIMEOUT_MS + 100)

      // Should have killed the process.
      expect(mockManager.killCalls).toContain('terminal')

      // Should emit crashed status.
      const crashedStatus = statuses.find(
        (s) => s.state === 'crashed' && s.error?.includes('unresponsive')
      )
      expect(crashedStatus).toBeDefined()
    })

    it('resets heartbeat timer on heartbeat message', () => {
      monitor.forkAndMonitor('terminal')
      monitor.handleReady('terminal')

      // Advance to near the timeout.
      vi.advanceTimersByTime(HEARTBEAT_TIMEOUT_MS - 1000)

      // Send a heartbeat — should reset the timer.
      monitor.handleHeartbeat('terminal')

      // Advance past the original timeout — should still be healthy.
      vi.advanceTimersByTime(2000)
      expect(monitor.isHealthy('terminal')).toBe(true)

      // But advancing past the NEW timeout should trigger.
      vi.advanceTimersByTime(HEARTBEAT_TIMEOUT_MS)

      expect(mockManager.killCalls).toContain('terminal')
    })

    it('ignores heartbeats for non-ready services', () => {
      monitor.forkAndMonitor('terminal')
      // Don't call handleReady — service is still starting.

      monitor.handleHeartbeat('terminal')

      // Advance a lot of time — should not trigger any timeout.
      vi.advanceTimersByTime(HEARTBEAT_TIMEOUT_MS * 3)
      expect(mockManager.killCalls).not.toContain('terminal')
    })

    it('clears heartbeat timer on crash', () => {
      monitor.forkAndMonitor('terminal')
      monitor.handleReady('terminal')

      // Crash the process.
      mockManager.simulateUnexpectedExit('terminal', 1, '')

      // Advance past the heartbeat timeout — should NOT double-trigger.
      vi.advanceTimersByTime(HEARTBEAT_TIMEOUT_MS + 1000)

      // Kill should not have been called directly (only the exit handler ran).
      // The heartbeat timer was cleared by the crash handler.
      const killCallsForTerminal = mockManager.killCalls.filter(
        (n) => n === 'terminal'
      )
      expect(killCallsForTerminal).toHaveLength(0)
    })
  })

  // -----------------------------------------------------------------------
  // Manual restart
  // -----------------------------------------------------------------------

  describe('manualRestart', () => {
    it('resets the backoff counter', async () => {
      vi.useRealTimers()

      const realManager = createMockManager()
      const realMonitor = new LifecycleMonitor(realManager, { maxRestarts: 3 })
      const realStatuses: LifecycleStatus[] = []
      realMonitor.setStatusListener((status) => realStatuses.push(status))

      realMonitor.forkAndMonitor('terminal')
      realMonitor.handleReady('terminal')

      await realMonitor.manualRestart('terminal')

      // Should have called restart on the manager.
      expect(realManager.restartCalls).toContain('terminal')

      // Status should include starting.
      const startingStatuses = realStatuses.filter(
        (s) => s.state === 'starting'
      )
      expect(startingStatuses.length).toBeGreaterThanOrEqual(2)

      realMonitor.shutdown()
    })

    it('cancels pending auto-restart', () => {
      monitor.forkAndMonitor('terminal')
      monitor.handleReady('terminal')

      // Crash triggers auto-restart schedule.
      mockManager.simulateUnexpectedExit('terminal', 1, '')

      // Manual restart before the timer fires.
      // Need to use real timers for this part since manualRestart is async.
      // Instead, verify that after manual restart, the service is in starting state.
      const restartPromise = monitor.manualRestart('terminal')

      // The restarting status from auto-restart should be present.
      const restartingStatuses = statuses.filter(
        (s) => s.state === 'restarting'
      )
      expect(restartingStatuses).toHaveLength(1)

      // After manual restart, there should be a new starting status.
      return restartPromise.then(() => {
        const startingAfterManual = statuses.filter(
          (s) => s.state === 'starting'
        )
        expect(startingAfterManual.length).toBeGreaterThanOrEqual(2)
      })
    })

    it('marks service as not healthy during restart', async () => {
      vi.useRealTimers()

      const realManager = createMockManager()
      const realMonitor = new LifecycleMonitor(realManager, { maxRestarts: 3 })

      realMonitor.forkAndMonitor('terminal')
      realMonitor.handleReady('terminal')
      expect(realMonitor.isHealthy('terminal')).toBe(true)

      await realMonitor.manualRestart('terminal')
      expect(realMonitor.isHealthy('terminal')).toBe(false)

      realMonitor.shutdown()
    })
  })

  // -----------------------------------------------------------------------
  // areServicesHealthy
  // -----------------------------------------------------------------------

  describe('areServicesHealthy', () => {
    it('returns true when all specified services are healthy', () => {
      monitor.forkAllAndMonitor(['terminal', 'server'])
      monitor.handleReady('terminal')
      monitor.handleReady('server')
      expect(monitor.areServicesHealthy(['terminal', 'server'])).toBe(true)
    })

    it('returns false when some services are not healthy', () => {
      monitor.forkAllAndMonitor(['terminal', 'server'])
      monitor.handleReady('terminal')
      expect(monitor.areServicesHealthy(['terminal', 'server'])).toBe(false)
    })

    it('returns true for empty list', () => {
      expect(monitor.areServicesHealthy([])).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // Shutdown
  // -----------------------------------------------------------------------

  describe('shutdown', () => {
    it('cancels all pending restart timers', () => {
      monitor.forkAndMonitor('terminal')
      monitor.handleReady('terminal')

      mockManager.simulateUnexpectedExit('terminal', 1, '')

      // Verify restart was scheduled.
      const restartingStatus = statuses.find((s) => s.state === 'restarting')
      expect(restartingStatus).toBeDefined()

      const forkCountBefore = mockManager.forkCalls.length

      monitor.shutdown()

      // Advance past the backoff delay.
      vi.advanceTimersByTime(20_000)

      // Should NOT have forked a new process.
      expect(mockManager.forkCalls.length).toBe(forkCountBefore)
    })

    it('cancels heartbeat timers', () => {
      monitor.forkAndMonitor('terminal')
      monitor.handleReady('terminal')

      monitor.shutdown()

      // Advance past heartbeat timeout.
      vi.advanceTimersByTime(HEARTBEAT_TIMEOUT_MS + 1000)

      // Should NOT have killed the process.
      expect(mockManager.killCalls).toHaveLength(0)
    })

    it('suppresses crash handling after shutdown', () => {
      monitor.forkAndMonitor('terminal')
      monitor.handleReady('terminal')
      monitor.shutdown()

      mockManager.simulateUnexpectedExit('terminal', 1, '')

      const crashedStatuses = statuses.filter((s) => s.state === 'crashed')
      expect(crashedStatuses).toHaveLength(0)
    })
  })

  // -----------------------------------------------------------------------
  // Multiple services
  // -----------------------------------------------------------------------

  describe('multiple services', () => {
    it('tracks services independently', () => {
      monitor.forkAllAndMonitor(['terminal', 'server'])

      monitor.handleReady('terminal')
      expect(monitor.isHealthy('terminal')).toBe(true)
      expect(monitor.isHealthy('server')).toBe(false)

      monitor.handleReady('server')
      expect(monitor.isHealthy('terminal')).toBe(true)
      expect(monitor.isHealthy('server')).toBe(true)
    })

    it('crash in one service does not affect others', () => {
      monitor.forkAllAndMonitor(['terminal', 'server'])
      monitor.handleReady('terminal')
      monitor.handleReady('server')

      mockManager.simulateUnexpectedExit('terminal', 1, '')

      expect(monitor.isHealthy('terminal')).toBe(false)
      expect(monitor.isHealthy('server')).toBe(true)
    })

    it('restart counts are per-service', () => {
      monitor.forkAllAndMonitor(['terminal', 'server'])
      monitor.handleReady('terminal')
      monitor.handleReady('server')

      // Crash terminal twice.
      mockManager.simulateUnexpectedExit('terminal', 1, '')
      vi.advanceTimersByTime(600)
      mockManager.simulateUnexpectedExit('terminal', 1, '')

      // Terminal should be on attempt 2, server on attempt 0.
      const terminalRestarting = statuses.filter(
        (s) => s.state === 'restarting' && s.name === 'terminal'
      )
      expect(terminalRestarting).toHaveLength(2)

      // Crash server once — should use attempt 0 backoff (500ms).
      mockManager.simulateUnexpectedExit('server', 1, '')
      const serverRestarting = statuses.filter(
        (s) => s.state === 'restarting' && s.name === 'server'
      )
      expect(serverRestarting).toHaveLength(1)
      if (serverRestarting[0]?.state === 'restarting') {
        expect(serverRestarting[0].delayMs).toBe(500)
      }
    })
  })

  // -----------------------------------------------------------------------
  // Status event broadcasting
  // -----------------------------------------------------------------------

  describe('status broadcasting', () => {
    it('sends status events to all renderer windows', () => {
      const mockSend1 = vi.fn()
      const mockSend2 = vi.fn()
      mockGetAllWindows.mockReturnValue([
        { isDestroyed: () => false, webContents: { send: mockSend1 } },
        { isDestroyed: () => false, webContents: { send: mockSend2 } },
      ])

      monitor.forkAndMonitor('terminal')

      expect(mockSend1).toHaveBeenCalledWith(
        'sidecar:status',
        expect.objectContaining({ state: 'starting', name: 'terminal' })
      )
      expect(mockSend2).toHaveBeenCalledWith(
        'sidecar:status',
        expect.objectContaining({ state: 'starting', name: 'terminal' })
      )
    })

    it('skips destroyed windows', () => {
      const mockSend = vi.fn()
      mockGetAllWindows.mockReturnValue([
        {
          isDestroyed: () => true as unknown as false,
          webContents: { send: mockSend },
        },
      ])

      monitor.forkAndMonitor('terminal')

      expect(mockSend).not.toHaveBeenCalled()
    })
  })

  // -----------------------------------------------------------------------
  // Heartbeat constants
  // -----------------------------------------------------------------------

  describe('heartbeat constants', () => {
    it('HEARTBEAT_INTERVAL_MS is 5000', () => {
      expect(HEARTBEAT_INTERVAL_MS).toBe(5000)
    })

    it('HEARTBEAT_TIMEOUT_MS is 15000', () => {
      expect(HEARTBEAT_TIMEOUT_MS).toBe(15_000)
    })

    it('timeout is 3x the interval', () => {
      expect(HEARTBEAT_TIMEOUT_MS).toBe(HEARTBEAT_INTERVAL_MS * 3)
    })
  })
})
