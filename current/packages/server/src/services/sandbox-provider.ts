import type { RpcError } from '@laborer/shared/rpc'
import { Context, type Effect } from 'effect'

// ---------------------------------------------------------------------------
// Parameter & result types
// ---------------------------------------------------------------------------

/**
 * Parameters for creating a new sandbox.
 * Passed by `WorkspaceProvider` to whichever `SandboxProvider` implementation
 * is configured for the project.
 */
interface CreateSandboxParams {
  /** Git branch name (used for naming / labelling). */
  readonly branchName: string
  /**
   * Current branch of the project's main repo (e.g. "main", "develop").
   * Used by Daytona to clone the repo at this branch before creating
   * the workspace branch. Not used by Docker (which uses local worktrees).
   */
  readonly currentBranch: string | null
  /** Resolved dev server configuration from `ConfigService`. */
  readonly devServerConfig: {
    /** Auto-open the dev server sidebar on terminal spawn. */
    readonly autoOpen: boolean
    /** Minutes of inactivity before auto-stop (Daytona only). */
    readonly autoStopInterval: number | null
    /** Path to a Dockerfile (mutually exclusive with `image`). */
    readonly dockerfile: string | null
    /** Base image name (e.g. "node:22"). */
    readonly image: string | null
    /** Override install command for cached deps images. */
    readonly installCommand: string | null
    /** Docker network to join (Docker provider only). */
    readonly network: string | null
    /** Port the dev server listens on. */
    readonly port: number | null
    /** Sandbox provider for this project ("docker", "daytona", or "none"). */
    readonly provider: 'docker' | 'daytona' | 'none' | null
    /** Daytona sandbox resource limits (CPU, memory, disk). */
    readonly resources: {
      readonly cpu?: number | undefined
      readonly disk?: number | undefined
      readonly memory?: number | undefined
    } | null
    /** Scripts to run inside the sandbox before the start command. */
    readonly setupScripts: readonly string[]
    /** Command to start the dev server. */
    readonly startCommand: string | null
    /** Working directory inside the sandbox. */
    readonly workdir: string
  }
  /**
   * Optional callback invoked after the sandbox is fully ready.
   * Implementations may use this to kick off post-creation tasks
   * (e.g. auto-running the dev server).
   */
  readonly onReady?:
    | ((workspaceId: string) => Effect.Effect<void, RpcError>)
    | undefined
  /** Human-readable project name (used for naming / labelling). */
  readonly projectName: string
  /**
   * Remote origin URL of the project repo (e.g. "git@github.com:user/repo.git").
   * Used by Daytona to clone the repo into the sandbox. Not used by Docker
   * (which bind-mounts the local worktree).
   */
  readonly repoUrl: string | null
  /** Unique workspace identifier. */
  readonly workspaceId: string
  /** Absolute path to the local git worktree on the host (empty string for Daytona). */
  readonly worktreePath: string
}

/**
 * Options for spawning a terminal inside a sandbox.
 */
interface TerminalOpts {
  /** Whether to automatically run setup scripts + start command. */
  readonly autoRun?: boolean | undefined
  /** Initial terminal column count. */
  readonly cols?: number | undefined
  /** Initial command to execute in the terminal. */
  readonly command?: string | undefined
  /** Prompt passed to a supported interactive agent when it starts. */
  readonly initialPrompt?: string | undefined
  /** Initial terminal row count. */
  readonly rows?: number | undefined
}

/**
 * A minimal, provider-agnostic handle to an interactive terminal session.
 *
 * Both Docker (`docker exec` PTY) and Daytona (WebSocket PTY) sessions
 * are represented through this interface so that the terminal infrastructure
 * can work with either provider without branching.
 */
interface TerminalHandle {
  /** Human-readable description of the command being run. */
  readonly command: string
  /** Unique identifier for this terminal session. */
  readonly id: string
  /** Current status of the terminal session. */
  readonly status: 'running' | 'stopped'
  /** Workspace this terminal belongs to. */
  readonly workspaceId: string
}

/**
 * Result of a provider availability check.
 * Mirrors the shape returned by `DockerDetection.check()`.
 */
interface ProviderStatus {
  /** Whether the provider is available and can create sandboxes. */
  readonly available: boolean
  /** Human-readable error message when not available. */
  readonly error?: string | undefined
}

// ---------------------------------------------------------------------------
// SandboxProvider service
// ---------------------------------------------------------------------------

/**
 * Abstraction over sandbox lifecycle, terminal access, preview URLs, and
 * state reconciliation.
 *
 * Both the existing Docker flow (`DockerSandboxProvider`) and the new Daytona
 * cloud sandbox flow (`DaytonaSandboxProvider`) implement this interface.
 * `WorkspaceProvider` delegates to whichever implementation is configured for
 * the current project.
 *
 * Designed as a _deep module_: small surface area where each method hides
 * significant provider-specific complexity.
 */
class SandboxProvider extends Context.Tag('@laborer/SandboxProvider')<
  SandboxProvider,
  {
    /** Provision a sandbox for a workspace. */
    readonly createSandbox: (
      params: CreateSandboxParams
    ) => Effect.Effect<void, RpcError>

    /** Tear down a sandbox and clean up all associated resources. */
    readonly destroySandbox: (
      workspaceId: string
    ) => Effect.Effect<void, RpcError>

    /** Pause / stop the sandbox (free compute while preserving state). */
    readonly pauseSandbox: (
      workspaceId: string
    ) => Effect.Effect<void, RpcError>

    /** Resume / start a previously paused sandbox. */
    readonly resumeSandbox: (
      workspaceId: string
    ) => Effect.Effect<void, RpcError>

    /**
     * Get a preview URL for a port exposed by the sandbox.
     *
     * For Docker this is an `.orb.local` URL; for Daytona it is a
     * `*.preview.daytona.io` URL.
     */
    readonly getPreviewUrl: (
      workspaceId: string,
      port: number
    ) => Effect.Effect<string, RpcError>

    /**
     * Spawn an interactive terminal session inside the sandbox.
     *
     * Returns a `TerminalHandle` that the terminal infrastructure can
     * use regardless of provider.
     */
    readonly spawnTerminal: (
      workspaceId: string,
      opts?: TerminalOpts
    ) => Effect.Effect<TerminalHandle, RpcError>

    /**
     * Resize a terminal's PTY session.
     *
     * For Daytona: calls `PtyHandle.resize()` on the WebSocket PTY.
     * For Docker/host: forwards to the terminal utility process via
     * `TerminalClient`.
     *
     * @see Issue #17: Daytona PTY — bridge to xterm.js terminal component
     */
    readonly resizeTerminal: (
      terminalId: string,
      cols: number,
      rows: number
    ) => Effect.Effect<void, RpcError>

    /**
     * Kill a terminal's PTY session (stop the process, retain metadata).
     *
     * For Daytona: disconnects the PtyHandle WebSocket.
     * For Docker/host: forwards to the terminal utility process.
     */
    readonly killTerminal: (terminalId: string) => Effect.Effect<void, RpcError>

    /**
     * Remove a terminal — kills the PTY (if running) and cleans up all
     * resources including the PtyHandle registry entry.
     *
     * For Daytona: disconnects + removes from registry.
     * For Docker/host: forwards to the terminal utility process.
     */
    readonly removeTerminal: (
      terminalId: string
    ) => Effect.Effect<void, RpcError>

    /**
     * Sync LiveStore state with the actual provider state.
     *
     * For Docker: delegates to the existing `docker events` listener.
     * For Daytona: polls the Daytona API on a 30-second interval.
     *
     * Called once at startup and then kept running as a background fiber.
     */
    readonly reconcileState: () => Effect.Effect<void>

    /**
     * Check whether the provider is available (e.g. Docker running,
     * Daytona API key configured and reachable).
     */
    readonly checkAvailability: () => Effect.Effect<ProviderStatus>

    /**
     * Set the auto-stop interval for a sandbox (minutes of inactivity).
     *
     * For Daytona: calls `sandbox.setAutostopInterval()` via the SDK.
     * For Docker: no-op (Docker containers don't have auto-stop).
     *
     * @param workspaceId - The workspace whose sandbox to update
     * @param interval - Minutes of inactivity before auto-stop (0 disables)
     */
    readonly setAutoStopInterval: (
      workspaceId: string,
      interval: number
    ) => Effect.Effect<void, RpcError>
  }
>() {}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { SandboxProvider }
export type {
  CreateSandboxParams,
  ProviderStatus,
  TerminalHandle,
  TerminalOpts,
}
