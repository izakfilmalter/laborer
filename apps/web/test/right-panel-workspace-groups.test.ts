/**
 * The workspace tab strip reads as project-then-workspaces: projects in
 * Laborer's durable order, workspaces in the window's layout order.
 */

import type { SharedProjectRow } from '@laborer/shared/rpc'
import { describe, expect, it } from 'vitest'
import { groupOpenWorkspacesByProject } from '@/components/right-panel/right-panel-workspace-groups'
import type { WorkspaceView } from '@/db/shared-state'

function project(
  id: string,
  overrides: Partial<SharedProjectRow> = {}
): SharedProjectRow {
  return {
    id,
    name: id,
    rootPath: `/repos/${id}`,
    createdAt: 0,
    ...overrides,
  } as SharedProjectRow
}

function workspace(id: string, projectId: string): WorkspaceView {
  return {
    branchName: id,
    id,
    projectId,
    worktreePath: `/repos/${projectId}/${id}`,
  } as WorkspaceView
}

describe('groupOpenWorkspacesByProject', () => {
  it('orders projects by their durable rank', () => {
    const groups = groupOpenWorkspacesByProject({
      openWorkspaceIds: ['b-1', 'a-1'],
      projects: [
        project('beta', { sortOrder: 2 }),
        project('alpha', { sortOrder: 1 }),
      ],
      workspaces: [workspace('b-1', 'beta'), workspace('a-1', 'alpha')],
    })

    expect(groups.map((group) => group.project.id)).toEqual(['alpha', 'beta'])
  })

  it('keeps layout order within a project', () => {
    const groups = groupOpenWorkspacesByProject({
      openWorkspaceIds: ['a-2', 'a-1', 'a-3'],
      projects: [project('alpha')],
      workspaces: [
        workspace('a-1', 'alpha'),
        workspace('a-2', 'alpha'),
        workspace('a-3', 'alpha'),
      ],
    })

    expect(groups[0]?.workspaces.map((entry) => entry.id)).toEqual([
      'a-2',
      'a-1',
      'a-3',
    ])
  })

  it('skips open ids whose workspace view is unknown', () => {
    const groups = groupOpenWorkspacesByProject({
      openWorkspaceIds: ['a-1', 'ghost'],
      projects: [project('alpha')],
      workspaces: [workspace('a-1', 'alpha')],
    })

    expect(groups).toHaveLength(1)
    expect(groups[0]?.workspaces.map((entry) => entry.id)).toEqual(['a-1'])
  })

  it('omits projects with no open workspace', () => {
    const groups = groupOpenWorkspacesByProject({
      openWorkspaceIds: ['a-1'],
      projects: [project('alpha'), project('beta')],
      workspaces: [workspace('a-1', 'alpha'), workspace('b-1', 'beta')],
    })

    expect(groups.map((group) => group.project.id)).toEqual(['alpha'])
  })
})
