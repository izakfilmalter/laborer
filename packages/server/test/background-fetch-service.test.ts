import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assert, describe, it } from '@effect/vitest'
import { events } from '@laborer/shared/schema'
import { Context, Effect, Layer } from 'effect'
import { afterAll } from 'vitest'
import { BackgroundFetchService } from '../src/services/background-fetch-service.js'
import { LaborerStore } from '../src/services/laborer-store.js'
import { createTempDir, git, initRepo } from './helpers/git-helpers.js'
import { TestLaborerStore } from './helpers/test-store.js'

const BRANCH_AB_RE = /^# branch\.ab \+(\d+) -(\d+)$/m

const tempRoots: string[] = []

afterAll(() => {
  for (const root of tempRoots) {
    if (existsSync(root)) {
      rmSync(root, { recursive: true, force: true })
    }
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

const createRemoteClone = (remotePath: string, prefix: string): string => {
  const parentDir = createTempDir(prefix, tempRoots)
  const repoPath = join(parentDir, 'repo')
  git(`clone "${remotePath}" repo`, parentDir)
  configureRepo(repoPath)
  return repoPath
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

const buildBackgroundFetchService = (
  storeContext: Context.Context<LaborerStore>
) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      BackgroundFetchService.layer.pipe(
        Layer.provide(Layer.succeedContext(storeContext))
      )
    )

    return Context.get(context, BackgroundFetchService)
  })

describe('BackgroundFetchService', () => {
  it.scoped('fetchNow succeeds for a workspace with a remote', () =>
    Effect.gen(function* () {
      const { localPath } = initRemoteRepo('fetch-now')

      const storeContext = yield* Layer.build(TestLaborerStore)
      const { store } = Context.get(storeContext, LaborerStore)

      createWorkspace(store, localPath, 'workspace-fetch-now')

      const service = yield* buildBackgroundFetchService(storeContext)
      const result = yield* service.fetchNow('workspace-fetch-now')

      assert.isTrue(result)
    })
  )

  it.scoped('fetchNow returns false for a missing workspace', () =>
    Effect.gen(function* () {
      const storeContext = yield* Layer.build(TestLaborerStore)
      const service = yield* buildBackgroundFetchService(storeContext)
      const result = yield* service.fetchNow('missing-workspace')

      assert.isFalse(result)
    })
  )

  it.scoped(
    'fetchNow updates tracking refs so new remote commits are visible',
    () =>
      Effect.gen(function* () {
        const { localPath, remotePath } = initRemoteRepo('fetch-updates')
        const remoteClonePath = createRemoteClone(
          remotePath,
          'fetch-updates-pusher'
        )

        // Push a new commit to the remote from another clone
        commitFile(remoteClonePath, 'remote.txt', 'remote change\n')
        git('push origin main', remoteClonePath)

        // Before fetch: local tracking ref is stale, git status won't see behind
        const beforeStatus = git('status --porcelain=v2 --branch', localPath)
        const beforeBehind = beforeStatus.match(BRANCH_AB_RE)
        assert.isNotNull(beforeBehind)
        assert.strictEqual(beforeBehind?.[2], '0')

        const storeContext = yield* Layer.build(TestLaborerStore)
        const { store } = Context.get(storeContext, LaborerStore)

        createWorkspace(store, localPath, 'workspace-fetch-updates')

        const service = yield* buildBackgroundFetchService(storeContext)
        const fetched = yield* service.fetchNow('workspace-fetch-updates')
        assert.isTrue(fetched)

        // After fetch: tracking ref updated, git status shows behind count
        const afterStatus = git('status --porcelain=v2 --branch', localPath)
        const afterBehind = afterStatus.match(BRANCH_AB_RE)
        assert.isNotNull(afterBehind)
        assert.strictEqual(afterBehind?.[2], '1')
      })
  )

  it.scoped(
    'startFetching and stopFetching manage lifecycle without errors',
    () =>
      Effect.gen(function* () {
        const { localPath } = initRemoteRepo('fetch-lifecycle')

        const storeContext = yield* Layer.build(TestLaborerStore)
        const { store } = Context.get(storeContext, LaborerStore)

        createWorkspace(store, localPath, 'workspace-lifecycle', 'running')

        const service = yield* buildBackgroundFetchService(storeContext)

        // Start and stop should not throw
        yield* service.startFetching('workspace-lifecycle')
        yield* service.stopFetching('workspace-lifecycle')
      })
  )

  it.scoped('stopAllFetching cleans up all schedules without errors', () =>
    Effect.gen(function* () {
      const { localPath: localPath1 } = initRemoteRepo('fetch-stop-all-1')
      const { localPath: localPath2 } = initRemoteRepo('fetch-stop-all-2')

      const storeContext = yield* Layer.build(TestLaborerStore)
      const { store } = Context.get(storeContext, LaborerStore)

      createWorkspace(store, localPath1, 'workspace-stop-all-1', 'running')
      createWorkspace(store, localPath2, 'workspace-stop-all-2', 'running')

      const service = yield* buildBackgroundFetchService(storeContext)

      yield* service.startFetching('workspace-stop-all-1')
      yield* service.startFetching('workspace-stop-all-2')
      yield* service.stopAllFetching()
    })
  )
})
