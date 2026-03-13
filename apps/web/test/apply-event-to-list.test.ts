/**
 * Unit tests for the `applyEventToList` pure function.
 *
 * This function applies a single `TerminalLifecycleEventSchema` event
 * to an in-memory terminal list and returns the updated list. It handles
 * all 6 event types: ProcessChanged, Spawned, StatusChanged, Removed,
 * Restarted, and Exited.
 *
 * Tests are isolated here (separate from use-terminal-list.test.ts)
 * because `applyEventToList` is a pure function that doesn't need the
 * React/Atom mocking infrastructure the hook tests require.
 */

import { describe, expect, it } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks — only the modules the source file imports at module level that
// are unavailable in the test environment.
// ---------------------------------------------------------------------------

import { vi } from 'vitest'

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
  useAtomValue: () => ({ _tag: 'Success', waiting: false, value: [] }),
  useAtomSet: () => vi.fn(),
}))

vi.mock('@/atoms/terminal-service-client', () => ({
  TerminalServiceClient: {
    mutation: () => Symbol.for('noop'),
    runtime: {
      atom: () => Symbol.for('terminalListAtom'),
    },
  },
}))

import { applyEventToList } from '../src/hooks/use-terminal-list'

// ---------------------------------------------------------------------------
// Shared test data
// ---------------------------------------------------------------------------

const EXISTING_TERMINAL = {
  id: 'term-existing',
  workspaceId: 'ws-1',
  command: '/bin/zsh',
  args: [] as readonly string[],
  cwd: '/home/user',
  agentStatus: null,
  foregroundProcess: null,
  hasChildProcess: false,
  processChain: [] as readonly never[],
  status: 'running' as const,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('applyEventToList', () => {
  it('ProcessChanged upserts the terminal from the event payload', () => {
    const updated = {
      ...EXISTING_TERMINAL,
      hasChildProcess: true,
      foregroundProcess: {
        category: 'agent' as const,
        label: 'Claude',
        rawName: 'claude',
      },
    }

    const result = applyEventToList(
      { _tag: 'ProcessChanged', terminal: updated },
      [EXISTING_TERMINAL]
    )

    expect(result).toEqual([updated])
  })

  it('ProcessChanged adds a new terminal if not present', () => {
    const newTerminal = { ...EXISTING_TERMINAL, id: 'term-new' }

    const result = applyEventToList(
      { _tag: 'ProcessChanged', terminal: newTerminal },
      [EXISTING_TERMINAL]
    )

    expect(result).toHaveLength(2)
    expect(result[1]).toEqual(newTerminal)
  })

  it('Spawned adds a new terminal with default fields', () => {
    const result = applyEventToList(
      {
        _tag: 'Spawned',
        id: 'term-spawned',
        workspaceId: 'ws-2',
        command: 'npm run dev',
        status: 'running' as const,
      },
      [EXISTING_TERMINAL]
    )

    expect(result).toHaveLength(2)
    expect(result[1]).toEqual({
      id: 'term-spawned',
      workspaceId: 'ws-2',
      command: 'npm run dev',
      args: [],
      cwd: '',
      agentStatus: null,
      foregroundProcess: null,
      hasChildProcess: false,
      processChain: [],
      status: 'running',
    })
  })

  it('StatusChanged updates the status of an existing terminal', () => {
    const result = applyEventToList(
      {
        _tag: 'StatusChanged',
        id: 'term-existing',
        status: 'stopped' as const,
      },
      [EXISTING_TERMINAL]
    )

    expect(result).toHaveLength(1)
    expect(result[0]?.status).toBe('stopped')
    // Other fields preserved
    expect(result[0]?.command).toBe('/bin/zsh')
  })

  it('StatusChanged is a no-op for unknown terminal IDs', () => {
    const result = applyEventToList(
      {
        _tag: 'StatusChanged',
        id: 'nonexistent',
        status: 'stopped' as const,
      },
      [EXISTING_TERMINAL]
    )

    expect(result).toEqual([EXISTING_TERMINAL])
  })

  it('Removed filters the terminal out of the list', () => {
    const result = applyEventToList({ _tag: 'Removed', id: 'term-existing' }, [
      EXISTING_TERMINAL,
    ])

    expect(result).toHaveLength(0)
  })

  it('Removed is a no-op for unknown terminal IDs', () => {
    const result = applyEventToList({ _tag: 'Removed', id: 'nonexistent' }, [
      EXISTING_TERMINAL,
    ])

    expect(result).toEqual([EXISTING_TERMINAL])
  })

  it('Restarted resets process fields and updates status/command', () => {
    const withAgent = {
      ...EXISTING_TERMINAL,
      agentStatus: 'active' as const,
      hasChildProcess: true,
      foregroundProcess: {
        category: 'agent' as const,
        label: 'Claude',
        rawName: 'claude',
      },
      processChain: [
        { category: 'agent' as const, label: 'Claude', rawName: 'claude' },
      ],
    }

    const result = applyEventToList(
      {
        _tag: 'Restarted',
        id: 'term-existing',
        workspaceId: 'ws-1',
        command: 'npm run dev',
        status: 'running' as const,
      },
      [withAgent]
    )

    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      ...withAgent,
      command: 'npm run dev',
      status: 'running',
      agentStatus: null,
      foregroundProcess: null,
      hasChildProcess: false,
      processChain: [],
    })
  })

  it('Restarted is a no-op for unknown terminal IDs', () => {
    const result = applyEventToList(
      {
        _tag: 'Restarted',
        id: 'nonexistent',
        workspaceId: 'ws-1',
        command: 'cat',
        status: 'running' as const,
      },
      [EXISTING_TERMINAL]
    )

    expect(result).toEqual([EXISTING_TERMINAL])
  })

  it('Exited is informational and does not change the list', () => {
    const result = applyEventToList(
      { _tag: 'Exited', id: 'term-existing', exitCode: 0, signal: 0 },
      [EXISTING_TERMINAL]
    )

    expect(result).toEqual([EXISTING_TERMINAL])
  })
})
