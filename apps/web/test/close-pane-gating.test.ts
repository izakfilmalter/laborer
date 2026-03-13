/**
 * Unit tests for synchronous close-pane gating.
 *
 * Tests the pure functions `computeClosePaneAction` and
 * `computeCloseWorkspaceAction` which determine whether closing a pane
 * or workspace should proceed immediately or show a confirmation dialog.
 *
 * These functions use cached terminal data (from the 5-second poll) to
 * make instant decisions — no async RPC calls at close time.
 *
 * This follows the same pattern as VS Code's ChildProcessMonitor: process
 * state is pre-cached and read synchronously at close time.
 *
 * @see apps/web/src/panels/layout-utils.ts — computeClosePaneAction, computeCloseWorkspaceAction
 * @see apps/web/src/routes/index.tsx — gatedClosePane (consumer)
 */

import type { LeafNode, SplitNode } from '@laborer/shared/types'
import { describe, expect, it } from 'vitest'
import {
  computeClosePaneAction,
  computeCloseWorkspaceAction,
} from '../src/panels/layout-utils'

describe('computeClosePaneAction', () => {
  it('returns "close" when the terminal has no child process', () => {
    const layout: LeafNode = {
      _tag: 'LeafNode',
      id: 'pane-A',
      paneType: 'terminal',
      terminalId: 'term-1',
      workspaceId: 'ws-1',
    }

    const terminals = [{ id: 'term-1', hasChildProcess: false }]

    const result = computeClosePaneAction(layout, 'pane-A', terminals)

    expect(result).toBe('close')
  })

  it('returns "confirm" when the terminal has a running child process', () => {
    const layout: LeafNode = {
      _tag: 'LeafNode',
      id: 'pane-A',
      paneType: 'terminal',
      terminalId: 'term-1',
      workspaceId: 'ws-1',
    }

    const terminals = [{ id: 'term-1', hasChildProcess: true }]

    const result = computeClosePaneAction(layout, 'pane-A', terminals)

    expect(result).toBe('confirm')
  })

  it('returns "close" when the pane has no terminal assigned', () => {
    const layout: LeafNode = {
      _tag: 'LeafNode',
      id: 'pane-empty',
      paneType: 'terminal',
    }

    const result = computeClosePaneAction(layout, 'pane-empty', [])

    expect(result).toBe('close')
  })

  it('returns "close" when layout is undefined', () => {
    const result = computeClosePaneAction(undefined, 'pane-A', [])

    expect(result).toBe('close')
  })

  it('returns "close" when pane ID does not exist in the layout', () => {
    const layout: LeafNode = {
      _tag: 'LeafNode',
      id: 'pane-A',
      paneType: 'terminal',
      terminalId: 'term-1',
      workspaceId: 'ws-1',
    }

    const terminals = [{ id: 'term-1', hasChildProcess: true }]

    const result = computeClosePaneAction(layout, 'nonexistent', terminals)

    expect(result).toBe('close')
  })

  it('returns the correct action for a nested pane with a running process', () => {
    const layout: SplitNode = {
      _tag: 'SplitNode',
      id: 'split-root',
      direction: 'horizontal',
      children: [
        {
          _tag: 'LeafNode',
          id: 'pane-A',
          paneType: 'terminal',
          terminalId: 'term-1',
          workspaceId: 'ws-1',
        },
        {
          _tag: 'LeafNode',
          id: 'pane-B',
          paneType: 'terminal',
          terminalId: 'term-2',
          workspaceId: 'ws-1',
        },
      ],
      sizes: [50, 50],
    }

    const terminals = [
      { id: 'term-1', hasChildProcess: false },
      { id: 'term-2', hasChildProcess: true },
    ]

    // Idle terminal → close immediately
    expect(computeClosePaneAction(layout, 'pane-A', terminals)).toBe('close')
    // Running process → show confirmation
    expect(computeClosePaneAction(layout, 'pane-B', terminals)).toBe('confirm')
  })
})

describe('computeCloseWorkspaceAction', () => {
  it('returns "close" when no workspace terminal has a running child process', () => {
    const layout: SplitNode = {
      _tag: 'SplitNode',
      id: 'split-root',
      direction: 'horizontal',
      children: [
        {
          _tag: 'LeafNode',
          id: 'pane-A',
          paneType: 'terminal',
          terminalId: 'term-1',
          workspaceId: 'ws-1',
        },
        {
          _tag: 'LeafNode',
          id: 'pane-B',
          paneType: 'terminal',
          terminalId: 'term-2',
          workspaceId: 'ws-1',
        },
      ],
      sizes: [50, 50],
    }

    const terminals = [
      { id: 'term-1', hasChildProcess: false },
      { id: 'term-2', hasChildProcess: false },
    ]

    const result = computeCloseWorkspaceAction(layout, 'ws-1', terminals)

    expect(result).toBe('close')
  })

  it('returns "confirm" when any workspace terminal has a running child process', () => {
    const layout: SplitNode = {
      _tag: 'SplitNode',
      id: 'split-root',
      direction: 'horizontal',
      children: [
        {
          _tag: 'LeafNode',
          id: 'pane-A',
          paneType: 'terminal',
          terminalId: 'term-1',
          workspaceId: 'ws-1',
        },
        {
          _tag: 'LeafNode',
          id: 'pane-B',
          paneType: 'terminal',
          terminalId: 'term-2',
          workspaceId: 'ws-1',
        },
      ],
      sizes: [50, 50],
    }

    const terminals = [
      { id: 'term-1', hasChildProcess: false },
      { id: 'term-2', hasChildProcess: true },
    ]

    const result = computeCloseWorkspaceAction(layout, 'ws-1', terminals)

    expect(result).toBe('confirm')
  })

  it('returns "close" when layout is undefined', () => {
    const result = computeCloseWorkspaceAction(undefined, 'ws-1', [])

    expect(result).toBe('close')
  })

  it('only considers terminals from the specified workspace', () => {
    const layout: SplitNode = {
      _tag: 'SplitNode',
      id: 'split-root',
      direction: 'horizontal',
      children: [
        {
          _tag: 'LeafNode',
          id: 'pane-A',
          paneType: 'terminal',
          terminalId: 'term-1',
          workspaceId: 'ws-1',
        },
        {
          _tag: 'LeafNode',
          id: 'pane-B',
          paneType: 'terminal',
          terminalId: 'term-2',
          workspaceId: 'ws-2',
        },
      ],
      sizes: [50, 50],
    }

    const terminals = [
      { id: 'term-1', hasChildProcess: false },
      { id: 'term-2', hasChildProcess: true }, // different workspace
    ]

    // ws-1 has no running processes — should close immediately
    expect(computeCloseWorkspaceAction(layout, 'ws-1', terminals)).toBe('close')
    // ws-2 has a running process — should confirm
    expect(computeCloseWorkspaceAction(layout, 'ws-2', terminals)).toBe(
      'confirm'
    )
  })
})
