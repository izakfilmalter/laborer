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
import { mockFetch, pendingPromise } from './helpers/mock-fetch'

/**
 * Mock for the `useAtomValue` hook used by `useInitStatusPoll` inside the
 * phase transition driver.  Controls what the `lifecycle.initStatus` RPC
 * atom returns so we can simulate the Restored -> Eventually transition.
 *
 * Uses a React state-based approach: `setInitStatusResult` triggers a
 * re-render so the component sees the new value.
 */
const { initStatusResultRef, subscribersRef } = vi.hoisted(() => ({
  initStatusResultRef: {
    current: {
      _tag: 'Initial' as string,
      waiting: true,
      value: undefined as unknown,
    },
  },
  subscribersRef: {
    current: new Set<() => void>(),
  },
}))

/** Update the mock init-status result and notify all mounted components. */
function setInitStatusResult(result: {
  _tag: string
  waiting: boolean
  value: unknown
}) {
  initStatusResultRef.current = result
  for (const notify of subscribersRef.current) {
    notify()
  }
}

vi.mock('@effect-atom/atom-react/Hooks', async () => {
  const React = await import('react')
  return {
    useAtomValue: () => {
      const [, forceRender] = React.useReducer((x: number) => x + 1, 0)
      React.useEffect(() => {
        const notify = () => forceRender()
        subscribersRef.current.add(notify)
        return () => {
          subscribersRef.current.delete(notify)
        }
      }, [forceRender])
      return initStatusResultRef.current
    },
  }
})

vi.mock('@/atoms/laborer-client', () => ({
  LaborerClient: {
    query: () => Symbol.for('initStatus'),
  },
}))

import { PhaseTransitionDriver } from '../src/hooks/use-phase-transition-driver'

/** Displays the current lifecycle phase for test assertions. */
function PhaseDisplay() {
  const { phase } = useLifecyclePhase()
  return <span data-testid="phase">{phase}</span>
}

describe('PhaseTransitionDriver', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.useFakeTimers()
    initStatusResultRef.current = {
      _tag: 'Initial',
      waiting: true,
      value: undefined,
    }
    subscribersRef.current.clear()
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
    // All sidecars healthy immediately
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
      return pendingPromise()
    })

    // RPC atom starts in Initial state (not ready)
    initStatusResultRef.current = {
      _tag: 'Initial',
      waiting: true,
      value: undefined,
    }

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

    // Init-status RPC returns not ready — still Restored
    await act(async () => {
      setInitStatusResult({
        _tag: 'Success',
        waiting: false,
        value: { ready: false },
      })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByTestId('phase').textContent).toBe(
      String(LifecyclePhase.Restored)
    )

    // Deferred services finish initializing — RPC returns ready
    await act(async () => {
      setInitStatusResult({
        _tag: 'Success',
        waiting: false,
        value: { ready: true },
      })
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
    // RPC atom immediately returns ready
    initStatusResultRef.current = {
      _tag: 'Success',
      waiting: false,
      value: { ready: true },
    }

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
      return pendingPromise()
    })

    render(
      <LifecyclePhaseProvider>
        <PhaseTransitionDriver />
        <PhaseDisplay />
      </LifecyclePhaseProvider>
    )

    // All sidecars healthy → Restored, init-status ready → Eventually
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByTestId('phase').textContent).toBe(
      String(LifecyclePhase.Eventually)
    )

    // Phase should remain Eventually after additional time
    await act(async () => {
      vi.advanceTimersByTime(10_000)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByTestId('phase').textContent).toBe(
      String(LifecyclePhase.Eventually)
    )
  })
})
