import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RpcError } from '@laborer/shared/rpc'
import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { NodeTaskBoardDatabase } from '../src/services/node-task-board-database.js'
import {
  createTaskCard,
  createTaskUlid,
  manualTaskBranchName,
  runSlackTaskPlanning,
} from '../src/services/task-card-creator.js'
import { waitFor } from './helpers/timing-helpers.js'

const databasePath = (): string =>
  join(mkdtempSync(join(tmpdir(), 'laborer-card-creator-')), 'tasks.sqlite')
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/u
const SLACK_PERMALINK = 'https://example.slack.com/archives/C1/p1'
const slackPlan = {
  branchName: 'slack/fix-auth',
  initialPrompt: 'Fix the auth flow',
  title: 'Fix auth flow',
  workType: 'bug',
} as const

/** Read a card through its own connection, the way another process would. */
const storedTask = (path: string, id: string) => {
  const database = NodeTaskBoardDatabase.open(path)
  try {
    return database.find(id)
  } finally {
    database.close()
  }
}

describe('task card creation', () => {
  it('turns a manual task title into an unadorned branch name', () => {
    expect(manualTaskBranchName('  Débug electric sync delays!  ')).toBe(
      'debug-electric-sync-delays'
    )
    expect(manualTaskBranchName('⚡️')).toBe('task')
    expect(manualTaskBranchName('Same title')).toBe('same-title')
  })

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

  it('analyzes a Slack card that waits in its Todo column', async () => {
    const path = databasePath()
    const planner = vi.fn(() => Effect.succeed(slackPlan))

    const result = await Effect.runPromise(
      createTaskCard(
        { rootPath: '/repo', status: 'todo', text: SLACK_PERMALINK },
        path,
        planner
      )
    )

    expect(result).toMatchObject({ source: 'slack_url', status: 'todo' })
    await waitFor(
      () =>
        Promise.resolve(
          storedTask(path, result.id)?.description === slackPlan.initialPrompt
        ),
      5000,
      'the Slack thread to be analyzed'
    )
    expect(storedTask(path, result.id)).toMatchObject({
      status: 'todo',
      title: slackPlan.title,
    })
    // The analysis runs inside the card's repository so OpenCode reuses the
    // already-booted project instead of booting one for the home directory.
    expect(planner).toHaveBeenCalledWith(SLACK_PERMALINK, '/repo')
  })

  it('keeps a Slack card in the In Progress column it was added to', async () => {
    const path = databasePath()
    const planner = vi.fn(() => Effect.succeed(slackPlan))

    const result = await Effect.runPromise(
      createTaskCard(
        { rootPath: '/repo', status: 'in_progress', text: SLACK_PERMALINK },
        path,
        planner
      )
    )

    expect(result).toMatchObject({ source: 'slack_url', status: 'in_progress' })
    expect(storedTask(path, result.id)).toMatchObject({
      description: null,
      executionStatus: 'queued',
      slackPermalink: SLACK_PERMALINK,
      status: 'in_progress',
      title: SLACK_PERMALINK,
    })
    // Provisioning plans this card, so creation must not analyze it twice.
    expect(planner).not.toHaveBeenCalled()
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
        '/repo',
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
      description: 'Fix the auth flow',
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
        '/repo',
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
      description: null,
      status: 'todo',
    })
    failed.close()
  })

  it('encodes sortable timestamps in generated identifiers', () => {
    expect(createTaskUlid(2).slice(0, 10)).toBe('0000000002')
  })
})
