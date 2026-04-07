/**
 * Tests for DaytonaSandboxProvider — Issues 13, 14, & 19
 *
 * Issue 13: Verifies createSandbox with a mocked DaytonaClient, ensuring correct
 * SDK parameters and LiveStore event commits. No real API calls.
 *
 * Issue 14: Verifies destroySandbox lifecycle — deletion, idempotent handling of
 * already-destroyed sandboxes, graceful skip when workspace is missing or has no
 * sandboxId, and best-effort cleanup when delete fails.
 *
 * Issue 19: Verifies pauseSandbox and resumeSandbox idempotency — pausing
 * an already-stopped/archived sandbox skips the SDK stop call, resuming an
 * already-started sandbox skips the SDK start call. Also tests
 * setAutoStopInterval delegation to the SDK.
 */

import { CodeLanguage } from '@daytonaio/sdk'
import { assert, describe, it } from '@effect/vitest'
import { RpcError } from '@laborer/shared/rpc'
import { events, tables } from '@laborer/shared/schema'
import { Effect, Layer, Ref } from 'effect'
import type {
  DaytonaPaginatedSandboxes,
  DaytonaSandbox,
} from '../../server/src/services/daytona-client.js'
import { DaytonaClient } from '../../server/src/services/daytona-client.js'
import { DaytonaSandboxProvider } from '../../server/src/services/daytona-sandbox-provider.js'
import { LaborerStore } from '../../server/src/services/laborer-store.js'
import { SandboxProvider } from '../../server/src/services/sandbox-provider.js'
import { TestLaborerStore } from './helpers/test-store.js'

// ---------------------------------------------------------------------------
// Types & helpers
// ---------------------------------------------------------------------------

interface MockCallRecord {
  readonly args: readonly unknown[]
  readonly method: string
}

const makeMockSandbox = (): DaytonaSandbox =>
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
    process: {} as DaytonaSandbox['process'],
    computerUse: {} as DaytonaSandbox['computerUse'],
    codeInterpreter: {} as DaytonaSandbox['codeInterpreter'],
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
  const sb = makeMockSandbox()
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
  const sb = makeMockSandbox()
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
  const sb = { ...makeMockSandbox(), state } as unknown as DaytonaSandbox
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
// Seed helpers
// ---------------------------------------------------------------------------

const seedWorkspace = (
  store: { commit: (e: unknown) => void },
  workspaceId: string,
  projectName = 'test-project',
  branchName = 'feature/test'
) => {
  const projectId = `project-${crypto.randomUUID()}`
  store.commit(
    events.projectCreated({
      id: projectId,
      repoPath: '/tmp/test-repo',
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
      worktreePath: `/tmp/worktrees/${branchName}`,
      status: 'creating',
      origin: 'laborer',
      createdAt: new Date().toISOString(),
      baseSha: null,
    })
  )
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
          seedWorkspace(store as never, wid)

          yield* sp.createSandbox({
            workspaceId: wid,
            branchName: 'feature/test',
            projectName: 'test-project',
            worktreePath: '/tmp/worktrees/feature/test',
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
          seedWorkspace(store as never, wid)

          yield* sp.createSandbox({
            workspaceId: wid,
            branchName: 'feature/default',
            projectName: 'default-project',
            worktreePath: '/tmp/worktrees/feature/default',
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
          seedWorkspace(store as never, wid)
          const called = yield* Ref.make(false)

          yield* sp.createSandbox({
            workspaceId: wid,
            branchName: 'feature/cb',
            projectName: 'cb-project',
            worktreePath: '/tmp/worktrees/feature/cb',
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
          seedWorkspace(store as never, wid, 'my-project', 'feat/cool')

          yield* sp.createSandbox({
            workspaceId: wid,
            branchName: 'feat/cool',
            projectName: 'my-project',
            worktreePath: '/tmp/worktrees/feat/cool',
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
