import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SidecarRuntimeBoundary } from '@/components/sidecar-runtime-boundary'
import { RPC_PORT_DEAD_EVENT } from '@laborer/shared/rpc-transport-messageport-client'

const { getDesktopBridgeMock, isElectronMock, resetTerminalListStoreMock } =
  vi.hoisted(() => ({
    getDesktopBridgeMock: vi.fn(),
    isElectronMock: vi.fn(() => true),
    resetTerminalListStoreMock: vi.fn(),
  }))

vi.mock('@/lib/desktop', () => ({
  getDesktopBridge: getDesktopBridgeMock,
  isElectron: isElectronMock,
}))

vi.mock('@/hooks/use-terminal-list', () => ({
  resetTerminalListStore: resetTerminalListStoreMock,
}))

describe('SidecarRuntimeBoundary', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('bumps generation immediately when a port dies while the server is healthy', async () => {
    const onSidecarStatus = vi.fn(() => () => undefined)
    getDesktopBridgeMock.mockReturnValue({
      getSidecarStatuses: vi.fn(async () => [
        { name: 'server', state: 'healthy' },
      ]),
      onSidecarStatus,
    })

    render(
      <SidecarRuntimeBoundary>
        {(generation) => <div>{generation}</div>}
      </SidecarRuntimeBoundary>
    )

    await waitFor(() => expect(onSidecarStatus).toHaveBeenCalled())
    await act(async () => {
      await Promise.resolve()
    })

    act(() => {
      window.dispatchEvent(new Event(RPC_PORT_DEAD_EVENT))
    })

    await waitFor(() => expect(screen.getByText('1')).toBeTruthy())
    expect(resetTerminalListStoreMock).toHaveBeenCalledTimes(1)
  })

  it('waits for recovery when the port dies before the server is healthy', async () => {
    let sidecarStatusListener:
      | ((status: { name: 'server'; state: 'starting' | 'healthy' }) => void)
      | null = null

    getDesktopBridgeMock.mockReturnValue({
      getSidecarStatuses: vi.fn(async () => [
        { name: 'server', state: 'starting' },
      ]),
      onSidecarStatus: vi.fn((listener) => {
        sidecarStatusListener = listener
        return () => undefined
      }),
    })

    render(
      <SidecarRuntimeBoundary>
        {(generation) => <div>{generation}</div>}
      </SidecarRuntimeBoundary>
    )

    await act(async () => {
      await Promise.resolve()
    })

    act(() => {
      window.dispatchEvent(new Event(RPC_PORT_DEAD_EVENT))
    })

    expect(screen.getByText('0')).toBeTruthy()

    act(() => {
      sidecarStatusListener?.({ name: 'server', state: 'healthy' })
    })

    await waitFor(() => expect(screen.getByText('1')).toBeTruthy())
    expect(resetTerminalListStoreMock).toHaveBeenCalledTimes(1)
  })
})
