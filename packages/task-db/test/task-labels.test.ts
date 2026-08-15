import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  NativeTaskDatabase,
  parseLabelIds,
  serializeLabelIds,
} from '@laborer/task-db'
import { afterEach, describe, expect, it } from 'vitest'

const directories: string[] = []
const temporaryDatabasePath = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'laborer-task-labels-'))
  directories.push(directory)
  return join(directory, 'laborer.sqlite')
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('task label ids', () => {
  it('defaults a newly inserted task to no labels', () => {
    const path = temporaryDatabasePath()
    const database = NativeTaskDatabase.open(path)
    const { task } = database.insert({
      id: 'task-1',
      rootPath: '/repo',
      source: 'manual',
      status: 'todo',
      title: 'Unlabeled',
    })
    expect(task.labelIds).toEqual([])
    database.close()
  })

  it('seeds the default FE, BE, and Full Stack labels on migration', () => {
    const path = temporaryDatabasePath()
    const database = NativeTaskDatabase.open(path)
    database.close()

    const raw = new DatabaseSync(path)
    const seeded = raw
      .prepare('SELECT name, color FROM labels ORDER BY name')
      .all()
    raw.close()

    expect(seeded).toEqual([
      { name: 'BE', color: 'violet' },
      { name: 'FE', color: 'blue' },
      { name: 'Full Stack', color: 'emerald' },
    ])
  })

  it('does not resurrect a deleted default label on reopen', () => {
    const path = temporaryDatabasePath()
    NativeTaskDatabase.open(path).close()

    const raw = new DatabaseSync(path)
    raw.prepare('DELETE FROM labels WHERE name = ?').run('FE')
    raw.close()

    NativeTaskDatabase.open(path).close()

    const reopened = new DatabaseSync(path)
    const names = reopened
      .prepare('SELECT name FROM labels ORDER BY name')
      .all()
      .map((row) => (row as { name: string }).name)
    reopened.close()

    expect(names).toEqual(['BE', 'Full Stack'])
  })

  it('round-trips stored label ids in application order', () => {
    const path = temporaryDatabasePath()
    const database = NativeTaskDatabase.open(path)
    database.insert({
      id: 'task-1',
      rootPath: '/repo',
      source: 'manual',
      status: 'todo',
      title: 'Labeled',
    })
    database.close()

    const raw = new DatabaseSync(path)
    raw
      .prepare('UPDATE tasks SET label_ids = ? WHERE id = ?')
      .run(serializeLabelIds(['bug', 'urgent']), 'task-1')
    raw.close()

    const reopened = NativeTaskDatabase.open(path)
    expect(reopened.find('task-1')?.labelIds).toEqual(['bug', 'urgent'])
    reopened.close()
  })

  it.each([
    ['not json at all', 'not-json'],
    ['a json object', '{"bug":true}'],
    ['an array of non-strings', '[1,2]'],
  ])('reads %s as no labels', (_description, stored) => {
    const path = temporaryDatabasePath()
    const database = NativeTaskDatabase.open(path)
    database.insert({
      id: 'task-1',
      rootPath: '/repo',
      source: 'manual',
      status: 'todo',
      title: 'Corrupted',
    })
    database.close()

    const raw = new DatabaseSync(path)
    raw
      .prepare('UPDATE tasks SET label_ids = ? WHERE id = ?')
      .run(stored, 'task-1')
    raw.close()

    const reopened = NativeTaskDatabase.open(path)
    expect(reopened.find('task-1')?.labelIds).toEqual([])
    reopened.close()
  })

  it('stores labels app-wide, without a root path and uniquely named', () => {
    const path = temporaryDatabasePath()
    NativeTaskDatabase.open(path).close()

    const raw = new DatabaseSync(path)
    const columns = raw
      .prepare('SELECT name FROM pragma_table_info(?)')
      .all('labels')
      .map((row) => (row as { name: string }).name)
    expect(columns).not.toContain('root_path')

    const insert = raw.prepare(
      `INSERT INTO labels (id, name, color, created_at, updated_at, revision)
       VALUES (?, ?, 'blue', 1, 1, 1)`
    )
    insert.run('label-1', 'Bug')
    expect(() => insert.run('label-2', 'bug')).toThrow()
    raw.close()
  })

  it('dedupes while preserving order when serializing', () => {
    expect(parseLabelIds(serializeLabelIds(['a', 'b', 'a']))).toEqual([
      'a',
      'b',
    ])
  })
})
