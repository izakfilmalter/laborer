import { realpathSync } from 'node:fs'
import { RpcError } from '@laborer/shared/rpc'
import { Context, Effect, Layer } from 'effect'
import { execFile } from '../lib/spawn.js'
import { LaborerDatabase } from './laborer-database.js'
import type { NativeLaborerDatabase } from './native-laborer-database.js'
import { withFsmonitorDisabled } from './repo-watching-git.js'
import { RepositoryIdentity } from './repository-identity.js'
import {
  listWorkspaceRecords,
  type WorkspaceRecord,
} from './workspace-records.js'
import { type DetectedWorktree, WorktreeDetector } from './worktree-detector.js'
import {
  type TranslatableWorktree,
  translateWorktreesToTasks,
} from './worktree-task-translator.js'

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

const canonicalize = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

const toWorkspaceBranchName = (
  branch: string | null,
  headSha: string
): string => {
  if (branch !== null && branch.length > 0) {
    return branch
  }
  return `detached/${headSha.slice(0, 8)}`
}

interface ExternalWorktreeLineage {
  readonly baseBranch: string
  readonly baseSha: string
}

interface BranchCreation {
  readonly baseSha: string
  readonly createdAt: number
  readonly source: string
}

const REFLOG_UNIX_TIMESTAMP_PATTERN = /@\{(\d+)\}$/

const branchNameFromCreationSource = (source: string): string => {
  const prefix = 'refs/heads/'
  return source.startsWith(prefix) ? source.slice(prefix.length) : source
}

const parseBranchCreation = (
  entry: string
): { readonly branch: string; readonly creation: BranchCreation } | null => {
  const [baseSha, selector, ...messageParts] = entry.split('\t')
  const timestampMatch = selector?.match(REFLOG_UNIX_TIMESTAMP_PATTERN)
  if (baseSha === undefined || timestampMatch == null) {
    return null
  }
  const branch = selector?.slice(0, timestampMatch.index)
  const refsPrefix = 'refs/heads/'
  if (branch === undefined || !branch.startsWith(refsPrefix)) {
    return null
  }
  const message = messageParts.join('\t')
  const prefix = 'branch: Created from '
  if (!(message.startsWith(prefix) && baseSha.length > 0)) {
    return null
  }
  return {
    branch: branch.slice(refsPrefix.length),
    creation: {
      baseSha,
      createdAt: Number(timestampMatch[1]),
      source: branchNameFromCreationSource(message.slice(prefix.length)),
    },
  }
}

const parseBranchCreations = (
  stdout: string,
  liveWorkspaceBranches: ReadonlySet<string>
): ReadonlyMap<string, BranchCreation> => {
  const creations = new Map<string, BranchCreation>()
  for (const entry of stdout.split('\n')) {
    const parsed = parseBranchCreation(entry)
    // Reflog output is newest-first. Keep the newest creation entry if a ref
    // has ever been deleted and recreated without its old log being pruned.
    if (
      parsed !== null &&
      liveWorkspaceBranches.has(parsed.branch) &&
      !creations.has(parsed.branch)
    ) {
      creations.set(parsed.branch, parsed.creation)
    }
  }
  return creations
}

const creationParentStillMatches = (
  repoPath: string,
  creation: BranchCreation,
  sourceCreation: BranchCreation | undefined
): Effect.Effect<boolean, RpcError> => {
  if (
    sourceCreation === undefined ||
    sourceCreation.createdAt > creation.createdAt
  ) {
    return Effect.succeed(false)
  }
  return runGit(
    [
      'merge-base',
      '--is-ancestor',
      creation.baseSha,
      `refs/heads/${creation.source}`,
    ],
    repoPath
  ).pipe(Effect.map((result) => result.exitCode === 0))
}

/**
 * Recover the start point Git recorded when a local branch was created. This
 * is adoption evidence only: once persisted, `parent_task_id` remains the
 * authoritative lineage fact.
 */
const deriveExternalWorktreeLineages = (
  repoPath: string,
  detectedWorktrees: readonly DetectedWorktree[]
): Effect.Effect<ReadonlyMap<string, ExternalWorktreeLineage>, RpcError> =>
  Effect.gen(function* () {
    const liveWorkspaceBranches = new Set(
      detectedWorktrees.flatMap((worktree) =>
        worktree.isMain || worktree.branch === null ? [] : [worktree.branch]
      )
    )
    if (liveWorkspaceBranches.size === 0) {
      return new Map()
    }
    const reflog = yield* runGit(
      [
        'reflog',
        'show',
        '--date=unix',
        '--format=%H%x09%gD%x09%gs',
        ...[...liveWorkspaceBranches].map((branch) => `refs/heads/${branch}`),
      ],
      repoPath
    )
    if (reflog.exitCode !== 0) {
      return new Map()
    }
    const lineages = new Map<string, ExternalWorktreeLineage>()
    const creationsByBranch = parseBranchCreations(
      reflog.stdout,
      liveWorkspaceBranches
    )

    for (const [branch, creation] of creationsByBranch) {
      // "Created from HEAD" does not identify which worktree was the cwd;
      // commit-graph guesses can permanently mis-parent sibling branches.
      if (
        creation.source !== branch &&
        liveWorkspaceBranches.has(creation.source) &&
        (yield* creationParentStillMatches(
          repoPath,
          creation,
          creationsByBranch.get(creation.source)
        ))
      ) {
        lineages.set(branch, {
          baseBranch: creation.source,
          baseSha: creation.baseSha,
        })
      }
    }

    return lineages
  })

/**
 * Choose the worktrees the shared task db should witness as cards. Skips the
 * main checkout, worktrees mid-provisioning for an existing task (the
 * workspace's `taskSource` is committed before `git worktree add` runs,
 * while the task row gains its `worktree_path` only after), and
 * laborer-managed destroys still in progress.
 */
const selectTranslatableWorktrees = (
  detectedWorktrees: readonly {
    readonly branch: string | null
    readonly isMain: boolean
    readonly path: string
  }[],
  workspacesByCanonicalPath: ReadonlyMap<string, WorkspaceRecord>,
  baseShasByCanonicalPath: ReadonlyMap<string, string | null>,
  lineagesByBranch: ReadonlyMap<string, ExternalWorktreeLineage>
): readonly TranslatableWorktree[] => {
  const translatable: TranslatableWorktree[] = []
  for (const detected of detectedWorktrees) {
    if (detected.isMain) {
      continue
    }
    const canonicalPath = canonicalize(detected.path)
    const workspace = workspacesByCanonicalPath.get(canonicalPath)
    if (workspace !== undefined) {
      continue
    }
    const lineage =
      detected.branch === null
        ? undefined
        : lineagesByBranch.get(detected.branch)
    translatable.push({
      baseBranch: lineage?.baseBranch ?? null,
      baseSha: baseShasByCanonicalPath.get(canonicalPath) ?? null,
      branch: detected.branch,
      canonicalPath,
      path: detected.path,
    })
  }
  return translatable
}

const repairDetectedWorktreeLineage = (
  database: NativeLaborerDatabase,
  detected: DetectedWorktree,
  lineagesByBranch: ReadonlyMap<string, ExternalWorktreeLineage>,
  workspacesByBranch: ReadonlyMap<string, WorkspaceRecord>,
  workspacesByPath: ReadonlyMap<string, WorkspaceRecord>
): void => {
  if (detected.branch === null) {
    return
  }
  const lineage = lineagesByBranch.get(detected.branch)
  if (lineage === undefined) {
    return
  }
  const childWorkspace = workspacesByPath.get(canonicalize(detected.path))
  const parentWorkspace = workspacesByBranch.get(lineage.baseBranch)
  if (
    childWorkspace === undefined ||
    parentWorkspace === undefined ||
    childWorkspace.id === parentWorkspace.id
  ) {
    return
  }
  const childTask = database.findTask(childWorkspace.id)
  if (
    childTask?.source !== 'worktree' ||
    childTask.parentTaskId !== null ||
    childTask.baseBranch !== null
  ) {
    return
  }
  database.updateTask(childTask.id, childTask.revision, {
    baseBranch: lineage.baseBranch,
    baseSha: lineage.baseSha,
    parentTaskId: parentWorkspace.id,
  })
}

const repairExternalWorktreeLineages = (
  database: NativeLaborerDatabase,
  projectId: string,
  detectedWorktrees: readonly DetectedWorktree[],
  lineagesByBranch: ReadonlyMap<string, ExternalWorktreeLineage>
): void => {
  const currentWorkspaces = listWorkspaceRecords(database).filter(
    (workspace) => workspace.projectId === projectId
  )
  const workspacesByBranch = new Map(
    currentWorkspaces.map((workspace) => [workspace.branchName, workspace])
  )
  const workspacesByPath = new Map(
    currentWorkspaces.map((workspace) => [
      canonicalize(workspace.worktreePath),
      workspace,
    ])
  )
  for (const detected of detectedWorktrees) {
    repairDetectedWorktreeLineage(
      database,
      detected,
      lineagesByBranch,
      workspacesByBranch,
      workspacesByPath
    )
  }
}

const scanDetectedWorktreeAdditions = (
  repoPath: string,
  projectId: string,
  defaultBranchRef: string,
  detectedWorktrees: readonly DetectedWorktree[],
  workspacesByCanonicalPath: ReadonlyMap<string, WorkspaceRecord>,
  lineagesByBranch: ReadonlyMap<string, ExternalWorktreeLineage>
): Effect.Effect<
  {
    readonly added: number
    readonly baseShasByCanonicalPath: ReadonlyMap<string, string | null>
    readonly unchanged: number
  },
  RpcError
> =>
  Effect.gen(function* () {
    let added = 0
    let unchanged = 0
    const baseShasByCanonicalPath = new Map<string, string | null>()
    for (const detected of detectedWorktrees) {
      const canonicalDetectedPath = canonicalize(detected.path)
      if (workspacesByCanonicalPath.has(canonicalDetectedPath)) {
        unchanged += 1
        continue
      }
      if (detected.isMain) {
        continue
      }
      const lineage =
        detected.branch === null
          ? undefined
          : lineagesByBranch.get(detected.branch)
      const baseSha =
        lineage?.baseSha ??
        (yield* deriveBaseSha(repoPath, defaultBranchRef, detected.head))
      baseShasByCanonicalPath.set(canonicalDetectedPath, baseSha)
      const branchName = toWorkspaceBranchName(detected.branch, detected.head)
      yield* Effect.log(
        `[WorktreeReconciler] ADDING external workspace: project=${projectId} branch=${branchName} isMain=${detected.isMain} path=${canonicalDetectedPath} baseSha=${baseSha?.slice(0, 8) ?? 'null'}`
      )
      added += 1
    }
    return { added, baseShasByCanonicalPath, unchanged }
  })

class WorktreeReconciler extends Context.Service<
  WorktreeReconciler,
  {
    reconcile: (
      projectId: string,
      repoPath: string
    ) => Effect.Effect<ReconcileResult, RpcError>
  }
>()('@laborer/WorktreeReconciler') {
  static readonly layer = Layer.effect(
    WorktreeReconciler,
    Effect.gen(function* () {
      const laborerDatabase = yield* LaborerDatabase
      const detector = yield* WorktreeDetector
      const repoIdentity = yield* RepositoryIdentity

      const reconcile = Effect.fn('WorktreeReconciler.reconcile')(function* (
        projectId: string,
        repoPath: string
      ) {
        // Resolve canonical repo path through RepositoryIdentity so that
        // detection runs against a canonicalized checkout root regardless
        // of what path representation the caller provides.
        const identity = yield* repoIdentity.resolve(repoPath).pipe(
          Effect.mapError(
            (error) =>
              new RpcError({
                message: `Failed to resolve canonical identity for reconciliation: ${error.message}`,
                code: 'WORKTREE_RECONCILE_FAILED',
              })
          )
        )
        const canonicalRepoPath = identity.canonicalRoot

        const detectedWorktrees = yield* detector.detect(canonicalRepoPath)
        const defaultBranchRef = yield* getDefaultBranchRef(canonicalRepoPath)
        const lineagesByBranch = yield* deriveExternalWorktreeLineages(
          canonicalRepoPath,
          detectedWorktrees
        )

        yield* Effect.logDebug(
          `[WorktreeReconciler] project=${projectId} detected ${detectedWorktrees.length} worktrees, defaultBranchRef=${defaultBranchRef}. Worktrees: ${detectedWorktrees.map((w) => `${w.branch ?? 'detached'}(isMain=${w.isMain}, head=${w.head.slice(0, 8)})`).join(', ')}`
        )

        const allWorkspaces = yield* laborerDatabase.read(
          'list workspaces for reconciliation',
          (database) =>
            listWorkspaceRecords(database).filter(
              (workspace) => workspace.projectId === projectId
            )
        )

        // Filter out workspaces that should not be candidates for removal:
        //
        // - **destroyed**: already gone — nothing to remove.
        // - **creating**: committed to the store but `git worktree add`
        //   has not executed yet, so the directory won't appear in
        //   `git worktree list`. Removing would race with the background
        //   setup fiber.
        const existingWorkspaces = allWorkspaces.filter(
          (w) => w.status !== 'creating'
        )

        // Canonicalize existing workspace paths for comparison so that
        // path representation differences (symlinks, /var vs /private/var)
        // do not cause false adds or removes.
        //
        // For the "add" pass, use ALL workspaces (including destroyed
        // laborer-managed ones). A laborer workspace in "destroyed" status
        // may still have its worktree directory on disk while cleanup is
        // in progress (git worktree removal can take seconds). Without
        // checking destroyed laborer records, the
        // reconciler would re-detect the same worktree and create a
        // duplicate "external" record that immediately reappears in the UI.
        const allByCanonicalPath = new Map(
          allWorkspaces.map((workspace) => [
            canonicalize(workspace.worktreePath),
            workspace,
          ])
        )
        const detectedCanonicalPaths = new Set(
          detectedWorktrees.map((worktree) => canonicalize(worktree.path))
        )

        const { added, baseShasByCanonicalPath, unchanged } =
          yield* scanDetectedWorktreeAdditions(
            canonicalRepoPath,
            projectId,
            defaultBranchRef,
            detectedWorktrees,
            allByCanonicalPath,
            lineagesByBranch
          )
        let removed = 0

        for (const workspace of existingWorkspaces) {
          const canonicalWorkspacePath = canonicalize(workspace.worktreePath)
          if (detectedCanonicalPaths.has(canonicalWorkspacePath)) {
            continue
          }

          yield* laborerDatabase
            .run('release missing worktree', (database) => {
              const task = database.findTask(workspace.id)
              if (task !== null) {
                database.updateTask(task.id, task.revision, {
                  status: 'done',
                  worktreeError: null,
                  worktreePath: null,
                  worktreeStatus: null,
                })
              }
            })
            .pipe(
              Effect.mapError(
                () =>
                  new RpcError({
                    code: 'WORKTREE_RECONCILE_FAILED',
                    message: `Failed to release missing worktree ${workspace.id}`,
                  })
              )
            )
          removed += 1
        }

        yield* translateWorktreesToTasks(
          {
            parentTaskIdsByBranch: new Map(
              allWorkspaces.map((workspace) => [
                workspace.branchName,
                workspace.id,
              ])
            ),
            rootPath: canonicalRepoPath,
            worktrees: selectTranslatableWorktrees(
              detectedWorktrees,
              allByCanonicalPath,
              baseShasByCanonicalPath,
              lineagesByBranch
            ),
          },
          laborerDatabase.database
        )

        // Older external worktrees were adopted before lineage recovery was
        // available. Repair only external tasks with neither lineage nor a
        // snapshotted base branch; explicit or deliberately promoted lineage
        // remains untouched.
        yield* laborerDatabase
          .run('repair external worktree lineage', (database) =>
            repairExternalWorktreeLineages(
              database,
              projectId,
              detectedWorktrees,
              lineagesByBranch
            )
          )
          .pipe(
            Effect.mapError(
              () =>
                new RpcError({
                  code: 'WORKTREE_RECONCILE_FAILED',
                  message: `Failed to repair external worktree lineage for ${projectId}`,
                })
            )
          )

        if (added > 0 || removed > 0) {
          yield* Effect.log(
            `[WorktreeReconciler] project=${projectId} reconcile complete: added=${added} removed=${removed} unchanged=${unchanged}`
          )
        } else {
          yield* Effect.logDebug(
            `[WorktreeReconciler] project=${projectId} reconcile complete: added=${added} removed=${removed} unchanged=${unchanged}`
          )
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
