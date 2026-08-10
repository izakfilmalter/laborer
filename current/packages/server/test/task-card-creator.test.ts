import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RpcError } from '@laborer/shared/rpc'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { NodeTaskBoardDatabase } from '../src/services/node-task-board-database.js'
import {
  createTaskCard,
  createTaskUlid,
  runSlackTaskPlanning,
} from '../src/services/task-card-creator.js'

const databasePath = (): string =>
  join(mkdtempSync(join(tmpdir(), 'laborer-card-creator-')), 'tasks.sqlite')
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/u

describe('task card creation', () => {
  it('creates a manual card in its selected column with a ULID', async () => {
    const path = databasePath()
    const result = await Effect.runPromise(
      createTaskCard(
        { rootPath: '/repo', status: 'done', text: '  Ship docs  ' },
        path
      )
    )
    const database = NodeTaskBoardDatabase.open(path)

    expect(result).toMatchObject({ source: 'manual', status: 'done' })
    expect(result.id).toMatch(ULID_PATTERN)
    expect(database.find(result.id)).toMatchObject({
      branchName: null,
      revision: 1,
      rootPath: '/repo',
      status: 'done',
      title: 'Ship docs',
      worktreePath: null,
    })
    expect(database.readChanges(0).cursor).toBe(1)
    database.close()
  })

  it('rejects unbounded manual titles before writing a card', async () => {
    const path = databasePath()
    const error = await Effect.runPromise(
      Effect.flip(
        createTaskCard(
          { rootPath: '/repo', status: 'todo', text: 'x'.repeat(101) },
          path
        )
      )
    )
    expect(error).toMatchObject({ code: 'INVALID_INPUT' })

    const database = NodeTaskBoardDatabase.open(path)
    expect(database.snapshot().tasks).toEqual([])
    database.close()
  })

  it('stores a completed Slack plan through revision CAS', async () => {
    const path = databasePath()
    const database = NodeTaskBoardDatabase.open(path)
    database.insert({
      executionStatus: 'queued',
      id: 'slack-card',
      rootPath: '/repo',
      slackPermalink: 'https://example.slack.com/archives/C1/p1',
      source: 'slack_url',
      status: 'todo',
      title: 'https://example.slack.com/archives/C1/p1',
    })
    database.close()

    await Effect.runPromise(
      runSlackTaskPlanning(
        'slack-card',
        'https://example.slack.com/archives/C1/p1',
        path,
        () =>
          Effect.succeed({
            branchName: 'slack/fix-auth',
            initialPrompt: 'Fix the auth flow',
            title: 'Fix auth flow',
            workType: 'bug',
          })
      )
    )

    const updated = NodeTaskBoardDatabase.open(path)
    expect(updated.find('slack-card')).toMatchObject({
      branchName: 'slack/fix-auth',
      executionStatus: null,
      initialPrompt: 'Fix the auth flow',
      revision: 2,
      title: 'Fix auth flow',
    })
    expect(updated.readChanges(0).cursor).toBe(2)
    updated.close()
  })

  it('marks Slack analysis failures without moving the card', async () => {
    const path = databasePath()
    const database = NodeTaskBoardDatabase.open(path)
    database.insert({
      executionStatus: 'queued',
      id: 'failed-card',
      rootPath: '/repo',
      source: 'slack_url',
      status: 'todo',
      title: 'Slack URL',
    })
    database.close()

    await Effect.runPromise(
      runSlackTaskPlanning(
        'failed-card',
        'https://example.slack.com/archives/C1/p1',
        path,
        () =>
          Effect.fail(
            new RpcError({
              code: 'SLACK_ANALYSIS_FAILED',
              message: 'planner unavailable',
            })
          )
      )
    )

    const failed = NodeTaskBoardDatabase.open(path)
    expect(failed.find('failed-card')).toMatchObject({
      executionStatus: 'failed',
      initialPrompt: null,
      status: 'todo',
    })
    failed.close()
  })

  it('encodes sortable timestamps in generated identifiers', () => {
    expect(createTaskUlid(2).slice(0, 10)).toBe('0000000002')
  })
})
