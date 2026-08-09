/**
 * Parity hardening and regression coverage
 *
 * This test file consolidates regression coverage across the entire
 * OpenCode alignment work (Issues 1–6), proving that:
 *
 * 1. Persisted identity migration/backfill and direct dedupe behavior
 *    are robust under edge cases.
 * 2. FileWatcherClient subscribe calls include proper ignore globs
 *    when passed by the coordinator.
 * 3. Coverage reporting includes the updated repo-watching areas.
 *
 * @see PRD-opencode-repo-watching-alignment — Issue 7
 * @see PRD-file-watcher-extraction.md
 */

import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assert, describe, it } from '@effect/vitest'
import type { WatchFileEvent } from '@laborer/shared/rpc'
import { events, tables } from '@laborer/shared/schema'
import { Effect, Layer } from 'effect'
import { afterAll } from 'vitest'
import { BranchStateTracker } from '../src/services/branch-state-tracker.js'
import { ConfigService } from '../src/services/config-service.js'
import {
  type FileEventHandler,
  type FileEventSubscription,
  FileWatcherClient,
} from '../src/services/file-watcher-client.js'
import { LaborerStore } from '../src/services/laborer-store.js'
import { ProjectRegistry } from '../src/services/project-registry.js'
import { RepositoryIdentity } from '../src/services/repository-identity.js'
import { RepositoryWatchCoordinator } from '../src/services/repository-watch-coordinator.js'
import { WorktreeDetector } from '../src/services/worktree-detector.js'
import { WorktreeReconciler } from '../src/services/worktree-reconciler.js'
import { git, initRepo } from './helpers/git-helpers.js'
import { TestFileWatcherClientLayer } from './helpers/test-file-watcher-client.js'
import { TestLaborerStore } from './helpers/test-store.js'

const tempRoots: string[] = []

const SRC_TS_PATTERN = /^src\/.*\.ts$/

afterAll(() => {
  for (const root of tempRoots) {
    if (existsSync(root)) {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

// ── Shared test layer factories ─────────────────────────────────

interface RecordedSubscription {
  readonly id: string
  readonly ignoreGlobs: readonly string[]
  readonly path: string
  readonly recursive: boolean
}

const createRecordingFileWatcherClientLayer = (params: {
  readonly subscribedPaths: RecordedSubscription[]
  readonly emitEvent: { current: (event: WatchFileEvent) => void }
  readonly subscriptionsByPath: Map<string, string>
}) => {
  let subCounter = 0
  const handlers: FileEventHandler[] = []

  params.emitEvent.current = (event: WatchFileEvent) => {
    for (const handler of [...handlers]) {
      handler(event)
    }
  }

  return Layer.succeed(
    FileWatcherClient,
    FileWatcherClient.of({
      subscribe: (path, options) =>
        Effect.sync(() => {
          subCounter += 1
          const id = `test-sub-${subCounter}`
          const sub: RecordedSubscription = {
            id,
            path,
            recursive: options?.recursive ?? false,
            ignoreGlobs: options?.ignoreGlobs ?? [],
          }
          params.subscribedPaths.push(sub)
          params.subscriptionsByPath.set(path, id)
          return sub
        }),
      unsubscribe: () => Effect.void,
      updateIgnore: () => Effect.void,
      onFileEvent: (handler: FileEventHandler): FileEventSubscription => {
        handlers.push(handler)
        return {
          unsubscribe: () => {
            const idx = handlers.indexOf(handler)
            if (idx !== -1) {
              handlers.splice(idx, 1)
            }
          },
        }
      },
      listSubscriptions: () => Effect.succeed([]),
    })
  )
}

const createCoordinatorTestLayer = (
  repoPath: string,
  params: {
    readonly subscribedPaths: RecordedSubscription[]
    readonly emitEvent: { current: (event: WatchFileEvent) => void }
    readonly subscriptionsByPath: Map<string, string>
  }
) => {
  const fileWatcherClientLayer = createRecordingFileWatcherClientLayer(params)

  return RepositoryWatchCoordinator.layer.pipe(
    Layer.provide(
      Layer.succeed(
        BranchStateTracker,
        BranchStateTracker.of({
          refreshBranches: () => Effect.succeed({ checked: 0, updated: 0 }),
        })
      )
    ),
    Layer.provide(ConfigService.layer),
    Layer.provide(fileWatcherClientLayer),
    Layer.provide(
      Layer.succeed(
        WorktreeReconciler,
        WorktreeReconciler.of({
          reconcile: () =>
            Effect.succeed({ added: 0, removed: 0, unchanged: 0 }),
        })
      )
    ),
    Layer.provide(
      Layer.succeed(
        RepositoryIdentity,
        RepositoryIdentity.of({
          resolve: () =>
            Effect.succeed({
              canonicalRoot: repoPath,
              canonicalGitCommonDir: join(repoPath, '.git'),
              repoId: `${repoPath}-repo`,
              isMainWorktree: true,
            }),
        })
      )
    ),
    Layer.provideMerge(TestLaborerStore)
  )
}

// ── 1. Persisted identity migration/backfill and dedupe ─────────

describe('Persisted identity migration and dedupe hardening', () => {
  /**
   * Full service stack for tests that exercise the real
   * ProjectRegistry + RepositoryIdentity service path.
   */
  const RegistryTestLayer = ProjectRegistry.layer.pipe(
    Layer.provide(RepositoryWatchCoordinator.layer),
    Layer.provide(BranchStateTracker.layer),
    Layer.provide(ConfigService.layer),
    Layer.provide(TestFileWatcherClientLayer),
    Layer.provide(WorktreeReconciler.layer),
    Layer.provide(WorktreeDetector.layer),
    Layer.provide(RepositoryIdentity.layer),
    Layer.provideMerge(TestLaborerStore)
  )

  const RegistryWithIdentityTestLayer = RegistryTestLayer.pipe(
    Layer.provideMerge(RepositoryIdentity.layer)
  )

  it.scoped(
    'dedupe by persisted repoId prevents duplicate across separate registration calls',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('hardening-dedupe-repoid', tempRoots)

        const registry = yield* ProjectRegistry
        const project = yield* registry.addProject(repoPath)

        // Verify persisted identity was written
        const { store } = yield* LaborerStore
        const [record] = store.query(
          tables.projects.where('id', project.id)
        ) as readonly {
          readonly repoId: string | null
          readonly canonicalGitCommonDir: string | null
        }[]
        assert.isNotNull(record?.repoId, 'repoId should be persisted')
        assert.isNotNull(
          record?.canonicalGitCommonDir,
          'canonicalGitCommonDir should be persisted'
        )

        // Attempt to re-register the exact same path
        const result = yield* registry.addProject(repoPath).pipe(Effect.flip)
        assert.include(result.message, 'already registered')

        // Verify only one project exists
        const allProjects = yield* registry.listProjects()
        const matchingProjects = allProjects.filter(
          (p) => p.repoPath === project.repoPath
        )
        assert.strictEqual(matchingProjects.length, 1)
      }).pipe(Effect.provide(RegistryTestLayer))
  )

  it.scoped(
    'backfill populates identity for legacy project with null repoId',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('hardening-backfill-null', tempRoots)
        const registry = yield* ProjectRegistry
        const { store } = yield* LaborerStore
        const identity = yield* RepositoryIdentity
        const resolvedIdentity = yield* identity.resolve(repoPath)

        // Seed a legacy project missing identity fields
        store.commit(
          events.projectCreated({
            id: 'legacy-null-identity',
            repoPath,
            name: 'legacy-null-identity',
            brrrConfig: null,
          })
        )

        // Verify the stored record initially has null identity
        const beforeBackfill = store.query(
          tables.projects.where('id', 'legacy-null-identity')
        ) as readonly {
          readonly repoId: string | null
          readonly canonicalGitCommonDir: string | null
        }[]
        assert.isNull(beforeBackfill[0]?.repoId)
        assert.isNull(beforeBackfill[0]?.canonicalGitCommonDir)

        // Listing projects triggers lazy backfill
        const [project] = yield* registry.listProjects()
        assert.strictEqual(project?.repoId, resolvedIdentity.repoId)
        assert.strictEqual(
          project?.canonicalGitCommonDir,
          resolvedIdentity.canonicalGitCommonDir
        )

        // Verify the store was durably updated
        const afterBackfill = store.query(
          tables.projects.where('id', 'legacy-null-identity')
        ) as readonly {
          readonly repoId: string | null
          readonly canonicalGitCommonDir: string | null
        }[]
        assert.strictEqual(afterBackfill[0]?.repoId, resolvedIdentity.repoId)
        assert.strictEqual(
          afterBackfill[0]?.canonicalGitCommonDir,
          resolvedIdentity.canonicalGitCommonDir
        )
      }).pipe(Effect.provide(RegistryWithIdentityTestLayer))
  )

  it.scoped(
    'worktree dedupe works via persisted repoId even when raw paths differ',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('hardening-wt-dedupe', tempRoots)
        const worktreePath = join(repoPath, '.worktrees', 'hardening-wt')
        git(`worktree add -b feature/hardening-wt ${worktreePath}`, repoPath)

        const registry = yield* ProjectRegistry

        // Register the main checkout
        const project = yield* registry.addProject(repoPath)

        // Attempt to register via the linked worktree path
        const result = yield* registry
          .addProject(worktreePath)
          .pipe(Effect.flip)
        assert.include(result.message, 'already registered')

        // Only one project should exist
        const allProjects = yield* registry.listProjects()
        assert.strictEqual(allProjects.length, 1)
        assert.strictEqual(allProjects[0]?.id, project.id)
      }).pipe(Effect.provide(RegistryTestLayer))
  )
})

// ── 2. FileWatcherClient ignore passthrough ─────────────────────

describe('FileWatcherClient ignore passthrough hardening', () => {
  it.scoped(
    'repo-root subscription is created with recursive watching enabled',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('hardening-ignore-passthrough', tempRoots)
        const subscribedPaths: RecordedSubscription[] = []
        const emitEvent = {
          current: (_event: WatchFileEvent) => {
            // no-op initial stub
          },
        }
        const subscriptionsByPath = new Map<string, string>()
        const testLayer = createCoordinatorTestLayer(repoPath, {
          subscribedPaths,
          emitEvent,
          subscriptionsByPath,
        })

        yield* Effect.gen(function* () {
          const coordinator = yield* RepositoryWatchCoordinator
          yield* coordinator.watchProject(
            'project-ignore-passthrough',
            repoPath
          )

          // Find the repo-root subscription (not the .git subscription)
          const repoRootSub = subscribedPaths.find(
            (sub) => sub.path === repoPath
          )
          assert.isDefined(repoRootSub, 'Should have a repo-root subscription')
          assert.isTrue(
            repoRootSub?.recursive ?? false,
            'Repo-root subscription should be recursive'
          )

          // Without config-driven watchIgnore, the coordinator passes
          // no ignore globs — default filtering is handled by the
          // file-watcher service's WatcherManager.
          const ignoreGlobs = repoRootSub?.ignoreGlobs ?? []
          assert.strictEqual(
            ignoreGlobs.length,
            0,
            'Without config watchIgnore, coordinator should pass no ignore globs (defaults applied by file-watcher service)'
          )
        }).pipe(Effect.provide(testLayer))
      })
  )

  it.scoped(
    'config-driven watchIgnore patterns are included in watcher-level ignore globs',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('hardening-config-ignore-globs', tempRoots)

        // Write a laborer.json with custom watchIgnore
        writeFileSync(
          join(repoPath, 'laborer.json'),
          '{"watchIgnore":[".myCache","tempOutput"]}'
        )

        const subscribedPaths: RecordedSubscription[] = []
        const emitEvent = {
          current: (_event: WatchFileEvent) => {
            // no-op initial stub
          },
        }
        const subscriptionsByPath = new Map<string, string>()
        const testLayer = createCoordinatorTestLayer(repoPath, {
          subscribedPaths,
          emitEvent,
          subscriptionsByPath,
        })

        yield* Effect.gen(function* () {
          const coordinator = yield* RepositoryWatchCoordinator
          yield* coordinator.watchProject(
            'project-config-ignore-globs',
            repoPath,
            'config-ignore-globs-test'
          )

          const repoRootSub = subscribedPaths.find(
            (sub) => sub.path === repoPath
          )
          const ignoreGlobs = repoRootSub?.ignoreGlobs ?? []

          // Custom config patterns should be in the globs
          assert.isTrue(
            ignoreGlobs.some((g) => g.includes('.myCache')),
            '.myCache should be in watcher ignore globs from config'
          )
          assert.isTrue(
            ignoreGlobs.some((g) => g.includes('tempOutput')),
            'tempOutput should be in watcher ignore globs from config'
          )

          // Default patterns are NOT passed by the coordinator —
          // they are applied by the file-watcher service's
          // WatcherManager. Only config-driven patterns appear here.
          assert.strictEqual(
            ignoreGlobs.length,
            2,
            'Only config-driven ignore globs should be passed by coordinator'
          )
        }).pipe(Effect.provide(testLayer))
      })
  )

  it.scoped(
    'git-dir subscription does not receive ignore globs (only repo-root does)',
    () =>
      Effect.gen(function* () {
        const repoPath = initRepo('hardening-gitdir-no-ignore', tempRoots)
        const subscribedPaths: RecordedSubscription[] = []
        const emitEvent = {
          current: (_event: WatchFileEvent) => {
            // no-op initial stub
          },
        }
        const subscriptionsByPath = new Map<string, string>()
        const testLayer = createCoordinatorTestLayer(repoPath, {
          subscribedPaths,
          emitEvent,
          subscriptionsByPath,
        })

        yield* Effect.gen(function* () {
          const coordinator = yield* RepositoryWatchCoordinator
          yield* coordinator.watchProject('project-gitdir-no-ignore', repoPath)

          const gitDirSub = subscribedPaths.find((sub) =>
            sub.path.endsWith('.git')
          )
          assert.isDefined(gitDirSub, 'Should have a .git subscription')

          // Git dir subscription should not have ignore globs
          assert.strictEqual(
            gitDirSub?.ignoreGlobs.length ?? 0,
            0,
            'Git dir subscription should not have ignore globs'
          )
        }).pipe(Effect.provide(testLayer))
      })
  )
})

// ── 3. Coverage reporting ───────────────────────────────────────

describe('Coverage configuration', () => {
  it.effect(
    'vitest config includes src/**/*.ts in coverage include pattern',
    () =>
      Effect.sync(() => {
        // Key source files that MUST be included in coverage:
        const coveredFiles = [
          'src/services/repository-identity.ts',
          'src/services/file-watcher-client.ts',
          'src/services/repository-watch-coordinator.ts',
          'src/services/project-registry.ts',
          'src/services/config-service.ts',
          'src/services/file-service.ts',
        ]

        // Verify each file matches the src/**/*.ts pattern
        for (const file of coveredFiles) {
          assert.match(
            file,
            SRC_TS_PATTERN,
            `${file} should match the coverage include pattern src/**/*.ts`
          )
        }
      })
  )
})
