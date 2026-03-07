/**
 * BranchStateTracker — Effect Service
 *
 * Refreshes branch metadata for all workspaces belonging to a project
 * by reading the current branch from git and committing update events
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

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { RpcError } from '@laborer/shared/rpc'
import { events, tables } from '@laborer/shared/schema'
import { Context, Effect, Layer } from 'effect'
import { LaborerStore } from './laborer-store.js'
import { withFsmonitorDisabled } from './repo-watching-git.js'

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

class BranchStateTracker extends Context.Tag('@laborer/BranchStateTracker')<
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
>() {
  static readonly layer = Layer.effect(
    BranchStateTracker,
    Effect.gen(function* () {
      const { store } = yield* LaborerStore

      const refreshBranches = Effect.fn('BranchStateTracker.refreshBranches')(
        function* (projectId: string) {
          const allWorkspaces = store.query(
            tables.workspaces.where('projectId', projectId)
          ) as readonly {
            readonly branchName: string
            readonly id: string
            readonly status: string
            readonly worktreePath: string
          }[]

          // Only refresh non-destroyed workspaces
          const activeWorkspaces = allWorkspaces.filter(
            (w) => w.status !== 'destroyed'
          )

          let checked = 0
          let updated = 0

          for (const workspace of activeWorkspaces) {
            const currentBranch = yield* getCurrentBranch(
              workspace.worktreePath
            ).pipe(Effect.catchAll(() => Effect.succeed(null)))

            checked += 1

            if (currentBranch === null) {
              continue
            }

            if (currentBranch !== workspace.branchName) {
              store.commit(
                events.workspaceBranchChanged({
                  id: workspace.id,
                  branchName: currentBranch,
                })
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

export { BranchStateTracker }
