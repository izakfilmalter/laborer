/**
 * Tests for LiveStore sync status indicator.
 *
 * Verifies that:
 * - Sync indicator renders when sync status is active (not connected/syncing)
 * - Sync indicator hidden when sync status is idle/connected
 * - Sync indicator hidden when no sync backend is configured (unknown)
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

  // Tracer bullet: sync indicator is visible when sync is actively syncing
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

    // Sync indicator should be visible when syncing
    const syncIndicator = screen.getByTestId('sync-indicator')
    expect(syncIndicator).toBeTruthy()
  })

  it('sync indicator hidden when sync status is connected/idle', async () => {
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

    // Sync indicator should not be visible when connected and idle
    expect(screen.queryByTestId('sync-indicator')).toBeNull()
  })

  it('sync indicator hidden when no sync status set (unknown/default)', async () => {
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

    // No sync status set -> unknown -> indicator should not be visible
    expect(screen.queryByTestId('sync-indicator')).toBeNull()
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
    // Should have fixed width class to prevent layout shifts
    expect(syncIndicator.className).toContain('w-4')
  })
})
