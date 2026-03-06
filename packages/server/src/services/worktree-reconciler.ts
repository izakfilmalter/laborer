import { execFile } from 'node:child_process'
import { RpcError } from '@laborer/shared/rpc'
import { events, tables } from '@laborer/shared/schema'
import { Context, Effect, Layer } from 'effect'
import { LaborerStore } from './laborer-store.js'
import { PortAllocator } from './port-allocator.js'
import { WorktreeDetector } from './worktree-detector.js'

interface WorkspaceRecord {
  readonly branchName: string
  readonly id: string
  readonly port: number
  readonly projectId: string
  readonly status: string
  readonly worktreePath: string
}

export interface ReconcileResult {
  readonly added: number
  readonly removed: number
  readonly unchanged: number
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
        execFile('git', [...args], { cwd }, (error, stdout, stderr) => {
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
        })
      }),
    catch: (error) =>
      new RpcError({
        message: `Failed to run git ${args.join(' ')}: ${String(error)}`,
        code: 'WORKTREE_RECONCILE_FAILED',
      }),
  })

const getDefaultBranchRef = (
  repoPath: string
): Effect.Effect<string, RpcError> =>
  Effect.gen(function* () {
    const symbolicRef = yield* runGit(
      ['symbolic-ref', 'refs/remotes/origin/HEAD'],
      repoPath
    )

    if (symbolicRef.exitCode === 0 && symbolicRef.stdout.trim().length > 0) {
      return symbolicRef.stdout.trim()
    }

    for (const branch of ['main', 'master']) {
      const branchCheck = yield* runGit(
        ['rev-parse', '--verify', `refs/heads/${branch}`],
        repoPath
      )
      if (branchCheck.exitCode === 0) {
        return branch
      }
    }

    return 'HEAD'
  })

const deriveBaseSha = (
  repoPath: string,
  defaultBranchRef: string,
  headSha: string
): Effect.Effect<string | null, RpcError> =>
  Effect.gen(function* () {
    const mergeBase = yield* runGit(
      ['merge-base', defaultBranchRef, headSha],
      repoPath
    )

    if (mergeBase.exitCode === 0 && mergeBase.stdout.trim().length > 0) {
      return mergeBase.stdout.trim()
    }

    const fallbackHead = yield* runGit(['rev-parse', headSha], repoPath)
    if (fallbackHead.exitCode === 0 && fallbackHead.stdout.trim().length > 0) {
      return fallbackHead.stdout.trim()
    }

    return null
  })

const toWorkspaceBranchName = (
  branch: string | null,
  headSha: string
): string => {
  if (branch !== null && branch.length > 0) {
    return branch
  }
  return `detached/${headSha.slice(0, 8)}`
}

class WorktreeReconciler extends Context.Tag('@laborer/WorktreeReconciler')<
  WorktreeReconciler,
  {
    reconcile: (
      projectId: string,
      repoPath: string
    ) => Effect.Effect<ReconcileResult, RpcError>
  }
>() {
  static readonly layer = Layer.effect(
    WorktreeReconciler,
    Effect.gen(function* () {
      const { store } = yield* LaborerStore
      const portAllocator = yield* PortAllocator
      const detector = yield* WorktreeDetector

      const reconcile = Effect.fn('WorktreeReconciler.reconcile')(function* (
        projectId: string,
        repoPath: string
      ) {
        const detectedWorktrees = yield* detector.detect(repoPath)
        const defaultBranchRef = yield* getDefaultBranchRef(repoPath)

        const allWorkspaces = store.query(
          tables.workspaces.where('projectId', projectId)
        ) as readonly WorkspaceRecord[]

        // Filter out destroyed workspaces so that a worktree whose Laborer
        // record was destroyed can be re-detected on the next reconciliation
        // pass. Without this filter, destroyed records would block re-detection
        // since their worktreePath would match the detected path.
        // @see Issue #163: Worktree detection polish — stale destroyed records
        const existingWorkspaces = allWorkspaces.filter(
          (w) => w.status !== 'destroyed'
        )

        const existingByPath = new Map(
          existingWorkspaces.map((workspace) => [
            workspace.worktreePath,
            workspace,
          ])
        )
        const detectedPaths = new Set(
          detectedWorktrees.map((worktree) => worktree.path)
        )

        let added = 0
        let removed = 0
        let unchanged = 0

        for (const detected of detectedWorktrees) {
          if (existingByPath.has(detected.path)) {
            unchanged += 1
            continue
          }

          const baseSha = yield* deriveBaseSha(
            repoPath,
            defaultBranchRef,
            detected.head
          )

          store.commit(
            events.workspaceCreated({
              id: crypto.randomUUID(),
              projectId,
              taskSource: null,
              branchName: toWorkspaceBranchName(detected.branch, detected.head),
              worktreePath: detected.path,
              port: 0,
              status: 'stopped',
              origin: 'external',
              createdAt: new Date().toISOString(),
              baseSha,
            })
          )
          added += 1
        }

        for (const workspace of existingWorkspaces) {
          if (detectedPaths.has(workspace.worktreePath)) {
            continue
          }

          if (workspace.port > 0) {
            yield* portAllocator
              .free(workspace.port)
              .pipe(Effect.catchAll(() => Effect.void))
          }

          store.commit(events.workspaceDestroyed({ id: workspace.id }))
          removed += 1
        }

        return {
          added,
          removed,
          unchanged,
        } satisfies ReconcileResult
      })

      return WorktreeReconciler.of({ reconcile })
    })
  )
}

export { WorktreeReconciler }
