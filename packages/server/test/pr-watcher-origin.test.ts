// @effect-diagnostics effect/preferSchemaOverJson:off
import { assert, describe, it } from '@effect/vitest'
import { events, tables } from '@laborer/shared/schema'
import { Context, Effect, Layer } from 'effect'
import { afterEach, vi } from 'vitest'
import type { SpawnResult } from '../src/lib/spawn.js'
import { spawn } from '../src/lib/spawn.js'
import { LaborerStore } from '../src/services/laborer-store.js'
import { PrWatcher } from '../src/services/pr-watcher.js'
import { TestLaborerStore } from './helpers/test-store.js'

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

const createWorkspace = (store: LaborerStore['Type']['store']) => {
  store.commit(
    events.workspaceCreated({
      id: 'workspace-1',
      projectId: 'project-1',
      taskSource: null,
      branchName: 'feature/fork-pr',
      worktreePath: '/tmp/workspace-1',
      status: 'running',
      origin: 'laborer',
      createdAt: new Date().toISOString(),
      baseSha: null,
    })
  )
}

afterEach(() => {
  spawnMock.mockReset()
})

describe('PrWatcher fork origin PR lookup', () => {
  it.scoped(
    'prefers the origin repo when a fork has both origin and upstream',
    () =>
      Effect.gen(function* () {
        spawnMock.mockImplementation(
          createSpawnMock({
            '--repo acme/fork': {
              stdout: JSON.stringify({
                number: 42,
                state: 'OPEN',
                title: 'Origin fork PR',
                url: 'https://github.com/acme/fork/pull/42',
              }),
            },
            'remote.origin.url': {
              stdout: 'git@github.com:acme/fork.git',
            },
            'gh pr view --json number,url,title,state': {
              stdout: '',
              stderr: 'no pull requests found',
              exitCode: 1,
            },
          })
        )

        const storeContext = yield* Layer.build(TestLaborerStore)
        const { store } = Context.get(storeContext, LaborerStore)
        const prWatcherContext = yield* Layer.build(
          PrWatcher.layer.pipe(
            Layer.provide(Layer.succeedContext(storeContext))
          )
        )
        const prWatcher = Context.get(prWatcherContext, PrWatcher)

        createWorkspace(store)

        const prData = yield* prWatcher.checkPr('workspace-1')

        assert.strictEqual(prData.number, 42)
        assert.strictEqual(prData.url, 'https://github.com/acme/fork/pull/42')

        const workspace = store
          .query(tables.workspaces)
          .find((row) => row.id === 'workspace-1')
        assert.strictEqual(workspace?.prNumber, 42)
        assert.strictEqual(workspace?.prTitle, 'Origin fork PR')

        const ghCalls = spawnMock.mock.calls.filter(([cmd]) => cmd[0] === 'gh')
        assert.strictEqual(ghCalls.length, 1)
        assert.include(ghCalls[0]?.[0].join(' '), '--repo acme/fork')
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
            'gh pr view --json number,url,title,state': {
              stdout: JSON.stringify({
                number: 7,
                state: 'OPEN',
                title: 'Upstream PR',
                url: 'https://github.com/upstream/repo/pull/7',
              }),
            },
          })
        )

        const storeContext = yield* Layer.build(TestLaborerStore)
        const { store } = Context.get(storeContext, LaborerStore)
        const prWatcherContext = yield* Layer.build(
          PrWatcher.layer.pipe(
            Layer.provide(Layer.succeedContext(storeContext))
          )
        )
        const prWatcher = Context.get(prWatcherContext, PrWatcher)

        createWorkspace(store)

        const prData = yield* prWatcher.checkPr('workspace-1')

        assert.strictEqual(prData.number, 7)
        assert.strictEqual(
          prData.url,
          'https://github.com/upstream/repo/pull/7'
        )

        const ghCalls = spawnMock.mock.calls.filter(([cmd]) => cmd[0] === 'gh')
        assert.strictEqual(ghCalls.length, 2)
        assert.include(ghCalls[0]?.[0].join(' '), '--repo acme/fork')
        assert.notInclude(ghCalls[1]?.[0].join(' ') ?? '', '--repo')
      })
  )
})
