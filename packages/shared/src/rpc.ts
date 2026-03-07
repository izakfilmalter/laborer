import { Rpc, RpcGroup } from '@effect/rpc'
import { Schema } from 'effect'
import { PrdStatus, TerminalStatus, WorkspaceStatus } from './types.js'

// ---------------------------------------------------------------------------
// Terminal Lifecycle Event Schemas
// ---------------------------------------------------------------------------
// These schemas model the discriminated union of lifecycle events emitted by
// the TerminalManager's PubSub. They are used as the success schema for the
// streaming `terminal.events` RPC endpoint.
//
// @see Issue #142: Terminal event stream RPC
// ---------------------------------------------------------------------------

export const TerminalSpawnedEvent = Schema.TaggedStruct('Spawned', {
  id: Schema.String,
  workspaceId: Schema.String,
  command: Schema.String,
  status: TerminalStatus,
})

export const TerminalStatusChangedEvent = Schema.TaggedStruct('StatusChanged', {
  id: Schema.String,
  status: TerminalStatus,
})

export const TerminalExitedEvent = Schema.TaggedStruct('Exited', {
  id: Schema.String,
  exitCode: Schema.Int,
  signal: Schema.Int,
})

export const TerminalRemovedEvent = Schema.TaggedStruct('Removed', {
  id: Schema.String,
})

export const TerminalRestartedEvent = Schema.TaggedStruct('Restarted', {
  id: Schema.String,
  workspaceId: Schema.String,
  command: Schema.String,
  status: TerminalStatus,
})

/**
 * Union of all terminal lifecycle events for the `terminal.events` stream.
 *
 * @see Issue #142: Terminal event stream RPC
 */
export const TerminalLifecycleEventSchema = Schema.Union(
  TerminalSpawnedEvent,
  TerminalStatusChangedEvent,
  TerminalExitedEvent,
  TerminalRemovedEvent,
  TerminalRestartedEvent
)

export type TerminalLifecycleEventSchema =
  typeof TerminalLifecycleEventSchema.Type

// ---------------------------------------------------------------------------
// Error Types
// ---------------------------------------------------------------------------

export class RpcError extends Schema.TaggedError<RpcError>()('RpcError', {
  message: Schema.String,
  code: Schema.optional(Schema.String),
}) {}

/**
 * Tagged error type for terminal service RPC operations.
 *
 * Distinct from `RpcError` (used by the main server) so that terminal service
 * errors are distinguishable at the type level. Error codes identify the
 * specific failure:
 * - `TERMINAL_NOT_FOUND` — no terminal with the given ID exists
 * - `TERMINAL_ALREADY_STOPPED` — kill/write/resize on a stopped terminal
 * - `SPAWN_FAILED` — PTY spawn failed (e.g., invalid command)
 * - `INTERNAL_ERROR` — unexpected internal failure
 *
 * @see Issue #137: Terminal RPC contract
 */
export class TerminalRpcError extends Schema.TaggedError<TerminalRpcError>()(
  'TerminalRpcError',
  {
    message: Schema.String,
    code: Schema.optional(Schema.String),
  }
) {}

// ---------------------------------------------------------------------------
// Shared Response Schemas
// ---------------------------------------------------------------------------

const HealthCheckResponse = Schema.Struct({
  status: Schema.Literal('ok'),
  uptime: Schema.Number,
})

export const ProjectResponse = Schema.Struct({
  id: Schema.String,
  repoPath: Schema.String,
  name: Schema.String,
  rlphConfig: Schema.optional(Schema.String),
})

export type ProjectResponse = typeof ProjectResponse.Type

const ConfigResolvedValueString = Schema.Struct({
  value: Schema.String,
  source: Schema.String,
})

const ConfigResolvedValueStringArray = Schema.Struct({
  value: Schema.Array(Schema.String),
  source: Schema.String,
})

const ConfigResolvedValueNullableString = Schema.Struct({
  value: Schema.NullOr(Schema.String),
  source: Schema.String,
})

const ConfigResponse = Schema.Struct({
  prdsDir: ConfigResolvedValueString,
  worktreeDir: ConfigResolvedValueString,
  setupScripts: ConfigResolvedValueStringArray,
  rlphConfig: ConfigResolvedValueNullableString,
  watchIgnore: ConfigResolvedValueStringArray,
})

const TaskResponse = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  source: Schema.String,
  prdId: Schema.optional(Schema.String),
  externalId: Schema.optional(Schema.String),
  title: Schema.String,
  status: Schema.String,
})

const TaskImportResponse = Schema.Struct({
  importedCount: Schema.Int,
  totalCount: Schema.Int,
})

export const PrdResponse = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  title: Schema.String,
  slug: Schema.String,
  filePath: Schema.String,
  status: PrdStatus,
  createdAt: Schema.String,
})

const PrdReadResponse = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  title: Schema.String,
  slug: Schema.String,
  filePath: Schema.String,
  status: PrdStatus,
  createdAt: Schema.String,
  content: Schema.String,
})

const WorkspaceResponse = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  branchName: Schema.String,
  worktreePath: Schema.String,
  port: Schema.Int,
  status: WorkspaceStatus,
})

const TerminalResponse = Schema.Struct({
  id: Schema.String,
  workspaceId: Schema.String,
  command: Schema.String,
  status: Schema.Literal('running', 'stopped'),
})

const DiffResponse = Schema.Struct({
  workspaceId: Schema.String,
  diffContent: Schema.String,
  lastUpdated: Schema.String,
})

// ---------------------------------------------------------------------------
// RPC Definitions
// ---------------------------------------------------------------------------

export class LaborerRpcs extends RpcGroup.make(
  // -----------------------------------------------------------------------
  // Health Check
  // -----------------------------------------------------------------------
  Rpc.make('health.check', {
    success: HealthCheckResponse,
  }),

  // -----------------------------------------------------------------------
  // Project RPCs
  // -----------------------------------------------------------------------
  Rpc.make('project.add', {
    success: ProjectResponse,
    error: RpcError,
    payload: {
      repoPath: Schema.String,
    },
  }),

  Rpc.make('project.remove', {
    error: RpcError,
    payload: {
      projectId: Schema.String,
    },
  }),

  Rpc.make('project.list', {
    success: Schema.Array(ProjectResponse),
    error: RpcError,
  }),

  // -----------------------------------------------------------------------
  // Config RPCs
  // -----------------------------------------------------------------------
  Rpc.make('config.get', {
    success: ConfigResponse,
    error: RpcError,
    payload: {
      projectId: Schema.String,
    },
  }),

  Rpc.make('config.update', {
    error: RpcError,
    payload: {
      projectId: Schema.String,
      config: Schema.Struct({
        prdsDir: Schema.optional(Schema.String),
        worktreeDir: Schema.optional(Schema.String),
        setupScripts: Schema.optional(Schema.Array(Schema.String)),
        rlphConfig: Schema.optional(Schema.String),
      }),
    },
  }),

  // -----------------------------------------------------------------------
  // PRD RPCs
  // -----------------------------------------------------------------------
  Rpc.make('prd.create', {
    success: PrdResponse,
    error: RpcError,
    payload: {
      projectId: Schema.String,
      title: Schema.String,
      content: Schema.String,
    },
  }),

  Rpc.make('prd.list', {
    success: Schema.Array(PrdResponse),
    error: RpcError,
    payload: {
      projectId: Schema.String,
    },
  }),

  Rpc.make('prd.read', {
    success: PrdReadResponse,
    error: RpcError,
    payload: {
      prdId: Schema.String,
    },
  }),

  Rpc.make('prd.remove', {
    error: RpcError,
    payload: {
      prdId: Schema.String,
    },
  }),

  Rpc.make('prd.update', {
    success: PrdResponse,
    error: RpcError,
    payload: {
      prdId: Schema.String,
      content: Schema.String,
    },
  }),

  Rpc.make('prd.updateStatus', {
    success: PrdResponse,
    error: RpcError,
    payload: {
      prdId: Schema.String,
      status: PrdStatus,
    },
  }),

  Rpc.make('prd.createIssue', {
    success: TaskResponse,
    error: RpcError,
    payload: {
      prdId: Schema.String,
      title: Schema.String,
      body: Schema.String,
    },
  }),

  Rpc.make('prd.readIssues', {
    success: Schema.String,
    error: RpcError,
    payload: {
      prdId: Schema.String,
    },
  }),

  Rpc.make('prd.listRemainingIssues', {
    success: Schema.Array(TaskResponse),
    error: RpcError,
    payload: {
      prdId: Schema.String,
    },
  }),

  Rpc.make('prd.updateIssue', {
    success: TaskResponse,
    error: RpcError,
    payload: {
      taskId: Schema.String,
      body: Schema.optional(Schema.String),
      status: Schema.optional(Schema.String),
    },
  }),

  // -----------------------------------------------------------------------
  // Workspace RPCs
  // -----------------------------------------------------------------------
  Rpc.make('workspace.create', {
    success: WorkspaceResponse,
    error: RpcError,
    payload: {
      projectId: Schema.String,
      branchName: Schema.optional(Schema.String),
      taskId: Schema.optional(Schema.String),
    },
  }),

  Rpc.make('workspace.destroy', {
    error: RpcError,
    payload: {
      workspaceId: Schema.String,
    },
  }),

  // -----------------------------------------------------------------------
  // Terminal RPCs
  // -----------------------------------------------------------------------
  Rpc.make('terminal.spawn', {
    success: TerminalResponse,
    error: RpcError,
    payload: {
      workspaceId: Schema.String,
      command: Schema.optional(Schema.String),
    },
  }),

  // -----------------------------------------------------------------------
  // Diff RPCs
  // -----------------------------------------------------------------------
  Rpc.make('diff.refresh', {
    success: DiffResponse,
    error: RpcError,
    payload: {
      workspaceId: Schema.String,
    },
  }),

  // -----------------------------------------------------------------------
  // Editor RPCs
  // -----------------------------------------------------------------------
  Rpc.make('editor.open', {
    error: RpcError,
    payload: {
      workspaceId: Schema.String,
      filePath: Schema.optional(Schema.String),
    },
  }),

  // -----------------------------------------------------------------------
  // rlph RPCs
  // -----------------------------------------------------------------------
  Rpc.make('rlph.startLoop', {
    success: TerminalResponse,
    error: RpcError,
    payload: {
      workspaceId: Schema.String,
    },
  }),

  Rpc.make('rlph.review', {
    success: TerminalResponse,
    error: RpcError,
    payload: {
      workspaceId: Schema.String,
      prNumber: Schema.Int,
    },
  }),

  Rpc.make('rlph.fix', {
    success: TerminalResponse,
    error: RpcError,
    payload: {
      workspaceId: Schema.String,
      prNumber: Schema.Int,
    },
  }),

  // -----------------------------------------------------------------------
  // Task RPCs
  // -----------------------------------------------------------------------
  Rpc.make('task.create', {
    success: TaskResponse,
    error: RpcError,
    payload: {
      projectId: Schema.String,
      prdId: Schema.optional(Schema.String),
      title: Schema.String,
      description: Schema.optional(Schema.String),
    },
  }),

  Rpc.make('task.importGithub', {
    success: TaskImportResponse,
    error: RpcError,
    payload: {
      projectId: Schema.String,
    },
  }),

  Rpc.make('task.importLinear', {
    success: TaskImportResponse,
    error: RpcError,
    payload: {
      projectId: Schema.String,
    },
  }),

  Rpc.make('task.updateStatus', {
    error: RpcError,
    payload: {
      taskId: Schema.String,
      status: Schema.String,
    },
  }),

  Rpc.make('task.remove', {
    error: RpcError,
    payload: {
      taskId: Schema.String,
    },
  })
) {}

// ---------------------------------------------------------------------------
// Terminal Service RPC Contract
// ---------------------------------------------------------------------------
// The terminal service runs as a separate Bun HTTP server process. These RPCs
// define the contract between the server (or any client) and the terminal
// service. Defined here in @laborer/shared so both @laborer/server and
// @laborer/terminal can import the same types.
//
// @see PRD-terminal-extraction.md — Terminal RPC Contract section
// @see Issue #137: Terminal RPC contract
// ---------------------------------------------------------------------------

/**
 * Information about a single terminal instance, returned by spawn, restart,
 * and list operations. Includes the opaque `workspaceId` metadata that the
 * caller passed at spawn time.
 */
export const TerminalInfo = Schema.Struct({
  id: Schema.String,
  workspaceId: Schema.String,
  command: Schema.String,
  args: Schema.Array(Schema.String),
  cwd: Schema.String,
  status: TerminalStatus,
})

export type TerminalInfo = typeof TerminalInfo.Type

/**
 * RPC group for the standalone terminal service (`@laborer/terminal`).
 *
 * All 7 endpoints operate on terminal instances managed by the terminal
 * service. The `workspaceId` is opaque metadata passed at spawn time —
 * the terminal service stores it but does not interpret it.
 *
 * Endpoints:
 * - `terminal.spawn` — create a new terminal with command, cwd, env, dimensions
 * - `terminal.write` — send input data to a terminal's PTY
 * - `terminal.resize` — resize a terminal's PTY dimensions
 * - `terminal.kill` — kill the PTY process (terminal kept in memory as stopped)
 * - `terminal.remove` — kill (if running) and fully remove a terminal
 * - `terminal.restart` — kill and respawn with the same command/config
 * - `terminal.list` — return all terminals (running and stopped)
 * - `terminal.events` — streaming endpoint pushing lifecycle events
 *
 * @see PRD-terminal-extraction.md
 * @see Issue #137: Terminal RPC contract
 * @see Issue #142: Terminal event stream RPC
 */
export class TerminalRpcs extends RpcGroup.make(
  // -----------------------------------------------------------------------
  // terminal.spawn — create a new terminal
  // -----------------------------------------------------------------------
  Rpc.make('terminal.spawn', {
    success: TerminalInfo,
    error: TerminalRpcError,
    payload: {
      /** Shell command to execute (e.g., "bash", "opencode", "rlph --once"). */
      command: Schema.String,
      /** Command arguments (optional, default []). */
      args: Schema.optional(Schema.Array(Schema.String)),
      /** Working directory for the PTY process. */
      cwd: Schema.String,
      /** Environment variables to inject into the PTY process. */
      env: Schema.optional(
        Schema.Record({ key: Schema.String, value: Schema.String })
      ),
      /** Initial terminal column count. */
      cols: Schema.Int,
      /** Initial terminal row count. */
      rows: Schema.Int,
      /**
       * Opaque workspace identifier — stored alongside the terminal for
       * caller-side bookkeeping. The terminal service does not interpret it.
       */
      workspaceId: Schema.String,
    },
  }),

  // -----------------------------------------------------------------------
  // terminal.write — send input to a terminal
  // -----------------------------------------------------------------------
  Rpc.make('terminal.write', {
    error: TerminalRpcError,
    payload: {
      id: Schema.String,
      data: Schema.String,
    },
  }),

  // -----------------------------------------------------------------------
  // terminal.resize — resize a terminal's PTY
  // -----------------------------------------------------------------------
  Rpc.make('terminal.resize', {
    error: TerminalRpcError,
    payload: {
      id: Schema.String,
      cols: Schema.Int,
      rows: Schema.Int,
    },
  }),

  // -----------------------------------------------------------------------
  // terminal.kill — stop the PTY (terminal retained in memory)
  // -----------------------------------------------------------------------
  Rpc.make('terminal.kill', {
    error: TerminalRpcError,
    payload: {
      id: Schema.String,
    },
  }),

  // -----------------------------------------------------------------------
  // terminal.remove — kill (if running) and fully remove from memory
  // -----------------------------------------------------------------------
  Rpc.make('terminal.remove', {
    error: TerminalRpcError,
    payload: {
      id: Schema.String,
    },
  }),

  // -----------------------------------------------------------------------
  // terminal.restart — kill and respawn with same command/config
  // -----------------------------------------------------------------------
  Rpc.make('terminal.restart', {
    success: TerminalInfo,
    error: TerminalRpcError,
    payload: {
      id: Schema.String,
    },
  }),

  // -----------------------------------------------------------------------
  // terminal.list — return all terminals (running + stopped)
  // -----------------------------------------------------------------------
  Rpc.make('terminal.list', {
    success: Schema.Array(TerminalInfo),
    error: TerminalRpcError,
  }),

  // -----------------------------------------------------------------------
  // terminal.events — streaming lifecycle events
  // -----------------------------------------------------------------------
  /**
   * Streaming RPC that pushes terminal lifecycle events as they occur.
   *
   * Events include: Spawned, StatusChanged, Exited, Removed, Restarted.
   * The stream stays open until the client disconnects. Multiple
   * subscribers receive the same events independently.
   *
   * @see Issue #142: Terminal event stream RPC
   */
  Rpc.make('terminal.events', {
    success: TerminalLifecycleEventSchema,
    error: TerminalRpcError,
    stream: true,
  })
) {}
