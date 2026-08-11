import { basename } from 'node:path'
import { taskDatabasePath } from '@laborer/task-db/path'
import { Effect } from 'effect'
import { NodeTaskBoardDatabase } from './node-task-board-database.js'
import { createTaskUlid } from './task-card-creator.js'

/**
 * A git worktree the reconciler considers eligible for a board card: not the
 * main checkout, not prunable, and not currently claimed by an in-flight
 * provisioning workspace (LiveStore `taskSource`) or a laborer-managed
 * destroy in progress.
 */
export interface TranslatableWorktree {
  readonly baseSha?: string | null
  readonly branch: string | null
  /** Canonical (realpath) worktree location. */
  readonly canonicalPath: string
  /** Raw path as reported by `git worktree list`. */
  readonly path: string
}

/**
 * Translate git worktrees without a board presence into `worktree`-source
 * tasks, born In Progress. The claim check and insert are atomic per
 * worktree (see {@link NodeTaskBoardDatabase.adoptWorktreeTask}), so
 * concurrent reconcile passes converge on a single card.
 *
 * Translation is witness work: it never fails the caller. Database trouble
 * is logged and reported as zero adoptions.
 */
export const translateWorktreesToTasks = (
  input: {
    /** Canonical repo root owning these worktrees; becomes `root_path`. */
    readonly rootPath: string
    readonly worktrees: readonly TranslatableWorktree[]
  },
  path = taskDatabasePath()
): Effect.Effect<number> =>
  Effect.try(() => {
    if (input.worktrees.length === 0) {
      return 0
    }
    const database = NodeTaskBoardDatabase.open(path)
    try {
      let adopted = 0
      for (const worktree of input.worktrees) {
        const task = database.adoptWorktreeTask({
          baseSha: worktree.baseSha ?? null,
          branchName: worktree.branch,
          id: createTaskUlid(),
          rootPath: input.rootPath,
          title: worktree.branch ?? basename(worktree.canonicalPath),
          worktreePath: worktree.canonicalPath,
          worktreePathAliases: [worktree.path],
        })
        if (task !== null) {
          adopted += 1
        }
      }
      return adopted
    } finally {
      database.close()
    }
  }).pipe(
    Effect.tap((adopted) =>
      adopted > 0
        ? Effect.log(
            `[worktree-task-translator] adopted ${adopted} worktree(s) as tasks under ${input.rootPath}`
          )
        : Effect.void
    ),
    Effect.catchAll((error) =>
      Effect.logWarning(
        `[worktree-task-translator] could not translate worktrees under ${input.rootPath}: ${
          error.cause instanceof Error ? error.cause.message : String(error)
        }`
      ).pipe(Effect.as(0))
    )
  )
