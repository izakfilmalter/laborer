import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { afterAll } from 'vitest'
import { BackgroundFetchService } from '../src/services/background-fetch-service.js'
import { LaborerDatabase } from '../src/services/laborer-database.js'
import type { NativeLaborerDatabase } from '../src/services/native-laborer-database.js'
import { createTempDir, git, initRepo } from './helpers/git-helpers.js'

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
  // Name the bare repository's branch so its HEAD matches the branch seeded
  // below. A host defaulting to `master` would leave HEAD on an unborn branch,
  // and clones of it would check nothing out and have no local `main` to push.
  git('init --bare -b main', remotePath)

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
  database: NativeLaborerDatabase,
  worktreePath: string,
  workspaceId: string
) => {
  database.insertProject({
    canonicalGitCommonDir: join(worktreePath, '.git'),
    id: workspaceId,
    name: workspaceId,
    repoId: workspaceId,
    rootPath: worktreePath,
  })
  database.insertTask({
    branchName: 'main',
    id: workspaceId,
    rootPath: worktreePath,
    source: 'worktree',
    status: 'in_progress',
    title: workspaceId,
    worktreePath,
    worktreeStatus: 'ready',
  })
}

const TestLayer = BackgroundFetchService.layer.pipe(
  Layer.provideMerge(LaborerDatabase.testLayer().pipe(Layer.orDie))
)

describe('BackgroundFetchService', () => {
  it.effect('fetchNow succeeds for a workspace with a remote', () =>
    Effect.gen(function* () {
      const { localPath } = initRemoteRepo('fetch-now')

      const { database } = yield* LaborerDatabase
      createWorkspace(database, localPath, 'workspace-fetch-now')

      const service = yield* BackgroundFetchService
      const result = yield* service.fetchNow('workspace-fetch-now')

      assert.isTrue(result)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect('fetchNow returns false for a missing workspace', () =>
    Effect.gen(function* () {
      const service = yield* BackgroundFetchService
      const result = yield* service.fetchNow('missing-workspace')

      assert.isFalse(result)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect(
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

        const { database } = yield* LaborerDatabase
        createWorkspace(database, localPath, 'workspace-fetch-updates')

        const service = yield* BackgroundFetchService
        const fetched = yield* service.fetchNow('workspace-fetch-updates')
        assert.isTrue(fetched)

        // After fetch: tracking ref updated, git status shows behind count
        const afterStatus = git('status --porcelain=v2 --branch', localPath)
        const afterBehind = afterStatus.match(BRANCH_AB_RE)
        assert.isNotNull(afterBehind)
        assert.strictEqual(afterBehind?.[2], '1')
      }).pipe(Effect.provide(TestLayer))
  )

  it.effect(
    'startFetching and stopFetching manage lifecycle without errors',
    () =>
      Effect.gen(function* () {
        const { localPath } = initRemoteRepo('fetch-lifecycle')

        const { database } = yield* LaborerDatabase
        createWorkspace(database, localPath, 'workspace-lifecycle')

        const service = yield* BackgroundFetchService

        // Start and stop should not throw
        yield* service.startFetching('workspace-lifecycle')
        yield* service.stopFetching('workspace-lifecycle')
      }).pipe(Effect.provide(TestLayer))
  )

  it.effect('stopAllFetching cleans up all schedules without errors', () =>
    Effect.gen(function* () {
      const { localPath: localPath1 } = initRemoteRepo('fetch-stop-all-1')
      const { localPath: localPath2 } = initRemoteRepo('fetch-stop-all-2')

      const { database } = yield* LaborerDatabase
      createWorkspace(database, localPath1, 'workspace-stop-all-1')
      createWorkspace(database, localPath2, 'workspace-stop-all-2')

      const service = yield* BackgroundFetchService

      yield* service.startFetching('workspace-stop-all-1')
      yield* service.startFetching('workspace-stop-all-2')
      yield* service.stopAllFetching()
    }).pipe(Effect.provide(TestLayer))
  )
})
