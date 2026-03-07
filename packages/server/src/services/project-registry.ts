/**
 * ProjectRegistry — Effect Service
 *
 * Manages the set of projects (repos) the user is working with.
 * Validates paths are git repositories and stores/retrieves projects
 * via LiveStore.
 *
 * Uses RepositoryIdentity to resolve canonical repository metadata,
 * ensuring that repo root, nested path, symlinked path, and linked
 * worktree inputs all map to the same logical project.
 *
 * Usage:
 * ```ts
 * const program = Effect.gen(function* () {
 *   const registry = yield* ProjectRegistry
 *   const project = yield* registry.addProject("/path/to/repo")
 * })
 * ```
 *
 * Issue #21: addProject method
 * Issue #22: removeProject method
 * Issue #23: listProjects + getProject methods
 *
 * @see PRD-opencode-inspired-repo-watching.md — Issue 6: addProject performs
 *   canonical discovery, initial worktree reconciliation, initial branch
 *   refresh, and watcher startup before returning the project as ready.
 */

import { basename } from 'node:path'
import { RpcError } from '@laborer/shared/rpc'
import { events, tables } from '@laborer/shared/schema'
import { Context, Effect, Layer } from 'effect'
import { BranchStateTracker } from './branch-state-tracker.js'
import { LaborerStore } from './laborer-store.js'
import { RepositoryIdentity } from './repository-identity.js'
import { RepositoryWatchCoordinator } from './repository-watch-coordinator.js'
import { WorktreeReconciler } from './worktree-reconciler.js'

/**
 * Shape of a project record returned by the registry.
 * Matches the LiveStore projects table columns.
 */
interface ProjectRecord {
  readonly canonicalGitCommonDir: string | null
  readonly id: string
  readonly name: string
  readonly repoId: string | null
  readonly repoPath: string
  readonly rlphConfig: string | null
}

class ProjectRegistry extends Context.Tag('@laborer/ProjectRegistry')<
  ProjectRegistry,
  {
    readonly addProject: (
      repoPath: string
    ) => Effect.Effect<ProjectRecord, RpcError>
    readonly removeProject: (projectId: string) => Effect.Effect<void, RpcError>
    readonly listProjects: () => Effect.Effect<readonly ProjectRecord[], never>
    readonly getProject: (
      projectId: string
    ) => Effect.Effect<ProjectRecord, RpcError>
  }
>() {
  static readonly layer = Layer.effect(
    ProjectRegistry,
    Effect.gen(function* () {
      const { store } = yield* LaborerStore
      const repoIdentity = yield* RepositoryIdentity
      const worktreeReconciler = yield* WorktreeReconciler
      const branchTracker = yield* BranchStateTracker
      const watchCoordinator = yield* RepositoryWatchCoordinator

      const withBestEffortBackfill = (project: ProjectRecord) =>
        backfillProjectIdentity(project).pipe(
          Effect.catchAll(() => Effect.succeed(project))
        )

      const backfillProjectIdentity = Effect.fn(
        'ProjectRegistry.backfillProjectIdentity'
      )(function* (project: ProjectRecord) {
        if (project.repoId !== null && project.canonicalGitCommonDir !== null) {
          return project
        }

        const identity = yield* repoIdentity.resolve(project.repoPath)
        const backfilledProject = {
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

        return backfilledProject
      })

      const addProject = Effect.fn('ProjectRegistry.addProject')(function* (
        repoPath: string
      ) {
        // 1. Resolve canonical repository identity
        // This validates the path exists, is a directory, and is inside
        // a git repository. It also resolves symlinks and finds the
        // true checkout root.
        const identity = yield* repoIdentity.resolve(repoPath).pipe(
          Effect.mapError((error) => {
            // Distinguish between path-level issues and git-level
            // issues so downstream consumers get appropriate codes.
            const isPathError =
              error.message.includes('does not exist') ||
              error.message.includes('not a directory')
            return new RpcError({
              message: isPathError
                ? error.message
                : `Path is not a git repository: ${repoPath}`,
              code: isPathError ? 'INVALID_PATH' : 'NOT_GIT_REPO',
            })
          })
        )

        const canonicalRoot = identity.canonicalRoot

        // 2. Check if the logical repository is already registered.
        // Comparing only checkout roots misses the case where the user
        // adds a linked worktree path for a repository that already has
        // its main checkout registered, so dedupe on repo identity.
        const existingProject = yield* Effect.forEach(
          store.query(tables.projects),
          (project) =>
            Effect.gen(function* () {
              if (project.repoId === identity.repoId) {
                return project
              }

              const backfilledProject = yield* backfillProjectIdentity(
                project
              ).pipe(
                Effect.match({
                  onFailure: () => undefined,
                  onSuccess: (resolvedProject) => resolvedProject,
                })
              )

              return backfilledProject?.repoId === identity.repoId
                ? backfilledProject
                : undefined
            })
        ).pipe(
          Effect.map((projects) =>
            projects.find((project) => project !== undefined)
          )
        )

        if (existingProject) {
          return yield* new RpcError({
            message: `${repoPath} resolves to the already registered repository ${existingProject.repoPath} (project ${existingProject.name})`,
            code: 'ALREADY_REGISTERED',
          })
        }

        // 3. Derive project name from the canonical checkout root
        const name = basename(canonicalRoot)

        // 4. Generate a unique ID
        const id = crypto.randomUUID()

        // 5. Commit ProjectCreated event to LiveStore using canonical path
        const project = {
          id,
          repoPath: canonicalRoot,
          repoId: identity.repoId,
          canonicalGitCommonDir: identity.canonicalGitCommonDir,
          name,
          rlphConfig: null,
        }

        store.commit(events.projectCreated(project))

        yield* worktreeReconciler
          .reconcile(id, canonicalRoot)
          .pipe(
            Effect.catchAll((error) =>
              Effect.logWarning(
                `Initial worktree reconciliation failed for project ${canonicalRoot}: ${error.message}`
              )
            )
          )

        // Initial branch refresh ensures workspace records have
        // current branch names before the project is returned as
        // ready. This must run after reconciliation has created
        // workspace records.
        yield* branchTracker
          .refreshBranches(id)
          .pipe(
            Effect.catchAll((error) =>
              Effect.logWarning(
                `Initial branch refresh failed for project ${canonicalRoot}: ${error.message}`
              )
            )
          )

        yield* watchCoordinator.watchProject(
          id,
          canonicalRoot,
          name,
          identity.canonicalGitCommonDir
        )

        return project
      })

      const removeProject = Effect.fn('ProjectRegistry.removeProject')(
        function* (projectId: string) {
          // 1. Validate the project exists
          const existingProjects = store.query(
            tables.projects.where('id', projectId)
          )

          if (existingProjects.length === 0) {
            return yield* new RpcError({
              message: `Project not found: ${projectId}`,
              code: 'NOT_FOUND',
            })
          }

          yield* watchCoordinator.unwatchProject(projectId)

          // 2. Commit ProjectRemoved event to LiveStore
          store.commit(events.projectRemoved({ id: projectId }))
        }
      )

      const listProjects = () =>
        Effect.forEach(store.query(tables.projects), (project) =>
          withBestEffortBackfill(project as ProjectRecord)
        )

      const getProject = Effect.fn('ProjectRegistry.getProject')(function* (
        projectId: string
      ) {
        const results = store.query(tables.projects.where('id', projectId))

        if (results.length === 0) {
          return yield* new RpcError({
            message: `Project not found: ${projectId}`,
            code: 'NOT_FOUND',
          })
        }

        // Safe: length > 0 guaranteed by the check above
        return yield* withBestEffortBackfill(results[0] as ProjectRecord)
      })

      return ProjectRegistry.of({
        addProject,
        removeProject,
        listProjects,
        getProject,
      })
    })
  )
}

export { ProjectRegistry }
