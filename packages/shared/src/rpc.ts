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
 * Pushed when a terminal's process-level state changes (foreground process,
 * agent status, child process presence, or process chain). Emitted by the
 * server-side background detection fiber whenever the diff against the
 * previous snapshot is non-empty, and immediately when a hook-reported
 * agent status arrives.
 *
 * Carries the full `TerminalInfo` so subscribers can replace their local
 * state in one shot without a round-trip `terminal.list` fetch.
 */
export const TerminalProcessChangedEvent = Schema.TaggedStruct(
  'ProcessChanged',
  {
    terminal: Schema.suspend(() => TerminalInfo),
  }
)

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
  TerminalRestartedEvent,
  TerminalProcessChangedEvent
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
  brrrConfig: Schema.optional(Schema.String),
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

const ConfigResolvedValueBoolean = Schema.Struct({
  value: Schema.Boolean,
  source: Schema.String,
})

const ConfigResolvedValueNullableString = Schema.Struct({
  value: Schema.NullOr(Schema.String),
  source: Schema.String,
})

const ConfigResolvedValueNullableNumber = Schema.Struct({
  value: Schema.NullOr(Schema.Number),
  source: Schema.String,
})

export const SandboxProviderTypeSchema = Schema.Literal('docker', 'daytona')

export type SandboxProviderType = typeof SandboxProviderTypeSchema.Type

const SandboxResourcesSchema = Schema.Struct({
  cpu: Schema.optional(Schema.Number),
  disk: Schema.optional(Schema.Number),
  memory: Schema.optional(Schema.Number),
})

const ConfigResolvedValueNullableSandboxProvider = Schema.Struct({
  value: Schema.NullOr(SandboxProviderTypeSchema),
  source: Schema.String,
})

const ConfigResolvedValueNullableSandboxResources = Schema.Struct({
  value: Schema.NullOr(SandboxResourcesSchema),
  source: Schema.String,
})

const DevServerConfigResponse = Schema.Struct({
  autoOpen: ConfigResolvedValueBoolean,
  autoStopInterval: ConfigResolvedValueNullableNumber,
  image: ConfigResolvedValueNullableString,
  dockerfile: ConfigResolvedValueNullableString,
  installCommand: ConfigResolvedValueNullableString,
  network: ConfigResolvedValueNullableString,
  port: ConfigResolvedValueNullableNumber,
  provider: ConfigResolvedValueNullableSandboxProvider,
  resources: ConfigResolvedValueNullableSandboxResources,
  setupScripts: ConfigResolvedValueStringArray,
  startCommand: ConfigResolvedValueNullableString,
  workdir: ConfigResolvedValueString,
})

export const AgentProviderSchema = Schema.Literal('opencode', 'claude', 'codex')

export type AgentProvider = typeof AgentProviderSchema.Type

const ConfigResolvedValueAgent = Schema.Struct({
  value: AgentProviderSchema,
  source: Schema.String,
})

const ConfigResponse = Schema.Struct({
  agent: ConfigResolvedValueAgent,
  devServer: DevServerConfigResponse,
  prdsDir: ConfigResolvedValueString,
  worktreeDir: ConfigResolvedValueString,
  setupScripts: ConfigResolvedValueStringArray,
  brrrConfig: ConfigResolvedValueNullableString,
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
  status: WorkspaceStatus,
})

const TerminalResponse = Schema.Struct({
  id: Schema.String,
  workspaceId: Schema.String,
  command: Schema.String,
  status: Schema.Literal('running', 'stopped'),
})

const DockerStatusResponse = Schema.Struct({
  available: Schema.Boolean,
  error: Schema.optional(Schema.String),
})

/**
 * Alias for DockerStatusResponse — used by the new provider-agnostic
 * `sandbox.providerStatus` RPC. Same shape as `docker.status`.
 */
const ProviderStatusResponse = DockerStatusResponse

const PrStatusResponse = Schema.Struct({
  number: Schema.NullOr(Schema.Int),
  state: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
})

const WorkspaceSyncStatusResponse = Schema.Struct({
  aheadCount: Schema.NullOr(Schema.Int),
  behindCount: Schema.NullOr(Schema.Int),
})

// ---------------------------------------------------------------------------
// Review Comment Schemas
// ---------------------------------------------------------------------------

/**
 * Reaction on a GitHub PR comment (e.g. rocket, thumbs_up, confused).
 * Used to determine triage/resolution state of findings.
 */
export const PrCommentReaction = Schema.Struct({
  id: Schema.Number,
  content: Schema.String,
  userId: Schema.Number,
})

export type PrCommentReaction = typeof PrCommentReaction.Type

/**
 * A single PR comment fetched from GitHub.
 * Includes both issue comments and inline review comments.
 * Comments that contain a brrr-finding marker are returned in the
 * `findings` array instead of `comments`.
 */
export const PrComment = Schema.Struct({
  /** GitHub comment ID */
  id: Schema.Number,
  /** 'issue' for issue comments, 'review' for inline review comments */
  commentType: Schema.Literal('issue', 'review'),
  /** GitHub login of the comment author */
  authorLogin: Schema.String,
  /** Avatar URL of the comment author */
  authorAvatarUrl: Schema.String,
  /** Comment body (markdown) */
  body: Schema.String,
  /** File path for inline review comments (null for issue comments) */
  filePath: Schema.NullOr(Schema.String),
  /** Line number for inline review comments (null for issue comments) */
  line: Schema.NullOr(Schema.Number),
  /** ISO 8601 timestamp */
  createdAt: Schema.String,
  /** Reactions on this comment */
  reactions: Schema.Array(PrCommentReaction),
})

export type PrComment = typeof PrComment.Type

/**
 * Severity level for a brrr review finding.
 */
export const ReviewSeverity = Schema.Literal('critical', 'warning', 'info')

export type ReviewSeverity = typeof ReviewSeverity.Type

/**
 * A structured finding extracted from a brrr inline review comment.
 * Parsed from the `<!-- brrr-finding:{json} -->` HTML comment marker.
 */
export const ReviewFinding = Schema.Struct({
  /** Short slugified identifier (e.g. "sql-injection") */
  id: Schema.String,
  /** File path where the finding applies */
  file: Schema.String,
  /** Line number in the file */
  line: Schema.Number,
  /** Severity level: critical, warning, or info */
  severity: ReviewSeverity,
  /** Human-readable description of the finding */
  description: Schema.String,
  /** Suggested fixes (may be empty) */
  suggestedFixes: Schema.Array(Schema.String),
  /** Finding category (e.g. "correctness", "security", "style"); null if unset */
  category: Schema.NullOr(Schema.String),
  /** IDs of other findings this one depends on (may be empty) */
  dependsOn: Schema.Array(Schema.String),
  /** GitHub comment ID of the inline review comment containing this finding */
  commentId: Schema.Number,
  /** Reactions on the comment containing this finding */
  reactions: Schema.Array(PrCommentReaction),
})

export type ReviewFinding = typeof ReviewFinding.Type

/**
 * Review verdict extracted from the brrr summary comment.
 * The summary comment is identified by the `<!-- brrr-review -->` marker.
 */
export const ReviewVerdict = Schema.Literal('approved', 'needs_fix')

export type ReviewVerdict = typeof ReviewVerdict.Type

/**
 * Response from review.fetchComments RPC.
 * Comments with brrr-finding markers appear in `findings`, not `comments`.
 * The verdict is extracted from the `<!-- brrr-review -->` summary comment.
 */
const ReviewFetchCommentsResponse = Schema.Struct({
  /** Review verdict (approved/needs_fix), or null if no brrr review summary exists */
  verdict: Schema.NullOr(ReviewVerdict),
  /** Structured findings extracted from brrr inline review comments */
  findings: Schema.Array(ReviewFinding),
  /** PR comments without brrr-finding markers (human comments + non-finding brrr comments) */
  comments: Schema.Array(PrComment),
})

/**
 * Response from review.fetchVerdict RPC.
 * Lightweight response containing only the verdict — used by workspace
 * cards to show a review status badge without fetching all comments.
 */
const ReviewFetchVerdictResponse = Schema.Struct({
  /** Review verdict (approved/needs_fix), or null if no brrr review summary exists */
  verdict: Schema.NullOr(ReviewVerdict),
})

// ---------------------------------------------------------------------------
// File Service Schemas (Lazy File Service)
// ---------------------------------------------------------------------------

/**
 * A single file or directory entry returned by `file.list`.
 *
 * Each node represents one entry in a directory listing. The `path` is
 * relative to the worktree root, `absolute` is the full filesystem path,
 * and `ignored` indicates whether the entry matches a `.gitignore` or
 * `.ignore` pattern.
 *
 * @see PRD: Lazy File Service — FileNode schema
 */
export const FileNode = Schema.Struct({
  /** File or directory name (basename). */
  name: Schema.String,
  /** Path relative to the worktree root. */
  path: Schema.String,
  /** Absolute filesystem path. */
  absolute: Schema.String,
  /** Whether this entry is a file or directory. */
  type: Schema.Literal('file', 'directory'),
  /** Whether this entry matches a gitignore/ignore pattern. */
  ignored: Schema.Boolean,
})

export type FileNode = typeof FileNode.Type

/**
 * A file change event streamed to the client from `file.watcher.subscribe`.
 *
 * The `file` path is relative to the worktree root. The `event` type maps
 * internal watcher types to the client-facing vocabulary:
 * - `"add"` — a file was created
 * - `"change"` — a file was modified
 * - `"unlink"` — a file was deleted
 *
 * @see PRD: Lazy File Service — FileWatcherEvent schema
 * @see Issue 5: file.watcher.subscribe — Per-workspace watcher event stream
 */
export const FileWatcherEvent = Schema.Struct({
  /** Path of the changed file, relative to the worktree root. */
  file: Schema.String,
  /** The type of file change. */
  event: Schema.Literal('add', 'change', 'unlink'),
})

export type FileWatcherEvent = typeof FileWatcherEvent.Type

/**
 * A single hunk within a structured patch, representing a contiguous
 * set of changes between the old and new file versions.
 *
 * Each hunk has start positions and line counts for both old and new
 * versions, plus an array of diff lines where each line is prefixed
 * with `" "` (context), `"+"` (added), or `"-"` (removed).
 *
 * @see PRD: Lazy File Service — FileContent.patch schema
 * @see Issue 3: file.read — On-demand file content with per-file diff
 */
export const PatchHunk = Schema.Struct({
  /** Starting line in the old file. */
  oldStart: Schema.Number,
  /** Number of lines from the old file in this hunk. */
  oldLines: Schema.Number,
  /** Starting line in the new file. */
  newStart: Schema.Number,
  /** Number of lines from the new file in this hunk. */
  newLines: Schema.Number,
  /** Diff lines, each prefixed with " ", "+", or "-". */
  lines: Schema.Array(Schema.String),
})

export type PatchHunk = typeof PatchHunk.Type

/**
 * A structured patch representing the diff between two versions of a file.
 *
 * Computed via the `diff` npm library's `structuredPatch()` with
 * `context: Infinity` so the entire file is included as context.
 *
 * @see PRD: Lazy File Service — FileContent.patch schema
 * @see Issue 3: file.read — On-demand file content with per-file diff
 */
export const StructuredPatch = Schema.Struct({
  /** Old file name (typically the relative path). */
  oldFileName: Schema.String,
  /** New file name (typically the relative path). */
  newFileName: Schema.String,
  /** Old file header (e.g., "old"). */
  oldHeader: Schema.optional(Schema.String),
  /** New file header (e.g., "new"). */
  newHeader: Schema.optional(Schema.String),
  /** Array of hunks representing changes. */
  hunks: Schema.Array(PatchHunk),
  /** Index line from the diff header. */
  index: Schema.optional(Schema.String),
})

export type StructuredPatch = typeof StructuredPatch.Type

/**
 * File content returned by `file.read`.
 *
 * Represents the content of a single file from a workspace's worktree,
 * along with its diff against HEAD (if the file has changes).
 *
 * - `type: "text"` — text file, `content` is the UTF-8 string
 * - `type: "binary"` — binary file, `content` is empty
 *
 * For images, `content` is base64-encoded with `encoding: "base64"`
 * and `mimeType` set to the image MIME type.
 *
 * @see PRD: Lazy File Service — FileContent schema
 * @see Issue 3: file.read — On-demand file content with per-file diff
 */
export const FileContent = Schema.Struct({
  /** Whether this is a text or binary file. */
  type: Schema.Literal('text', 'binary'),
  /** File content (UTF-8 text, base64 for images, or empty for binary). */
  content: Schema.String,
  /** Raw git diff output for this file (absent if no changes). */
  diff: Schema.optional(Schema.String),
  /** Structured patch with hunks (absent if no changes). */
  patch: Schema.optional(StructuredPatch),
  /** Content encoding (present only for base64-encoded content). */
  encoding: Schema.optional(Schema.Literal('base64')),
  /** MIME type (present for images and detected binary files). */
  mimeType: Schema.optional(Schema.String),
})

export type FileContent = typeof FileContent.Type

/**
 * Summary of a single changed file in a workspace, returned by `file.status`.
 *
 * Each entry represents a file that differs from HEAD — either modified,
 * newly added (untracked), or deleted. Line counts indicate the number of
 * lines added and removed relative to HEAD.
 *
 * @see PRD: Lazy File Service — FileInfo schema
 * @see Issue 4: file.status — Workspace-level changed file summary
 */
export const FileInfo = Schema.Struct({
  /** Path of the changed file, relative to the worktree root. */
  path: Schema.String,
  /** Number of lines added relative to HEAD. */
  added: Schema.Number,
  /** Number of lines removed relative to HEAD. */
  removed: Schema.Number,
  /** The type of change: added (untracked), deleted, or modified. */
  status: Schema.Literal('added', 'deleted', 'modified'),
})

export type FileInfo = typeof FileInfo.Type

// ---------------------------------------------------------------------------
// File Tree Schemas
// ---------------------------------------------------------------------------

/**
 * Git status type for a single file, compatible with `@pierre/trees`.
 * Maps the full porcelain v2 status codes down to three types.
 */
export const GitStatusEntry = Schema.Struct({
  path: Schema.String,
  status: Schema.Literal('added', 'deleted', 'modified'),
})

export type GitStatusEntry = typeof GitStatusEntry.Type

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
  // Lifecycle — Deferred service initialization status
  // -----------------------------------------------------------------------

  /**
   * Returns the current initialization status of deferred services.
   *
   * The renderer polls this RPC after reaching Phase 2 (Ready) to detect
   * when all deferred services have initialized, triggering the
   * Restored → Eventually phase transition.
   *
   * This is a streaming RPC: the server immediately emits the current
   * readiness state, then pushes `{ ready: true }` when all deferred
   * services complete initialization. The stream stays open until the
   * client disconnects.
   *
   * @see Issue #15: Server "fully initialized" event
   * @see PRD section: "Server Layer Graph Splitting"
   */
  Rpc.make('lifecycle.initStatus', {
    success: Schema.Struct({
      /** Whether all deferred services have finished initializing. */
      ready: Schema.Boolean,
    }),
    stream: true,
  }),

  // -----------------------------------------------------------------------
  // Docker Prerequisite Detection
  // -----------------------------------------------------------------------
  Rpc.make('docker.status', {
    success: DockerStatusResponse,
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
        agent: Schema.optional(AgentProviderSchema),
        devServer: Schema.optional(
          Schema.Struct({
            autoOpen: Schema.optional(Schema.Boolean),
            autoStopInterval: Schema.optional(Schema.Number),
            image: Schema.optional(Schema.String),
            dockerfile: Schema.optional(Schema.String),
            installCommand: Schema.optional(Schema.String),
            network: Schema.optional(Schema.String),
            port: Schema.optional(Schema.Number),
            provider: Schema.optional(SandboxProviderTypeSchema),
            resources: Schema.optional(SandboxResourcesSchema),
            setupScripts: Schema.optional(Schema.Array(Schema.String)),
            startCommand: Schema.optional(Schema.String),
            workdir: Schema.optional(Schema.String),
          })
        ),
        prdsDir: Schema.optional(Schema.String),
        worktreeDir: Schema.optional(Schema.String),
        setupScripts: Schema.optional(Schema.Array(Schema.String)),
        brrrConfig: Schema.optional(Schema.String),
      }),
    },
  }),

  // -----------------------------------------------------------------------
  // Global Config RPCs
  // -----------------------------------------------------------------------
  Rpc.make('globalConfig.get', {
    success: Schema.Struct({
      agent: Schema.optional(AgentProviderSchema),
    }),
    error: RpcError,
  }),

  Rpc.make('globalConfig.update', {
    error: RpcError,
    payload: {
      config: Schema.Struct({
        agent: Schema.optional(AgentProviderSchema),
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
      force: Schema.optional(Schema.Boolean),
    },
  }),

  Rpc.make('workspace.checkDirty', {
    success: Schema.Array(Schema.String),
    error: RpcError,
    payload: {
      workspaceId: Schema.String,
    },
  }),

  Rpc.make('workspace.refreshPr', {
    success: PrStatusResponse,
    error: RpcError,
    payload: {
      workspaceId: Schema.String,
    },
  }),

  Rpc.make('workspace.refreshSyncStatus', {
    success: WorkspaceSyncStatusResponse,
    error: RpcError,
    payload: {
      workspaceId: Schema.String,
    },
  }),

  Rpc.make('workspace.push', {
    success: WorkspaceSyncStatusResponse,
    error: RpcError,
    payload: {
      workspaceId: Schema.String,
    },
  }),

  Rpc.make('workspace.pull', {
    success: WorkspaceSyncStatusResponse,
    error: RpcError,
    payload: {
      workspaceId: Schema.String,
    },
  }),

  Rpc.make('workspace.startContainer', {
    error: RpcError,
    payload: {
      workspaceId: Schema.String,
    },
  }),

  // -----------------------------------------------------------------------
  // Container RPCs (Issue 10)
  // -----------------------------------------------------------------------
  Rpc.make('container.setPort', {
    error: RpcError,
    payload: {
      workspaceId: Schema.String,
      /** The port number, or null to clear. */
      port: Schema.NullOr(Schema.Int),
    },
  }),

  Rpc.make('container.pause', {
    error: RpcError,
    payload: {
      workspaceId: Schema.String,
    },
  }),

  Rpc.make('container.unpause', {
    error: RpcError,
    payload: {
      workspaceId: Schema.String,
    },
  }),

  // -----------------------------------------------------------------------
  // Sandbox RPCs (provider-agnostic replacements for container/docker RPCs)
  //
  // These are the canonical names going forward. The old container.* and
  // docker.* names above are kept as backward-compatible aliases.
  // -----------------------------------------------------------------------

  Rpc.make('sandbox.providerStatus', {
    success: ProviderStatusResponse,
  }),

  Rpc.make('workspace.startSandbox', {
    error: RpcError,
    payload: {
      workspaceId: Schema.String,
    },
  }),

  Rpc.make('sandbox.setPort', {
    error: RpcError,
    payload: {
      workspaceId: Schema.String,
      /** The port number, or null to clear. */
      port: Schema.NullOr(Schema.Int),
    },
  }),

  Rpc.make('sandbox.pause', {
    error: RpcError,
    payload: {
      workspaceId: Schema.String,
    },
  }),

  Rpc.make('sandbox.resume', {
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
      /**
       * When true and the workspace is containerized, auto-types setup scripts
       * from `laborer.json` followed by the `devServer.startCommand` into the
       * terminal after spawn. Used for dev server terminals.
       */
      autoRun: Schema.optional(Schema.Boolean),
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
  // brrr RPCs
  // -----------------------------------------------------------------------
  Rpc.make('brrr.startLoop', {
    success: TerminalResponse,
    error: RpcError,
    payload: {
      workspaceId: Schema.String,
    },
  }),

  Rpc.make('brrr.review', {
    success: TerminalResponse,
    error: RpcError,
    payload: {
      workspaceId: Schema.String,
    },
  }),

  Rpc.make('brrr.fix', {
    success: TerminalResponse,
    error: RpcError,
    payload: {
      workspaceId: Schema.String,
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
  }),

  // -----------------------------------------------------------------------
  // Review RPCs
  // -----------------------------------------------------------------------

  /**
   * Fetch all PR comments (issue comments + inline review comments) for a
   * workspace's pull request. Returns raw comment data including author info,
   * body, file/line references, and reactions.
   *
   * @see PRD-review-findings-panel.md — "PR Comment Fetcher" section
   */
  Rpc.make('review.fetchComments', {
    success: ReviewFetchCommentsResponse,
    error: RpcError,
    payload: {
      workspaceId: Schema.String,
    },
  }),

  /**
   * Fetch only the review verdict for a workspace's PR. This is a
   * lightweight call that only fetches issue comments (not inline review
   * comments or reactions) and parses the `<!-- brrr-review -->` marker.
   * Used by workspace cards to show a verdict badge without the overhead
   * of fetching all findings and comments.
   *
   * @see PRD-review-findings-panel.md — "Verdict Badge Data Source" section
   */
  Rpc.make('review.fetchVerdict', {
    success: ReviewFetchVerdictResponse,
    error: RpcError,
    payload: {
      workspaceId: Schema.String,
    },
  }),

  /**
   * Add a reaction (e.g. rocket) to an inline review comment on GitHub.
   * Used by the review pane to queue findings for brrr fix.
   *
   * @see PRD-review-findings-panel.md — "Rocket Reaction Service" section
   */
  Rpc.make('review.addReaction', {
    success: PrCommentReaction,
    error: RpcError,
    payload: {
      workspaceId: Schema.String,
      commentId: Schema.Number,
      content: Schema.String,
    },
  }),

  /**
   * Remove a reaction from an inline review comment on GitHub.
   * Used by the review pane to unqueue findings from brrr fix.
   *
   * @see PRD-review-findings-panel.md — "Rocket Reaction Service" section
   */
  Rpc.make('review.removeReaction', {
    error: RpcError,
    payload: {
      workspaceId: Schema.String,
      commentId: Schema.Number,
      reactionId: Schema.Number,
    },
  }),

  // -----------------------------------------------------------------------
  // GitHub OAuth RPCs
  // -----------------------------------------------------------------------

  /**
   * Exchange a GitHub OAuth authorization code for an access token.
   * Uses the GitHub Desktop dev OAuth App credentials (public, open-source).
   * The client_secret is kept server-side.
   */
  Rpc.make('github.exchangeOAuthCode', {
    success: Schema.Struct({
      accessToken: Schema.String,
      scope: Schema.String,
      tokenType: Schema.String,
    }),
    error: RpcError,
    payload: {
      code: Schema.String,
    },
  }),

  // -----------------------------------------------------------------------
  // Alive-driven individual fetch RPCs
  // -----------------------------------------------------------------------

  /**
   * Fetch a single issue comment by ID, applying brrr finding/verdict parsing.
   * Used by Alive event handler when a `pr-comment` (subtype: issue-comment)
   * event arrives, avoiding a full fetchComments round-trip.
   */
  Rpc.make('review.fetchSingleIssueComment', {
    success: Schema.Struct({
      comment: PrComment,
      /** Non-null if this comment is the brrr review summary. */
      verdict: Schema.NullOr(ReviewVerdict),
    }),
    error: RpcError,
    payload: {
      workspaceId: Schema.String,
      commentId: Schema.Number,
    },
  }),

  /**
   * Fetch a single PR review comment (inline) by ID, applying brrr finding
   * parsing. Returns either a plain comment or a structured finding.
   */
  Rpc.make('review.fetchSingleReviewComment', {
    success: Schema.Union(
      Schema.Struct({
        kind: Schema.Literal('comment'),
        comment: PrComment,
      }),
      Schema.Struct({
        kind: Schema.Literal('finding'),
        finding: ReviewFinding,
      })
    ),
    error: RpcError,
    payload: {
      workspaceId: Schema.String,
      commentId: Schema.Number,
    },
  }),

  /**
   * Fetch a single PR review by ID. Returns the review state which can be
   * used to update the verdict badge immediately.
   */
  Rpc.make('review.fetchSingleReview', {
    success: Schema.Struct({
      reviewId: Schema.Number,
      state: Schema.String,
      authorLogin: Schema.String,
      body: Schema.String,
    }),
    error: RpcError,
    payload: {
      workspaceId: Schema.String,
      reviewId: Schema.Number,
    },
  }),

  // -----------------------------------------------------------------------
  // File Service RPCs (Lazy File Service)
  // -----------------------------------------------------------------------

  /**
   * List a single directory level from a workspace's worktree.
   *
   * Returns `FileNode[]` sorted directories-first, then alphabetically.
   * Noisy directories (node_modules, .git, dist, build, etc.) and OS
   * metadata files (.DS_Store, Thumbs.db) are skipped. When `dir` is
   * omitted, lists the worktree root.
   *
   * @see PRD: Lazy File Service — file.list RPC
   */
  Rpc.make('file.list', {
    success: Schema.Array(FileNode),
    error: RpcError,
    payload: {
      workspaceId: Schema.String,
      dir: Schema.optional(Schema.String),
    },
  }),

  /**
   * Read a single file's content from a workspace's worktree and compute
   * its diff against HEAD.
   *
   * Returns `FileContent` with the file's text (or base64 for images),
   * plus optional diff and structured patch if the file has changes.
   * Binary files are detected by extension and returned with `type: "binary"`
   * and empty content. Non-existent files return `type: "text"` with empty
   * content.
   *
   * @see PRD: Lazy File Service — file.read RPC
   * @see Issue 3: file.read — On-demand file content with per-file diff
   */
  Rpc.make('file.read', {
    success: FileContent,
    error: RpcError,
    payload: {
      workspaceId: Schema.String,
      filePath: Schema.String,
    },
  }),

  /**
   * Return a summary of all changed files in a workspace with line-level
   * change counts.
   *
   * Runs three git commands in parallel:
   * - `git diff --numstat HEAD` for modified files with line counts
   * - `git ls-files --others --exclude-standard` for untracked (added) files
   * - `git diff --name-only --diff-filter=D HEAD` for deleted files
   *
   * Returns `FileInfo[]` where each entry has a relative path, added/removed
   * line counts, and a status of "added", "deleted", or "modified".
   *
   * @see PRD: Lazy File Service — file.status RPC
   * @see Issue 4: file.status — Workspace-level changed file summary
   */
  Rpc.make('file.status', {
    success: Schema.Array(FileInfo),
    error: RpcError,
    payload: {
      workspaceId: Schema.String,
    },
  }),

  /**
   * Streaming RPC that forwards file change events for a workspace's worktree.
   *
   * Subscribes a recursive file watcher on the workspace's worktree via
   * the file-watcher sidecar. Events are streamed as `FileWatcherEvent`
   * objects with paths relative to the worktree root. The client uses
   * these events for invalidation only — not for data.
   *
   * On stream teardown (client disconnect), the file watcher subscription
   * is automatically cleaned up.
   *
   * @see PRD: Lazy File Service — Watcher Event Stream
   * @see Issue 5: file.watcher.subscribe — Per-workspace watcher event stream
   */
  Rpc.make('file.watcher.subscribe', {
    success: FileWatcherEvent,
    error: RpcError,
    stream: true,
    payload: {
      workspaceId: Schema.String,
    },
  })
) {}

// ---------------------------------------------------------------------------
// File Watcher Service RPC Contract
// ---------------------------------------------------------------------------
// The file-watcher service runs as a separate HTTP server process. These RPCs
// define the contract between the server (or any client) and the file-watcher
// service. Defined here in @laborer/shared so both @laborer/server and
// @laborer/file-watcher can import the same types.
//
// @see PRD-file-watcher-extraction.md
// ---------------------------------------------------------------------------

/**
 * Tagged error type for file-watcher service RPC operations.
 *
 * Error codes:
 * - `SUBSCRIBE_FAILED` — failed to start watching a path
 * - `NOT_FOUND` — no subscription with the given ID
 * - `INTERNAL_ERROR` — unexpected internal failure
 */
export class FileWatcherRpcError extends Schema.TaggedError<FileWatcherRpcError>()(
  'FileWatcherRpcError',
  {
    message: Schema.String,
    code: Schema.optional(Schema.String),
  }
) {}

/**
 * Information about an active watch subscription.
 */
export const WatchSubscriptionInfo = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  recursive: Schema.Boolean,
  ignoreGlobs: Schema.Array(Schema.String),
})

export type WatchSubscriptionInfo = typeof WatchSubscriptionInfo.Type

/**
 * A normalized file event emitted by the file-watcher service.
 *
 * Events are classified as add/change/delete. When the native
 * `@parcel/watcher` backend is active, classification is authoritative.
 * When the `fs.watch` fallback is in use, add/delete are inferred from
 * `existsSync` checks and should be treated as best-effort.
 */
export const WatchFileEvent = Schema.Struct({
  /** Which subscription generated this event */
  subscriptionId: Schema.String,
  /** The type of file change */
  type: Schema.Literal('add', 'change', 'delete'),
  /** Relative path of the changed file within the watched directory */
  fileName: Schema.NullOr(Schema.String),
  /** Absolute path of the changed file */
  absolutePath: Schema.String,
})

export type WatchFileEvent = typeof WatchFileEvent.Type

/**
 * RPC group for the standalone file-watcher service (`@laborer/file-watcher`).
 *
 * Endpoints:
 * - `watcher.subscribe` — start watching a directory path
 * - `watcher.unsubscribe` — stop watching by subscription ID
 * - `watcher.updateIgnore` — update ignore patterns for an active subscription
 * - `watcher.list` — list all active subscriptions
 * - `watcher.events` — streaming endpoint pushing file change events
 *
 * @see PRD-file-watcher-extraction.md
 */
export class FileWatcherRpcs extends RpcGroup.make(
  // -----------------------------------------------------------------------
  // watcher.subscribe — start watching a directory
  // -----------------------------------------------------------------------
  Rpc.make('watcher.subscribe', {
    success: WatchSubscriptionInfo,
    error: FileWatcherRpcError,
    payload: {
      /** Absolute path of the directory to watch. */
      path: Schema.String,
      /** Whether to watch recursively (default true). */
      recursive: Schema.optional(Schema.Boolean),
      /** Glob patterns to ignore (e.g. "node_modules/**"). */
      ignoreGlobs: Schema.optional(Schema.Array(Schema.String)),
    },
  }),

  // -----------------------------------------------------------------------
  // watcher.unsubscribe — stop watching by subscription ID
  // -----------------------------------------------------------------------
  Rpc.make('watcher.unsubscribe', {
    error: FileWatcherRpcError,
    payload: {
      id: Schema.String,
    },
  }),

  // -----------------------------------------------------------------------
  // watcher.updateIgnore — update ignore patterns for a subscription
  // -----------------------------------------------------------------------
  Rpc.make('watcher.updateIgnore', {
    error: FileWatcherRpcError,
    payload: {
      id: Schema.String,
      ignoreGlobs: Schema.Array(Schema.String),
    },
  }),

  // -----------------------------------------------------------------------
  // watcher.list — list all active subscriptions
  // -----------------------------------------------------------------------
  Rpc.make('watcher.list', {
    success: Schema.Array(WatchSubscriptionInfo),
    error: FileWatcherRpcError,
  }),

  // -----------------------------------------------------------------------
  // watcher.events — streaming file change events
  // -----------------------------------------------------------------------
  /**
   * Streaming RPC that pushes normalized file change events as they occur.
   *
   * Events include: add, change, delete with file path and subscription ID.
   * The stream stays open until the client disconnects.
   */
  Rpc.make('watcher.events', {
    success: WatchFileEvent,
    error: FileWatcherRpcError,
    stream: true,
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
 * Category of a detected foreground process.
 *
 * - `agent` — AI coding agents (claude, opencode, codex, aider, etc.)
 * - `editor` — Text editors (vim, nvim, nano, emacs, helix, etc.)
 * - `devServer` — Dev servers, runtimes, build tools (node, bun, python, etc.)
 * - `shell` — The shell itself (zsh, bash, fish) — means idle at prompt
 * - `unknown` — A process is running but not in the known list
 */
export const ProcessCategorySchema = Schema.Literal(
  'agent',
  'editor',
  'devServer',
  'shell',
  'unknown'
)

export type ProcessCategory = typeof ProcessCategorySchema.Type

/**
 * Information about the foreground process running in a terminal.
 * Used by the sidebar to show what's actually happening in each terminal.
 */
export const ForegroundProcessSchema = Schema.Struct({
  /** The category of the detected process. */
  category: ProcessCategorySchema,
  /** Human-readable label for display (e.g., "Claude", "vim", "Node.js"). */
  label: Schema.String,
  /** Raw process name from ps (e.g., "claude", "nvim", "node"). */
  rawName: Schema.String,
})

export type ForegroundProcess = typeof ForegroundProcessSchema.Type

/**
 * Agent status for a terminal, derived from foreground process transitions.
 *
 * - `active` — an AI agent is currently the foreground process
 * - `waiting_for_input` — an agent was running but is now idle
 *   (needs user input or has completed its task)
 */
export const AgentStatusSchema = Schema.Literal('active', 'waiting_for_input')

export type AgentStatus = typeof AgentStatusSchema.Type

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
  /**
   * Agent status derived from foreground process transitions.
   * Null when no agent has been detected in this terminal.
   */
  agentStatus: Schema.NullOr(AgentStatusSchema),
  /**
   * Information about the foreground process running in the terminal.
   * Null when the shell is idle at a prompt or the terminal is stopped.
   */
  foregroundProcess: Schema.NullOr(ForegroundProcessSchema),
  /**
   * Whether the shell has child processes running (e.g., vim, dev server,
   * opencode). False when the shell is idle at a prompt. Used by the UI
   * to decide whether to show a close confirmation dialog.
   */
  hasChildProcess: Schema.Boolean,
  /**
   * Classified processes along the tree from the shell's first child
   * down to the deepest leaf. Used by the UI to show the full chain,
   * e.g. "OpenCode › biome". Empty when the shell is idle or stopped.
   */
  processChain: Schema.Array(ForegroundProcessSchema),
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
      /** Shell command to execute (e.g., "bash", "opencode", "brrr build --once"). */
      command: Schema.String,
      /** Command arguments (optional, default []). */
      args: Schema.optional(Schema.Array(Schema.String)),
      /** Working directory for the PTY process. */
      cwd: Schema.String,
      /** Environment variables to inject into the PTY process. */
      env: Schema.optional(
        Schema.Record({ key: Schema.String, value: Schema.String })
      ),
      /**
       * Optional pre-generated terminal ID. When provided, the terminal
       * manager uses this ID instead of generating a new UUID. Allows the
       * caller to inject the terminal ID into the environment before spawn
       * (needed for agent hook scripts to identify their terminal).
       */
      id: Schema.optional(Schema.String),
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
  // terminal.setAgentStatus — external hook status override
  // -----------------------------------------------------------------------
  /**
   * Set agent status for a terminal from an external hook.
   *
   * Called by the server-side HTTP hook proxy when an agent CLI
   * (opencode, claude) reports a lifecycle transition. The agent
   * POSTs to a lightweight HTTP endpoint in the server process,
   * which forwards the event here via RPC.
   *
   * - `'active'` — agent is processing / busy
   * - `'waiting_for_input'` — agent finished, needs user input
   * - `'clear'` — remove hook override, revert to ps-based detection
   */
  Rpc.make('terminal.setAgentStatus', {
    error: TerminalRpcError,
    payload: {
      id: Schema.String,
      event: Schema.Literal('active', 'waiting_for_input', 'clear'),
    },
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
