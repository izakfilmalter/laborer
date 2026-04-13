import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assert, describe, it } from '@effect/vitest'
import { RpcError } from '@laborer/shared/rpc'
import { events, tables } from '@laborer/shared/schema'
import { Effect, Layer } from 'effect'
import { afterAll } from 'vitest'
import { ConfigService } from '../src/services/config-service.js'
import { ContainerService } from '../src/services/container-service.js'
import { DepsImageService } from '../src/services/deps-image-service.js'
import { DockerDetection } from '../src/services/docker-detection.js'
import { LaborerStore } from '../src/services/laborer-store.js'
import { SandboxProvider } from '../src/services/sandbox-provider.js'
import { SandboxProviderRoutedLayer } from '../src/services/sandbox-provider-router.js'
import { getShuruTerminalHandle } from '../src/services/shuru-client.js'
import { ShuruDetection } from '../src/services/shuru-detection.js'
import { TerminalClient } from '../src/services/terminal-client.js'
import { initRepo } from './helpers/git-helpers.js'
import { TestLaborerStore } from './helpers/test-store.js'

const tempRoots: string[] = []
const EMPTY_ENV_VALUE = ''
const fakeShuruCliPath = fileURLToPath(
  new URL('./fixtures/fake-shuru-cli.js', import.meta.url)
)
const SHURU_ID_PATTERN = /^shuru:/
const SHURU_PREVIEW_HOST = '127.0.0.1'

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

const TestTerminalClient = Layer.succeed(
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

const makeSandboxProviderTestLayer = (
  laborerStoreLayer: Layer.Layer<LaborerStore>
) =>
  SandboxProviderRoutedLayer.pipe(
    Layer.provideMerge(TestTerminalClient),
    Layer.provideMerge(TestShuruDetection),
    Layer.provideMerge(TestDockerDetection),
    Layer.provideMerge(TestDepsImageService),
    Layer.provideMerge(TestContainerService),
    Layer.provideMerge(ConfigService.layer),
    Layer.provideMerge(laborerStoreLayer)
  )

const TestLayer = makeSandboxProviderTestLayer(TestLaborerStore)

const readLogEntries = (logPath: string) =>
  readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)

const waitFor = (
  predicate: () => boolean,
  failureMessage: string
): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (predicate()) {
        return
      }

      yield* Effect.sleep('20 millis')
    }

    assert.fail(failureMessage)
  })

const runStateCommand = (
  sandboxProvider: SandboxProvider['Type'],
  workspaceId: string,
  command: string
) =>
  Effect.gen(function* () {
    const terminal = yield* sandboxProvider.spawnTerminal(workspaceId, {
      autoRun: true,
      command,
    })

    yield* waitFor(
      () => getShuruTerminalHandle(terminal.id)?.getExitCode() !== null,
      `Expected Shuru terminal "${terminal.id}" to exit after running "${command}".`
    )

    const handle = getShuruTerminalHandle(terminal.id)
    assert.isDefined(handle)
    if (handle === undefined) {
      assert.fail(`Expected Shuru terminal handle for "${terminal.id}".`)
    }

    const output = handle.getBufferedOutput().trim()
    yield* sandboxProvider.removeTerminal(terminal.id)
    return output
  })

afterAll(() => {
  for (const root of tempRoots) {
    if (existsSync(root)) {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

const restoreEnv = (
  previousBin: string | undefined,
  previousCheckpointDir: string | undefined,
  previousLogPath: string | undefined,
  previousStatError: string | undefined
): void => {
  if (previousBin === undefined) {
    process.env.LABORER_SHURU_BIN = EMPTY_ENV_VALUE
  } else {
    process.env.LABORER_SHURU_BIN = previousBin
  }

  if (previousCheckpointDir === undefined) {
    process.env.LABORER_TEST_SHURU_CHECKPOINT_DIR = EMPTY_ENV_VALUE
  } else {
    process.env.LABORER_TEST_SHURU_CHECKPOINT_DIR = previousCheckpointDir
  }

  if (previousLogPath === undefined) {
    process.env.LABORER_TEST_SHURU_LOG_PATH = EMPTY_ENV_VALUE
  } else {
    process.env.LABORER_TEST_SHURU_LOG_PATH = previousLogPath
  }

  if (previousStatError === undefined) {
    process.env.LABORER_TEST_SHURU_STAT_ERROR = EMPTY_ENV_VALUE
  } else {
    process.env.LABORER_TEST_SHURU_STAT_ERROR = previousStatError
  }
}

describe('SandboxProviderRouter shuru lifecycle', () => {
  it.scoped(
    'creates and destroys a Shuru sandbox through the routed provider',
    () =>
      Effect.gen(function* () {
        const previousBin = process.env.LABORER_SHURU_BIN
        const previousCheckpointDir =
          process.env.LABORER_TEST_SHURU_CHECKPOINT_DIR
        const previousLogPath = process.env.LABORER_TEST_SHURU_LOG_PATH
        const previousStatError = process.env.LABORER_TEST_SHURU_STAT_ERROR

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            restoreEnv(
              previousBin,
              previousCheckpointDir,
              previousLogPath,
              previousStatError
            )
          })
        )

        const repoPath = initRepo('shuru-router', tempRoots)
        const checkpointDir = join(repoPath, 'fake-shuru-checkpoints')
        const logPath = join(repoPath, 'fake-shuru-log.ndjson')
        process.env.LABORER_SHURU_BIN = `node ${fakeShuruCliPath}`
        process.env.LABORER_TEST_SHURU_CHECKPOINT_DIR = checkpointDir
        process.env.LABORER_TEST_SHURU_LOG_PATH = logPath
        process.env.LABORER_TEST_SHURU_STAT_ERROR = EMPTY_ENV_VALUE

        const projectId = crypto.randomUUID()
        const workspaceId = crypto.randomUUID()
        const branchName = 'feature/shuru-router'

        const { store } = yield* LaborerStore
        store.commit(
          events.projectCreated({
            id: projectId,
            repoPath,
            name: 'shuru-router',
            brrrConfig: null,
          })
        )
        store.commit(
          events.workspaceCreated({
            id: workspaceId,
            projectId,
            taskSource: null,
            branchName,
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
          branchName,
          currentBranch: null,
          projectName: 'shuru-router',
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
            setupScripts: [],
            startCommand: null,
            workdir: '/workspace',
          },
        })

        const createdWorkspace = store.query(
          tables.workspaces.where('id', workspaceId)
        )[0]
        assert.isDefined(createdWorkspace)
        if (createdWorkspace === undefined) {
          assert.fail('Expected createSandbox to materialize sandbox metadata')
        }

        assert.match(createdWorkspace.sandboxId ?? '', SHURU_ID_PATTERN)
        assert.strictEqual(createdWorkspace.sandboxProvider, 'shuru')
        assert.strictEqual(createdWorkspace.sandboxStatus, 'running')
        assert.strictEqual(createdWorkspace.sandboxUrl, '')
        assert.strictEqual(createdWorkspace.sandboxImage, 'shuru')

        const createLogEntries = readLogEntries(logPath)
        const argvEntry = createLogEntries.find(
          (entry) => entry.type === 'argv'
        )
        const statEntry = createLogEntries.find(
          (entry) => entry.type === 'request' && entry.method === 'stat'
        )

        assert.deepStrictEqual(argvEntry?.argv, [
          'run',
          '--stdio',
          '--mount',
          `${repoPath}:/workspace:ro`,
        ])
        assert.deepStrictEqual(statEntry?.params, { path: '/workspace' })

        yield* sandboxProvider.destroySandbox(workspaceId)

        const destroyedWorkspace = store.query(
          tables.workspaces.where('id', workspaceId)
        )[0]
        assert.isDefined(destroyedWorkspace)
        if (destroyedWorkspace === undefined) {
          assert.fail('Expected destroySandbox to preserve the workspace row')
        }

        assert.isNull(destroyedWorkspace.sandboxId)
        assert.isNull(destroyedWorkspace.sandboxStatus)
        assert.strictEqual(destroyedWorkspace.sandboxProvider, 'shuru')
        assert.strictEqual(destroyedWorkspace.sandboxUrl, '')

        const destroyLogEntries = readLogEntries(logPath)
        assert.isTrue(
          destroyLogEntries.some((entry) => entry.type === 'stdin-end')
        )
      }).pipe(Effect.provide(TestLayer))
  )

  it.scoped('cleans up the Shuru process when startup validation fails', () =>
    Effect.gen(function* () {
      const previousBin = process.env.LABORER_SHURU_BIN
      const previousCheckpointDir =
        process.env.LABORER_TEST_SHURU_CHECKPOINT_DIR
      const previousLogPath = process.env.LABORER_TEST_SHURU_LOG_PATH
      const previousStatError = process.env.LABORER_TEST_SHURU_STAT_ERROR

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          restoreEnv(
            previousBin,
            previousCheckpointDir,
            previousLogPath,
            previousStatError
          )
        })
      )

      const repoPath = initRepo('shuru-router-error', tempRoots)
      const checkpointDir = join(repoPath, 'fake-shuru-checkpoints')
      const logPath = join(repoPath, 'fake-shuru-log.ndjson')
      process.env.LABORER_SHURU_BIN = `node ${fakeShuruCliPath}`
      process.env.LABORER_TEST_SHURU_CHECKPOINT_DIR = checkpointDir
      process.env.LABORER_TEST_SHURU_LOG_PATH = logPath
      process.env.LABORER_TEST_SHURU_STAT_ERROR = '1'

      const projectId = crypto.randomUUID()
      const workspaceId = crypto.randomUUID()

      const { store } = yield* LaborerStore
      store.commit(
        events.projectCreated({
          id: projectId,
          repoPath,
          name: 'shuru-router-error',
          brrrConfig: null,
        })
      )
      store.commit(
        events.workspaceCreated({
          id: workspaceId,
          projectId,
          taskSource: null,
          branchName: 'feature/shuru-router-error',
          worktreePath: repoPath,
          status: 'running',
          origin: 'laborer',
          createdAt: new Date().toISOString(),
          baseSha: null,
        })
      )

      const sandboxProvider = yield* SandboxProvider
      const result = yield* sandboxProvider
        .createSandbox({
          workspaceId,
          branchName: 'feature/shuru-router-error',
          currentBranch: null,
          projectName: 'shuru-router-error',
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
            setupScripts: [],
            startCommand: null,
            workdir: '/workspace',
          },
        })
        .pipe(Effect.either)

      assert.isTrue(result._tag === 'Left')
      if (result._tag !== 'Left') {
        assert.fail(
          'Expected createSandbox to fail when /workspace validation fails'
        )
      }

      assert.strictEqual(result.left.code, 'SHURU_START_FAILED')

      const failedWorkspace = store.query(
        tables.workspaces.where('id', workspaceId)
      )[0]
      assert.isDefined(failedWorkspace)
      if (failedWorkspace === undefined) {
        assert.fail('Expected the workspace row to remain after failure')
      }

      assert.isNull(failedWorkspace.sandboxId)
      assert.isNull(failedWorkspace.sandboxStatus)

      const logEntries = readLogEntries(logPath)
      assert.isTrue(logEntries.some((entry) => entry.type === 'stdin-end'))
    }).pipe(Effect.provide(TestLayer))
  )

  it.scoped(
    'allocates unique localhost preview ports for Shuru workspaces',
    () =>
      Effect.gen(function* () {
        const previousBin = process.env.LABORER_SHURU_BIN
        const previousCheckpointDir =
          process.env.LABORER_TEST_SHURU_CHECKPOINT_DIR
        const previousLogPath = process.env.LABORER_TEST_SHURU_LOG_PATH
        const previousStatError = process.env.LABORER_TEST_SHURU_STAT_ERROR

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            restoreEnv(
              previousBin,
              previousCheckpointDir,
              previousLogPath,
              previousStatError
            )
          })
        )

        const repoPath = initRepo('shuru-router-preview', tempRoots)
        const checkpointDir = join(repoPath, 'fake-shuru-checkpoints')
        const logPath = join(repoPath, 'fake-shuru-log.ndjson')
        process.env.LABORER_SHURU_BIN = `node ${fakeShuruCliPath}`
        process.env.LABORER_TEST_SHURU_CHECKPOINT_DIR = checkpointDir
        process.env.LABORER_TEST_SHURU_LOG_PATH = logPath
        process.env.LABORER_TEST_SHURU_STAT_ERROR = EMPTY_ENV_VALUE

        const projectId = crypto.randomUUID()
        const firstWorkspaceId = crypto.randomUUID()
        const secondWorkspaceId = crypto.randomUUID()

        const { store } = yield* LaborerStore
        store.commit(
          events.projectCreated({
            id: projectId,
            repoPath,
            name: 'shuru-router-preview',
            brrrConfig: null,
          })
        )

        for (const [workspaceId, branchName] of [
          [firstWorkspaceId, 'feature/shuru-preview-one'],
          [secondWorkspaceId, 'feature/shuru-preview-two'],
        ] as const) {
          store.commit(
            events.workspaceCreated({
              id: workspaceId,
              projectId,
              taskSource: null,
              branchName,
              worktreePath: repoPath,
              status: 'running',
              origin: 'laborer',
              createdAt: new Date().toISOString(),
              baseSha: null,
            })
          )
        }

        const sandboxProvider = yield* SandboxProvider
        const createSandbox = (workspaceId: string, branchName: string) =>
          sandboxProvider.createSandbox({
            workspaceId,
            branchName,
            currentBranch: null,
            projectName: 'shuru-router-preview',
            repoUrl: null,
            worktreePath: repoPath,
            devServerConfig: {
              autoOpen: false,
              autoStopInterval: null,
              dockerfile: null,
              image: null,
              installCommand: null,
              network: null,
              port: 3000,
              provider: 'shuru',
              resources: null,
              setupScripts: [],
              startCommand: null,
              workdir: '/workspace',
            },
          })

        yield* createSandbox(firstWorkspaceId, 'feature/shuru-preview-one')
        yield* createSandbox(secondWorkspaceId, 'feature/shuru-preview-two')

        const firstWorkspace = store.query(
          tables.workspaces.where('id', firstWorkspaceId)
        )[0]
        const secondWorkspace = store.query(
          tables.workspaces.where('id', secondWorkspaceId)
        )[0]

        assert.isDefined(firstWorkspace)
        assert.isDefined(secondWorkspace)
        if (firstWorkspace === undefined || secondWorkspace === undefined) {
          assert.fail('Expected both Shuru workspaces to be materialized')
        }

        assert.strictEqual(firstWorkspace.sandboxUrl, SHURU_PREVIEW_HOST)
        assert.strictEqual(secondWorkspace.sandboxUrl, SHURU_PREVIEW_HOST)
        assert.isTrue(typeof firstWorkspace.sandboxPort === 'number')
        assert.isTrue(typeof secondWorkspace.sandboxPort === 'number')
        assert.notStrictEqual(
          firstWorkspace.sandboxPort,
          secondWorkspace.sandboxPort
        )

        const firstPreviewUrl = yield* sandboxProvider.getPreviewUrl(
          firstWorkspaceId,
          3000
        )
        const secondPreviewUrl = yield* sandboxProvider.getPreviewUrl(
          secondWorkspaceId,
          3000
        )

        assert.strictEqual(
          firstPreviewUrl,
          `http://${SHURU_PREVIEW_HOST}:${String(firstWorkspace.sandboxPort)}`
        )
        assert.strictEqual(
          secondPreviewUrl,
          `http://${SHURU_PREVIEW_HOST}:${String(secondWorkspace.sandboxPort)}`
        )

        const argvEntries = readLogEntries(logPath).filter(
          (entry) => entry.type === 'argv'
        )
        assert.deepStrictEqual(argvEntries[0]?.argv, [
          'run',
          '--stdio',
          '--mount',
          `${repoPath}:/workspace:ro`,
          '-p',
          `${String(firstWorkspace.sandboxPort)}:3000`,
        ])
        assert.deepStrictEqual(argvEntries[1]?.argv, [
          'run',
          '--stdio',
          '--mount',
          `${repoPath}:/workspace:ro`,
          '-p',
          `${String(secondWorkspace.sandboxPort)}:3000`,
        ])
      }).pipe(Effect.provide(TestLayer))
  )

  it.scoped(
    'reuses a shared base checkpoint across unchanged Shuru workspaces',
    () =>
      Effect.gen(function* () {
        const previousBin = process.env.LABORER_SHURU_BIN
        const previousCheckpointDir =
          process.env.LABORER_TEST_SHURU_CHECKPOINT_DIR
        const previousLogPath = process.env.LABORER_TEST_SHURU_LOG_PATH
        const previousStatError = process.env.LABORER_TEST_SHURU_STAT_ERROR

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            restoreEnv(
              previousBin,
              previousCheckpointDir,
              previousLogPath,
              previousStatError
            )
          })
        )

        const repoPath = initRepo('shuru-router-base-checkpoint', tempRoots)
        const checkpointDir = join(repoPath, 'fake-shuru-checkpoints')
        const logPath = join(repoPath, 'fake-shuru-log.ndjson')
        writeFileSync(
          join(repoPath, 'package-lock.json'),
          JSON.stringify({ lockfileVersion: 1, name: 'checkpoint-test' })
        )

        process.env.LABORER_SHURU_BIN = `node ${fakeShuruCliPath}`
        process.env.LABORER_TEST_SHURU_CHECKPOINT_DIR = checkpointDir
        process.env.LABORER_TEST_SHURU_LOG_PATH = logPath
        process.env.LABORER_TEST_SHURU_STAT_ERROR = EMPTY_ENV_VALUE

        const projectId = crypto.randomUUID()
        const firstWorkspaceId = crypto.randomUUID()
        const secondWorkspaceId = crypto.randomUUID()

        const { store } = yield* LaborerStore
        store.commit(
          events.projectCreated({
            id: projectId,
            repoPath,
            name: 'shuru-router-base-checkpoint',
            brrrConfig: null,
          })
        )

        for (const [workspaceId, branchName] of [
          [firstWorkspaceId, 'feature/shuru-base-checkpoint-one'],
          [secondWorkspaceId, 'feature/shuru-base-checkpoint-two'],
        ] as const) {
          store.commit(
            events.workspaceCreated({
              id: workspaceId,
              projectId,
              taskSource: null,
              branchName,
              worktreePath: repoPath,
              status: 'running',
              origin: 'laborer',
              createdAt: new Date().toISOString(),
              baseSha: null,
            })
          )
        }

        const sandboxProvider = yield* SandboxProvider
        const createSandbox = (workspaceId: string, branchName: string) =>
          sandboxProvider.createSandbox({
            workspaceId,
            branchName,
            currentBranch: null,
            projectName: 'shuru-router-base-checkpoint',
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
              startCommand: null,
              workdir: '/workspace',
            },
          })

        yield* createSandbox(
          firstWorkspaceId,
          'feature/shuru-base-checkpoint-one'
        )
        yield* createSandbox(
          secondWorkspaceId,
          'feature/shuru-base-checkpoint-two'
        )

        const firstWorkspace = store.query(
          tables.workspaces.where('id', firstWorkspaceId)
        )[0]
        const secondWorkspace = store.query(
          tables.workspaces.where('id', secondWorkspaceId)
        )[0]

        assert.isDefined(firstWorkspace)
        assert.isDefined(secondWorkspace)
        if (firstWorkspace === undefined || secondWorkspace === undefined) {
          assert.fail('Expected both checkpoint-backed workspaces to exist')
        }

        assert.isTrue(
          firstWorkspace.sandboxImage?.startsWith('shuru-checkpoint:') === true
        )
        assert.strictEqual(
          secondWorkspace.sandboxImage,
          firstWorkspace.sandboxImage
        )

        const checkpointName = firstWorkspace.sandboxImage?.replace(
          'shuru-checkpoint:',
          ''
        )

        const logEntries = readLogEntries(logPath)
        const argvEntries = logEntries.filter((entry) => entry.type === 'argv')
        const execRequests = logEntries.filter(
          (entry) => entry.type === 'request' && entry.method === 'exec'
        )
        const checkpointRequests = logEntries.filter(
          (entry) => entry.type === 'request' && entry.method === 'checkpoint'
        )

        assert.strictEqual(execRequests.length, 1)
        assert.strictEqual(checkpointRequests.length, 1)
        assert.deepStrictEqual(argvEntries[0]?.argv, [
          'run',
          '--stdio',
          '--allow-net',
          '--mount',
          `${repoPath}:/workspace:ro`,
        ])
        assert.deepStrictEqual(argvEntries[1]?.argv, [
          'run',
          '--stdio',
          '--from',
          checkpointName,
          '--mount',
          `${repoPath}:/workspace:ro`,
        ])
        assert.deepStrictEqual(argvEntries[2]?.argv, [
          'run',
          '--stdio',
          '--from',
          checkpointName,
          '--mount',
          `${repoPath}:/workspace:ro`,
        ])
      }).pipe(Effect.provide(TestLayer))
  )

  it.scoped(
    'rebuilds the shared base checkpoint when the lockfile changes',
    () =>
      Effect.gen(function* () {
        const previousBin = process.env.LABORER_SHURU_BIN
        const previousCheckpointDir =
          process.env.LABORER_TEST_SHURU_CHECKPOINT_DIR
        const previousLogPath = process.env.LABORER_TEST_SHURU_LOG_PATH
        const previousStatError = process.env.LABORER_TEST_SHURU_STAT_ERROR

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            restoreEnv(
              previousBin,
              previousCheckpointDir,
              previousLogPath,
              previousStatError
            )
          })
        )

        const repoPath = initRepo(
          'shuru-router-checkpoint-invalidation',
          tempRoots
        )
        const checkpointDir = join(repoPath, 'fake-shuru-checkpoints')
        const logPath = join(repoPath, 'fake-shuru-log.ndjson')
        writeFileSync(
          join(repoPath, 'package-lock.json'),
          JSON.stringify({ lockfileVersion: 1, name: 'checkpoint-test' })
        )

        process.env.LABORER_SHURU_BIN = `node ${fakeShuruCliPath}`
        process.env.LABORER_TEST_SHURU_CHECKPOINT_DIR = checkpointDir
        process.env.LABORER_TEST_SHURU_LOG_PATH = logPath
        process.env.LABORER_TEST_SHURU_STAT_ERROR = EMPTY_ENV_VALUE

        const projectId = crypto.randomUUID()
        const firstWorkspaceId = crypto.randomUUID()
        const secondWorkspaceId = crypto.randomUUID()

        const { store } = yield* LaborerStore
        store.commit(
          events.projectCreated({
            id: projectId,
            repoPath,
            name: 'shuru-router-checkpoint-invalidation',
            brrrConfig: null,
          })
        )

        const createWorkspace = (workspaceId: string, branchName: string) => {
          store.commit(
            events.workspaceCreated({
              id: workspaceId,
              projectId,
              taskSource: null,
              branchName,
              worktreePath: repoPath,
              status: 'running',
              origin: 'laborer',
              createdAt: new Date().toISOString(),
              baseSha: null,
            })
          )
        }

        createWorkspace(firstWorkspaceId, 'feature/shuru-checkpoint-first')

        const sandboxProvider = yield* SandboxProvider
        const createSandbox = (workspaceId: string, branchName: string) =>
          sandboxProvider.createSandbox({
            workspaceId,
            branchName,
            currentBranch: null,
            projectName: 'shuru-router-checkpoint-invalidation',
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
              startCommand: null,
              workdir: '/workspace',
            },
          })

        yield* createSandbox(firstWorkspaceId, 'feature/shuru-checkpoint-first')

        const firstWorkspace = store.query(
          tables.workspaces.where('id', firstWorkspaceId)
        )[0]
        assert.isDefined(firstWorkspace)
        if (firstWorkspace === undefined) {
          assert.fail('Expected the first checkpoint-backed workspace to exist')
        }

        writeFileSync(
          join(repoPath, 'package-lock.json'),
          JSON.stringify({ lockfileVersion: 2, name: 'checkpoint-test' })
        )

        createWorkspace(secondWorkspaceId, 'feature/shuru-checkpoint-second')
        yield* createSandbox(
          secondWorkspaceId,
          'feature/shuru-checkpoint-second'
        )

        const secondWorkspace = store.query(
          tables.workspaces.where('id', secondWorkspaceId)
        )[0]
        assert.isDefined(secondWorkspace)
        if (secondWorkspace === undefined) {
          assert.fail(
            'Expected the second checkpoint-backed workspace to exist'
          )
        }

        assert.notStrictEqual(
          firstWorkspace.sandboxImage,
          secondWorkspace.sandboxImage
        )

        const logEntries = readLogEntries(logPath)
        const execRequests = logEntries.filter(
          (entry) => entry.type === 'request' && entry.method === 'exec'
        )
        const checkpointRequests = logEntries.filter(
          (entry) => entry.type === 'request' && entry.method === 'checkpoint'
        )

        assert.strictEqual(execRequests.length, 2)
        assert.strictEqual(checkpointRequests.length, 2)
      }).pipe(Effect.provide(TestLayer))
  )

  it.scoped(
    'restores paused Shuru sandboxes from a workspace runtime checkpoint',
    () =>
      Effect.gen(function* () {
        const previousBin = process.env.LABORER_SHURU_BIN
        const previousCheckpointDir =
          process.env.LABORER_TEST_SHURU_CHECKPOINT_DIR
        const previousLogPath = process.env.LABORER_TEST_SHURU_LOG_PATH
        const previousStatError = process.env.LABORER_TEST_SHURU_STAT_ERROR

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            restoreEnv(
              previousBin,
              previousCheckpointDir,
              previousLogPath,
              previousStatError
            )
          })
        )

        const repoPath = initRepo('shuru-router-runtime-checkpoint', tempRoots)
        const checkpointDir = join(repoPath, 'fake-shuru-checkpoints')
        const logPath = join(repoPath, 'fake-shuru-log.ndjson')
        writeFileSync(
          join(repoPath, 'package-lock.json'),
          JSON.stringify({
            lockfileVersion: 1,
            name: 'runtime-checkpoint-test',
          })
        )

        process.env.LABORER_SHURU_BIN = `node ${fakeShuruCliPath}`
        process.env.LABORER_TEST_SHURU_CHECKPOINT_DIR = checkpointDir
        process.env.LABORER_TEST_SHURU_LOG_PATH = logPath
        process.env.LABORER_TEST_SHURU_STAT_ERROR = EMPTY_ENV_VALUE

        const projectId = crypto.randomUUID()
        const workspaceId = crypto.randomUUID()

        const { store } = yield* LaborerStore
        store.commit(
          events.projectCreated({
            id: projectId,
            repoPath,
            name: 'shuru-router-runtime-checkpoint',
            brrrConfig: null,
          })
        )
        store.commit(
          events.workspaceCreated({
            id: workspaceId,
            projectId,
            taskSource: null,
            branchName: 'feature/shuru-runtime-checkpoint',
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
          branchName: 'feature/shuru-runtime-checkpoint',
          currentBranch: null,
          projectName: 'shuru-router-runtime-checkpoint',
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
            startCommand: null,
            workdir: '/workspace',
          },
        })

        const runtimeState = 'runtime-only-state'
        const setOutput = yield* runStateCommand(
          sandboxProvider,
          workspaceId,
          `laborer-test-state set ${runtimeState}`
        )
        assert.strictEqual(setOutput, runtimeState)

        const runningWorkspace = store.query(
          tables.workspaces.where('id', workspaceId)
        )[0]
        assert.isDefined(runningWorkspace)
        if (runningWorkspace === undefined) {
          assert.fail('Expected the Shuru workspace to exist before pause.')
        }

        const pausedFromSandboxId = runningWorkspace.sandboxId

        yield* sandboxProvider.pauseSandbox(workspaceId)

        const pausedWorkspace = store.query(
          tables.workspaces.where('id', workspaceId)
        )[0]
        assert.isDefined(pausedWorkspace)
        if (pausedWorkspace === undefined) {
          assert.fail('Expected the Shuru workspace to exist after pause.')
        }

        assert.strictEqual(pausedWorkspace.sandboxStatus, 'paused')

        yield* sandboxProvider.resumeSandbox(workspaceId)

        const resumedState = yield* runStateCommand(
          sandboxProvider,
          workspaceId,
          'laborer-test-state get'
        )
        assert.strictEqual(resumedState, runtimeState)

        const resumedWorkspace = store.query(
          tables.workspaces.where('id', workspaceId)
        )[0]
        assert.isDefined(resumedWorkspace)
        if (resumedWorkspace === undefined) {
          assert.fail('Expected the Shuru workspace to exist after resume.')
        }

        assert.strictEqual(resumedWorkspace.sandboxStatus, 'running')
        assert.match(resumedWorkspace.sandboxId ?? '', SHURU_ID_PATTERN)
        assert.notStrictEqual(resumedWorkspace.sandboxId, pausedFromSandboxId)

        const logEntries = readLogEntries(logPath)
        const argvEntries = logEntries.filter((entry) => entry.type === 'argv')
        const checkpointRequests = logEntries.filter(
          (entry) => entry.type === 'request' && entry.method === 'checkpoint'
        )
        const runtimeCheckpointRequest = checkpointRequests.at(-1)
        const runtimeCheckpointParams =
          typeof runtimeCheckpointRequest?.params === 'object' &&
          runtimeCheckpointRequest.params !== null
            ? (runtimeCheckpointRequest.params as Record<string, unknown>)
            : null
        const runtimeCheckpointName =
          typeof runtimeCheckpointParams?.name === 'string'
            ? runtimeCheckpointParams.name
            : null

        assert.strictEqual(checkpointRequests.length, 2)
        assert.isTrue(
          runtimeCheckpointName?.startsWith('laborer-shuru-runtime-') === true
        )
        assert.deepStrictEqual(argvEntries.at(-1)?.argv, [
          'run',
          '--stdio',
          '--from',
          runtimeCheckpointName,
          '--mount',
          `${repoPath}:/workspace:ro`,
        ])
      }).pipe(Effect.provide(TestLayer))
  )

  it.scoped(
    'falls back to the shared base checkpoint when no runtime checkpoint metadata exists',
    () =>
      Effect.gen(function* () {
        const previousBin = process.env.LABORER_SHURU_BIN
        const previousCheckpointDir =
          process.env.LABORER_TEST_SHURU_CHECKPOINT_DIR
        const previousLogPath = process.env.LABORER_TEST_SHURU_LOG_PATH
        const previousStatError = process.env.LABORER_TEST_SHURU_STAT_ERROR

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            restoreEnv(
              previousBin,
              previousCheckpointDir,
              previousLogPath,
              previousStatError
            )
          })
        )

        const repoPath = initRepo('shuru-router-runtime-fallback', tempRoots)
        const checkpointDir = join(repoPath, 'fake-shuru-checkpoints')
        const logPath = join(repoPath, 'fake-shuru-log.ndjson')
        writeFileSync(
          join(repoPath, 'package-lock.json'),
          JSON.stringify({ lockfileVersion: 1, name: 'runtime-fallback-test' })
        )

        process.env.LABORER_SHURU_BIN = `node ${fakeShuruCliPath}`
        process.env.LABORER_TEST_SHURU_CHECKPOINT_DIR = checkpointDir
        process.env.LABORER_TEST_SHURU_LOG_PATH = logPath
        process.env.LABORER_TEST_SHURU_STAT_ERROR = EMPTY_ENV_VALUE

        const projectId = crypto.randomUUID()
        const workspaceId = crypto.randomUUID()

        const laborerStore = yield* LaborerStore
        const { store } = laborerStore

        store.commit(
          events.projectCreated({
            id: projectId,
            repoPath,
            name: 'shuru-router-runtime-fallback',
            brrrConfig: null,
          })
        )
        store.commit(
          events.workspaceCreated({
            id: workspaceId,
            projectId,
            taskSource: null,
            branchName: 'feature/shuru-runtime-fallback',
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
          branchName: 'feature/shuru-runtime-fallback',
          currentBranch: null,
          projectName: 'shuru-router-runtime-fallback',
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
            startCommand: null,
            workdir: '/workspace',
          },
        })

        yield* runStateCommand(
          sandboxProvider,
          workspaceId,
          'laborer-test-state set ephemeral-runtime-state'
        )
        yield* sandboxProvider.pauseSandbox(workspaceId)

        const pausedWorkspace = store.query(
          tables.workspaces.where('id', workspaceId)
        )[0]
        assert.isDefined(pausedWorkspace)
        if (pausedWorkspace === undefined) {
          assert.fail('Expected the paused Shuru workspace to exist.')
        }

        const baseCheckpointName = pausedWorkspace.sandboxImage?.replace(
          'shuru-checkpoint:',
          ''
        )

        const freshProviderLayer = makeSandboxProviderTestLayer(
          Layer.succeed(LaborerStore, laborerStore)
        )

        const restoredState = yield* Effect.gen(function* () {
          const freshProvider = yield* SandboxProvider
          yield* freshProvider.resumeSandbox(workspaceId)
          return yield* runStateCommand(
            freshProvider,
            workspaceId,
            'laborer-test-state get'
          )
        }).pipe(Effect.provide(freshProviderLayer))

        assert.strictEqual(restoredState, '')

        const resumedWorkspace = store.query(
          tables.workspaces.where('id', workspaceId)
        )[0]
        assert.isDefined(resumedWorkspace)
        if (resumedWorkspace === undefined) {
          assert.fail('Expected the resumed Shuru workspace to exist.')
        }

        assert.strictEqual(resumedWorkspace.sandboxStatus, 'running')

        const logEntries = readLogEntries(logPath)
        const argvEntries = logEntries.filter((entry) => entry.type === 'argv')

        assert.deepStrictEqual(argvEntries.at(-1)?.argv, [
          'run',
          '--stdio',
          '--from',
          baseCheckpointName,
          '--mount',
          `${repoPath}:/workspace:ro`,
        ])
      }).pipe(Effect.provide(TestLayer))
  )

  it.scoped(
    'pauses stale running Shuru workspaces on provider startup and keeps them resumable',
    () =>
      Effect.gen(function* () {
        const previousBin = process.env.LABORER_SHURU_BIN
        const previousCheckpointDir =
          process.env.LABORER_TEST_SHURU_CHECKPOINT_DIR
        const previousLogPath = process.env.LABORER_TEST_SHURU_LOG_PATH
        const previousStatError = process.env.LABORER_TEST_SHURU_STAT_ERROR

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            restoreEnv(
              previousBin,
              previousCheckpointDir,
              previousLogPath,
              previousStatError
            )
          })
        )

        const repoPath = initRepo('shuru-router-reconcile', tempRoots)
        const checkpointDir = join(repoPath, 'fake-shuru-checkpoints')
        const logPath = join(repoPath, 'fake-shuru-log.ndjson')
        process.env.LABORER_SHURU_BIN = `node ${fakeShuruCliPath}`
        process.env.LABORER_TEST_SHURU_CHECKPOINT_DIR = checkpointDir
        process.env.LABORER_TEST_SHURU_LOG_PATH = logPath
        process.env.LABORER_TEST_SHURU_STAT_ERROR = EMPTY_ENV_VALUE

        const projectId = crypto.randomUUID()
        const workspaceId = crypto.randomUUID()
        const laborerStore = yield* LaborerStore
        const { store } = laborerStore

        store.commit(
          events.projectCreated({
            id: projectId,
            repoPath,
            name: 'shuru-router-reconcile',
            brrrConfig: null,
          })
        )
        store.commit(
          events.workspaceCreated({
            id: workspaceId,
            projectId,
            taskSource: null,
            branchName: 'feature/shuru-reconcile',
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
            sandboxId: 'shuru:stale-runtime',
            sandboxUrl: '',
            sandboxImage: 'shuru',
            sandboxProvider: 'shuru',
          })
        )

        const freshProviderLayer = makeSandboxProviderTestLayer(
          Layer.succeed(LaborerStore, laborerStore)
        )

        yield* Effect.gen(function* () {
          const freshProvider = yield* SandboxProvider

          const reconciledWorkspace = store.query(
            tables.workspaces.where('id', workspaceId)
          )[0]
          assert.isDefined(reconciledWorkspace)
          if (reconciledWorkspace === undefined) {
            assert.fail('Expected the stale Shuru workspace to exist.')
          }

          assert.strictEqual(reconciledWorkspace.sandboxStatus, 'paused')
          assert.strictEqual(
            reconciledWorkspace.sandboxId,
            'shuru:stale-runtime'
          )

          yield* freshProvider.resumeSandbox(workspaceId)

          const resumedWorkspace = store.query(
            tables.workspaces.where('id', workspaceId)
          )[0]
          assert.isDefined(resumedWorkspace)
          if (resumedWorkspace === undefined) {
            assert.fail('Expected the reconciled Shuru workspace to resume.')
          }

          assert.strictEqual(resumedWorkspace.sandboxStatus, 'running')
          assert.match(resumedWorkspace.sandboxId ?? '', SHURU_ID_PATTERN)
        }).pipe(Effect.provide(freshProviderLayer))
      }).pipe(Effect.provide(TestLaborerStore))
  )

  it.scoped('cleans up Shuru runtime state when post-start setup fails', () =>
    Effect.gen(function* () {
      const previousBin = process.env.LABORER_SHURU_BIN
      const previousCheckpointDir =
        process.env.LABORER_TEST_SHURU_CHECKPOINT_DIR
      const previousLogPath = process.env.LABORER_TEST_SHURU_LOG_PATH
      const previousStatError = process.env.LABORER_TEST_SHURU_STAT_ERROR

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          restoreEnv(
            previousBin,
            previousCheckpointDir,
            previousLogPath,
            previousStatError
          )
        })
      )

      const repoPath = initRepo('shuru-router-onready-failure', tempRoots)
      const checkpointDir = join(repoPath, 'fake-shuru-checkpoints')
      const logPath = join(repoPath, 'fake-shuru-log.ndjson')
      process.env.LABORER_SHURU_BIN = `node ${fakeShuruCliPath}`
      process.env.LABORER_TEST_SHURU_CHECKPOINT_DIR = checkpointDir
      process.env.LABORER_TEST_SHURU_LOG_PATH = logPath
      process.env.LABORER_TEST_SHURU_STAT_ERROR = EMPTY_ENV_VALUE

      const projectId = crypto.randomUUID()
      const workspaceId = crypto.randomUUID()

      const { store } = yield* LaborerStore
      store.commit(
        events.projectCreated({
          id: projectId,
          repoPath,
          name: 'shuru-router-onready-failure',
          brrrConfig: null,
        })
      )
      store.commit(
        events.workspaceCreated({
          id: workspaceId,
          projectId,
          taskSource: null,
          branchName: 'feature/shuru-onready-failure',
          worktreePath: repoPath,
          status: 'running',
          origin: 'laborer',
          createdAt: new Date().toISOString(),
          baseSha: null,
        })
      )

      const sandboxProvider = yield* SandboxProvider
      const result = yield* sandboxProvider
        .createSandbox({
          workspaceId,
          branchName: 'feature/shuru-onready-failure',
          currentBranch: null,
          projectName: 'shuru-router-onready-failure',
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
            setupScripts: [],
            startCommand: null,
            workdir: '/workspace',
          },
          onReady: () =>
            Effect.fail(
              new RpcError({
                message: 'post-start Shuru setup failed',
                code: 'TEST_ON_READY_FAILED',
              })
            ),
        })
        .pipe(Effect.either)

      assert.isTrue(result._tag === 'Left')
      if (result._tag !== 'Left') {
        assert.fail('Expected createSandbox to fail when onReady fails')
      }

      assert.strictEqual(result.left.code, 'TEST_ON_READY_FAILED')

      const failedWorkspace = store.query(
        tables.workspaces.where('id', workspaceId)
      )[0]
      assert.isDefined(failedWorkspace)
      if (failedWorkspace === undefined) {
        assert.fail('Expected the Shuru workspace row to remain after failure.')
      }

      assert.isNull(failedWorkspace.sandboxId)
      assert.isNull(failedWorkspace.sandboxStatus)

      const logEntries = readLogEntries(logPath)
      assert.isTrue(logEntries.some((entry) => entry.type === 'stdin-end'))
    }).pipe(Effect.provide(TestLayer))
  )
})
