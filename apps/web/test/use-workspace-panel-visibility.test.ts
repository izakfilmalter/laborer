/**
 * The file tree side panel is keyed by workspace, and the layout is the
 * authority on which workspaces exist: a workspace that leaves the layout
 * takes its panel with it. (Diff and the PR conversation moved into the
 * persisted right-panel store — see `right-panel-store.test.ts`.)
 */

import type { WindowLayout, WorkspaceTileNode } from '@laborer/shared/types'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useWorkspacePanelVisibility } from '@/routes/-hooks/use-workspace-panel-visibility'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const tile = (workspaceId: string): WorkspaceTileNode => ({
  _tag: 'WorkspaceTileLeaf',
  id: `tile-${workspaceId}`,
  panelTabs: [],
  workspaceId,
})

/** One window tab per workspace, so "another tab" is expressible. */
const layoutOf = (...workspaceIdsPerTab: string[][]): WindowLayout => ({
  activeTabId: 'tab-0',
  tabs: workspaceIdsPerTab.map((workspaceIds, index) => ({
    id: `tab-${index}`,
    ...(workspaceIds.length > 0
      ? {
          workspaceLayout:
            workspaceIds.length === 1 && workspaceIds[0] !== undefined
              ? tile(workspaceIds[0])
              : ({
                  _tag: 'WorkspaceTileSplit',
                  children: workspaceIds.map(tile),
                  direction: 'horizontal',
                  id: `split-${index}`,
                  sizes: workspaceIds.map(() => 100 / workspaceIds.length),
                } satisfies WorkspaceTileNode),
        }
      : {}),
  })),
})

const renderVisibility = (windowLayout: WindowLayout | undefined) =>
  renderHook(
    (props: { readonly windowLayout: WindowLayout | undefined }) =>
      useWorkspacePanelVisibility({
        windowLayout: props.windowLayout,
      }),
    { initialProps: { windowLayout } }
  )

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useWorkspacePanelVisibility', () => {
  afterEach(() => {
    cleanup()
  })

  it('closes a tree panel when its workspace leaves the layout', () => {
    const view = renderVisibility(layoutOf(['ws-1', 'ws-2']))

    act(() => {
      view.result.current.toggleTree('ws-1')
      view.result.current.toggleTree('ws-2')
    })

    expect(view.result.current.treeWorkspaceIds).toEqual(['ws-1', 'ws-2'])

    act(() => {
      view.rerender({ windowLayout: layoutOf(['ws-2']) })
    })

    expect(view.result.current.treeWorkspaceIds).toEqual(['ws-2'])
  })

  it('toggles a panel shut for a workspace that is still open', () => {
    const view = renderVisibility(layoutOf(['ws-1']))

    act(() => {
      expect(view.result.current.toggleTree('ws-1')).toBe(true)
    })
    expect(view.result.current.treeWorkspaceIds).toEqual(['ws-1'])

    act(() => {
      expect(view.result.current.toggleTree('ws-1')).toBe(false)
    })
    expect(view.result.current.treeWorkspaceIds).toEqual([])
  })
})
