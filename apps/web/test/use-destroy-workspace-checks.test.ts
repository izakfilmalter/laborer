import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { checkDirtyFn, mutationMap, refreshTerminalsFn, terminalsState } =
  vi.hoisted(() => ({
    checkDirtyFn: vi.fn(),
    mutationMap: new Map<unknown, ReturnType<typeof vi.fn>>(),
    refreshTerminalsFn: vi.fn(),
    terminalsState: { terminals: [] as readonly unknown[] },
  }))

vi.mock('@effect-atom/atom-react/Hooks', () => ({
  useAtomSet: (atom: unknown) => {
    return mutationMap.get(atom) ?? vi.fn()
  },
}))

vi.mock('@/atoms/laborer-client', () => ({
  LaborerClient: {
    mutation: (name: string) => {
      const sentinel = Symbol.for(`mutation:${name}`)
      if (name === 'workspace.checkDirty') {
        mutationMap.set(sentinel, checkDirtyFn)
      }
      return sentinel
    },
  },
}))

vi.mock('@/hooks/use-terminal-list', () => ({
  useTerminalList: () => ({
    terminals: terminalsState.terminals,
    refresh: refreshTerminalsFn,
  }),
}))

import { useDestroyWorkspaceChecks } from '../src/hooks/use-destroy-workspace-checks'

const ACTIVE_TERMINAL = {
  id: 'term-1',
  workspaceId: 'ws-1',
  command: '/bin/zsh',
  args: [],
  cwd: '/tmp/ws-1',
  agentStatus: null,
  foregroundProcess: {
    category: 'editor' as const,
    label: 'nvim',
    rawName: 'nvim',
  },
  hasChildProcess: true,
  processChain: [],
  status: 'running' as const,
}

const IDLE_TERMINAL = {
  ...ACTIVE_TERMINAL,
  id: 'term-2',
  workspaceId: 'ws-2',
  foregroundProcess: null,
  hasChildProcess: false,
}

const createDeferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })

  return { promise, reject, resolve }
}

describe('useDestroyWorkspaceChecks', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    terminalsState.terminals = [ACTIVE_TERMINAL, IDLE_TERMINAL]
  })

  it('shows cached active terminals immediately while checks are still running', () => {
    checkDirtyFn.mockImplementation(
      () =>
        new Promise(() => {
          // Keep pending so the hook stays in a loading state.
        })
    )
    refreshTerminalsFn.mockImplementation(
      () =>
        new Promise(() => {
          // Keep pending so the hook stays in a loading state.
        })
    )

    const { result } = renderHook(() => useDestroyWorkspaceChecks('ws-1'))

    act(() => {
      result.current.startChecks()
    })

    expect(result.current.activeTerminals).toEqual([
      { id: 'term-1', label: 'nvim' },
    ])
    expect(result.current.isCheckingDirtyFiles).toBe(true)
    expect(result.current.isCheckingTerminals).toBe(true)
  })

  it('publishes dirty files as soon as that check resolves without waiting for terminals', async () => {
    const dirtyFilesDeferred = createDeferred<readonly string[]>()
    const terminalsDeferred =
      createDeferred<readonly (typeof ACTIVE_TERMINAL)[]>()
    checkDirtyFn.mockReturnValue(dirtyFilesDeferred.promise)
    refreshTerminalsFn.mockReturnValue(terminalsDeferred.promise)

    const { result } = renderHook(() => useDestroyWorkspaceChecks('ws-1'))

    act(() => {
      result.current.startChecks()
    })

    await act(async () => {
      dirtyFilesDeferred.resolve(['src/app.ts'])
      await dirtyFilesDeferred.promise
    })

    await waitFor(() => {
      expect(result.current.dirtyFiles).toEqual(['src/app.ts'])
    })
    expect(result.current.isCheckingDirtyFiles).toBe(false)
    expect(result.current.isCheckingTerminals).toBe(true)
  })
})
