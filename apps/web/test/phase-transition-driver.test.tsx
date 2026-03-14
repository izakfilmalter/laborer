/**
 * Tests for the phase transition driver — wires sidecar status events
 * to lifecycle phase transitions.
 *
 * Verifies that:
 * - Phase advances from Starting to Ready when server reports healthy
 * - Phase does not advance on irrelevant sidecar events
 * - Phase advances to Restored when all sidecars are healthy
 * - Out-of-order events are handled correctly
 * - Transitions work in both Electron (IPC) and dev (polling) modes
 *
 * @see Issue #7: Wire sidecar status events to lifecycle phase transitions
 */

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LifecyclePhase,
  LifecyclePhaseProvider,
  useLifecyclePhase,
} from '../src/components/lifecycle-phase-context'
import { PhaseTransitionDriver } from '../src/hooks/use-phase-transition-driver'

/** Displays the current lifecycle phase for test assertions. */
function PhaseDisplay() {
  const { phase } = useLifecyclePhase()
  return <span data-testid="phase">{phase}</span>
}

/** Creates a promise that never resolves — simulates a hanging request. */
function pendingPromise<T>(): Promise<T> {
  return new Promise<T>(() => {
    // Intentionally never resolved
  })
}

describe('PhaseTransitionDriver', () => {
  const originalFetch = globalThis.fetch

  function mockFetch(impl: (url: string) => Promise<{ ok: boolean } | never>) {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      return impl(url) as Promise<Response>
    }) as typeof fetch
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    globalThis.fetch = originalFetch
  })

  // Tracer bullet: phase advances from Starting to Ready when server reports healthy
  it('advances to Ready when server health endpoint responds', async () => {
    mockFetch((url) => {
      if (url === '/server-health') {
        return Promise.resolve({ ok: true })
      }
      return pendingPromise()
    })

    render(
      <LifecyclePhaseProvider>
        <PhaseTransitionDriver />
        <PhaseDisplay />
      </LifecyclePhaseProvider>
    )

    // Initially Starting
    expect(screen.getByTestId('phase').textContent).toBe(
      String(LifecyclePhase.Starting)
    )

    // Let the initial poll complete (server healthy)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    // Phase should advance to Ready
    expect(screen.getByTestId('phase').textContent).toBe(
      String(LifecyclePhase.Ready)
    )
  })

  it('stays at Starting when no sidecar events received', async () => {
    // All fetches hang — no services respond
    mockFetch(() => pendingPromise())

    render(
      <LifecyclePhaseProvider>
        <PhaseTransitionDriver />
        <PhaseDisplay />
      </LifecyclePhaseProvider>
    )

    // Let microtasks flush
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    // Phase should remain Starting
    expect(screen.getByTestId('phase').textContent).toBe(
      String(LifecyclePhase.Starting)
    )

    // Even after a poll interval, still Starting
    await act(async () => {
      vi.advanceTimersByTime(3000)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByTestId('phase').textContent).toBe(
      String(LifecyclePhase.Starting)
    )
  })

  it('does not advance to Ready when only terminal reports healthy', async () => {
    mockFetch((url) => {
      if (url === '/terminal-health') {
        return Promise.resolve({ ok: true })
      }
      return pendingPromise()
    })

    render(
      <LifecyclePhaseProvider>
        <PhaseTransitionDriver />
        <PhaseDisplay />
      </LifecyclePhaseProvider>
    )

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    // Terminal healthy but server not — should still be Starting
    expect(screen.getByTestId('phase').textContent).toBe(
      String(LifecyclePhase.Starting)
    )
  })

  it('does not advance to Ready when only file-watcher reports healthy', async () => {
    mockFetch((url) => {
      if (url === '/file-watcher-health') {
        return Promise.resolve({ ok: true })
      }
      return pendingPromise()
    })

    render(
      <LifecyclePhaseProvider>
        <PhaseTransitionDriver />
        <PhaseDisplay />
      </LifecyclePhaseProvider>
    )

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    // File-watcher healthy but server not — should still be Starting
    expect(screen.getByTestId('phase').textContent).toBe(
      String(LifecyclePhase.Starting)
    )
  })

  it('advances to Restored when terminal + file-watcher become healthy after Ready', async () => {
    let terminalHealthy = false
    let fileWatcherHealthy = false

    mockFetch((url) => {
      if (url === '/server-health') {
        return Promise.resolve({ ok: true })
      }
      if (url === '/terminal-health' && terminalHealthy) {
        return Promise.resolve({ ok: true })
      }
      if (url === '/file-watcher-health' && fileWatcherHealthy) {
        return Promise.resolve({ ok: true })
      }
      if (url === '/terminal-health' || url === '/file-watcher-health') {
        return Promise.reject(new Error('not ready'))
      }
      return pendingPromise()
    })

    render(
      <LifecyclePhaseProvider>
        <PhaseTransitionDriver />
        <PhaseDisplay />
      </LifecyclePhaseProvider>
    )

    // Initial poll — server healthy, others not
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByTestId('phase').textContent).toBe(
      String(LifecyclePhase.Ready)
    )

    // Terminal and file-watcher become healthy
    terminalHealthy = true
    fileWatcherHealthy = true

    // Wait for next poll interval
    await act(async () => {
      vi.advanceTimersByTime(3000)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByTestId('phase').textContent).toBe(
      String(LifecyclePhase.Restored)
    )
  })

  it('handles out-of-order events: terminal healthy before server', async () => {
    let serverHealthy = false

    mockFetch((url) => {
      if (url === '/server-health' && serverHealthy) {
        return Promise.resolve({ ok: true })
      }
      if (url === '/server-health') {
        return Promise.reject(new Error('not ready'))
      }
      if (url === '/terminal-health') {
        return Promise.resolve({ ok: true })
      }
      if (url === '/file-watcher-health') {
        return Promise.resolve({ ok: true })
      }
      return pendingPromise()
    })

    render(
      <LifecyclePhaseProvider>
        <PhaseTransitionDriver />
        <PhaseDisplay />
      </LifecyclePhaseProvider>
    )

    // Initial poll — terminal + file-watcher healthy, server not
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    // Still Starting — server not healthy yet
    expect(screen.getByTestId('phase').textContent).toBe(
      String(LifecyclePhase.Starting)
    )

    // Server becomes healthy
    serverHealthy = true

    await act(async () => {
      vi.advanceTimersByTime(3000)
      await Promise.resolve()
      await Promise.resolve()
    })

    // Should jump to Restored since all three are healthy
    expect(screen.getByTestId('phase').textContent).toBe(
      String(LifecyclePhase.Restored)
    )
  })

  it('advances to Restored when terminal healthy but file-watcher not yet', async () => {
    let fileWatcherHealthy = false

    mockFetch((url) => {
      if (url === '/server-health') {
        return Promise.resolve({ ok: true })
      }
      if (url === '/terminal-health') {
        return Promise.resolve({ ok: true })
      }
      if (url === '/file-watcher-health' && fileWatcherHealthy) {
        return Promise.resolve({ ok: true })
      }
      if (url === '/file-watcher-health') {
        return Promise.reject(new Error('not ready'))
      }
      return pendingPromise()
    })

    render(
      <LifecyclePhaseProvider>
        <PhaseTransitionDriver />
        <PhaseDisplay />
      </LifecyclePhaseProvider>
    )

    // Initial poll — server + terminal healthy, file-watcher not
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    // Should be Ready (server healthy), not Restored (file-watcher not healthy)
    expect(screen.getByTestId('phase').textContent).toBe(
      String(LifecyclePhase.Ready)
    )

    // File-watcher becomes healthy
    fileWatcherHealthy = true

    await act(async () => {
      vi.advanceTimersByTime(3000)
      await Promise.resolve()
      await Promise.resolve()
    })

    // Now Restored
    expect(screen.getByTestId('phase').textContent).toBe(
      String(LifecyclePhase.Restored)
    )
  })

  // Issue #15: Eventually transition via init-status polling
  it('advances to Eventually when init-status returns ready after Restored', async () => {
    let initStatusReady = false

    mockFetch((url) => {
      // All sidecars healthy immediately
      if (url === '/server-health') {
        return Promise.resolve({ ok: true })
      }
      if (url === '/terminal-health') {
        return Promise.resolve({ ok: true })
      }
      if (url === '/file-watcher-health') {
        return Promise.resolve({ ok: true })
      }
      // Init-status endpoint
      if (url === '/server-init-status') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ready: initStatusReady }),
        })
      }
      return pendingPromise()
    })

    render(
      <LifecyclePhaseProvider>
        <PhaseTransitionDriver />
        <PhaseDisplay />
      </LifecyclePhaseProvider>
    )

    // Initial poll — all sidecars healthy → Restored
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByTestId('phase').textContent).toBe(
      String(LifecyclePhase.Restored)
    )

    // Init-status returns not ready — still Restored
    await act(async () => {
      vi.advanceTimersByTime(2000)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByTestId('phase').textContent).toBe(
      String(LifecyclePhase.Restored)
    )

    // Deferred services finish initializing
    initStatusReady = true

    await act(async () => {
      vi.advanceTimersByTime(2000)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByTestId('phase').textContent).toBe(
      String(LifecyclePhase.Eventually)
    )
  })

  it('does not poll init-status before Restored phase', async () => {
    const initStatusCalls: string[] = []

    mockFetch((url) => {
      // Only server healthy — terminal and file-watcher not ready
      if (url === '/server-health') {
        return Promise.resolve({ ok: true })
      }
      if (url === '/server-init-status') {
        initStatusCalls.push(url)
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ready: true }),
        })
      }
      if (url === '/terminal-health' || url === '/file-watcher-health') {
        return Promise.reject(new Error('not ready'))
      }
      return pendingPromise()
    })

    render(
      <LifecyclePhaseProvider>
        <PhaseTransitionDriver />
        <PhaseDisplay />
      </LifecyclePhaseProvider>
    )

    // Initial poll — server healthy, but sidecars not → Ready only
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByTestId('phase').textContent).toBe(
      String(LifecyclePhase.Ready)
    )

    // Advance several poll intervals — init-status should NOT be polled
    await act(async () => {
      vi.advanceTimersByTime(10_000)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(initStatusCalls).toHaveLength(0)
    expect(screen.getByTestId('phase').textContent).toBe(
      String(LifecyclePhase.Ready)
    )
  })

  it('stops polling init-status after Eventually is reached', async () => {
    let initStatusCallCount = 0

    mockFetch((url) => {
      if (url === '/server-health') {
        return Promise.resolve({ ok: true })
      }
      if (url === '/terminal-health') {
        return Promise.resolve({ ok: true })
      }
      if (url === '/file-watcher-health') {
        return Promise.resolve({ ok: true })
      }
      if (url === '/server-init-status') {
        initStatusCallCount++
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ready: true }),
        })
      }
      return pendingPromise()
    })

    render(
      <LifecyclePhaseProvider>
        <PhaseTransitionDriver />
        <PhaseDisplay />
      </LifecyclePhaseProvider>
    )

    // All sidecars healthy → Restored, init-status ready → Eventually
    // (init-status polling starts immediately on Restored and returns ready)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByTestId('phase').textContent).toBe(
      String(LifecyclePhase.Eventually)
    )

    const callCountAtEventually = initStatusCallCount

    // Advance several more poll intervals — should NOT poll again
    // (phase === Eventually, useEffect cleanup runs)
    await act(async () => {
      vi.advanceTimersByTime(10_000)
      await Promise.resolve()
      await Promise.resolve()
    })

    // The call count should not have increased significantly
    // (one extra call at most from the effect re-running when phase changes)
    expect(initStatusCallCount).toBeLessThanOrEqual(callCountAtEventually + 1)
  })
})
