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
    connection.set({
      attempt: 1,
      phase: 'connected',
      retryAt: null,
      session: 1,
    })
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

  it('escalates once the retry ladder is exhausted', () => {
    render(
      <AtomRegistryProvider>
        <ConnectionReconnectBanner />
      </AtomRegistryProvider>
    )

    act(() => connection.set({ attempt: 1, phase: 'backoff', session: null }))
    act(() => vi.advanceTimersByTime(2000))
    expect(screen.getByText('Connection lost')).toBeTruthy()

    act(() => connection.set({ attempt: 5 }))
    expect(screen.getByText('Can’t reach the daemon')).toBeTruthy()
  })

  it('counts down to the next automatic attempt', () => {
    vi.setSystemTime(0)
    render(
      <AtomRegistryProvider>
        <ConnectionReconnectBanner />
      </AtomRegistryProvider>
    )

    act(() =>
      connection.set({
        attempt: 1,
        phase: 'backoff',
        retryAt: 8000,
        session: null,
      })
    )
    act(() => vi.advanceTimersByTime(2000))
    expect(screen.getByText('Retrying in 6s')).toBeTruthy()

    act(() => vi.advanceTimersByTime(2000))
    expect(screen.getByText('Retrying in 4s')).toBeTruthy()
  })

  it('announces the outage and its recovery to assistive technology', () => {
    render(
      <AtomRegistryProvider>
        <ConnectionReconnectBanner />
      </AtomRegistryProvider>
    )

    const liveRegion = screen.getByRole('status')
    expect(liveRegion.textContent).toBe('')

    act(() =>
      connection.set({
        attempt: 1,
        phase: 'backoff',
        retryAt: null,
        session: null,
      })
    )
    act(() => vi.advanceTimersByTime(2000))
    expect(liveRegion.textContent).toContain('Retrying automatically')

    act(() => connection.set({ phase: 'connected', session: 2 }))
    expect(screen.getByTestId('reconnect-restored')).toBeTruthy()
    expect(liveRegion.textContent).toBe('Reconnected to the daemon.')

    act(() => vi.advanceTimersByTime(2400))
    expect(screen.queryByTestId('reconnect-restored')).toBeNull()
    expect(liveRegion.textContent).toBe('')
  })
})
