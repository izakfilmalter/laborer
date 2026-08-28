import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assert, describe, it } from '@effect/vitest'
import { rootWorkspaceId } from '@laborer/shared/root-workspace'
import { Context, Effect, Layer, Ref, Result } from 'effect'
import { afterAll } from 'vitest'
import { BackgroundFetchService } from '../src/services/background-fetch-service.js'
import { LaborerDatabase } from '../src/services/laborer-database.js'
import type { NativeLaborerDatabase } from '../src/services/native-laborer-database.js'
import { PrWatcher } from '../src/services/pr-watcher.js'
import {
  resolveDefaultBaseBranch,
  WorkspaceSyncService,
} from '../src/services/workspace-sync-service.js'
import { createTempDir, git, initRepo } from './helpers/git-helpers.js'

const tempRoots: string[] = []

afterAll(() => {
  for (const root of tempRoots) {
    if (existsSync(root)) {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

class TestPrWatcherRecorder extends Context.Service<
  TestPrWatcherRecorder,
  {
    readonly checkPrCalls: Ref.Ref<readonly string[]>
  }
>()('@laborer/test/TestPrWatcherRecorder') {}

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
            approvals: null,
            authorLogin: null,
            baseBranch: null,
            checkStatus: null,
            checks: null,
            isDraft: false,
            mergeStatus: null,
            number: null,
            reviewDecision: null,
            state: null,
            title: null,
            unresolvedThreads: null,
            url: null,
          }
        }),
      isPolling: () => Effect.succeed(false),
      refreshPolling: () => Effect.void,
      startPolling: () => Effect.void,
      stopAllPolling: () => Effect.void,
      stopPolling: () => Effect.void,
    })
  })
)

class TestBackgroundFetchRecorder extends Context.Service<
  TestBackgroundFetchRecorder,
  {
    readonly startFetchingCalls: Ref.Ref<readonly string[]>
  }
>()('@laborer/test/TestBackgroundFetchRecorder') {}

const TestBackgroundFetchRecorderLayer = Layer.effect(
  TestBackgroundFetchRecorder,
  Effect.gen(function* () {
    return TestBackgroundFetchRecorder.of({
      startFetchingCalls: yield* Ref.make<readonly string[]>([]),
    })
  })
)

const TestBackgroundFetchLayer = Layer.effect(
  BackgroundFetchService,
  Effect.gen(function* () {
    const recorder = yield* TestBackgroundFetchRecorder

    return BackgroundFetchService.of({
      startFetching: (workspaceId) =>
        Ref.update(recorder.startFetchingCalls, (calls) => [
          ...calls,
          workspaceId,
        ]),
      stopFetching: () => Effect.void,
      stopAllFetching: () => Effect.void,
      fetchNow: () => Effect.succeed(false),
    })
  })
)

const TestLayer = WorkspaceSyncService.layer.pipe(
  Layer.provide(TestPrWatcherLayer),
  Layer.provide(TestBackgroundFetchLayer),
  Layer.provideMerge(TestPrWatcherRecorderLayer),
  Layer.provideMerge(TestBackgroundFetchRecorderLayer),
  Layer.provideMerge(LaborerDatabase.testLayer().pipe(Layer.orDie))
)

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
  // Name the branch so the bare HEAD matches the branch seeded below; a host
  // defaulting to `master` leaves HEAD unborn and clones check nothing out.
  git('init --bare -b main', remotePath)

  const seedPath = initRepo(`${prefix}-seed`, tempRoots)
  git('branch -M main', seedPath)
  git(`remote add origin "${remotePath}"`, seedPath)
  git('push -u origin main', seedPath)

  const localPath = createRemoteClone(remotePath, `${prefix}-local`)
  git('checkout main', localPath)

  return { localPath, remotePath }
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

describe('WorkspaceSyncService', () => {
  it.effect(
    'returns WORKSPACE_NOT_FOUND when the workspace does not exist',
    () =>
      Effect.gen(function* () {
        const workspaceSyncService = yield* WorkspaceSyncService

        const result = yield* workspaceSyncService
          .checkStatus('missing-workspace')
          .pipe(Effect.result)

        assert.isTrue(Result.isFailure(result))
        if (Result.isSuccess(result)) {
          assert.fail('Expected missing workspace status lookup to fail')
        }

        assert.strictEqual(result.failure.code, 'WORKSPACE_NOT_FOUND')
        assert.strictEqual(
          result.failure.message,
          'Workspace not found: missing-workspace'
        )
      }).pipe(Effect.provide(TestLayer))
  )

  it.effect('returns null counts when no upstream is configured', () =>
    Effect.gen(function* () {
      const repoPath = initRepo('sync-no-upstream', tempRoots)
      const { database } = yield* LaborerDatabase
      createWorkspace(database, repoPath, 'workspace-no-upstream')

      const workspaceSyncService = yield* WorkspaceSyncService
      const result = yield* workspaceSyncService.checkStatus(
        'workspace-no-upstream'
      )

      assert.deepStrictEqual(result, {
        aheadCount: null,
        behindCount: null,
        hasChanges: false,
        hasUpstream: false,
      })
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect('rejects sync checks after a workspace releases its worktree', () =>
    Effect.gen(function* () {
      const { localPath, remotePath } = initRemoteRepo('sync-destroyed')
      const remoteClonePath = createRemoteClone(
        remotePath,
        'sync-destroyed-remote'
      )

      commitFile(remoteClonePath, 'remote.txt', 'remote change\n')
      git('push origin main', remoteClonePath)
      git('fetch origin', localPath)

      const { database } = yield* LaborerDatabase
      createWorkspace(database, localPath, 'workspace-destroyed')

      const workspaceSyncService = yield* WorkspaceSyncService

      const before = yield* workspaceSyncService.checkStatus(
        'workspace-destroyed'
      )
      assert.strictEqual(before.behindCount, 1)

      const task = database.findTask('workspace-destroyed')
      assert.isNotNull(task)
      if (task === null) {
        assert.fail('Expected workspace task')
      }
      database.updateTask(task.id, task.revision, {
        worktreePath: null,
        worktreeStatus: null,
      })

      const result = yield* workspaceSyncService
        .checkStatus('workspace-destroyed')
        .pipe(Effect.result)
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.strictEqual(result.failure.code, 'WORKSPACE_NOT_FOUND')
      }
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect('tracks ahead and behind commit counts for upstream branches', () =>
    Effect.gen(function* () {
      const { localPath, remotePath } = initRemoteRepo('sync-ahead-behind')
      const remoteClonePath = createRemoteClone(remotePath, 'sync-remote-work')

      commitFile(localPath, 'local.txt', 'local change\n')
      commitFile(remoteClonePath, 'remote.txt', 'remote change\n')
      git('push origin main', remoteClonePath)
      git('fetch origin', localPath)

      const { database } = yield* LaborerDatabase
      createWorkspace(database, localPath, 'workspace-ahead-behind')

      const workspaceSyncService = yield* WorkspaceSyncService
      const result = yield* workspaceSyncService.checkStatus(
        'workspace-ahead-behind'
      )

      assert.deepStrictEqual(result, {
        aheadCount: 1,
        behindCount: 1,
        hasChanges: false,
        hasUpstream: true,
      })
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect(
    'tracks the repo root, which has no task row of its own to poll',
    () =>
      Effect.gen(function* () {
        const { localPath, remotePath } = initRemoteRepo('sync-root')
        const remoteClonePath = createRemoteClone(
          remotePath,
          'sync-root-remote-work'
        )

        commitFile(localPath, 'local.txt', 'local change\n')
        commitFile(remoteClonePath, 'remote.txt', 'remote change\n')
        git('push origin main', remoteClonePath)
        git('fetch origin', localPath)

        const { database } = yield* LaborerDatabase
        createWorkspace(database, localPath, 'project-with-root')
        const workspaceId = rootWorkspaceId('project-with-root')

        const backgroundFetchRecorder = yield* TestBackgroundFetchRecorder
        const workspaceSyncService = yield* WorkspaceSyncService
        const result = yield* workspaceSyncService.checkStatus(workspaceId)

        assert.deepStrictEqual(result, {
          aheadCount: 1,
          behindCount: 1,
          hasChanges: false,
          hasUpstream: true,
        })

        // The root's tracking refs go stale unless reading its status
        // enrolls the repo in background fetching, and repeated reads must
        // not re-enrol it.
        yield* workspaceSyncService.checkStatus(workspaceId)
        const startFetchingCalls = yield* Ref.get(
          backgroundFetchRecorder.startFetchingCalls
        )
        assert.deepStrictEqual(
          startFetchingCalls.filter((id) => id === workspaceId),
          [workspaceId]
        )
      }).pipe(Effect.provide(TestLayer))
  )

  it.effect('pushes local commits and refreshes PR state after push', () =>
    Effect.gen(function* () {
      const { localPath, remotePath } = initRemoteRepo('sync-push')

      commitFile(localPath, 'push.txt', 'push me\n')

      const { database } = yield* LaborerDatabase
      createWorkspace(database, localPath, 'workspace-push')

      const prWatcherRecorder = yield* TestPrWatcherRecorder
      const workspaceSyncService = yield* WorkspaceSyncService

      const before = yield* workspaceSyncService.checkStatus('workspace-push')
      assert.strictEqual(before.aheadCount, 1)
      assert.strictEqual(before.behindCount, 0)

      const result = yield* workspaceSyncService.push('workspace-push')

      assert.deepStrictEqual(result, {
        aheadCount: 0,
        behindCount: 0,
        hasChanges: false,
        hasUpstream: true,
      })
      assert.strictEqual(git('rev-list --count main', remotePath), '2')

      const checkPrCalls = yield* Ref.get(prWatcherRecorder.checkPrCalls)
      assert.deepStrictEqual(checkPrCalls, ['workspace-push'])
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect('pulls remote commits and clears behind count after pull', () =>
    Effect.gen(function* () {
      const { localPath, remotePath } = initRemoteRepo('sync-pull')
      const remoteClonePath = createRemoteClone(
        remotePath,
        'sync-pull-remote-work'
      )

      commitFile(remoteClonePath, 'pulled.txt', 'from remote\n')
      git('push origin main', remoteClonePath)
      git('fetch origin', localPath)

      const { database } = yield* LaborerDatabase
      createWorkspace(database, localPath, 'workspace-pull')

      const workspaceSyncService = yield* WorkspaceSyncService

      const before = yield* workspaceSyncService.checkStatus('workspace-pull')
      assert.strictEqual(before.aheadCount, 0)
      assert.strictEqual(before.behindCount, 1)

      const result = yield* workspaceSyncService.pull('workspace-pull')

      assert.deepStrictEqual(result, {
        aheadCount: 0,
        behindCount: 0,
        hasChanges: false,
        hasUpstream: true,
      })
      assert.strictEqual(git('show HEAD:pulled.txt', localPath), 'from remote')
    }).pipe(Effect.provide(TestLayer))
  )
  it.effect('reports uncommitted work, then commits all of it at once', () =>
    Effect.gen(function* () {
      const { localPath } = initRemoteRepo('sync-commit')
      writeFileSync(join(localPath, 'tracked.txt'), 'edited\n')
      writeFileSync(join(localPath, 'untracked.txt'), 'new\n')

      const { database } = yield* LaborerDatabase
      createWorkspace(database, localPath, 'workspace-commit')

      const workspaceSyncService = yield* WorkspaceSyncService

      const before = yield* workspaceSyncService.checkStatus('workspace-commit')
      assert.isTrue(before.hasChanges)

      const after = yield* workspaceSyncService.commit(
        'workspace-commit',
        'Commit everything'
      )

      // Untracked files count too: the diff the operator approved included
      // them, so a commit that left them behind would mean something else.
      assert.isFalse(after.hasChanges)
      assert.strictEqual(after.aheadCount, 1)
      assert.strictEqual(
        git('show --name-only --format=%s HEAD', localPath).split('\n')[0],
        'Commit everything'
      )
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect('publishes a branch that has never been pushed', () =>
    Effect.gen(function* () {
      const { localPath, remotePath } = initRemoteRepo('sync-publish')
      git('checkout -b feature/publish-me', localPath)
      commitFile(localPath, 'feature.txt', 'feature work\n')

      const { database } = yield* LaborerDatabase
      createWorkspace(database, localPath, 'workspace-publish')

      const workspaceSyncService = yield* WorkspaceSyncService

      const before =
        yield* workspaceSyncService.checkStatus('workspace-publish')
      assert.isFalse(before.hasUpstream)

      const result = yield* workspaceSyncService.push('workspace-publish')

      assert.isTrue(result.hasUpstream)
      assert.strictEqual(result.aheadCount, 0)
      assert.strictEqual(
        git('rev-list --count feature/publish-me', remotePath),
        '2'
      )
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect(
    'targets the branch the remote calls default, not the one named main',
    () =>
      Effect.gen(function* () {
        // Regression: the base branch was hardcoded to "main", so opening a
        // pull request on a repository whose default is "master" failed with
        // "Base ref must be a branch" — after the work had already been
        // pushed, which is the worst moment to find out.
        const remotePath = createTempDir('sync-default-remote', tempRoots)
        git('init --bare -b master', remotePath)

        const seedPath = initRepo('sync-default-seed', tempRoots)
        git('branch -M master', seedPath)
        git(`remote add origin "${remotePath}"`, seedPath)
        git('push -u origin master', seedPath)

        const localPath = createRemoteClone(remotePath, 'sync-default-local')

        assert.strictEqual(
          yield* Effect.promise(() => resolveDefaultBaseBranch(localPath)),
          'master'
        )
      })
  )

  it.effect('falls back to main when the remote will not say', () =>
    Effect.gen(function* () {
      // A repository with no origin at all still has to answer something,
      // and "main" is the better guess than an empty base ref.
      const localPath = initRepo('sync-no-origin', tempRoots)

      assert.strictEqual(
        yield* Effect.promise(() => resolveDefaultBaseBranch(localPath)),
        'main'
      )
    })
  )
})
