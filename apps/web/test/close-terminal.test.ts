/**
 * Unit tests for terminal cleanup on pane close.
 *
 * Tests the pure function `getTerminalIdsToRemove` which determines
 * which terminal processes need to be killed when a pane is closed.
 * This logic ensures you can't have running terminals without a pane.
 *
 * @see apps/web/src/panels/layout-utils.ts — getTerminalIdsToRemove
 * @see apps/web/src/routes/index.tsx — handleClosePane (consumer)
 */

import type { LeafNode, SplitNode } from '@laborer/shared/types'
import { describe, expect, it } from 'vitest'
import { getTerminalIdsToRemove } from '../src/panels/layout-utils'

describe('getTerminalIdsToRemove', () => {
  it('returns the terminal ID when closing a pane with a terminal', () => {
    const layout: LeafNode = {
      _tag: 'LeafNode',
      id: 'pane-A',
      paneType: 'terminal',
      terminalId: 'term-1',
      workspaceId: 'ws-1',
    }

    const ids = getTerminalIdsToRemove(layout, 'pane-A')

    expect(ids).toEqual(['term-1'])
  })

  it('returns both terminal and dev server IDs when pane has both', () => {
    const layout: LeafNode = {
      _tag: 'LeafNode',
      id: 'pane-A',
      paneType: 'terminal',
      terminalId: 'term-1',
      workspaceId: 'ws-1',
      devServerTerminalId: 'term-dev-1',
    }

    const ids = getTerminalIdsToRemove(layout, 'pane-A')

    expect(ids).toEqual(['term-1', 'term-dev-1'])
  })

  it('returns empty array when pane has no terminal assigned', () => {
    const layout: LeafNode = {
      _tag: 'LeafNode',
      id: 'pane-empty',
      paneType: 'terminal',
    }

    const ids = getTerminalIdsToRemove(layout, 'pane-empty')

    expect(ids).toEqual([])
  })

  it('returns empty array when layout is undefined', () => {
    const ids = getTerminalIdsToRemove(undefined, 'pane-A')

    expect(ids).toEqual([])
  })

  it('returns empty array when pane ID does not exist in the layout', () => {
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
        },
        {
          _tag: 'LeafNode',
          id: 'pane-B',
          paneType: 'terminal',
          terminalId: 'term-2',
        },
      ],
      sizes: [50, 50],
    }

    const ids = getTerminalIdsToRemove(layout, 'nonexistent')

    expect(ids).toEqual([])
  })

  it('finds the terminal in a nested layout', () => {
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
        },
        {
          _tag: 'SplitNode',
          id: 'split-right',
          direction: 'vertical',
          children: [
            {
              _tag: 'LeafNode',
              id: 'pane-B',
              paneType: 'terminal',
              terminalId: 'term-2',
            },
            {
              _tag: 'LeafNode',
              id: 'pane-C',
              paneType: 'terminal',
              terminalId: 'term-3',
              devServerTerminalId: 'term-dev-3',
            },
          ],
          sizes: [50, 50],
        },
      ],
      sizes: [50, 50],
    }

    // Closing a deeply nested pane returns its terminal ID
    expect(getTerminalIdsToRemove(layout, 'pane-C')).toEqual([
      'term-3',
      'term-dev-3',
    ])

    // Other panes are not affected
    expect(getTerminalIdsToRemove(layout, 'pane-A')).toEqual(['term-1'])
    expect(getTerminalIdsToRemove(layout, 'pane-B')).toEqual(['term-2'])
  })

  it('returns empty array when pane ID matches a SplitNode, not a leaf', () => {
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
        },
        {
          _tag: 'LeafNode',
          id: 'pane-B',
          paneType: 'terminal',
          terminalId: 'term-2',
        },
      ],
      sizes: [50, 50],
    }

    // SplitNodes aren't closeable panes — should return nothing
    expect(getTerminalIdsToRemove(layout, 'split-root')).toEqual([])
  })
})
