/**
 * BranchStateTracker — Effect Service
 *
 * Refreshes branch metadata for all workspaces belonging to a project
 * by reading the current branch from git and persisting changed facts
 * when stored branch names are stale.
 *
 * This service is triggered by the RepositoryWatchCoordinator when
 * git metadata changes are detected (HEAD, refs). It treats git as
 * the source of truth and commits `workspaceBranchChanged` events
 * for any workspace whose stored branch name differs from what git
 * reports.
 *
 * @see PRD-opencode-inspired-repo-watching.md — Issue 4
 */

import { existsSync } from 'node:fs'
import { RpcError } from '@laborer/shared/rpc'
import { Context, Effect, Layer } from 'effect'
import { execFile } from '../lib/spawn.js'
import { LaborerDatabase } from './laborer-database.js'
import { withFsmonitorDisabled } from './repo-watching-git.js'
import { listWorkspaceRecords } from './workspace-records.js'

export interface BranchRefreshResult {
  readonly checked: number
  readonly updated: number
}

const runGit = (
  args: readonly string[],
  cwd: string
): Effect.Effect<
  {
    readonly exitCode: number
    readonly stderr: string
    readonly stdout: string
  },
  RpcError
> =>
  Effect.tryPromise({
    try: () =>
      new Promise<{
        readonly exitCode: number
        readonly stderr: string
        readonly stdout: string
      }>((resolve) => {
        execFile(
          'git',
          withFsmonitorDisabled(args),
          { cwd },
          (error, stdout, stderr) => {
            if (error) {
              const code =
                typeof error.code === 'number' ? error.code : Number(error.code)
              resolve({
                exitCode: Number.isFinite(code) ? code : 1,
                stdout: stdout ?? '',
                stderr: stderr ?? '',
              })
              return
            }

            resolve({
              exitCode: 0,
              stdout: stdout ?? '',
              stderr: stderr ?? '',
            })
          }
        )
      }),
    catch: (error) =>
      new RpcError({
        message: `Failed to run git ${args.join(' ')}: ${String(error)}`,
        code: 'BRANCH_REFRESH_FAILED',
      }),
  })

/**
 * Resolve the current branch name for a worktree path.
 * Returns the branch name, or `detached/<short-sha>` for detached HEAD,
 * or null if the path does not exist or git fails.
 */
const getCurrentBranch = (
  worktreePath: string
): Effect.Effect<string | null, RpcError> =>
  Effect.gen(function* () {
    if (!existsSync(worktreePath)) {
      return null
    }

    const branchResult = yield* runGit(
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      worktreePath
    )

    if (branchResult.exitCode !== 0) {
      return null
    }

    const branch = branchResult.stdout.trim()

    // git rev-parse --abbrev-ref HEAD returns "HEAD" when detached
    if (branch === 'HEAD') {
      const shaResult = yield* runGit(['rev-parse', 'HEAD'], worktreePath)
      if (shaResult.exitCode === 0 && shaResult.stdout.trim().length > 0) {
        return `detached/${shaResult.stdout.trim().slice(0, 8)}`
      }
      return null
    }

    return branch
  })

class BranchStateTracker extends Context.Service<
  BranchStateTracker,
  {
    /**
     * Refresh branch state for all workspaces belonging to a project.
     * Reads the current branch from git for each workspace's worktree
     * path and commits `workspaceBranchChanged` events for any stale
     * branch names.
     */
    readonly refreshBranches: (
      projectId: string
    ) => Effect.Effect<BranchRefreshResult, RpcError>
  }
>()('@laborer/BranchStateTracker') {
  static readonly layer = Layer.effect(
    BranchStateTracker,
    Effect.gen(function* () {
      const laborerDatabase = yield* LaborerDatabase

      const refreshBranches = Effect.fn('BranchStateTracker.refreshBranches')(
        function* (projectId: string) {
          const allWorkspaces = yield* laborerDatabase.read(
            'list workspaces for branch refresh',
            (database) =>
              listWorkspaceRecords(database).filter(
                (workspace) => workspace.projectId === projectId
              )
          )

          const activeWorkspaces = allWorkspaces

          let checked = 0
          let updated = 0

          // The main checkout is a synthetic workspace rather than a task, so
          // keep its branch on the project row. This lets every renderer show
          // the real checked-out branch instead of the implementation label
          // "root" while preserving the synthetic workspace model.
          const project = yield* laborerDatabase.read(
            'find project for root branch refresh',
            (database) => database.findProject(projectId)
          )
          if (project !== null) {
            const rootBranch = yield* getCurrentBranch(project.rootPath).pipe(
              Effect.catch(() => Effect.succeed(null))
            )
            if (rootBranch !== null && rootBranch !== project.branchName) {
              yield* laborerDatabase
                .run('update root workspace branch', (database) =>
                  database.updateProject(project.id, project.revision, {
                    branchName: rootBranch,
                  })
                )
                .pipe(
                  Effect.mapError(
                    () =>
                      new RpcError({
                        code: 'BRANCH_REFRESH_FAILED',
                        message: `Failed to persist root branch for project ${projectId}`,
                      })
                  )
                )
            }
          }

          for (const workspace of activeWorkspaces) {
            const currentBranch = yield* getCurrentBranch(
              workspace.worktreePath
            ).pipe(Effect.catch(() => Effect.succeed(null)))

            checked += 1

            if (currentBranch === null) {
              continue
            }

            if (currentBranch !== workspace.branchName) {
              yield* laborerDatabase
                .run('update workspace branch', (database) => {
                  const task = database.findTask(workspace.id)
                  if (task !== null) {
                    database.updateTask(task.id, task.revision, {
                      branchName: currentBranch,
                    })
                  }
                })
                .pipe(
                  Effect.mapError(
                    () =>
                      new RpcError({
                        code: 'BRANCH_REFRESH_FAILED',
                        message: `Failed to persist branch for workspace ${workspace.id}`,
                      })
                  )
                )
              updated += 1
            }
          }

          return { checked, updated } satisfies BranchRefreshResult
        }
      )

      return BranchStateTracker.of({ refreshBranches })
    })
  )
}

export { BranchStateTracker, getCurrentBranch }
