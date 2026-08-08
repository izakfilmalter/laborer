/**
 * WorkspaceProvider — Effect Service
 *
 * Manages isolated workspace environments via git worktrees. Each workspace
 * gets its own branch and directory. Sandbox lifecycle (container/cloud
 * sandbox creation, destruction, pause, resume) is delegated to the
 * configured `SandboxProvider` implementation (Docker or Daytona).
 *
 * Responsibilities:
 * - Worktree creation via `git worktree add`
 * - Worktree destruction via `git worktree remove` + `git branch -D`
 * - Project validation via ProjectRegistry
 * - Workspace state tracking via LiveStore
 * - Branch management and naming
 * - Worktree directory validation after creation (Issue #34)
 * - File watcher scoping via environment variables (Issue #34)
 * - Environment variable injection (watcher scoping, etc.) for workspace processes
 * - Setup script execution after worktree creation (Issue #35)
 * - Full rollback on setup script failure (Issue #37)
 *
 * Setup scripts are defined in `laborer.json` and resolved via ConfigService:
 * ```json
 * {
 *   "setupScripts": ["bun install", "cp .env.example .env"]
 * }
 * ```
 *
 * Each script is executed in the worktree directory with the workspace
 * environment variables injected. Scripts run sequentially
 * and any non-zero exit code aborts the remaining scripts. On failure,
 * the workspace is rolled back: worktree removed, branch
 * deleted. The error includes the script's stdout + stderr output.
 *
 * Usage:
 * ```ts
 * const program = Effect.gen(function* () {
 *   const provider = yield* WorkspaceProvider
 *   const workspace = yield* provider.createWorktree("project-id", "feature/my-branch")
 *   const env = yield* provider.getWorkspaceEnv("workspace-id")
 *   yield* provider.destroyWorktree("workspace-id")
 * })
 * ```
 *
 * Issue #33: createWorktree method
 * Issue #34: worktree directory validation + file watcher scoping
 * Issue #35: run setup scripts in worktree
 * Issue #37: handle setup script failure (rollback)
 * Issue #38: handle dirty git state error
 * Issue #43: destroyWorktree method
 */

import { execFile } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { RpcError } from '@laborer/shared/rpc'
import { events, tables } from '@laborer/shared/schema'
import {
  Array as Arr,
  Cause,
  Context,
  Effect,
  Fiber,
  Layer,
  pipe,
  Ref,
} from 'effect'
import { spawn } from '../lib/spawn.js'
import { spawnGit } from '../lib/spawn-git.js'
import { ConfigService } from './config-service.js'
import { LaborerStore } from './laborer-store.js'
import { ProjectRegistry } from './project-registry.js'
import { SandboxProvider } from './sandbox-provider.js'

/**
 * Shape of a workspace record returned by the provider.
 * Matches the LiveStore workspaces table columns.
 */
interface WorkspaceRecord {
  /** Branch this workspace's PR targets (sub-workspaces only). Null for ordinary workspaces. */
  readonly baseBranch: string | null
  /** SHA of the parent branch HEAD when the worktree was created. Used by DiffService as the diff base. */
  readonly baseSha: string | null
  readonly branchName: string
  readonly createdAt: string
  readonly id: string
  readonly origin: 'laborer' | 'external'
  readonly projectId: string
  readonly status: string
  readonly taskSource: string | null
  readonly worktreePath: string
}

/**
 * Slugify a branch name for use as a directory name.
 * Replaces non-alphanumeric characters (except hyphens) with hyphens.
 */
const slugify = (branchName: string): string =>
  branchName
    .replace(/\//g, '-')
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

/**
 * Module-level log annotation for structured logging.
 */
const logPrefix = 'WorkspaceProvider'

const localBranchExists = (
  repoPath: string,
  branchName: string
): Effect.Effect<boolean, RpcError> =>
  Effect.tryPromise({
    try: async () => {
      const proc = spawn(['git', 'rev-parse', '--verify', branchName], {
        cwd: repoPath,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const exitCode = await proc.exited
      return exitCode === 0
    },
    catch: () =>
      new RpcError({
        message: `Failed to check branch existence: ${branchName}`,
        code: 'GIT_CHECK_FAILED',
      }),
  })

const originBranchExists = (
  repoPath: string,
  branchName: string,
  remoteBranchRef: string
): Effect.Effect<boolean> =>
  Effect.tryPromise({
    try: async () => {
      const fetchProc = spawn(
        [
          'git',
          'fetch',
          'origin',
          `refs/heads/${branchName}:refs/remotes/${remoteBranchRef}`,
        ],
        {
          cwd: repoPath,
          stdout: 'pipe',
          stderr: 'pipe',
        }
      )
      const fetchExitCode = await fetchProc.exited
      if (fetchExitCode !== 0) {
        return false
      }

      const verifyProc = spawn(
        ['git', 'rev-parse', '--verify', remoteBranchRef],
        {
          cwd: repoPath,
          stdout: 'pipe',
          stderr: 'pipe',
        }
      )
      const verifyExitCode = await verifyProc.exited
      return verifyExitCode === 0
    },
    catch: () =>
      new RpcError({
        message: `Failed to check origin branch existence: ${branchName}`,
        code: 'GIT_CHECK_FAILED',
      }),
  }).pipe(Effect.catchAll(() => Effect.succeed(false)))

const buildWorktreeAddArgs = (params: {
  readonly baseRef?: string | undefined
  readonly branchExists: boolean
  readonly branchName: string
  readonly remoteBranchExists: boolean
  readonly remoteBranchRef: string
  readonly worktreePath: string
}): string[] => {
  if (params.branchExists) {
    return ['git', 'worktree', 'add', params.worktreePath, params.branchName]
  }

  if (params.remoteBranchExists) {
    return [
      'git',
      'worktree',
      'add',
      '--track',
      '-b',
      params.branchName,
      params.worktreePath,
      params.remoteBranchRef,
    ]
  }

  return [
    'git',
    'worktree',
    'add',
    '-b',
    params.branchName,
    params.worktreePath,
    ...(params.baseRef ? [params.baseRef] : []),
  ]
}

/**
 * Result of running a single setup script.
 */
interface SetupScriptResult {
  readonly command: string
  readonly exitCode: number
  readonly stderr: string
  readonly stdout: string
}

/**
 * Execute a single shell command in a given directory with the provided
 * environment variables. Captures stdout and stderr for logging.
 */
const runSetupScript = (
  command: string,
  cwd: string,
  env: Record<string, string>
): Effect.Effect<SetupScriptResult, RpcError> =>
  Effect.tryPromise({
    try: async () => {
      const proc = spawn(['sh', '-c', command], {
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, ...env },
      })
      const exitCode = await proc.exited
      const stdout = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()
      return { command, exitCode, stdout, stderr }
    },
    catch: (error) =>
      new RpcError({
        message: `Failed to spawn setup script '${command}': ${String(error)}`,
        code: 'SETUP_SCRIPT_FAILED',
      }),
  })

/**
 * Execute all setup scripts from the project config in the worktree directory.
 * Scripts run sequentially. Captures stdout/stderr for each script.
 * Returns an array of results. If any script has a non-zero exit code,
 * execution stops and the remaining scripts are skipped.
 *
 * @param scripts - Array of shell commands to execute
 * @param worktreePath - Directory to execute scripts in
 * @param env - Environment variables to inject (PORT, etc.)
 * @returns Array of results for each executed script
 */
const executeSetupScripts = (
  scripts: readonly string[],
  worktreePath: string,
  env: Record<string, string>
): Effect.Effect<readonly SetupScriptResult[], RpcError> =>
  Effect.gen(function* () {
    const results: SetupScriptResult[] = []

    for (const script of scripts) {
      yield* Effect.logInfo(`Running setup script: ${script}`).pipe(
        Effect.annotateLogs('module', logPrefix)
      )

      const result = yield* runSetupScript(script, worktreePath, env)
      results.push(result)

      if (result.stdout.length > 0) {
        yield* Effect.logDebug(
          `Setup script stdout: ${result.stdout.trim()}`
        ).pipe(Effect.annotateLogs('module', logPrefix))
      }

      if (result.exitCode !== 0) {
        yield* Effect.logWarning(
          `Setup script failed (exit ${result.exitCode}): ${script}\nstderr: ${result.stderr.trim()}`
        ).pipe(Effect.annotateLogs('module', logPrefix))
        // Stop executing remaining scripts — the caller will handle rollback
        break
      }

      yield* Effect.logInfo(
        `Setup script completed successfully: ${script}`
      ).pipe(Effect.annotateLogs('module', logPrefix))
    }

    return results
  })

/**
 * Result of running setup scripts. Either all scripts succeeded,
 * or one failed with details about the failure.
 */
type SetupResult =
  | { readonly _tag: 'Success' }
  | {
      readonly _tag: 'Failure'
      readonly command: string
      readonly exitCode: number
      readonly stdout: string
      readonly stderr: string
    }

/**
 * Run setup scripts in the worktree directory.
 * Returns a SetupResult indicating success or failure with details.
 * Does nothing (returns Success) if no scripts are configured.
 *
 * @param scripts - Setup scripts resolved from ConfigService
 * @param worktreePath - Directory to execute scripts in
 * @param env - Environment variables to inject (PORT, etc.)
 */
const runProjectSetupScripts = (
  scripts: readonly string[],
  worktreePath: string,
  env: Record<string, string>
): Effect.Effect<SetupResult, RpcError> =>
  Effect.gen(function* () {
    if (scripts.length === 0) {
      return { _tag: 'Success' } as SetupResult
    }

    const scriptResults = yield* executeSetupScripts(scripts, worktreePath, env)

    const failedScript = pipe(
      scriptResults,
      Arr.findFirst((r) => r.exitCode !== 0)
    )

    if (failedScript._tag === 'Some') {
      const failed = failedScript.value
      yield* Effect.logWarning(
        `Workspace setup failed: script '${failed.command}' exited with code ${failed.exitCode}`
      ).pipe(Effect.annotateLogs('module', logPrefix))

      return {
        _tag: 'Failure',
        command: failed.command,
        exitCode: failed.exitCode,
        stdout: failed.stdout,
        stderr: failed.stderr,
      } as SetupResult
    }

    yield* Effect.logInfo(
      `All ${scripts.length} setup script(s) completed successfully`
    ).pipe(Effect.annotateLogs('module', logPrefix))

    return { _tag: 'Success' } as SetupResult
  })

/**
 * Build the error message for a failed setup script, including
 * stdout and stderr output for user visibility.
 */
const buildSetupFailureMessage = (failure: {
  readonly command: string
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}): string => {
  const outputParts: string[] = []
  if (failure.stdout.trim().length > 0) {
    outputParts.push(`stdout: ${failure.stdout.trim()}`)
  }
  if (failure.stderr.trim().length > 0) {
    outputParts.push(`stderr: ${failure.stderr.trim()}`)
  }
  const outputSuffix =
    outputParts.length > 0 ? `\n${outputParts.join('\n')}` : ''

  return `Setup script '${failure.command}' failed with exit code ${failure.exitCode}.${outputSuffix}`
}

/**
 * Result of validating a worktree after creation. Contains detailed
 * validation checks for directory existence, git working tree status,
 * correct branch, and git toplevel isolation.
 *
 * Issue #34: worktree directory validation
 */
interface WorktreeValidation {
  /** The actual branch name found in the worktree (for error messages) */
  readonly actualBranch: string | null
  /** The actual toplevel path (for error messages) */
  readonly actualToplevel: string | null
  /** Whether the checked-out branch matches the expected branch name */
  readonly correctBranch: boolean
  /** Whether the directory exists on disk */
  readonly directoryExists: boolean
  /** Whether `git rev-parse --is-inside-work-tree` returns true */
  readonly isGitWorkTree: boolean
  /** Whether the git toplevel path matches the worktree path (not the main repo) */
  readonly isolatedToplevel: boolean
}

/**
 * Validate a created worktree directory. Runs three git commands to verify:
 * 1. The directory is inside a git work tree (`git rev-parse --is-inside-work-tree`)
 * 2. The correct branch is checked out (`git rev-parse --abbrev-ref HEAD`)
 * 3. The git toplevel points to the worktree (not the main repo) (`git rev-parse --show-toplevel`)
 *
 * Also checks that the directory exists on disk before running git commands.
 *
 * @param worktreePath - Absolute path to the worktree directory
 * @param expectedBranch - The branch name that should be checked out
 * @returns WorktreeValidation with detailed results
 *
 * Issue #34: worktree directory validation
 */
/**
 * Execute a git command using node:child_process.
 * This is used by `validateWorktree` for lightweight git queries where
 * the full spawn utility is not needed.
 *
 * @param args - Git subcommand and arguments (without "git" prefix)
 * @param cwd - Working directory to run the command in
 * @returns Promise of { exitCode, stdout }
 */
const execGit = (
  args: readonly string[],
  cwd: string
): Promise<{ exitCode: number; stdout: string }> =>
  new Promise((resolvePromise) => {
    execFile('git', [...args], { cwd }, (error, stdout) => {
      if (error) {
        // execFile returns an error for non-zero exit codes
        const exitCode = error.code !== undefined ? Number(error.code) : 1
        resolvePromise({ exitCode, stdout: stdout ?? '' })
        return
      }
      resolvePromise({ exitCode: 0, stdout: stdout ?? '' })
    })
  })

const validateWorktree = (
  worktreePath: string,
  expectedBranch: string
): Effect.Effect<WorktreeValidation, RpcError> =>
  Effect.gen(function* () {
    // 1. Check directory exists
    const directoryExists = existsSync(worktreePath)
    if (!directoryExists) {
      return {
        directoryExists: false,
        isGitWorkTree: false,
        correctBranch: false,
        actualBranch: null,
        isolatedToplevel: false,
        actualToplevel: null,
      } satisfies WorktreeValidation
    }

    // 2. Check it's a git work tree
    const workTreeResult = yield* Effect.tryPromise({
      try: async () => {
        const result = await execGit(
          ['rev-parse', '--is-inside-work-tree'],
          worktreePath
        )
        return result.exitCode === 0
      },
      catch: () =>
        new RpcError({
          message: `Failed to verify worktree at: ${worktreePath}`,
          code: 'WORKTREE_VERIFY_FAILED',
        }),
    })

    // 3. Check the correct branch is checked out
    const branchResult = yield* Effect.tryPromise({
      try: async () => {
        const result = await execGit(
          ['rev-parse', '--abbrev-ref', 'HEAD'],
          worktreePath
        )
        return result.exitCode === 0 ? result.stdout.trim() : null
      },
      catch: () =>
        new RpcError({
          message: `Failed to check branch in worktree: ${worktreePath}`,
          code: 'WORKTREE_VERIFY_FAILED',
        }),
    })

    // 4. Check git toplevel points to the worktree directory (not the main repo)
    const toplevelResult = yield* Effect.tryPromise({
      try: async () => {
        const result = await execGit(
          ['rev-parse', '--show-toplevel'],
          worktreePath
        )
        return result.exitCode === 0 ? result.stdout.trim() : null
      },
      catch: () =>
        new RpcError({
          message: `Failed to check git toplevel for worktree: ${worktreePath}`,
          code: 'WORKTREE_VERIFY_FAILED',
        }),
    })
    // Normalize paths for comparison using realpathSync to resolve symlinks.
    // On macOS, /var is a symlink to /private/var — git resolves the symlink
    // but Node.js path.resolve() does not. realpathSync handles this.
    // Uses Effect.try so that a realpathSync failure (e.g. race condition
    // where the directory was removed between existsSync and here) falls
    // back to raw path comparison instead of killing the fiber with a defect.
    const { normalizedToplevel, normalizedWorktree } = yield* Effect.try({
      try: () => ({
        normalizedWorktree: realpathSync(worktreePath),
        normalizedToplevel: toplevelResult
          ? realpathSync(toplevelResult)
          : null,
      }),
      catch: () => ({
        normalizedWorktree: worktreePath,
        normalizedToplevel: toplevelResult,
      }),
    }).pipe(Effect.merge)
    return {
      directoryExists: true,
      isGitWorkTree: workTreeResult,
      correctBranch: branchResult === expectedBranch,
      actualBranch: branchResult,
      isolatedToplevel:
        normalizedToplevel !== null &&
        normalizedToplevel === normalizedWorktree,
      actualToplevel: toplevelResult,
    } satisfies WorktreeValidation
  })

/**
 * Build a human-readable error message from a failed worktree validation.
 * Lists all failed checks so the user can diagnose the issue.
 *
 * Issue #34: worktree directory validation
 */
const buildValidationErrorMessage = (
  validation: WorktreeValidation,
  worktreePath: string,
  expectedBranch: string
): string => {
  const failures: string[] = []

  if (!validation.directoryExists) {
    failures.push(`directory does not exist: ${worktreePath}`)
  }
  if (!validation.isGitWorkTree) {
    failures.push('not a valid git working tree')
  }
  if (!validation.correctBranch) {
    failures.push(
      `expected branch "${expectedBranch}" but found "${validation.actualBranch ?? 'unknown'}"`
    )
  }
  if (!validation.isolatedToplevel) {
    failures.push(
      `git toplevel "${validation.actualToplevel ?? 'unknown'}" does not match worktree path "${worktreePath}"`
    )
  }

  return `Worktree validation failed: ${failures.join('; ')}`
}

class WorkspaceProvider extends Context.Tag('@laborer/WorkspaceProvider')<
  WorkspaceProvider,
  {
    /**
     * Create a new git worktree for a project.
     *
     * Returns immediately with a workspace in 'creating' status.
     * The heavy setup (worktree creation, setup scripts,
     * optional container setup) runs as a background fiber. Progress
     * is communicated via `worktreeSetupStepChanged` LiveStore events.
     * Once the worktree exists and validates, the workspace transitions
     * to 'running' so agents can open while setup scripts continue.
     *
     * @param projectId - ID of the registered project
     * @param branchName - Optional branch name (auto-generated if omitted)
     * @param onReady - Optional effect to run when workspace setup completes
     *   (e.g. start diff polling). Receives the workspace ID. Errors are
     *   logged but do not affect the workspace status.
     * @param baseWorkspaceId - Optional workspace to branch from, making this
     *   a sub-workspace: the worktree is created from that workspace's current
     *   HEAD (its branch is pushed best-effort first so the PR base exists on
     *   the remote) and `baseBranch` records the branch its PR targets.
     */
    readonly createWorktree: (
      projectId: string,
      branchName?: string,
      onReady?: (workspaceId: string) => Effect.Effect<void, RpcError>,
      baseWorkspaceId?: string
    ) => Effect.Effect<WorkspaceRecord, RpcError>

    /**
     * Destroy a workspace by removing its git worktree and committing a
     * WorkspaceDestroyed event to LiveStore.
     * The branch is kept so it can be reused when creating a new workspace.
     * All workspaces have their worktree removed regardless of origin.
     *
     * Steps:
     * 1. Look up the workspace in LiveStore
     * 2. Look up the project to get the repo path
     * 3. Run `git worktree remove --force` to remove the worktree directory
     * 4. Commit WorkspaceDestroyed event to LiveStore
     *
     * If the worktree has uncommitted changes and `force` is not set,
     * returns a `DIRTY_WORKTREE` error so the client can warn the user.
     *
     * @param workspaceId - ID of the workspace to destroy
     * @param force - If true, destroy even if there are uncommitted changes
     */
    readonly destroyWorktree: (
      workspaceId: string,
      force?: boolean
    ) => Effect.Effect<void, RpcError>

    /**
     * Check a workspace worktree for uncommitted changes.
     *
     * Returns a list of dirty file paths (empty array if clean).
     * This is a lightweight check that does not modify any state.
     *
     * @param workspaceId - ID of the workspace to check
     */
    readonly checkDirtyFiles: (
      workspaceId: string
    ) => Effect.Effect<readonly string[], RpcError>

    /**
     * Start a sandbox for an existing workspace.
     *
     * Converts a non-sandboxed workspace (typically one detected from
     * an existing git worktree with origin 'external') into a fully
     * sandboxed laborer workspace. Transitions the workspace to
     * 'running' status, updates origin to 'laborer', and runs sandbox
     * setup as a background fiber.
     *
     * @param workspaceId - ID of the workspace to sandbox
     * @param onReady - Optional effect to run when workspace is ready
     *   (e.g. start diff/PR polling). Errors are logged but do not
     *   affect workspace status.
     */
    readonly startSandbox: (
      workspaceId: string,
      onReady?: (workspaceId: string) => Effect.Effect<void, RpcError>
    ) => Effect.Effect<void, RpcError>

    /**
     * Get environment variables for a workspace.
     *
     * Returns a Record of env vars that should be injected into all
     * processes running in the workspace (setup scripts, terminals,
     * dev servers). Includes:
     * - LABORER_WORKSPACE_ID: the workspace ID
     * - LABORER_WORKSPACE_PATH: the worktree directory path
     * - LABORER_BRANCH: the workspace branch name
     *
     * @param workspaceId - ID of the workspace
     */
    readonly getWorkspaceEnv: (
      workspaceId: string
    ) => Effect.Effect<Record<string, string>, RpcError>
  }
>() {
  static readonly layer = Layer.scoped(
    WorkspaceProvider,
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      // Track background container-setup fibers per workspace so
      // destroyWorktree can interrupt them before cleaning up.
      const setupFibers = yield* Ref.make(
        new Map<string, Fiber.RuntimeFiber<void, never>>()
      )
      // Track in-flight destroy fibers by worktree path so a new create
      // for the same branch/path can wait for the actual cleanup fiber to
      // finish instead of guessing with a timeout.
      const destroyFibers = yield* Ref.make(
        new Map<string, Fiber.RuntimeFiber<void, never>>()
      )
      const { store } = yield* LaborerStore
      const registry = yield* ProjectRegistry
      const configService = yield* ConfigService
      const sandboxProvider = yield* SandboxProvider

      /**
       * Create and validate a git worktree.
       * Returns the base SHA on success. Communicates progress via
       * worktreeSetupStepChanged events.
       */
      const performWorktreeSetup = (params: {
        readonly id: string
        readonly branchName: string
        readonly repoPath: string
        readonly worktreeDir: string
        readonly worktreePath: string
        /**
         * Commit to branch the new worktree from (sub-workspaces: the parent
         * workspace's HEAD). Defaults to the main checkout's HEAD. Ignored
         * when the branch already exists.
         */
        readonly baseRef?: string | undefined
      }): Effect.Effect<string | null, RpcError> =>
        Effect.gen(function* () {
          const { id, branchName, repoPath, worktreeDir, worktreePath } = params

          // Check if a branch with this name already exists locally.
          const branchExists = yield* localBranchExists(repoPath, branchName)

          const remoteBranchRef = `origin/${branchName}`
          const remoteBranchExists = branchExists
            ? false
            : yield* originBranchExists(repoPath, branchName, remoteBranchRef)

          // Signal UI: creating worktree
          store.commit(
            events.worktreeSetupStepChanged({
              workspaceId: id,
              step: 'creating-worktree',
            })
          )

          // Ensure the resolved worktree directory exists
          yield* Effect.tryPromise({
            try: async () => {
              const proc = spawn(['mkdir', '-p', worktreeDir], {
                cwd: repoPath,
                stdout: 'pipe',
                stderr: 'pipe',
              })
              await proc.exited
            },
            catch: () =>
              new RpcError({
                message: `Failed to create worktrees directory: ${worktreeDir}`,
                code: 'FILESYSTEM_ERROR',
              }),
          })

          // Clean up stale worktree path if it exists on disk
          if (existsSync(worktreePath)) {
            yield* Effect.logWarning(
              `Worktree path already exists, cleaning up: ${worktreePath}`
            ).pipe(Effect.annotateLogs('module', logPrefix))

            yield* Effect.tryPromise({
              try: async () => {
                const proc = spawn(['rm', '-rf', worktreePath], {
                  stdout: 'pipe',
                  stderr: 'pipe',
                })
                await proc.exited
              },
              catch: () =>
                new RpcError({
                  message: `Failed to remove stale worktree directory: ${worktreePath}`,
                  code: 'FILESYSTEM_ERROR',
                }),
            }).pipe(Effect.catchAll(() => Effect.void))
          }

          // Prune stale git worktree references
          yield* Effect.tryPromise({
            try: async () => {
              const proc = spawn(['git', 'worktree', 'prune'], {
                cwd: repoPath,
                stdout: 'pipe',
                stderr: 'pipe',
              })
              await proc.exited
            },
            catch: () =>
              new RpcError({
                message: 'Failed to prune worktree references',
                code: 'GIT_WORKTREE_FAILED',
              }),
          }).pipe(Effect.catchAll(() => Effect.void))

          // Create the git worktree, reusing the branch if it exists.
          // If the user typed a branch that only exists on origin, create the
          // local workspace branch from that remote branch instead of dev/main.
          // New branches start from baseRef when provided (sub-workspaces
          // branch from the parent workspace's HEAD instead of the main
          // checkout's HEAD).
          const worktreeArgs = buildWorktreeAddArgs({
            baseRef: params.baseRef,
            branchExists,
            branchName,
            remoteBranchExists,
            remoteBranchRef,
            worktreePath,
          })

          const worktreeResult = yield* Effect.tryPromise({
            try: async () => {
              const proc = spawn(worktreeArgs, {
                cwd: repoPath,
                stdout: 'pipe',
                stderr: 'pipe',
              })
              const exitCode = await proc.exited
              const stderr = await new Response(proc.stderr).text()
              return { exitCode, stderr }
            },
            catch: (error) =>
              new RpcError({
                message: `Failed to spawn git worktree command: ${String(error)}`,
                code: 'GIT_WORKTREE_FAILED',
              }),
          })

          if (worktreeResult.exitCode !== 0) {
            return yield* new RpcError({
              message: `git worktree add failed (exit ${worktreeResult.exitCode}): ${worktreeResult.stderr.trim()}`,
              code: 'GIT_WORKTREE_FAILED',
            })
          }

          // Capture the base SHA. Sub-workspaces diff against the parent
          // workspace's HEAD (baseRef); ordinary workspaces against the main
          // checkout's HEAD.
          const baseSha = params.baseRef
            ? params.baseRef
            : yield* Effect.tryPromise({
                try: async () => {
                  const proc = spawn(['git', 'rev-parse', 'HEAD'], {
                    cwd: repoPath,
                    stdout: 'pipe',
                    stderr: 'pipe',
                  })
                  const exitCode = await proc.exited
                  const stdout = await new Response(proc.stdout).text()
                  return exitCode === 0 ? stdout.trim() : null
                },
                catch: () =>
                  new RpcError({
                    message: 'Failed to capture base SHA for worktree',
                    code: 'GIT_REV_PARSE_FAILED',
                  }),
              })

          // Signal UI: validating worktree
          store.commit(
            events.worktreeSetupStepChanged({
              workspaceId: id,
              step: 'validating-worktree',
            })
          )

          // Validate the worktree (Issue #34)
          const validation = yield* validateWorktree(worktreePath, branchName)

          const isValid =
            validation.directoryExists &&
            validation.isGitWorkTree &&
            validation.correctBranch &&
            validation.isolatedToplevel

          if (!isValid) {
            const errorMsg = buildValidationErrorMessage(
              validation,
              worktreePath,
              branchName
            )

            yield* Effect.logWarning(errorMsg).pipe(
              Effect.annotateLogs('module', logPrefix)
            )

            return yield* new RpcError({
              message: errorMsg,
              code: 'WORKTREE_VERIFY_FAILED',
            })
          }

          yield* Effect.logDebug(
            `Worktree validated: directory exists, git work tree, branch=${branchName}, toplevel=${worktreePath}`
          ).pipe(Effect.annotateLogs('module', logPrefix))

          return baseSha
        })

      /**
       * Run background sandbox setup by delegating to the configured
       * SandboxProvider. The provider handles all provider-specific steps
       * (e.g. Docker: deps image build + container creation; Daytona:
       * sandbox creation + code push).
       *
       * Communicates progress via sandboxSetupStepChanged events emitted
       * by the provider implementation.
       */
      /**
       * Get the remote origin URL for a repo path.
       * Returns null if the remote cannot be resolved.
       */
      const getRepoRemoteUrl = (
        repoPath: string
      ): Effect.Effect<string | null> =>
        Effect.tryPromise({
          try: async () => {
            const proc = spawn(['git', 'remote', 'get-url', 'origin'], {
              cwd: repoPath,
              stdout: 'pipe',
              stderr: 'pipe',
            })
            const exitCode = await proc.exited
            const stdout = await new Response(proc.stdout).text()
            return exitCode === 0 ? stdout.trim() : null
          },
          catch: () => null,
        }).pipe(Effect.catchAll(() => Effect.succeed(null)))

      /**
       * Get the current branch name for a repo path.
       * Returns null if the branch cannot be resolved (e.g. detached HEAD).
       */
      const getCurrentBranch = (
        repoPath: string
      ): Effect.Effect<string | null> =>
        Effect.tryPromise({
          try: async () => {
            const proc = spawn(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], {
              cwd: repoPath,
              stdout: 'pipe',
              stderr: 'pipe',
            })
            const exitCode = await proc.exited
            const stdout = await new Response(proc.stdout).text()
            const branch = exitCode === 0 ? stdout.trim() : null
            // rev-parse returns "HEAD" for detached HEAD state
            return branch === 'HEAD' ? null : branch
          },
          catch: () => null,
        }).pipe(Effect.catchAll(() => Effect.succeed(null)))

      const performSandboxSetup = (params: {
        readonly id: string
        readonly branchName: string
        readonly worktreePath: string
        readonly projectName: string
        readonly repoUrl: string | null
        readonly currentBranch: string | null
        readonly devServer: {
          readonly autoOpen: { readonly value: boolean }
          readonly autoStopInterval: { readonly value: number | null }
          readonly dockerfile: { readonly value: string | null }
          readonly image: { readonly value: string | null }
          readonly installCommand: { readonly value: string | null }
          readonly network: { readonly value: string | null }
          readonly port: { readonly value: number | null }
          readonly provider: {
            readonly value: 'docker' | 'daytona' | 'none' | null
          }
          readonly resources: {
            readonly value: {
              readonly cpu?: number | undefined
              readonly disk?: number | undefined
              readonly memory?: number | undefined
            } | null
          }
          readonly setupScripts: { readonly value: readonly string[] }
          readonly startCommand: { readonly value: string | null }
          readonly workdir: { readonly value: string }
        }
        readonly onReady?:
          | ((workspaceId: string) => Effect.Effect<void, RpcError>)
          | undefined
      }): Effect.Effect<void, RpcError> =>
        sandboxProvider.createSandbox({
          workspaceId: params.id,
          worktreePath: params.worktreePath,
          branchName: params.branchName,
          projectName: params.projectName,
          repoUrl: params.repoUrl,
          currentBranch: params.currentBranch,
          devServerConfig: {
            autoOpen: params.devServer.autoOpen.value,
            autoStopInterval: params.devServer.autoStopInterval.value,
            dockerfile: params.devServer.dockerfile.value,
            image: params.devServer.image.value,
            installCommand: params.devServer.installCommand.value,
            network: params.devServer.network.value,
            port: params.devServer.port.value,
            provider: params.devServer.provider.value,
            resources: params.devServer.resources.value,
            setupScripts: params.devServer.setupScripts.value,
            startCommand: params.devServer.startCommand.value,
            workdir: params.devServer.workdir.value,
          },
          onReady: params.onReady,
        })

      const runPostWorktreeSetup = (params: {
        readonly id: string
        readonly branchName: string
        readonly setupScripts: readonly string[]
        readonly worktreePath: string
      }): Effect.Effect<void, RpcError> =>
        Effect.gen(function* () {
          const scriptEnv = {
            LABORER_WORKSPACE_ID: params.id,
            LABORER_WORKSPACE_PATH: params.worktreePath,
            LABORER_BRANCH: params.branchName,
          }

          if (params.setupScripts.length > 0) {
            store.commit(
              events.worktreeSetupStepChanged({
                workspaceId: params.id,
                step: 'running-setup-scripts',
              })
            )
          }

          const setupResult = yield* runProjectSetupScripts(
            params.setupScripts,
            params.worktreePath,
            scriptEnv
          )

          if (setupResult._tag === 'Failure') {
            return yield* new RpcError({
              message: buildSetupFailureMessage(setupResult),
              code: 'SETUP_SCRIPT_FAILED',
            })
          }

          store.commit(
            events.worktreeSetupStepChanged({
              workspaceId: params.id,
              step: null,
            })
          )
        })

      /**
       * Best-effort push of a workspace branch so it exists on the remote
       * before a sub-workspace PR targets it. Failures (offline, no remote,
       * auth) are logged and never block creation — the local git
       * relationship is valid regardless, and the PR diff self-heals on the
       * parent's next push.
       */
      const pushBranchBestEffort = (worktreePath: string, branchName: string) =>
        Effect.tryPromise({
          try: async () => {
            const proc = spawn(['git', 'push', '-u', 'origin', branchName], {
              cwd: worktreePath,
              stdout: 'pipe',
              stderr: 'pipe',
            })
            const exitCode = await proc.exited
            const stderr = await new Response(proc.stderr).text()
            return { exitCode, stderr }
          },
          catch: (error) =>
            new RpcError({
              message: `Failed to spawn git push: ${String(error)}`,
              code: 'GIT_PUSH_FAILED',
            }),
        }).pipe(
          Effect.flatMap(({ exitCode, stderr }) =>
            exitCode === 0
              ? Effect.logDebug(`Pushed base branch ${branchName}`)
              : Effect.logWarning(
                  `Best-effort push of base branch ${branchName} failed (exit ${exitCode}): ${stderr.trim()}`
                )
          ),
          Effect.catchAll((error) =>
            Effect.logWarning(
              `Best-effort push of base branch ${branchName} failed: ${error.message}`
            )
          ),
          Effect.annotateLogs('module', logPrefix)
        )

      /** Resolve the current HEAD SHA of a worktree. */
      const resolveWorktreeHead = (worktreePath: string) =>
        Effect.tryPromise({
          try: async () => {
            const proc = spawn(['git', 'rev-parse', 'HEAD'], {
              cwd: worktreePath,
              stdout: 'pipe',
              stderr: 'pipe',
            })
            const exitCode = await proc.exited
            const stdout = await new Response(proc.stdout).text()
            if (exitCode !== 0) {
              throw new Error(`git rev-parse HEAD exited with ${exitCode}`)
            }
            return stdout.trim()
          },
          catch: (error) =>
            new RpcError({
              message: `Failed to resolve base workspace HEAD at ${worktreePath}: ${String(error)}`,
              code: 'GIT_REV_PARSE_FAILED',
            }),
        })

      /**
       * Prepare the base commit for a sub-workspace: push the base
       * workspace's branch (best-effort, so the PR base exists on the
       * remote) and resolve its current HEAD — the commit the new
       * sub-workspace branches from.
       */
      const prepareSubWorkspaceBase = (base: {
        readonly worktreePath: string
        readonly branchName: string
      }): Effect.Effect<string, RpcError> =>
        pushBranchBestEffort(base.worktreePath, base.branchName).pipe(
          Effect.andThen(resolveWorktreeHead(base.worktreePath))
        )

      const createWorktree = Effect.fn('WorkspaceProvider.createWorktree')(
        function* (
          projectId: string,
          branchName?: string,
          onReady?: (workspaceId: string) => Effect.Effect<void, RpcError>,
          baseWorkspaceId?: string
        ) {
          // 1. Validate the project exists and get its repo path
          const project = yield* registry.getProject(projectId)

          // 1a. Resolve the base workspace when creating a sub-workspace.
          // The sub-workspace branches from this workspace's HEAD and its
          // PR targets this workspace's branch (see
          // docs/adr/0001-branch-keyed-workspace-lineage.md).
          const baseWorkspace = baseWorkspaceId
            ? store
                .query(tables.workspaces)
                .find((w) => w.id === baseWorkspaceId)
            : undefined
          if (baseWorkspaceId !== undefined) {
            if (baseWorkspace === undefined) {
              return yield* new RpcError({
                message: `Base workspace not found: ${baseWorkspaceId}`,
                code: 'NOT_FOUND',
              })
            }
            if (baseWorkspace.projectId !== projectId) {
              return yield* new RpcError({
                message: `Base workspace ${baseWorkspaceId} belongs to a different project`,
                code: 'BASE_WORKSPACE_INVALID',
              })
            }
            if (baseWorkspace.worktreePath === '') {
              return yield* new RpcError({
                message: `Base workspace ${baseWorkspaceId} has no local worktree to branch from`,
                code: 'BASE_WORKSPACE_INVALID',
              })
            }
          }

          // 1b. Resolve config for worktree location + setup scripts
          const resolvedConfig = yield* configService
            .resolveConfig(project.repoPath, project.name)
            .pipe(
              Effect.mapError(
                (e) =>
                  new RpcError({
                    message: e.message,
                    code: 'CONFIG_VALIDATION_ERROR',
                  })
              )
            )

          // 2. Generate or validate branch name
          const resolvedBranch =
            branchName ?? `laborer/${crypto.randomUUID().slice(0, 8)}`

          // Determine the effective provider for this workspace
          const effectiveProvider = resolvedConfig.devServer.provider.value

          // 3. Compute worktree path from resolved config.
          // For Daytona, there is no local worktree — code lives in the
          // cloud sandbox. Use empty string as a placeholder.
          const isDaytona = effectiveProvider === 'daytona'
          const shouldStartSandbox =
            effectiveProvider !== 'none' &&
            resolvedConfig.devServer.image.value !== null
          const worktreeDir = resolvedConfig.worktreeDir.value
          const worktreePath = isDaytona
            ? ''
            : join(worktreeDir, slugify(resolvedBranch))

          // 4. Generate workspace ID and commit to LiveStore immediately
          // with status 'creating'. The UI sees the workspace right away
          // in the card list; heavy setup runs as a background fiber.
          const id = crypto.randomUUID()
          const createdAt = new Date().toISOString()

          const workspace: WorkspaceRecord = {
            id,
            projectId,
            taskSource: null,
            branchName: resolvedBranch,
            worktreePath,
            status: 'creating',
            origin: 'laborer',
            createdAt,
            baseSha: null,
            baseBranch: baseWorkspace?.branchName ?? null,
          }

          store.commit(
            events.workspaceCreated({
              id: workspace.id,
              projectId: workspace.projectId,
              taskSource: workspace.taskSource,
              branchName: workspace.branchName,
              worktreePath: workspace.worktreePath,
              status: workspace.status,
              origin: workspace.origin,
              createdAt: workspace.createdAt,
              baseSha: workspace.baseSha,
              sandboxProvider: effectiveProvider,
              baseBranch: workspace.baseBranch,
            })
          )

          // ── Local worktree path (Docker / no sandbox) ──────────
          const localWorktreeSetup = Effect.gen(function* () {
            // Phase 0: Wait for any in-flight destroy cleanup targeting the
            // same worktree path. This blocks on the actual background fiber
            // instead of polling with a timeout.
            const inFlightDestroy = (yield* Ref.get(destroyFibers)).get(
              worktreePath
            )
            if (inFlightDestroy !== undefined) {
              yield* Effect.logInfo(
                `Waiting for in-flight destroy cleanup at ${worktreePath} before creating workspace ${id}`
              ).pipe(Effect.annotateLogs('module', logPrefix))
              yield* Fiber.join(inFlightDestroy)
              yield* Effect.logInfo(
                `In-flight destroy cleanup finished for ${worktreePath}; resuming workspace ${id} creation`
              ).pipe(Effect.annotateLogs('module', logPrefix))
            }

            // Phase 0b: Sub-workspaces branch from the base workspace's
            // HEAD. Push its branch first (best-effort) so the PR base
            // exists on the remote, then resolve the HEAD to branch from.
            const baseRef = baseWorkspace
              ? yield* prepareSubWorkspaceBase(baseWorkspace)
              : undefined

            // Phase 1: Create and validate worktree. This is the first
            // checkpoint: once it succeeds, agents can open in the
            // workspace directory even if later setup is still running.
            const baseSha = yield* performWorktreeSetup({
              id,
              branchName: resolvedBranch,
              repoPath: project.repoPath,
              worktreeDir,
              worktreePath,
              baseRef,
            })

            // Update baseSha now that we have it
            if (baseSha !== null) {
              store.commit(events.workspaceBaseShaUpdated({ id, baseSha }))
            }

            // Worktree setup complete — transition to 'running'.
            // Clear worktreeSetupStep via the WorkspaceStatusChanged materializer.
            store.commit(
              events.workspaceStatusChanged({ id, status: 'running' })
            )

            // Run the onReady callback (e.g. start diff/PR polling,
            // open agent panels) as soon as the worktree directory is ready.
            if (onReady) {
              yield* onReady(id).pipe(
                Effect.catchAll((err) =>
                  Effect.logWarning(
                    `onReady callback failed for workspace ${id}: ${err.message}`
                  ).pipe(Effect.annotateLogs('module', logPrefix))
                )
              )
            }

            // Phase 1b: Run project setup scripts after the worktree-ready
            // checkpoint. The UI can show progress while agents are already
            // available in the worktree directory.
            yield* runPostWorktreeSetup({
              id,
              branchName: resolvedBranch,
              setupScripts: resolvedConfig.setupScripts.value,
              worktreePath,
            })

            // Phase 2: Start sandbox if devServer config has an image
            if (shouldStartSandbox) {
              yield* performSandboxSetup({
                id,
                branchName: resolvedBranch,
                worktreePath,
                projectName: project.name,
                repoUrl: null,
                currentBranch: null,
                devServer: resolvedConfig.devServer,
              })
            }
          })

          // 5. Fork the heavy setup work into a background fiber.
          // For Docker: worktree creation, setup scripts, then container setup.
          // For Daytona: skip worktree entirely, go straight to sandbox creation
          //   (sandbox clones code from remote and creates branch internally).
          // Progress is communicated via worktreeSetupStepChanged / sandboxSetupStepChanged events.
          const worktreeSetupEffect = Effect.gen(function* () {
            if (isDaytona) {
              // ── Daytona path ──────────────────────────────────────
              // No local worktree needed. The Daytona sandbox clones
              // the repo from the remote and creates the workspace
              // branch inside the sandbox. This is much faster than
              // creating a local worktree + pushing code via SSH.

              // Resolve the remote origin URL and current branch so
              // the Daytona provider can clone the repo in the sandbox.
              const repoUrl = yield* getRepoRemoteUrl(project.repoPath)
              const currentBranch = yield* getCurrentBranch(project.repoPath)

              yield* performSandboxSetup({
                id,
                branchName: resolvedBranch,
                worktreePath,
                projectName: project.name,
                repoUrl,
                currentBranch,
                devServer: resolvedConfig.devServer,
                onReady,
              })

              // Daytona workspaces have no local worktree. Keep them in
              // 'creating' until the provider has committed sandbox metadata
              // so terminal auto-open routes to the sandbox instead of the host.
              store.commit(
                events.workspaceStatusChanged({ id, status: 'running' })
              )
            } else {
              yield* localWorktreeSetup
            }
          }).pipe(
            // Use catchAllCause instead of catchAll so that both expected
            // errors (RpcError) and unexpected defects (thrown exceptions,
            // e.g. realpathSync failure) are caught. With plain catchAll,
            // a defect would kill the background fiber silently and leave
            // the workspace permanently stuck in 'creating' status.
            Effect.catchAllCause((cause) =>
              Effect.gen(function* () {
                const prettyMessage = Cause.pretty(cause)
                yield* Effect.logWarning(
                  `Background worktree setup failed for workspace ${id}: ${prettyMessage}`
                ).pipe(Effect.annotateLogs('module', logPrefix))

                // Clear worktree setup step
                store.commit(
                  events.worktreeSetupStepChanged({
                    workspaceId: id,
                    step: null,
                  })
                )

                // Clear sandbox setup step in case it was set
                store.commit(
                  events.sandboxSetupStepChanged({
                    workspaceId: id,
                    step: null,
                  })
                )

                // Extract a user-facing error message from the cause.
                // For expected failures (RpcError), use the error message.
                // For defects (thrown exceptions), use the pretty-printed cause.
                const failureOption = Cause.failureOption(cause)
                const errorMessage =
                  failureOption._tag === 'Some'
                    ? String(failureOption.value)
                    : prettyMessage

                // Set workspace to errored status so the user can decide
                // whether to retry or destroy it. Never auto-destroy — the
                // worktree may contain uncommitted work.
                store.commit(
                  events.workspaceStatusChanged({
                    id,
                    status: 'errored',
                    errorMessage,
                  })
                )
              })
            )
          )

          const fiber = yield* worktreeSetupEffect.pipe(Effect.forkIn(scope))

          // Track the fiber so destroyWorktree can interrupt it
          yield* Ref.update(setupFibers, (m) => {
            const next = new Map(m)
            next.set(id, fiber)
            return next
          })

          // Remove tracking when the fiber completes
          fiber.addObserver(() => {
            Ref.update(setupFibers, (m) => {
              const n = new Map(m)
              n.delete(id)
              return n
            }).pipe(Effect.runSync)
          })

          return workspace
        }
      )

      const destroyWorktree = Effect.fn('WorkspaceProvider.destroyWorktree')(
        function* (workspaceId: string, force?: boolean) {
          yield* Effect.logInfo(
            `destroyWorktree called: workspaceId=${workspaceId}, force=${String(force ?? false)}`
          ).pipe(Effect.annotateLogs('module', logPrefix))

          // 1. Look up the workspace in LiveStore
          const allWorkspaces = store.query(tables.workspaces)
          const workspaceOpt = pipe(
            allWorkspaces,
            Arr.findFirst((w) => w.id === workspaceId)
          )

          if (workspaceOpt._tag === 'None') {
            // A previous destroy already removed the workspace row.
            // Return success without emitting another WorkspaceDestroyed event,
            // otherwise duplicate destroys can replay the same delete into
            // sync clients and destabilize downstream subscriptions.
            yield* Effect.logInfo(
              `Workspace ${workspaceId} already removed from LiveStore — skipping duplicate destroy`
            ).pipe(Effect.annotateLogs('module', logPrefix))
            return
          }

          const workspace = workspaceOpt.value

          const inFlightDestroy = (yield* Ref.get(destroyFibers)).get(
            workspace.worktreePath
          )
          if (inFlightDestroy !== undefined) {
            yield* Effect.logInfo(
              `Destroy already in progress for workspace ${workspaceId} at ${workspace.worktreePath} — skipping duplicate destroy`
            ).pipe(Effect.annotateLogs('module', logPrefix))
            return
          }

          // Interrupt any in-flight background container setup fiber for
          // this workspace and wait for it to fully stop. This prevents
          // races where the setup fiber is still running docker commands
          // (e.g. docker run with a bind mount to the worktree) while we
          // tear down the worktree directory.
          const fibers = yield* Ref.get(setupFibers)
          const setupFiber = fibers.get(workspaceId)
          if (setupFiber !== undefined) {
            yield* Effect.logInfo(
              `Interrupting background container setup for workspace ${workspaceId}`
            ).pipe(Effect.annotateLogs('module', logPrefix))
            yield* Fiber.interrupt(setupFiber).pipe(Effect.asVoid)
            yield* Ref.update(setupFibers, (m) => {
              const next = new Map(m)
              next.delete(workspaceId)
              return next
            })
          }

          yield* Effect.logInfo(
            `Destroying workspace: branch=${workspace.branchName}, path=${workspace.worktreePath}, origin=${workspace.origin}, status=${workspace.status}`
          ).pipe(Effect.annotateLogs('module', logPrefix))

          // 2. Look up the project to get the repo path for git commands
          const project = yield* registry.getProject(workspace.projectId)

          yield* Effect.logInfo(
            `Project resolved: repoPath=${project.repoPath}`
          ).pipe(Effect.annotateLogs('module', logPrefix))

          // 2b. Check for uncommitted changes in the worktree before destroying.
          //     If the worktree has dirty state and force is not set, return an
          //     error so the client can warn the user and offer a force option.
          if (!force) {
            yield* Effect.logInfo(
              'Checking worktree for uncommitted changes...'
            ).pipe(Effect.annotateLogs('module', logPrefix))

            const dirtyFiles = yield* Effect.tryPromise({
              try: async () => {
                // Use spawnGit with readOnly to set GIT_OPTIONAL_LOCKS=0,
                // preventing lock contention with concurrent git operations.
                // Also reads stdout concurrently with exit to avoid pipe
                // buffer deadlocks, and enforces a 15s timeout.
                const { exitCode, stdout } = await spawnGit(
                  ['status', '--porcelain'],
                  {
                    cwd: workspace.worktreePath,
                    readOnly: true,
                    timeoutMs: 15_000,
                  }
                )
                if (exitCode !== 0 || stdout.trim().length === 0) {
                  return [] as string[]
                }
                // Parse porcelain output: each line is "XY filename"
                // Extract just the file paths (skip the 3-char status prefix)
                return stdout
                  .trim()
                  .split('\n')
                  .map((line) => line.slice(3))
              },
              catch: () =>
                new RpcError({
                  message: 'Failed to check worktree status',
                  code: 'GIT_CHECK_FAILED',
                }),
            }).pipe(
              // If we can't check (e.g. directory already gone), skip the check
              Effect.catchAll((err) =>
                Effect.logWarning(
                  `Dirty check failed (skipping): ${String(err)}`
                ).pipe(
                  Effect.annotateLogs('module', logPrefix),
                  Effect.map(() => [] as string[])
                )
              )
            )

            yield* Effect.logInfo(
              `Dirty check result: ${dirtyFiles.length} changed file(s)`
            ).pipe(Effect.annotateLogs('module', logPrefix))

            if (dirtyFiles.length > 0) {
              const fileList = dirtyFiles.join('\n')
              return yield* new RpcError({
                message: `Workspace "${workspace.branchName}" has uncommitted changes:\n${fileList}`,
                code: 'DIRTY_WORKTREE',
              })
            }
          }

          // 3. Update workspace status to "destroyed" in LiveStore first
          //    (so the UI reflects the state change even if cleanup takes time)
          yield* Effect.logInfo(
            'Setting workspace status to destroyed in LiveStore'
          ).pipe(Effect.annotateLogs('module', logPrefix))

          store.commit(
            events.workspaceStatusChanged({
              id: workspaceId,
              status: 'destroyed',
            })
          )

          // 3b. Fork slow cleanup (container destroy, git worktree remove,
          //     branch delete) into a background daemon fiber so
          //     the RPC response returns immediately. The UI already reflects
          //     the "destroyed" status via the LiveStore event above.
          yield* Effect.logInfo('Forking background cleanup fiber').pipe(
            Effect.annotateLogs('module', logPrefix)
          )

          const backgroundCleanup = Effect.gen(function* () {
            // Destroy sandbox if one exists.
            // Sandbox destruction happens before worktree removal so
            // the sandbox is stopped before its bind-mounted directory
            // (Docker) or linked code (Daytona) is deleted.
            // Best-effort: logs warnings but continues cleanup.
            if (workspace.sandboxProvider !== 'none') {
              yield* sandboxProvider
                .destroySandbox(workspaceId)
                .pipe(
                  Effect.catchAll((error) =>
                    Effect.logWarning(
                      `Sandbox destroy failed for workspace "${workspaceId}": ${String(error)}`
                    ).pipe(Effect.annotateLogs('module', logPrefix))
                  )
                )
            }

            // 4. Remove the git worktree and branch.
            //    Both laborer-managed and external workspaces have their
            //    worktree removed from disk. Without this, external workspaces
            //    would be immediately re-detected by the reconciler and
            //    reappear in the UI after destruction.
            yield* Effect.logInfo(
              `Running: git worktree remove --force ${workspace.worktreePath} (cwd: ${project.repoPath})`
            ).pipe(Effect.annotateLogs('module', logPrefix))

            const removeResult = yield* Effect.tryPromise({
              try: async () => {
                const proc = spawn(
                  [
                    'git',
                    'worktree',
                    'remove',
                    '--force',
                    workspace.worktreePath,
                  ],
                  {
                    cwd: project.repoPath,
                    stdout: 'pipe',
                    stderr: 'pipe',
                  }
                )
                const exitCode = await proc.exited
                const stdout = await new Response(proc.stdout).text()
                const stderr = await new Response(proc.stderr).text()
                return { exitCode, stdout, stderr }
              },
              catch: (error) =>
                new RpcError({
                  message: `Failed to spawn git worktree remove: ${String(error)}`,
                  code: 'GIT_WORKTREE_FAILED',
                }),
            })

            yield* Effect.logInfo(
              `git worktree remove result: exitCode=${removeResult.exitCode}, stdout="${removeResult.stdout.trim()}", stderr="${removeResult.stderr.trim()}"`
            ).pipe(Effect.annotateLogs('module', logPrefix))

            if (removeResult.exitCode !== 0) {
              yield* Effect.logWarning(
                'git worktree remove failed, running fallback cleanup...'
              ).pipe(Effect.annotateLogs('module', logPrefix))

              // Fallback: manually remove the worktree directory and prune
              // stale worktree references. git worktree remove can fail when
              // the worktree has modifications even with --force in some git
              // versions, or when the worktree metadata is inconsistent.
              yield* Effect.logInfo(
                `Running: rm -rf ${workspace.worktreePath}`
              ).pipe(Effect.annotateLogs('module', logPrefix))

              yield* Effect.tryPromise({
                try: async () => {
                  const proc = spawn(['rm', '-rf', workspace.worktreePath], {
                    cwd: project.repoPath,
                    stdout: 'pipe',
                    stderr: 'pipe',
                  })
                  const exitCode = await proc.exited
                  return exitCode
                },
                catch: (err) =>
                  new RpcError({
                    message: `Failed to remove worktree directory: ${workspace.worktreePath}: ${String(err)}`,
                    code: 'FILESYSTEM_ERROR',
                  }),
              }).pipe(
                Effect.tap((exitCode) =>
                  Effect.logInfo(`rm -rf result: exitCode=${exitCode}`).pipe(
                    Effect.annotateLogs('module', logPrefix)
                  )
                ),
                Effect.catchAll((err) =>
                  Effect.logWarning(
                    `Fallback rm -rf failed: ${String(err)}`
                  ).pipe(Effect.annotateLogs('module', logPrefix))
                )
              )

              yield* Effect.logInfo(
                `Running: git worktree prune (cwd: ${project.repoPath})`
              ).pipe(Effect.annotateLogs('module', logPrefix))

              yield* Effect.tryPromise({
                try: async () => {
                  const proc = spawn(['git', 'worktree', 'prune'], {
                    cwd: project.repoPath,
                    stdout: 'pipe',
                    stderr: 'pipe',
                  })
                  const exitCode = await proc.exited
                  return exitCode
                },
                catch: (err) =>
                  new RpcError({
                    message: `Failed to prune stale worktree references: ${String(err)}`,
                    code: 'GIT_WORKTREE_FAILED',
                  }),
              }).pipe(
                Effect.tap((exitCode) =>
                  Effect.logInfo(
                    `git worktree prune result: exitCode=${exitCode}`
                  ).pipe(Effect.annotateLogs('module', logPrefix))
                ),
                Effect.catchAll((err) =>
                  Effect.logWarning(
                    `Fallback git worktree prune failed: ${String(err)}`
                  ).pipe(Effect.annotateLogs('module', logPrefix))
                )
              )
            }

            // Prune stale worktree references after removal
            yield* Effect.tryPromise({
              try: async () => {
                const proc = spawn(['git', 'worktree', 'prune'], {
                  cwd: project.repoPath,
                  stdout: 'pipe',
                  stderr: 'pipe',
                })
                await proc.exited
              },
              catch: (err) =>
                new RpcError({
                  message: `Failed to prune worktree references: ${String(err)}`,
                  code: 'GIT_WORKTREE_FAILED',
                }),
            }).pipe(Effect.catchAll(() => Effect.void))

            // Delete the branch
            yield* Effect.tryPromise({
              try: async () => {
                const proc = spawn(
                  ['git', 'branch', '-D', workspace.branchName],
                  {
                    cwd: project.repoPath,
                    stdout: 'pipe',
                    stderr: 'pipe',
                  }
                )
                const exitCode = await proc.exited
                const stderr = await new Response(proc.stderr).text()
                return { exitCode, stderr }
              },
              catch: (err) =>
                new RpcError({
                  message: `Failed to delete branch ${workspace.branchName}: ${String(err)}`,
                  code: 'GIT_BRANCH_DELETE_FAILED',
                }),
            }).pipe(
              Effect.tap(({ exitCode, stderr }) =>
                exitCode !== 0
                  ? Effect.logWarning(
                      `git branch -D failed (exit ${exitCode}): ${stderr.trim()}`
                    ).pipe(Effect.annotateLogs('module', logPrefix))
                  : Effect.logDebug(
                      `Deleted branch ${workspace.branchName}`
                    ).pipe(Effect.annotateLogs('module', logPrefix))
              ),
              Effect.catchAll((err) =>
                Effect.logWarning(
                  `Failed to delete branch: ${String(err)}`
                ).pipe(Effect.annotateLogs('module', logPrefix))
              )
            )

            // Check if directory still exists after cleanup
            const dirStillExists = existsSync(workspace.worktreePath)
            yield* Effect.logInfo(
              `Post-cleanup: directory ${workspace.worktreePath} exists=${String(dirStillExists)}`
            ).pipe(Effect.annotateLogs('module', logPrefix))

            // 5. Commit WorkspaceDestroyed event to LiveStore
            //    This removes the row from the workspaces table
            yield* Effect.logInfo(
              `Committing WorkspaceDestroyed event for ${workspaceId}`
            ).pipe(Effect.annotateLogs('module', logPrefix))

            store.commit(events.workspaceDestroyed({ id: workspaceId }))

            yield* Effect.logInfo(
              `Workspace ${workspaceId} (${workspace.branchName}) destroyed successfully`
            ).pipe(Effect.annotateLogs('module', logPrefix))
          }).pipe(
            Effect.catchAll((error) =>
              Effect.logError(
                `Background cleanup failed for workspace ${workspaceId}: ${String(error)}`
              ).pipe(Effect.annotateLogs('module', logPrefix))
            )
          )

          const cleanupFiber = yield* Effect.forkDaemon(backgroundCleanup)

          yield* Ref.update(destroyFibers, (m) => {
            const next = new Map(m)
            next.set(workspace.worktreePath, cleanupFiber)
            return next
          })

          cleanupFiber.addObserver(() => {
            Ref.update(destroyFibers, (m) => {
              const next = new Map(m)
              const current = next.get(workspace.worktreePath)
              if (current === cleanupFiber) {
                next.delete(workspace.worktreePath)
              }
              return next
            }).pipe(Effect.runSync)
          })
        }
      )

      const startSandbox = Effect.fn('WorkspaceProvider.startSandbox')(
        function* (
          workspaceId: string,
          onReady?: (workspaceId: string) => Effect.Effect<void, RpcError>
        ) {
          // 1. Look up the workspace in LiveStore
          const allWorkspaces = store.query(tables.workspaces)
          const workspaceOpt = pipe(
            allWorkspaces,
            Arr.findFirst((w) => w.id === workspaceId)
          )

          if (workspaceOpt._tag === 'None') {
            return yield* new RpcError({
              message: `Workspace not found: ${workspaceId}`,
              code: 'NOT_FOUND',
            })
          }

          const workspace = workspaceOpt.value

          // 2. Reject if workspace already has a sandbox
          if (workspace.sandboxId != null) {
            return yield* new RpcError({
              message: `Workspace ${workspaceId} already has a sandbox`,
              code: 'ALREADY_CONTAINERIZED',
            })
          }

          // 3. Look up the project and resolve config
          const project = yield* registry.getProject(workspace.projectId)
          const resolvedConfig = yield* configService
            .resolveConfig(project.repoPath, project.name)
            .pipe(
              Effect.mapError(
                (e) =>
                  new RpcError({
                    message: e.message,
                    code: 'CONFIG_VALIDATION_ERROR',
                  })
              )
            )

          // Docker requires an explicit image; Daytona uses a default image
          // when none is configured. Only gate on missing image for Docker.
          const devServerImage = resolvedConfig.devServer.image.value
          const effectiveProvider = resolvedConfig.devServer.provider.value
          if (effectiveProvider === 'none') {
            return yield* new RpcError({
              message: 'This workspace is configured with no sandbox provider',
              code: 'NO_SANDBOX_CONFIGURED',
            })
          }
          if (devServerImage === null && effectiveProvider !== 'daytona') {
            return yield* new RpcError({
              message:
                'No devServer.image configured in laborer.json — cannot start sandbox',
              code: 'NO_DEV_SERVER_IMAGE',
            })
          }

          yield* Effect.logInfo(
            `Starting sandbox for workspace: id=${workspaceId}, branch=${workspace.branchName}, path=${workspace.worktreePath}`
          ).pipe(Effect.annotateLogs('module', logPrefix))

          // 4. Transition workspace: update origin to 'laborer' and status
          //    to 'running'
          if (workspace.origin === 'external') {
            store.commit(
              events.workspaceOriginChanged({
                id: workspaceId,
                origin: 'laborer',
              })
            )
          }
          if (workspace.status !== 'running') {
            store.commit(
              events.workspaceStatusChanged({
                id: workspaceId,
                status: 'running',
              })
            )
          }

          // 5. Resolve repo info for Daytona provider
          const repoUrl =
            effectiveProvider === 'daytona'
              ? yield* getRepoRemoteUrl(project.repoPath)
              : null
          const currentBranch =
            effectiveProvider === 'daytona'
              ? yield* getCurrentBranch(project.repoPath)
              : null

          // 6. Fork sandbox setup as a background fiber (same pattern
          //    as createWorktree)
          const sandboxSetupEffect = performSandboxSetup({
            id: workspaceId,
            branchName: workspace.branchName,
            worktreePath: workspace.worktreePath,
            projectName: project.name,
            repoUrl,
            currentBranch,
            devServer: resolvedConfig.devServer,
            onReady,
          }).pipe(
            Effect.catchAll((err) =>
              Effect.gen(function* () {
                yield* Effect.logWarning(
                  `Sandbox setup failed for workspace ${workspaceId}: ${String(err)}`
                ).pipe(Effect.annotateLogs('module', logPrefix))

                // Clear sandbox setup step
                store.commit(
                  events.sandboxSetupStepChanged({
                    workspaceId,
                    step: null,
                  })
                )

                // Set workspace to errored status so the user can decide
                // whether to retry or destroy it.
                store.commit(
                  events.workspaceStatusChanged({
                    id: workspaceId,
                    status: 'errored',
                    errorMessage: String(err),
                  })
                )
              })
            )
          )

          const fiber = yield* sandboxSetupEffect.pipe(Effect.forkIn(scope))

          // Track the fiber so destroyWorktree can interrupt it
          yield* Ref.update(setupFibers, (m) => {
            const next = new Map(m)
            next.set(workspaceId, fiber)
            return next
          })

          // Remove tracking when the fiber completes
          fiber.addObserver(() => {
            Ref.update(setupFibers, (m) => {
              const n = new Map(m)
              n.delete(workspaceId)
              return n
            }).pipe(Effect.runSync)
          })
        }
      )

      const checkDirtyFiles = Effect.fn('WorkspaceProvider.checkDirtyFiles')(
        function* (workspaceId: string) {
          const allWorkspaces = store.query(tables.workspaces)
          const workspaceOpt = pipe(
            allWorkspaces,
            Arr.findFirst((w) => w.id === workspaceId)
          )

          if (workspaceOpt._tag === 'None') {
            return yield* new RpcError({
              message: `Workspace not found: ${workspaceId}`,
              code: 'NOT_FOUND',
            })
          }

          const workspace = workspaceOpt.value

          yield* Effect.logInfo(
            `Checking worktree for uncommitted changes: workspace=${workspaceId}, path=${workspace.worktreePath}`
          ).pipe(Effect.annotateLogs('module', logPrefix))

          const dirtyFiles = yield* Effect.tryPromise({
            try: async () => {
              // Use spawnGit with readOnly to set GIT_OPTIONAL_LOCKS=0,
              // preventing lock contention with concurrent git operations.
              // Also reads stdout concurrently with exit to avoid pipe
              // buffer deadlocks, and enforces a 15s timeout.
              const { exitCode, stdout } = await spawnGit(
                ['status', '--porcelain'],
                {
                  cwd: workspace.worktreePath,
                  readOnly: true,
                  timeoutMs: 15_000,
                }
              )
              if (exitCode !== 0 || stdout.trim().length === 0) {
                return [] as string[]
              }
              return stdout
                .trim()
                .split('\n')
                .map((line) => line.slice(3))
            },
            catch: () =>
              new RpcError({
                message: 'Failed to check worktree status',
                code: 'GIT_CHECK_FAILED',
              }),
          }).pipe(
            Effect.catchAll((err) =>
              Effect.logWarning(
                `Dirty check failed (skipping): ${String(err)}`
              ).pipe(
                Effect.annotateLogs('module', logPrefix),
                Effect.map(() => [] as string[])
              )
            )
          )

          yield* Effect.logInfo(
            `Dirty check result: ${dirtyFiles.length} changed file(s)`
          ).pipe(Effect.annotateLogs('module', logPrefix))

          return dirtyFiles as readonly string[]
        }
      )

      const getWorkspaceEnv = Effect.fn('WorkspaceProvider.getWorkspaceEnv')(
        function* (workspaceId: string) {
          // Look up the workspace from LiveStore
          const allWorkspaces = store.query(tables.workspaces)
          const workspace = pipe(
            allWorkspaces,
            Arr.findFirst((w) => w.id === workspaceId)
          )

          if (workspace._tag === 'None') {
            return yield* new RpcError({
              message: `Workspace not found: ${workspaceId}`,
              code: 'NOT_FOUND',
            })
          }

          const ws = workspace.value

          // Build the environment variables for this workspace.
          // Includes file watcher scoping vars that constrain common tools
          // (Watchman, chokidar, TypeScript) to watch only the worktree
          // directory, preventing multiple workspaces from exhausting the
          // OS file descriptor limit (Issue #34, User Story #23).
          return {
            // Core workspace identification
            LABORER_WORKSPACE_ID: ws.id,
            LABORER_WORKSPACE_PATH: ws.worktreePath,
            LABORER_BRANCH: ws.branchName,

            // File watcher scoping (Issue #34)
            // Watchman: constrain root to worktree directory
            WATCHMAN_ROOT: ws.worktreePath,
            // chokidar (Vite, webpack, etc.): use polling instead of
            // native watchers to avoid exhausting OS file descriptors
            CHOKIDAR_USEPOLLING: 'true',
            // TypeScript: use dynamic priority polling for file watching
            // instead of native FS events (lower file descriptor usage)
            TSC_WATCHFILE: 'DynamicPriorityPolling',
            TSC_WATCHDIRECTORY: 'DynamicPriorityPolling',
          } as Record<string, string>
        }
      )

      return WorkspaceProvider.of({
        createWorktree,
        destroyWorktree,
        startSandbox,
        checkDirtyFiles,
        getWorkspaceEnv,
      })
    })
  )
}

export { buildValidationErrorMessage, validateWorktree, WorkspaceProvider }
export type { WorktreeValidation }
