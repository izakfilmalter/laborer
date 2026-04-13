import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assert, describe, it } from '@effect/vitest'
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

const TestLayer = SandboxProviderRoutedLayer.pipe(
  Layer.provideMerge(TestTerminalClient),
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

afterAll(() => {
  for (const root of tempRoots) {
    if (existsSync(root)) {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

const restoreEnv = (
  previousBin: string | undefined,
  previousLogPath: string | undefined,
  previousStatError: string | undefined
): void => {
  if (previousBin === undefined) {
    process.env.LABORER_SHURU_BIN = EMPTY_ENV_VALUE
  } else {
    process.env.LABORER_SHURU_BIN = previousBin
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
        const previousLogPath = process.env.LABORER_TEST_SHURU_LOG_PATH
        const previousStatError = process.env.LABORER_TEST_SHURU_STAT_ERROR

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            restoreEnv(previousBin, previousLogPath, previousStatError)
          })
        )

        const repoPath = initRepo('shuru-router', tempRoots)
        const logPath = join(repoPath, 'fake-shuru-log.ndjson')
        process.env.LABORER_SHURU_BIN = `node ${fakeShuruCliPath}`
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
      const previousLogPath = process.env.LABORER_TEST_SHURU_LOG_PATH
      const previousStatError = process.env.LABORER_TEST_SHURU_STAT_ERROR

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          restoreEnv(previousBin, previousLogPath, previousStatError)
        })
      )

      const repoPath = initRepo('shuru-router-error', tempRoots)
      const logPath = join(repoPath, 'fake-shuru-log.ndjson')
      process.env.LABORER_SHURU_BIN = `node ${fakeShuruCliPath}`
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
        const previousLogPath = process.env.LABORER_TEST_SHURU_LOG_PATH
        const previousStatError = process.env.LABORER_TEST_SHURU_STAT_ERROR

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            restoreEnv(previousBin, previousLogPath, previousStatError)
          })
        )

        const repoPath = initRepo('shuru-router-preview', tempRoots)
        const logPath = join(repoPath, 'fake-shuru-log.ndjson')
        process.env.LABORER_SHURU_BIN = `node ${fakeShuruCliPath}`
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
})
