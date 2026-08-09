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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

import {
  applyEventToList,
  removeTerminalListItem,
  resetTerminalListStore,
  upsertTerminalListItem,
} from '../src/hooks/use-terminal-list'

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
      agentStatus: {
        status: 'working' as const,
        source: 'ps' as const,
        changedAt: 0,
        stale: false,
      },
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

// ---------------------------------------------------------------------------
// Pending removal tests — verifies the "isDisposed" guard that prevents
// the terminal.events stream from re-adding optimistically removed terminals.
//
// This addresses the bug where closing a terminal via Cmd+W would
// optimistically remove it from the shared list, but the terminal.events
// stream would re-add it on the next ProcessChanged event because the
// stream's internal Ref still contained the terminal.
//
// @see .reference/vscode — TerminalInstance.isDisposed pattern
// ---------------------------------------------------------------------------

describe('applyEventToList — pending removal guard', () => {
  beforeEach(() => {
    resetTerminalListStore()
  })

  afterEach(() => {
    resetTerminalListStore()
  })

  it('ProcessChanged is suppressed for optimistically removed terminals', () => {
    // Simulate: terminal exists in the shared store
    upsertTerminalListItem(EXISTING_TERMINAL)
    // Simulate: user closes terminal via Cmd+W → optimistic removal
    removeTerminalListItem(EXISTING_TERMINAL.id)

    // Simulate: detection fiber emits ProcessChanged before the server
    // processes the remove RPC — this is the race condition.
    const updatedTerminal = { ...EXISTING_TERMINAL, hasChildProcess: true }
    const result = applyEventToList(
      { _tag: 'ProcessChanged', terminal: updatedTerminal },
      [EXISTING_TERMINAL]
    )

    // The terminal should NOT be upserted back into the list.
    expect(result).toEqual([EXISTING_TERMINAL])
  })

  it('Spawned is suppressed for optimistically removed terminals', () => {
    upsertTerminalListItem(EXISTING_TERMINAL)
    removeTerminalListItem(EXISTING_TERMINAL.id)

    const result = applyEventToList(
      {
        _tag: 'Spawned',
        id: EXISTING_TERMINAL.id,
        workspaceId: 'ws-1',
        command: '/bin/zsh',
        status: 'running' as const,
      },
      []
    )

    expect(result).toEqual([])
  })

  it('StatusChanged is suppressed for optimistically removed terminals', () => {
    upsertTerminalListItem(EXISTING_TERMINAL)
    removeTerminalListItem(EXISTING_TERMINAL.id)

    const result = applyEventToList(
      {
        _tag: 'StatusChanged',
        id: EXISTING_TERMINAL.id,
        status: 'stopped' as const,
      },
      [EXISTING_TERMINAL]
    )

    // List should be unchanged — the StatusChanged should not update
    // the terminal that is pending removal.
    expect(result).toEqual([EXISTING_TERMINAL])
  })

  it('Restarted is suppressed for optimistically removed terminals', () => {
    upsertTerminalListItem(EXISTING_TERMINAL)
    removeTerminalListItem(EXISTING_TERMINAL.id)

    const result = applyEventToList(
      {
        _tag: 'Restarted',
        id: EXISTING_TERMINAL.id,
        workspaceId: 'ws-1',
        command: 'npm run dev',
        status: 'running' as const,
      },
      [EXISTING_TERMINAL]
    )

    expect(result).toEqual([EXISTING_TERMINAL])
  })

  it('Removed event keeps the pending removal flag to suppress stale events', () => {
    upsertTerminalListItem(EXISTING_TERMINAL)
    removeTerminalListItem(EXISTING_TERMINAL.id)

    // Server confirms the removal
    const afterRemoved = applyEventToList(
      { _tag: 'Removed', id: EXISTING_TERMINAL.id },
      [EXISTING_TERMINAL]
    )
    expect(afterRemoved).toHaveLength(0)

    // A subsequent Spawned event with the same ID should still be suppressed.
    // The pending removal flag is kept permanently to guard against stale
    // ProcessChanged events arriving after the Removed event. Terminal IDs
    // are unique UUIDs so a real respawn would use a new ID.
    const afterRespawn = applyEventToList(
      {
        _tag: 'Spawned',
        id: EXISTING_TERMINAL.id,
        workspaceId: 'ws-1',
        command: '/bin/zsh',
        status: 'running' as const,
      },
      []
    )
    expect(afterRespawn).toHaveLength(0)
  })

  it('events for non-removed terminals are unaffected', () => {
    const otherTerminal = { ...EXISTING_TERMINAL, id: 'term-other' }
    upsertTerminalListItem(EXISTING_TERMINAL)
    // Remove EXISTING_TERMINAL but not otherTerminal
    removeTerminalListItem(EXISTING_TERMINAL.id)

    // ProcessChanged for otherTerminal should still work
    const updated = { ...otherTerminal, hasChildProcess: true }
    const result = applyEventToList(
      { _tag: 'ProcessChanged', terminal: updated },
      [otherTerminal]
    )

    expect(result).toEqual([updated])
  })

  it('full Cmd+W scenario: optimistic remove → stream events → server confirmation', () => {
    const termA = { ...EXISTING_TERMINAL, id: 'term-a' }
    const termB = { ...EXISTING_TERMINAL, id: 'term-b', workspaceId: 'ws-2' }
    const list = [termA, termB]

    // User closes term-a via Cmd+W
    upsertTerminalListItem(termA)
    upsertTerminalListItem(termB)
    removeTerminalListItem(termA.id)

    // Stream delivers ProcessChanged for term-a (200ms detection fiber)
    // This should NOT re-add term-a
    const afterProcess = applyEventToList(
      {
        _tag: 'ProcessChanged',
        terminal: { ...termA, hasChildProcess: true },
      },
      list
    )
    expect(afterProcess).toEqual(list) // list unchanged

    // Stream delivers ProcessChanged for term-b (unrelated terminal)
    // This should work normally
    const updatedB = { ...termB, hasChildProcess: true }
    const afterProcessB = applyEventToList(
      { _tag: 'ProcessChanged', terminal: updatedB },
      list
    )
    expect(afterProcessB).toEqual([termA, updatedB])

    // Server confirms removal of term-a
    const afterRemoved = applyEventToList({ _tag: 'Removed', id: termA.id }, [
      termA,
      updatedB,
    ])
    expect(afterRemoved).toEqual([updatedB])

    // User spawns new agent for workspace → Spawned event for new terminal
    // Should work since term-a's pending removal is cleared
    const afterSpawn = applyEventToList(
      {
        _tag: 'Spawned',
        id: 'term-new',
        workspaceId: 'ws-1',
        command: 'opencode',
        status: 'running' as const,
      },
      [updatedB]
    )
    expect(afterSpawn).toHaveLength(2)
    expect(afterSpawn[1]?.id).toBe('term-new')
  })
})
