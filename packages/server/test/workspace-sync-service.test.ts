import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assert, describe, it } from '@effect/vitest'
import { events, tables } from '@laborer/shared/schema'
import { Context, Effect, Layer, Ref } from 'effect'
import { afterAll } from 'vitest'
import { LaborerStore } from '../src/services/laborer-store.js'
import { PrWatcher } from '../src/services/pr-watcher.js'
import { WorkspaceSyncService } from '../src/services/workspace-sync-service.js'
import { createTempDir, git, initRepo } from './helpers/git-helpers.js'
import { TestLaborerStore } from './helpers/test-store.js'

const tempRoots: string[] = []

afterAll(() => {
  for (const root of tempRoots) {
    if (existsSync(root)) {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

class TestPrWatcherRecorder extends Context.Tag(
  '@laborer/test/TestPrWatcherRecorder'
)<
  TestPrWatcherRecorder,
  {
    readonly checkPrCalls: Ref.Ref<readonly string[]>
  }
>() {}

const TestPrWatcherRecorderLayer = Layer.effect(
  TestPrWatcherRecorder,
  Effect.gen(function* () {
    return TestPrWatcherRecorder.of({
      checkPrCalls: yield* Ref.make<readonly string[]>([]),
    })
  })
)

const TestPrWatcherLayer = Layer.effect(
  PrWatcher,
  Effect.gen(function* () {
    const recorder = yield* TestPrWatcherRecorder

    return PrWatcher.of({
      checkPr: (workspaceId) =>
        Effect.gen(function* () {
          yield* Ref.update(recorder.checkPrCalls, (calls) => [
            ...calls,
            workspaceId,
          ])

          return {
            number: null,
            state: null,
            title: null,
            url: null,
          }
        }),
      isPolling: () => Effect.succeed(false),
      startPolling: () => Effect.void,
      stopAllPolling: () => Effect.void,
      stopPolling: () => Effect.void,
    })
  })
)

const buildWorkspaceSyncService = (
  storeContext: Context.Context<LaborerStore>
) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      WorkspaceSyncService.layer.pipe(
        Layer.provide(TestPrWatcherLayer),
        Layer.provideMerge(TestPrWatcherRecorderLayer),
        Layer.provide(Layer.succeedContext(storeContext))
      )
    )

    return {
      prWatcherRecorder: Context.get(context, TestPrWatcherRecorder),
      workspaceSyncService: Context.get(context, WorkspaceSyncService),
    }
  })

const configureRepo = (repoPath: string) => {
  git('config user.email test@example.com', repoPath)
  git('config user.name Test User', repoPath)
}

const commitFile = (repoPath: string, fileName: string, content: string) => {
  writeFileSync(join(repoPath, fileName), content)
  git(`add ${fileName}`, repoPath)
  git(`commit -m "${fileName}"`, repoPath)
}

const createRemoteClone = (remotePath: string, prefix: string): string => {
  const parentDir = createTempDir(prefix, tempRoots)
  const repoPath = join(parentDir, 'repo')
  git(`clone "${remotePath}" repo`, parentDir)
  configureRepo(repoPath)
  return repoPath
}

const initRemoteRepo = (prefix: string) => {
  const remotePath = createTempDir(`${prefix}-remote`, tempRoots)
  git('init --bare', remotePath)

  const seedPath = initRepo(`${prefix}-seed`, tempRoots)
  git('branch -M main', seedPath)
  git(`remote add origin "${remotePath}"`, seedPath)
  git('push -u origin main', seedPath)

  const localPath = createRemoteClone(remotePath, `${prefix}-local`)
  git('checkout main', localPath)

  return { localPath, remotePath }
}

const createWorkspace = (
  store: { commit: (event: unknown) => void },
  worktreePath: string,
  workspaceId: string,
  status: 'running' | 'stopped' = 'stopped'
) => {
  store.commit(
    events.workspaceCreated({
      id: workspaceId,
      projectId: 'project-1',
      taskSource: null,
      branchName: 'main',
      worktreePath,
      port: 0,
      status,
      origin: 'external',
      createdAt: new Date().toISOString(),
      baseSha: null,
    })
  )
}

describe('WorkspaceSyncService', () => {
  it.scoped(
    'returns WORKSPACE_NOT_FOUND when the workspace does not exist',
    () =>
      Effect.gen(function* () {
        const storeContext = yield* Layer.build(TestLaborerStore)
        const { workspaceSyncService } =
          yield* buildWorkspaceSyncService(storeContext)

        const result = yield* workspaceSyncService
          .checkStatus('missing-workspace')
          .pipe(Effect.either)

        assert.isTrue(result._tag === 'Left')
        if (result._tag === 'Right') {
          assert.fail('Expected missing workspace status lookup to fail')
        }

        assert.strictEqual(result.left.code, 'WORKSPACE_NOT_FOUND')
        assert.strictEqual(
          result.left.message,
          'Workspace not found: missing-workspace'
        )
      })
  )

  it.scoped('returns null counts when no upstream is configured', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('sync-no-upstream', tempRoots)
      const storeContext = yield* Layer.build(TestLaborerStore)
      const { store } = Context.get(storeContext, LaborerStore)

      createWorkspace(store, repoPath, 'workspace-no-upstream')

      const { workspaceSyncService } =
        yield* buildWorkspaceSyncService(storeContext)
      const result = yield* workspaceSyncService.checkStatus(
        'workspace-no-upstream'
      )

      assert.deepStrictEqual(result, {
        aheadCount: null,
        behindCount: null,
      })
    })
  )

  it.scoped('clears cached sync counts for destroyed workspaces', () =>
    Effect.gen(function* () {
      const { localPath, remotePath } = initRemoteRepo('sync-destroyed')
      const remoteClonePath = createRemoteClone(
        remotePath,
        'sync-destroyed-remote'
      )

      commitFile(remoteClonePath, 'remote.txt', 'remote change\n')
      git('push origin main', remoteClonePath)
      git('fetch origin', localPath)

      const storeContext = yield* Layer.build(TestLaborerStore)
      const { store } = Context.get(storeContext, LaborerStore)

      createWorkspace(store, localPath, 'workspace-destroyed')

      const { workspaceSyncService } =
        yield* buildWorkspaceSyncService(storeContext)

      const before = yield* workspaceSyncService.checkStatus(
        'workspace-destroyed'
      )
      assert.strictEqual(before.behindCount, 1)

      store.commit(
        events.workspaceStatusChanged({
          id: 'workspace-destroyed',
          status: 'destroyed',
        })
      )

      const result = yield* workspaceSyncService.checkStatus(
        'workspace-destroyed'
      )
      assert.deepStrictEqual(result, {
        aheadCount: null,
        behindCount: null,
      })

      const workspace = store.query(
        tables.workspaces.where('id', 'workspace-destroyed')
      )
      assert.strictEqual(workspace[0]?.aheadCount, null)
      assert.strictEqual(workspace[0]?.behindCount, null)
    })
  )

  it.scoped('tracks ahead and behind commit counts for upstream branches', () =>
    Effect.gen(function* () {
      const { localPath, remotePath } = initRemoteRepo('sync-ahead-behind')
      const remoteClonePath = createRemoteClone(remotePath, 'sync-remote-work')

      commitFile(localPath, 'local.txt', 'local change\n')
      commitFile(remoteClonePath, 'remote.txt', 'remote change\n')
      git('push origin main', remoteClonePath)
      git('fetch origin', localPath)

      const storeContext = yield* Layer.build(TestLaborerStore)
      const { store } = Context.get(storeContext, LaborerStore)

      createWorkspace(store, localPath, 'workspace-ahead-behind')

      const { workspaceSyncService } =
        yield* buildWorkspaceSyncService(storeContext)
      const result = yield* workspaceSyncService.checkStatus(
        'workspace-ahead-behind'
      )

      assert.deepStrictEqual(result, {
        aheadCount: 1,
        behindCount: 1,
      })

      const workspace = store.query(
        tables.workspaces.where('id', 'workspace-ahead-behind')
      )
      assert.strictEqual(workspace[0]?.aheadCount, 1)
      assert.strictEqual(workspace[0]?.behindCount, 1)
    })
  )

  it.scoped('pushes local commits and refreshes PR state after push', () =>
    Effect.gen(function* () {
      const { localPath, remotePath } = initRemoteRepo('sync-push')

      commitFile(localPath, 'push.txt', 'push me\n')

      const storeContext = yield* Layer.build(TestLaborerStore)
      const { store } = Context.get(storeContext, LaborerStore)

      createWorkspace(store, localPath, 'workspace-push')

      const { prWatcherRecorder, workspaceSyncService } =
        yield* buildWorkspaceSyncService(storeContext)

      const before = yield* workspaceSyncService.checkStatus('workspace-push')
      assert.strictEqual(before.aheadCount, 1)
      assert.strictEqual(before.behindCount, 0)

      const result = yield* workspaceSyncService.push('workspace-push')

      assert.deepStrictEqual(result, {
        aheadCount: 0,
        behindCount: 0,
      })
      assert.strictEqual(git('rev-list --count main', remotePath), '2')

      const checkPrCalls = yield* Ref.get(prWatcherRecorder.checkPrCalls)
      assert.deepStrictEqual(checkPrCalls, ['workspace-push'])
    })
  )

  it.scoped('pulls remote commits and clears behind count after pull', () =>
    Effect.gen(function* () {
      const { localPath, remotePath } = initRemoteRepo('sync-pull')
      const remoteClonePath = createRemoteClone(
        remotePath,
        'sync-pull-remote-work'
      )

      commitFile(remoteClonePath, 'pulled.txt', 'from remote\n')
      git('push origin main', remoteClonePath)
      git('fetch origin', localPath)

      const storeContext = yield* Layer.build(TestLaborerStore)
      const { store } = Context.get(storeContext, LaborerStore)

      createWorkspace(store, localPath, 'workspace-pull')

      const { workspaceSyncService } =
        yield* buildWorkspaceSyncService(storeContext)

      const before = yield* workspaceSyncService.checkStatus('workspace-pull')
      assert.strictEqual(before.aheadCount, 0)
      assert.strictEqual(before.behindCount, 1)

      const result = yield* workspaceSyncService.pull('workspace-pull')

      assert.deepStrictEqual(result, {
        aheadCount: 0,
        behindCount: 0,
      })
      assert.strictEqual(git('show HEAD:pulled.txt', localPath), 'from remote')
    })
  )
})
