import { basename } from 'node:path'
import { taskDatabasePath } from '@laborer/task-db/path'
import { createTaskUlid } from '@laborer/task-db/ulid'
import { Effect } from 'effect'
import { NodeTaskBoardDatabase } from './node-task-board-database.js'

interface WorktreeAdoptionDatabase {
  readonly adoptWorktreeTask: (input: {
    readonly baseBranch?: string | null
    readonly baseSha?: string | null
    readonly branchName: string | null
    readonly id: string
    readonly parentTaskId?: string | null
    readonly rootPath: string
    readonly title: string
    readonly worktreePath: string
    readonly worktreePathAliases: readonly string[]
  }) => { readonly id: string } | null
}

/**
 * A git worktree the reconciler considers eligible for a board card: not the
 * main checkout, not prunable, and not currently claimed by an in-flight
 * provisioning task or a laborer-managed destroy in progress.
 */
export interface TranslatableWorktree {
  readonly baseBranch?: string | null
  readonly baseSha?: string | null
  readonly branch: string | null
  /** Canonical (realpath) worktree location. */
  readonly canonicalPath: string
  /** Raw path as reported by `git worktree list`. */
  readonly path: string
}

interface WorktreeTranslationInput {
  /** Existing live workspace task IDs, keyed by their checked-out branch. */
  readonly parentTaskIdsByBranch?: ReadonlyMap<string, string>
  /** Canonical repo root owning these worktrees; becomes `root_path`. */
  readonly rootPath: string
  readonly worktrees: readonly TranslatableWorktree[]
}

const readyWorktreeIndex = (
  pending: readonly TranslatableWorktree[],
  taskIdsByBranch: ReadonlyMap<string, string>
): number => {
  const ready = pending.findIndex(
    (worktree) =>
      worktree.baseBranch == null ||
      taskIdsByBranch.has(worktree.baseBranch) ||
      !pending.some((candidate) => candidate.branch === worktree.baseBranch)
  )
  return ready === -1 ? 0 : ready
}

const adoptWorktrees = (
  input: WorktreeTranslationInput,
  database: WorktreeAdoptionDatabase
): number => {
  let adopted = 0
  const taskIdsByBranch = new Map(input.parentTaskIdsByBranch)
  const pending = [...input.worktrees]
  while (pending.length > 0) {
    // Parents must be adopted before their descendants so the stored foreign
    // key is valid when several worktrees are first witnessed in one pass.
    const [worktree] = pending.splice(
      readyWorktreeIndex(pending, taskIdsByBranch),
      1
    )
    if (worktree === undefined) {
      continue
    }
    const parentTaskId =
      worktree.baseBranch == null
        ? null
        : (taskIdsByBranch.get(worktree.baseBranch) ?? null)
    const task = database.adoptWorktreeTask({
      baseBranch: parentTaskId === null ? null : (worktree.baseBranch ?? null),
      baseSha: worktree.baseSha ?? null,
      branchName: worktree.branch,
      id: createTaskUlid(),
      parentTaskId,
      rootPath: input.rootPath,
      title: worktree.branch ?? basename(worktree.canonicalPath),
      worktreePath: worktree.canonicalPath,
      worktreePathAliases: [worktree.path],
    })
    if (task !== null) {
      adopted += 1
      if (worktree.branch !== null) {
        taskIdsByBranch.set(worktree.branch, task.id)
      }
    }
  }
  return adopted
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
  input: WorktreeTranslationInput,
  target: string | WorktreeAdoptionDatabase = taskDatabasePath()
): Effect.Effect<number> =>
  Effect.try(() => {
    if (input.worktrees.length === 0) {
      return 0
    }
    let ownedDatabase: NodeTaskBoardDatabase | null = null
    let database: WorktreeAdoptionDatabase
    if (typeof target === 'string') {
      ownedDatabase = NodeTaskBoardDatabase.open(target)
      database = ownedDatabase
    } else {
      database = target
    }
    try {
      return adoptWorktrees(input, database)
    } finally {
      ownedDatabase?.close()
    }
  }).pipe(
    Effect.tap((adopted) =>
      adopted > 0
        ? Effect.log(
            `[worktree-task-translator] adopted ${adopted} worktree(s) as tasks under ${input.rootPath}`
          )
        : Effect.void
    ),
    Effect.catch((error) =>
      Effect.logWarning(
        `[worktree-task-translator] could not translate worktrees under ${input.rootPath}: ${
          error.cause instanceof Error ? error.cause.message : String(error)
        }`
      ).pipe(Effect.as(0))
    )
  )
