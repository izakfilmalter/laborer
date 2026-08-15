import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { labelColorForName } from '@laborer/shared/labels'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LaborerDatabaseLabelNameConflictError,
  LaborerDatabaseStaleRevisionError,
  LaborerDatabaseUnknownLabelError,
  NativeLaborerDatabase,
} from '../src/services/native-laborer-database.js'

const BLANK_NAME_MESSAGE = /must not be blank/
const directories: string[] = []
const databasePath = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'laborer-labels-db-'))
  directories.push(directory)
  return join(directory, 'laborer.sqlite')
}

const openDatabase = (): NativeLaborerDatabase =>
  NativeLaborerDatabase.open(databasePath())

/**
 * Migration 0011 seeds FE, BE, and Full Stack into every new database, so these
 * cases assert against the labels the test itself authored.
 */
const DEFAULT_LABEL_NAMES = new Set(['BE', 'FE', 'Full Stack'])
const authored = <Row extends { readonly name: string }>(
  labels: readonly Row[]
): readonly Row[] =>
  labels.filter((label) => !DEFAULT_LABEL_NAMES.has(label.name))

const insertTask = (database: NativeLaborerDatabase, id: string) =>
  database.insertTask({
    id,
    rootPath: '/repo',
    source: 'manual',
    status: 'todo',
    title: `Task ${id}`,
  }).row

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('label persistence', () => {
  it('derives an omitted color from the trimmed name', () => {
    const database = openDatabase()
    const { row } = database.createLabel({ name: '  Bug  ' })
    expect(row).toMatchObject({
      color: labelColorForName('bug'),
      name: 'Bug',
      revision: 1,
    })
    database.close()
  })

  it('treats a repeated id as an idempotent no-op', () => {
    const database = openDatabase()
    const first = database.createLabel({
      color: 'teal',
      id: 'label-1',
      name: 'Bug',
    })
    const replay = database.createLabel({
      color: 'pink',
      id: 'label-1',
      name: 'Something else',
    })
    expect(replay.row).toEqual(first.row)
    expect(authored(database.listLabels())).toHaveLength(1)
    database.close()
  })

  it('rejects a case-insensitive name collision app-wide', () => {
    const database = openDatabase()
    database.createLabel({ id: 'label-1', name: 'Bug' })
    expect(() => database.createLabel({ id: 'label-2', name: 'bug' })).toThrow(
      LaborerDatabaseLabelNameConflictError
    )
    expect(authored(database.listLabels())).toHaveLength(1)
    database.close()
  })

  it('rejects a rename onto another label name app-wide', () => {
    const database = openDatabase()
    database.createLabel({ id: 'label-1', name: 'Bug' })
    const chore = database.createLabel({ id: 'label-2', name: 'Chore' })
    expect(() =>
      database.updateLabel('label-2', chore.row.revision, { name: 'BUG' })
    ).toThrow(LaborerDatabaseLabelNameConflictError)
    database.close()
  })

  it('rejects a blank name', () => {
    const database = openDatabase()
    expect(() => database.createLabel({ name: '   ' })).toThrow(
      BLANK_NAME_MESSAGE
    )
    database.close()
  })

  it('renames under revision CAS and rejects a stale revision', () => {
    const database = openDatabase()
    const created = database.createLabel({
      id: 'label-1',
      name: 'Bug',
    })
    const updated = database.updateLabel('label-1', created.row.revision, {
      color: 'violet',
      name: 'Defect',
    })
    expect(updated.row).toMatchObject({
      color: 'violet',
      name: 'Defect',
      revision: 2,
    })
    expect(() =>
      database.updateLabel('label-1', created.row.revision, { name: 'Again' })
    ).toThrow(LaborerDatabaseStaleRevisionError)
    database.close()
  })

  it('appends label writes to the state ledger', () => {
    const database = openDatabase()
    const { cursor } = database.createLabel({
      id: 'label-1',
      name: 'Bug',
    })
    const changes = database.stateChangesAfter(cursor - 1)
    expect(changes.at(0)).toMatchObject({
      rowId: 'label-1',
      tableName: 'labels',
    })
    expect(authored(database.snapshot().labels)).toHaveLength(1)
    expect(
      authored(database.stateUpdatesAfter(cursor - 1)?.labels.rows ?? [])
    ).toHaveLength(1)
    database.close()
  })

  it('hard-deletes a label and strips it from every task', () => {
    const database = openDatabase()
    database.createLabel({ id: 'label-1', name: 'Bug' })
    database.createLabel({ id: 'label-2', name: 'Chore' })
    const task = insertTask(database, 'task-1')
    const other = insertTask(database, 'task-2')
    database.setTaskLabels(task.id, task.revision, ['label-1', 'label-2'])
    database.setTaskLabels(other.id, other.revision, ['label-2'])

    const labelled = database.findTask('task-1')
    const deleted = database.deleteLabel('label-1', 1)

    expect(deleted.row.id).toBe('label-1')
    expect(database.findLabel('label-1')).toBeNull()
    expect(database.findTask('task-1')?.labelIds).toEqual(['label-2'])
    expect(database.findTask('task-2')?.labelIds).toEqual(['label-2'])
    // The touched task advances so subscribers re-render it.
    expect(database.findTask('task-1')?.revision).toBe(
      (labelled?.revision ?? 0) + 1
    )
    expect(
      database.taskChangesAfter(0).filter(({ taskId }) => taskId === 'task-1')
    ).toHaveLength(3)
    database.close()
  })

  it('leaves untouched tasks alone when a label is deleted', () => {
    const database = openDatabase()
    database.createLabel({ id: 'label-1', name: 'Bug' })
    const task = insertTask(database, 'task-1')
    database.deleteLabel('label-1', 1)
    expect(database.findTask('task-1')?.revision).toBe(task.revision)
    database.close()
  })
})

describe('setTaskLabels', () => {
  it('dedupes while preserving order', () => {
    const database = openDatabase()
    database.createLabel({ id: 'label-1', name: 'Bug' })
    database.createLabel({ id: 'label-2', name: 'Chore' })
    const task = insertTask(database, 'task-1')
    const { row } = database.setTaskLabels(task.id, task.revision, [
      'label-2',
      'label-1',
      'label-2',
    ])
    expect(row.labelIds).toEqual(['label-2', 'label-1'])
    expect(row.revision).toBe(task.revision + 1)
    database.close()
  })

  it('fails a stale revision without writing', () => {
    const database = openDatabase()
    database.createLabel({ id: 'label-1', name: 'Bug' })
    const task = insertTask(database, 'task-1')
    database.setTaskLabels(task.id, task.revision, ['label-1'])
    expect(() => database.setTaskLabels(task.id, task.revision, [])).toThrow(
      LaborerDatabaseStaleRevisionError
    )
    expect(database.findTask('task-1')?.labelIds).toEqual(['label-1'])
    database.close()
  })

  it('rejects ids that name no stored label', () => {
    const database = openDatabase()
    const task = insertTask(database, 'task-1')
    expect(() =>
      database.setTaskLabels(task.id, task.revision, ['missing-label'])
    ).toThrow(LaborerDatabaseUnknownLabelError)
    expect(database.findTask('task-1')?.labelIds).toEqual([])
    database.close()
  })

  it('applies one label to tasks in different project root paths', () => {
    const database = openDatabase()
    database.createLabel({ id: 'label-1', name: 'Bug' })
    const here = insertTask(database, 'task-1')
    const elsewhere = database.insertTask({
      id: 'task-2',
      rootPath: '/other-repo',
      source: 'manual',
      status: 'todo',
      title: 'Task in another project',
    }).row

    database.setTaskLabels(here.id, here.revision, ['label-1'])
    database.setTaskLabels(elsewhere.id, elsewhere.revision, ['label-1'])

    expect(database.findTask('task-1')?.labelIds).toEqual(['label-1'])
    expect(database.findTask('task-2')?.labelIds).toEqual(['label-1'])
    database.close()
  })

  it('appends the task ledger row so subscribers see the write', () => {
    const database = openDatabase()
    database.createLabel({ id: 'label-1', name: 'Bug' })
    const task = insertTask(database, 'task-1')
    const { cursor } = database.setTaskLabels(
      task.id,
      task.revision,
      ['label-1'],
      'mutation-1'
    )
    expect(database.taskUpdateAfter(cursor - 1)).toMatchObject({
      mutationIds: ['mutation-1'],
    })
    database.close()
  })

  it('defaults a task with a corrupted label_ids column to no labels', () => {
    const path = databasePath()
    const database = NativeLaborerDatabase.open(path)
    insertTask(database, 'task-1')
    database.close()

    const raw = new DatabaseSync(path)
    raw
      .prepare('UPDATE tasks SET label_ids = ? WHERE id = ?')
      .run('{"not":"an array"}', 'task-1')
    raw.close()

    const reopened = NativeLaborerDatabase.open(path)
    expect(reopened.findTask('task-1')?.labelIds).toEqual([])
    reopened.close()
  })
})
