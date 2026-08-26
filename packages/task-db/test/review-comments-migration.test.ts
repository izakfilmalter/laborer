import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { NativeTaskDatabase } from '@laborer/task-db'
import { afterEach, describe, expect, it } from 'vitest'

const directories: string[] = []
const temporaryDatabasePath = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'laborer-review-comments-'))
  directories.push(directory)
  return join(directory, 'laborer.sqlite')
}

const migratedDatabase = (): DatabaseSync => {
  const path = temporaryDatabasePath()
  NativeTaskDatabase.open(path).close()
  const raw = new DatabaseSync(path)
  raw.exec('PRAGMA foreign_keys = ON')
  return raw
}

const openThread = (raw: DatabaseSync, id: string): void => {
  raw
    .prepare(`INSERT INTO review_comment_threads (
      id, workspace_id, file_path, side, start_line, end_line, status,
      created_at, updated_at, revision
    ) VALUES (?, 'workspace-1', 'src/app.ts', 'additions', 3, 5, 'open', 1, 1, 1)`)
    .run(id)
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('review comment migration', () => {
  it('registers the migration in the append-only ledger', () => {
    const path = temporaryDatabasePath()
    const database = NativeTaskDatabase.open(path)
    expect(database.migrationNames().at(-1)).toBe('0016_review_comments')
    database.close()
  })

  it('indexes threads by workspace so a workspace read is not a scan', () => {
    const raw = migratedDatabase()
    const indexes = raw
      .prepare('SELECT name FROM pragma_index_list(?)')
      .all('review_comment_threads')
      .map((row) => (row as { name: string }).name)
    expect(indexes).toContain('review_comment_threads_workspace_id_idx')
    raw.close()
  })

  it('rejects a side, a status, or an inverted line range', () => {
    const raw = migratedDatabase()
    const insert = (
      side: string,
      status: string,
      startLine: number,
      endLine: number
    ) =>
      raw
        .prepare(`INSERT INTO review_comment_threads (
          id, workspace_id, file_path, side, start_line, end_line, status,
          created_at, updated_at, revision
        ) VALUES ('thread-x', 'workspace-1', 'src/app.ts', ?, ?, ?, ?, 1, 1, 1)`)
        .run(side, startLine, endLine, status)

    expect(() => insert('both', 'open', 1, 2)).toThrow()
    expect(() => insert('additions', 'pending', 1, 2)).toThrow()
    expect(() => insert('additions', 'open', 9, 2)).toThrow()
    expect(() => insert('additions', 'open', 0, 2)).toThrow()
    raw.close()
  })

  it('accepts only human and agent as a reply author', () => {
    const raw = migratedDatabase()
    openThread(raw, 'thread-1')
    const insert = raw.prepare(`INSERT INTO review_comment_replies (
      id, thread_id, author, body, created_at
    ) VALUES (?, 'thread-1', ?, 'Take another look', 1)`)

    insert.run('reply-1', 'human')
    insert.run('reply-2', 'agent')
    expect(() => insert.run('reply-3', 'reviewer')).toThrow()
    raw.close()
  })

  it('cascades replies away with the thread that held them', () => {
    const raw = migratedDatabase()
    openThread(raw, 'thread-1')
    raw
      .prepare(`INSERT INTO review_comment_replies (
        id, thread_id, author, body, created_at
      ) VALUES ('reply-1', 'thread-1', 'human', 'Take another look', 1)`)
      .run()

    raw
      .prepare('DELETE FROM review_comment_threads WHERE id = ?')
      .run('thread-1')
    expect(
      raw.prepare('SELECT COUNT(*) AS count FROM review_comment_replies').get()
    ).toEqual({ count: 0 })
    raw.close()
  })
})
