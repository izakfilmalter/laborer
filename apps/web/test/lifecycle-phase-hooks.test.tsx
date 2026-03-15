/**
 * Tests for useWhenPhase and useServiceStatus hooks.
 *
 * Verifies that:
 * - `useWhenPhase(phase)` returns the correct boolean based on current phase
 * - `useServiceStatus()` aggregates sidecar status data reactively
 *
 * @see Issue #5: useWhenPhase hook and service status hook
 */

import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LifecyclePhase,
  LifecyclePhaseProvider,
  useLifecyclePhase,
} from '../src/components/lifecycle-phase-context'
import { useServiceStatus } from '../src/hooks/use-service-status'
import { useWhenPhase } from '../src/hooks/use-when-phase'
import { mockFetch, pendingPromise } from './helpers/mock-fetch'

/**
 * Test component that displays useWhenPhase results for each phase
 * and provides phase advancement controls.
 */
function WhenPhaseDisplay() {
  const { advanceTo } = useLifecyclePhase()
  const isStarting = useWhenPhase(LifecyclePhase.Starting)
  const isReady = useWhenPhase(LifecyclePhase.Ready)
  const isRestored = useWhenPhase(LifecyclePhase.Restored)
  const isEventually = useWhenPhase(LifecyclePhase.Eventually)

  return (
    <div>
      <span data-testid="when-starting">{String(isStarting)}</span>
      <span data-testid="when-ready">{String(isReady)}</span>
      <span data-testid="when-restored">{String(isRestored)}</span>
      <span data-testid="when-eventually">{String(isEventually)}</span>
      <button onClick={() => advanceTo(LifecyclePhase.Ready)} type="button">
        Advance to Ready
      </button>
      <button onClick={() => advanceTo(LifecyclePhase.Restored)} type="button">
        Advance to Restored
      </button>
      <button
        onClick={() => advanceTo(LifecyclePhase.Eventually)}
        type="button"
      >
        Advance to Eventually
      </button>
    </div>
  )
}

describe('useWhenPhase', () => {
  afterEach(() => {
    cleanup()
  })

  // Tracer bullet: useWhenPhase(Ready) returns false during Starting, true after Ready
  it('returns false for Ready during Starting phase and true after advancing to Ready', async () => {
    const user = userEvent.setup()

    render(
      <LifecyclePhaseProvider>
        <WhenPhaseDisplay />
      </LifecyclePhaseProvider>
    )

    // During Starting phase, Ready should be false
    expect(screen.getByTestId('when-ready').textContent).toBe('false')

    // Advance to Ready
    await user.click(screen.getByText('Advance to Ready'))

    // Now Ready should be true
    expect(screen.getByTestId('when-ready').textContent).toBe('true')
  })

  it('returns true immediately for Starting (always past)', () => {
    render(
      <LifecyclePhaseProvider>
        <WhenPhaseDisplay />
      </LifecyclePhaseProvider>
    )

    // Starting is always reached — should be true from the start
    expect(screen.getByTestId('when-starting').textContent).toBe('true')
  })

  it('returns false for Eventually until Eventually phase is reached', async () => {
    const user = userEvent.setup()

    render(
      <LifecyclePhaseProvider>
        <WhenPhaseDisplay />
      </LifecyclePhaseProvider>
    )

    // Eventually should be false during Starting
    expect(screen.getByTestId('when-eventually').textContent).toBe('false')

    // Advance to Ready — Eventually still false
    await user.click(screen.getByText('Advance to Ready'))
    expect(screen.getByTestId('when-eventually').textContent).toBe('false')

    // Advance to Restored — Eventually still false
    await user.click(screen.getByText('Advance to Restored'))
    expect(screen.getByTestId('when-eventually').textContent).toBe('false')

    // Advance to Eventually — now true
    await user.click(screen.getByText('Advance to Eventually'))
    expect(screen.getByTestId('when-eventually').textContent).toBe('true')
  })
})

/**
 * Test component that displays useServiceStatus values.
 * Mocks fetch at the system boundary to control sidecar health responses.
 */
function ServiceStatusDisplay() {
  const statuses = useServiceStatus()

  return (
    <div>
      <span data-testid="server-state">{statuses.server.state}</span>
      <span data-testid="terminal-state">{statuses.terminal.state}</span>
      <span data-testid="file-watcher-state">
        {statuses['file-watcher'].state}
      </span>
      <span data-testid="sync-state">{statuses.sync.state}</span>
    </div>
  )
}

describe('useServiceStatus', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    globalThis.fetch = originalFetch
  })

  // Tracer bullet: useServiceStatus shows starting state for services
  // when health endpoints haven't responded yet
  it('shows starting state for sidecar services initially', async () => {
    // Fetch never resolves — services are in starting state
    mockFetch(() => pendingPromise())

    render(<ServiceStatusDisplay />)

    // useSidecarStatuses emits 'starting' for pollable services immediately
    // in dev mode, then polls. Since fetch never resolves, they stay starting.
    await act(async () => {
      await Promise.resolve()
    })

    expect(screen.getByTestId('server-state').textContent).toBe('starting')
    expect(screen.getByTestId('terminal-state').textContent).toBe('starting')
    expect(screen.getByTestId('file-watcher-state').textContent).toBe(
      'starting'
    )
  })

  it('includes sync status entry with unknown state initially', async () => {
    mockFetch(() => pendingPromise())

    render(<ServiceStatusDisplay />)

    await act(async () => {
      await Promise.resolve()
    })

    // Sync status is unknown until LiveStore is wired (Issue #2)
    expect(screen.getByTestId('sync-state').textContent).toBe('unknown')
  })

  it('updates sidecar status to healthy when health endpoint responds', async () => {
    // Server healthy, others never respond
    mockFetch((url) => {
      if (url === '/server-health') {
        return Promise.resolve({ ok: true })
      }
      return pendingPromise()
    })

    render(<ServiceStatusDisplay />)

    // Let initial poll complete
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByTestId('server-state').textContent).toBe('healthy')
    expect(screen.getByTestId('terminal-state').textContent).toBe('starting')
  })

  it('updates reactively when service status changes', async () => {
    let serverHealthy = false

    mockFetch((url) => {
      if (url === '/server-health' && serverHealthy) {
        return Promise.resolve({ ok: true })
      }
      if (url === '/server-health') {
        return Promise.reject(new Error('not ready'))
      }
      return pendingPromise()
    })

    render(<ServiceStatusDisplay />)

    // Initial poll — server not healthy
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByTestId('server-state').textContent).toBe('starting')

    // Server becomes healthy
    serverHealthy = true

    // Advance timer to trigger next poll (3 second interval)
    await act(async () => {
      vi.advanceTimersByTime(3000)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByTestId('server-state').textContent).toBe('healthy')
  })
})
