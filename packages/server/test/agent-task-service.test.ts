import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { AgentTaskService } from '../src/services/agent-task-service.js'
import { LaborerDatabase } from '../src/services/laborer-database.js'
import { NativeLaborerDatabase } from '../src/services/native-laborer-database.js'
import { NodeTaskBoardDatabase } from '../src/services/node-task-board-database.js'

/**
 * Registers one more project against an existing fixture database, so a test
 * can exercise how a candidate is matched across several projects.
 */
const registerProject = (
  databasePath: string,
  input: {
    readonly id: string
    readonly name: string
    readonly shortName: string
  }
) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'laborer-agent-task-')))
  writeFileSync(
    join(root, 'laborer.json'),
    `${JSON.stringify({ shortName: input.shortName })}\n`
  )
  const database = NativeLaborerDatabase.connect(databasePath)
  database.insertProject({
    canonicalGitCommonDir: root,
    id: input.id,
    name: input.name,
    repoId: `repo-${input.id}`,
    rootPath: root,
  })
  database.close()
  return root
}

const fixture = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'laborer-agent-task-')))
  const databasePath = join(root, 'tasks.sqlite')
  writeFileSync(join(root, 'laborer.json'), '{"shortName":"AGT"}\n')
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
          identifier: 'AGT-1',
          taskNumber: 1,
          title: 'Follow up',
        })

        expect(yield* service.listTasks({ search: 'follow' })).toHaveLength(1)
        const updated = yield* service.updateTask({
          description: null,
          expectedRevision: created.revision,
          id: created.identifier,
          title: 'Refined follow-up',
        })
        expect(updated).toMatchObject({ description: null, revision: 2 })

        const deleted = yield* service.deleteTask(
          updated.identifier,
          updated.revision
        )
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

  it('resolves historical project aliases while exposing the current identifier', async () => {
    const { layer, root } = fixture()
    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* AgentTaskService
        const created = yield* service.createTask({
          path: root,
          title: 'Alias',
        })
        writeFileSync(
          join(root, 'laborer.json'),
          '{"shortName":"NEW","shortNameAliases":["AGT"]}\n'
        )

        expect(yield* service.getTask(created.identifier)).toMatchObject({
          id: created.id,
          identifier: 'NEW-1',
        })
        expect(yield* service.getTask('NEW-1')).toMatchObject({
          id: created.id,
        })
      }).pipe(Effect.provide(layer))
    )
  })

  it('rejects a readable identifier that matches duplicate nested-root numbers', async () => {
    const { databasePath, layer, root } = fixture()
    const database = NodeTaskBoardDatabase.open(databasePath)
    database.insert({
      id: 'root-task',
      rootPath: root,
      source: 'manual',
      status: 'todo',
      title: 'Root task',
    })
    database.insert({
      id: 'nested-task',
      rootPath: join(root, 'packages', 'nested'),
      source: 'manual',
      status: 'todo',
      title: 'Nested task',
    })
    database.close()

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* AgentTaskService
        return yield* Effect.flip(service.getTask('AGT-1'))
      }).pipe(Effect.provide(layer))
    )
    expect(error.code).toBe('AMBIGUOUS_IDENTIFIER')
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

        // An omitted revision means last-write-wins rather than a hard error.
        expect(
          (yield* service.setTaskLabels({
            id: task.id,
            labelIds: [label.id],
          })).labelIds
        ).toEqual([label.id])
      }).pipe(Effect.provide(layer))
    )
  })

  it('adds and removes labels without a revision, idempotently', async () => {
    const { layer, root } = fixture()
    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* AgentTaskService
        const first = yield* service.createLabel({ name: 'First' })
        const second = yield* service.createLabel({ name: 'Second' })
        const task = yield* service.createTask({ path: root, title: 'Labeled' })

        const added = yield* service.addTaskLabels({
          id: task.id,
          labelIds: [first.id],
        })
        expect(added.labelIds).toEqual([first.id])

        // Two agents each add their own id; neither erases the other's.
        const both = yield* service.addTaskLabels({
          id: task.id,
          labelIds: [second.id],
        })
        expect(both.labelIds).toEqual([first.id, second.id])

        const repeated = yield* service.addTaskLabels({
          id: task.id,
          labelIds: [first.id, second.id],
        })
        expect(repeated.labelIds).toEqual([first.id, second.id])
        // A no-op leaves the revision alone, so nobody else's CAS breaks.
        expect(repeated.revision).toBe(both.revision)

        const removed = yield* service.removeTaskLabels({
          id: task.id,
          labelIds: [first.id],
        })
        expect(removed.labelIds).toEqual([second.id])
        const removedAgain = yield* service.removeTaskLabels({
          id: task.id,
          labelIds: [first.id],
        })
        expect(removedAgain.labelIds).toEqual([second.id])
        expect(removedAgain.revision).toBe(removed.revision)

        expect(
          (yield* Effect.flip(
            service.addTaskLabels({
              id: task.id,
              labelIds: ['label-that-does-not-exist'],
            })
          )).code
        ).toBe('NOT_FOUND')
        expect(
          (yield* Effect.flip(
            service.addTaskLabels({
              id: 'task-that-does-not-exist',
              labelIds: [first.id],
            })
          )).code
        ).toBe('NOT_FOUND')
      }).pipe(Effect.provide(layer))
    )
  })

  it('creates a labeled task in one call and rolls back an unknown label id', async () => {
    const { layer, root } = fixture()
    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* AgentTaskService
        const first = yield* service.createLabel({ name: 'First' })
        const second = yield* service.createLabel({ name: 'Second' })

        const labeled = yield* service.createTask({
          labelIds: [first.id, second.id, first.id],
          path: root,
          title: 'Born labeled',
        })
        // The labels arrive with the row, so no follow-up write bumped it.
        expect(labeled).toMatchObject({
          identifier: 'AGT-1',
          labelIds: [first.id, second.id],
          revision: 1,
        })
        expect((yield* service.getTask(labeled.id)).labelIds).toEqual([
          first.id,
          second.id,
        ])

        // Omitting the ids still creates an ordinary unlabeled task.
        const plain = yield* service.createTask({ path: root, title: 'Plain' })
        expect(plain.labelIds).toEqual([])

        const unknown = yield* Effect.flip(
          service.createTask({
            labelIds: [first.id, 'label-that-does-not-exist'],
            path: root,
            title: 'Never staged',
          })
        )
        expect(unknown.code).toBe('NOT_FOUND')
        expect(unknown.message).toContain('Unknown labels')
        // Row and labels share one transaction, so the rejected call left no
        // half-created task behind for the agent to clean up.
        expect(
          (yield* service.listTasks({})).map(({ title }) => title)
        ).toEqual(['Born labeled', 'Plain'])
      }).pipe(Effect.provide(layer))
    )
  })

  it('updates and deletes without a revision, and still honours a stale one', async () => {
    const { layer, root } = fixture()
    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* AgentTaskService
        const task = yield* service.createTask({ path: root, title: 'Guarded' })

        const retitled = yield* service.updateTask({
          id: task.id,
          title: 'Retitled',
        })
        expect(retitled.title).toBe('Retitled')
        expect(
          (yield* Effect.flip(
            service.updateTask({
              expectedRevision: task.revision,
              id: task.id,
              title: 'Stale',
            })
          )).code
        ).toBe('CAS_CONFLICT')

        const label = yield* service.createLabel({ name: 'Loose' })
        const recolored = yield* service.updateLabel({
          color: 'teal',
          id: label.id,
        })
        expect(recolored.color).toBe('teal')
        expect(
          (yield* Effect.flip(
            service.updateLabel({
              expectedRevision: label.revision,
              id: label.id,
              name: 'Stale label',
            })
          )).code
        ).toBe('CAS_CONFLICT')
        expect((yield* service.deleteLabel(label.id)).id).toBe(label.id)

        expect((yield* service.deleteTask(task.id)).status).toBe('cancelled')
      }).pipe(Effect.provide(layer))
    )
  })

  it('resolves a project by name, short name, or path, case-insensitively', async () => {
    const { databasePath, layer, root } = fixture()
    const other = registerProject(databasePath, {
      id: 'project-2',
      name: 'Next',
      shortName: 'NXT',
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* AgentTaskService
        const byPath = yield* service.createTask({
          path: other,
          title: 'By path',
        })
        expect(byPath.rootPath).toBe(other)

        // The value list_projects leads with works verbatim, in any case.
        for (const candidate of ['Next', 'next', 'NEXT', '  next  ']) {
          expect(
            (yield* service.createTask({ path: candidate, title: candidate }))
              .rootPath
          ).toBe(other)
        }
        // As does the short name it reports alongside.
        for (const candidate of ['NXT', 'nxt']) {
          expect(
            (yield* service.createTask({ path: candidate, title: candidate }))
              .rootPath
          ).toBe(other)
        }

        expect(
          (yield* service.listTasks({ path: 'nxt' })).map(
            ({ rootPath }) => rootPath
          )
        ).toEqual(Array.from({ length: 7 }, () => other))
        expect(yield* service.listTasks({ path: 'Project' })).toEqual([])
        expect(
          (yield* service.createTask({ path: root, title: 'Home' })).rootPath
        ).toBe(root)
        expect(yield* service.listTasks({ path: 'AGT' })).toHaveLength(1)
      }).pipe(Effect.provide(layer))
    )
  })

  it('resolves a retired short name and prefers a project name over another project short name', async () => {
    const { databasePath, layer } = fixture()
    const named = registerProject(databasePath, {
      id: 'project-2',
      name: 'NXT',
      shortName: 'NAM',
    })
    const shortNamed = registerProject(databasePath, {
      id: 'project-3',
      name: 'Next',
      shortName: 'NXT',
    })
    const renamed = registerProject(databasePath, {
      id: 'project-4',
      name: 'Renamed',
      shortName: 'RNM',
    })
    writeFileSync(
      join(renamed, 'laborer.json'),
      '{"shortName":"RNM","shortNameAliases":["OLD"]}\n'
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* AgentTaskService
        // Name beats short name: tiers are tried in order, not merged.
        expect(
          (yield* service.createTask({ path: 'nxt', title: 'Named wins' }))
            .rootPath
        ).toBe(named)
        expect(
          (yield* service.createTask({ path: 'Next', title: 'Short named' }))
            .rootPath
        ).toBe(shortNamed)
        // A retired short name still resolves, after names and short names.
        expect(
          (yield* service.createTask({ path: 'old', title: 'Alias' })).rootPath
        ).toBe(renamed)
      }).pipe(Effect.provide(layer))
    )
  })

  it('refuses to guess between two projects answering to the same name', async () => {
    const { databasePath, layer } = fixture()
    const first = registerProject(databasePath, {
      id: 'project-2',
      name: 'Twin',
      shortName: 'TWA',
    })
    const second = registerProject(databasePath, {
      id: 'project-3',
      name: 'twin',
      shortName: 'TWB',
    })

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* AgentTaskService
        return yield* Effect.flip(
          service.createTask({ path: 'TWIN', title: 'Ambiguous' })
        )
      }).pipe(Effect.provide(layer))
    )
    expect(error.code).toBe('AMBIGUOUS_PROJECT')
    expect(error.message).toContain(first)
    expect(error.message).toContain(second)
  })

  it('names the accepted forms and the registered projects when nothing matches', async () => {
    const { layer, root } = fixture()
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* AgentTaskService
        return yield* Effect.flip(
          service.createTask({ path: 'nope', title: 'Orphan' })
        )
      }).pipe(Effect.provide(layer))
    )
    expect(error.code).toBe('UNKNOWN_PROJECT')
    expect(error.message).toContain('project name')
    expect(error.message).toContain('short name')
    expect(error.message).toContain(`Project (AGT) at ${root}`)
  })
})
