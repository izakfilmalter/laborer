/**
 * Tests for ServiceStatusDots — compact per-service status indicators
 * in the header.
 *
 * Verifies that:
 * - Each core service (Server, Terminal, File Watcher) shows a status dot
 * - Each dot reflects the correct state (starting/healthy/crashed/unknown)
 * - Dots consume useServiceStatus() reactively
 * - Pulsing animation for starting state
 *
 * @see Issue #8: Header per-service status dots
 */

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LifecyclePhaseProvider } from '../src/components/lifecycle-phase-context'
import { ServiceStatusDots } from '../src/components/service-status-dots'
import { mockFetch, pendingPromise } from './helpers/mock-fetch'

describe('ServiceStatusDots', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    globalThis.fetch = originalFetch
  })

  // Tracer bullet: each service shows the correct state based on useServiceStatus()
  it('shows starting state for server dot when server is starting', async () => {
    // All fetches fail — services are starting (dev mode polling emits 'starting' on mount)
    mockFetch(() => Promise.reject(new Error('not ready')))

    render(
      <LifecyclePhaseProvider>
        <ServiceStatusDots />
      </LifecyclePhaseProvider>
    )

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    const serverDot = screen.getByTestId('service-dot-server')
    expect(serverDot.dataset.state).toBe('starting')
  })

  it('shows healthy state for server dot when server health check passes', async () => {
    mockFetch((url) => {
      if (url === '/server-health') {
        return Promise.resolve({ ok: true })
      }
      return Promise.reject(new Error('not ready'))
    })

    render(
      <LifecyclePhaseProvider>
        <ServiceStatusDots />
      </LifecyclePhaseProvider>
    )

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    const serverDot = screen.getByTestId('service-dot-server')
    expect(serverDot.dataset.state).toBe('healthy')
  })

  it('shows error state for server dot when server crashes', async () => {
    // First poll: server healthy, then crash
    let serverCrashed = false

    mockFetch((url) => {
      if (url === '/server-health' && !serverCrashed) {
        return Promise.resolve({ ok: true })
      }
      if (url === '/server-health' && serverCrashed) {
        return Promise.resolve({ ok: false })
      }
      return Promise.reject(new Error('not ready'))
    })

    render(
      <LifecyclePhaseProvider>
        <ServiceStatusDots />
      </LifecyclePhaseProvider>
    )

    // Initial poll — server healthy
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByTestId('service-dot-server').dataset.state).toBe(
      'healthy'
    )

    // Server crashes
    serverCrashed = true

    await act(async () => {
      vi.advanceTimersByTime(3000)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByTestId('service-dot-server').dataset.state).toBe(
      'crashed'
    )
  })

  it('renders all three core services independently', async () => {
    // Server healthy, terminal starting, file-watcher starting
    mockFetch((url) => {
      if (url === '/server-health') {
        return Promise.resolve({ ok: true })
      }
      if (url === '/terminal-health') {
        return Promise.resolve({ ok: true })
      }
      // File-watcher not ready
      return Promise.reject(new Error('not ready'))
    })

    render(
      <LifecyclePhaseProvider>
        <ServiceStatusDots />
      </LifecyclePhaseProvider>
    )

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    const serverDot = screen.getByTestId('service-dot-server')
    const terminalDot = screen.getByTestId('service-dot-terminal')
    const fileWatcherDot = screen.getByTestId('service-dot-file-watcher')

    expect(serverDot.dataset.state).toBe('healthy')
    expect(terminalDot.dataset.state).toBe('healthy')
    // File-watcher poll fails → stays 'starting' (dev mode emits starting on mount)
    expect(fileWatcherDot.dataset.state).toBe('starting')
  })

  it('summarizes every service in one non-interactive line', async () => {
    mockFetch((url) => {
      if (
        url === '/server-health' ||
        url === '/terminal-health' ||
        url === '/file-watcher-health'
      ) {
        return Promise.resolve({ ok: true })
      }
      return Promise.reject(new Error('not ready'))
    })

    render(
      <LifecyclePhaseProvider>
        <ServiceStatusDots />
      </LifecyclePhaseProvider>
    )

    await act(async () => {
      vi.advanceTimersByTime(600)
      await Promise.resolve()
      await Promise.resolve()
    })

    const summary = screen.getByTestId('service-status-summary')
    expect(summary.textContent).toContain('All services running')
    // A readout, not a control: no button role and nothing to expand.
    expect(summary.tagName.toLowerCase()).toBe('span')
    expect(summary.getAttribute('aria-expanded')).toBeNull()
    // The hover card only repeats what the always-present list already says,
    // so it stays out of the accessibility tree.
    expect(summary.getAttribute('aria-hidden')).toBe('true')
    expect(screen.getByTestId('service-dot-sync').textContent).toContain(
      'Connection'
    )
  })

  it('gives an unacknowledged crash its own actionable row', async () => {
    let serverOk = true
    mockFetch((url) => {
      if (url === '/server-health') {
        return Promise.resolve({ ok: serverOk })
      }
      if (url === '/terminal-health' || url === '/file-watcher-health') {
        return Promise.resolve({ ok: true })
      }
      return Promise.reject(new Error('not ready'))
    })

    render(
      <LifecyclePhaseProvider>
        <ServiceStatusDots />
      </LifecyclePhaseProvider>
    )

    await act(async () => {
      vi.advanceTimersByTime(600)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.queryByTestId('service-error-server')).toBeNull()

    serverOk = false
    await act(async () => {
      vi.advanceTimersByTime(3000)
      await Promise.resolve()
      await Promise.resolve()
    })

    // The row is visible without hovering anything, and so are its actions.
    expect(screen.getByTestId('service-error-server')).toBeTruthy()
    expect(screen.getByTestId('retry-error-server')).toBeTruthy()

    await act(async () => {
      screen.getByTestId('dismiss-error-server').click()
      await Promise.resolve()
    })

    expect(screen.queryByTestId('service-error-server')).toBeNull()
  })

  it('names the single affected service in the summary', async () => {
    mockFetch((url) => {
      if (url === '/server-health' || url === '/terminal-health') {
        return Promise.resolve({ ok: true })
      }
      return Promise.reject(new Error('not ready'))
    })

    render(
      <LifecyclePhaseProvider>
        <ServiceStatusDots />
      </LifecyclePhaseProvider>
    )

    await act(async () => {
      vi.advanceTimersByTime(600)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByTestId('service-status-summary').textContent).toContain(
      'File Watcher starting'
    )
  })

  it('renders within an output element with accessible label', () => {
    mockFetch(() => pendingPromise())

    render(
      <LifecyclePhaseProvider>
        <ServiceStatusDots />
      </LifecyclePhaseProvider>
    )

    const output = screen.getByRole('status')
    expect(output.tagName.toLowerCase()).toBe('output')
    expect(output.getAttribute('aria-label')).toBe('Service statuses')
  })
})
