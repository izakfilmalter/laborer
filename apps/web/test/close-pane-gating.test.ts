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
  computeClosePaneGateAction,
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

// ---------------------------------------------------------------------------
// Tests: computeClosePaneGateAction
//
// Enriched close-pane gating that also considers whether the pane being
// closed is the last pane for a workspace with a merged PR. When both
// conditions hold, the user should be offered a "close and destroy" action.
//
// Returns one of:
// - 'close': close immediately, no dialog
// - 'confirm': show "process running" dialog (2 actions: Cancel, Close)
// - 'confirm-with-destroy': show "process running" dialog with 3 actions
//   (Cancel, Close, Close & Destroy)
// - 'prompt-destroy': no running process but last pane + merged PR —
//   show "destroy workspace?" dialog
// ---------------------------------------------------------------------------

describe('computeClosePaneGateAction', () => {
  it('returns "close" when no process and PR is not merged', () => {
    const layout: LeafNode = {
      _tag: 'LeafNode',
      id: 'pane-A',
      paneType: 'terminal',
      terminalId: 'term-1',
      workspaceId: 'ws-1',
    }
    const terminals = [{ id: 'term-1', hasChildProcess: false }]

    const result = computeClosePaneGateAction(layout, 'pane-A', terminals, null)
    expect(result).toEqual({ action: 'close' })
  })

  it('returns "confirm" when process running and PR is not merged', () => {
    const layout: LeafNode = {
      _tag: 'LeafNode',
      id: 'pane-A',
      paneType: 'terminal',
      terminalId: 'term-1',
      workspaceId: 'ws-1',
    }
    const terminals = [{ id: 'term-1', hasChildProcess: true }]

    const result = computeClosePaneGateAction(layout, 'pane-A', terminals, null)
    expect(result).toEqual({ action: 'confirm' })
  })

  it('returns "confirm" when process running and PR merged but NOT last pane', () => {
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
      { id: 'term-1', hasChildProcess: true },
      { id: 'term-2', hasChildProcess: false },
    ]

    const result = computeClosePaneGateAction(
      layout,
      'pane-A',
      terminals,
      'merged'
    )
    expect(result).toEqual({ action: 'confirm' })
  })

  it('returns "confirm-with-destroy" when process running, last pane, PR merged', () => {
    const layout: LeafNode = {
      _tag: 'LeafNode',
      id: 'pane-A',
      paneType: 'terminal',
      terminalId: 'term-1',
      workspaceId: 'ws-1',
    }
    const terminals = [{ id: 'term-1', hasChildProcess: true }]

    const result = computeClosePaneGateAction(
      layout,
      'pane-A',
      terminals,
      'merged'
    )
    expect(result).toEqual({
      action: 'confirm-with-destroy',
      workspaceId: 'ws-1',
    })
  })

  it('returns "prompt-destroy" when no process, last pane, PR merged', () => {
    const layout: LeafNode = {
      _tag: 'LeafNode',
      id: 'pane-A',
      paneType: 'terminal',
      terminalId: 'term-1',
      workspaceId: 'ws-1',
    }
    const terminals = [{ id: 'term-1', hasChildProcess: false }]

    const result = computeClosePaneGateAction(
      layout,
      'pane-A',
      terminals,
      'merged'
    )
    expect(result).toEqual({ action: 'prompt-destroy', workspaceId: 'ws-1' })
  })

  it('returns "close" when no process, last pane, but PR is open (not merged)', () => {
    const layout: LeafNode = {
      _tag: 'LeafNode',
      id: 'pane-A',
      paneType: 'terminal',
      terminalId: 'term-1',
      workspaceId: 'ws-1',
    }
    const terminals = [{ id: 'term-1', hasChildProcess: false }]

    const result = computeClosePaneGateAction(
      layout,
      'pane-A',
      terminals,
      'open'
    )
    expect(result).toEqual({ action: 'close' })
  })

  it('considers only same-workspace panes when checking last pane', () => {
    // Two panes from different workspaces — pane-A is the ONLY pane for ws-1
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
      { id: 'term-2', hasChildProcess: false },
    ]

    // pane-A is the last pane for ws-1 and PR is merged → prompt-destroy
    const result = computeClosePaneGateAction(
      layout,
      'pane-A',
      terminals,
      'merged'
    )
    expect(result).toEqual({ action: 'prompt-destroy', workspaceId: 'ws-1' })
  })

  it('returns "close" when layout is undefined', () => {
    const result = computeClosePaneGateAction(undefined, 'pane-A', [], 'merged')
    expect(result).toEqual({ action: 'close' })
  })
})
