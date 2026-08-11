import { assert, describe, it } from '@effect/vitest'
import { Context, Duration, Effect, Layer, Logger, TestClock } from 'effect'
import { LaborerDatabase } from '../src/services/laborer-database.js'
import type { NativeLaborerDatabase } from '../src/services/native-laborer-database.js'
import { PR_BACKGROUND_POLL_INTERVAL_MS } from '../src/services/polling-intervals.js'
import { PrTaskTransitions } from '../src/services/pr-task-transitions.js'
import { PrWatcher } from '../src/services/pr-watcher.js'
import { waitFor } from './helpers/timing-helpers.js'

type PrWatcherService = Context.Tag.Service<typeof PrWatcher>

const waitForPollingState = (
  prWatcher: PrWatcherService,
  workspaceId: string,
  expected: boolean
) =>
  Effect.promise(() =>
    waitFor(
      async () =>
        (await Effect.runPromise(prWatcher.isPolling(workspaceId))) ===
        expected,
      2000,
      `PrWatcher polling state for ${workspaceId}`
    )
  )

const insertProject = (database: NativeLaborerDatabase) => {
  database.insertProject({
    canonicalGitCommonDir: '/tmp/.git',
    id: 'project-1',
    name: 'Test project',
    repoId: 'test-project',
    rootPath: '/tmp',
  })
}

const insertWorkspace = (
  database: NativeLaborerDatabase,
  input: {
    readonly branchName: string
    readonly id: string
    readonly source?: 'manual' | 'worktree'
    readonly worktreePath: string
  }
) =>
  database.insertTask({
    branchName: input.branchName,
    id: input.id,
    rootPath: '/tmp',
    source: input.source ?? 'manual',
    status: 'in_progress',
    title: input.branchName,
    worktreePath: input.worktreePath,
    worktreeStatus: 'ready',
  }).row

const buildPrWatcher = (databaseContext: Context.Context<LaborerDatabase>) =>
  Effect.gen(function* () {
    const prWatcherContext = yield* Layer.build(
      PrWatcher.layer.pipe(
        Layer.provide(PrTaskTransitions.noopLayer),
        Layer.provide(Layer.succeedContext(databaseContext))
      )
    )
    return Context.get(prWatcherContext, PrWatcher)
  })

const withDatabase = <A, E, R>(
  run: (
    database: NativeLaborerDatabase,
    databaseContext: Context.Context<LaborerDatabase>
  ) => Effect.Effect<A, E, R>
) =>
  Effect.gen(function* () {
    const databaseContext = yield* Layer.build(LaborerDatabase.testLayer())
    const { database } = Context.get(databaseContext, LaborerDatabase)
    insertProject(database)
    return yield* run(database, databaseContext)
  })

describe('PrWatcher', () => {
  it.scoped(
    'bootstraps polling for persisted active workspaces on startup',
    () =>
      withDatabase((database, databaseContext) =>
        Effect.gen(function* () {
          insertWorkspace(database, {
            branchName: 'feature/pr-status',
            id: 'workspace-running',
            worktreePath: '/tmp/workspace-running',
          })

          const prWatcher = yield* buildPrWatcher(databaseContext)
          yield* waitForPollingState(prWatcher, 'workspace-running', true)

          assert.isTrue(yield* prWatcher.isPolling('workspace-running'))
        })
      )
  )

  it.scoped(
    'bootstraps background polling for externally adopted workspaces on startup',
    () =>
      withDatabase((database, databaseContext) =>
        Effect.gen(function* () {
          insertWorkspace(database, {
            branchName: 'feature/stopped',
            id: 'workspace-stopped',
            source: 'worktree',
            worktreePath: '/tmp/workspace-stopped',
          })

          const prWatcher = yield* buildPrWatcher(databaseContext)
          yield* waitForPollingState(prWatcher, 'workspace-stopped', true)

          assert.isTrue(yield* prWatcher.isPolling('workspace-stopped'))
        })
      )
  )

  it.scoped(
    'clears stale PR data without warning when a workspace path is missing',
    () => {
      const logs: string[] = []
      const logger = Logger.make(({ message }) => {
        logs.push(String(message))
      })

      return withDatabase((database, databaseContext) =>
        Effect.gen(function* () {
          database.insertTask({
            branchName: 'feature/stopped-pr',
            id: 'workspace-stopped',
            prNumber: 42,
            prState: 'merged',
            prTitle: 'Test PR',
            prUrl: 'https://github.com/test/repo/pull/42',
            rootPath: '/tmp',
            source: 'worktree',
            status: 'in_progress',
            title: 'Test PR',
            worktreePath: '/tmp/workspace-stopped-pr',
            worktreeStatus: 'ready',
          })

          const workspaceBefore = database.findTask('workspace-stopped')
          assert.strictEqual(workspaceBefore?.prState, 'merged')
          assert.strictEqual(workspaceBefore?.prNumber, 42)

          const prWatcher = yield* buildPrWatcher(databaseContext)
          yield* prWatcher.checkPr('workspace-stopped')

          const workspaceAfter = database.findTask('workspace-stopped')
          assert.strictEqual(
            workspaceAfter?.prState,
            null,
            'checkPr should clear stale PR data for a missing worktree'
          )
          assert.isFalse(
            logs.some((message) =>
              message.includes('[PrWatcher] Failed to run gh pr view')
            ),
            'a missing worktree should not be reported as a gh spawn failure'
          )
        })
      ).pipe(Effect.provide(Logger.replace(Logger.defaultLogger, logger)))
    }
  )

  it.scoped('refreshes polling coverage for an adopted workspace', () =>
    withDatabase((database, databaseContext) =>
      Effect.gen(function* () {
        const prWatcher = yield* buildPrWatcher(databaseContext)
        insertWorkspace(database, {
          branchName: 'laborer/adopted',
          id: 'workspace-adopted',
          source: 'worktree',
          worktreePath: '/tmp/workspace-adopted',
        })

        yield* prWatcher.refreshPolling()
        yield* waitForPollingState(prWatcher, 'workspace-adopted', true)
        assert.isTrue(yield* prWatcher.isPolling('workspace-adopted'))
      })
    )
  )

  it.scoped('periodically discovers an adopted workspace', () =>
    withDatabase((database, databaseContext) =>
      Effect.gen(function* () {
        const prWatcher = yield* buildPrWatcher(databaseContext)

        yield* Effect.yieldNow()
        insertWorkspace(database, {
          branchName: 'laborer/periodically-adopted',
          id: 'workspace-periodically-adopted',
          source: 'worktree',
          worktreePath: '/tmp/workspace-periodically-adopted',
        })

        assert.isFalse(
          yield* prWatcher.isPolling('workspace-periodically-adopted')
        )
        yield* TestClock.adjust(Duration.millis(PR_BACKGROUND_POLL_INTERVAL_MS))
        yield* Effect.yieldNow()
        assert.isTrue(
          yield* prWatcher.isPolling('workspace-periodically-adopted')
        )
      })
    )
  )

  it.scoped('polling coverage continuously polls adopted workspaces', () =>
    withDatabase((database, databaseContext) =>
      Effect.gen(function* () {
        database.insertTask({
          branchName: 'feature/stopped-boot',
          id: 'workspace-stopped-boot',
          prNumber: 99,
          prState: 'open',
          prTitle: 'Boot PR',
          prUrl: 'https://github.com/test/repo/pull/99',
          rootPath: '/tmp',
          source: 'worktree',
          status: 'in_progress',
          title: 'Boot PR',
          worktreePath: '/tmp/workspace-stopped-boot',
          worktreeStatus: 'ready',
        })
        assert.strictEqual(
          database.findTask('workspace-stopped-boot')?.prState,
          'open'
        )

        const prWatcher = yield* buildPrWatcher(databaseContext)
        yield* waitForPollingState(prWatcher, 'workspace-stopped-boot', true)
        assert.isTrue(
          yield* prWatcher.isPolling('workspace-stopped-boot'),
          'adopted workspaces should poll continuously'
        )

        yield* Effect.promise(() =>
          waitFor(
            async () =>
              database.findTask('workspace-stopped-boot')?.prState === null,
            5000,
            'adopted workspace bootstrap PR check'
          )
        )
        assert.strictEqual(
          database.findTask('workspace-stopped-boot')?.prState,
          null,
          'polling coverage should check adopted workspaces'
        )
      })
    )
  )

  it.scoped(
    'checkPr stops polling when the durable workspace task is not found',
    () =>
      withDatabase((database, databaseContext) =>
        Effect.gen(function* () {
          const task = insertWorkspace(database, {
            branchName: 'feature/vanish',
            id: 'workspace-vanishing',
            worktreePath: '/tmp/workspace-vanishing',
          })
          const prWatcher = yield* buildPrWatcher(databaseContext)

          yield* waitForPollingState(prWatcher, 'workspace-vanishing', true)
          assert.isTrue(yield* prWatcher.isPolling('workspace-vanishing'))

          database.deleteTask(task.id, task.revision)
          assert.isNull(database.findTask('workspace-vanishing'))

          yield* prWatcher.checkPr('workspace-vanishing')

          assert.isFalse(
            yield* prWatcher.isPolling('workspace-vanishing'),
            'polling should stop when the durable workspace task is absent'
          )
        })
      )
  )
})
