/**
 * Unit tests for the DevWatcher (dev mode hot reload).
 *
 * Tests verify:
 * - File watching is set up for all three service dist directories
 * - File change events trigger utility process restarts
 * - Debounce prevents rapid restarts during a single rebuild
 * - Shutdown cancels watchers and pending debounce timers
 * - Watch errors are handled gracefully (missing directories)
 * - Restarts go through the LifecycleMonitor (not direct manager calls)
 *
 * The DevWatcher depends on LifecycleMonitor, which we mock since it is
 * tested separately in lifecycle-monitor.test.ts. We also use a mock
 * watch function to avoid filesystem dependencies.
 *
 * @see Issue #17: Dev mode hot reload (tsdown --watch + auto-restart)
 */

import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DEBOUNCE_MS,
  DevWatcher,
  type FsWatcher,
  type WatchFn,
} from '../src/dev-watcher.js'
import type { LifecycleMonitor } from '../src/lifecycle-monitor.js'
import type { ServiceName } from '../src/utility-process-manager.js'

// ---------------------------------------------------------------------------
// Mock LifecycleMonitor
// ---------------------------------------------------------------------------

interface MockLifecycleMonitor {
  manualRestartCalls: ServiceName[]
}

function createMockLifecycleMonitor(): MockLifecycleMonitor & LifecycleMonitor {
  const state: MockLifecycleMonitor = {
    manualRestartCalls: [],
  }

  const monitor = {
    manualRestart(name: ServiceName) {
      state.manualRestartCalls.push(name)
      return Promise.resolve()
    },
  }

  return Object.assign(monitor, state) as unknown as MockLifecycleMonitor &
    LifecycleMonitor
}

// ---------------------------------------------------------------------------
// Mock fs.watch
// ---------------------------------------------------------------------------

interface MockWatcher {
  callback: (eventType: string, filename: string | null) => void
  closed: boolean
  path: string
}

function createMockWatchFn(): {
  watchFn: WatchFn
  watchers: MockWatcher[]
  failPaths: Set<string>
} {
  const watchers: MockWatcher[] = []
  const failPaths = new Set<string>()

  const watchFn: WatchFn = (path, _options, callback) => {
    if (failPaths.has(path)) {
      throw new Error(`ENOENT: no such file or directory, watch '${path}'`)
    }

    const watcher: MockWatcher = {
      path,
      callback,
      closed: false,
    }
    watchers.push(watcher)

    const fsWatcher: FsWatcher = {
      close() {
        watcher.closed = true
      },
    }

    return fsWatcher
  }

  return { watchFn, watchers, failPaths }
}

/**
 * Find a mock watcher by package name substring.
 * Throws if not found, which makes the test fail with a descriptive message.
 */
function findWatcher(
  watchers: readonly MockWatcher[],
  pkgName: string
): MockWatcher {
  const watcher = watchers.find((w) => w.path.includes(pkgName))
  if (!watcher) {
    throw new Error(
      `No watcher found for '${pkgName}'. Available: ${watchers.map((w) => w.path).join(', ')}`
    )
  }
  return watcher
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DevWatcher', () => {
  let mockMonitor: MockLifecycleMonitor & LifecycleMonitor
  let mockWatch: ReturnType<typeof createMockWatchFn>
  let devWatcher: DevWatcher

  const REPO_ROOT = '/test/repo'

  beforeEach(() => {
    vi.useFakeTimers()
    mockMonitor = createMockLifecycleMonitor()
    mockWatch = createMockWatchFn()
    devWatcher = new DevWatcher({
      lifecycleMonitor: mockMonitor,
      repoRoot: REPO_ROOT,
      watchFn: mockWatch.watchFn,
    })
  })

  afterEach(() => {
    devWatcher.shutdown()
    vi.useRealTimers()
  })

  // -----------------------------------------------------------------------
  // startWatching
  // -----------------------------------------------------------------------

  describe('startWatching', () => {
    it('watches all three service dist directories', () => {
      devWatcher.startWatching()

      expect(mockWatch.watchers).toHaveLength(3)

      const watchedPaths = mockWatch.watchers.map((w) => w.path).sort()
      expect(watchedPaths).toEqual([
        join(REPO_ROOT, 'packages/file-watcher/dist'),
        join(REPO_ROOT, 'packages/server/dist'),
        join(REPO_ROOT, 'packages/terminal/dist'),
      ])
    })

    it('handles missing dist directories gracefully', () => {
      mockWatch.failPaths.add(join(REPO_ROOT, 'packages/terminal/dist'))

      // Should not throw — logs a warning and continues.
      devWatcher.startWatching()

      // 2 watchers created (terminal failed).
      expect(mockWatch.watchers).toHaveLength(2)
    })

    it('does nothing after shutdown', () => {
      devWatcher.shutdown()
      devWatcher.startWatching()

      expect(mockWatch.watchers).toHaveLength(0)
    })
  })

  // -----------------------------------------------------------------------
  // File change → restart
  // -----------------------------------------------------------------------

  describe('file change triggers restart', () => {
    it('restarts the terminal utility process on dist change', () => {
      devWatcher.startWatching()

      const watcher = findWatcher(mockWatch.watchers, 'terminal')
      watcher.callback('change', 'utility-main.mjs')

      // Advance past the debounce delay.
      vi.advanceTimersByTime(DEBOUNCE_MS + 10)

      expect(mockMonitor.manualRestartCalls).toEqual(['terminal'])
    })

    it('restarts the server utility process on dist change', () => {
      devWatcher.startWatching()

      const watcher = findWatcher(mockWatch.watchers, 'server')
      watcher.callback('change', 'utility-main.mjs')
      vi.advanceTimersByTime(DEBOUNCE_MS + 10)

      expect(mockMonitor.manualRestartCalls).toEqual(['server'])
    })

    it('restarts the file-watcher utility process on dist change', () => {
      devWatcher.startWatching()

      const watcher = findWatcher(mockWatch.watchers, 'file-watcher')
      watcher.callback('change', 'utility-main.mjs')
      vi.advanceTimersByTime(DEBOUNCE_MS + 10)

      expect(mockMonitor.manualRestartCalls).toEqual(['file-watcher'])
    })

    it('does not restart before debounce expires', () => {
      devWatcher.startWatching()

      const watcher = findWatcher(mockWatch.watchers, 'terminal')
      watcher.callback('change', 'utility-main.mjs')

      // Advance to just before the debounce.
      vi.advanceTimersByTime(DEBOUNCE_MS - 10)

      expect(mockMonitor.manualRestartCalls).toHaveLength(0)
    })
  })

  // -----------------------------------------------------------------------
  // Debounce
  // -----------------------------------------------------------------------

  describe('debounce', () => {
    it('coalesces multiple rapid changes into a single restart', () => {
      devWatcher.startWatching()

      const watcher = findWatcher(mockWatch.watchers, 'terminal')

      // Simulate multiple rapid file changes (tsdown writes .mjs, .mjs.map, .d.mts).
      watcher.callback('change', 'utility-main.mjs')
      vi.advanceTimersByTime(50)
      watcher.callback('change', 'utility-main.mjs.map')
      vi.advanceTimersByTime(50)
      watcher.callback('change', 'utility-main.d.mts')

      // Advance past the debounce from the LAST event.
      vi.advanceTimersByTime(DEBOUNCE_MS + 10)

      // Should have only one restart, not three.
      expect(mockMonitor.manualRestartCalls).toEqual(['terminal'])
    })

    it('resets debounce timer on each new change', () => {
      devWatcher.startWatching()

      const watcher = findWatcher(mockWatch.watchers, 'terminal')

      watcher.callback('change', 'utility-main.mjs')

      // Advance to just before the debounce.
      vi.advanceTimersByTime(DEBOUNCE_MS - 10)

      // Another change resets the timer.
      watcher.callback('change', 'utility-main.mjs.map')

      // Advance past the original debounce — should NOT have restarted yet.
      vi.advanceTimersByTime(20)
      expect(mockMonitor.manualRestartCalls).toHaveLength(0)

      // Advance past the new debounce.
      vi.advanceTimersByTime(DEBOUNCE_MS)
      expect(mockMonitor.manualRestartCalls).toEqual(['terminal'])
    })

    it('debounces per service independently', () => {
      devWatcher.startWatching()

      const terminalWatcher = findWatcher(mockWatch.watchers, 'terminal')
      const serverWatcher = findWatcher(mockWatch.watchers, 'server')

      terminalWatcher.callback('change', 'utility-main.mjs')
      serverWatcher.callback('change', 'utility-main.mjs')

      vi.advanceTimersByTime(DEBOUNCE_MS + 10)

      // Both should restart independently.
      expect(mockMonitor.manualRestartCalls.sort()).toEqual([
        'server',
        'terminal',
      ])
    })
  })

  // -----------------------------------------------------------------------
  // Shutdown
  // -----------------------------------------------------------------------

  describe('shutdown', () => {
    it('closes all file watchers', () => {
      devWatcher.startWatching()
      expect(mockWatch.watchers.every((w) => !w.closed)).toBe(true)

      devWatcher.shutdown()

      expect(mockWatch.watchers.every((w) => w.closed)).toBe(true)
    })

    it('cancels pending debounce timers', () => {
      devWatcher.startWatching()

      const watcher = findWatcher(mockWatch.watchers, 'terminal')
      watcher.callback('change', 'utility-main.mjs')

      devWatcher.shutdown()

      // Advance past the debounce — should NOT restart.
      vi.advanceTimersByTime(DEBOUNCE_MS + 100)
      expect(mockMonitor.manualRestartCalls).toHaveLength(0)
    })

    it('prevents new restarts after shutdown', () => {
      devWatcher.startWatching()

      const watcher = findWatcher(mockWatch.watchers, 'terminal')

      devWatcher.shutdown()

      // Simulate a change after shutdown.
      watcher.callback('change', 'utility-main.mjs')
      vi.advanceTimersByTime(DEBOUNCE_MS + 100)

      expect(mockMonitor.manualRestartCalls).toHaveLength(0)
    })
  })

  // -----------------------------------------------------------------------
  // DEBOUNCE_MS constant
  // -----------------------------------------------------------------------

  describe('constants', () => {
    it('DEBOUNCE_MS is 200', () => {
      expect(DEBOUNCE_MS).toBe(200)
    })
  })

  // -----------------------------------------------------------------------
  // Restart failure handling
  // -----------------------------------------------------------------------

  describe('restart failure handling', () => {
    it('handles manualRestart rejection gracefully', () => {
      const failingMonitor = createMockLifecycleMonitor()
      ;(failingMonitor as unknown as Record<string, unknown>).manualRestart =
        () => Promise.reject(new Error('Restart failed'))

      const watcher = new DevWatcher({
        lifecycleMonitor: failingMonitor as unknown as LifecycleMonitor,
        repoRoot: REPO_ROOT,
        watchFn: mockWatch.watchFn,
      })
      watcher.startWatching()

      const terminalWatcher = findWatcher(mockWatch.watchers, 'terminal')
      terminalWatcher.callback('change', 'utility-main.mjs')

      // Should not throw — the promise rejection is caught internally.
      vi.advanceTimersByTime(DEBOUNCE_MS + 10)

      watcher.shutdown()
    })
  })
})
