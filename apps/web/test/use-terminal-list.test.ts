import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Mock setup (vi.hoisted runs before vi.mock factory functions)
// ---------------------------------------------------------------------------

const { listTerminalsFn, mutationMap } = vi.hoisted(() => ({
  listTerminalsFn: vi.fn(),
  mutationMap: new Map<unknown, ReturnType<typeof vi.fn>>(),
}))

vi.mock('@effect-atom/atom-react/Hooks', () => ({
  useAtomSet: (atom: unknown) => {
    return mutationMap.get(atom) ?? vi.fn()
  },
}))

vi.mock('@/atoms/terminal-service-client', () => ({
  TerminalServiceClient: {
    mutation: (name: string) => {
      const sentinel = Symbol.for(`mutation:${name}`)
      if (name === 'terminal.list') {
        mutationMap.set(sentinel, listTerminalsFn)
      }
      return sentinel
    },
  },
}))

// Import AFTER mocks are set up
import {
  removeTerminalListItem,
  resetTerminalListStore,
  upsertTerminalListItem,
  useTerminalList,
} from '../src/hooks/use-terminal-list'

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const TERMINAL_A = {
  id: 'term-1',
  workspaceId: 'ws-1',
  command: '/bin/zsh',
  args: [],
  cwd: '/home/user/project',
  agentStatus: null,
  foregroundProcess: null,
  hasChildProcess: false,
  processChain: [],
  status: 'running' as const,
}

const TERMINAL_B = {
  id: 'term-2',
  workspaceId: 'ws-2',
  command: 'npm run dev',
  args: [],
  cwd: '/home/user/other',
  agentStatus: null,
  foregroundProcess: null,
  hasChildProcess: false,
  processChain: [],
  status: 'stopped' as const,
}

// ---------------------------------------------------------------------------
// Tests — initial fetch (real timers, async resolution)
// ---------------------------------------------------------------------------

describe('useTerminalList', () => {
  afterEach(() => {
    cleanup()
    resetTerminalListStore()
    vi.useRealTimers()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    resetTerminalListStore()
  })

  it('starts with loading state and empty terminals', () => {
    listTerminalsFn.mockImplementation(
      () =>
        new Promise(() => {
          // Never resolves — keeps the hook in loading state
        })
    )
    const { result } = renderHook(() => useTerminalList())

    expect(result.current.isLoading).toBe(true)
    expect(result.current.terminals).toEqual([])
    expect(result.current.serviceStatus).toBe('checking')
    expect(result.current.errorMessage).toBeNull()
  })

  it('fetches terminals on mount and updates state', async () => {
    listTerminalsFn.mockResolvedValue([TERMINAL_A, TERMINAL_B])

    const { result } = renderHook(() => useTerminalList())

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.terminals).toEqual([TERMINAL_A, TERMINAL_B])
    expect(result.current.isServiceAvailable).toBe(true)
    expect(result.current.serviceStatus).toBe('available')
    expect(result.current.errorMessage).toBeNull()
    expect(listTerminalsFn).toHaveBeenCalledTimes(1)
  })

  it('returns empty array when no terminals exist', async () => {
    listTerminalsFn.mockResolvedValue([])

    const { result } = renderHook(() => useTerminalList())

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.terminals).toEqual([])
    expect(result.current.isServiceAvailable).toBe(true)
  })

  it('sets service unavailable on RPC error', async () => {
    listTerminalsFn.mockRejectedValue(new Error('Connection refused'))

    const { result } = renderHook(() => useTerminalList())

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.isServiceAvailable).toBe(false)
    expect(result.current.serviceStatus).toBe('unavailable')
    expect(result.current.errorMessage).toBe('Connection refused')
    expect(result.current.terminals).toEqual([])
  })

  it('handles non-Error rejection values', async () => {
    listTerminalsFn.mockRejectedValue('string error')

    const { result } = renderHook(() => useTerminalList())

    await waitFor(() => {
      expect(result.current.serviceStatus).toBe('unavailable')
    })

    expect(result.current.errorMessage).toBe('Unknown terminal service error')
  })

  it('does not update state after unmount', async () => {
    let resolvePromise!: (value: unknown[]) => void
    listTerminalsFn.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePromise = resolve
        })
    )

    const { result, unmount } = renderHook(() => useTerminalList())

    unmount()

    // Resolve after unmount — should not throw or update state
    await act(() => {
      resolvePromise([TERMINAL_A])
    })

    // State remains at initial values since the hook was unmounted
    expect(result.current.isLoading).toBe(true)
    expect(result.current.terminals).toEqual([])
  })

  // -------------------------------------------------------------------------
  // Polling tests (fake timers with shouldAdvanceTime to let Promises resolve)
  // -------------------------------------------------------------------------

  it('polls at the configured interval', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    listTerminalsFn.mockResolvedValue([TERMINAL_A])

    const { result } = renderHook(() => useTerminalList(1000))

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })
    expect(listTerminalsFn).toHaveBeenCalledTimes(1)

    // Advance past one polling interval
    listTerminalsFn.mockResolvedValue([TERMINAL_A, TERMINAL_B])
    await act(() => {
      vi.advanceTimersByTime(1000)
    })

    await waitFor(() => {
      expect(result.current.terminals).toHaveLength(2)
    })
    expect(listTerminalsFn).toHaveBeenCalledTimes(2)
    expect(result.current.terminals).toEqual([TERMINAL_A, TERMINAL_B])
  })

  it('shows a newly created terminal immediately before the next poll', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    listTerminalsFn.mockResolvedValue([TERMINAL_A])

    const { result } = renderHook(() => useTerminalList(1000))

    await waitFor(() => {
      expect(result.current.terminals).toEqual([TERMINAL_A])
    })

    act(() => {
      upsertTerminalListItem(TERMINAL_B)
    })

    expect(result.current.terminals).toEqual([TERMINAL_A, TERMINAL_B])
    expect(listTerminalsFn).toHaveBeenCalledTimes(1)
  })

  it('removes a closed terminal immediately before the next poll', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    listTerminalsFn.mockResolvedValue([TERMINAL_A, TERMINAL_B])

    const { result } = renderHook(() => useTerminalList(1000))

    await waitFor(() => {
      expect(result.current.terminals).toEqual([TERMINAL_A, TERMINAL_B])
    })

    act(() => {
      removeTerminalListItem(TERMINAL_B.id)
    })

    expect(result.current.terminals).toEqual([TERMINAL_A])
    expect(listTerminalsFn).toHaveBeenCalledTimes(1)
  })

  it('keeps last known terminals when a subsequent poll fails', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    listTerminalsFn.mockResolvedValue([TERMINAL_A])

    const { result } = renderHook(() => useTerminalList(1000))

    await waitFor(() => {
      expect(result.current.terminals).toEqual([TERMINAL_A])
    })

    // Next poll fails
    listTerminalsFn.mockRejectedValue(new Error('Service restarting'))
    await act(() => {
      vi.advanceTimersByTime(1000)
    })

    await waitFor(() => {
      expect(result.current.serviceStatus).toBe('unavailable')
    })

    // Terminals from the successful fetch are retained
    expect(result.current.terminals).toEqual([TERMINAL_A])
    expect(result.current.errorMessage).toBe('Service restarting')
  })

  it('recovers after service becomes available again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    listTerminalsFn.mockRejectedValue(new Error('Down'))

    const { result } = renderHook(() => useTerminalList(1000))

    await waitFor(() => {
      expect(result.current.serviceStatus).toBe('unavailable')
    })

    // Service comes back
    listTerminalsFn.mockResolvedValue([TERMINAL_A])
    await act(() => {
      vi.advanceTimersByTime(1000)
    })

    await waitFor(() => {
      expect(result.current.isServiceAvailable).toBe(true)
    })
    expect(result.current.terminals).toEqual([TERMINAL_A])
    expect(result.current.errorMessage).toBeNull()
  })

  it('cleans up the polling interval on unmount', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    listTerminalsFn.mockResolvedValue([])

    const { result, unmount } = renderHook(() => useTerminalList(1000))

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })
    expect(listTerminalsFn).toHaveBeenCalledTimes(1)

    unmount()

    // Advance timers — should NOT trigger another fetch
    await act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(listTerminalsFn).toHaveBeenCalledTimes(1)
  })

  it('does not poll when interval is 0', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    listTerminalsFn.mockResolvedValue([TERMINAL_A])

    const { result } = renderHook(() => useTerminalList(0))

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })
    expect(listTerminalsFn).toHaveBeenCalledTimes(1)

    // Advance well past any potential interval
    await act(() => {
      vi.advanceTimersByTime(10_000)
    })
    expect(listTerminalsFn).toHaveBeenCalledTimes(1)
  })
})
