import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  recordWsConnectionAttempt,
  recordWsConnectionClosed,
  recordWsConnectionErrored,
  recordWsConnectionOpened,
  resetWsConnectionStateForTests,
  setBrowserOnlineStatus,
} from '../src/atoms/ws-connection-state'
import { LifecyclePhaseProvider } from '../src/components/lifecycle-phase-context'
import { ServiceStatusDots } from '../src/components/service-status-dots'
import { mockFetch } from './helpers/mock-fetch'

describe('server connection status indicator', () => {
  const originalFetch = globalThis.fetch
  let serverHealthy = true

  function mockSidecarHealth() {
    mockFetch((url) => {
      if (url === '/server-health') {
        return serverHealthy
          ? Promise.resolve({ ok: true })
          : Promise.reject(new Error('server down'))
      }
      if (url === '/terminal-health' || url === '/file-watcher-health') {
        return Promise.resolve({ ok: true })
      }
      return Promise.reject(new Error('not ready'))
    })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    serverHealthy = true
    resetWsConnectionStateForTests()
    mockSidecarHealth()
  })

  afterEach(() => {
    cleanup()
    resetWsConnectionStateForTests()
    vi.useRealTimers()
    globalThis.fetch = originalFetch
  })

  function renderIndicator() {
    render(
      <LifecyclePhaseProvider>
        <ServiceStatusDots />
      </LifecyclePhaseProvider>
    )
  }

  async function flushHealthCheck() {
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  it('reports healthy only when server health and RPC are connected', async () => {
    renderIndicator()
    await flushHealthCheck()

    act(() => {
      recordWsConnectionAttempt('ws://localhost/rpc')
      recordWsConnectionOpened()
    })

    expect(screen.getByTestId('sync-indicator').dataset.state).toBe('healthy')
  })

  it('reports reconnecting when an established RPC connection closes', async () => {
    recordWsConnectionAttempt('ws://localhost/rpc')
    recordWsConnectionOpened()
    renderIndicator()
    await flushHealthCheck()

    act(() => {
      recordWsConnectionClosed({ code: 1006 })
    })

    expect(screen.getByTestId('sync-indicator').dataset.state).toBe(
      'reconnecting'
    )
  })

  it('reports down while offline and recovers after a sidecar restart', async () => {
    recordWsConnectionAttempt('ws://localhost/rpc')
    recordWsConnectionOpened()
    renderIndicator()
    await flushHealthCheck()

    act(() => {
      setBrowserOnlineStatus(false)
      recordWsConnectionClosed({ code: 1006, reason: 'server restarted' })
    })
    expect(screen.getByTestId('sync-indicator').dataset.state).toBe('down')

    act(() => {
      setBrowserOnlineStatus(true)
      recordWsConnectionAttempt('ws://localhost/rpc')
    })
    expect(screen.getByTestId('sync-indicator').dataset.state).toBe(
      'reconnecting'
    )

    act(() => {
      recordWsConnectionOpened()
    })
    expect(screen.getByTestId('sync-indicator').dataset.state).toBe('healthy')
  })

  it('reports down when the initial RPC connection fails', async () => {
    renderIndicator()
    await flushHealthCheck()

    act(() => {
      recordWsConnectionAttempt('ws://localhost/rpc')
      recordWsConnectionErrored('connection refused')
    })

    expect(screen.getByTestId('sync-indicator').dataset.state).toBe('down')
  })

  it('tracks a server sidecar restart through down and reconnecting', async () => {
    recordWsConnectionAttempt('ws://localhost/rpc')
    recordWsConnectionOpened()
    renderIndicator()
    await flushHealthCheck()
    expect(screen.getByTestId('sync-indicator').dataset.state).toBe('healthy')

    serverHealthy = false
    act(() => {
      recordWsConnectionClosed({ code: 1006 })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })

    expect(screen.getByTestId('sync-indicator').dataset.state).toBe('down')

    serverHealthy = true
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(screen.getByTestId('sync-indicator').dataset.state).toBe(
      'reconnecting'
    )

    act(() => {
      recordWsConnectionAttempt('ws://localhost/rpc')
      recordWsConnectionOpened()
    })
    expect(screen.getByTestId('sync-indicator').dataset.state).toBe('healthy')
  })

  it('retains fixed badge dimensions in every connection state', async () => {
    renderIndicator()
    await flushHealthCheck()

    expect(screen.getByTestId('sync-indicator').className).toContain('h-5')
    expect(screen.getByTestId('sync-indicator').textContent).toContain(
      'Connection'
    )
  })
})
