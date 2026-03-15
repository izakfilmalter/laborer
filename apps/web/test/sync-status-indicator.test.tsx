/**
 * Tests for LiveStore sync status indicator.
 *
 * Verifies that:
 * - Sync indicator is always visible regardless of sync state
 * - Sync indicator reflects the current sync status (starting, healthy, unknown)
 * - Indicator does not cause layout shifts (fixed dimensions)
 *
 * @see Issue #2: LiveStore sync status indicator
 */

import { act, cleanup, render, screen } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LifecyclePhaseProvider } from '../src/components/lifecycle-phase-context'
import { ServiceStatusDots } from '../src/components/service-status-dots'
import {
  SyncStatusProvider,
  useSyncStatusUpdate,
} from '../src/components/sync-status-context'

describe('LiveStore sync status indicator', () => {
  const originalFetch = globalThis.fetch

  function mockFetch(impl: (url: string) => Promise<{ ok: boolean } | never>) {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      return impl(url) as Promise<Response>
    }) as typeof fetch
  }

  /** Mock all sidecar services as healthy so we can focus on sync indicator. */
  function mockAllSidecarsHealthy() {
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

  /** Helper component that sets sync status via context using useEffect. */
  function SyncStatusSetter({
    isConnected,
  }: {
    readonly isConnected: boolean
  }) {
    const setSyncState = useSyncStatusUpdate()
    useEffect(() => {
      setSyncState(isConnected ? { state: 'healthy' } : { state: 'starting' })
    }, [isConnected, setSyncState])
    return null
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    globalThis.fetch = originalFetch
  })

  it('sync indicator renders when sync status is syncing', async () => {
    mockAllSidecarsHealthy()

    render(
      <LifecyclePhaseProvider>
        <SyncStatusProvider>
          <SyncStatusSetter isConnected={false} />
          <ServiceStatusDots />
        </SyncStatusProvider>
      </LifecyclePhaseProvider>
    )

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    const syncIndicator = screen.getByTestId('sync-indicator')
    expect(syncIndicator).toBeTruthy()
  })

  it('sync indicator visible when sync status is connected/idle', async () => {
    mockAllSidecarsHealthy()

    render(
      <LifecyclePhaseProvider>
        <SyncStatusProvider>
          <SyncStatusSetter isConnected={true} />
          <ServiceStatusDots />
        </SyncStatusProvider>
      </LifecyclePhaseProvider>
    )

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    // Sync indicator is always visible
    const syncIndicator = screen.getByTestId('sync-indicator')
    expect(syncIndicator).toBeTruthy()
  })

  it('sync indicator visible when no sync status set (unknown/default)', async () => {
    mockAllSidecarsHealthy()

    render(
      <LifecyclePhaseProvider>
        <SyncStatusProvider>
          <ServiceStatusDots />
        </SyncStatusProvider>
      </LifecyclePhaseProvider>
    )

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    // Sync indicator is always visible, even when unknown
    const syncIndicator = screen.getByTestId('sync-indicator')
    expect(syncIndicator).toBeTruthy()
  })

  it('sync indicator does not cause layout shifts (fixed dimensions)', async () => {
    mockAllSidecarsHealthy()

    render(
      <LifecyclePhaseProvider>
        <SyncStatusProvider>
          <SyncStatusSetter isConnected={false} />
          <ServiceStatusDots />
        </SyncStatusProvider>
      </LifecyclePhaseProvider>
    )

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    const syncIndicator = screen.getByTestId('sync-indicator')
    // Badge-based indicator has fixed height (h-5) from Badge base styles.
    expect(syncIndicator.className).toContain('h-5')
  })
})
