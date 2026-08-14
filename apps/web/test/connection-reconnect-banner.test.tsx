import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AtomRegistryProvider } from '../src/atoms/provider'

const connection = vi.hoisted(() => {
  let snapshot = {
    attempt: 1,
    generation: 1,
    phase: 'connected' as 'connected' | 'connecting' | 'backoff',
    retryAt: null as number | null,
    session: 1 as number | null,
  }
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    retryNow: vi.fn(),
    set: (next: Partial<typeof snapshot>) => {
      snapshot = { ...snapshot, ...next }
      for (const listener of listeners) {
        listener()
      }
    },
    start: vi.fn(),
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
})

vi.mock('../src/atoms/renderer-connection', async (importOriginal) => ({
  ...(await importOriginal()),
  rendererConnectionSupervisor: connection,
}))

import { ConnectionReconnectBanner } from '../src/components/connection-reconnect-banner'

describe('ConnectionReconnectBanner', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    connection.set({ phase: 'connected', session: 1 })
    connection.retryNow.mockClear()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('waits two seconds, remains non-blocking, and clears on reconnect', () => {
    render(
      <AtomRegistryProvider>
        <main>Stale readable data</main>
        <ConnectionReconnectBanner />
      </AtomRegistryProvider>
    )

    act(() => connection.set({ phase: 'backoff', session: null }))
    act(() => vi.advanceTimersByTime(1999))
    expect(screen.queryByTestId('reconnect-banner')).toBeNull()
    expect(screen.getByText('Stale readable data')).toBeTruthy()

    act(() => vi.advanceTimersByTime(1))
    expect(screen.getByTestId('reconnect-banner')).toBeTruthy()
    act(() => connection.set({ phase: 'connected', session: 2 }))
    expect(screen.queryByTestId('reconnect-banner')).toBeNull()
  })

  it('offers an explicit reconnect without retrying a user action', () => {
    render(
      <AtomRegistryProvider>
        <ConnectionReconnectBanner />
      </AtomRegistryProvider>
    )
    act(() => connection.set({ phase: 'backoff', session: null }))
    act(() => vi.advanceTimersByTime(2000))
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    expect(connection.retryNow).toHaveBeenCalledOnce()
  })
})
