import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { NodeTaskBoardDatabase } from '../src/services/node-task-board-database.js'
import { translateWorktreesToTasks } from '../src/services/worktree-task-translator.js'

const databasePath = (): string =>
  join(mkdtempSync(join(tmpdir(), 'laborer-worktree-tasks-')), 'tasks.sqlite')

describe('translateWorktreesToTasks', () => {
  it('adopts unclaimed worktrees as in-progress tasks titled by branch', async () => {
    const path = databasePath()
    const adopted = await Effect.runPromise(
      translateWorktreesToTasks(
        {
          rootPath: '/repo',
          worktrees: [
            {
              branch: 'feature/one',
              canonicalPath: '/repo.worktrees/one',
              path: '/repo.worktrees/one',
            },
            {
              branch: null,
              canonicalPath: '/repo.worktrees/detached-head',
              path: '/repo.worktrees/detached-head',
            },
          ],
        },
        path
      )
    )

    expect(adopted).toBe(2)
    const database = NodeTaskBoardDatabase.open(path)
    const tasks = database.snapshot().tasks
    expect(tasks).toHaveLength(2)
    expect(tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          branchName: 'feature/one',
          rootPath: '/repo',
          source: 'worktree',
          status: 'in_progress',
          title: 'feature/one',
          worktreePath: '/repo.worktrees/one',
        }),
        expect.objectContaining({
          branchName: null,
          source: 'worktree',
          title: 'detached-head',
          worktreePath: '/repo.worktrees/detached-head',
        }),
      ])
    )
    database.close()
  })

  it('does not duplicate cards across repeated passes', async () => {
    const path = databasePath()
    const worktrees = {
      rootPath: '/repo',
      worktrees: [
        {
          branch: 'feature/one',
          canonicalPath: '/repo.worktrees/one',
          path: '/repo.worktrees/one',
        },
      ],
    }

    const first = await Effect.runPromise(
      translateWorktreesToTasks(worktrees, path)
    )
    const second = await Effect.runPromise(
      translateWorktreesToTasks(worktrees, path)
    )

    expect(first).toBe(1)
    expect(second).toBe(0)
    const database = NodeTaskBoardDatabase.open(path)
    expect(database.snapshot().tasks).toHaveLength(1)
    database.close()
  })

  it('skips worktrees already claimed by existing task rows', async () => {
    const path = databasePath()
    const database = NodeTaskBoardDatabase.open(path)
    database.insert({
      id: 'execution-card',
      executionId: 'exec-1',
      rootPath: '/repo',
      source: 'execution',
      status: 'in_progress',
      title: 'Queued execution',
      branchName: 'laborer/queued',
      worktreePath: '/repo.worktrees/queued',
    })
    database.close()

    const adopted = await Effect.runPromise(
      translateWorktreesToTasks(
        {
          rootPath: '/repo',
          worktrees: [
            {
              branch: 'laborer/queued',
              canonicalPath: '/repo.worktrees/queued',
              path: '/repo.worktrees/queued',
            },
          ],
        },
        path
      )
    )

    expect(adopted).toBe(0)
  })

  it('reports zero adoptions instead of failing on database trouble', async () => {
    const adopted = await Effect.runPromise(
      translateWorktreesToTasks(
        {
          rootPath: '/repo',
          worktrees: [
            {
              branch: 'feature/one',
              canonicalPath: '/repo.worktrees/one',
              path: '/repo.worktrees/one',
            },
          ],
        },
        '/dev/null/not-a-directory/tasks.sqlite'
      )
    )

    expect(adopted).toBe(0)
  })
})
