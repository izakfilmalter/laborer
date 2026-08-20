/**
 * Full-height side panels are keyed by workspace, and the layout is the
 * authority on which workspaces exist.
 *
 * The interesting case is the gap between the two. Revealing a workspace
 * commits the layout asynchronously, so an open request arrives while the
 * layout still knows nothing about the workspace it names — and the pass
 * that closes panels for departed workspaces cannot tell "not here yet"
 * from "gone" by looking at the layout alone. These tests pin both sides:
 * a request survives that gap, and a genuinely departed workspace still
 * loses its panel.
 */

import type { WindowLayout, WorkspaceTileNode } from '@laborer/shared/types'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

const renderVisibility = (windowLayout: WindowLayout | undefined) => {
  const focusWorkspace = vi.fn()
  const view = renderHook(
    (props: { readonly windowLayout: WindowLayout | undefined }) =>
      useWorkspacePanelVisibility({
        focusWorkspace,
        windowLayout: props.windowLayout,
      }),
    { initialProps: { windowLayout } }
  )

  return { focusWorkspace, view }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useWorkspacePanelVisibility', () => {
  afterEach(() => {
    cleanup()
  })

  it('opens the conversation for a workspace that is not the focused one', () => {
    const { focusWorkspace, view } = renderVisibility(
      layoutOf(['ws-focused'], ['ws-elsewhere'])
    )

    act(() => {
      view.result.current.openCommentsForWorkspace('ws-elsewhere')
    })

    expect(focusWorkspace).toHaveBeenCalledWith('ws-elsewhere')
    expect(view.result.current.commentsWorkspaceIds).toEqual(['ws-elsewhere'])
  })

  it('focuses an already-open conversation rather than closing it', () => {
    const { focusWorkspace, view } = renderVisibility(layoutOf(['ws-1']))

    act(() => {
      view.result.current.openCommentsForWorkspace('ws-1')
    })
    act(() => {
      view.result.current.openCommentsForWorkspace('ws-1')
    })

    expect(focusWorkspace).toHaveBeenCalledTimes(2)
    expect(view.result.current.commentsWorkspaceIds).toEqual(['ws-1'])
  })

  it('holds an open request until the workspace reaches the layout', () => {
    const { view } = renderVisibility(layoutOf(['ws-open']))

    act(() => {
      view.result.current.openCommentsForWorkspace('ws-arriving')
    })

    // The layout commit has not landed, so the request is still unanswered
    // rather than recorded against a workspace the layout would disown.
    expect(view.result.current.commentsWorkspaceIds).toEqual([])

    act(() => {
      view.rerender({ windowLayout: layoutOf(['ws-open', 'ws-arriving']) })
    })

    expect(view.result.current.commentsWorkspaceIds).toEqual(['ws-arriving'])
  })

  it('survives an intermediate commit that does not yet name the workspace', () => {
    const { view } = renderVisibility(undefined)

    act(() => {
      view.result.current.openCommentsForWorkspace('ws-arriving')
    })

    // Adding a workspace to an empty window creates the tab first, so a
    // layout without it lands in between. That must not reap the request.
    act(() => {
      view.rerender({ windowLayout: layoutOf([]) })
    })
    expect(view.result.current.commentsWorkspaceIds).toEqual([])

    act(() => {
      view.rerender({ windowLayout: layoutOf(['ws-arriving']) })
    })

    expect(view.result.current.commentsWorkspaceIds).toEqual(['ws-arriving'])
  })

  it('closes a panel when its workspace leaves the layout', () => {
    const { view } = renderVisibility(layoutOf(['ws-1', 'ws-2']))

    act(() => {
      view.result.current.toggleComments('ws-1')
      view.result.current.toggleDiff('ws-2')
    })

    expect(view.result.current.commentsWorkspaceIds).toEqual(['ws-1'])
    expect(view.result.current.diffWorkspaceIds).toEqual(['ws-2'])

    act(() => {
      view.rerender({ windowLayout: layoutOf(['ws-2']) })
    })

    expect(view.result.current.commentsWorkspaceIds).toEqual([])
    expect(view.result.current.diffWorkspaceIds).toEqual(['ws-2'])
  })

  it('toggles a panel shut for a workspace that is still open', () => {
    const { view } = renderVisibility(layoutOf(['ws-1']))

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
