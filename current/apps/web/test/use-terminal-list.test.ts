import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Mock setup (vi.hoisted runs before vi.mock factory functions)
// ---------------------------------------------------------------------------

const { listTerminalsFn, mutationMap, atomValueMap } = vi.hoisted(() => ({
  listTerminalsFn: vi.fn(),
  mutationMap: new Map<unknown, ReturnType<typeof vi.fn>>(),
  atomValueMap: new Map<unknown, unknown>(),
}))

vi.mock('@effect-atom/atom', () => ({
  Atom: {
    keepAlive: (atom: unknown) => atom,
  },
  Result: {
    isSuccess: (r: { _tag: string }) => r._tag === 'Success',
    isFailure: (r: { _tag: string }) => r._tag === 'Failure',
    isInitial: (r: { _tag: string }) => r._tag === 'Initial',
  },
}))

vi.mock('@effect-atom/atom-react/Hooks', () => ({
  useAtomValue: (atom: unknown) => {
    return (
      atomValueMap.get(atom) ?? {
        _tag: 'Success',
        waiting: false,
        value: [],
      }
    )
  },
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
    runtime: {
      atom: (_effect: unknown) => Symbol.for('terminalListAtom'),
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
// Helpers
// ---------------------------------------------------------------------------

/** Set the mock atom value to simulate a successful terminal list. */
const setAtomTerminals = (terminals: readonly unknown[]) => {
  const atomKey = Symbol.for('terminalListAtom')
  atomValueMap.set(atomKey, {
    _tag: 'Success',
    waiting: false,
    value: terminals,
  })
}

/** Set the mock atom to initial (loading) state. */
const setAtomLoading = () => {
  const atomKey = Symbol.for('terminalListAtom')
  atomValueMap.set(atomKey, {
    _tag: 'Initial',
    waiting: true,
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useTerminalList', () => {
  afterEach(() => {
    cleanup()
    resetTerminalListStore()
    atomValueMap.clear()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    resetTerminalListStore()
    // Default: atom has loaded an empty list.
    setAtomTerminals([])
  })

  it('starts with loading state when atom is initial', () => {
    setAtomLoading()
    const { result } = renderHook(() => useTerminalList())

    expect(result.current.isLoading).toBe(true)
    expect(result.current.terminals).toEqual([])
  })

  it('returns terminals when atom is in success state', async () => {
    setAtomTerminals([TERMINAL_A, TERMINAL_B])
    const { result } = renderHook(() => useTerminalList())

    expect(result.current.isLoading).toBe(false)

    // Wait for useEffect to sync atom result → service status.
    await waitFor(() => {
      expect(result.current.isServiceAvailable).toBe(true)
    })

    expect(result.current.terminals).toEqual([TERMINAL_A, TERMINAL_B])
  })

  it('returns empty array when atom has no terminals', () => {
    setAtomTerminals([])
    const { result } = renderHook(() => useTerminalList())

    expect(result.current.isLoading).toBe(false)
    expect(result.current.terminals).toEqual([])
    expect(result.current.isServiceAvailable).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Optimistic updates via shared store
  // -------------------------------------------------------------------------

  it('shows a newly created terminal via upsertTerminalListItem', () => {
    setAtomTerminals([TERMINAL_A])

    const { result } = renderHook(() => useTerminalList())

    act(() => {
      upsertTerminalListItem(TERMINAL_B)
    })

    expect(result.current.terminals).toEqual([TERMINAL_A, TERMINAL_B])
  })

  it('removes a terminal via removeTerminalListItem', () => {
    setAtomTerminals([TERMINAL_A, TERMINAL_B])

    const { result } = renderHook(() => useTerminalList())

    // First publish so shared store is populated
    act(() => {
      upsertTerminalListItem(TERMINAL_A)
      upsertTerminalListItem(TERMINAL_B)
    })

    act(() => {
      removeTerminalListItem(TERMINAL_B.id)
    })

    expect(result.current.terminals).toEqual([TERMINAL_A])
  })

  // -------------------------------------------------------------------------
  // Imperative refresh — used by close-confirmation gating
  // -------------------------------------------------------------------------

  it('refresh() returns fresh terminal data from the server', async () => {
    setAtomTerminals([TERMINAL_A])
    listTerminalsFn.mockResolvedValue([TERMINAL_A])

    const { result } = renderHook(() => useTerminalList())

    // Server now reports a child process running
    const updatedTerminal = { ...TERMINAL_A, hasChildProcess: true }
    listTerminalsFn.mockResolvedValue([updatedTerminal])

    let freshData: unknown
    await act(async () => {
      freshData = await result.current.refresh()
    })

    expect(freshData).toEqual([updatedTerminal])
  })

  it('refresh() publishes to all subscribers so hook state updates', async () => {
    setAtomTerminals([TERMINAL_A])
    listTerminalsFn.mockResolvedValue([TERMINAL_A])

    const { result } = renderHook(() => useTerminalList())

    // Server reports the process has exited (hasChildProcess flipped)
    const updatedTerminal = { ...TERMINAL_A, hasChildProcess: true }
    listTerminalsFn.mockResolvedValue([updatedTerminal])

    await act(async () => {
      await result.current.refresh()
    })

    // The hook's own terminals state should reflect the refreshed data
    expect(result.current.terminals).toEqual([updatedTerminal])
  })

  it('refresh() propagates errors so callers can fall back to cached data', async () => {
    setAtomTerminals([TERMINAL_A])
    listTerminalsFn.mockResolvedValue([TERMINAL_A])

    const { result } = renderHook(() => useTerminalList())

    // Populate shared store
    await act(async () => {
      await result.current.refresh()
    })

    // Server is down
    listTerminalsFn.mockRejectedValue(new Error('Connection refused'))

    await expect(act(() => result.current.refresh())).rejects.toThrow(
      'Connection refused'
    )

    // Cached terminals should still be available from the hook
    expect(result.current.terminals).toEqual([TERMINAL_A])
  })
})
