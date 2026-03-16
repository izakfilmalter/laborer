/**
 * RepositoryWatchCoordinator — Scoped Effect Service
 *
 * Owns all watcher lifecycle for registered repositories. For each
 * project, the coordinator subscribes to:
 *   1. The canonical common git directory — for metadata changes that
 *      affect branch state, worktree membership, and HEAD.
 *   2. The canonical checkout root — for repo-wide file change events
 *      that are normalized and published through the file-watcher service.
 *
 * Watch events are treated as invalidation signals only. The
 * coordinator does not mutate project or workspace state directly;
 * instead, it debounces events and delegates to refresh services:
 *   - WorktreeReconciler for worktree membership changes
 *   - BranchStateTracker for branch metadata refresh
 *   - FileWatcherClient for normalized file change fanout
 *
 * Events are classified by concern and debounced independently so
 * that rapid branch switches do not delay worktree reconciliation
 * and vice versa.
 *
 * The coordinator is scoped: project removal tears down that
 * project's watchers, and server shutdown tears down all watchers
 * via the Effect finalizer.
 *
 * @see PRD-opencode-inspired-repo-watching.md — Issues 3, 4 & 5
 * @see PRD-file-watcher-extraction.md
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { WatchFileEvent } from '@laborer/shared/rpc'
import { events, tables } from '@laborer/shared/schema'
import { Context, Data, Effect, Layer, Ref, Runtime } from 'effect'
import { BranchStateTracker } from './branch-state-tracker.js'
import { ConfigService } from './config-service.js'
import { FileWatcherClient } from './file-watcher-client.js'
import { LaborerStore } from './laborer-store.js'
import { RepositoryIdentity } from './repository-identity.js'
import { WorktreeReconciler } from './worktree-reconciler.js'

/**
 * Per-project watcher state. Tracks active subscription IDs so they
 * can be individually torn down on project removal.
 */
interface ProjectWatcherState {
  /** Pending debounce timer for branch state refresh */
  branchTimer: ReturnType<typeof setTimeout> | null
  /** Whether this watcher state has been torn down */
  closed: boolean
  /** Canonical path to the git common directory */
  readonly gitDirPath: string
  /** Remote subscription ID for the git metadata root watcher */
  gitDirRootSubscriptionId: string | null
  /** Project identifier */
  readonly projectId: string
  /** Pending retry timer for watcher recovery */
  recoveryTimer: ReturnType<typeof setTimeout> | null
  /** Canonical repo checkout root */
  readonly repoPath: string
  /** Remote subscription ID for the repo checkout root watcher */
  repoRootSubscriptionId: string | null
  /** Remote subscription ID for the shared worktrees directory watcher */
  worktreesSubscriptionId: string | null
  /** Pending debounce timer for worktree reconciliation */
  worktreeTimer: ReturnType<typeof setTimeout> | null
}

interface ProjectRecord {
  readonly canonicalGitCommonDir: string | null
  readonly id: string
  readonly name: string
  readonly repoId: string | null
  readonly repoPath: string
}

interface WatchTarget {
  readonly canonicalGitCommonDir: string
  readonly projectId: string
  readonly projectName: string
  readonly repoPath: string
}

const DEBOUNCE_MS = 500
const RECOVERY_RETRY_MS = 1000
const RECOVERY_RETRY_LABEL = `${RECOVERY_RETRY_MS}ms`

const formatWatcherWarning = (
  summary: string,
  params: {
    readonly detail?: string
    readonly path?: string
    readonly projectId: string
    readonly retrying?: boolean
  }
): string => {
  const pathSegment = params.path === undefined ? '' : ` at ${params.path}`
  const detailSegment = params.detail === undefined ? '' : `: ${params.detail}`
  const retrySegment = params.retrying
    ? ` Git-backed refresh remains active; retrying watcher setup in ${RECOVERY_RETRY_LABEL}.`
    : ''

  return `${summary} for project ${params.projectId}${pathSegment}${detailSegment}.${retrySegment}`
}

/**
 * Files in the git directory that indicate branch-related changes.
 * HEAD is modified on branch switches, refs/ contains branch pointers,
 * MERGE_HEAD and REBASE_HEAD appear during merge/rebase operations.
 */
const BRANCH_RELATED_FILES = new Set([
  'HEAD',
  'MERGE_HEAD',
  'REBASE_HEAD',
  'ORIG_HEAD',
  'FETCH_HEAD',
])

/**
 * Determine whether a filesystem event from the git directory
 * is branch-related based on the fileName.
 */
const isBranchRelatedEvent = (fileName: string | null): boolean => {
  if (fileName === null) {
    return true
  }
  if (BRANCH_RELATED_FILES.has(fileName)) {
    return true
  }
  if (fileName.startsWith('refs')) {
    return true
  }
  return false
}

/**
 * Determine whether a filesystem event from the git directory
 * is worktree-related based on the fileName.
 */
const isWorktreeRelatedEvent = (fileName: string | null): boolean => {
  if (fileName === null) {
    return true
  }
  if (fileName === 'worktrees' || fileName.startsWith('worktrees')) {
    return true
  }
  return false
}

class RepositoryWatchCoordinatorError extends Data.TaggedError(
  'RepositoryWatchCoordinatorError'
)<{
  readonly message: string
}> {}

class RepositoryWatchCoordinator extends Context.Tag(
  '@laborer/RepositoryWatchCoordinator'
)<
  RepositoryWatchCoordinator,
  {
    /**
     * Start watching a project's repository. Resolves canonical
     * identity, subscribes to git metadata, and sets up debounced
     * refresh. Idempotent — re-calling for the same project
     * replaces the previous watchers.
     *
     * When `canonicalGitCommonDir` is provided, the coordinator
     * skips identity re-resolution and uses the supplied value
     * directly. This avoids redundant git commands when the caller
     * (e.g. `ProjectRegistry.addProject`) has already resolved
     * canonical identity.
     */
    readonly watchProject: (
      projectId: string,
      repoPath: string,
      projectName?: string,
      canonicalGitCommonDir?: string
    ) => Effect.Effect<void, never>

    /**
     * Stop watching a project. Closes all subscriptions and
     * clears pending timers for the given project.
     */
    readonly unwatchProject: (projectId: string) => Effect.Effect<void, never>

    /**
     * Reconcile and start watching all persisted projects.
     * Used during startup bootstrapping.
     */
    readonly watchAll: () => Effect.Effect<void, never>
  }
>() {
  static readonly layer = Layer.scoped(
    RepositoryWatchCoordinator,
    Effect.gen(function* () {
      const { store } = yield* LaborerStore
      const reconciler = yield* WorktreeReconciler
      const branchTracker = yield* BranchStateTracker
      const repoIdentity = yield* RepositoryIdentity
      const fileWatcherClient = yield* FileWatcherClient
      const configService = yield* ConfigService
      const runtime = yield* Effect.runtime<never>()

      const ensurePersistedIdentity = Effect.fn(
        'RepositoryWatchCoordinator.ensurePersistedIdentity'
      )(function* (project: ProjectRecord) {
        if (project.repoId !== null && project.canonicalGitCommonDir !== null) {
          return project
        }

        const identity = yield* repoIdentity.resolve(project.repoPath)
        const updatedProject = {
          ...project,
          repoPath: identity.canonicalRoot,
          repoId: identity.repoId,
          canonicalGitCommonDir: identity.canonicalGitCommonDir,
        } satisfies ProjectRecord

        store.commit(
          events.projectRepositoryIdentityBackfilled({
            id: project.id,
            repoPath: identity.canonicalRoot,
            repoId: identity.repoId,
            canonicalGitCommonDir: identity.canonicalGitCommonDir,
          })
        )

        return updatedProject
      })
      const statesRef = yield* Ref.make(new Map<string, ProjectWatcherState>())

      /**
       * Mapping from remote subscription ID → project ID.
       * Used to route incoming file events to the correct project state.
       */
      const subscriptionToProjectRef = yield* Ref.make(
        new Map<string, string>()
      )

      /**
       * Mapping from remote subscription ID → subscription purpose.
       * Used to classify incoming events from git dir vs repo root watchers.
       */
      const subscriptionPurposeRef = yield* Ref.make(
        new Map<string, 'git-dir' | 'worktrees' | 'repo-root'>()
      )

      const runPromise = Runtime.runPromise(runtime)

      // ── Helpers ──────────────────────────────────────────────

      const clearTimers = (state: ProjectWatcherState): void => {
        if (state.worktreeTimer !== null) {
          clearTimeout(state.worktreeTimer)
          state.worktreeTimer = null
        }
        if (state.branchTimer !== null) {
          clearTimeout(state.branchTimer)
          state.branchTimer = null
        }
        if (state.recoveryTimer !== null) {
          clearTimeout(state.recoveryTimer)
          state.recoveryTimer = null
        }
      }

      const isActive = (state: ProjectWatcherState): boolean => !state.closed

      const logWatcherWarning = (
        summary: string,
        params: {
          readonly detail?: string
          readonly path?: string
          readonly projectId: string
          readonly retrying?: boolean
        }
      ): Effect.Effect<void, never> =>
        Effect.logWarning(formatWatcherWarning(summary, params))

      const cleanupSubscriptionId = (subId: string | null): void => {
        if (subId !== null) {
          runPromise(
            fileWatcherClient
              .unsubscribe(subId)
              .pipe(Effect.catchAll(() => Effect.void))
          ).catch(() => undefined)
        }
      }

      const removeSubscriptionMapping = (subId: string | null): void => {
        if (subId !== null) {
          runPromise(
            Ref.update(subscriptionToProjectRef, (map) => {
              const next = new Map(map)
              next.delete(subId)
              return next
            }).pipe(
              Effect.zipRight(
                Ref.update(subscriptionPurposeRef, (map) => {
                  const next = new Map(map)
                  next.delete(subId)
                  return next
                })
              )
            )
          ).catch(() => undefined)
        }
      }

      const closeState = (state: ProjectWatcherState): void => {
        state.closed = true
        clearTimers(state)
        cleanupSubscriptionId(state.gitDirRootSubscriptionId)
        removeSubscriptionMapping(state.gitDirRootSubscriptionId)
        state.gitDirRootSubscriptionId = null
        cleanupSubscriptionId(state.worktreesSubscriptionId)
        removeSubscriptionMapping(state.worktreesSubscriptionId)
        state.worktreesSubscriptionId = null
        cleanupSubscriptionId(state.repoRootSubscriptionId)
        removeSubscriptionMapping(state.repoRootSubscriptionId)
        state.repoRootSubscriptionId = null
      }

      const reconcileWithWarning = (
        projectId: string,
        repoPath: string,
        reason: string
      ): Effect.Effect<void, never> =>
        reconciler.reconcile(projectId, repoPath).pipe(
          Effect.asVoid,
          Effect.catchAll((error) =>
            Effect.logWarning(
              `Worktree reconciliation failed for project ${projectId} (${reason}): ${error.message}`
            )
          )
        )

      const refreshBranchesWithWarning = (
        projectId: string,
        reason: string
      ): Effect.Effect<void, never> =>
        branchTracker.refreshBranches(projectId).pipe(
          Effect.asVoid,
          Effect.catchAll((error) =>
            Effect.logWarning(
              `Branch refresh failed for project ${projectId} (${reason}): ${error.message}`
            )
          )
        )

      const scheduleReconcile = (
        state: ProjectWatcherState,
        reason: string
      ): void => {
        if (!isActive(state)) {
          return
        }
        if (state.worktreeTimer !== null) {
          clearTimeout(state.worktreeTimer)
        }
        state.worktreeTimer = setTimeout(() => {
          if (!isActive(state)) {
            state.worktreeTimer = null
            return
          }
          state.worktreeTimer = null
          runPromise(
            reconcileWithWarning(state.projectId, state.repoPath, reason)
          ).catch(() => undefined)
        }, DEBOUNCE_MS)
      }

      const scheduleBranchRefresh = (
        state: ProjectWatcherState,
        reason: string
      ): void => {
        if (!isActive(state)) {
          return
        }
        if (state.branchTimer !== null) {
          clearTimeout(state.branchTimer)
        }
        state.branchTimer = setTimeout(() => {
          if (!isActive(state)) {
            state.branchTimer = null
            return
          }
          state.branchTimer = null
          runPromise(refreshBranchesWithWarning(state.projectId, reason)).catch(
            () => undefined
          )
        }, DEBOUNCE_MS)
      }

      const scheduleRecovery = (
        state: ProjectWatcherState,
        reason: string
      ): void => {
        if (!isActive(state)) {
          return
        }
        if (state.recoveryTimer !== null) {
          return
        }

        state.recoveryTimer = setTimeout(() => {
          if (!isActive(state)) {
            state.recoveryTimer = null
            return
          }
          state.recoveryTimer = null
          runPromise(
            logWatcherWarning('Watcher degraded', {
              projectId: state.projectId,
              detail: `${reason}; attempting recovery now`,
            }).pipe(
              Effect.zipRight(
                Ref.get(statesRef).pipe(
                  Effect.flatMap((states) => {
                    const latest = states.get(state.projectId)
                    if (latest === undefined) {
                      return Effect.void
                    }

                    return watchProject(latest.projectId, latest.repoPath)
                  })
                )
              )
            )
          ).catch(() => undefined)
        }, RECOVERY_RETRY_MS)
      }

      // ── Event handler for file-watcher service events ────────

      /**
       * Handle incoming file events from the file-watcher service.
       * Routes events to the appropriate handler based on subscription
       * purpose (git-dir, worktrees, or repo-root).
       */
      const handleFileEvent = (event: WatchFileEvent): void => {
        // Look up project and purpose synchronously from mutable state
        // We can't use Effect.runSync inside callbacks easily, so we
        // maintain a parallel mutable lookup for the hot path.
        const projectId = subscriptionToProjectMap.get(event.subscriptionId)
        const purpose = subscriptionPurposeMap.get(event.subscriptionId)
        if (projectId === undefined || purpose === undefined) {
          return
        }

        // Look up state
        const state = projectWatcherStatesMap.get(projectId)
        if (state === undefined || !isActive(state)) {
          return
        }

        if (purpose === 'git-dir') {
          handleGitDirEvent(state, event)
        } else if (purpose === 'worktrees') {
          handleWorktreesEvent(state)
        }
        // repo-root events are handled by the file-watcher service's
        // normalization and streamed directly to DiffService via
        // FileWatcherClient.onFileEvent — the coordinator doesn't
        // need to handle them here.
      }

      // Mutable shadow maps for synchronous access in callbacks.
      // Kept in sync with the Ref-based maps.
      const subscriptionToProjectMap = new Map<string, string>()
      const subscriptionPurposeMap = new Map<
        string,
        'git-dir' | 'worktrees' | 'repo-root'
      >()
      const projectWatcherStatesMap = new Map<string, ProjectWatcherState>()

      // Register the event handler with the FileWatcherClient
      const eventSubscription = fileWatcherClient.onFileEvent(handleFileEvent)

      // ── Git metadata event handlers ──────────────────────────

      const handleGitDirEvent = (
        state: ProjectWatcherState,
        event: WatchFileEvent
      ): void => {
        if (!isActive(state)) {
          return
        }

        if (event.fileName === 'worktrees') {
          const switched = switchToWorktreesWatcher(state, 'worktrees-created')
          if (!switched) {
            scheduleReconcile(state, 'worktrees-created')
          }
        }

        if (isBranchRelatedEvent(event.fileName)) {
          scheduleBranchRefresh(state, 'git-metadata-change')
        }

        if (isWorktreeRelatedEvent(event.fileName)) {
          scheduleReconcile(state, 'git-metadata-change')
        }
      }

      const handleWorktreesEvent = (state: ProjectWatcherState): void => {
        if (!isActive(state)) {
          return
        }
        scheduleReconcile(state, 'worktree-metadata-change')
        scheduleBranchRefresh(state, 'worktree-metadata-change')
      }

      /**
       * Attempt to add the dedicated worktrees watcher when the
       * shared worktrees directory appears inside the git dir.
       */
      const switchToWorktreesWatcher = (
        state: ProjectWatcherState,
        reason: string
      ): boolean => {
        if (!isActive(state)) {
          return false
        }
        const worktreesDir = join(state.gitDirPath, 'worktrees')
        if (
          state.worktreesSubscriptionId !== null ||
          !existsSync(worktreesDir)
        ) {
          return false
        }

        runPromise(
          Ref.get(statesRef).pipe(
            Effect.flatMap((states) => {
              const latest = states.get(state.projectId)
              if (
                latest === undefined ||
                latest.worktreesSubscriptionId !== null
              ) {
                return Effect.void
              }
              return watchProject(latest.projectId, latest.repoPath).pipe(
                Effect.zipRight(
                  Ref.get(statesRef).pipe(
                    Effect.flatMap((nextStates) => {
                      const refreshed = nextStates.get(state.projectId)
                      if (refreshed === undefined) {
                        return Effect.void
                      }

                      return reconcileWithWarning(
                        refreshed.projectId,
                        refreshed.repoPath,
                        reason
                      )
                    })
                  )
                )
              )
            })
          )
        ).catch(() => undefined)

        return true
      }

      // ── Subscribe helpers (via FileWatcherClient) ────────────

      const registerSubscription = (
        subId: string,
        projectId: string,
        purpose: 'git-dir' | 'worktrees' | 'repo-root'
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          yield* Ref.update(subscriptionToProjectRef, (map) => {
            const next = new Map(map)
            next.set(subId, projectId)
            return next
          })
          yield* Ref.update(subscriptionPurposeRef, (map) => {
            const next = new Map(map)
            next.set(subId, purpose)
            return next
          })
          // Keep mutable shadow maps in sync
          subscriptionToProjectMap.set(subId, projectId)
          subscriptionPurposeMap.set(subId, purpose)
        })

      const subscribeGitDirRoot = (
        projectId: string,
        gitDirPath: string
      ): Effect.Effect<string | null, never> =>
        fileWatcherClient.subscribe(gitDirPath, { recursive: true }).pipe(
          Effect.tap((sub) =>
            registerSubscription(sub.id, projectId, 'git-dir')
          ),
          Effect.map((sub) => sub.id),
          Effect.catchAll((error) =>
            logWatcherWarning('Failed to watch git dir', {
              projectId,
              path: gitDirPath,
              detail: error.message,
              retrying: true,
            }).pipe(Effect.as(null))
          )
        )

      const subscribeWorktreesDir = (
        projectId: string,
        gitDirPath: string
      ): Effect.Effect<string | null, never> => {
        const worktreesDir = join(gitDirPath, 'worktrees')

        return fileWatcherClient
          .subscribe(worktreesDir, { recursive: true })
          .pipe(
            Effect.tap((sub) =>
              registerSubscription(sub.id, projectId, 'worktrees')
            ),
            Effect.map((sub) => sub.id),
            Effect.catchAll((error) =>
              logWatcherWarning('Failed to watch worktrees dir', {
                projectId,
                path: worktreesDir,
                detail: error.message,
                retrying: true,
              }).pipe(Effect.as(null))
            )
          )
      }

      const subscribeRepoRoot = (
        projectId: string,
        repoPath: string,
        ignoreGlobs?: string[]
      ): Effect.Effect<string | null, never> =>
        fileWatcherClient
          .subscribe(
            repoPath,
            ignoreGlobs !== undefined && ignoreGlobs.length > 0
              ? { recursive: true, ignoreGlobs }
              : { recursive: true }
          )
          .pipe(
            Effect.tap((sub) =>
              registerSubscription(sub.id, projectId, 'repo-root')
            ),
            Effect.map((sub) => sub.id),
            Effect.catchAll((error) =>
              logWatcherWarning('Failed to watch repo root', {
                projectId,
                path: repoPath,
                detail: error.message,
                retrying: true,
              }).pipe(Effect.as(null))
            )
          )

      // ── Public methods ───────────────────────────────────────

      const unwatchProject = Effect.fn(
        'RepositoryWatchCoordinator.unwatchProject'
      )(function* (projectId: string) {
        yield* Ref.update(statesRef, (states) => {
          const next = new Map(states)
          const existing = next.get(projectId)
          if (existing !== undefined) {
            closeState(existing)
            projectWatcherStatesMap.delete(projectId)
            next.delete(projectId)
          }
          return next
        })
      })

      const startWatching = Effect.fn(
        'RepositoryWatchCoordinator.startWatching'
      )(function* ({
        canonicalGitCommonDir,
        projectId,
        projectName,
        repoPath,
      }: WatchTarget) {
        // Resolve project config for ignore patterns
        const resolvedConfig = yield* configService
          .resolveConfig(repoPath, projectName)
          .pipe(
            Effect.catchAll((error) =>
              Effect.logWarning(
                `Failed to resolve config for project ${projectId}: ${String(error)}`
              ).pipe(Effect.as(null))
            )
          )

        // Compute ignore globs from config
        const additionalIgnores = resolvedConfig?.watchIgnore.value ?? []
        const ignoreGlobs =
          additionalIgnores.length > 0
            ? additionalIgnores.map((prefix) => `${prefix}/**`)
            : []

        const gitDirPath = canonicalGitCommonDir
        const hasWorktreesDir = existsSync(join(gitDirPath, 'worktrees'))

        const state: ProjectWatcherState = {
          closed: false,
          projectId,
          repoPath,
          gitDirPath,
          gitDirRootSubscriptionId: null,
          worktreesSubscriptionId: null,
          repoRootSubscriptionId: null,
          worktreeTimer: null,
          branchTimer: null,
          recoveryTimer: null,
        }

        state.gitDirRootSubscriptionId = yield* subscribeGitDirRoot(
          projectId,
          gitDirPath
        )

        if (hasWorktreesDir) {
          state.worktreesSubscriptionId = yield* subscribeWorktreesDir(
            projectId,
            gitDirPath
          )
        }

        state.repoRootSubscriptionId = yield* subscribeRepoRoot(
          projectId,
          repoPath,
          ignoreGlobs
        )

        // Update Ref-based and mutable shadow maps
        yield* Ref.update(statesRef, (states) => {
          const next = new Map(states)
          next.set(projectId, state)
          return next
        })
        projectWatcherStatesMap.set(projectId, state)

        if (
          state.gitDirRootSubscriptionId === null ||
          state.repoRootSubscriptionId === null ||
          (hasWorktreesDir && state.worktreesSubscriptionId === null)
        ) {
          scheduleRecovery(state, 'watch-target-unavailable')
        }
      })

      const watchProject = Effect.fn('RepositoryWatchCoordinator.watchProject')(
        function* (
          projectId: string,
          repoPath: string,
          projectName?: string,
          preResolvedGitCommonDir?: string
        ) {
          // Tear down existing watchers for this project
          yield* unwatchProject(projectId)

          // Use pre-resolved identity when the caller already has it,
          // otherwise resolve from git.
          if (preResolvedGitCommonDir !== undefined) {
            yield* startWatching({
              projectId,
              projectName: projectName ?? projectId,
              repoPath,
              canonicalGitCommonDir: preResolvedGitCommonDir,
            })
            return
          }

          // Resolve canonical git common dir
          const identity = yield* repoIdentity
            .resolve(repoPath)
            .pipe(
              Effect.catchAll((error) =>
                Effect.logWarning(
                  `Failed to resolve repo identity for project ${projectId}: ${error.message}`
                ).pipe(Effect.as(null))
              )
            )

          if (identity === null) {
            return
          }

          yield* startWatching({
            projectId,
            projectName: projectName ?? projectId,
            repoPath: identity.canonicalRoot,
            canonicalGitCommonDir: identity.canonicalGitCommonDir,
          })
        }
      )

      const watchAll = Effect.fn('RepositoryWatchCoordinator.watchAll')(
        function* () {
          const projects = yield* Effect.forEach(
            store.query(tables.projects),
            (project) =>
              ensurePersistedIdentity(project as ProjectRecord).pipe(
                Effect.catchAll((error) =>
                  Effect.logWarning(
                    `Failed to backfill repo identity for project ${project.id}: ${error.message}`
                  ).pipe(Effect.as(project))
                )
              )
          )
          yield* Effect.forEach(projects, (project) =>
            reconcileWithWarning(project.id, project.repoPath, 'startup')
          )
          yield* Effect.forEach(projects, (project) =>
            refreshBranchesWithWarning(project.id, 'startup')
          )
          yield* Effect.forEach(projects, (project) =>
            project.canonicalGitCommonDir === null
              ? watchProject(project.id, project.repoPath, project.name)
              : startWatching({
                  projectId: project.id,
                  projectName: project.name,
                  repoPath: project.repoPath,
                  canonicalGitCommonDir: project.canonicalGitCommonDir,
                })
          )
        }
      )

      // ── Lifecycle ────────────────────────────────────────────

      yield* Effect.addFinalizer(() =>
        Ref.get(statesRef).pipe(
          Effect.flatMap((states) =>
            Effect.sync(() => {
              for (const state of states.values()) {
                closeState(state)
              }
              eventSubscription.unsubscribe()
            })
          )
        )
      )

      const service = RepositoryWatchCoordinator.of({
        watchProject,
        unwatchProject,
        watchAll,
      })

      // Bootstrap: reconcile and watch all existing projects
      yield* watchAll()

      return service
    })
  )
}

export {
  formatWatcherWarning,
  RepositoryWatchCoordinator,
  RepositoryWatchCoordinatorError,
}
