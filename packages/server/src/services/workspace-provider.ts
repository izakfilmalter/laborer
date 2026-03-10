/**
 * WorkspaceProvider — Effect Service
 *
 * Manages isolated workspace environments via git worktrees. Each workspace
 * gets its own branch, directory, and allocated port. The provider interface
 * is designed to be pluggable — v1 ships with git worktrees, but future
 * implementations could use Docker or Daytona.
 *
 * Responsibilities:
 * - Worktree creation via `git worktree add`
 * - Worktree destruction via `git worktree remove` + `git branch -D`
 * - Port allocation via PortAllocator
 * - Project validation via ProjectRegistry
 * - Workspace state tracking via LiveStore
 * - Branch management and naming
 * - Worktree directory validation after creation (Issue #34)
 * - File watcher scoping via environment variables (Issue #34)
 * - Environment variable injection (PORT, watcher scoping, etc.) for workspace processes
 * - Setup script execution after worktree creation (Issue #35)
 * - Full rollback on setup script failure (Issue #37)
 * - Git fetch failure handling (Issue #39)
 *
 * Setup scripts are defined in `laborer.json` and resolved via ConfigService:
 * ```json
 * {
 *   "setupScripts": ["bun install", "cp .env.example .env"]
 * }
 * ```
 *
 * Each script is executed in the worktree directory with the workspace
 * environment variables (PORT, etc.) injected. Scripts run sequentially
 * and any non-zero exit code aborts the remaining scripts. On failure,
 * the workspace is rolled back: worktree removed, port freed, branch
 * deleted. The error includes the script's stdout + stderr output.
 *
 * Usage:
 * ```ts
 * const program = Effect.gen(function* () {
 *   const provider = yield* WorkspaceProvider
 *   const workspace = yield* provider.createWorktree("project-id", "feature/my-branch")
 *   const env = yield* provider.getWorkspaceEnv("workspace-id")
 *   // env.PORT === "3142"
 *   yield* provider.destroyWorktree("workspace-id")
 * })
 * ```
 *
 * Issue #33: createWorktree method
 * Issue #34: worktree directory validation + file watcher scoping
 * Issue #35: run setup scripts in worktree
 * Issue #36: inject PORT env var
 * Issue #37: handle setup script failure (rollback)
 * Issue #38: handle dirty git state error
 * Issue #39: handle git fetch failure
 * Issue #43: destroyWorktree method
 */

import { execFile } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { RpcError } from '@laborer/shared/rpc'
import { events, tables } from '@laborer/shared/schema'
import {
  Array as Arr,
  Context,
  Data,
  Effect,
  Fiber,
  Layer,
  pipe,
  Ref,
} from 'effect'
import { ConfigService } from './config-service.js'
import { ContainerService } from './container-service.js'
import { DepsImageService } from './deps-image-service.js'
import { LaborerStore } from './laborer-store.js'
import { PortAllocator } from './port-allocator.js'
import { ProjectRegistry } from './project-registry.js'

/**
 * Shape of a workspace record returned by the provider.
 * Matches the LiveStore workspaces table columns.
 */
interface WorkspaceRecord {
  /** SHA of the parent branch HEAD when the worktree was created. Used by DiffService as the diff base. */
  readonly baseSha: string | null
  readonly branchName: string
  readonly createdAt: string
  readonly id: string
  readonly origin: 'laborer' | 'external'
  readonly port: number
  readonly projectId: string
  readonly status: string
  readonly taskSource: string | null
  readonly worktreePath: string
}

class GitSpawnError extends Data.TaggedError('GitSpawnError')<{
  readonly cause: unknown
  readonly message: string
}> {}

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
      const proc = Bun.spawn(['sh', '-c', command], {
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
 * Rollback a partially-created workspace. Cleans up in order:
 * 1. Set workspace status to "errored" in LiveStore (if workspace was committed)
 * 2. Remove the git worktree directory via `git worktree remove --force`
 * 3. Delete the branch via `git branch -D`
 * 4. Free the allocated port
 *
 * All steps are best-effort — failures are logged but don't prevent
 * subsequent cleanup steps from running.
 *
 * @param repoPath - Path to the main git repo
 * @param worktreePath - Path to the worktree directory to remove
 * @param branchName - Branch name to delete
 * @param port - Port to free
 * @param portAllocator - PortAllocator service instance
 */
const rollbackWorktree = (
  repoPath: string,
  worktreePath: string,
  branchName: string,
  port: number,
  portAllocator: {
    readonly free: (port: number) => Effect.Effect<void, RpcError>
  }
): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    yield* Effect.logInfo(
      `Rolling back workspace: removing worktree, branch, and freeing port ${port}`
    ).pipe(Effect.annotateLogs('module', logPrefix))

    // 1. Remove the git worktree directory
    yield* Effect.tryPromise({
      try: async () => {
        const proc = Bun.spawn(
          ['git', 'worktree', 'remove', '--force', worktreePath],
          {
            cwd: repoPath,
            stdout: 'pipe',
            stderr: 'pipe',
          }
        )
        const exitCode = await proc.exited
        const stderr = await new Response(proc.stderr).text()
        return { exitCode, stderr }
      },
      catch: (cause) =>
        new GitSpawnError({
          cause,
          message: `Failed to spawn git worktree remove during rollback: ${String(cause)}`,
        }),
    }).pipe(
      Effect.tap(({ exitCode, stderr }) =>
        exitCode !== 0
          ? Effect.logWarning(
              `Rollback: git worktree remove failed (exit ${exitCode}): ${stderr.trim()}`
            ).pipe(Effect.annotateLogs('module', logPrefix))
          : Effect.logDebug('Rollback: worktree removed').pipe(
              Effect.annotateLogs('module', logPrefix)
            )
      ),
      Effect.catchAll((error) =>
        Effect.logWarning(
          `Rollback: failed to remove worktree: ${String(error)}`
        ).pipe(Effect.annotateLogs('module', logPrefix))
      )
    )

    // 2. Delete the branch
    yield* Effect.tryPromise({
      try: async () => {
        const proc = Bun.spawn(['git', 'branch', '-D', branchName], {
          cwd: repoPath,
          stdout: 'pipe',
          stderr: 'pipe',
        })
        const exitCode = await proc.exited
        const stderr = await new Response(proc.stderr).text()
        return { exitCode, stderr }
      },
      catch: (cause) =>
        new GitSpawnError({
          cause,
          message: `Failed to spawn git branch -D during rollback: ${String(cause)}`,
        }),
    }).pipe(
      Effect.tap(({ exitCode, stderr }) =>
        exitCode !== 0
          ? Effect.logWarning(
              `Rollback: git branch -D failed (exit ${exitCode}): ${stderr.trim()}`
            ).pipe(Effect.annotateLogs('module', logPrefix))
          : Effect.logDebug('Rollback: branch deleted').pipe(
              Effect.annotateLogs('module', logPrefix)
            )
      ),
      Effect.catchAll((error) =>
        Effect.logWarning(
          `Rollback: failed to delete branch: ${String(error)}`
        ).pipe(Effect.annotateLogs('module', logPrefix))
      )
    )

    // 3. Free the allocated port
    yield* portAllocator.free(port).pipe(
      Effect.tap(() =>
        Effect.logDebug(`Rollback: freed port ${port}`).pipe(
          Effect.annotateLogs('module', logPrefix)
        )
      ),
      Effect.catchAll((error) =>
        Effect.logWarning(
          `Rollback: failed to free port ${port}: ${String(error)}`
        ).pipe(Effect.annotateLogs('module', logPrefix))
      )
    )

    yield* Effect.logInfo(
      'Rollback complete: worktree, branch, and port cleaned up'
    ).pipe(Effect.annotateLogs('module', logPrefix))
  })

/**
 * Fetch the latest remote refs before worktree creation. Runs `git fetch --all`
 * to ensure all remote branches are up-to-date. This is important because
 * `git worktree add` creates a branch from the current HEAD — if the local
 * repo is stale, the worktree starts from an outdated commit.
 *
 * Network failures (DNS resolution, SSH auth, remote unreachable) are caught
 * and returned as a clear `GIT_FETCH_FAILED` error. The error message includes
 * the git stderr output for diagnosis (e.g., "Could not resolve host" or
 * "Permission denied").
 *
 * This step is placed before port allocation so no resources need cleanup
 * on failure — matching the design of the dirty state check (Issue #38).
 *
 * @param repoPath - Path to the git repository to fetch in
 */
const fetchRemote = (repoPath: string): Effect.Effect<void, RpcError> =>
  Effect.gen(function* () {
    yield* Effect.logDebug('Fetching latest remote refs...').pipe(
      Effect.annotateLogs('module', logPrefix)
    )

    const result = yield* Effect.tryPromise({
      try: async () => {
        const proc = Bun.spawn(['git', 'fetch', '--all'], {
          cwd: repoPath,
          stdout: 'pipe',
          stderr: 'pipe',
        })
        const exitCode = await proc.exited
        const stdout = await new Response(proc.stdout).text()
        const stderr = await new Response(proc.stderr).text()
        return { exitCode, stdout, stderr }
      },
      catch: (error) =>
        new RpcError({
          message: `Failed to spawn git fetch: ${String(error)}`,
          code: 'GIT_FETCH_FAILED',
        }),
    })

    if (result.exitCode !== 0) {
      const stderrTrimmed = result.stderr.trim()
      const isNetworkError = detectNetworkError(stderrTrimmed)
      const guidance = isNetworkError
        ? 'Check your network connection and try again.'
        : 'Verify the remote is accessible and your credentials are valid.'

      yield* Effect.logWarning(
        `git fetch failed (exit ${result.exitCode}): ${stderrTrimmed}`
      ).pipe(Effect.annotateLogs('module', logPrefix))

      return yield* new RpcError({
        message: `Failed to fetch remote updates (exit ${result.exitCode}): ${stderrTrimmed}. ${guidance}`,
        code: 'GIT_FETCH_FAILED',
      })
    }

    yield* Effect.logDebug('Remote refs fetched successfully').pipe(
      Effect.annotateLogs('module', logPrefix)
    )
  })

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
 * Execute a git command using node:child_process (works in both Bun and Node.js).
 * This is used by `validateWorktree` instead of `Bun.spawn` so the validation
 * logic can be tested under vitest (which runs on Node.js, not Bun).
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
    const normalizedWorktree = realpathSync(worktreePath)
    const normalizedToplevel = toplevelResult
      ? realpathSync(toplevelResult)
      : null
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

/**
 * Detect whether a git stderr message indicates a network-related failure.
 * Used to provide more specific guidance in error messages.
 */
const detectNetworkError = (stderr: string): boolean => {
  const lowerStderr = stderr.toLowerCase()
  return (
    lowerStderr.includes('could not resolve host') ||
    lowerStderr.includes('unable to access') ||
    lowerStderr.includes('connection refused') ||
    lowerStderr.includes('connection timed out') ||
    lowerStderr.includes('network is unreachable') ||
    lowerStderr.includes('no route to host') ||
    lowerStderr.includes('ssh_exchange_identification') ||
    lowerStderr.includes('could not read from remote repository') ||
    lowerStderr.includes('the requested url returned error')
  )
}

class WorkspaceProvider extends Context.Tag('@laborer/WorkspaceProvider')<
  WorkspaceProvider,
  {
    /**
     * Create a new git worktree for a project.
     *
     * 1. Validates the project exists
     * 2. Generates a branch name if not provided
     * 3. Allocates a port from the PortAllocator
     * 4. Runs `git worktree add` to create the isolated directory
     * 5. Commits WorkspaceCreated event to LiveStore
     *
     * @param projectId - ID of the registered project
     * @param branchName - Optional branch name (auto-generated if omitted)
     * @param taskId - Optional task ID to link workspace to a task
     */
    readonly createWorktree: (
      projectId: string,
      branchName?: string,
      taskId?: string
    ) => Effect.Effect<WorkspaceRecord, RpcError>

    /**
     * Destroy a workspace by removing its git worktree, freeing the
     * allocated port, and committing a WorkspaceDestroyed event to LiveStore.
     * The branch is kept so it can be reused when creating a new workspace.
     * All workspaces have their worktree removed regardless of origin.
     *
     * Steps:
     * 1. Look up the workspace in LiveStore
     * 2. Look up the project to get the repo path
     * 3. Run `git worktree remove --force` to remove the worktree directory
     * 4. Free the allocated port via PortAllocator
     * 5. Commit WorkspaceDestroyed event to LiveStore
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
     * Get environment variables for a workspace.
     *
     * Returns a Record of env vars that should be injected into all
     * processes running in the workspace (setup scripts, terminals,
     * dev servers). Includes:
     * - PORT: the allocated port for dev servers
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
      const { store } = yield* LaborerStore
      const portAllocator = yield* PortAllocator
      const registry = yield* ProjectRegistry
      const configService = yield* ConfigService
      const containerService = yield* ContainerService
      const depsImageService = yield* DepsImageService

      const createWorktree = Effect.fn('WorkspaceProvider.createWorktree')(
        function* (projectId: string, branchName?: string, taskId?: string) {
          // 1. Validate the project exists and get its repo path
          const project = yield* registry.getProject(projectId)

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

          // 3. Check if a branch with this name already exists
          const branchExists = yield* Effect.tryPromise({
            try: async () => {
              const proc = Bun.spawn(
                ['git', 'rev-parse', '--verify', resolvedBranch],
                {
                  cwd: project.repoPath,
                  stdout: 'pipe',
                  stderr: 'pipe',
                }
              )
              const exitCode = await proc.exited
              return exitCode === 0
            },
            catch: () =>
              new RpcError({
                message: `Failed to check branch existence: ${resolvedBranch}`,
                code: 'GIT_CHECK_FAILED',
              }),
          })

          // 3b. Fetch latest remote refs (Issue #39)
          // Ensures the local repo has the latest remote state before
          // creating a worktree. Runs before port allocation so no
          // resources need cleanup on failure.
          yield* fetchRemote(project.repoPath)

          // 4. Allocate a port for this workspace
          const port = yield* portAllocator.allocate()

          // 5. Compute worktree path from resolved config
          const worktreeDir = resolvedConfig.worktreeDir.value
          const worktreePath = join(worktreeDir, slugify(resolvedBranch))

          // 6. Ensure the resolved worktree directory exists
          yield* Effect.tryPromise({
            try: async () => {
              const proc = Bun.spawn(['mkdir', '-p', worktreeDir], {
                cwd: project.repoPath,
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

          // 6b. Clean up stale worktree path if it exists on disk from a
          //     previous incomplete cleanup. Also prune git's internal worktree
          //     metadata so `git worktree add` doesn't fail with "already exists".
          if (existsSync(worktreePath)) {
            yield* Effect.logWarning(
              `Worktree path already exists, cleaning up: ${worktreePath}`
            ).pipe(Effect.annotateLogs('module', logPrefix))

            yield* Effect.tryPromise({
              try: async () => {
                const proc = Bun.spawn(['rm', '-rf', worktreePath], {
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

          // Prune stale git worktree references before creating. This cleans
          // up .git/worktrees/ entries for paths that no longer exist on disk.
          yield* Effect.tryPromise({
            try: async () => {
              const proc = Bun.spawn(['git', 'worktree', 'prune'], {
                cwd: project.repoPath,
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

          // 7. Create the git worktree, reusing the branch if it already exists
          const worktreeArgs = branchExists
            ? ['git', 'worktree', 'add', worktreePath, resolvedBranch]
            : ['git', 'worktree', 'add', '-b', resolvedBranch, worktreePath]

          const worktreeResult = yield* Effect.tryPromise({
            try: async () => {
              const proc = Bun.spawn(worktreeArgs, {
                cwd: project.repoPath,
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
            // Clean up: free the allocated port since worktree creation failed
            yield* portAllocator
              .free(port)
              .pipe(Effect.catchAll(() => Effect.void))

            return yield* new RpcError({
              message: `git worktree add failed (exit ${worktreeResult.exitCode}): ${worktreeResult.stderr.trim()}`,
              code: 'GIT_WORKTREE_FAILED',
            })
          }

          // 7b. Capture the base SHA — the commit the worktree was branched from.
          // `git worktree add -b <branch> <path>` creates the new branch at HEAD of
          // the main repo, so `git rev-parse HEAD` in the project repo gives us the
          // exact commit the worktree diverged from. This is stored in LiveStore and
          // used by DiffService as the base for `git diff <baseSha>`.
          const baseSha = yield* Effect.tryPromise({
            try: async () => {
              const proc = Bun.spawn(['git', 'rev-parse', 'HEAD'], {
                cwd: project.repoPath,
                stdout: 'pipe',
                stderr: 'pipe',
              })
              const exitCode = await proc.exited
              const stdout = await new Response(proc.stdout).text()
              if (exitCode === 0) {
                return stdout.trim()
              }
              return null
            },
            catch: () =>
              new RpcError({
                message: 'Failed to capture base SHA for worktree',
                code: 'GIT_REV_PARSE_FAILED',
              }),
          })

          // 8. Validate the worktree (Issue #34)
          // Comprehensive validation: directory exists, is a git work tree,
          // correct branch is checked out, and git toplevel is isolated to
          // the worktree path (not pointing at the main repo).
          const validation = yield* validateWorktree(
            worktreePath,
            resolvedBranch
          )

          const isValid =
            validation.directoryExists &&
            validation.isGitWorkTree &&
            validation.correctBranch &&
            validation.isolatedToplevel

          if (!isValid) {
            // Clean up: free port
            yield* portAllocator
              .free(port)
              .pipe(Effect.catchAll(() => Effect.void))

            const errorMsg = buildValidationErrorMessage(
              validation,
              worktreePath,
              resolvedBranch
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
            `Worktree validated: directory exists, git work tree, branch=${resolvedBranch}, toplevel=${worktreePath}`
          ).pipe(Effect.annotateLogs('module', logPrefix))

          // 9. Generate workspace ID early (needed for env var injection)
          const id = crypto.randomUUID()
          const createdAt = new Date().toISOString()

          // 10. Run setup scripts from resolved config (Issue #35, #37, #156)
          // Scripts run in the worktree directory with workspace env vars
          // injected. If any script fails, the workspace is fully rolled
          // back: worktree removed, port freed, branch deleted.
          const scriptEnv = {
            PORT: String(port),
            LABORER_WORKSPACE_ID: id,
            LABORER_WORKSPACE_PATH: worktreePath,
            LABORER_BRANCH: resolvedBranch,
          }

          const setupResult = yield* runProjectSetupScripts(
            resolvedConfig.setupScripts.value,
            worktreePath,
            scriptEnv
          )

          if (setupResult._tag === 'Failure') {
            // Commit "errored" status briefly so the UI sees the failure
            // before rollback removes the workspace
            store.commit(
              events.workspaceCreated({
                id,
                projectId,
                taskSource: taskId ?? null,
                branchName: resolvedBranch,
                worktreePath,
                port,
                status: 'errored',
                origin: 'laborer',
                createdAt,
                baseSha,
              })
            )

            // Full rollback: remove worktree, delete branch, free port
            yield* rollbackWorktree(
              project.repoPath,
              worktreePath,
              resolvedBranch,
              port,
              portAllocator
            )

            // Remove the errored workspace from LiveStore after rollback
            store.commit(events.workspaceDestroyed({ id }))

            return yield* new RpcError({
              message: buildSetupFailureMessage(setupResult),
              code: 'SETUP_SCRIPT_FAILED',
            })
          }

          // 11. Commit to LiveStore

          const workspace: WorkspaceRecord = {
            id,
            projectId,
            taskSource: taskId ?? null,
            branchName: resolvedBranch,
            worktreePath,
            port,
            status: 'running',
            origin: 'laborer',
            createdAt,
            baseSha,
          }

          store.commit(
            events.workspaceCreated({
              id: workspace.id,
              projectId: workspace.projectId,
              taskSource: workspace.taskSource,
              branchName: workspace.branchName,
              worktreePath: workspace.worktreePath,
              port: workspace.port,
              status: workspace.status,
              origin: workspace.origin,
              createdAt: workspace.createdAt,
              baseSha: workspace.baseSha,
            })
          )

          // 12. Start container if devServer config has an image (Issue #5)
          // Runs as a background fiber so workspace creation returns immediately.
          // The UI sees the workspace right away; the container appears once ready
          // (the containerStarted LiveStore event updates containerId reactively).
          const devServerImage = resolvedConfig.devServer.image.value
          if (devServerImage !== null) {
            const setupEffect = Effect.gen(function* () {
              // Signal UI: building deps image
              store.commit(
                events.containerSetupStepChanged({
                  workspaceId: id,
                  step: 'building-image',
                })
              )

              // Try to build/reuse a cached deps image with node_modules pre-installed.
              // Seeds all node_modules (root + workspace packages) into the worktree
              // so the bind mount carries them into the container.
              const depsResult = yield* depsImageService
                .ensureDepsImage({
                  projectRoot: project.repoPath,
                  projectName: project.name,
                  baseImage: devServerImage,
                  workdir: resolvedConfig.devServer.workdir.value,
                  worktreePath,
                  installCommand:
                    resolvedConfig.devServer.installCommand.value ?? undefined,
                  setupScripts:
                    resolvedConfig.devServer.setupScripts.value.length > 0
                      ? resolvedConfig.devServer.setupScripts.value
                      : undefined,
                  onProgress: (step) => {
                    store.commit(
                      events.containerSetupStepChanged({
                        workspaceId: id,
                        step,
                      })
                    )
                  },
                })
                .pipe(
                  Effect.catchAll((error: RpcError) =>
                    Effect.gen(function* () {
                      yield* Effect.logWarning(
                        `Deps image build failed, falling back to base image: ${error.message}`
                      ).pipe(Effect.annotateLogs('module', logPrefix))
                      return null
                    })
                  )
                )

              // Signal UI: starting container
              store.commit(
                events.containerSetupStepChanged({
                  workspaceId: id,
                  step: 'starting-container',
                })
              )

              yield* containerService
                .createContainer({
                  workspaceId: id,
                  worktreePath,
                  branchName: resolvedBranch,
                  projectName: project.name,
                  depsImageName: depsResult?.imageName,
                  devServerConfig: {
                    image: devServerImage,
                    dockerfile: resolvedConfig.devServer.dockerfile.value,
                    network: resolvedConfig.devServer.network.value,
                    workdir: resolvedConfig.devServer.workdir.value,
                  },
                })
                .pipe(
                  Effect.tapError((containerError) =>
                    Effect.gen(function* () {
                      yield* Effect.logWarning(
                        `Container creation failed, rolling back workspace: ${containerError.message}`
                      ).pipe(Effect.annotateLogs('module', logPrefix))

                      // Clear setup step before rollback
                      store.commit(
                        events.containerSetupStepChanged({
                          workspaceId: id,
                          step: null,
                        })
                      )

                      // Full rollback: remove worktree, delete branch, free port
                      yield* rollbackWorktree(
                        project.repoPath,
                        worktreePath,
                        resolvedBranch,
                        port,
                        portAllocator
                      )

                      // Remove the workspace from LiveStore after rollback
                      store.commit(events.workspaceDestroyed({ id }))
                    })
                  )
                )

              // containerStarted materializer clears containerSetupStep automatically
            }).pipe(
              Effect.catchAll((err) =>
                Effect.gen(function* () {
                  // Clear setup step on unexpected failure
                  store.commit(
                    events.containerSetupStepChanged({
                      workspaceId: id,
                      step: null,
                    })
                  )
                  yield* Effect.logWarning(
                    `Background container setup failed for workspace ${id}: ${String(err)}`
                  ).pipe(Effect.annotateLogs('module', logPrefix))
                })
              )
            )

            const fiber = yield* setupEffect.pipe(Effect.forkIn(scope))

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
          }

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
            // The workspace row is already gone from LiveStore. This can
            // happen when a previous destroy partially completed (e.g. the
            // WorkspaceDestroyed event was committed but the UI still held
            // a stale reference). Commit a no-op destroy event (SQL DELETE
            // with WHERE is idempotent) and return successfully so the UI
            // can clear the stale entry.
            yield* Effect.logWarning(
              `Workspace ${workspaceId} not found in LiveStore — committing idempotent WorkspaceDestroyed to clean up stale UI reference`
            ).pipe(Effect.annotateLogs('module', logPrefix))
            store.commit(events.workspaceDestroyed({ id: workspaceId }))
            return
          }

          const workspace = workspaceOpt.value

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
                const proc = Bun.spawn(['git', 'status', '--porcelain'], {
                  cwd: workspace.worktreePath,
                  stdout: 'pipe',
                  stderr: 'pipe',
                })
                const exitCode = await proc.exited
                const stdout = await new Response(proc.stdout).text()
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

          // 3b. Destroy container if one exists (Issue #5)
          //     Container destruction happens before worktree removal so
          //     the container is stopped before its bind-mounted directory
          //     is deleted. Best-effort: logs warnings but continues cleanup.
          if (workspace.containerId !== null) {
            yield* Effect.logInfo(
              `Destroying container: ${workspace.containerId}`
            ).pipe(Effect.annotateLogs('module', logPrefix))

            yield* containerService
              .destroyContainer(workspaceId)
              .pipe(
                Effect.catchAll((error) =>
                  Effect.logWarning(
                    `Container destroy failed for workspace "${workspaceId}": ${error.message}`
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
              const proc = Bun.spawn(
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
                const proc = Bun.spawn(['rm', '-rf', workspace.worktreePath], {
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
                const proc = Bun.spawn(['git', 'worktree', 'prune'], {
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
              const proc = Bun.spawn(['git', 'worktree', 'prune'], {
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
              const proc = Bun.spawn(
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
              Effect.logWarning(`Failed to delete branch: ${String(err)}`).pipe(
                Effect.annotateLogs('module', logPrefix)
              )
            )
          )

          // Check if directory still exists after cleanup
          const dirStillExists = existsSync(workspace.worktreePath)
          yield* Effect.logInfo(
            `Post-cleanup: directory ${workspace.worktreePath} exists=${String(dirStillExists)}`
          ).pipe(Effect.annotateLogs('module', logPrefix))

          if (workspace.port > 0) {
            // 5. Free the allocated port
            yield* Effect.logInfo(`Freeing port ${workspace.port}`).pipe(
              Effect.annotateLogs('module', logPrefix)
            )

            yield* portAllocator
              .free(workspace.port)
              .pipe(
                Effect.catchAll((err) =>
                  Effect.logWarning(
                    `Failed to free port ${workspace.port}: ${err.message}`
                  )
                )
              )
          }

          // 6. Commit WorkspaceDestroyed event to LiveStore
          //    This removes the row from the workspaces table
          yield* Effect.logInfo(
            `Committing WorkspaceDestroyed event for ${workspaceId}`
          ).pipe(Effect.annotateLogs('module', logPrefix))

          store.commit(events.workspaceDestroyed({ id: workspaceId }))

          yield* Effect.logInfo(
            `Workspace ${workspaceId} (${workspace.branchName}) destroyed successfully`
          ).pipe(Effect.annotateLogs('module', logPrefix))
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
            PORT: String(ws.port),
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
        getWorkspaceEnv,
      })
    })
  )
}

export { buildValidationErrorMessage, validateWorktree, WorkspaceProvider }
export type { WorktreeValidation }
