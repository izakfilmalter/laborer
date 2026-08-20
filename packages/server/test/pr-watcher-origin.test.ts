// @effect-diagnostics effect/preferSchemaOverJson:off
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, describe, it } from '@effect/vitest'
import { Context, Duration, Effect, Fiber, Layer } from 'effect'
import { TestClock } from 'effect/testing'
import { afterEach, vi } from 'vitest'
import type { SpawnResult } from '../src/lib/spawn.js'
import { spawn } from '../src/lib/spawn.js'
import { LaborerDatabase } from '../src/services/laborer-database.js'
import type { NativeLaborerDatabase } from '../src/services/native-laborer-database.js'
import { PR_REVIEW_THREADS_TIMEOUT_MS } from '../src/services/polling-intervals.js'
import { PrTaskTransitions } from '../src/services/pr-task-transitions.js'
import { PrWatcher } from '../src/services/pr-watcher.js'

vi.mock('../src/lib/spawn.js', () => ({
  spawn: vi.fn(),
}))

const spawnMock = vi.mocked(spawn)

/** A stream can only be drained once, so every call gets its own. */
const emptyStream = () =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close()
    },
  })

const createSpawnMock = (
  handlers: Record<
    string,
    { stdout: string; stderr?: string; exitCode?: number }
  >
): typeof spawn => {
  return ((cmd: string[]) => {
    const cmdString = cmd.join(' ')

    for (const [pattern, response] of Object.entries(handlers)) {
      if (cmdString.includes(pattern)) {
        const stdout = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(response.stdout))
            controller.close()
          },
        })
        const stderr = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(response.stderr ?? ''))
            controller.close()
          },
        })

        return {
          exited: Promise.resolve(response.exitCode ?? 0),
          stdout,
          stderr,
          kill: () => true,
          pid: 1234,
        } satisfies SpawnResult
      }
    }

    const emptyStdout = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close()
      },
    })
    const errorStderr = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('command not mocked'))
        controller.close()
      },
    })

    return {
      exited: Promise.resolve(1),
      stdout: emptyStdout,
      stderr: errorStderr,
      kill: () => true,
      pid: 1234,
    } satisfies SpawnResult
  }) as typeof spawn
}

/**
 * PrWatcher skips workspaces whose worktree directory is missing before it
 * ever spawns `gh`, so these tests need a real directory on disk. The scope
 * removes it when each test ends.
 */
const makeWorktreeDir = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), 'pr-watcher-origin-'))),
  (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true }))
)

const createWorkspace = (
  database: NativeLaborerDatabase,
  worktreePath: string,
  prUnresolvedThreads: number | null = null
) => {
  database.insertProject({
    canonicalGitCommonDir: '/tmp/.git',
    id: 'project-1',
    name: 'Test project',
    repoId: 'test-project',
    rootPath: '/tmp',
  })
  database.insertTask({
    branchName: 'feature/fork-pr',
    id: 'workspace-1',
    prUnresolvedThreads,
    rootPath: '/tmp',
    source: 'worktree',
    status: 'in_progress',
    title: 'Fork PR',
    worktreePath,
    worktreeStatus: 'ready',
  })
}

const buildWatcher = (databaseContext: Context.Context<LaborerDatabase>) =>
  Effect.gen(function* () {
    const prWatcherContext = yield* Layer.build(
      PrWatcher.layer.pipe(
        Layer.provide(PrTaskTransitions.noopLayer),
        Layer.provide(Layer.succeedContext(databaseContext))
      )
    )
    return Context.get(prWatcherContext, PrWatcher)
  })

/** Every `gh api graphql` the watcher spent, in call order. */
const graphqlCalls = () =>
  spawnMock.mock.calls
    .map(([cmd]) => cmd.join(' '))
    .filter((cmd) => cmd.includes('graphql'))

/** One `gh api graphql --slurp` page of review threads. */
const threadPages = (resolved: readonly boolean[]) =>
  JSON.stringify([
    {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: resolved.map((isResolved) => ({ isResolved })),
              pageInfo: { endCursor: null, hasNextPage: false },
            },
          },
        },
      },
    },
  ])

afterEach(() => {
  spawnMock.mockReset()
})

describe('PrWatcher fork origin PR lookup', () => {
  it.effect('checks local mergeability even before a PR exists', () =>
    Effect.gen(function* () {
      spawnMock.mockImplementation(
        createSpawnMock({
          'gh pr view': {
            exitCode: 1,
            stderr: 'no pull requests found',
            stdout: '',
          },
          'git merge-tree --write-tree dev HEAD': {
            exitCode: 1,
            stdout: 'conflicted.ts',
          },
        })
      )

      const worktreePath = yield* makeWorktreeDir
      const databaseContext = yield* Layer.build(LaborerDatabase.testLayer())
      const { database } = Context.get(databaseContext, LaborerDatabase)
      createWorkspace(database, worktreePath)
      const task = database.findTask('workspace-1')
      assert.isNotNull(task)
      database.updateTask('workspace-1', task.revision, { baseBranch: 'dev' })

      const prWatcherContext = yield* Layer.build(
        PrWatcher.layer.pipe(
          Layer.provide(PrTaskTransitions.noopLayer),
          Layer.provide(Layer.succeedContext(databaseContext))
        )
      )
      const prWatcher = Context.get(prWatcherContext, PrWatcher)

      const prData = yield* prWatcher.checkPr('workspace-1')

      assert.deepInclude(prData, {
        baseBranch: 'dev',
        mergeStatus: 'conflicting',
        number: null,
      })
      assert.deepInclude(database.findTask('workspace-1'), {
        prBaseBranch: 'dev',
        prMergeStatus: 'conflicting',
      })
    })
  )

  it.effect(
    'prefers the origin repo when a fork has both origin and upstream',
    () =>
      Effect.gen(function* () {
        const transitions: unknown[] = []
        spawnMock.mockImplementation(
          createSpawnMock({
            '--repo acme/fork': {
              stdout: JSON.stringify({
                baseRefName: 'dev',
                isDraft: true,
                mergeable: 'CONFLICTING',
                mergeStateStatus: 'DIRTY',
                number: 42,
                state: 'OPEN',
                statusCheckRollup: [
                  { conclusion: 'SUCCESS', status: 'COMPLETED' },
                  { conclusion: 'FAILURE', status: 'COMPLETED' },
                ],
                title: 'Origin fork PR',
                url: 'https://github.com/acme/fork/pull/42',
              }),
            },
            'remote.origin.url': {
              stdout: 'git@github.com:acme/fork.git',
            },
            'gh pr view feature/fork-pr --json number,url,title,state,isDraft,baseRefName,mergeable,mergeStateStatus,statusCheckRollup,updatedAt':
              {
                stdout: '',
                stderr: 'no pull requests found',
                exitCode: 1,
              },
          })
        )

        const worktreePath = yield* makeWorktreeDir
        const databaseContext = yield* Layer.build(LaborerDatabase.testLayer())
        const { database } = Context.get(databaseContext, LaborerDatabase)
        createWorkspace(database, worktreePath)
        const prWatcherContext = yield* Layer.build(
          PrWatcher.layer.pipe(
            Layer.provide(Layer.succeedContext(databaseContext)),
            Layer.provide(
              Layer.succeed(
                PrTaskTransitions,
                PrTaskTransitions.of({
                  transition: (input) =>
                    Effect.sync(() => {
                      transitions.push(input)
                    }),
                })
              )
            )
          )
        )
        const prWatcher = Context.get(prWatcherContext, PrWatcher)

        const prData = yield* prWatcher.checkPr('workspace-1')
        yield* prWatcher.checkPr('workspace-1')

        assert.strictEqual(prData.number, 42)
        assert.strictEqual(prData.url, 'https://github.com/acme/fork/pull/42')
        assert.deepInclude(database.findTask('workspace-1'), {
          prBaseBranch: 'dev',
          prCheckStatus: 'failure',
          prIsDraft: true,
          prMergeStatus: 'conflicting',
          prNumber: 42,
          prState: 'open',
          prTitle: 'Origin fork PR',
          prUrl: 'https://github.com/acme/fork/pull/42',
        })
        assert.isAtLeast(transitions.length, 2)
        for (const transition of transitions) {
          assert.deepEqual(transition, {
            branchName: 'feature/fork-pr',
            projectRepoPath: '/tmp',
            registeredProjectRepoPaths: ['/tmp'],
            prState: 'OPEN',
          })
        }

        const ghCalls = spawnMock.mock.calls.filter(([cmd]) => cmd[0] === 'gh')
        assert.isAtLeast(ghCalls.length, 1)
        assert.include(
          ghCalls[0]?.[0].join(' '),
          'gh pr view feature/fork-pr --json number,url,title,state,isDraft,baseRefName,mergeable,mergeStateStatus,statusCheckRollup,updatedAt --repo acme/fork'
        )
      })
  )

  it.effect(
    'falls back to default gh repo resolution when origin has no PR',
    () =>
      Effect.gen(function* () {
        spawnMock.mockImplementation(
          createSpawnMock({
            '--repo acme/fork': {
              stdout: '',
              stderr: 'no pull requests found',
              exitCode: 1,
            },
            'remote.origin.url': {
              stdout: 'git@github.com:acme/fork.git',
            },
            'gh pr view feature/fork-pr --json number,url,title,state,isDraft,baseRefName,mergeable,mergeStateStatus,statusCheckRollup,updatedAt':
              {
                stdout: JSON.stringify({
                  number: 7,
                  state: 'OPEN',
                  statusCheckRollup: [
                    { conclusion: 'CANCELLED', status: 'COMPLETED' },
                  ],
                  title: 'Upstream PR',
                  url: 'https://github.com/upstream/repo/pull/7',
                }),
              },
          })
        )

        const worktreePath = yield* makeWorktreeDir
        const databaseContext = yield* Layer.build(LaborerDatabase.testLayer())
        const { database } = Context.get(databaseContext, LaborerDatabase)
        createWorkspace(database, worktreePath)
        const prWatcherContext = yield* Layer.build(
          PrWatcher.layer.pipe(
            Layer.provide(PrTaskTransitions.noopLayer),
            Layer.provide(Layer.succeedContext(databaseContext))
          )
        )
        const prWatcher = Context.get(prWatcherContext, PrWatcher)

        const prData = yield* prWatcher.checkPr('workspace-1')

        assert.strictEqual(prData.number, 7)
        assert.strictEqual(prData.checkStatus, 'failure')
        assert.strictEqual(
          prData.url,
          'https://github.com/upstream/repo/pull/7'
        )

        const ghCalls = spawnMock.mock.calls.filter(([cmd]) => cmd[0] === 'gh')
        assert.isAtLeast(ghCalls.length, 2)
        assert.isTrue(
          ghCalls.some(([cmd]) =>
            cmd
              .join(' ')
              .includes(
                'gh pr view feature/fork-pr --json number,url,title,state,isDraft,baseRefName,mergeable,mergeStateStatus,statusCheckRollup,updatedAt --repo acme/fork'
              )
          )
        )
        assert.isTrue(
          ghCalls.some(([cmd]) => {
            const call = cmd.join(' ')
            return (
              call.includes(
                'gh pr view feature/fork-pr --json number,url,title,state,isDraft,baseRefName,mergeable,mergeStateStatus,statusCheckRollup,updatedAt'
              ) && !call.includes('--repo')
            )
          })
        )
      })
  )

  it.effect('keeps the individual checks behind a red rollup', () =>
    Effect.gen(function* () {
      spawnMock.mockImplementation(
        createSpawnMock({
          'gh pr view': {
            stdout: JSON.stringify({
              baseRefName: 'dev',
              number: 9,
              state: 'OPEN',
              statusCheckRollup: [
                {
                  completedAt: '2026-08-14T10:03:00Z',
                  conclusion: 'SUCCESS',
                  detailsUrl: 'https://github.com/acme/repo/runs/1',
                  name: 'Build',
                  startedAt: '2026-08-14T10:02:20Z',
                  status: 'COMPLETED',
                  workflowName: 'Merge Checks',
                },
                {
                  conclusion: 'SKIPPED',
                  name: '[code]smith',
                  status: 'COMPLETED',
                },
                {
                  conclusion: 'CANCELLED',
                  name: 'E2E Tests',
                  status: 'COMPLETED',
                },
                { context: 'Vercel', state: 'SUCCESS' },
              ],
              title: 'Checked PR',
              url: 'https://github.com/acme/repo/pull/9',
            }),
          },
        })
      )

      const worktreePath = yield* makeWorktreeDir
      const databaseContext = yield* Layer.build(LaborerDatabase.testLayer())
      const { database } = Context.get(databaseContext, LaborerDatabase)
      createWorkspace(database, worktreePath)
      const prWatcherContext = yield* Layer.build(
        PrWatcher.layer.pipe(
          Layer.provide(PrTaskTransitions.noopLayer),
          Layer.provide(Layer.succeedContext(databaseContext))
        )
      )
      const prWatcher = Context.get(prWatcherContext, PrWatcher)

      const prData = yield* prWatcher.checkPr('workspace-1')

      // A cancelled check fails the rollup but reads as its own bucket in the
      // list, and a skipped one is neither pass nor fail.
      assert.strictEqual(prData.checkStatus, 'failure')
      assert.deepEqual(prData.checks, [
        {
          bucket: 'success',
          durationMs: 40_000,
          group: 'Merge Checks',
          name: 'Build',
          url: 'https://github.com/acme/repo/runs/1',
        },
        {
          bucket: 'skipped',
          durationMs: null,
          group: null,
          name: '[code]smith',
          url: null,
        },
        {
          bucket: 'cancelled',
          durationMs: null,
          group: null,
          name: 'E2E Tests',
          url: null,
        },
        {
          bucket: 'success',
          durationMs: null,
          group: null,
          name: 'Vercel',
          url: null,
        },
      ])
      // The list survives the round trip through the task row.
      assert.deepEqual(
        database.findTask('workspace-1')?.prChecks?.map((check) => check.name),
        ['Build', '[code]smith', 'E2E Tests', 'Vercel']
      )
    })
  )
})

describe('PrWatcher unresolved review threads', () => {
  it.effect('leaves a merged pull request unasked about', () =>
    Effect.gen(function* () {
      spawnMock.mockImplementation(
        createSpawnMock({
          'gh pr view': {
            stdout: JSON.stringify({
              number: 11,
              state: 'MERGED',
              title: 'Landed',
              updatedAt: '2026-08-14T10:00:00Z',
              url: 'https://github.com/acme/fork/pull/11',
            }),
          },
        })
      )

      const worktreePath = yield* makeWorktreeDir
      const databaseContext = yield* Layer.build(LaborerDatabase.testLayer())
      const { database } = Context.get(databaseContext, LaborerDatabase)
      createWorkspace(database, worktreePath, 4)
      const prWatcher = yield* buildWatcher(databaseContext)

      const prData = yield* prWatcher.checkPr('workspace-1')

      // Nobody is waiting on a thread in a pull request that is over, and
      // the badge it would feed is gone with it.
      assert.isNull(prData.unresolvedThreads)
      assert.deepEqual(graphqlCalls(), [])
    })
  )

  it.effect('holds the last count when the thread read fails', () =>
    Effect.gen(function* () {
      spawnMock.mockImplementation(
        createSpawnMock({
          'gh pr view': {
            stdout: JSON.stringify({
              number: 11,
              state: 'OPEN',
              title: 'In review',
              updatedAt: '2026-08-14T10:00:00Z',
              url: 'https://github.com/acme/fork/pull/11',
            }),
          },
          'api graphql': {
            exitCode: 1,
            stderr: 'HTTP 502: Bad gateway',
            stdout: '',
          },
        })
      )

      const worktreePath = yield* makeWorktreeDir
      const databaseContext = yield* Layer.build(LaborerDatabase.testLayer())
      const { database } = Context.get(databaseContext, LaborerDatabase)
      createWorkspace(database, worktreePath, 4)
      const prWatcher = yield* buildWatcher(databaseContext)

      const prData = yield* prWatcher.checkPr('workspace-1')

      // One refused request on a five-second poll must not blink the badge
      // out and back.
      assert.strictEqual(prData.unresolvedThreads, 4)
      assert.strictEqual(
        database.findTask('workspace-1')?.prUnresolvedThreads,
        4
      )
    })
  )

  it.effect('counts threads in the repository the pull request lives in', () =>
    Effect.gen(function* () {
      spawnMock.mockImplementation(
        createSpawnMock({
          '--repo acme/fork': {
            exitCode: 1,
            stderr: 'no pull requests found',
            stdout: '',
          },
          'remote.origin.url': { stdout: 'git@github.com:acme/fork.git' },
          'api graphql': { stdout: threadPages([false, true, false]) },
          'gh pr view': {
            stdout: JSON.stringify({
              number: 7,
              state: 'OPEN',
              title: 'Upstream PR',
              updatedAt: '2026-08-14T10:00:00Z',
              url: 'https://github.com/upstream/repo/pull/7',
            }),
          },
        })
      )

      const worktreePath = yield* makeWorktreeDir
      const databaseContext = yield* Layer.build(LaborerDatabase.testLayer())
      const { database } = Context.get(databaseContext, LaborerDatabase)
      createWorkspace(database, worktreePath)
      const prWatcher = yield* buildWatcher(databaseContext)

      const prData = yield* prWatcher.checkPr('workspace-1')

      // A fork clone whose PR was opened against the parent: origin is
      // `acme/fork`, but #7 only exists in `upstream/repo`.
      assert.strictEqual(prData.unresolvedThreads, 2)
      const [graphql] = graphqlCalls()
      assert.include(graphql ?? '', 'owner=upstream')
      assert.include(graphql ?? '', 'repo=repo')
      assert.notInclude(graphql ?? '', 'owner=acme')
    })
  )

  it.effect('gives up on a thread read that never finishes', () =>
    Effect.gen(function* () {
      let graphqlSpawned: () => void = () => undefined
      const graphqlStarted = new Promise<void>((resolve) => {
        graphqlSpawned = resolve
      })
      const prView = createSpawnMock({
        'gh pr view': {
          stdout: JSON.stringify({
            number: 11,
            state: 'OPEN',
            title: 'In review',
            updatedAt: '2026-08-14T10:00:00Z',
            url: 'https://github.com/acme/fork/pull/11',
          }),
        },
      }) as unknown as (cmd: readonly string[]) => SpawnResult
      spawnMock.mockImplementation(((cmd: string[]) => {
        if (!cmd.join(' ').includes('graphql')) {
          return prView(cmd)
        }

        graphqlSpawned()
        return {
          // A `gh` that never exits: only the timeout can end this read.
          exited: new Promise<number>(() => undefined),
          kill: () => true,
          pid: 99,
          stderr: emptyStream(),
          stdout: emptyStream(),
        } satisfies SpawnResult
      }) as typeof spawn)

      const worktreePath = yield* makeWorktreeDir
      const databaseContext = yield* Layer.build(LaborerDatabase.testLayer())
      const { database } = Context.get(databaseContext, LaborerDatabase)
      createWorkspace(database, worktreePath, 4)
      const prWatcher = yield* buildWatcher(databaseContext)

      const fiber = yield* Effect.forkChild(prWatcher.checkPr('workspace-1'))
      yield* Effect.promise(() => graphqlStarted)
      yield* TestClock.adjust(Duration.millis(PR_REVIEW_THREADS_TIMEOUT_MS))
      const prData = yield* Fiber.join(fiber)

      // The poll loop is sequential, so the rest of the check has to come
      // back whatever GitHub does with the thread request.
      assert.strictEqual(prData.number, 11)
      assert.strictEqual(prData.unresolvedThreads, 4)
    })
  )

  it.effect('asks again only when the pull request has moved', () =>
    Effect.gen(function* () {
      spawnMock.mockImplementation(
        createSpawnMock({
          'gh pr view': {
            stdout: JSON.stringify({
              number: 7,
              state: 'OPEN',
              title: 'In review',
              updatedAt: '2026-08-14T10:00:00Z',
              url: 'https://github.com/acme/fork/pull/7',
            }),
          },
          'api graphql': { stdout: threadPages([false, false]) },
        })
      )

      const worktreePath = yield* makeWorktreeDir
      const databaseContext = yield* Layer.build(LaborerDatabase.testLayer())
      const { database } = Context.get(databaseContext, LaborerDatabase)
      createWorkspace(database, worktreePath)
      const prWatcher = yield* buildWatcher(databaseContext)

      yield* prWatcher.checkPr('workspace-1')
      const second = yield* prWatcher.checkPr('workspace-1')

      // GraphQL has its own hourly budget and honours no conditional
      // request, so an unchanged `updatedAt` is answered from memory.
      assert.strictEqual(second.unresolvedThreads, 2)
      assert.lengthOf(graphqlCalls(), 1)
    })
  )
})
