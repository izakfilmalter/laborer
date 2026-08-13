import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SharedStateUpdate } from '@laborer/shared/rpc'
import { Deferred, Effect, Fiber, Stream } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'
import { NativeLaborerDatabase } from '../src/services/native-laborer-database.js'
import { subscribeToSharedState } from '../src/services/shared-state-reader.js'

const directories: string[] = []
const databasePath = () => {
  const directory = mkdtempSync(join(tmpdir(), 'shared-state-reader-'))
  directories.push(directory)
  return join(directory, 'laborer.sqlite')
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

const collectAfterSnapshot = (
  path: string,
  count: number,
  action: () => void,
  pollIntervalMs = 10_000
): Promise<readonly SharedStateUpdate[]> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const fiber = yield* subscribeToSharedState(path, pollIntervalMs).pipe(
          Stream.tap(() => Deferred.succeed(started, undefined)),
          Stream.take(count),
          Stream.runCollect,
          Effect.forkScoped
        )
        yield* Deferred.await(started)
        yield* Effect.sync(action)
        return Array.from(yield* Fiber.join(fiber))
      })
    )
  )

describe('subscribeToSharedState', () => {
  it('emits own writes immediately with both cursors and mutation ids', async () => {
    const path = databasePath()
    const events = await collectAfterSnapshot(path, 5, () => {
      const writer = NativeLaborerDatabase.open(path)
      try {
        writer.insertTask(
          {
            id: 'task-1',
            rootPath: '/repo',
            source: 'manual',
            status: 'todo',
            title: 'Task',
          },
          'task-mutation'
        )
        writer.insertProject(
          {
            canonicalGitCommonDir: '/repo/.git',
            id: 'project-1',
            name: 'Repo',
            repoId: 'repo-1',
            rootPath: '/repo',
          },
          'project-mutation'
        )
        writer.insertSetting('github.token', 'secret', 'setting-mutation')
        writer.deleteTask('task-1', 1, 'delete-mutation')
      } finally {
        writer.close()
      }
    })

    expect(events[0]?.tasks?.type).toBe('snapshot')
    expect(events[0]?.projects?.cursor).toBe(0)
    expect(events[1]?.tasks).toMatchObject({
      cursor: 1,
      mutationIds: ['task-mutation'],
      type: 'delta',
    })
    expect(events[2]?.projects).toMatchObject({
      cursor: 1,
      mutationIds: ['project-mutation'],
      type: 'delta',
    })
    expect(events[3]?.settings).toMatchObject({
      cursor: 2,
      mutationIds: ['setting-mutation'],
      type: 'delta',
    })
    expect(events[4]?.tasks).toMatchObject({
      cursor: 2,
      deletedRowIds: ['task-1'],
      mutationIds: ['delete-mutation'],
      type: 'delta',
    })
  })

  it('polls writes that do not publish the process-local wakeup', async () => {
    const path = databasePath()
    NativeLaborerDatabase.open(path).close()
    const events = await collectAfterSnapshot(
      path,
      2,
      () => {
        const writer = new DatabaseSync(path)
        writer.exec(`BEGIN IMMEDIATE;
          INSERT INTO tasks (id, root_path, title, status, source, created_at, updated_at)
          VALUES ('external-task', '/repo', 'External', 'todo', 'manual', 1, 1);
          INSERT INTO task_changes (task_id, changed_at, mutation_id)
          VALUES ('external-task', 1, NULL);
          COMMIT;`)
        writer.close()
      },
      20
    )

    expect(events[1]?.tasks).toMatchObject({
      cursor: 1,
      rows: [expect.objectContaining({ id: 'external-task' })],
      type: 'delta',
    })
  })

  it('bounds queued deltas and recovers a stalled subscriber with a snapshot', async () => {
    const path = databasePath()
    const events = await collectAfterSnapshot(
      path,
      18,
      () => {
        const writer = NativeLaborerDatabase.open(path)
        try {
          for (let index = 1; index <= 20; index += 1) {
            writer.insertTask({
              id: `task-${String(index)}`,
              rootPath: '/repo',
              source: 'manual',
              status: 'todo',
              title: `Task ${String(index)}`,
            })
          }
        } finally {
          writer.close()
        }
      },
      20
    )

    expect(
      events.slice(1, 17).every((event) => event.tasks?.type === 'delta')
    ).toBe(true)
    expect(events[17]?.tasks).toMatchObject({
      cursor: 20,
      type: 'snapshot',
    })
    expect(events[17]?.tasks?.rows).toHaveLength(20)
  })

  it('falls back to a snapshot when a ledger cursor has been pruned', async () => {
    const path = databasePath()
    const seed = NativeLaborerDatabase.open(path)
    seed.insertTask({
      id: 'task-1',
      rootPath: '/repo',
      source: 'manual',
      status: 'todo',
      title: 'One',
    })
    seed.close()

    const events = await collectAfterSnapshot(
      path,
      2,
      () => {
        const writer = new DatabaseSync(path)
        writer.exec(`BEGIN IMMEDIATE;
          INSERT INTO tasks (id, root_path, title, status, source, created_at, updated_at)
          VALUES ('task-2', '/repo', 'Two', 'todo', 'manual', 2, 2);
          INSERT INTO task_changes (task_id, changed_at) VALUES ('task-2', 2);
          INSERT INTO tasks (id, root_path, title, status, source, created_at, updated_at)
          VALUES ('task-3', '/repo', 'Three', 'todo', 'manual', 3, 3);
          INSERT INTO task_changes (task_id, changed_at) VALUES ('task-3', 3);
          DELETE FROM task_changes WHERE sequence = 2;
          COMMIT;`)
        writer.close()
      },
      20
    )

    expect(events[1]?.tasks?.type).toBe('snapshot')
    expect(events[1]?.tasks?.cursor).toBe(3)
    expect(events[1]?.tasks?.rows.map(({ id }) => id).sort()).toEqual([
      'task-1',
      'task-2',
      'task-3',
    ])
  })

  it('snapshot-falls back when a ledger row cannot be decoded', async () => {
    const path = databasePath()
    NativeLaborerDatabase.open(path).close()
    const events = await collectAfterSnapshot(
      path,
      2,
      () => {
        const writer = new DatabaseSync(path)
        writer.exec(`INSERT INTO state_changes
          (table_name, row_id, changed_at, mutation_id)
          VALUES ('corrupt_table', 'row-1', 1, NULL)`)
        writer.close()
      },
      20
    )

    expect(events[1]?.projects).toMatchObject({ cursor: 1, type: 'snapshot' })
    expect(events[1]?.settings).toMatchObject({ cursor: 1, type: 'snapshot' })
  })

  it('starts every reconnect from a full authoritative snapshot', async () => {
    const path = databasePath()
    const writer = NativeLaborerDatabase.open(path)
    writer.insertSetting('theme', 'dark')
    writer.close()

    const readFirst = () =>
      Effect.runPromise(subscribeToSharedState(path, 20).pipe(Stream.runHead))
    const first = await readFirst()
    const reconnected = await readFirst()

    expect(first._tag).toBe('Some')
    expect(reconnected._tag).toBe('Some')
    if (first._tag === 'Some' && reconnected._tag === 'Some') {
      expect(first.value.settings?.type).toBe('snapshot')
      expect(reconnected.value.settings).toEqual(first.value.settings)
    }
  })
})
