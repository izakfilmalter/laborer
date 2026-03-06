/**
 * ProjectRegistry — Effect Service
 *
 * Manages the set of projects (repos) the user is working with.
 * Validates paths are git repositories and stores/retrieves projects
 * via LiveStore.
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
 */

import { execFile } from 'node:child_process'
import { statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { RpcError } from '@laborer/shared/rpc'
import { events, tables } from '@laborer/shared/schema'
import { Context, Effect, Layer } from 'effect'
import { LaborerStore } from './laborer-store.js'
import { WorktreeReconciler } from './worktree-reconciler.js'
import { WorktreeWatcher } from './worktree-watcher.js'

/**
 * ProjectRegistry Effect Context Tag
 *
 * Tagged service that manages project registration, validation,
 * and lifecycle. Depends on LaborerStore for persistence.
 */
/**
 * Shape of a project record returned by the registry.
 * Matches the LiveStore projects table columns.
 */
interface ProjectRecord {
  readonly id: string
  readonly name: string
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
      const worktreeReconciler = yield* WorktreeReconciler
      const worktreeWatcher = yield* WorktreeWatcher

      const addProject = Effect.fn('ProjectRegistry.addProject')(function* (
        repoPath: string
      ) {
        // 1. Resolve to absolute path
        const resolvedPath = resolve(repoPath)

        // 2. Validate path exists and is a directory
        const pathExists = yield* Effect.try({
          try: () => {
            const s = statSync(resolvedPath)
            return s.isDirectory()
          },
          catch: () =>
            new RpcError({
              message: `Path does not exist: ${resolvedPath}`,
              code: 'INVALID_PATH',
            }),
        })

        if (!pathExists) {
          return yield* new RpcError({
            message: `Path is not a directory: ${resolvedPath}`,
            code: 'INVALID_PATH',
          })
        }

        // 3. Validate it's a git repo by running
        // `git rev-parse --is-inside-work-tree`
        const isGitRepo = yield* Effect.tryPromise({
          try: () =>
            new Promise<boolean>((resolve) => {
              execFile(
                'git',
                ['rev-parse', '--is-inside-work-tree'],
                { cwd: resolvedPath },
                (error) => {
                  resolve(error === null)
                }
              )
            }),
          catch: () =>
            new RpcError({
              message: `Failed to check git status for: ${resolvedPath}`,
              code: 'GIT_CHECK_FAILED',
            }),
        })

        if (!isGitRepo) {
          return yield* new RpcError({
            message: `Path is not a git repository: ${resolvedPath}`,
            code: 'NOT_GIT_REPO',
          })
        }

        // 4. Check if project is already registered
        const existingProjects = store.query(
          tables.projects.where('repoPath', resolvedPath)
        )

        if (existingProjects.length > 0) {
          return yield* new RpcError({
            message: `Project already registered: ${resolvedPath}`,
            code: 'ALREADY_REGISTERED',
          })
        }

        // 5. Derive project name from directory name
        const name = basename(resolvedPath)

        // 6. Generate a unique ID
        const id = crypto.randomUUID()

        // 7. Commit ProjectCreated event to LiveStore
        const project = {
          id,
          repoPath: resolvedPath,
          name,
          rlphConfig: null,
        }

        store.commit(events.projectCreated(project))

        yield* worktreeReconciler
          .reconcile(id, resolvedPath)
          .pipe(
            Effect.catchAll((error) =>
              Effect.logWarning(
                `Initial worktree reconciliation failed for project ${resolvedPath}: ${error.message}`
              )
            )
          )

        yield* worktreeWatcher.watchProject(id, resolvedPath)

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

          yield* worktreeWatcher.unwatchProject(projectId)

          // 2. Commit ProjectRemoved event to LiveStore
          store.commit(events.projectRemoved({ id: projectId }))
        }
      )

      const listProjects = () => Effect.sync(() => store.query(tables.projects))

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
        return results[0] as (typeof results)[number]
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
