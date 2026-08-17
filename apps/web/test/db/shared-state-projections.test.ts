import type {
  SharedLabelRow,
  SharedProjectRow,
  SharedTaskRow,
} from '@laborer/shared/rpc'
import { describe, expect, it } from 'vitest'
import {
  labelsForIds,
  orderedLabelsFromRows,
  orderedProjectsFromRows,
  projectForRoot,
  taskCountsByLabel,
  workspaceViewsFromRows,
} from '../../src/db/shared-state'

const task = (id: string): SharedTaskRow => ({
  actionName: null,
  baseBranch: null,
  baseSha: null,
  branchName: null,
  createdAt: 1,
  description: null,
  executionId: null,
  executionStatus: null,
  id,
  labelIds: [],
  parentTaskId: null,
  prBaseBranch: null,
  prCheckStatus: null,
  prIsDraft: false,
  prMergeStatus: null,
  prNumber: null,
  prState: null,
  prTitle: null,
  prUrl: null,
  revision: 1,
  rootPath: '/repo',
  setupCompletedAt: null,
  slackPermalink: null,
  sortOrder: null,
  source: 'manual',
  status: 'todo',
  taskNumber: 1,
  title: id,
  updatedAt: 1,
  worktreeBotOwned: false,
  worktreeError: null,
  worktreeExists: false,
  worktreePath: null,
  worktreeStatus: null,
})

const project = (
  rootPath: string,
  id = 'project-one',
  sortOrder: number | null = null
): SharedProjectRow => ({
  branchName: null,
  canonicalGitCommonDir: `${rootPath}/.git`,
  createdAt: 1,
  id,
  name: id,
  repoId: `repo-${id}`,
  revision: 1,
  rootPath,
  sortOrder,
  updatedAt: 1,
})

const label = (id: string, name: string): SharedLabelRow => ({
  color: 'blue',
  createdAt: 1,
  id,
  name,
  revision: 1,
  updatedAt: 1,
})

describe('shared-record projections', () => {
  it('keeps canonical Project rows while applying presentation order', () => {
    const rows = [project('/later', 'later', 2), project('/first', 'first', 1)]
    expect(orderedProjectsFromRows(rows).map(({ id }) => id)).toEqual([
      'first',
      'later',
    ])
    expect(orderedProjectsFromRows(rows)[0]).not.toHaveProperty('repoPath')
  })

  it('resolves the closest registered Project root after re-registration', () => {
    const outer = project('/repo', 'outer')
    const nested = project('/repo/packages/app', 'new-project-id')
    expect(
      projectForRoot('/repo/packages/app/worktree', [outer, nested])?.id
    ).toBe('new-project-id')
    expect(projectForRoot('/repository', [outer, nested])).toBeUndefined()
  })

  it('orders and resolves Labels while omitting temporarily missing rows', () => {
    const rows = [label('b', 'Backend'), label('a', 'API')]
    expect(orderedLabelsFromRows(rows).map(({ id }) => id)).toEqual(['a', 'b'])
    expect(
      labelsForIds(['b', 'missing', 'a'], rows).map(({ id }) => id)
    ).toEqual(['b', 'a'])
  })

  it('counts Label usage across Tasks', () => {
    const tasks = [
      { ...task('one'), labelIds: ['a', 'b'] },
      { ...task('two'), labelIds: ['a'] },
    ]
    expect(taskCountsByLabel(tasks)).toEqual(
      new Map([
        ['a', 2],
        ['b', 1],
      ])
    )
  })
})

describe('workspaceViewsFromRows', () => {
  it('projects lifecycle and PR facts into stable Workspace views', () => {
    const row: SharedTaskRow = {
      ...task('child'),
      branchName: 'feat/child',
      parentTaskId: 'parent',
      prIsDraft: true,
      prNumber: 421,
      prState: 'open',
      prTitle: 'Stream workspaces',
      prUrl: 'https://github.com/example/repo/pull/421',
      source: 'worktree',
      worktreeError: 'setup failed',
      worktreePath: '/repo/.worktrees/child',
      worktreeStatus: 'errored',
    }

    expect(workspaceViewsFromRows([row], [project('/repo')])).toEqual([
      expect.objectContaining({ id: 'root-project-one' }),
      expect.objectContaining({
        branchName: 'feat/child',
        id: 'child',
        parentTaskId: 'parent',
        prState: 'OPEN',
        status: 'errored',
      }),
    ])
  })

  it('omits Tasks without worktrees or a currently related Project', () => {
    const unknownProject = {
      ...task('unknown'),
      rootPath: '/unknown',
      worktreePath: '/unknown/worktree',
      worktreeStatus: 'ready' as const,
    }
    expect(
      workspaceViewsFromRows([task('todo'), unknownProject], [project('/repo')])
    ).toEqual([expect.objectContaining({ id: 'root-project-one' })])
  })

  it('synthesizes the Project root Workspace first', () => {
    const row = {
      ...task('feature'),
      branchName: 'feat/one',
      worktreePath: '/repo/.worktrees/one',
      worktreeStatus: 'ready' as const,
    }
    const views = workspaceViewsFromRows([row], [project('/repo')])
    expect(views.map(({ id }) => id)).toEqual(['root-project-one', 'feature'])
    expect(views[0]?.worktreePath).toBe('/repo')
  })
})
