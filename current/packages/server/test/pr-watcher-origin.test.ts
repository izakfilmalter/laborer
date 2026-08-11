// @effect-diagnostics effect/preferSchemaOverJson:off
import { assert, describe, it } from '@effect/vitest'
import { Context, Effect, Layer } from 'effect'
import { afterEach, vi } from 'vitest'
import type { SpawnResult } from '../src/lib/spawn.js'
import { spawn } from '../src/lib/spawn.js'
import { LaborerDatabase } from '../src/services/laborer-database.js'
import type { NativeLaborerDatabase } from '../src/services/native-laborer-database.js'
import { PrTaskTransitions } from '../src/services/pr-task-transitions.js'
import { PrWatcher } from '../src/services/pr-watcher.js'

vi.mock('../src/lib/spawn.js', () => ({
  spawn: vi.fn(),
}))

const spawnMock = vi.mocked(spawn)

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

const createWorkspace = (database: NativeLaborerDatabase) => {
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
    rootPath: '/tmp',
    source: 'worktree',
    status: 'in_progress',
    title: 'Fork PR',
    worktreePath: '/tmp',
    worktreeStatus: 'ready',
  })
}

afterEach(() => {
  spawnMock.mockReset()
})

describe('PrWatcher fork origin PR lookup', () => {
  it.scoped(
    'prefers the origin repo when a fork has both origin and upstream',
    () =>
      Effect.gen(function* () {
        const transitions: unknown[] = []
        spawnMock.mockImplementation(
          createSpawnMock({
            '--repo acme/fork': {
              stdout: JSON.stringify({
                isDraft: true,
                number: 42,
                state: 'OPEN',
                title: 'Origin fork PR',
                url: 'https://github.com/acme/fork/pull/42',
              }),
            },
            'remote.origin.url': {
              stdout: 'git@github.com:acme/fork.git',
            },
            'gh pr view feature/fork-pr --json number,url,title,state,isDraft':
              {
                stdout: '',
                stderr: 'no pull requests found',
                exitCode: 1,
              },
          })
        )

        const databaseContext = yield* Layer.build(LaborerDatabase.testLayer())
        const { database } = Context.get(databaseContext, LaborerDatabase)
        createWorkspace(database)
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
          prIsDraft: true,
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
          'gh pr view feature/fork-pr --json number,url,title,state,isDraft --repo acme/fork'
        )
      })
  )

  it.scoped(
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
            'gh pr view feature/fork-pr --json number,url,title,state,isDraft':
              {
                stdout: JSON.stringify({
                  number: 7,
                  state: 'OPEN',
                  title: 'Upstream PR',
                  url: 'https://github.com/upstream/repo/pull/7',
                }),
              },
          })
        )

        const databaseContext = yield* Layer.build(LaborerDatabase.testLayer())
        const { database } = Context.get(databaseContext, LaborerDatabase)
        createWorkspace(database)
        const prWatcherContext = yield* Layer.build(
          PrWatcher.layer.pipe(
            Layer.provide(PrTaskTransitions.noopLayer),
            Layer.provide(Layer.succeedContext(databaseContext))
          )
        )
        const prWatcher = Context.get(prWatcherContext, PrWatcher)

        const prData = yield* prWatcher.checkPr('workspace-1')

        assert.strictEqual(prData.number, 7)
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
                'gh pr view feature/fork-pr --json number,url,title,state,isDraft --repo acme/fork'
              )
          )
        )
        assert.isTrue(
          ghCalls.some(([cmd]) => {
            const call = cmd.join(' ')
            return (
              call.includes(
                'gh pr view feature/fork-pr --json number,url,title,state,isDraft'
              ) && !call.includes('--repo')
            )
          })
        )
      })
  )
})
