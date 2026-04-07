/**
 * Git sync helpers for pushing worktree code to Daytona sandboxes via SSH.
 *
 * Pure functions for constructing SSH remote URLs, git remote names,
 * and the commands needed to push a local worktree HEAD to a remote
 * sandbox. These helpers are used by `DaytonaSandboxProvider.createSandbox`
 * to transfer code into a newly created Daytona cloud sandbox.
 *
 * @see packages/server/src/services/daytona-sandbox-provider.ts
 * @see docs/daytona-sandbox-provider/issues.md (Issue 15)
 */

// ---------------------------------------------------------------------------
// SSH host constants
// ---------------------------------------------------------------------------

/**
 * Default SSH host for Daytona sandboxes.
 * The SSH gateway is accessed via this hostname at port 2222.
 */
const DAYTONA_SSH_HOST = 'ssh.app.daytona.io'

/** Prefix used for temporary Daytona git remotes. */
const SANDBOX_REMOTE_PREFIX = 'sandbox-'

/**
 * Default working directory inside Daytona sandboxes.
 * The agent and dev server operate from this path.
 */
const DAYTONA_PROJECT_DIR = '/home/daytona/project'

// ---------------------------------------------------------------------------
// Pure helper functions
// ---------------------------------------------------------------------------

/**
 * Build the git remote name used for pushing code to a Daytona sandbox.
 *
 * Format: `sandbox-{workspaceId}`
 *
 * The remote is added temporarily during code push and removed afterward.
 */
const buildRemoteName = (workspaceId: string): string =>
  `${SANDBOX_REMOTE_PREFIX}${workspaceId}`

/**
 * Check whether a git remote name belongs to Laborer's temporary sandbox sync.
 *
 * These remotes are added briefly while pushing worktree code to Daytona and
 * should be ignored by generic repo fetches.
 */
const isSandboxRemoteName = (remoteName: string): boolean =>
  remoteName.startsWith(SANDBOX_REMOTE_PREFIX)

/**
 * Build the SSH remote URL for pushing code to a Daytona sandbox.
 *
 * Format: `ssh://{token}@{host}/{projectDir}`
 *
 * The token comes from `sandbox.createSshAccess()` and serves as the
 * SSH username for authentication.
 *
 * @param token - SSH access token from Daytona API
 * @param host - SSH gateway host (defaults to `ssh.app.daytona.io`)
 * @param projectDir - Project directory inside the sandbox (defaults to `/home/daytona/project`)
 */
const buildSshRemoteUrl = (
  token: string,
  host = DAYTONA_SSH_HOST,
  projectDir = DAYTONA_PROJECT_DIR
): string => `ssh://${token}@${host}${projectDir}`

/**
 * Build the git command args to add a temporary remote for the sandbox.
 *
 * @returns Array of git args: `['remote', 'add', remoteName, remoteUrl]`
 */
const buildAddRemoteArgs = (
  remoteName: string,
  remoteUrl: string
): readonly string[] => ['remote', 'add', remoteName, remoteUrl]

/**
 * Build the git command args to push HEAD to the sandbox remote.
 *
 * Uses `--force` because the sandbox is freshly created and may have
 * a different history (or no history at all).
 *
 * @returns Array of git args: `['push', remoteName, 'HEAD:main', '--force']`
 */
const buildPushArgs = (remoteName: string): readonly string[] => [
  'push',
  remoteName,
  'HEAD:main',
  '--force',
]

/**
 * Build the git command args to remove the temporary sandbox remote.
 *
 * @returns Array of git args: `['remote', 'remove', remoteName]`
 */
const buildRemoveRemoteArgs = (remoteName: string): readonly string[] => [
  'remote',
  'remove',
  remoteName,
]

/**
 * Build the shell command to initialize a git repo inside the sandbox
 * (if not already present) and configure it to accept pushes.
 *
 * Runs inside the sandbox via `sandbox.process.executeCommand()`.
 */
const buildSandboxInitCommand = (projectDir = DAYTONA_PROJECT_DIR): string =>
  `git init ${projectDir} && cd ${projectDir} && git config receive.denyCurrentBranch ignore`

/**
 * Build the shell command to check out the pushed code inside the sandbox.
 *
 * After the local push, the sandbox's working tree needs to be updated
 * to reflect the pushed HEAD. This resets the working tree to match the
 * `main` branch that was pushed.
 *
 * Runs inside the sandbox via `sandbox.process.executeCommand()`.
 */
const buildSandboxCheckoutCommand = (
  projectDir = DAYTONA_PROJECT_DIR
): string => `cd ${projectDir} && git checkout -f main`

// ---------------------------------------------------------------------------
// SSH environment builder
// ---------------------------------------------------------------------------

/**
 * Build the environment variables needed for SSH-based git push.
 *
 * Disables strict host key checking and known hosts to avoid interactive
 * prompts during automated push. Uses `GIT_SSH_COMMAND` to pass SSH
 * options without modifying the user's SSH config.
 */
const buildSshGitEnv = (): Record<string, string> => ({
  GIT_SSH_COMMAND:
    'ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 2222',
})

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  buildAddRemoteArgs,
  buildPushArgs,
  buildRemoveRemoteArgs,
  buildRemoteName,
  isSandboxRemoteName,
  buildSandboxCheckoutCommand,
  buildSandboxInitCommand,
  buildSshGitEnv,
  buildSshRemoteUrl,
  DAYTONA_PROJECT_DIR,
  DAYTONA_SSH_HOST,
}
