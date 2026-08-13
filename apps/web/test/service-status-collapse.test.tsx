/**
 * Tests for ServiceStatusDots badge rendering.
 *
 * Verifies that:
 * - Individual badges are always visible for each core service
 * - Badges show correctly when services are healthy
 * - Badges show correctly when services are not healthy
 * - Output wrapper has accessible label
 *
 * @see Issue #8: Header per-service status dots
 */

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LifecyclePhaseProvider } from '../src/components/lifecycle-phase-context'
import { ServiceStatusDots } from '../src/components/service-status-dots'
import { mockFetch } from './helpers/mock-fetch'

describe('ServiceStatusDots badges', () => {
  const originalFetch = globalThis.fetch

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

  it('shows all service badges when all services are healthy', async () => {
    mockAllHealthy()

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

    expect(screen.getByTestId('service-dot-server')).toBeTruthy()
    expect(screen.getByTestId('service-dot-terminal')).toBeTruthy()
    expect(screen.getByTestId('service-dot-file-watcher')).toBeTruthy()
  })

  it('badges remain visible even after extended healthy period', async () => {
    mockAllHealthy()

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

    // Advance well past old collapse delay — badges should still be visible
    await act(async () => {
      vi.advanceTimersByTime(10_000)
      await Promise.resolve()
    })

    expect(screen.getByTestId('service-dot-server')).toBeTruthy()
    expect(screen.getByTestId('service-dot-terminal')).toBeTruthy()
    expect(screen.getByTestId('service-dot-file-watcher')).toBeTruthy()
  })

  it('shows all badges when any service is not healthy', async () => {
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

    expect(screen.getByTestId('service-dot-server')).toBeTruthy()
    expect(screen.getByTestId('service-dot-terminal')).toBeTruthy()
    expect(screen.getByTestId('service-dot-file-watcher')).toBeTruthy()
  })

  it('output wrapper has accessible label', async () => {
    mockAllHealthy()

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

    const output = screen.getByRole('status')
    expect(output.getAttribute('aria-label')).toBe('Service statuses')
  })
})
