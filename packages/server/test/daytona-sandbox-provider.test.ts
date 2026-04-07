/**
 * Tests for DaytonaSandboxProvider — Issues 13, 14, 15 & 19
 *
 * Issue 13: Verifies createSandbox with a mocked DaytonaClient, ensuring correct
 * SDK parameters and LiveStore event commits. No real API calls.
 *
 * Issue 14: Verifies destroySandbox lifecycle — deletion, idempotent handling of
 * already-destroyed sandboxes, graceful skip when workspace is missing or has no
 * sandboxId, and best-effort cleanup when delete fails.
 *
 * Issue 15: Verifies git sync — pushing worktree HEAD to sandbox via SSH.
 * Tests that createSshAccess is called, git init is executed in the sandbox,
 * local git remote is added/pushed/cleaned up, and checkout is executed.
 *
 * Issue 19: Verifies pauseSandbox and resumeSandbox idempotency — pausing
 * an already-stopped/archived sandbox skips the SDK stop call, resuming an
 * already-started sandbox skips the SDK start call. Also tests
 * setAutoStopInterval delegation to the SDK.
 */

import { rmSync } from 'node:fs'
import { CodeLanguage } from '@daytonaio/sdk'
import { assert, describe, it } from '@effect/vitest'
import { RpcError } from '@laborer/shared/rpc'
import { events, tables } from '@laborer/shared/schema'
import { Effect, Layer, Ref } from 'effect'
import { afterAll, beforeEach, vi } from 'vitest'
import type {
  DaytonaPaginatedSandboxes,
  DaytonaSandbox,
} from '../../server/src/services/daytona-client.js'
import { DaytonaClient } from '../../server/src/services/daytona-client.js'
import { DaytonaSandboxProvider } from '../../server/src/services/daytona-sandbox-provider.js'
import { LaborerStore } from '../../server/src/services/laborer-store.js'
import { SandboxProvider } from '../../server/src/services/sandbox-provider.js'
import { initRepo } from './helpers/git-helpers.js'
import { TestLaborerStore } from './helpers/test-store.js'

// ---------------------------------------------------------------------------
// Mock spawnGit to prevent real SSH connections during unit tests.
// The mock records calls and returns success exit codes.
// ---------------------------------------------------------------------------

const spawnGitCalls: Array<{ args: readonly string[]; cwd: string }> = []

vi.mock('../../server/src/lib/spawn-git.js', () => ({
  spawnGit: (
    args: readonly string[],
    options: { cwd: string; env?: Record<string, string>; timeoutMs?: number }
  ) => {
    spawnGitCalls.push({ args: [...args], cwd: options.cwd })
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' })
  },
}))

// ---------------------------------------------------------------------------
// Types & helpers
// ---------------------------------------------------------------------------

interface MockCallRecord {
  readonly args: readonly unknown[]
  readonly method: string
}

const makeMockSandbox = (log?: MockCallRecord[]): DaytonaSandbox =>
  ({
    id: 'sandbox-test-123',
    name: 'test-sandbox',
    state: 'started',
    organizationId: 'org-1',
    user: 'daytona',
    env: {},
    labels: {},
    public: false,
    target: 'us',
    cpu: 2,
    gpu: 0,
    memory: 4,
    disk: 20,
    networkBlockAll: false,
    toolboxProxyUrl: 'https://toolbox.test',
    fs: {} as DaytonaSandbox['fs'],
    git: {} as DaytonaSandbox['git'],
    process: {
      executeCommand: (...args: unknown[]) => {
        log?.push({ method: 'sandbox.process.executeCommand', args })
        return Promise.resolve({ exitCode: 0, result: '' })
      },
    } as unknown as DaytonaSandbox['process'],
    computerUse: {} as DaytonaSandbox['computerUse'],
    codeInterpreter: {} as DaytonaSandbox['codeInterpreter'],
    createSshAccess: (...args: unknown[]) => {
      log?.push({ method: 'sandbox.createSshAccess', args })
      return Promise.resolve({
        id: 'ssh-access-1',
        sandboxId: 'sandbox-test-123',
        token: 'test-ssh-token-abc',
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        createdAt: new Date(),
        updatedAt: new Date(),
        sshCommand: 'ssh -p 2222 test-ssh-token-abc@ssh.app.daytona.io',
      })
    },
    getPreviewLink: () =>
      Promise.resolve({
        url: 'https://3000-sandbox-test-123.preview.daytona.io',
        token: '',
      }),
  }) as unknown as DaytonaSandbox

// ---------------------------------------------------------------------------
// Mock layers
// ---------------------------------------------------------------------------

const makeMockClientLayer = (
  log: MockCallRecord[]
): Layer.Layer<DaytonaClient> => {
  const sb = makeMockSandbox(log)
  return Layer.succeed(
    DaytonaClient,
    DaytonaClient.of({
      create: (...args) =>
        Effect.sync(() => {
          log.push({ method: 'create', args })
          return sb
        }),
      createFromSnapshot: (...args) =>
        Effect.sync(() => {
          log.push({ method: 'createFromSnapshot', args })
          return sb
        }),
      get: (...args) =>
        Effect.sync(() => {
          log.push({ method: 'get', args })
          return sb
        }),
      list: (...args) =>
        Effect.sync(() => {
          log.push({ method: 'list', args })
          return { items: [], total: 0 } as unknown as DaytonaPaginatedSandboxes
        }),
      start: (...args) =>
        Effect.sync(() => {
          log.push({ method: 'start', args })
        }),
      stop: (...args) =>
        Effect.sync(() => {
          log.push({ method: 'stop', args })
        }),
      delete: (...args) =>
        Effect.sync(() => {
          log.push({ method: 'delete', args })
        }),
      setAutostopInterval: (...args) =>
        Effect.sync(() => {
          log.push({ method: 'setAutostopInterval', args })
        }),
      snapshot: {} as DaytonaClient['Type']['snapshot'],
      raw: {} as DaytonaClient['Type']['raw'],
    })
  )
}

const makeNotFoundClientLayer = (
  log: MockCallRecord[]
): Layer.Layer<DaytonaClient> =>
  Layer.succeed(
    DaytonaClient,
    DaytonaClient.of({
      create: () => Effect.die('not expected'),
      createFromSnapshot: () => Effect.die('not expected'),
      get: (...args) => {
        log.push({ method: 'get', args })
        return new RpcError({ message: 'Not found', code: 'DAYTONA_NOT_FOUND' })
      },
      list: () =>
        Effect.succeed({
          items: [],
          total: 0,
        } as unknown as DaytonaPaginatedSandboxes),
      start: () => Effect.void,
      stop: () => Effect.void,
      delete: () => Effect.void,
      setAutostopInterval: () => Effect.void,
      snapshot: {} as DaytonaClient['Type']['snapshot'],
      raw: {} as DaytonaClient['Type']['raw'],
    })
  )

/**
 * Mock DaytonaClient where `.get()` fails with a non-NOT_FOUND error
 * (e.g. network timeout). Used to verify destroySandbox handles transient
 * errors gracefully — skips delete but still commits the stop event.
 */
const makeGetErrorClientLayer = (
  log: MockCallRecord[]
): Layer.Layer<DaytonaClient> =>
  Layer.succeed(
    DaytonaClient,
    DaytonaClient.of({
      create: () => Effect.die('not expected'),
      createFromSnapshot: () => Effect.die('not expected'),
      get: (...args) => {
        log.push({ method: 'get', args })
        return new RpcError({
          message: 'Request timed out',
          code: 'DAYTONA_TIMEOUT',
        })
      },
      list: () =>
        Effect.succeed({
          items: [],
          total: 0,
        } as unknown as DaytonaPaginatedSandboxes),
      start: () => Effect.void,
      stop: () => Effect.void,
      delete: () => Effect.void,
      setAutostopInterval: () => Effect.void,
      snapshot: {} as DaytonaClient['Type']['snapshot'],
      raw: {} as DaytonaClient['Type']['raw'],
    })
  )

/**
 * Mock DaytonaClient where `.get()` succeeds but `.delete()` fails.
 * Used to verify destroySandbox still commits v2.SandboxStopped even
 * when the actual SDK delete call errors.
 */
const makeDeleteFailClientLayer = (
  log: MockCallRecord[]
): Layer.Layer<DaytonaClient> => {
  const sb = makeMockSandbox(log)
  return Layer.succeed(
    DaytonaClient,
    DaytonaClient.of({
      create: () => Effect.die('not expected'),
      createFromSnapshot: () => Effect.die('not expected'),
      get: (...args) =>
        Effect.sync(() => {
          log.push({ method: 'get', args })
          return sb
        }),
      list: () =>
        Effect.succeed({
          items: [],
          total: 0,
        } as unknown as DaytonaPaginatedSandboxes),
      start: () => Effect.void,
      stop: () => Effect.void,
      delete: (...args) => {
        log.push({ method: 'delete', args })
        return new RpcError({
          message: 'Internal server error',
          code: 'DAYTONA_ERROR',
        })
      },
      setAutostopInterval: () => Effect.void,
      snapshot: {} as DaytonaClient['Type']['snapshot'],
      raw: {} as DaytonaClient['Type']['raw'],
    })
  )
}

/**
 * Mock DaytonaClient where `.get()` returns a sandbox with a specific state.
 * Used for idempotency tests (pause already-stopped, resume already-started).
 */
const makeStateClientLayer = (
  log: MockCallRecord[],
  state: string
): Layer.Layer<DaytonaClient> => {
  const sb = { ...makeMockSandbox(log), state } as unknown as DaytonaSandbox
  return Layer.succeed(
    DaytonaClient,
    DaytonaClient.of({
      create: (...args) =>
        Effect.sync(() => {
          log.push({ method: 'create', args })
          return sb
        }),
      createFromSnapshot: (...args) =>
        Effect.sync(() => {
          log.push({ method: 'createFromSnapshot', args })
          return sb
        }),
      get: (...args) =>
        Effect.sync(() => {
          log.push({ method: 'get', args })
          return sb
        }),
      list: (...args) =>
        Effect.sync(() => {
          log.push({ method: 'list', args })
          return { items: [], total: 0 } as unknown as DaytonaPaginatedSandboxes
        }),
      start: (...args) =>
        Effect.sync(() => {
          log.push({ method: 'start', args })
        }),
      stop: (...args) =>
        Effect.sync(() => {
          log.push({ method: 'stop', args })
        }),
      delete: (...args) =>
        Effect.sync(() => {
          log.push({ method: 'delete', args })
        }),
      setAutostopInterval: (...args) =>
        Effect.sync(() => {
          log.push({ method: 'setAutostopInterval', args })
        }),
      snapshot: {} as DaytonaClient['Type']['snapshot'],
      raw: {} as DaytonaClient['Type']['raw'],
    })
  )
}

const makeLayer = (log: MockCallRecord[]) =>
  DaytonaSandboxProvider.layer.pipe(
    Layer.provide(makeMockClientLayer(log)),
    Layer.provideMerge(TestLaborerStore)
  )

const makeStateLayer = (log: MockCallRecord[], state: string) =>
  DaytonaSandboxProvider.layer.pipe(
    Layer.provide(makeStateClientLayer(log, state)),
    Layer.provideMerge(TestLaborerStore)
  )

const makeNotFoundLayer = (log: MockCallRecord[]) =>
  DaytonaSandboxProvider.layer.pipe(
    Layer.provide(makeNotFoundClientLayer(log)),
    Layer.provideMerge(TestLaborerStore)
  )

const makeGetErrorLayer = (log: MockCallRecord[]) =>
  DaytonaSandboxProvider.layer.pipe(
    Layer.provide(makeGetErrorClientLayer(log)),
    Layer.provideMerge(TestLaborerStore)
  )

const makeDeleteFailLayer = (log: MockCallRecord[]) =>
  DaytonaSandboxProvider.layer.pipe(
    Layer.provide(makeDeleteFailClientLayer(log)),
    Layer.provideMerge(TestLaborerStore)
  )

// ---------------------------------------------------------------------------
// Temp directory management
// ---------------------------------------------------------------------------

const tempRoots: string[] = []

beforeEach(() => {
  spawnGitCalls.length = 0
})

afterAll(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

/**
 * Seed a workspace in LiveStore AND create a real git repo as the worktree.
 * Returns the worktree path (a real git repo) for use in createSandbox calls.
 */
const seedWorkspace = (
  store: { commit: (e: unknown) => void },
  workspaceId: string,
  projectName = 'test-project',
  branchName = 'feature/test'
): string => {
  const repoPath = initRepo(`daytona-${workspaceId.slice(0, 8)}`, tempRoots)
  const projectId = `project-${crypto.randomUUID()}`
  store.commit(
    events.projectCreated({
      id: projectId,
      repoPath,
      name: projectName,
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
      status: 'creating',
      origin: 'laborer',
      createdAt: new Date().toISOString(),
      baseSha: null,
    })
  )
  return repoPath
}

const dsc = (
  overrides: Partial<{
    image: string | null
    port: number | null
    startCommand: string | null
  }> = {}
) => ({
  autoOpen: false,
  autoStopInterval: null as number | null,
  dockerfile: null,
  image: 'image' in overrides ? (overrides.image ?? null) : 'node:22',
  installCommand: null,
  network: null,
  port: 'port' in overrides ? (overrides.port ?? null) : null,
  provider: null as 'docker' | 'daytona' | null,
  resources: null as {
    readonly cpu?: number | undefined
    readonly disk?: number | undefined
    readonly memory?: number | undefined
  } | null,
  setupScripts: [] as readonly string[],
  startCommand:
    'startCommand' in overrides ? (overrides.startCommand ?? null) : null,
  workdir: '/app',
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DaytonaSandboxProvider', () => {
  describe('createSandbox', () => {
    it.scoped('calls create with correct SDK params when image is set', () =>
      Effect.gen(function* () {
        const log: MockCallRecord[] = []
        yield* Effect.gen(function* () {
          const sp = yield* SandboxProvider
          const { store } = yield* LaborerStore
          const wid = crypto.randomUUID()
          const worktreePath = seedWorkspace(store as never, wid)

          yield* sp.createSandbox({
            workspaceId: wid,
            branchName: 'feature/test',
            projectName: 'test-project',
            worktreePath,
            devServerConfig: dsc({ image: 'node:22', port: 3000 }),
          })

          const creates = log.filter((c) => c.method === 'create')
          assert.strictEqual(creates.length, 1)
          const params = creates[0]?.args[0] as Record<string, unknown>
          assert.strictEqual(params.image, 'node:22')
          assert.strictEqual(params.language, CodeLanguage.TYPESCRIPT)
          assert.deepStrictEqual(params.labels, {
            'laborer-workspace-id': wid,
            'laborer-project': 'test-project',
            'laborer-branch': 'feature/test',
          })
          assert.strictEqual(params.autoStopInterval, 15)
          assert.strictEqual(params.autoDeleteInterval, -1)

          const [ws] = store.query(tables.workspaces.where('id', wid))
          assert.strictEqual(ws?.sandboxId, 'sandbox-test-123')
          assert.strictEqual(ws?.sandboxImage, 'node:22')
          assert.strictEqual(ws?.sandboxStatus, 'running')
          assert.strictEqual(ws?.sandboxProvider, 'daytona')
          assert.strictEqual(ws?.sandboxPort, 3000)
          assert.strictEqual(ws?.sandboxSetupStep, null)
        }).pipe(Effect.provide(makeLayer(log)))
      })
    )

    it.scoped('calls createFromSnapshot when image is null', () =>
      Effect.gen(function* () {
        const log: MockCallRecord[] = []
        yield* Effect.gen(function* () {
          const sp = yield* SandboxProvider
          const { store } = yield* LaborerStore
          const wid = crypto.randomUUID()
          const worktreePath = seedWorkspace(store as never, wid)

          yield* sp.createSandbox({
            workspaceId: wid,
            branchName: 'feature/default',
            projectName: 'default-project',
            worktreePath,
            devServerConfig: dsc({ image: null }),
          })

          assert.strictEqual(
            log.filter((c) => c.method === 'createFromSnapshot').length,
            1
          )
          assert.strictEqual(log.filter((c) => c.method === 'create').length, 0)
          const [ws] = store.query(tables.workspaces.where('id', wid))
          assert.strictEqual(ws?.sandboxImage, 'daytona-default')
          assert.strictEqual(ws?.sandboxProvider, 'daytona')
        }).pipe(Effect.provide(makeLayer(log)))
      })
    )

    it.scoped('invokes onReady callback after creation', () =>
      Effect.gen(function* () {
        const log: MockCallRecord[] = []
        yield* Effect.gen(function* () {
          const sp = yield* SandboxProvider
          const { store } = yield* LaborerStore
          const wid = crypto.randomUUID()
          const worktreePath = seedWorkspace(store as never, wid)
          const called = yield* Ref.make(false)

          yield* sp.createSandbox({
            workspaceId: wid,
            branchName: 'feature/cb',
            projectName: 'cb-project',
            worktreePath,
            devServerConfig: dsc(),
            onReady: () => Ref.set(called, true).pipe(Effect.asVoid),
          })

          assert.isTrue(yield* Ref.get(called))
        }).pipe(Effect.provide(makeLayer(log)))
      })
    )

    it.scoped('sets labels with workspace ID, project, and branch', () =>
      Effect.gen(function* () {
        const log: MockCallRecord[] = []
        yield* Effect.gen(function* () {
          const sp = yield* SandboxProvider
          const { store } = yield* LaborerStore
          const wid = crypto.randomUUID()
          const worktreePath = seedWorkspace(
            store as never,
            wid,
            'my-project',
            'feat/cool'
          )

          yield* sp.createSandbox({
            workspaceId: wid,
            branchName: 'feat/cool',
            projectName: 'my-project',
            worktreePath,
            devServerConfig: dsc(),
          })

          const [call] = log.filter((c) => c.method === 'create')
          const params = call?.args[0] as Record<string, unknown>
          assert.deepStrictEqual(params.labels, {
            'laborer-workspace-id': wid,
            'laborer-project': 'my-project',
            'laborer-branch': 'feat/cool',
          })
        }).pipe(Effect.provide(makeLayer(log)))
      })
    )

    it.scoped(
      'calls createSshAccess on the sandbox during git sync (Issue 15)',
      () =>
        Effect.gen(function* () {
          const log: MockCallRecord[] = []
          yield* Effect.gen(function* () {
            const sp = yield* SandboxProvider
            const { store } = yield* LaborerStore
            const wid = crypto.randomUUID()
            const worktreePath = seedWorkspace(store as never, wid)

            yield* sp.createSandbox({
              workspaceId: wid,
              branchName: 'feature/git-sync',
              projectName: 'sync-project',
              worktreePath,
              devServerConfig: dsc(),
            })

            const sshCalls = log.filter(
              (c) => c.method === 'sandbox.createSshAccess'
            )
            assert.strictEqual(sshCalls.length, 1)
            // Token expiry should be 10 minutes
            assert.strictEqual((sshCalls[0]?.args as unknown[])[0], 10)
          }).pipe(Effect.provide(makeLayer(log)))
        })
    )

    it.scoped(
      'executes git init in sandbox before pushing code (Issue 15)',
      () =>
        Effect.gen(function* () {
          const log: MockCallRecord[] = []
          yield* Effect.gen(function* () {
            const sp = yield* SandboxProvider
            const { store } = yield* LaborerStore
            const wid = crypto.randomUUID()
            const worktreePath = seedWorkspace(store as never, wid)

            yield* sp.createSandbox({
              workspaceId: wid,
              branchName: 'feature/git-init',
              projectName: 'init-project',
              worktreePath,
              devServerConfig: dsc(),
            })

            const execCalls = log.filter(
              (c) => c.method === 'sandbox.process.executeCommand'
            )
            // Should have at least 2 calls: git init + git checkout
            assert.isTrue(execCalls.length >= 2)
            // First call should be git init
            const initCmd = (execCalls[0]?.args as unknown[])[0] as string
            assert.isTrue(initCmd.includes('git init'))
            assert.isTrue(initCmd.includes('receive.denyCurrentBranch ignore'))
          }).pipe(Effect.provide(makeLayer(log)))
        })
    )

    it.scoped(
      'executes git checkout in sandbox after pushing code (Issue 15)',
      () =>
        Effect.gen(function* () {
          const log: MockCallRecord[] = []
          yield* Effect.gen(function* () {
            const sp = yield* SandboxProvider
            const { store } = yield* LaborerStore
            const wid = crypto.randomUUID()
            const worktreePath = seedWorkspace(store as never, wid)

            yield* sp.createSandbox({
              workspaceId: wid,
              branchName: 'feature/git-checkout',
              projectName: 'checkout-project',
              worktreePath,
              devServerConfig: dsc(),
            })

            const execCalls = log.filter(
              (c) => c.method === 'sandbox.process.executeCommand'
            )
            // Last executeCommand call should be the checkout
            const lastCmd = (execCalls.at(-1)?.args as unknown[])[0] as string
            assert.isTrue(lastCmd.includes('git checkout -f main'))
          }).pipe(Effect.provide(makeLayer(log)))
        })
    )

    it.scoped(
      'reports pushing-code setup step during git sync (Issue 15)',
      () =>
        Effect.gen(function* () {
          const log: MockCallRecord[] = []
          yield* Effect.gen(function* () {
            const sp = yield* SandboxProvider
            const { store } = yield* LaborerStore
            const wid = crypto.randomUUID()
            const worktreePath = seedWorkspace(store as never, wid)

            yield* sp.createSandbox({
              workspaceId: wid,
              branchName: 'feature/step',
              projectName: 'step-project',
              worktreePath,
              devServerConfig: dsc(),
            })

            // After successful creation, setup step should be cleared (null)
            const [ws] = store.query(tables.workspaces.where('id', wid))
            assert.strictEqual(ws?.sandboxSetupStep, null)
          }).pipe(Effect.provide(makeLayer(log)))
        })
    )

    it.scoped('calls git remote remove to clean up after push (Issue 15)', () =>
      Effect.gen(function* () {
        const log: MockCallRecord[] = []
        yield* Effect.gen(function* () {
          const sp = yield* SandboxProvider
          const { store } = yield* LaborerStore
          const wid = crypto.randomUUID()
          const worktreePath = seedWorkspace(store as never, wid)

          yield* sp.createSandbox({
            workspaceId: wid,
            branchName: 'feature/cleanup',
            projectName: 'cleanup-project',
            worktreePath,
            devServerConfig: dsc(),
          })

          // Verify spawnGit was called with 'remote remove' to clean up
          const removeCalls = spawnGitCalls.filter(
            (c) => c.args[0] === 'remote' && c.args[1] === 'remove'
          )
          assert.strictEqual(removeCalls.length, 1)
          assert.isTrue(
            (removeCalls[0]?.args[2] as string).includes(`sandbox-${wid}`)
          )
        }).pipe(Effect.provide(makeLayer(log)))
      })
    )
  })

  describe('destroySandbox', () => {
    it.scoped('deletes sandbox and commits SandboxStopped', () =>
      Effect.gen(function* () {
        const log: MockCallRecord[] = []
        yield* Effect.gen(function* () {
          const sp = yield* SandboxProvider
          const { store } = yield* LaborerStore
          const wid = crypto.randomUUID()
          seedWorkspace(store as never, wid)
          store.commit(
            events.sandboxStarted({
              workspaceId: wid,
              sandboxId: 'sb-destroy',
              sandboxUrl: 'sb-destroy',
              sandboxImage: 'node:22',
              sandboxProvider: 'daytona',
            })
          )

          yield* sp.destroySandbox(wid)

          assert.strictEqual(log.filter((c) => c.method === 'get').length, 1)
          assert.strictEqual(log.filter((c) => c.method === 'delete').length, 1)
          const [ws] = store.query(tables.workspaces.where('id', wid))
          assert.strictEqual(ws?.sandboxId, null)
          assert.strictEqual(ws?.sandboxStatus, null)
        }).pipe(Effect.provide(makeLayer(log)))
      })
    )

    it.scoped('handles already-destroyed sandbox gracefully (NOT_FOUND)', () =>
      Effect.gen(function* () {
        const log: MockCallRecord[] = []
        yield* Effect.gen(function* () {
          const sp = yield* SandboxProvider
          const { store } = yield* LaborerStore
          const wid = crypto.randomUUID()
          seedWorkspace(store as never, wid)
          store.commit(
            events.sandboxStarted({
              workspaceId: wid,
              sandboxId: 'sb-gone',
              sandboxUrl: 'sb-gone',
              sandboxImage: 'node:22',
              sandboxProvider: 'daytona',
            })
          )

          yield* sp.destroySandbox(wid)

          // Should NOT call delete (sandbox is already gone)
          assert.strictEqual(log.filter((c) => c.method === 'delete').length, 0)
          const [ws] = store.query(tables.workspaces.where('id', wid))
          assert.strictEqual(ws?.sandboxId, null)
          assert.strictEqual(ws?.sandboxStatus, null)
        }).pipe(Effect.provide(makeNotFoundLayer(log)))
      })
    )

    it.scoped('skips gracefully when workspace not found in LiveStore', () =>
      Effect.gen(function* () {
        const log: MockCallRecord[] = []
        yield* Effect.gen(function* () {
          const sp = yield* SandboxProvider
          // Do NOT seed a workspace — it should skip gracefully
          yield* sp.destroySandbox('nonexistent-workspace-id')

          // No SDK calls should be made
          assert.strictEqual(log.length, 0)
        }).pipe(Effect.provide(makeLayer(log)))
      })
    )

    it.scoped('skips gracefully when workspace has no sandboxId', () =>
      Effect.gen(function* () {
        const log: MockCallRecord[] = []
        yield* Effect.gen(function* () {
          const sp = yield* SandboxProvider
          const { store } = yield* LaborerStore
          const wid = crypto.randomUUID()
          // Seed workspace WITHOUT starting a sandbox (no sandboxId)
          seedWorkspace(store as never, wid)

          yield* sp.destroySandbox(wid)

          // No SDK calls should be made
          assert.strictEqual(log.length, 0)
        }).pipe(Effect.provide(makeLayer(log)))
      })
    )

    it.scoped(
      'still commits SandboxStopped when get fails with non-NOT_FOUND error',
      () =>
        Effect.gen(function* () {
          const log: MockCallRecord[] = []
          yield* Effect.gen(function* () {
            const sp = yield* SandboxProvider
            const { store } = yield* LaborerStore
            const wid = crypto.randomUUID()
            seedWorkspace(store as never, wid)
            store.commit(
              events.sandboxStarted({
                workspaceId: wid,
                sandboxId: 'sb-timeout',
                sandboxUrl: 'sb-timeout',
                sandboxImage: 'node:22',
                sandboxProvider: 'daytona',
              })
            )

            yield* sp.destroySandbox(wid)

            // get was called, delete was NOT called (couldn't fetch sandbox)
            assert.strictEqual(log.filter((c) => c.method === 'get').length, 1)
            assert.strictEqual(
              log.filter((c) => c.method === 'delete').length,
              0
            )
            // SandboxStopped event still committed
            const [ws] = store.query(tables.workspaces.where('id', wid))
            assert.strictEqual(ws?.sandboxId, null)
            assert.strictEqual(ws?.sandboxStatus, null)
          }).pipe(Effect.provide(makeGetErrorLayer(log)))
        })
    )

    it.scoped(
      'still commits SandboxStopped when delete fails (best-effort)',
      () =>
        Effect.gen(function* () {
          const log: MockCallRecord[] = []
          yield* Effect.gen(function* () {
            const sp = yield* SandboxProvider
            const { store } = yield* LaborerStore
            const wid = crypto.randomUUID()
            seedWorkspace(store as never, wid)
            store.commit(
              events.sandboxStarted({
                workspaceId: wid,
                sandboxId: 'sb-del-fail',
                sandboxUrl: 'sb-del-fail',
                sandboxImage: 'node:22',
                sandboxProvider: 'daytona',
              })
            )

            yield* sp.destroySandbox(wid)

            // Both get and delete were called
            assert.strictEqual(log.filter((c) => c.method === 'get').length, 1)
            assert.strictEqual(
              log.filter((c) => c.method === 'delete').length,
              1
            )
            // SandboxStopped event still committed despite delete failure
            const [ws] = store.query(tables.workspaces.where('id', wid))
            assert.strictEqual(ws?.sandboxId, null)
            assert.strictEqual(ws?.sandboxStatus, null)
          }).pipe(Effect.provide(makeDeleteFailLayer(log)))
        })
    )
  })

  describe('pauseSandbox', () => {
    it.scoped('stops sandbox and commits SandboxPaused', () =>
      Effect.gen(function* () {
        const log: MockCallRecord[] = []
        yield* Effect.gen(function* () {
          const sp = yield* SandboxProvider
          const { store } = yield* LaborerStore
          const wid = crypto.randomUUID()
          seedWorkspace(store as never, wid)
          store.commit(
            events.sandboxStarted({
              workspaceId: wid,
              sandboxId: 'sb-pause',
              sandboxUrl: 'sb-pause',
              sandboxImage: 'node:22',
              sandboxProvider: 'daytona',
            })
          )

          yield* sp.pauseSandbox(wid)

          assert.strictEqual(log.filter((c) => c.method === 'stop').length, 1)
          const [ws] = store.query(tables.workspaces.where('id', wid))
          assert.strictEqual(ws?.sandboxStatus, 'paused')
        }).pipe(Effect.provide(makeLayer(log)))
      })
    )

    it.scoped(
      'skips stop call when sandbox is already stopped (idempotent)',
      () =>
        Effect.gen(function* () {
          const log: MockCallRecord[] = []
          yield* Effect.gen(function* () {
            const sp = yield* SandboxProvider
            const { store } = yield* LaborerStore
            const wid = crypto.randomUUID()
            seedWorkspace(store as never, wid)
            store.commit(
              events.sandboxStarted({
                workspaceId: wid,
                sandboxId: 'sb-already-stopped',
                sandboxUrl: 'sb-already-stopped',
                sandboxImage: 'node:22',
                sandboxProvider: 'daytona',
              })
            )

            yield* sp.pauseSandbox(wid)

            // get was called (to check state), but stop was NOT called
            assert.strictEqual(log.filter((c) => c.method === 'get').length, 1)
            assert.strictEqual(log.filter((c) => c.method === 'stop').length, 0)
            // SandboxPaused event still committed
            const [ws] = store.query(tables.workspaces.where('id', wid))
            assert.strictEqual(ws?.sandboxStatus, 'paused')
          }).pipe(Effect.provide(makeStateLayer(log, 'stopped')))
        })
    )

    it.scoped('skips stop call when sandbox is archived (idempotent)', () =>
      Effect.gen(function* () {
        const log: MockCallRecord[] = []
        yield* Effect.gen(function* () {
          const sp = yield* SandboxProvider
          const { store } = yield* LaborerStore
          const wid = crypto.randomUUID()
          seedWorkspace(store as never, wid)
          store.commit(
            events.sandboxStarted({
              workspaceId: wid,
              sandboxId: 'sb-archived',
              sandboxUrl: 'sb-archived',
              sandboxImage: 'node:22',
              sandboxProvider: 'daytona',
            })
          )

          yield* sp.pauseSandbox(wid)

          // get was called, but stop was NOT called (archived = already inactive)
          assert.strictEqual(log.filter((c) => c.method === 'get').length, 1)
          assert.strictEqual(log.filter((c) => c.method === 'stop').length, 0)
          // SandboxPaused event still committed
          const [ws] = store.query(tables.workspaces.where('id', wid))
          assert.strictEqual(ws?.sandboxStatus, 'paused')
        }).pipe(Effect.provide(makeStateLayer(log, 'archived')))
      })
    )

    it.scoped('returns NOT_FOUND when workspace has no sandbox', () =>
      Effect.gen(function* () {
        const log: MockCallRecord[] = []
        yield* Effect.gen(function* () {
          const sp = yield* SandboxProvider
          const { store } = yield* LaborerStore
          const wid = crypto.randomUUID()
          seedWorkspace(store as never, wid)
          // No sandboxStarted event — workspace has no sandboxId

          const result = yield* sp.pauseSandbox(wid).pipe(
            Effect.map(() => null),
            Effect.catchAll((err) => Effect.succeed(err))
          )

          assert.isNotNull(result)
          assert.strictEqual((result as RpcError).code, 'NOT_FOUND')
          // No SDK calls made
          assert.strictEqual(log.length, 0)
        }).pipe(Effect.provide(makeLayer(log)))
      })
    )
  })

  describe('resumeSandbox', () => {
    it.scoped('starts sandbox and commits SandboxResumed', () =>
      Effect.gen(function* () {
        const log: MockCallRecord[] = []
        yield* Effect.gen(function* () {
          const sp = yield* SandboxProvider
          const { store } = yield* LaborerStore
          const wid = crypto.randomUUID()
          seedWorkspace(store as never, wid)
          store.commit(
            events.sandboxStarted({
              workspaceId: wid,
              sandboxId: 'sb-resume',
              sandboxUrl: 'sb-resume',
              sandboxImage: 'node:22',
              sandboxProvider: 'daytona',
            })
          )
          store.commit(events.sandboxPaused({ workspaceId: wid }))

          yield* sp.resumeSandbox(wid)

          assert.strictEqual(log.filter((c) => c.method === 'start').length, 1)
          const [ws] = store.query(tables.workspaces.where('id', wid))
          assert.strictEqual(ws?.sandboxStatus, 'running')
        }).pipe(Effect.provide(makeStateLayer(log, 'stopped')))
      })
    )

    it.scoped(
      'skips start call when sandbox is already started (idempotent)',
      () =>
        Effect.gen(function* () {
          const log: MockCallRecord[] = []
          yield* Effect.gen(function* () {
            const sp = yield* SandboxProvider
            const { store } = yield* LaborerStore
            const wid = crypto.randomUUID()
            seedWorkspace(store as never, wid)
            store.commit(
              events.sandboxStarted({
                workspaceId: wid,
                sandboxId: 'sb-already-running',
                sandboxUrl: 'sb-already-running',
                sandboxImage: 'node:22',
                sandboxProvider: 'daytona',
              })
            )

            yield* sp.resumeSandbox(wid)

            // get was called, but start was NOT called
            assert.strictEqual(log.filter((c) => c.method === 'get').length, 1)
            assert.strictEqual(
              log.filter((c) => c.method === 'start').length,
              0
            )
            // SandboxResumed event still committed
            const [ws] = store.query(tables.workspaces.where('id', wid))
            assert.strictEqual(ws?.sandboxStatus, 'running')
          }).pipe(Effect.provide(makeStateLayer(log, 'started')))
        })
    )

    it.scoped('returns NOT_FOUND when workspace has no sandbox', () =>
      Effect.gen(function* () {
        const log: MockCallRecord[] = []
        yield* Effect.gen(function* () {
          const sp = yield* SandboxProvider
          const { store } = yield* LaborerStore
          const wid = crypto.randomUUID()
          seedWorkspace(store as never, wid)
          // No sandboxStarted event — workspace has no sandboxId

          const result = yield* sp.resumeSandbox(wid).pipe(
            Effect.map(() => null),
            Effect.catchAll((err) => Effect.succeed(err))
          )

          assert.isNotNull(result)
          assert.strictEqual((result as RpcError).code, 'NOT_FOUND')
          // No SDK calls made
          assert.strictEqual(log.length, 0)
        }).pipe(Effect.provide(makeLayer(log)))
      })
    )
  })

  describe('setAutoStopInterval', () => {
    it.scoped('calls setAutostopInterval on the SDK sandbox', () =>
      Effect.gen(function* () {
        const log: MockCallRecord[] = []
        yield* Effect.gen(function* () {
          const sp = yield* SandboxProvider
          const { store } = yield* LaborerStore
          const wid = crypto.randomUUID()
          seedWorkspace(store as never, wid)
          store.commit(
            events.sandboxStarted({
              workspaceId: wid,
              sandboxId: 'sb-autostop',
              sandboxUrl: 'sb-autostop',
              sandboxImage: 'node:22',
              sandboxProvider: 'daytona',
            })
          )

          yield* sp.setAutoStopInterval(wid, 30)

          assert.strictEqual(log.filter((c) => c.method === 'get').length, 1)
          const autostopCalls = log.filter(
            (c) => c.method === 'setAutostopInterval'
          )
          assert.strictEqual(autostopCalls.length, 1)
          // Second arg is the interval
          assert.strictEqual((autostopCalls[0]?.args as unknown[])[1], 30)
        }).pipe(Effect.provide(makeLayer(log)))
      })
    )

    it.scoped('calls setAutostopInterval with 0 to disable', () =>
      Effect.gen(function* () {
        const log: MockCallRecord[] = []
        yield* Effect.gen(function* () {
          const sp = yield* SandboxProvider
          const { store } = yield* LaborerStore
          const wid = crypto.randomUUID()
          seedWorkspace(store as never, wid)
          store.commit(
            events.sandboxStarted({
              workspaceId: wid,
              sandboxId: 'sb-autostop-0',
              sandboxUrl: 'sb-autostop-0',
              sandboxImage: 'node:22',
              sandboxProvider: 'daytona',
            })
          )

          yield* sp.setAutoStopInterval(wid, 0)

          const autostopCalls = log.filter(
            (c) => c.method === 'setAutostopInterval'
          )
          assert.strictEqual(autostopCalls.length, 1)
          assert.strictEqual((autostopCalls[0]?.args as unknown[])[1], 0)
        }).pipe(Effect.provide(makeLayer(log)))
      })
    )

    it.scoped('returns NOT_FOUND when workspace has no sandbox', () =>
      Effect.gen(function* () {
        const log: MockCallRecord[] = []
        yield* Effect.gen(function* () {
          const sp = yield* SandboxProvider
          const { store } = yield* LaborerStore
          const wid = crypto.randomUUID()
          seedWorkspace(store as never, wid)

          const result = yield* sp.setAutoStopInterval(wid, 30).pipe(
            Effect.map(() => null),
            Effect.catchAll((err) => Effect.succeed(err))
          )

          assert.isNotNull(result)
          assert.strictEqual((result as RpcError).code, 'NOT_FOUND')
          assert.strictEqual(log.length, 0)
        }).pipe(Effect.provide(makeLayer(log)))
      })
    )
  })

  describe('checkAvailability', () => {
    it.scoped('returns available when list succeeds', () =>
      Effect.gen(function* () {
        const log: MockCallRecord[] = []
        yield* Effect.gen(function* () {
          const sp = yield* SandboxProvider
          const status = yield* sp.checkAvailability()
          assert.isTrue(status.available)
        }).pipe(Effect.provide(makeLayer(log)))
      })
    )
  })
})
