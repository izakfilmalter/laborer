import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { AgentTaskService } from '../src/services/agent-task-service.js'
import { LaborerDatabase } from '../src/services/laborer-database.js'
import { NativeLaborerDatabase } from '../src/services/native-laborer-database.js'
import { NodeTaskBoardDatabase } from '../src/services/node-task-board-database.js'

const fixture = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'laborer-agent-task-')))
  const databasePath = join(root, 'tasks.sqlite')
  const project = { id: 'project-1', name: 'Project', repoPath: root }
  const database = NativeLaborerDatabase.connect(databasePath)
  database.initialize()
  database.insertProject({
    canonicalGitCommonDir: root,
    id: project.id,
    name: project.name,
    repoId: 'repo-1',
    rootPath: project.repoPath,
  })
  database.close()
  const layer = AgentTaskService.layer(databasePath).pipe(
    Layer.provide(LaborerDatabase.layer(databasePath).pipe(Layer.orDie))
  )
  return { databasePath, layer, root }
}

describe('AgentTaskService', () => {
  it('resolves an external Git worktree to its registered project', async () => {
    const { layer, root } = fixture()
    const worktree = `${root}-linked`
    execFileSync('git', ['init', '--initial-branch=main'], { cwd: root })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: root,
    })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root })
    execFileSync('git', ['commit', '--allow-empty', '-m', 'initial'], {
      cwd: root,
    })
    execFileSync('git', ['worktree', 'add', '-b', 'feature/linked', worktree], {
      cwd: root,
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* AgentTaskService
        const created = yield* service.createTask({
          path: worktree,
          title: 'From linked worktree',
        })
        expect(created.rootPath).toBe(root)
        expect(yield* service.listTasks({ path: worktree })).toEqual([created])
      }).pipe(Effect.provide(layer))
    )
  })

  it('creates, filters, updates, and soft-deletes agent tasks with ledger writes', async () => {
    const { databasePath, layer, root } = fixture()
    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* AgentTaskService
        const created = yield* service.createTask({
          description: 'Investigate the failure',
          path: root,
          title: '  Follow up  ',
        })
        expect(created).toMatchObject({
          description: 'Investigate the failure',
          revision: 1,
          rootPath: root,
          source: 'agent',
          status: 'todo',
          title: 'Follow up',
        })

        expect(yield* service.listTasks({ search: 'follow' })).toHaveLength(1)
        const updated = yield* service.updateTask({
          description: null,
          expectedRevision: created.revision,
          id: created.id,
          title: 'Refined follow-up',
        })
        expect(updated).toMatchObject({ description: null, revision: 2 })

        const deleted = yield* service.deleteTask(updated.id, updated.revision)
        expect(deleted.status).toBe('cancelled')
        const staleDelete = yield* Effect.flip(
          service.deleteTask(updated.id, updated.revision)
        )
        expect(staleDelete).toMatchObject({ code: 'CAS_CONFLICT' })
        expect(staleDelete.message).toContain('Refetch the task and retry')
        expect(yield* service.listTasks({})).toEqual([])
        expect(
          yield* service.listTasks({ includeCancelled: true })
        ).toHaveLength(1)
      }).pipe(Effect.provide(layer))
    )

    const database = NodeTaskBoardDatabase.open(databasePath)
    expect(database.readChanges(0).cursor).toBe(3)
    database.close()
  })

  it('rejects unknown projects, stale revisions, and Execution updates', async () => {
    const { databasePath, layer, root } = fixture()
    const database = NodeTaskBoardDatabase.open(databasePath)
    database.insert({
      executionId: 'execution-1',
      id: 'execution-task',
      rootPath: root,
      source: 'execution',
      status: 'in_progress',
      title: 'Execution task',
    })
    database.close()

    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* AgentTaskService
        const locked = yield* Effect.flip(
          service.updateTask({
            expectedRevision: 1,
            id: 'execution-task',
            title: 'Nope',
          })
        )
        expect(locked.code).toBe('LOCKED_TASK')

        expect(yield* service.deleteTask('execution-task', 1)).toMatchObject({
          revision: 2,
          status: 'cancelled',
        })

        const missing = yield* Effect.flip(
          service.createTask({
            path: join(root, 'path-that-does-not-exist'),
            title: 'Orphan',
          })
        )
        expect(missing.code).toBe('UNKNOWN_PROJECT')

        const created = yield* service.createTask({ path: root, title: 'Race' })
        const first = yield* service.updateTask({
          expectedRevision: created.revision,
          id: created.id,
          title: 'Winner',
        })
        expect(first.revision).toBe(2)
        const stale = yield* Effect.flip(
          service.deleteTask(created.id, created.revision)
        )
        expect(stale.code).toBe('CAS_CONFLICT')
      }).pipe(Effect.provide(layer))
    )
  })

  it('creates, lists, renames, and deletes app-wide labels', async () => {
    const { layer } = fixture()
    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* AgentTaskService
        const created = yield* service.createLabel({ name: '  Bug  ' })
        expect(created).toMatchObject({ name: 'Bug', revision: 1 })
        expect(created).not.toHaveProperty('rootPath')
        // Migration 0011 seeds FE, BE, and Full Stack into every database.
        const listed = yield* service.listLabels()
        expect(listed).toContainEqual(created)
        expect(listed.map(({ name }) => name).sort()).toEqual([
          'BE',
          'Bug',
          'FE',
          'Full Stack',
        ])

        const conflict = yield* Effect.flip(
          service.createLabel({ name: 'bug' })
        )
        expect(conflict.code).toBe('NAME_CONFLICT')

        const blank = yield* Effect.flip(service.createLabel({ name: '   ' }))
        expect(blank.code).toBe('INVALID_INPUT')

        const renamed = yield* service.updateLabel({
          color: 'teal',
          expectedRevision: created.revision,
          id: created.id,
          name: 'Defect',
        })
        expect(renamed).toMatchObject({
          color: 'teal',
          name: 'Defect',
          revision: 2,
        })

        const stale = yield* Effect.flip(
          service.updateLabel({
            expectedRevision: created.revision,
            id: created.id,
            name: 'Late',
          })
        )
        expect(stale.code).toBe('CAS_CONFLICT')

        const missing = yield* Effect.flip(
          service.deleteLabel('label-that-does-not-exist', 1)
        )
        expect(missing.code).toBe('NOT_FOUND')

        expect(
          yield* service.deleteLabel(renamed.id, renamed.revision)
        ).toMatchObject({ id: created.id })
        expect((yield* service.listLabels()).map(({ name }) => name)).toEqual([
          'BE',
          'FE',
          'Full Stack',
        ])
      }).pipe(Effect.provide(layer))
    )
  })

  it('replaces a task label set and rejects unknown label ids', async () => {
    const { layer, root } = fixture()
    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* AgentTaskService
        const label = yield* service.createLabel({ name: 'Bug' })
        const task = yield* service.createTask({ path: root, title: 'Labeled' })

        const labeled = yield* service.setTaskLabels({
          expectedRevision: task.revision,
          id: task.id,
          labelIds: [label.id],
        })
        expect(labeled.labelIds).toEqual([label.id])
        expect(labeled.revision).toBe(2)

        const unknownLabel = yield* Effect.flip(
          service.setTaskLabels({
            expectedRevision: labeled.revision,
            id: task.id,
            labelIds: ['label-that-does-not-exist'],
          })
        )
        expect(unknownLabel.code).toBe('NOT_FOUND')

        const unknownTask = yield* Effect.flip(
          service.setTaskLabels({
            expectedRevision: 1,
            id: 'task-that-does-not-exist',
            labelIds: [],
          })
        )
        expect(unknownTask.code).toBe('NOT_FOUND')

        const staleTask = yield* Effect.flip(
          service.setTaskLabels({
            expectedRevision: task.revision,
            id: task.id,
            labelIds: [],
          })
        )
        expect(staleTask.code).toBe('CAS_CONFLICT')

        expect(
          (yield* service.setTaskLabels({
            expectedRevision: labeled.revision,
            id: task.id,
            labelIds: [],
          })).labelIds
        ).toEqual([])
      }).pipe(Effect.provide(layer))
    )
  })
})
