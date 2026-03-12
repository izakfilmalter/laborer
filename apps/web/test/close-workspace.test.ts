/**
 * Unit tests for workspace-level close operations.
 *
 * Tests the pure functions used when closing all terminals in a workspace:
 * - `getWorkspaceTerminalIds` — collects terminal IDs for a workspace
 * - `getWorkspaceActiveTerminals` — returns active terminals with process labels
 * - `shouldConfirmCloseWorkspace` — checks for running child processes
 * - `closeWorkspacePanes` — removes all workspace panes from the tree
 *
 * @see apps/web/src/panels/layout-utils.ts
 * @see apps/web/src/routes/index.tsx — handleCloseWorkspace (consumer)
 */

import type { LeafNode, SplitNode } from '@laborer/shared/types'
import { describe, expect, it } from 'vitest'
import {
  closeWorkspacePanes,
  getWorkspaceActiveTerminals,
  getWorkspaceTerminalIds,
  shouldConfirmCloseWorkspace,
} from '../src/panels/layout-utils'

describe('getWorkspaceTerminalIds', () => {
  it('returns terminal IDs for leaves matching the workspace', () => {
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
        {
          _tag: 'LeafNode',
          id: 'pane-C',
          paneType: 'terminal',
          terminalId: 'term-3',
          workspaceId: 'ws-1',
        },
      ],
      sizes: [33, 34, 33],
    }

    const ids = getWorkspaceTerminalIds(layout, 'ws-1')

    expect(ids).toEqual(['term-1', 'term-3'])
  })

  it('includes dev server terminal IDs', () => {
    const layout: LeafNode = {
      _tag: 'LeafNode',
      id: 'pane-A',
      paneType: 'terminal',
      terminalId: 'term-1',
      workspaceId: 'ws-1',
      devServerTerminalId: 'term-dev-1',
    }

    const ids = getWorkspaceTerminalIds(layout, 'ws-1')

    expect(ids).toEqual(['term-1', 'term-dev-1'])
  })

  it('returns empty array when layout is undefined', () => {
    const ids = getWorkspaceTerminalIds(undefined, 'ws-1')

    expect(ids).toEqual([])
  })

  it('returns empty array when no leaves match the workspace', () => {
    const layout: LeafNode = {
      _tag: 'LeafNode',
      id: 'pane-A',
      paneType: 'terminal',
      terminalId: 'term-1',
      workspaceId: 'ws-2',
    }

    const ids = getWorkspaceTerminalIds(layout, 'ws-1')

    expect(ids).toEqual([])
  })

  it('skips leaves without terminal IDs', () => {
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
          id: 'pane-empty',
          paneType: 'terminal',
          workspaceId: 'ws-1',
        },
      ],
      sizes: [50, 50],
    }

    const ids = getWorkspaceTerminalIds(layout, 'ws-1')

    expect(ids).toEqual(['term-1'])
  })
})

describe('getWorkspaceActiveTerminals', () => {
  it('returns terminals with active child processes and their labels', () => {
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
      {
        id: 'term-1',
        hasChildProcess: true,
        foregroundProcess: {
          category: 'editor' as const,
          label: 'vim',
          rawName: 'nvim',
        },
      },
      {
        id: 'term-2',
        hasChildProcess: false,
        foregroundProcess: null,
      },
    ]

    const result = getWorkspaceActiveTerminals(layout, 'ws-1', terminals)

    expect(result).toEqual([{ id: 'term-1', label: 'vim' }])
  })

  it('uses fallback label when foregroundProcess is null', () => {
    const layout: LeafNode = {
      _tag: 'LeafNode',
      id: 'pane-A',
      paneType: 'terminal',
      terminalId: 'term-1',
      workspaceId: 'ws-1',
    }

    const terminals = [
      {
        id: 'term-1',
        hasChildProcess: true,
        foregroundProcess: null,
      },
    ]

    const result = getWorkspaceActiveTerminals(layout, 'ws-1', terminals)

    expect(result).toEqual([{ id: 'term-1', label: 'Running process' }])
  })

  it('returns empty array when no terminals have child processes', () => {
    const layout: LeafNode = {
      _tag: 'LeafNode',
      id: 'pane-A',
      paneType: 'terminal',
      terminalId: 'term-1',
      workspaceId: 'ws-1',
    }

    const terminals = [
      {
        id: 'term-1',
        hasChildProcess: false,
        foregroundProcess: null,
      },
    ]

    const result = getWorkspaceActiveTerminals(layout, 'ws-1', terminals)

    expect(result).toEqual([])
  })

  it('returns empty array when layout is undefined', () => {
    const result = getWorkspaceActiveTerminals(undefined, 'ws-1', [])

    expect(result).toEqual([])
  })

  it('only includes terminals from the specified workspace', () => {
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
      {
        id: 'term-1',
        hasChildProcess: true,
        foregroundProcess: {
          category: 'editor' as const,
          label: 'vim',
          rawName: 'nvim',
        },
      },
      {
        id: 'term-2',
        hasChildProcess: true,
        foregroundProcess: {
          category: 'devServer' as const,
          label: 'Node.js',
          rawName: 'node',
        },
      },
    ]

    const result = getWorkspaceActiveTerminals(layout, 'ws-1', terminals)

    expect(result).toEqual([{ id: 'term-1', label: 'vim' }])
  })

  it('includes dev server terminals', () => {
    const layout: LeafNode = {
      _tag: 'LeafNode',
      id: 'pane-A',
      paneType: 'terminal',
      terminalId: 'term-1',
      workspaceId: 'ws-1',
      devServerTerminalId: 'term-dev-1',
    }

    const terminals = [
      {
        id: 'term-1',
        hasChildProcess: false,
        foregroundProcess: null,
      },
      {
        id: 'term-dev-1',
        hasChildProcess: true,
        foregroundProcess: {
          category: 'devServer' as const,
          label: 'npm run dev',
          rawName: 'node',
        },
      },
    ]

    const result = getWorkspaceActiveTerminals(layout, 'ws-1', terminals)

    expect(result).toEqual([{ id: 'term-dev-1', label: 'npm run dev' }])
  })
})

describe('shouldConfirmCloseWorkspace', () => {
  it('returns true when any workspace terminal has a running child process', () => {
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

    expect(shouldConfirmCloseWorkspace(layout, 'ws-1', terminals)).toBe(true)
  })

  it('returns false when no workspace terminal has a running child process', () => {
    const layout: LeafNode = {
      _tag: 'LeafNode',
      id: 'pane-A',
      paneType: 'terminal',
      terminalId: 'term-1',
      workspaceId: 'ws-1',
    }

    const terminals = [{ id: 'term-1', hasChildProcess: false }]

    expect(shouldConfirmCloseWorkspace(layout, 'ws-1', terminals)).toBe(false)
  })

  it('returns false when layout is undefined', () => {
    expect(shouldConfirmCloseWorkspace(undefined, 'ws-1', [])).toBe(false)
  })

  it('returns false when workspace has no terminals in the layout', () => {
    const layout: LeafNode = {
      _tag: 'LeafNode',
      id: 'pane-A',
      paneType: 'terminal',
      terminalId: 'term-1',
      workspaceId: 'ws-2',
    }

    const terminals = [{ id: 'term-1', hasChildProcess: true }]

    expect(shouldConfirmCloseWorkspace(layout, 'ws-1', terminals)).toBe(false)
  })
})

describe('closeWorkspacePanes', () => {
  it('removes all leaves belonging to the workspace', () => {
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

    const result = closeWorkspacePanes(layout, 'ws-1')

    // Only pane-B should remain (collapsed from split to leaf)
    expect(result).toEqual({
      _tag: 'LeafNode',
      id: 'pane-B',
      paneType: 'terminal',
      terminalId: 'term-2',
      workspaceId: 'ws-2',
    })
  })

  it('returns undefined when all panes belong to the workspace', () => {
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

    const result = closeWorkspacePanes(layout, 'ws-1')

    expect(result).toBeUndefined()
  })

  it('returns the layout unchanged when no leaves match the workspace', () => {
    const layout: LeafNode = {
      _tag: 'LeafNode',
      id: 'pane-A',
      paneType: 'terminal',
      terminalId: 'term-1',
      workspaceId: 'ws-2',
    }

    const result = closeWorkspacePanes(layout, 'ws-1')

    expect(result).toEqual(layout)
  })

  it('handles a single leaf that matches the workspace', () => {
    const layout: LeafNode = {
      _tag: 'LeafNode',
      id: 'pane-A',
      paneType: 'terminal',
      terminalId: 'term-1',
      workspaceId: 'ws-1',
    }

    const result = closeWorkspacePanes(layout, 'ws-1')

    expect(result).toBeUndefined()
  })

  it('handles nested splits with mixed workspaces', () => {
    const layout: SplitNode = {
      _tag: 'SplitNode',
      id: 'split-root',
      direction: 'horizontal',
      children: [
        {
          _tag: 'SplitNode',
          id: 'split-left',
          direction: 'vertical',
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
        },
        {
          _tag: 'LeafNode',
          id: 'pane-C',
          paneType: 'terminal',
          terminalId: 'term-3',
          workspaceId: 'ws-1',
        },
      ],
      sizes: [50, 50],
    }

    const result = closeWorkspacePanes(layout, 'ws-1')

    // Only pane-B from ws-2 should remain
    expect(result).toEqual({
      _tag: 'LeafNode',
      id: 'pane-B',
      paneType: 'terminal',
      terminalId: 'term-2',
      workspaceId: 'ws-2',
    })
  })
})
