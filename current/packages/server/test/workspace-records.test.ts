import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { LaborerDatabase } from '../src/services/laborer-database.js'
import {
  findWorkspaceRecord,
  listWorkspaceRecords,
} from '../src/services/workspace-records.js'

describe('task-backed workspace records', () => {
  it('projects only tasks that currently own a worktree', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { database } = yield* LaborerDatabase
        database.insertProject({
          canonicalGitCommonDir: '/repo/.git',
          id: 'project-1',
          name: 'Repo',
          repoId: 'repo-1',
          rootPath: '/repo',
        })
        database.insertProject({
          canonicalGitCommonDir: '/repo/packages/nested/.git',
          id: 'project-nested',
          name: 'Nested',
          repoId: 'repo-nested',
          rootPath: '/repo/packages/nested',
        })
        database.insertTask({
          branchName: 'feature/shared-db',
          id: 'task-worktree',
          rootPath: '/repo',
          source: 'manual',
          status: 'in_progress',
          title: 'Shared DB',
          worktreePath: '/repo-worktree',
          worktreeStatus: 'ready',
        })
        database.insertTask({
          branchName: 'feature/nested',
          id: 'task-nested',
          rootPath: '/repo/packages/nested/app',
          source: 'manual',
          status: 'in_progress',
          title: 'Nested task',
          worktreePath: '/repo-nested-worktree',
          worktreeStatus: 'ready',
        })
        database.insertTask({
          branchName: null,
          id: 'task-detached-worktree',
          rootPath: '/repo',
          source: 'worktree',
          status: 'in_progress',
          title: 'detached-abc123',
          worktreePath: '/repo-detached-worktree',
          worktreeStatus: 'ready',
        })
        database.insertTask({
          id: 'task-todo',
          rootPath: '/repo',
          source: 'manual',
          status: 'todo',
          title: 'Todo',
        })

        expect(listWorkspaceRecords(database)).toHaveLength(3)
        expect(findWorkspaceRecord(database, 'task-worktree')).toMatchObject({
          branchName: 'feature/shared-db',
          id: 'task-worktree',
          projectId: 'project-1',
          status: 'running',
          worktreePath: '/repo-worktree',
        })
        expect(findWorkspaceRecord(database, 'task-todo')).toBeNull()
        expect(findWorkspaceRecord(database, 'task-nested')).toMatchObject({
          id: 'task-nested',
          projectId: 'project-nested',
        })
        expect(
          findWorkspaceRecord(database, 'task-detached-worktree')
        ).toMatchObject({
          branchName: 'detached-abc123',
          id: 'task-detached-worktree',
          worktreePath: '/repo-detached-worktree',
        })
      }).pipe(Effect.provide(LaborerDatabase.testLayer().pipe(Layer.orDie)))
    )
  })
})
