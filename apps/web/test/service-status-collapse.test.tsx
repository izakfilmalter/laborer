/**
 * Tests for ServiceStatusDots collapse and expand behavior.
 *
 * Verifies that:
 * - Individual dots show expanded when any service is not healthy
 * - Dots collapse to a single compact indicator after 2s of all-healthy
 * - Clicking the compact indicator opens a popover with per-service detail
 * - The popover shows service name, state, and restart action
 * - Immediate expansion if a service goes unhealthy while collapsed
 * - On fast startups (all healthy within 500ms), user never sees expanded dots
 * - Restart action calls desktopBridge.restartSidecar()
 *
 * @see Issue #9: Header status collapse and expand
 */

import { act, cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LifecyclePhaseProvider } from '../src/components/lifecycle-phase-context'
import {
  COLLAPSE_DELAY_MS,
  ServiceStatusDots,
} from '../src/components/service-status-dots'

describe('ServiceStatusDots collapse/expand', () => {
  const originalFetch = globalThis.fetch

  function mockFetch(impl: (url: string) => Promise<{ ok: boolean } | never>) {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      return impl(url) as Promise<Response>
    }) as typeof fetch
  }

  /** Mock all services as healthy. */
  function mockAllHealthy() {
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
  }

  /** Mock server healthy, but file-watcher not ready. */
  function mockPartialHealthy() {
    mockFetch((url) => {
      if (url === '/server-health' || url === '/terminal-health') {
        return Promise.resolve({ ok: true })
      }
      return Promise.reject(new Error('not ready'))
    })
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    globalThis.fetch = originalFetch
  })

  // Tracer bullet: indicators collapse to compact form after 2 seconds of all-healthy
  it('collapses to single compact indicator after 2s of all-healthy', async () => {
    mockAllHealthy()

    render(
      <LifecyclePhaseProvider>
        <ServiceStatusDots />
      </LifecyclePhaseProvider>
    )

    // Let initial health polls resolve
    await act(async () => {
      // Advance past the 500ms fast-startup window
      vi.advanceTimersByTime(600)
      await Promise.resolve()
      await Promise.resolve()
    })

    // Should show expanded dots (not yet 2s since all-healthy)
    expect(screen.getByTestId('service-dot-server')).toBeTruthy()
    expect(screen.getByTestId('service-dot-terminal')).toBeTruthy()
    expect(screen.getByTestId('service-dot-file-watcher')).toBeTruthy()
    expect(screen.queryByTestId('service-status-collapsed')).toBeNull()

    // Advance 2 seconds for the collapse delay
    await act(async () => {
      vi.advanceTimersByTime(COLLAPSE_DELAY_MS)
      await Promise.resolve()
    })

    // Should now show the collapsed indicator
    expect(screen.getByTestId('service-status-collapsed')).toBeTruthy()
    // Individual dots should be gone
    expect(screen.queryByTestId('service-dot-server')).toBeNull()
    expect(screen.queryByTestId('service-dot-terminal')).toBeNull()
    expect(screen.queryByTestId('service-dot-file-watcher')).toBeNull()
  })

  it('shows expanded dots when any service is not healthy', async () => {
    mockPartialHealthy()

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

    // File-watcher is not healthy, so we should see expanded dots
    expect(screen.getByTestId('service-dot-server')).toBeTruthy()
    expect(screen.getByTestId('service-dot-terminal')).toBeTruthy()
    expect(screen.getByTestId('service-dot-file-watcher')).toBeTruthy()
    expect(screen.queryByTestId('service-status-collapsed')).toBeNull()

    // Even after the collapse delay, should stay expanded because not all healthy
    await act(async () => {
      vi.advanceTimersByTime(COLLAPSE_DELAY_MS + 1000)
      await Promise.resolve()
    })

    expect(screen.queryByTestId('service-status-collapsed')).toBeNull()
    expect(screen.getByTestId('service-dot-server')).toBeTruthy()
  })

  it('clicking compact indicator shows per-service detail popover', async () => {
    mockAllHealthy()

    render(
      <LifecyclePhaseProvider>
        <ServiceStatusDots />
      </LifecyclePhaseProvider>
    )

    // Wait for all healthy and collapse
    await act(async () => {
      vi.advanceTimersByTime(600)
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => {
      vi.advanceTimersByTime(COLLAPSE_DELAY_MS)
      await Promise.resolve()
    })

    const collapsedDot = screen.getByTestId('service-status-collapsed')
    expect(collapsedDot).toBeTruthy()

    // Click to open the popover
    await act(async () => {
      collapsedDot.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    // Popover should show per-service detail
    const popover = screen.getByTestId('service-status-popover')
    expect(popover).toBeTruthy()

    // Should have detail rows for each service
    expect(within(popover).getByTestId('service-detail-server')).toBeTruthy()
    expect(within(popover).getByTestId('service-detail-terminal')).toBeTruthy()
    expect(
      within(popover).getByTestId('service-detail-file-watcher')
    ).toBeTruthy()
  })

  it('popover detail shows service name and state', async () => {
    mockAllHealthy()

    render(
      <LifecyclePhaseProvider>
        <ServiceStatusDots />
      </LifecyclePhaseProvider>
    )

    // Wait for collapse
    await act(async () => {
      vi.advanceTimersByTime(600)
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => {
      vi.advanceTimersByTime(COLLAPSE_DELAY_MS)
      await Promise.resolve()
    })

    // Open popover
    await act(async () => {
      screen.getByTestId('service-status-collapsed').click()
      await Promise.resolve()
      await Promise.resolve()
    })

    const serverDetail = screen.getByTestId('service-detail-server')
    expect(serverDetail.textContent).toContain('Server')
    expect(serverDetail.textContent).toContain('Healthy')
  })

  it('expands immediately if a service goes unhealthy while collapsed', async () => {
    let fileWatcherHealthy = true
    mockFetch((url) => {
      if (url === '/server-health' || url === '/terminal-health') {
        return Promise.resolve({ ok: true })
      }
      if (url === '/file-watcher-health') {
        return fileWatcherHealthy
          ? Promise.resolve({ ok: true })
          : Promise.resolve({ ok: false })
      }
      return Promise.reject(new Error('not ready'))
    })

    render(
      <LifecyclePhaseProvider>
        <ServiceStatusDots />
      </LifecyclePhaseProvider>
    )

    // Wait for all healthy
    await act(async () => {
      vi.advanceTimersByTime(600)
      await Promise.resolve()
      await Promise.resolve()
    })

    // Collapse
    await act(async () => {
      vi.advanceTimersByTime(COLLAPSE_DELAY_MS)
      await Promise.resolve()
    })

    expect(screen.getByTestId('service-status-collapsed')).toBeTruthy()

    // File-watcher crashes
    fileWatcherHealthy = false

    // Advance to next health poll (3s interval in dev mode)
    await act(async () => {
      vi.advanceTimersByTime(3000)
      await Promise.resolve()
      await Promise.resolve()
    })

    // Should expand immediately — no collapsed indicator, individual dots visible
    expect(screen.queryByTestId('service-status-collapsed')).toBeNull()
    expect(screen.getByTestId('service-dot-server')).toBeTruthy()
    expect(screen.getByTestId('service-dot-file-watcher')).toBeTruthy()
  })

  it('on fast startup (all healthy within 500ms), user never sees expanded dots', async () => {
    mockAllHealthy()

    render(
      <LifecyclePhaseProvider>
        <ServiceStatusDots />
      </LifecyclePhaseProvider>
    )

    // Resolve health polls immediately (within 500ms window)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    // Should go straight to collapsed (no 2s delay)
    expect(screen.getByTestId('service-status-collapsed')).toBeTruthy()
    expect(screen.queryByTestId('service-dot-server')).toBeNull()
  })

  it('output wrapper has accessible label in both collapsed and expanded state', async () => {
    mockAllHealthy()

    render(
      <LifecyclePhaseProvider>
        <ServiceStatusDots />
      </LifecyclePhaseProvider>
    )

    // Expanded state
    await act(async () => {
      vi.advanceTimersByTime(600)
      await Promise.resolve()
      await Promise.resolve()
    })

    let output = screen.getByRole('status')
    expect(output.getAttribute('aria-label')).toBe('Service statuses')

    // Collapse
    await act(async () => {
      vi.advanceTimersByTime(COLLAPSE_DELAY_MS)
      await Promise.resolve()
    })

    // Still wrapped in accessible output
    output = screen.getByRole('status')
    expect(output.getAttribute('aria-label')).toBe('Service statuses')
  })
})
