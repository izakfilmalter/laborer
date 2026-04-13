import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MessageChannel } from 'node:worker_threads'
import { RpcServer } from '@effect/rpc'
import { assert, describe, it } from '@effect/vitest'
import { TerminalRpcs } from '@laborer/shared/rpc'
import type { RpcMessagePort } from '@laborer/shared/rpc-transport-messageport'
import { layerProtocolMessagePort } from '@laborer/shared/rpc-transport-messageport'
import { events } from '@laborer/shared/schema'
import { Context, Effect, Layer, Ref, Stream } from 'effect'
import { afterAll } from 'vitest'

import { ConfigService } from '../src/services/config-service.js'
import { ContainerService } from '../src/services/container-service.js'
import { makeServiceProxy } from '../src/services/deferred-service.js'
import { DepsImageService } from '../src/services/deps-image-service.js'
import { DockerDetection } from '../src/services/docker-detection.js'
import { LaborerStore } from '../src/services/laborer-store.js'
import { ProjectRegistry } from '../src/services/project-registry.js'
import { SandboxProvider } from '../src/services/sandbox-provider.js'
import { SandboxProviderRoutedLayer } from '../src/services/sandbox-provider-router.js'
import { ShuruDetection } from '../src/services/shuru-detection.js'
import { handleShuruTerminalDataPort } from '../src/services/shuru-terminal-data-channel.js'
import {
  TerminalClient,
  TerminalRpcPort,
} from '../src/services/terminal-client.js'
import { WorkspaceProvider } from '../src/services/workspace-provider.js'
import { initRepo } from './helpers/git-helpers.js'
import { TestLaborerStore } from './helpers/test-store.js'

const EMPTY_ENV_VALUE = ''
const HOST_TERMINAL_ID_PATTERN = /^host-terminal-/
const SHURU_TERMINAL_ID_PATTERN = /^shuru:/
const fakeShuruCliPath = fileURLToPath(
  new URL('./fixtures/fake-shuru-cli.js', import.meta.url)
)
const tempRoots: string[] = []

const TestContainerService = Layer.succeed(
  ContainerService,
  ContainerService.of({
    createContainer: () => Effect.void,
    destroyContainer: () => Effect.void,
    pauseContainer: () => Effect.void,
    unpauseContainer: () => Effect.void,
  })
)

const TestDepsImageService = Layer.succeed(
  DepsImageService,
  DepsImageService.of({
    ensureDepsImage: () => Effect.succeed(null),
  })
)

const TestDockerDetection = Layer.succeed(
  DockerDetection,
  DockerDetection.of({
    check: () => Effect.succeed({ available: true }),
  })
)

const TestShuruDetection = Layer.succeed(
  ShuruDetection,
  ShuruDetection.of({
    check: () => Effect.succeed({ available: true }),
  })
)

const StubTerminalClient = Layer.succeed(
  TerminalClient,
  TerminalClient.of({
    spawnInWorkspace: () =>
      Effect.succeed({
        id: 'stub-terminal',
        workspaceId: 'stub-workspace',
        command: 'stub-command',
        status: 'running' as const,
      }),
    killAllForWorkspace: () => Effect.succeed(0),
    resizeTerminal: () => Effect.void,
    killTerminal: () => Effect.void,
    removeTerminal: () => Effect.void,
  })
)

const ShuruProviderTestLayer = SandboxProviderRoutedLayer.pipe(
  Layer.provideMerge(StubTerminalClient),
  Layer.provideMerge(TestShuruDetection),
  Layer.provideMerge(TestDockerDetection),
  Layer.provideMerge(TestDepsImageService),
  Layer.provideMerge(TestContainerService),
  Layer.provideMerge(ConfigService.layer),
  Layer.provideMerge(TestLaborerStore)
)

const readLogEntries = (logPath: string) =>
  readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)

const restoreEnv = (previous: Record<string, string | undefined>): void => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) {
      process.env[key] = EMPTY_ENV_VALUE
    } else {
      process.env[key] = value
    }
  }
}

const waitFor = (
  predicate: () => boolean,
  failureMessage: string
): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (predicate()) {
        return
      }

      yield* Effect.sleep('100 millis')
    }

    assert.fail(failureMessage)
  })

function toRpcPort(
  nodePort: import('node:worker_threads').MessagePort
): RpcMessagePort {
  return {
    close() {
      nodePort.close()
    },
    off(event: string, listener: (...args: unknown[]) => void) {
      nodePort.off(event, listener)
    },
    on(event: string, listener: (...args: unknown[]) => void) {
      nodePort.on(event, listener)
    },
    postMessage(value: unknown, transferList?: readonly unknown[]) {
      nodePort.postMessage(value, transferList as undefined)
    },
    start() {
      nodePort.start()
    },
  }
}

const buildTerminalInfo = (
  id: string,
  workspaceId: string,
  command: string,
  cwd: string,
  args: readonly string[] = []
) => ({
  agentStatus: null,
  args,
  command,
  cwd,
  foregroundProcess: null,
  hasChildProcess: false,
  id,
  processChain: [],
  status: 'running' as const,
  workspaceId,
})

afterAll(() => {
  for (const root of tempRoots) {
    if (existsSync(root)) {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

describe('Shuru dev-server terminals', () => {
  it.scoped(
    'routes Shuru auto-run sessions through the sandbox while keeping manual terminals on the host',
    () =>
      Effect.gen(function* () {
        const { port1, port2 } = new MessageChannel()
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            port1.close()
            port2.close()
          })
        )

        const hostSpawnCalls = yield* Ref.make<
          readonly {
            readonly command: string
            readonly cwd: string
            readonly workspaceId: string
          }[]
        >([])
        const sandboxSpawnCalls = yield* Ref.make<
          readonly {
            readonly autoRun: boolean | undefined
            readonly command: string | undefined
            readonly workspaceId: string
          }[]
        >([])

        const fakeTerminalServer = RpcServer.layer(TerminalRpcs).pipe(
          Layer.provide(layerProtocolMessagePort(toRpcPort(port1))),
          Layer.provide(
            TerminalRpcs.toLayer(
              Effect.succeed({
                'terminal.events': () => Stream.empty,
                'terminal.kill': () => Effect.void,
                'terminal.list': () => Effect.succeed([]),
                'terminal.remove': () => Effect.void,
                'terminal.resize': () => Effect.void,
                'terminal.restart': ({ id }) =>
                  Effect.succeed(
                    buildTerminalInfo(id, 'workspace', 'restart', '/tmp')
                  ),
                'terminal.setAgentStatus': () => Effect.void,
                'terminal.spawn': (payload) =>
                  Effect.gen(function* () {
                    const nextCalls = yield* Ref.updateAndGet(
                      hostSpawnCalls,
                      (calls) => [
                        ...calls,
                        {
                          command: payload.command,
                          cwd: payload.cwd,
                          workspaceId: payload.workspaceId,
                        },
                      ]
                    )

                    return buildTerminalInfo(
                      `host-terminal-${String(nextCalls.length)}`,
                      payload.workspaceId,
                      payload.command,
                      payload.cwd,
                      payload.args ?? []
                    )
                  }),
                'terminal.write': () => Effect.void,
              })
            )
          )
        )

        yield* Layer.build(fakeTerminalServer)

        const sandboxProviderLayer = Layer.succeed(
          SandboxProvider,
          SandboxProvider.of(
            makeServiceProxy<SandboxProvider['Type']>('SandboxProvider', {
              spawnTerminal: (workspaceId, opts) =>
                Effect.gen(function* () {
                  yield* Ref.update(sandboxSpawnCalls, (calls) => [
                    ...calls,
                    {
                      autoRun: opts?.autoRun,
                      command: opts?.command,
                      workspaceId,
                    },
                  ])

                  return {
                    command: 'npm run dev',
                    id: 'shuru:dev-server',
                    status: 'running' as const,
                    workspaceId,
                  }
                }),
            })
          )
        )

        const terminalClientLayer = TerminalClient.layer.pipe(
          Layer.provide(
            Layer.succeed(TerminalRpcPort, { port: toRpcPort(port2) })
          ),
          Layer.provide(
            Layer.succeed(
              WorkspaceProvider,
              makeServiceProxy<WorkspaceProvider['Type']>('WorkspaceProvider', {
                getWorkspaceEnv: () => Effect.succeed({}),
              })
            )
          ),
          Layer.provide(
            Layer.succeed(
              ProjectRegistry,
              makeServiceProxy<ProjectRegistry['Type']>('ProjectRegistry')
            )
          ),
          Layer.provide(sandboxProviderLayer),
          Layer.provideMerge(ConfigService.layer),
          Layer.provideMerge(TestLaborerStore)
        )

        const context = yield* Layer.build(terminalClientLayer)
        const terminalClient = Context.get(context, TerminalClient)
        const { store } = Context.get(context, LaborerStore)

        const repoPath = initRepo('shuru-terminal-routing', tempRoots)
        const projectId = crypto.randomUUID()
        const workspaceId = crypto.randomUUID()

        store.commit(
          events.projectCreated({
            id: projectId,
            repoPath,
            name: 'shuru-terminal-routing',
            brrrConfig: null,
          })
        )
        store.commit(
          events.workspaceCreated({
            id: workspaceId,
            projectId,
            taskSource: null,
            branchName: 'feature/shuru-routing',
            worktreePath: repoPath,
            status: 'running',
            origin: 'laborer',
            createdAt: new Date().toISOString(),
            baseSha: null,
          })
        )
        store.commit(
          events.sandboxStarted({
            workspaceId,
            sandboxId: 'shuru:sandbox',
            sandboxPort: undefined,
            sandboxUrl: '',
            sandboxImage: 'shuru',
            sandboxProvider: 'shuru',
          })
        )

        const devServerTerminal = yield* terminalClient.spawnInWorkspace(
          workspaceId,
          undefined,
          true
        )

        assert.strictEqual(devServerTerminal.id, 'shuru:dev-server')
        assert.deepStrictEqual(yield* Ref.get(hostSpawnCalls), [])
        assert.deepStrictEqual(yield* Ref.get(sandboxSpawnCalls), [
          { autoRun: true, command: undefined, workspaceId },
        ])

        const hostTerminal = yield* terminalClient.spawnInWorkspace(workspaceId)

        assert.match(hostTerminal.id, HOST_TERMINAL_ID_PATTERN)
        assert.strictEqual((yield* Ref.get(sandboxSpawnCalls)).length, 1)
        assert.deepStrictEqual(yield* Ref.get(hostSpawnCalls), [
          {
            command: process.env.SHELL ?? '/bin/sh',
            cwd: repoPath,
            workspaceId,
          },
        ])
      })
  )

  it.scopedLive(
    'streams sandbox output to the terminal data channel and supports input, kill, and resize',
    () =>
      Effect.gen(function* () {
        const previousEnv = {
          LABORER_SHURU_BIN: process.env.LABORER_SHURU_BIN,
          LABORER_TEST_SHURU_CHECKPOINT_DIR:
            process.env.LABORER_TEST_SHURU_CHECKPOINT_DIR,
          LABORER_TEST_SHURU_ECHO_INPUT:
            process.env.LABORER_TEST_SHURU_ECHO_INPUT,
          LABORER_TEST_SHURU_LOG_PATH: process.env.LABORER_TEST_SHURU_LOG_PATH,
          LABORER_TEST_SHURU_SPAWN_STDERR:
            process.env.LABORER_TEST_SHURU_SPAWN_STDERR,
          LABORER_TEST_SHURU_SPAWN_STDOUT:
            process.env.LABORER_TEST_SHURU_SPAWN_STDOUT,
          LABORER_TEST_SHURU_STAT_ERROR:
            process.env.LABORER_TEST_SHURU_STAT_ERROR,
        }

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            restoreEnv(previousEnv)
          })
        )

        const repoPath = initRepo('shuru-dev-server-session', tempRoots)
        const logPath = join(repoPath, 'fake-shuru-log.ndjson')
        writeFileSync(
          join(repoPath, 'laborer.json'),
          `{
  "devServer": {
    "provider": "shuru",
    "setupScripts": ["echo preparing"],
    "startCommand": "npm run dev",
    "workdir": "/workspace"
  }
}`
        )

        process.env.LABORER_SHURU_BIN = `node ${fakeShuruCliPath}`
        process.env.LABORER_TEST_SHURU_ECHO_INPUT = '1'
        process.env.LABORER_TEST_SHURU_LOG_PATH = logPath
        process.env.LABORER_TEST_SHURU_SPAWN_STDERR = 'sandbox stderr\n'
        process.env.LABORER_TEST_SHURU_SPAWN_STDOUT = 'sandbox stdout\n'
        process.env.LABORER_TEST_SHURU_STAT_ERROR = EMPTY_ENV_VALUE

        const projectId = crypto.randomUUID()
        const workspaceId = crypto.randomUUID()

        const { store } = yield* LaborerStore
        store.commit(
          events.projectCreated({
            id: projectId,
            repoPath,
            name: 'shuru-dev-server-session',
            brrrConfig: null,
          })
        )
        store.commit(
          events.workspaceCreated({
            id: workspaceId,
            projectId,
            taskSource: null,
            branchName: 'feature/shuru-dev-server',
            worktreePath: repoPath,
            status: 'running',
            origin: 'laborer',
            createdAt: new Date().toISOString(),
            baseSha: null,
          })
        )

        const sandboxProvider = yield* SandboxProvider
        yield* sandboxProvider.createSandbox({
          workspaceId,
          branchName: 'feature/shuru-dev-server',
          currentBranch: null,
          projectName: 'shuru-dev-server-session',
          repoUrl: null,
          worktreePath: repoPath,
          devServerConfig: {
            autoOpen: false,
            autoStopInterval: null,
            dockerfile: null,
            image: null,
            installCommand: null,
            network: null,
            port: null,
            provider: 'shuru',
            resources: null,
            setupScripts: ['echo preparing'],
            startCommand: 'npm run dev',
            workdir: '/workspace',
          },
        })

        const terminal = yield* sandboxProvider.spawnTerminal(workspaceId, {
          autoRun: true,
        })

        assert.match(terminal.id, SHURU_TERMINAL_ID_PATTERN)

        yield* sandboxProvider.resizeTerminal(terminal.id, 120, 40)

        const { port1, port2 } = new MessageChannel()
        const received: string[] = []
        port2.on('message', (value) => {
          received.push(String(value))
        })

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            port1.close()
            port2.close()
          })
        )

        handleShuruTerminalDataPort(toRpcPort(port1), terminal.id)

        yield* waitFor(
          () =>
            received.some((message) =>
              message.includes('"status":"running"')
            ) &&
            received.some((message) => message.includes('sandbox stdout')) &&
            received.some((message) => message.includes('sandbox stderr')),
          'Expected the Shuru terminal data channel to stream initial output.'
        )

        port2.postMessage('ping')

        yield* waitFor(
          () => received.some((message) => message.includes('stdin:ping')),
          'Expected stdin forwarded through the Shuru terminal data channel.'
        )

        yield* sandboxProvider.killTerminal(terminal.id)

        yield* waitFor(
          () =>
            received.some((message) => message.includes('"status":"stopped"')),
          'Expected the Shuru terminal data channel to report process exit.'
        )

        const logEntries = readLogEntries(logPath)
        const spawnRequest = logEntries.find(
          (entry) => entry.type === 'request' && entry.method === 'spawn'
        )

        assert.deepStrictEqual(spawnRequest?.params, {
          argv: ['sh', '-lc', 'echo preparing\nnpm run dev'],
          cwd: '/workspace',
          env: {
            COLORTERM: 'truecolor',
            TERM: 'xterm-256color',
          },
        })
        assert.isTrue(
          logEntries.some(
            (entry) => entry.type === 'notification' && entry.method === 'input'
          )
        )
        assert.isTrue(
          logEntries.some(
            (entry) => entry.type === 'request' && entry.method === 'kill'
          )
        )
      }).pipe(Effect.provide(ShuruProviderTestLayer))
  )

  it.scopedLive(
    'skips rerunning setup scripts when the Shuru sandbox was restored from a shared checkpoint',
    () =>
      Effect.gen(function* () {
        const previousEnv = {
          LABORER_SHURU_BIN: process.env.LABORER_SHURU_BIN,
          LABORER_TEST_SHURU_CHECKPOINT_DIR:
            process.env.LABORER_TEST_SHURU_CHECKPOINT_DIR,
          LABORER_TEST_SHURU_LOG_PATH: process.env.LABORER_TEST_SHURU_LOG_PATH,
          LABORER_TEST_SHURU_SPAWN_STDERR:
            process.env.LABORER_TEST_SHURU_SPAWN_STDERR,
          LABORER_TEST_SHURU_SPAWN_STDOUT:
            process.env.LABORER_TEST_SHURU_SPAWN_STDOUT,
          LABORER_TEST_SHURU_STAT_ERROR:
            process.env.LABORER_TEST_SHURU_STAT_ERROR,
        }

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            restoreEnv(previousEnv)
          })
        )

        const repoPath = initRepo('shuru-dev-server-checkpoint', tempRoots)
        const checkpointDir = join(repoPath, 'fake-shuru-checkpoints')
        const logPath = join(repoPath, 'fake-shuru-log.ndjson')
        writeFileSync(
          join(repoPath, 'package-lock.json'),
          '{"lockfileVersion":1}'
        )
        writeFileSync(
          join(repoPath, 'laborer.json'),
          `{
  "devServer": {
    "provider": "shuru",
    "setupScripts": ["echo preparing"],
    "startCommand": "npm run dev",
    "workdir": "/workspace"
  }
}`
        )

        process.env.LABORER_SHURU_BIN = `node ${fakeShuruCliPath}`
        process.env.LABORER_TEST_SHURU_CHECKPOINT_DIR = checkpointDir
        process.env.LABORER_TEST_SHURU_LOG_PATH = logPath
        process.env.LABORER_TEST_SHURU_SPAWN_STDERR = ''
        process.env.LABORER_TEST_SHURU_SPAWN_STDOUT = ''
        process.env.LABORER_TEST_SHURU_STAT_ERROR = EMPTY_ENV_VALUE

        const projectId = crypto.randomUUID()
        const workspaceId = crypto.randomUUID()

        const { store } = yield* LaborerStore
        store.commit(
          events.projectCreated({
            id: projectId,
            repoPath,
            name: 'shuru-dev-server-checkpoint',
            brrrConfig: null,
          })
        )
        store.commit(
          events.workspaceCreated({
            id: workspaceId,
            projectId,
            taskSource: null,
            branchName: 'feature/shuru-dev-server-checkpoint',
            worktreePath: repoPath,
            status: 'running',
            origin: 'laborer',
            createdAt: new Date().toISOString(),
            baseSha: null,
          })
        )

        const sandboxProvider = yield* SandboxProvider
        yield* sandboxProvider.createSandbox({
          workspaceId,
          branchName: 'feature/shuru-dev-server-checkpoint',
          currentBranch: null,
          projectName: 'shuru-dev-server-checkpoint',
          repoUrl: null,
          worktreePath: repoPath,
          devServerConfig: {
            autoOpen: false,
            autoStopInterval: null,
            dockerfile: null,
            image: null,
            installCommand: null,
            network: null,
            port: null,
            provider: 'shuru',
            resources: null,
            setupScripts: ['echo preparing'],
            startCommand: 'npm run dev',
            workdir: '/workspace',
          },
        })

        const terminal = yield* sandboxProvider.spawnTerminal(workspaceId, {
          autoRun: true,
        })
        yield* sandboxProvider.killTerminal(terminal.id)

        const logEntries = readLogEntries(logPath)
        const spawnRequest = logEntries.find(
          (entry) => entry.type === 'request' && entry.method === 'spawn'
        )

        assert.deepStrictEqual(spawnRequest?.params, {
          argv: ['sh', '-lc', 'npm run dev'],
          cwd: '/workspace',
          env: {
            COLORTERM: 'truecolor',
            TERM: 'xterm-256color',
          },
        })
      }).pipe(Effect.provide(ShuruProviderTestLayer))
  )
})
