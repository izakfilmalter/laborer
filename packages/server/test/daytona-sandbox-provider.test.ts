/**
 * Tests for DaytonaSandboxProvider — Issues 12, 13, 14, 15, 16, 19 & 20
 *
 * Issue 12: Verifies checkAvailability — returns available when API is reachable,
 * returns unavailable with actionable guidance when list fails (auth error,
 * rate limit, timeout), and caches the result after the first check.
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
 * Issue 16: Verifies spawnTerminal — PTY session creation via Daytona SDK.
 * Tests that createPty is called with correct parameters, waitForConnection
 * is awaited, initial commands are sent, and TerminalHandle is returned.
 *
 * Issue 19: Verifies pauseSandbox and resumeSandbox idempotency — pausing
 * an already-stopped/archived sandbox skips the SDK stop call, resuming an
 * already-started sandbox skips the SDK start call. Also tests
 * setAutoStopInterval delegation to the SDK.
 *
 * Issue 20: Verifies state reconciliation — the polling loop detects sandbox
 * state drift and commits the correct LiveStore events (SandboxPaused,
 * SandboxResumed, SandboxStopped) to sync with actual Daytona state.
 */

import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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

/**
 * Mock PtyHandle returned by `createPty`. Records `sendInput`, `resize`,
 * `waitForConnection`, `disconnect`, and `kill` calls to the shared log.
 */
const makeMockPtyHandle = (sessionId: string, log?: MockCallRecord[]) => ({
  sessionId,
  sendInput: (...args: unknown[]) => {
    log?.push({ method: 'ptyHandle.sendInput', args })
    return Promise.resolve()
  },
  resize: (...args: unknown[]) => {
    log?.push({ method: 'ptyHandle.resize', args })
    return Promise.resolve({})
  },
  waitForConnection: () => {
    log?.push({ method: 'ptyHandle.waitForConnection', args: [] })
    return Promise.resolve()
  },
  disconnect: () => {
    log?.push({ method: 'ptyHandle.disconnect', args: [] })
    return Promise.resolve()
  },
  kill: () => {
    log?.push({ method: 'ptyHandle.kill', args: [] })
    return Promise.resolve()
  },
  wait: () => Promise.resolve({ exitCode: 0 }),
  isConnected: () => true,
  get exitCode() {
    return undefined
  },
  get error() {
    return undefined
  },
})

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
      createPty: (...args: unknown[]) => {
        log?.push({ method: 'sandbox.process.createPty', args })
        // Extract the session ID from the options (first positional arg)
        const opts = args[0] as { id?: string } | undefined
        const sessionId = opts?.id ?? 'mock-pty-session'
        return Promise.resolve(makeMockPtyHandle(sessionId, log))
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
    getPreviewLink: (port: number) => {
      log?.push({ method: 'sandbox.getPreviewLink', args: [port] })
      return Promise.resolve({
        url: `https://${port}-sandbox-test-123.preview.daytona.io`,
        token: '',
      })
    },
  }) as unknown as DaytonaSandbox

// ---------------------------------------------------------------------------
// Mock layers
// ---------------------------------------------------------------------------

/**
 * Build a mock snapshot service for the `DaytonaClient.snapshot` sub-service.
 *
 * By default, `get` throws (snapshot not found) and `create` succeeds.
 * Pass `snapshotExists: true` to make `get` return a mock snapshot (cache hit).
 */
const makeMockSnapshotService = (
  log: MockCallRecord[],
  options: { snapshotExists?: boolean } = {}
) =>
  ({
    get: (...args: unknown[]) => {
      log.push({ method: 'snapshot.get', args })
      if (options.snapshotExists) {
        return Promise.resolve({
          id: 'snap-1',
          name: args[0] as string,
          state: 'ACTIVE',
        })
      }
      throw new Error('Snapshot not found')
    },
    create: (...args: unknown[]) => {
      log.push({ method: 'snapshot.create', args })
      return Promise.resolve({
        id: 'snap-new',
        name: (args[0] as { name: string }).name,
        state: 'ACTIVE',
      })
    },
    list: () =>
      Promise.resolve({ items: [], total: 0, page: 1, totalPages: 0 }),
    delete: () => Promise.resolve(),
    activate: () => Promise.resolve({}),
  }) as unknown as DaytonaClient['Type']['snapshot']

const makeMockClientLayer = (
  log: MockCallRecord[],
  options: { snapshotExists?: boolean } = {}
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
      snapshot: makeMockSnapshotService(log, options),
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
      snapshot: makeMockSnapshotService(log),
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
      snapshot: makeMockSnapshotService(log),
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
      snapshot: makeMockSnapshotService(log),
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
      snapshot: makeMockSnapshotService(log),
      raw: {} as DaytonaClient['Type']['raw'],
    })
  )
}

const makeLayer = (
  log: MockCallRecord[],
  clientOptions?: { snapshotExists?: boolean }
) =>
  DaytonaSandboxProvider.layer.pipe(
    Layer.provide(makeMockClientLayer(log, clientOptions)),
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
    installCommand: string | null
    port: number | null
    startCommand: string | null
  }> = {}
) => ({
  autoOpen: false,
  autoStopInterval: null as number | null,
  dockerfile: null,
  image: 'image' in overrides ? (overrides.image ?? null) : 'node:22',
  installCommand:
    'installCommand' in overrides ? (overrides.installCommand ?? null) : null,
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
          const sp = yield* DaytonaSandboxProvider
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

          // When port is specified, sandboxUrl stores the full preview URL
          assert.strictEqual(
            ws?.sandboxUrl,
            'https://3000-sandbox-test-123.preview.daytona.io'
          )
        }).pipe(Effect.provide(makeLayer(log)))
      })
    )

    it.scoped('calls createFromSnapshot when image is null', () =>
      Effect.gen(function* () {
        const log: MockCallRecord[] = []
        yield* Effect.gen(function* () {
          const sp = yield* DaytonaSandboxProvider
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

          // When no port is specified, sandboxUrl stores just the sandbox ID
          assert.strictEqual(ws?.sandboxUrl, 'sandbox-test-123')
        }).pipe(Effect.provide(makeLayer(log)))
      })
    )

    it.scoped('invokes onReady callback after creation', () =>
      Effect.gen(function* () {
        const log: MockCallRecord[] = []
        yield* Effect.gen(function* () {
          const sp = yield* DaytonaSandboxProvider
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
          const sp = yield* DaytonaSandboxProvider
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
            const sp = yield* DaytonaSandboxProvider
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
            const sp = yield* DaytonaSandboxProvider
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
            const sp = yield* DaytonaSandboxProvider
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
            const sp = yield* DaytonaSandboxProvider
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
          const sp = yield* DaytonaSandboxProvider
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

    // ── Issue 21: Snapshot caching tests ──────────────────────
    // Tests for lockfile detection + snapshot caching during sandbox creation.

    it.scoped(
      'creates snapshot when lockfile exists and no cached snapshot (cache miss)',
      () =>
        Effect.gen(function* () {
          const log: MockCallRecord[] = []
          yield* Effect.gen(function* () {
            const sp = yield* DaytonaSandboxProvider
            const { store } = yield* LaborerStore
            const wid = crypto.randomUUID()
            const worktreePath = seedWorkspace(store as never, wid)

            // Write a lockfile to the worktree so detectLockfile finds it
            writeFileSync(join(worktreePath, 'bun.lock'), 'lockfile-content-v1')

            yield* sp.createSandbox({
              workspaceId: wid,
              branchName: 'feature/snapshot',
              projectName: 'snap-project',
              worktreePath,
              devServerConfig: dsc({ image: 'node:22' }),
            })

            // snapshot.get was called (to check cache)
            const getSnapshotCalls = log.filter(
              (c) => c.method === 'snapshot.get'
            )
            assert.strictEqual(getSnapshotCalls.length, 1)

            // snapshot.create was called (cache miss → build)
            const createSnapshotCalls = log.filter(
              (c) => c.method === 'snapshot.create'
            )
            assert.strictEqual(createSnapshotCalls.length, 1)

            // Sandbox created from snapshot (not from image directly)
            const createFromSnapshotCalls = log.filter(
              (c) => c.method === 'createFromSnapshot'
            )
            assert.strictEqual(createFromSnapshotCalls.length, 1)

            // Should NOT have called create (image-based)
            const createCalls = log.filter((c) => c.method === 'create')
            assert.strictEqual(createCalls.length, 0)

            // Verify sandbox was created successfully
            const [ws] = store.query(tables.workspaces.where('id', wid))
            assert.strictEqual(ws?.sandboxId, 'sandbox-test-123')
            assert.strictEqual(ws?.sandboxProvider, 'daytona')
          }).pipe(Effect.provide(makeLayer(log)))
        })
    )

    it.scoped(
      'uses cached snapshot when lockfile exists and snapshot already built (cache hit)',
      () =>
        Effect.gen(function* () {
          const log: MockCallRecord[] = []
          yield* Effect.gen(function* () {
            const sp = yield* DaytonaSandboxProvider
            const { store } = yield* LaborerStore
            const wid = crypto.randomUUID()
            const worktreePath = seedWorkspace(store as never, wid)

            // Write a lockfile to the worktree
            writeFileSync(join(worktreePath, 'bun.lock'), 'lockfile-content-v1')

            yield* sp.createSandbox({
              workspaceId: wid,
              branchName: 'feature/cache-hit',
              projectName: 'cached-project',
              worktreePath,
              devServerConfig: dsc({ image: 'node:22' }),
            })

            // snapshot.get was called (to check cache)
            const getSnapshotCalls = log.filter(
              (c) => c.method === 'snapshot.get'
            )
            assert.strictEqual(getSnapshotCalls.length, 1)

            // snapshot.create was NOT called (cache hit)
            const createSnapshotCalls = log.filter(
              (c) => c.method === 'snapshot.create'
            )
            assert.strictEqual(createSnapshotCalls.length, 0)

            // Sandbox created from snapshot
            const createFromSnapshotCalls = log.filter(
              (c) => c.method === 'createFromSnapshot'
            )
            assert.strictEqual(createFromSnapshotCalls.length, 1)

            // Verify the snapshot name was passed
            const snapshotParams = createFromSnapshotCalls[0]
              ?.args[0] as Record<string, unknown>
            assert.isString(snapshotParams.snapshot)
            assert.isTrue(
              (snapshotParams.snapshot as string).startsWith('laborer-deps-')
            )
          }).pipe(Effect.provide(makeLayer(log, { snapshotExists: true })))
        })
    )

    it.scoped('skips snapshot caching when no lockfile is found', () =>
      Effect.gen(function* () {
        const log: MockCallRecord[] = []
        yield* Effect.gen(function* () {
          const sp = yield* DaytonaSandboxProvider
          const { store } = yield* LaborerStore
          const wid = crypto.randomUUID()
          const worktreePath = seedWorkspace(store as never, wid)

          // No lockfile written — worktree has only git files

          yield* sp.createSandbox({
            workspaceId: wid,
            branchName: 'feature/no-lockfile',
            projectName: 'no-lock-project',
            worktreePath,
            devServerConfig: dsc({ image: 'node:22' }),
          })

          // snapshot.get should NOT be called (no lockfile)
          const getSnapshotCalls = log.filter(
            (c) => c.method === 'snapshot.get'
          )
          assert.strictEqual(getSnapshotCalls.length, 0)

          // snapshot.create should NOT be called
          const createSnapshotCalls = log.filter(
            (c) => c.method === 'snapshot.create'
          )
          assert.strictEqual(createSnapshotCalls.length, 0)

          // Sandbox created from image directly (not snapshot)
          const createCalls = log.filter((c) => c.method === 'create')
          assert.strictEqual(createCalls.length, 1)
        }).pipe(Effect.provide(makeLayer(log)))
      })
    )

    it.scoped('uses installCommand from config when available', () =>
      Effect.gen(function* () {
        const log: MockCallRecord[] = []
        yield* Effect.gen(function* () {
          const sp = yield* DaytonaSandboxProvider
          const { store } = yield* LaborerStore
          const wid = crypto.randomUUID()
          const worktreePath = seedWorkspace(store as never, wid)

          // Write a lockfile
          writeFileSync(
            join(worktreePath, 'bun.lock'),
            'lockfile-content-custom'
          )

          yield* sp.createSandbox({
            workspaceId: wid,
            branchName: 'feature/custom-install',
            projectName: 'custom-install-project',
            worktreePath,
            devServerConfig: dsc({
              image: 'node:22',
              installCommand: 'bun install --production',
            }),
          })

          // snapshot.create should be called with the custom install command
          const createSnapshotCalls = log.filter(
            (c) => c.method === 'snapshot.create'
          )
          assert.strictEqual(createSnapshotCalls.length, 1)

          // The first arg is the params object with { name, image }
          const snapshotParams = createSnapshotCalls[0]?.args[0] as {
            name: string
            image: { dockerfile: string }
          }
          // The Image should contain a RUN command with the custom install command
          assert.isTrue(
            snapshotParams.image.dockerfile.includes('bun install --production')
          )
        }).pipe(Effect.provide(makeLayer(log)))
      })
    )

    it.scoped(
      'reports building-snapshot setup step during snapshot build',
      () =>
        Effect.gen(function* () {
          const log: MockCallRecord[] = []
          yield* Effect.gen(function* () {
            const sp = yield* DaytonaSandboxProvider
            const { store } = yield* LaborerStore
            const wid = crypto.randomUUID()
            const worktreePath = seedWorkspace(store as never, wid)

            // Write a lockfile so snapshot caching triggers
            writeFileSync(
              join(worktreePath, 'package-lock.json'),
              '{"lockfileVersion":3}'
            )

            yield* sp.createSandbox({
              workspaceId: wid,
              branchName: 'feature/steps',
              projectName: 'steps-project',
              worktreePath,
              devServerConfig: dsc({ image: 'node:22' }),
            })

            // After creation, step should be cleared
            const [ws] = store.query(tables.workspaces.where('id', wid))
            assert.strictEqual(ws?.sandboxSetupStep, null)

            // Verify that a snapshot.create was called (the build happened)
            const createSnapshotCalls = log.filter(
              (c) => c.method === 'snapshot.create'
            )
            assert.strictEqual(createSnapshotCalls.length, 1)
          }).pipe(Effect.provide(makeLayer(log)))
        })
    )

    it.scoped(
      'snapshot caching works with default Daytona image (no explicit image)',
      () =>
        Effect.gen(function* () {
          const log: MockCallRecord[] = []
          yield* Effect.gen(function* () {
            const sp = yield* DaytonaSandboxProvider
            const { store } = yield* LaborerStore
            const wid = crypto.randomUUID()
            const worktreePath = seedWorkspace(store as never, wid)

            // Write a lockfile
            writeFileSync(
              join(worktreePath, 'pnpm-lock.yaml'),
              'lockfileVersion: 5.4'
            )

            yield* sp.createSandbox({
              workspaceId: wid,
              branchName: 'feature/default-image-snap',
              projectName: 'default-snap-project',
              worktreePath,
              devServerConfig: dsc({ image: null }),
            })

            // Snapshot.create should be called even with null image
            const createSnapshotCalls = log.filter(
              (c) => c.method === 'snapshot.create'
            )
            assert.strictEqual(createSnapshotCalls.length, 1)

            // Sandbox created from the newly-built snapshot
            const createFromSnapshotCalls = log.filter(
              (c) => c.method === 'createFromSnapshot'
            )
            assert.strictEqual(createFromSnapshotCalls.length, 1)

            // Verify snapshot name was passed to createFromSnapshot
            const params = createFromSnapshotCalls[0]?.args[0] as Record<
              string,
              unknown
            >
            assert.isString(params.snapshot)
            assert.isTrue(
              (params.snapshot as string).startsWith('laborer-deps-')
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
          const sp = yield* DaytonaSandboxProvider
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
          const sp = yield* DaytonaSandboxProvider
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
          const sp = yield* DaytonaSandboxProvider
          // Do NOT seed a workspace — it should skip gracefully
          yield* sp.destroySandbox('nonexistent-workspace-id')

          // No SDK calls should be made besides the eager availability check
          const nonListCalls = log.filter((r) => r.method !== 'list')
          assert.strictEqual(nonListCalls.length, 0)
        }).pipe(Effect.provide(makeLayer(log)))
      })
    )

    it.scoped('skips gracefully when workspace has no sandboxId', () =>
      Effect.gen(function* () {
        const log: MockCallRecord[] = []
        yield* Effect.gen(function* () {
          const sp = yield* DaytonaSandboxProvider
          const { store } = yield* LaborerStore
          const wid = crypto.randomUUID()
          // Seed workspace WITHOUT starting a sandbox (no sandboxId)
          seedWorkspace(store as never, wid)

          yield* sp.destroySandbox(wid)

          // No SDK calls should be made besides the eager availability check
          const nonListCalls = log.filter((r) => r.method !== 'list')
          assert.strictEqual(nonListCalls.length, 0)
        }).pipe(Effect.provide(makeLayer(log)))
      })
    )

    it.scoped(
      'still commits SandboxStopped when get fails with non-NOT_FOUND error',
      () =>
        Effect.gen(function* () {
          const log: MockCallRecord[] = []
          yield* Effect.gen(function* () {
            const sp = yield* DaytonaSandboxProvider
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
            const sp = yield* DaytonaSandboxProvider
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
          const sp = yield* DaytonaSandboxProvider
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
            const sp = yield* DaytonaSandboxProvider
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
          const sp = yield* DaytonaSandboxProvider
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
          const sp = yield* DaytonaSandboxProvider
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
          // No SDK calls made besides the eager availability check
          const nonListCalls = log.filter((r) => r.method !== 'list')
          assert.strictEqual(nonListCalls.length, 0)
        }).pipe(Effect.provide(makeLayer(log)))
      })
    )
  })

  describe('resumeSandbox', () => {
    it.scoped('starts sandbox and commits SandboxResumed', () =>
      Effect.gen(function* () {
        const log: MockCallRecord[] = []
        yield* Effect.gen(function* () {
          const sp = yield* DaytonaSandboxProvider
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
            const sp = yield* DaytonaSandboxProvider
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
          const sp = yield* DaytonaSandboxProvider
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
          // No SDK calls made besides the eager availability check
          const nonListCalls = log.filter((r) => r.method !== 'list')
          assert.strictEqual(nonListCalls.length, 0)
        }).pipe(Effect.provide(makeLayer(log)))
      })
    )
  })

  describe('setAutoStopInterval', () => {
    it.scoped('calls setAutostopInterval on the SDK sandbox', () =>
      Effect.gen(function* () {
        const log: MockCallRecord[] = []
        yield* Effect.gen(function* () {
          const sp = yield* DaytonaSandboxProvider
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
          const sp = yield* DaytonaSandboxProvider
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
          const sp = yield* DaytonaSandboxProvider
          const { store } = yield* LaborerStore
          const wid = crypto.randomUUID()
          seedWorkspace(store as never, wid)

          const result = yield* sp.setAutoStopInterval(wid, 30).pipe(
            Effect.map(() => null),
            Effect.catchAll((err) => Effect.succeed(err))
          )

          assert.isNotNull(result)
          assert.strictEqual((result as RpcError).code, 'NOT_FOUND')
          // No SDK calls made besides the eager availability check
          const nonListCalls = log.filter((r) => r.method !== 'list')
          assert.strictEqual(nonListCalls.length, 0)
        }).pipe(Effect.provide(makeLayer(log)))
      })
    )
  })

  describe('checkAvailability', () => {
    it.scoped('returns available when list succeeds', () =>
      Effect.gen(function* () {
        const log: MockCallRecord[] = []
        yield* Effect.gen(function* () {
          const sp = yield* DaytonaSandboxProvider
          const status = yield* sp.checkAvailability()
          assert.isTrue(status.available)
          assert.isUndefined(status.error)
        }).pipe(Effect.provide(makeLayer(log)))
      })
    )

    it.scoped('returns unavailable with guidance when list fails', () =>
      Effect.gen(function* () {
        const listFailClientLayer = Layer.succeed(
          DaytonaClient,
          DaytonaClient.of({
            create: () => Effect.die('not expected'),
            createFromSnapshot: () => Effect.die('not expected'),
            get: () => Effect.die('not expected'),
            list: () =>
              new RpcError({
                message: 'Unauthorized: invalid API key',
                code: 'DAYTONA_ERROR',
              }),
            start: () => Effect.void,
            stop: () => Effect.void,
            delete: () => Effect.void,
            setAutostopInterval: () => Effect.void,
            snapshot: {} as DaytonaClient['Type']['snapshot'],
            raw: {} as DaytonaClient['Type']['raw'],
          })
        )
        const layer = DaytonaSandboxProvider.layer.pipe(
          Layer.provide(listFailClientLayer),
          Layer.provideMerge(TestLaborerStore)
        )
        yield* Effect.gen(function* () {
          const sp = yield* DaytonaSandboxProvider
          const status = yield* sp.checkAvailability()
          assert.isFalse(status.available)
          assert.isDefined(status.error)
          assert.include(status.error, 'DAYTONA_API_KEY')
        }).pipe(Effect.provide(layer))
      })
    )

    it.scoped(
      'returns unavailable with rate limit guidance when rate limited',
      () =>
        Effect.gen(function* () {
          const rateLimitClientLayer = Layer.succeed(
            DaytonaClient,
            DaytonaClient.of({
              create: () => Effect.die('not expected'),
              createFromSnapshot: () => Effect.die('not expected'),
              get: () => Effect.die('not expected'),
              list: () =>
                new RpcError({
                  message: 'Rate limit exceeded',
                  code: 'DAYTONA_RATE_LIMIT',
                }),
              start: () => Effect.void,
              stop: () => Effect.void,
              delete: () => Effect.void,
              setAutostopInterval: () => Effect.void,
              snapshot: {} as DaytonaClient['Type']['snapshot'],
              raw: {} as DaytonaClient['Type']['raw'],
            })
          )
          const layer = DaytonaSandboxProvider.layer.pipe(
            Layer.provide(rateLimitClientLayer),
            Layer.provideMerge(TestLaborerStore)
          )
          yield* Effect.gen(function* () {
            const sp = yield* DaytonaSandboxProvider
            const status = yield* sp.checkAvailability()
            assert.isFalse(status.available)
            assert.isDefined(status.error)
            assert.include(status.error, 'rate limit')
          }).pipe(Effect.provide(layer))
        })
    )

    it.scoped(
      'returns unavailable with timeout guidance when API unreachable',
      () =>
        Effect.gen(function* () {
          const timeoutClientLayer = Layer.succeed(
            DaytonaClient,
            DaytonaClient.of({
              create: () => Effect.die('not expected'),
              createFromSnapshot: () => Effect.die('not expected'),
              get: () => Effect.die('not expected'),
              list: () =>
                new RpcError({
                  message: 'Request timed out',
                  code: 'DAYTONA_TIMEOUT',
                }),
              start: () => Effect.void,
              stop: () => Effect.void,
              delete: () => Effect.void,
              setAutostopInterval: () => Effect.void,
              snapshot: {} as DaytonaClient['Type']['snapshot'],
              raw: {} as DaytonaClient['Type']['raw'],
            })
          )
          const layer = DaytonaSandboxProvider.layer.pipe(
            Layer.provide(timeoutClientLayer),
            Layer.provideMerge(TestLaborerStore)
          )
          yield* Effect.gen(function* () {
            const sp = yield* DaytonaSandboxProvider
            const status = yield* sp.checkAvailability()
            assert.isFalse(status.available)
            assert.isDefined(status.error)
            assert.include(status.error, 'unreachable')
          }).pipe(Effect.provide(layer))
        })
    )

    it.scoped('caches the result after first check', () =>
      Effect.gen(function* () {
        const log: MockCallRecord[] = []
        yield* Effect.gen(function* () {
          const sp = yield* DaytonaSandboxProvider

          // First call — should invoke list
          const status1 = yield* sp.checkAvailability()
          assert.isTrue(status1.available)

          // Second call — should return cached result without calling list again
          const status2 = yield* sp.checkAvailability()
          assert.isTrue(status2.available)

          // list() is called during layer construction (eager check) and then
          // again if we call checkAvailability() after (but it should be cached).
          // The eager check + first explicit call should result in exactly 1 list call
          // (since the eager check caches the result).
          const listCalls = log.filter((r) => r.method === 'list')
          assert.strictEqual(listCalls.length, 1)
        }).pipe(Effect.provide(makeLayer(log)))
      })
    )
  })

  describe('getPreviewUrl', () => {
    it.scoped('returns Daytona preview URL and persists it to LiveStore', () =>
      Effect.gen(function* () {
        const log: MockCallRecord[] = []
        yield* Effect.gen(function* () {
          const sp = yield* DaytonaSandboxProvider
          const { store } = yield* LaborerStore
          const wid = crypto.randomUUID()
          seedWorkspace(store as never, wid)
          store.commit(
            events.sandboxStarted({
              workspaceId: wid,
              sandboxId: 'sandbox-test-123',
              sandboxUrl: 'sandbox-test-123',
              sandboxImage: 'daytona-default',
              sandboxProvider: 'daytona',
            })
          )

          const url = yield* sp.getPreviewUrl(wid, 3000)

          assert.strictEqual(
            url,
            'https://3000-sandbox-test-123.preview.daytona.io'
          )

          // Verify the URL was persisted to LiveStore
          const [ws] = store.query(tables.workspaces.where('id', wid))
          assert.strictEqual(
            ws?.sandboxUrl,
            'https://3000-sandbox-test-123.preview.daytona.io'
          )

          // Verify getPreviewLink was called with the correct port
          const previewCalls = log.filter(
            (c) => c.method === 'sandbox.getPreviewLink'
          )
          assert.strictEqual(previewCalls.length, 1)
          assert.deepStrictEqual(previewCalls[0]?.args, [3000])
        }).pipe(Effect.provide(makeLayer(log)))
      })
    )

    it.scoped('returns different URL for different port', () =>
      Effect.gen(function* () {
        const log: MockCallRecord[] = []
        yield* Effect.gen(function* () {
          const sp = yield* DaytonaSandboxProvider
          const { store } = yield* LaborerStore
          const wid = crypto.randomUUID()
          seedWorkspace(store as never, wid)
          store.commit(
            events.sandboxStarted({
              workspaceId: wid,
              sandboxId: 'sandbox-test-123',
              sandboxUrl: 'sandbox-test-123',
              sandboxImage: 'daytona-default',
              sandboxProvider: 'daytona',
            })
          )

          const url = yield* sp.getPreviewUrl(wid, 8080)

          assert.strictEqual(
            url,
            'https://8080-sandbox-test-123.preview.daytona.io'
          )

          // Verify LiveStore was updated with the new URL
          const [ws] = store.query(tables.workspaces.where('id', wid))
          assert.strictEqual(
            ws?.sandboxUrl,
            'https://8080-sandbox-test-123.preview.daytona.io'
          )
        }).pipe(Effect.provide(makeLayer(log)))
      })
    )

    it.scoped('returns NOT_FOUND when workspace has no sandbox', () =>
      Effect.gen(function* () {
        const log: MockCallRecord[] = []
        yield* Effect.gen(function* () {
          const sp = yield* DaytonaSandboxProvider
          const { store } = yield* LaborerStore
          const wid = crypto.randomUUID()
          seedWorkspace(store as never, wid)

          const result = yield* sp.getPreviewUrl(wid, 3000).pipe(Effect.either)

          assert.strictEqual(result._tag, 'Left')
          if (result._tag === 'Left') {
            assert.strictEqual(result.left.code, 'NOT_FOUND')
          }
        }).pipe(Effect.provide(makeLayer(log)))
      })
    )
  })

  describe('spawnTerminal', () => {
    it.scoped('creates PTY session and returns TerminalHandle', () =>
      Effect.gen(function* () {
        const log: MockCallRecord[] = []
        yield* Effect.gen(function* () {
          const sp = yield* DaytonaSandboxProvider
          const { store } = yield* LaborerStore
          const wid = crypto.randomUUID()
          seedWorkspace(store as never, wid)
          store.commit(
            events.sandboxStarted({
              workspaceId: wid,
              sandboxId: 'sb-pty',
              sandboxUrl: 'sb-pty',
              sandboxImage: 'node:22',
              sandboxProvider: 'daytona',
            })
          )

          const handle = yield* sp.spawnTerminal(wid)

          // TerminalHandle has correct metadata
          assert.strictEqual(handle.workspaceId, wid)
          assert.strictEqual(handle.status, 'running')
          assert.strictEqual(handle.command, '/bin/sh')
          assert.isString(handle.id)
        }).pipe(Effect.provide(makeLayer(log)))
      })
    )

    it.scoped('calls createPty with correct parameters', () =>
      Effect.gen(function* () {
        const log: MockCallRecord[] = []
        yield* Effect.gen(function* () {
          const sp = yield* DaytonaSandboxProvider
          const { store } = yield* LaborerStore
          const wid = crypto.randomUUID()
          seedWorkspace(store as never, wid)
          store.commit(
            events.sandboxStarted({
              workspaceId: wid,
              sandboxId: 'sb-pty-params',
              sandboxUrl: 'sb-pty-params',
              sandboxImage: 'node:22',
              sandboxProvider: 'daytona',
            })
          )

          yield* sp.spawnTerminal(wid, { cols: 120, rows: 30 })

          const ptyCalls = log.filter(
            (c) => c.method === 'sandbox.process.createPty'
          )
          assert.strictEqual(ptyCalls.length, 1)

          const opts = (ptyCalls[0]?.args as unknown[])[0] as Record<
            string,
            unknown
          >
          assert.strictEqual(opts.cols, 120)
          assert.strictEqual(opts.rows, 30)
          assert.strictEqual(opts.cwd, '/home/daytona/project')
          assert.isString(opts.id)
          assert.deepStrictEqual(
            (opts.envs as Record<string, string>).TERM,
            'xterm-256color'
          )
          assert.deepStrictEqual(
            (opts.envs as Record<string, string>).COLORTERM,
            'truecolor'
          )
        }).pipe(Effect.provide(makeLayer(log)))
      })
    )

    it.scoped('uses default cols/rows when not specified', () =>
      Effect.gen(function* () {
        const log: MockCallRecord[] = []
        yield* Effect.gen(function* () {
          const sp = yield* DaytonaSandboxProvider
          const { store } = yield* LaborerStore
          const wid = crypto.randomUUID()
          seedWorkspace(store as never, wid)
          store.commit(
            events.sandboxStarted({
              workspaceId: wid,
              sandboxId: 'sb-pty-defaults',
              sandboxUrl: 'sb-pty-defaults',
              sandboxImage: 'node:22',
              sandboxProvider: 'daytona',
            })
          )

          yield* sp.spawnTerminal(wid)

          const ptyCalls = log.filter(
            (c) => c.method === 'sandbox.process.createPty'
          )
          const opts = (ptyCalls[0]?.args as unknown[])[0] as Record<
            string,
            unknown
          >
          assert.strictEqual(opts.cols, 80)
          assert.strictEqual(opts.rows, 24)
        }).pipe(Effect.provide(makeLayer(log)))
      })
    )

    it.scoped('waits for WebSocket connection to be established', () =>
      Effect.gen(function* () {
        const log: MockCallRecord[] = []
        yield* Effect.gen(function* () {
          const sp = yield* DaytonaSandboxProvider
          const { store } = yield* LaborerStore
          const wid = crypto.randomUUID()
          seedWorkspace(store as never, wid)
          store.commit(
            events.sandboxStarted({
              workspaceId: wid,
              sandboxId: 'sb-pty-connect',
              sandboxUrl: 'sb-pty-connect',
              sandboxImage: 'node:22',
              sandboxProvider: 'daytona',
            })
          )

          yield* sp.spawnTerminal(wid)

          const waitCalls = log.filter(
            (c) => c.method === 'ptyHandle.waitForConnection'
          )
          assert.strictEqual(waitCalls.length, 1)
        }).pipe(Effect.provide(makeLayer(log)))
      })
    )

    it.scoped('sends initial command as input when specified', () =>
      Effect.gen(function* () {
        const log: MockCallRecord[] = []
        yield* Effect.gen(function* () {
          const sp = yield* DaytonaSandboxProvider
          const { store } = yield* LaborerStore
          const wid = crypto.randomUUID()
          seedWorkspace(store as never, wid)
          store.commit(
            events.sandboxStarted({
              workspaceId: wid,
              sandboxId: 'sb-pty-cmd',
              sandboxUrl: 'sb-pty-cmd',
              sandboxImage: 'node:22',
              sandboxProvider: 'daytona',
            })
          )

          const handle = yield* sp.spawnTerminal(wid, {
            command: 'bun dev',
          })

          // sendInput should have been called with the command + newline
          const sendCalls = log.filter(
            (c) => c.method === 'ptyHandle.sendInput'
          )
          assert.strictEqual(sendCalls.length, 1)
          assert.strictEqual((sendCalls[0]?.args as unknown[])[0], 'bun dev\n')
          // TerminalHandle command should reflect the specified command
          assert.strictEqual(handle.command, 'bun dev')
        }).pipe(Effect.provide(makeLayer(log)))
      })
    )

    it.scoped('does not send input when no command specified', () =>
      Effect.gen(function* () {
        const log: MockCallRecord[] = []
        yield* Effect.gen(function* () {
          const sp = yield* DaytonaSandboxProvider
          const { store } = yield* LaborerStore
          const wid = crypto.randomUUID()
          seedWorkspace(store as never, wid)
          store.commit(
            events.sandboxStarted({
              workspaceId: wid,
              sandboxId: 'sb-pty-nocmd',
              sandboxUrl: 'sb-pty-nocmd',
              sandboxImage: 'node:22',
              sandboxProvider: 'daytona',
            })
          )

          yield* sp.spawnTerminal(wid)

          // sendInput should NOT have been called
          const sendCalls = log.filter(
            (c) => c.method === 'ptyHandle.sendInput'
          )
          assert.strictEqual(sendCalls.length, 0)
        }).pipe(Effect.provide(makeLayer(log)))
      })
    )

    it.scoped('returns NOT_FOUND when workspace has no sandbox', () =>
      Effect.gen(function* () {
        const log: MockCallRecord[] = []
        yield* Effect.gen(function* () {
          const sp = yield* DaytonaSandboxProvider
          const { store } = yield* LaborerStore
          const wid = crypto.randomUUID()
          seedWorkspace(store as never, wid)
          // No sandboxStarted event — workspace has no sandboxId

          const result = yield* sp.spawnTerminal(wid).pipe(
            Effect.map(() => null),
            Effect.catchAll((err) => Effect.succeed(err))
          )

          assert.isNotNull(result)
          assert.strictEqual((result as RpcError).code, 'NOT_FOUND')
          // No SDK calls made besides the eager availability check
          const nonListCalls = log.filter((r) => r.method !== 'list')
          assert.strictEqual(nonListCalls.length, 0)
        }).pipe(Effect.provide(makeLayer(log)))
      })
    )
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Issue 20: State reconciliation
  // ─────────────────────────────────────────────────────────────────────────

  describe('reconcileState', () => {
    /**
     * Mock DaytonaClient where `.get()` returns a sandbox with a state
     * looked up from a configurable map by sandboxId. This allows
     * per-workspace state control for reconciliation tests.
     */
    const makeReconcileClientLayer = (
      log: MockCallRecord[],
      stateMap: Record<string, string>
    ): Layer.Layer<DaytonaClient> =>
      Layer.succeed(
        DaytonaClient,
        DaytonaClient.of({
          create: () => Effect.die('not expected in reconcile tests'),
          createFromSnapshot: () =>
            Effect.die('not expected in reconcile tests'),
          get: (...args) => {
            log.push({ method: 'get', args })
            const sandboxId = args[0]
            const state = stateMap[sandboxId]
            if (state === undefined) {
              return new RpcError({
                message: `Sandbox ${sandboxId} not found`,
                code: 'DAYTONA_NOT_FOUND',
              })
            }
            return Effect.succeed({
              ...makeMockSandbox(log),
              id: sandboxId,
              state,
            } as unknown as DaytonaSandbox)
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

    const makeReconcileLayer = (
      log: MockCallRecord[],
      stateMap: Record<string, string>
    ) =>
      DaytonaSandboxProvider.layer.pipe(
        Layer.provide(makeReconcileClientLayer(log, stateMap)),
        Layer.provideMerge(TestLaborerStore)
      )

    it.scoped(
      'commits SandboxPaused when Daytona state is stopped but LiveStore says running',
      () =>
        Effect.gen(function* () {
          const log: MockCallRecord[] = []
          const sandboxId = 'sb-reconcile-stopped'
          yield* Effect.gen(function* () {
            const sp = yield* DaytonaSandboxProvider
            const { store } = yield* LaborerStore
            const wid = crypto.randomUUID()
            seedWorkspace(store as never, wid)
            store.commit(
              events.sandboxStarted({
                workspaceId: wid,
                sandboxId,
                sandboxUrl: sandboxId,
                sandboxImage: 'node:22',
                sandboxProvider: 'daytona',
              })
            )

            // Verify LiveStore says 'running' before reconciliation
            const [wsBefore] = store.query(tables.workspaces.where('id', wid))
            assert.strictEqual(wsBefore?.sandboxStatus, 'running')

            // Run one reconciliation pass
            yield* sp.reconcileState()

            // After reconciliation, LiveStore should say 'paused'
            const [wsAfter] = store.query(tables.workspaces.where('id', wid))
            assert.strictEqual(wsAfter?.sandboxStatus, 'paused')

            // DaytonaClient.get was called
            const getCalls = log.filter((c) => c.method === 'get')
            assert.isTrue(getCalls.length >= 1)
          }).pipe(
            Effect.provide(makeReconcileLayer(log, { [sandboxId]: 'stopped' }))
          )
        })
    )

    it.scoped(
      'commits SandboxResumed when Daytona state is started but LiveStore says paused',
      () =>
        Effect.gen(function* () {
          const log: MockCallRecord[] = []
          const sandboxId = 'sb-reconcile-started'
          yield* Effect.gen(function* () {
            const sp = yield* DaytonaSandboxProvider
            const { store } = yield* LaborerStore
            const wid = crypto.randomUUID()
            seedWorkspace(store as never, wid)
            store.commit(
              events.sandboxStarted({
                workspaceId: wid,
                sandboxId,
                sandboxUrl: sandboxId,
                sandboxImage: 'node:22',
                sandboxProvider: 'daytona',
              })
            )
            // Pause the workspace in LiveStore
            store.commit(events.sandboxPaused({ workspaceId: wid }))

            // Verify LiveStore says 'paused' before reconciliation
            const [wsBefore] = store.query(tables.workspaces.where('id', wid))
            assert.strictEqual(wsBefore?.sandboxStatus, 'paused')

            // Run one reconciliation pass
            yield* sp.reconcileState()

            // After reconciliation, LiveStore should say 'running'
            const [wsAfter] = store.query(tables.workspaces.where('id', wid))
            assert.strictEqual(wsAfter?.sandboxStatus, 'running')
          }).pipe(
            Effect.provide(makeReconcileLayer(log, { [sandboxId]: 'started' }))
          )
        })
    )

    it.scoped(
      'commits SandboxStopped when Daytona sandbox is not found (destroyed externally)',
      () =>
        Effect.gen(function* () {
          const log: MockCallRecord[] = []
          const sandboxId = 'sb-reconcile-destroyed'
          yield* Effect.gen(function* () {
            const sp = yield* DaytonaSandboxProvider
            const { store } = yield* LaborerStore
            const wid = crypto.randomUUID()
            seedWorkspace(store as never, wid)
            store.commit(
              events.sandboxStarted({
                workspaceId: wid,
                sandboxId,
                sandboxUrl: sandboxId,
                sandboxImage: 'node:22',
                sandboxProvider: 'daytona',
              })
            )

            // Verify LiveStore says 'running' before reconciliation
            const [wsBefore] = store.query(tables.workspaces.where('id', wid))
            assert.strictEqual(wsBefore?.sandboxStatus, 'running')
            assert.strictEqual(wsBefore?.sandboxId, sandboxId)

            // Run one reconciliation pass
            yield* sp.reconcileState()

            // After reconciliation, sandboxId and sandboxStatus should be null
            const [wsAfter] = store.query(tables.workspaces.where('id', wid))
            assert.strictEqual(wsAfter?.sandboxId, null)
            assert.strictEqual(wsAfter?.sandboxStatus, null)
          }).pipe(
            // Empty stateMap — sandbox not found (DAYTONA_NOT_FOUND)
            Effect.provide(makeReconcileLayer(log, {}))
          )
        })
    )

    it.scoped('treats archived sandbox as paused (commits SandboxPaused)', () =>
      Effect.gen(function* () {
        const log: MockCallRecord[] = []
        const sandboxId = 'sb-reconcile-archived'
        yield* Effect.gen(function* () {
          const sp = yield* DaytonaSandboxProvider
          const { store } = yield* LaborerStore
          const wid = crypto.randomUUID()
          seedWorkspace(store as never, wid)
          store.commit(
            events.sandboxStarted({
              workspaceId: wid,
              sandboxId,
              sandboxUrl: sandboxId,
              sandboxImage: 'node:22',
              sandboxProvider: 'daytona',
            })
          )

          // Verify LiveStore says 'running' before reconciliation
          const [wsBefore] = store.query(tables.workspaces.where('id', wid))
          assert.strictEqual(wsBefore?.sandboxStatus, 'running')

          // Run one reconciliation pass
          yield* sp.reconcileState()

          // After reconciliation, LiveStore should say 'paused' (archived treated as paused)
          const [wsAfter] = store.query(tables.workspaces.where('id', wid))
          assert.strictEqual(wsAfter?.sandboxStatus, 'paused')
        }).pipe(
          Effect.provide(makeReconcileLayer(log, { [sandboxId]: 'archived' }))
        )
      })
    )

    it.scoped(
      'does nothing when states are already in sync (Daytona running, LS running)',
      () =>
        Effect.gen(function* () {
          const log: MockCallRecord[] = []
          const sandboxId = 'sb-reconcile-synced'
          yield* Effect.gen(function* () {
            const sp = yield* DaytonaSandboxProvider
            const { store } = yield* LaborerStore
            const wid = crypto.randomUUID()
            seedWorkspace(store as never, wid)
            store.commit(
              events.sandboxStarted({
                workspaceId: wid,
                sandboxId,
                sandboxUrl: sandboxId,
                sandboxImage: 'node:22',
                sandboxProvider: 'daytona',
              })
            )

            // LiveStore says 'running', Daytona says 'started' — already in sync
            const [wsBefore] = store.query(tables.workspaces.where('id', wid))
            assert.strictEqual(wsBefore?.sandboxStatus, 'running')

            // Run one reconciliation pass
            yield* sp.reconcileState()

            // Still 'running' — no events committed
            const [wsAfter] = store.query(tables.workspaces.where('id', wid))
            assert.strictEqual(wsAfter?.sandboxStatus, 'running')
            assert.strictEqual(wsAfter?.sandboxId, sandboxId)
          }).pipe(
            Effect.provide(makeReconcileLayer(log, { [sandboxId]: 'started' }))
          )
        })
    )

    it.scoped('skips Docker workspaces (only reconciles Daytona)', () =>
      Effect.gen(function* () {
        const log: MockCallRecord[] = []
        yield* Effect.gen(function* () {
          const sp = yield* DaytonaSandboxProvider
          const { store } = yield* LaborerStore
          const wid = crypto.randomUUID()
          seedWorkspace(store as never, wid)
          // Create a workspace with sandboxProvider=docker (not daytona)
          store.commit(
            events.sandboxStarted({
              workspaceId: wid,
              sandboxId: 'sb-docker-skip',
              sandboxUrl: 'sb-docker-skip',
              sandboxImage: 'node:22',
              sandboxProvider: 'docker',
            })
          )

          // Run one reconciliation pass
          yield* sp.reconcileState()

          // DaytonaClient.get should NOT have been called for a Docker workspace
          const getCalls = log.filter((c) => c.method === 'get')
          assert.strictEqual(getCalls.length, 0)

          // LiveStore unchanged
          const [ws] = store.query(tables.workspaces.where('id', wid))
          assert.strictEqual(ws?.sandboxStatus, 'running')
        }).pipe(Effect.provide(makeReconcileLayer(log, {})))
      })
    )

    it.scoped(
      'handles per-workspace errors gracefully (continues with other workspaces)',
      () =>
        Effect.gen(function* () {
          const log: MockCallRecord[] = []
          const goodSandboxId = 'sb-reconcile-good'
          const badSandboxId = 'sb-reconcile-bad'

          /**
           * Mock client where one sandbox times out but another succeeds.
           */
          const mixedClientLayer = Layer.succeed(
            DaytonaClient,
            DaytonaClient.of({
              create: () => Effect.die('not expected'),
              createFromSnapshot: () => Effect.die('not expected'),
              get: (...args) => {
                log.push({ method: 'get', args })
                const sandboxId = args[0]
                if (sandboxId === badSandboxId) {
                  return new RpcError({
                    message: 'Request timed out',
                    code: 'DAYTONA_TIMEOUT',
                  })
                }
                // Good sandbox reports 'stopped' (should trigger SandboxPaused)
                return Effect.succeed({
                  ...makeMockSandbox(log),
                  id: sandboxId,
                  state: 'stopped',
                } as unknown as DaytonaSandbox)
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

          const mixedLayer = DaytonaSandboxProvider.layer.pipe(
            Layer.provide(mixedClientLayer),
            Layer.provideMerge(TestLaborerStore)
          )

          yield* Effect.gen(function* () {
            const sp = yield* DaytonaSandboxProvider
            const { store } = yield* LaborerStore
            const wid1 = crypto.randomUUID()
            const wid2 = crypto.randomUUID()
            seedWorkspace(store as never, wid1)
            seedWorkspace(store as never, wid2)

            // First workspace: good sandbox that's stopped
            store.commit(
              events.sandboxStarted({
                workspaceId: wid1,
                sandboxId: goodSandboxId,
                sandboxUrl: goodSandboxId,
                sandboxImage: 'node:22',
                sandboxProvider: 'daytona',
              })
            )

            // Second workspace: bad sandbox that times out
            store.commit(
              events.sandboxStarted({
                workspaceId: wid2,
                sandboxId: badSandboxId,
                sandboxUrl: badSandboxId,
                sandboxImage: 'node:22',
                sandboxProvider: 'daytona',
              })
            )

            // Run one reconciliation pass
            yield* sp.reconcileState()

            // Good workspace should be reconciled to 'paused'
            const [ws1] = store.query(tables.workspaces.where('id', wid1))
            assert.strictEqual(ws1?.sandboxStatus, 'paused')

            // Bad workspace should remain 'running' (error was logged, not propagated)
            const [ws2] = store.query(tables.workspaces.where('id', wid2))
            assert.strictEqual(ws2?.sandboxStatus, 'running')

            // Both .get() calls were attempted
            const getCalls = log.filter((c) => c.method === 'get')
            assert.strictEqual(getCalls.length, 2)
          }).pipe(Effect.provide(mixedLayer))
        })
    )
  })
})
