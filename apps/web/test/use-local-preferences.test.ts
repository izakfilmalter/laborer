import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  projectExpansionCollection,
  sidebarWidthCollection,
  workspaceGroupExpansionCollection,
} from '@/db/local-preferences'
import {
  useProjectCollapseState,
  useWorkspaceGroupCollapseState,
} from '@/hooks/use-project-collapse-state'
import { useSidebarWidth } from '@/hooks/use-sidebar-width'

const deleteIfPresent = async (
  collection:
    | typeof sidebarWidthCollection
    | typeof projectExpansionCollection
    | typeof workspaceGroupExpansionCollection,
  id: string
): Promise<void> => {
  if (collection.has(id)) {
    await collection.delete(id).isPersisted.promise
  }
}

describe('local preference hooks', () => {
  afterEach(() => cleanup())

  it('keeps the responsive sidebar default and clamps inserts and updates', async () => {
    await deleteIfPresent(sidebarWidthCollection, 'current')
    localStorage.setItem('laborer:sidebar-width', '437.25')

    const { result, rerender } = renderHook(
      ({ defaultPx, maxPx }) => useSidebarWidth(200, maxPx, defaultPx),
      { initialProps: { defaultPx: 700, maxPx: 500 } }
    )

    expect(result.current.widthPx).toBe(500)
    rerender({ defaultPx: 700, maxPx: 800 })
    expect(result.current.widthPx).toBe(700)

    act(() => result.current.setWidthPx(900))
    expect(result.current.widthPx).toBe(800)
    expect(sidebarWidthCollection.get('current')).toMatchObject({
      id: 'current',
      widthPx: 800,
    })

    act(() => result.current.setWidthPx(251.4))
    expect(result.current.widthPx).toBe(251)
    expect(sidebarWidthCollection.get('current')).toMatchObject({
      id: 'current',
      widthPx: 251,
    })

    await waitFor(() =>
      expect(localStorage.getItem('laborer:sidebar-width')).toBe('437.25')
    )
  })

  it('shares Project rows and keys Workspace groups by Workspace ID', async () => {
    await deleteIfPresent(projectExpansionCollection, 'project-1')
    await deleteIfPresent(workspaceGroupExpansionCollection, 'workspace-1')
    localStorage.setItem(
      'laborer:project-collapse-state',
      '{"project-1":false}'
    )
    localStorage.setItem(
      'laborer:workspace-group-collapse-state',
      '{"project-1:feature":false}'
    )

    const project = renderHook(() => ({
      board: useProjectCollapseState(),
      sidebar: useProjectCollapseState(),
    }))
    const workspace = renderHook(() => useWorkspaceGroupCollapseState())

    expect(project.result.current.board.isExpanded('project-1')).toBe(true)
    expect(workspace.result.current.isExpanded('workspace-1')).toBe(true)

    act(() => project.result.current.sidebar.toggle('project-1'))
    await waitFor(() =>
      expect(project.result.current.board.isExpanded('project-1')).toBe(false)
    )
    expect(projectExpansionCollection.get('project-1')).toMatchObject({
      expanded: false,
      id: 'project-1',
    })

    act(() => project.result.current.board.toggle('project-1'))
    await waitFor(() =>
      expect(project.result.current.sidebar.isExpanded('project-1')).toBe(true)
    )

    act(() => workspace.result.current.toggle('workspace-1'))
    expect(workspaceGroupExpansionCollection.get('workspace-1')).toMatchObject({
      expanded: false,
      id: 'workspace-1',
    })
    expect(workspaceGroupExpansionCollection.has('project-1:feature')).toBe(
      false
    )

    expect(localStorage.getItem('laborer:project-collapse-state')).toBe(
      '{"project-1":false}'
    )
    expect(localStorage.getItem('laborer:workspace-group-collapse-state')).toBe(
      '{"project-1:feature":false}'
    )
  })
})
