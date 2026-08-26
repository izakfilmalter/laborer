import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LaborerDatabaseStaleRevisionError,
  NativeLaborerDatabase,
} from '../src/services/native-laborer-database.js'
import {
  AGENT_AUTHOR,
  HUMAN_AUTHOR,
  ReviewCommentAuthorMismatchError,
  ReviewCommentInvalidError,
  ReviewCommentNotFoundError,
  ReviewCommentRowError,
} from '../src/services/review-comments.js'

const directories: string[] = []
const databasePath = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'laborer-review-comments-db-'))
  directories.push(directory)
  return join(directory, 'laborer.sqlite')
}

const openDatabase = (path = databasePath()): NativeLaborerDatabase =>
  NativeLaborerDatabase.open(path)

const draft = {
  body: '  Rename this to something honest  ',
  endLine: 12,
  filePath: 'src/app.ts',
  side: 'additions',
  startLine: 10,
  workspaceId: 'workspace-1',
} as const

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('review comment persistence', () => {
  it('opens a thread together with the message that opened it', () => {
    const database = openDatabase()
    const { row: thread } = database.createReviewCommentThread(
      draft,
      HUMAN_AUTHOR
    )
    expect(thread).toMatchObject({
      endLine: 12,
      filePath: 'src/app.ts',
      revision: 1,
      side: 'additions',
      startLine: 10,
      status: 'open',
      workspaceId: 'workspace-1',
    })
    expect(thread.replies).toHaveLength(1)
    expect(thread.replies[0]).toMatchObject({
      author: 'human',
      body: 'Rename this to something honest',
      threadId: thread.id,
    })
    database.close()
  })

  it('records the author of the boundary that wrote each reply', () => {
    const database = openDatabase()
    const { row: opened } = database.createReviewCommentThread(
      draft,
      HUMAN_AUTHOR
    )
    const { row: answered } = database.appendReviewCommentReply(
      { body: 'Renamed it to `pendingReplies`', threadId: opened.id },
      AGENT_AUTHOR
    )
    expect(answered.replies.map(({ author }) => author)).toEqual([
      'human',
      'agent',
    ])
    database.close()
  })

  it('keeps an answer after the message it answers within one millisecond', () => {
    const database = openDatabase()
    const { row: opened } = database.createReviewCommentThread(
      { ...draft, id: 'thread-1' },
      HUMAN_AUTHOR,
      null,
      1000
    )
    for (const body of ['First answer', 'Second answer', 'Third answer']) {
      database.appendReviewCommentReply(
        { body, threadId: opened.id },
        AGENT_AUTHOR,
        null,
        1000
      )
    }
    expect(
      database
        .findReviewCommentThread('thread-1')
        ?.replies.map(({ body }) => body)
    ).toEqual([
      'Rename this to something honest',
      'First answer',
      'Second answer',
      'Third answer',
    ])
    database.close()
  })

  it('orders replies by time, then id, so one millisecond is still stable', () => {
    const database = openDatabase()
    const { row: opened } = database.createReviewCommentThread(
      { ...draft, id: 'thread-1', replyId: 'reply-b' },
      HUMAN_AUTHOR,
      null,
      1000
    )
    database.appendReviewCommentReply(
      { body: 'Second', createdAt: 1000, id: 'reply-a', threadId: opened.id },
      AGENT_AUTHOR
    )
    database.appendReviewCommentReply(
      { body: 'Third', createdAt: 999, id: 'reply-c', threadId: opened.id },
      HUMAN_AUTHOR
    )

    const thread = database.findReviewCommentThread('thread-1')
    expect(thread?.replies.map(({ id }) => id)).toEqual([
      'reply-c',
      'reply-a',
      'reply-b',
    ])
    database.close()
  })

  it('leaves the thread revision alone when a reply lands', () => {
    const database = openDatabase()
    const { row: opened } = database.createReviewCommentThread(
      draft,
      HUMAN_AUTHOR
    )
    const { row: answered } = database.appendReviewCommentReply(
      { body: 'Done', threadId: opened.id },
      AGENT_AUTHOR
    )
    expect(answered.revision).toBe(opened.revision)

    // The revision the human read before the agent answered still resolves.
    const { row: resolved } = database.setReviewCommentThreadStatus(
      opened.id,
      opened.revision,
      'resolved'
    )
    expect(resolved).toMatchObject({ revision: 2, status: 'resolved' })
    database.close()
  })

  it('treats a repeated thread or reply id as an idempotent no-op', () => {
    const database = openDatabase()
    const { row: first } = database.createReviewCommentThread(
      { ...draft, id: 'thread-1', replyId: 'reply-1' },
      HUMAN_AUTHOR
    )
    const { row: replay } = database.createReviewCommentThread(
      { ...draft, body: 'Something else', id: 'thread-1' },
      HUMAN_AUTHOR
    )
    expect(replay).toEqual(first)

    const { row: answered } = database.appendReviewCommentReply(
      { body: 'On it', id: 'reply-2', threadId: 'thread-1' },
      AGENT_AUTHOR
    )
    const { row: replayed } = database.appendReviewCommentReply(
      { body: 'On it', id: 'reply-2', threadId: 'thread-1' },
      AGENT_AUTHOR
    )
    expect(replayed).toEqual(answered)
    expect(replayed.replies).toHaveLength(2)
    database.close()
  })

  it('lists a workspace, hiding resolved threads unless asked', () => {
    const database = openDatabase()
    const { row: mine } = database.createReviewCommentThread(
      { ...draft, id: 'thread-1' },
      HUMAN_AUTHOR,
      null,
      1000
    )
    database.createReviewCommentThread(
      { ...draft, id: 'thread-2' },
      HUMAN_AUTHOR,
      null,
      2000
    )
    database.createReviewCommentThread(
      { ...draft, id: 'thread-3', workspaceId: 'workspace-2' },
      HUMAN_AUTHOR
    )
    database.setReviewCommentThreadStatus(mine.id, mine.revision, 'resolved')

    expect(
      database.listReviewCommentThreads('workspace-1').map(({ id }) => id)
    ).toEqual(['thread-2'])
    expect(
      database
        .listReviewCommentThreads('workspace-1', { includeResolved: true })
        .map(({ id }) => id)
    ).toEqual(['thread-1', 'thread-2'])
    database.close()
  })

  it('lets a boundary edit only its own words', () => {
    const database = openDatabase()
    const { row: opened } = database.createReviewCommentThread(
      draft,
      HUMAN_AUTHOR
    )
    const { row: answered } = database.appendReviewCommentReply(
      { body: 'Renamed it', threadId: opened.id },
      AGENT_AUTHOR
    )
    const agentReply = answered.replies.find(({ author }) => author === 'agent')
    const humanReply = answered.replies.find(({ author }) => author === 'human')

    expect(() =>
      database.updateReviewCommentReply(
        agentReply?.id ?? '',
        'Actually you did not',
        HUMAN_AUTHOR
      )
    ).toThrow(ReviewCommentAuthorMismatchError)

    const { row: edited } = database.updateReviewCommentReply(
      humanReply?.id ?? '',
      'Rename this, please',
      HUMAN_AUTHOR
    )
    expect(edited.replies.find(({ author }) => author === 'human')?.body).toBe(
      'Rename this, please'
    )
    database.close()
  })

  it('guards status and delete with revision CAS', () => {
    const database = openDatabase()
    const { row: opened } = database.createReviewCommentThread(
      draft,
      HUMAN_AUTHOR
    )
    expect(() =>
      database.setReviewCommentThreadStatus(opened.id, 99, 'resolved')
    ).toThrow(LaborerDatabaseStaleRevisionError)
    expect(() => database.deleteReviewCommentThread(opened.id, 99)).toThrow(
      LaborerDatabaseStaleRevisionError
    )

    const { row: deleted } = database.deleteReviewCommentThread(
      opened.id,
      opened.revision
    )
    expect(deleted.id).toBe(opened.id)
    expect(database.findReviewCommentThread(opened.id)).toBeNull()
    database.close()
  })

  it('rejects a blank body, an inverted anchor, and an unknown thread', () => {
    const database = openDatabase()
    expect(() =>
      database.createReviewCommentThread(
        { ...draft, body: '   ' },
        HUMAN_AUTHOR
      )
    ).toThrow(ReviewCommentInvalidError)
    expect(() =>
      database.createReviewCommentThread(
        { ...draft, endLine: 2, startLine: 9 },
        HUMAN_AUTHOR
      )
    ).toThrow(ReviewCommentInvalidError)
    expect(() =>
      database.appendReviewCommentReply(
        { body: 'Hello?', threadId: 'thread-missing' },
        AGENT_AUTHOR
      )
    ).toThrow(ReviewCommentNotFoundError)
    database.close()
  })

  it('fails the read rather than dropping a reply it cannot decode', () => {
    const path = databasePath()
    const database = openDatabase(path)
    const { row: opened } = database.createReviewCommentThread(
      { ...draft, id: 'thread-1', replyId: 'reply-1' },
      HUMAN_AUTHOR
    )
    database.close()

    const raw = new DatabaseSync(path)
    raw
      .prepare('UPDATE review_comment_replies SET created_at = ? WHERE id = ?')
      .run('yesterday', 'reply-1')
    raw.close()

    const reopened = openDatabase(path)
    expect(() => reopened.findReviewCommentThread(opened.id)).toThrow(
      ReviewCommentRowError
    )
    reopened.close()
  })
})
