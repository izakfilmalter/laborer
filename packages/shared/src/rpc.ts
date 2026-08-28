import { Schema } from 'effect'
import { Rpc, RpcGroup } from 'effect/unstable/rpc'
import {
  BrowserAnnotation,
  BrowserContextError,
  BrowserContextItem,
  BrowserControlError,
  BrowserControlEvent,
  BrowserControlHost,
  BrowserControlOperation,
  BrowserControlResponse,
} from './browser-control.js'
import { SLACK_MESSAGE_URL_MAX_LENGTH } from './slack-url.js'
import { TerminalStatus, WorkspaceStatus } from './types.js'

const APP_SETTING_KEY_MAX_LENGTH = 128
const APP_SETTING_VALUE_MAX_LENGTH = 16_384
export const OPERATION_ID_MAX_LENGTH = 128
export const OperationId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(OPERATION_ID_MAX_LENGTH)
)
export type OperationId = typeof OperationId.Type
const PRESENCE_CLIENT_ID_MAX_LENGTH = 128
const PRESENCE_WORKSPACE_ID_MAX_LENGTH = 1000
const PRESENCE_WORKSPACE_MAX_ITEMS = 1000

/** Longest label name accepted at the RPC, MCP, and persistence boundaries. */
export const LABEL_NAME_MAX_LENGTH = 60

/** An integer greater than or equal to zero at RPC and persistence boundaries. */
export const NonNegativeInt = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0)
)

/** An integer strictly greater than zero at RPC and persistence boundaries. */
export const PositiveInt = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThan(0)
)

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
export const TerminalLifecycleEventSchema = Schema.Union([
  TerminalSpawnedEvent,
  TerminalStatusChangedEvent,
  TerminalExitedEvent,
  TerminalRemovedEvent,
  TerminalRestartedEvent,
  TerminalProcessChangedEvent,
])

export type TerminalLifecycleEventSchema =
  typeof TerminalLifecycleEventSchema.Type

/** Ordered terminal data carried by the daemon's single WebSocket. */
export const TerminalAttachEvent = Schema.Union([
  Schema.TaggedStruct('Snapshot', {
    cursor: NonNegativeInt,
    data: Schema.String,
  }),
  Schema.TaggedStruct('Delta', {
    cursor: NonNegativeInt,
    data: Schema.String,
  }),
  Schema.TaggedStruct('Meta', {
    epoch: Schema.String,
    status: Schema.Literals(['running', 'stopped']),
  }),
  Schema.TaggedStruct('ReplayComplete', {}),
  Schema.TaggedStruct('Reset', {
    epoch: Schema.String,
    reason: Schema.Literals(['epoch_changed', 'cursor_out_of_range']),
  }),
  Schema.TaggedStruct('Exit', {
    exitCode: Schema.Int,
    signal: Schema.Int,
  }),
])

export type TerminalAttachEvent = typeof TerminalAttachEvent.Type

/** Daemon-observed health of the detached terminal host process. */
export const TerminalHostStatus = Schema.Struct({
  expectedVersion: Schema.String,
  runningVersion: Schema.optional(Schema.String),
  state: Schema.Literals([
    'healthy',
    'warning',
    'unresponsive',
    'outdated',
    'restarting',
    'unavailable',
  ]),
})

export type TerminalHostStatus = typeof TerminalHostStatus.Type

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
})

export type ProjectResponse = typeof ProjectResponse.Type

export const StoredTaskStatus = Schema.Literals([
  'todo',
  'in_progress',
  'in_review',
  'done',
  'cancelled',
])

export const BoardTask = Schema.Struct({
  actionName: Schema.NullOr(Schema.String),
  branchName: Schema.NullOr(Schema.String),
  createdAt: Schema.Int,
  executionId: Schema.NullOr(Schema.String),
  executionStatus: Schema.NullOr(
    Schema.Literals([
      'queued',
      'running',
      'cancelling',
      'completed',
      'failed',
      'cancelled',
      'needs-attention',
    ])
  ),
  id: Schema.String,
  description: Schema.NullOr(Schema.String),
  /** Ids of the labels applied to this task, in application order. */
  labelIds: Schema.Array(Schema.String),
  revision: Schema.Int,
  rootPath: Schema.String,
  slackPermalink: Schema.NullOr(Schema.String),
  source: Schema.Literals([
    'execution',
    'manual',
    'slack_url',
    'agent',
    'worktree',
  ]),
  status: StoredTaskStatus,
  taskNumber: Schema.Int,
  title: Schema.String,
  updatedAt: Schema.Int,
  worktreeBotOwned: Schema.Boolean,
  worktreeExists: Schema.Boolean,
  worktreePath: Schema.NullOr(Schema.String),
})

export type BoardTask = typeof BoardTask.Type

export const TaskBoardEvent = Schema.Union([
  Schema.TaggedStruct('snapshot', {
    cursor: Schema.Int,
    tasks: Schema.Array(BoardTask),
  }),
  Schema.TaggedStruct('delta', {
    cursor: Schema.Int,
    deletedTaskIds: Schema.Array(Schema.String),
    tasks: Schema.Array(BoardTask),
  }),
])

export type TaskBoardEvent = typeof TaskBoardEvent.Type

/**
 * One check behind a pull request's rolled-up check status. The rollup says
 * whether to worry; these say what to look at.
 */
export const PullRequestCheckRun = Schema.Struct({
  bucket: Schema.Literals([
    'success',
    'failure',
    'pending',
    'skipped',
    'cancelled',
  ]),
  durationMs: Schema.NullOr(Schema.Finite),
  group: Schema.NullOr(Schema.String),
  name: Schema.String,
  url: Schema.NullOr(Schema.String),
})
export type PullRequestCheckRun = typeof PullRequestCheckRun.Type

/**
 * GitHub's rolled-up verdict on a pull request's reviews.
 *
 * It is not the same question as "who said what": a reviewer who approved
 * and was then overruled by a later change request still shows as approving
 * in the timeline, while the decision reads `changesRequested`, because the
 * decision is what the merge button obeys.
 */
export const PullRequestReviewDecision = Schema.Literals([
  'approved',
  'changesRequested',
  'reviewRequired',
])
export type PullRequestReviewDecision = typeof PullRequestReviewDecision.Type

/**
 * An open pull request on the remote, described well enough to show it in the
 * sidebar and to pull it in.
 *
 * This is deliberately not a task row. A pull request nobody has checked out
 * has no worktree, no terminals, and no local status; the only things it can
 * honestly claim are the ones GitHub told us. Once it is pulled in, the
 * workspace it becomes is what the sidebar shows instead.
 */
export const OpenPullRequest = Schema.Struct({
  /** The login that opened it, which is the heading it is filed under. */
  authorLogin: Schema.String,
  /** The pull request body, shown as the card's description on hover. */
  body: Schema.NullOr(Schema.String),
  /** The head branch — what pulling this in checks out. */
  branchName: Schema.String,
  isDraft: Schema.Boolean,
  number: Schema.Number,
  title: Schema.String,
  url: Schema.String,
})
export type OpenPullRequest = typeof OpenPullRequest.Type

/** Authoritative shared-database task row plus server-only worktree facts. */
export const SharedTaskRow = Schema.Struct({
  ...BoardTask.fields,
  baseBranch: Schema.NullOr(Schema.String),
  baseSha: Schema.NullOr(Schema.String),
  parentTaskId: Schema.NullOr(Schema.String),
  prIsDraft: Schema.Boolean,
  /**
   * GitHub login of whoever opened the pull request on this branch. Null when
   * the branch has no pull request; that is "unattributed", not "mine".
   */
  prAuthorLogin: Schema.NullOr(Schema.String),
  prBaseBranch: Schema.NullOr(Schema.String),
  prCheckStatus: Schema.NullOr(
    Schema.Literals(['pending', 'success', 'failure'])
  ),
  prChecks: Schema.NullOr(Schema.Array(PullRequestCheckRun)),
  prMergeStatus: Schema.NullOr(
    Schema.Literals(['clean', 'conflicting', 'unknown'])
  ),
  prNumber: Schema.NullOr(Schema.Int),
  /**
   * How many reviewers' standing opinion is an approval. Null means unread
   * rather than unapproved.
   */
  prApprovals: Schema.NullOr(NonNegativeInt),
  prReviewDecision: Schema.NullOr(PullRequestReviewDecision),
  prState: Schema.NullOr(Schema.Literals(['open', 'closed', 'merged'])),
  prTitle: Schema.NullOr(Schema.String),
  /**
   * Review threads still awaiting resolution. Null means unread rather than
   * settled: a closed pull request, or a branch that never had one.
   */
  prUnresolvedThreads: Schema.NullOr(Schema.Int),
  prUrl: Schema.NullOr(Schema.String),
  setupCompletedAt: Schema.NullOr(Schema.Int),
  sortOrder: Schema.NullOr(Schema.Finite),
  worktreeError: Schema.NullOr(Schema.String),
  worktreeStatus: Schema.NullOr(
    Schema.Literals(['provisioning', 'ready', 'errored'])
  ),
})
export type SharedTaskRow = typeof SharedTaskRow.Type

export const SharedProjectRow = Schema.Struct({
  branchName: Schema.NullOr(Schema.String),
  canonicalGitCommonDir: Schema.String,
  createdAt: Schema.Int,
  id: Schema.String,
  name: Schema.String,
  repoId: Schema.String,
  revision: Schema.Int,
  rootPath: Schema.String,
  /** Manual rank. Null means unranked; ordering then falls back to createdAt. */
  sortOrder: Schema.NullOr(Schema.Finite),
  updatedAt: Schema.Int,
})
export type SharedProjectRow = typeof SharedProjectRow.Type

export const SharedSettingRow = Schema.Struct({
  createdAt: Schema.Int,
  key: Schema.String,
  revision: Schema.Int,
  updatedAt: Schema.Int,
  value: Schema.String,
})
export type SharedSettingRow = typeof SharedSettingRow.Type

/**
 * Label palette token. Tailwind needs literal class strings, so the token ->
 * class mapping lives in the renderer; this is the durable vocabulary.
 */
export const LabelColor = Schema.Literals([
  'red',
  'orange',
  'amber',
  'emerald',
  'teal',
  'blue',
  'violet',
  'pink',
])
export type LabelColor = typeof LabelColor.Type

/** A label, shared app-wide across every project. */
export const SharedLabelRow = Schema.Struct({
  color: LabelColor,
  createdAt: Schema.Int,
  id: Schema.String,
  name: Schema.String,
  revision: Schema.Int,
  updatedAt: Schema.Int,
})
export type SharedLabelRow = typeof SharedLabelRow.Type

// ---------------------------------------------------------------------------
// Review Comment Schemas
// ---------------------------------------------------------------------------

/** Longest review comment body accepted at every boundary. */
export const REVIEW_COMMENT_BODY_MAX_LENGTH = 10_000

/** Which half of the diff a review comment's line range names. */
export const ReviewCommentSide = Schema.Literals(['additions', 'deletions'])

export type ReviewCommentSide = typeof ReviewCommentSide.Type

/**
 * Where a review conversation stands. `resolved` means the request it carries
 * has actually been addressed, not merely read.
 */
export const ReviewCommentStatus = Schema.Literals(['open', 'resolved'])

export type ReviewCommentStatus = typeof ReviewCommentStatus.Type

/**
 * Who wrote a reply. This is a fact about the boundary that persisted it, not
 * a claim any payload makes: no request schema carries an author. Web clients
 * write `human` through the `reviewComment.*` RPCs; the coding agent writes
 * `agent` through the per-workspace MCP server.
 */
export const ReviewCommentAuthor = Schema.Literals(['human', 'agent'])

export type ReviewCommentAuthor = typeof ReviewCommentAuthor.Type

/** One message in a review conversation. */
export const ReviewCommentReply = Schema.Struct({
  /** Set by the boundary that wrote it, never claimed by its payload. */
  author: ReviewCommentAuthor,
  /** Markdown text. */
  body: Schema.String,
  createdAt: Schema.Int,
  id: Schema.String,
  threadId: Schema.String,
})

export type ReviewCommentReply = typeof ReviewCommentReply.Type

/**
 * A review conversation anchored to a line range of a changed file in a
 * workspace — the in-app equivalent of a GitHub review thread.
 *
 * The thread is durable because the coding agent reads it, and answers it,
 * through the per-workspace `laborer-current` MCP server rather than through
 * any chat transcript.
 */
export const ReviewCommentThread = Schema.Struct({
  createdAt: Schema.Int,
  /** Last line of the anchor, inclusive. Equals `startLine` for one line. */
  endLine: PositiveInt,
  /** Path relative to the worktree root, as the diff viewer reports it. */
  filePath: Schema.String,
  id: Schema.String,
  /** Every message so far, oldest first. Never empty. */
  replies: Schema.Array(ReviewCommentReply),
  revision: PositiveInt,
  side: ReviewCommentSide,
  startLine: PositiveInt,
  status: ReviewCommentStatus,
  updatedAt: Schema.Int,
  workspaceId: Schema.String,
})

export type ReviewCommentThread = typeof ReviewCommentThread.Type

const ReviewCommentBody = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(REVIEW_COMMENT_BODY_MAX_LENGTH)
)

const tableUpdate = <Row extends Schema.Top>(row: Row) =>
  Schema.Union([
    Schema.Struct({
      type: Schema.Literal('snapshot'),
      cursor: Schema.Int,
      rows: Schema.Array(row),
    }),
    Schema.Struct({
      type: Schema.Literal('delta'),
      cursor: Schema.Int,
      deletedRowIds: Schema.Array(Schema.String),
      /** Laborer operation ids whose authoritative rows are in this delta. */
      operationIds: Schema.optional(Schema.Array(Schema.String)),
      rows: Schema.Array(row),
    }),
  ])

export const TaskTableUpdate = tableUpdate(SharedTaskRow)
export type TaskTableUpdate = typeof TaskTableUpdate.Type
export const ProjectTableUpdate = tableUpdate(SharedProjectRow)
export type ProjectTableUpdate = typeof ProjectTableUpdate.Type
export const SettingTableUpdate = tableUpdate(SharedSettingRow)
export type SettingTableUpdate = typeof SettingTableUpdate.Type
export const LabelTableUpdate = tableUpdate(SharedLabelRow)
export type LabelTableUpdate = typeof LabelTableUpdate.Type
/**
 * Review conversations travel whole: a thread row carries its reply chain, so
 * an appended reply publishes as an updated thread rather than as a row of a
 * second, separately-cursored table.
 */
export const ReviewCommentTableUpdate = tableUpdate(ReviewCommentThread)
export type ReviewCommentTableUpdate = typeof ReviewCommentTableUpdate.Type

/** One stream, with task_changes and state_changes advancing independently. */
export const SharedStateUpdate = Schema.Struct({
  labels: Schema.optional(LabelTableUpdate),
  projects: Schema.optional(ProjectTableUpdate),
  reviewComments: Schema.optional(ReviewCommentTableUpdate),
  settings: Schema.optional(SettingTableUpdate),
  tasks: Schema.optional(TaskTableUpdate),
})
export type SharedStateUpdate = typeof SharedStateUpdate.Type

const ConfigResolvedValueString = Schema.Struct({
  value: Schema.String,
  source: Schema.String,
})

const ConfigResolvedValueStringArray = Schema.Struct({
  value: Schema.Array(Schema.String),
  source: Schema.String,
})

export const AgentProviderSchema = Schema.Literals([
  'opencode2',
  'claude',
  'codex',
])

export type AgentProvider = typeof AgentProviderSchema.Type

const ConfigResolvedValueAgent = Schema.Struct({
  value: AgentProviderSchema,
  source: Schema.String,
})

const ConfigResponse = Schema.Struct({
  agent: ConfigResolvedValueAgent,
  /**
   * Prompt handed to a fresh agent when an operator acts on the merge
   * conflict mark. Empty means the project has not configured one.
   */
  conflictPrompt: ConfigResolvedValueString,
  shortName: ConfigResolvedValueString,
  shortNameAliases: ConfigResolvedValueStringArray,
  worktreeDir: ConfigResolvedValueString,
  setupScripts: ConfigResolvedValueStringArray,
  /** Configured local preview URLs from the owning laborer.json layer. */
  previewUrls: ConfigResolvedValueStringArray,
  watchIgnore: ConfigResolvedValueStringArray,
})

const WorkspaceResponse = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  branchName: Schema.String,
  worktreePath: Schema.String,
  status: WorkspaceStatus,
})

const SlackWorkspacePlanResponse = Schema.Struct({
  branchName: Schema.String,
  initialPrompt: Schema.String,
  title: Schema.String,
  workType: Schema.Literals(['bug', 'feature']),
})

const TerminalResponse = Schema.Struct({
  id: Schema.String,
  workspaceId: Schema.String,
  command: Schema.String,
  status: Schema.Literals(['running', 'stopped']),
})

const PrStatusResponse = Schema.Struct({
  number: Schema.NullOr(Schema.Int),
  state: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
})

const WorkspaceSyncStatusResponse = Schema.Struct({
  aheadCount: Schema.NullOr(Schema.Int),
  behindCount: Schema.NullOr(Schema.Int),
  /**
   * Whether the worktree has uncommitted work — tracked edits or untracked
   * files. It rides along with the ahead/behind counts because one
   * `git status --porcelain=v2 --branch` answers both, and the git action
   * button needs all three to know whether its next step is a commit.
   */
  hasChanges: Schema.Boolean,
  /** Whether the branch tracks an upstream, so a plain `git push` resolves. */
  hasUpstream: Schema.Boolean,
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
  type: Schema.Literals(['file', 'directory']),
  /** Whether this entry matches a gitignore/ignore pattern. */
  ignored: Schema.Boolean,
})

export type FileNode = typeof FileNode.Type

/**
 * One entry in the recursive worktree listing returned by
 * `file.listEntries`.
 *
 * Modeled on t3code's `ProjectEntry`: the explorer's tree component wants a
 * flat list of relative paths tagged file-or-directory, not a nested
 * structure or per-level pages.
 */
export const FileEntry = Schema.Struct({
  /** Path relative to the worktree root. */
  path: Schema.String,
  /** Whether this entry is a file or directory. */
  kind: Schema.Literals(['file', 'directory']),
})

export type FileEntry = typeof FileEntry.Type

/**
 * The recursive worktree listing returned by `file.listEntries`.
 *
 * `truncated` is the server admitting it stopped walking at the entry cap;
 * the explorer can render what it has and say the listing is partial.
 */
export const FileEntriesResult = Schema.Struct({
  entries: Schema.Array(FileEntry),
  truncated: Schema.Boolean,
})

export type FileEntriesResult = typeof FileEntriesResult.Type

/**
 * A text file's verbatim contents returned by `file.readText`.
 *
 * Modeled on t3code's `ProjectReadFileResult`: unlike {@link FileContent}
 * (which trims and pairs the text with a diff), this is what an editor
 * surface needs — the exact bytes as UTF-8, the file's true size, and an
 * honest flag when the preview cap cut the text short.
 */
export const FileTextContent = Schema.Struct({
  /** Path relative to the worktree root, echoed back. */
  relativePath: Schema.String,
  /** UTF-8 contents, verbatim up to the preview cap. */
  contents: Schema.String,
  /** The file's full size in bytes, even when truncated. */
  byteLength: NonNegativeInt,
  /** True when `contents` stops at the preview cap before the file does. */
  truncated: Schema.Boolean,
})

export type FileTextContent = typeof FileTextContent.Type

/** Acknowledgement returned by `file.write`. */
export const FileWriteResult = Schema.Struct({
  /** Path relative to the worktree root, echoed back. */
  relativePath: Schema.String,
})

export type FileWriteResult = typeof FileWriteResult.Type

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
  event: Schema.Literals(['add', 'change', 'unlink']),
})

export type FileWatcherEvent = typeof FileWatcherEvent.Type

// ---------------------------------------------------------------------------
// Browser Preview Schemas
// ---------------------------------------------------------------------------

export const PREVIEW_URL_MAX_LENGTH = 2048
export const CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS = 32

const PreviewUrl = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(PREVIEW_URL_MAX_LENGTH)
)

const PreviewWorkspaceId = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1)
)

export const ConfiguredLocalServerUrls = Schema.Array(PreviewUrl).check(
  Schema.isMaxLength(CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS)
)

export const PreviewTabId = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(128)
)
export type PreviewTabId = typeof PreviewTabId.Type

export const PREVIEW_VIEWPORT_MIN_DIMENSION = 240
export const PREVIEW_VIEWPORT_MAX_DIMENSION = 3840
export const PREVIEW_VIEWPORT_MAX_AREA = 3840 * 2160

const PreviewViewportDimension = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(PREVIEW_VIEWPORT_MIN_DIMENSION),
  Schema.isLessThanOrEqualTo(PREVIEW_VIEWPORT_MAX_DIMENSION)
)

const previewViewportArea = Schema.makeFilter(
  ({ width, height }: { readonly height: number; readonly width: number }) =>
    width * height <= PREVIEW_VIEWPORT_MAX_AREA ||
    `Viewport area must not exceed ${String(PREVIEW_VIEWPORT_MAX_AREA)} pixels.`
)

export const PreviewViewportSize = Schema.Struct({
  height: PreviewViewportDimension,
  width: PreviewViewportDimension,
}).check(previewViewportArea)
export type PreviewViewportSize = typeof PreviewViewportSize.Type

export const PreviewRenderedViewportSize = Schema.Struct({
  height: Schema.Int.check(Schema.isGreaterThan(0)),
  width: Schema.Int.check(Schema.isGreaterThan(0)),
})
export type PreviewRenderedViewportSize =
  typeof PreviewRenderedViewportSize.Type

export const PREVIEW_VIEWPORT_PRESET_IDS = [
  'iphone-se',
  'iphone-xr',
  'iphone-12-pro',
  'iphone-14-pro-max',
  'pixel-7',
  'samsung-galaxy-s8-plus',
  'samsung-galaxy-s20-ultra',
  'ipad-mini',
  'ipad-air',
  'ipad-pro',
  'surface-pro-7',
  'surface-duo',
  'galaxy-z-fold-5',
  'asus-zenbook-fold',
  'samsung-galaxy-a51-71',
  'nest-hub',
  'nest-hub-max',
] as const

export const PreviewViewportPresetId = Schema.Literals(
  PREVIEW_VIEWPORT_PRESET_IDS
)
export type PreviewViewportPresetId = typeof PreviewViewportPresetId.Type

const StoredPreviewViewportPresetId = Schema.Literals([
  ...PREVIEW_VIEWPORT_PRESET_IDS,
  'desktop-1920x1080',
  'desktop-1440x900',
  'laptop-1366x768',
  'laptop-1280x800',
  'ipad-pro-11',
  'iphone-15-pro',
  'pixel-8',
  'galaxy-s24',
])

export const PreviewViewportSetting = Schema.Union([
  Schema.TaggedStruct('fill', {}),
  Schema.TaggedStruct('freeform', {
    ...PreviewViewportSize.fields,
  }).check(previewViewportArea),
  Schema.TaggedStruct('preset', {
    ...PreviewViewportSize.fields,
    presetId: StoredPreviewViewportPresetId,
  }).check(previewViewportArea),
])
export type PreviewViewportSetting = typeof PreviewViewportSetting.Type

export const FILL_PREVIEW_VIEWPORT = {
  _tag: 'fill',
} as const satisfies PreviewViewportSetting

export const PREVIEW_ZOOM_LEVELS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4,
  5,
] as const
export const PreviewZoomFactor = Schema.Literals(PREVIEW_ZOOM_LEVELS)
export type PreviewZoomFactor = typeof PreviewZoomFactor.Type
export const DEFAULT_PREVIEW_ZOOM_FACTOR: PreviewZoomFactor = 1

export const PreviewAppearancePreference = Schema.Literals([
  'system',
  'light',
  'dark',
])
export type PreviewAppearancePreference =
  typeof PreviewAppearancePreference.Type
export const DEFAULT_PREVIEW_APPEARANCE: PreviewAppearancePreference = 'system'

const PreviewTitle = Schema.String.check(Schema.isMaxLength(512))

export const PreviewNavStatus = Schema.Union([
  Schema.TaggedStruct('Idle', {}),
  Schema.TaggedStruct('Loading', {
    title: PreviewTitle,
    url: PreviewUrl,
  }),
  Schema.TaggedStruct('Success', {
    title: PreviewTitle,
    url: PreviewUrl,
  }),
  Schema.TaggedStruct('LoadFailed', {
    code: Schema.Int,
    description: Schema.String,
    title: PreviewTitle,
    url: PreviewUrl,
  }),
])
export type PreviewNavStatus = typeof PreviewNavStatus.Type

export const PreviewSessionSnapshot = Schema.Struct({
  canGoBack: Schema.Boolean,
  canGoForward: Schema.Boolean,
  navStatus: PreviewNavStatus,
  tabId: PreviewTabId,
  updatedAt: Schema.String,
  viewport: Schema.optional(PreviewViewportSetting),
  workspaceId: PreviewWorkspaceId,
})
export type PreviewSessionSnapshot = typeof PreviewSessionSnapshot.Type

export const PreviewOpenInput = Schema.Struct({
  url: Schema.optional(PreviewUrl),
  viewport: Schema.optional(PreviewViewportSetting),
  workspaceId: PreviewWorkspaceId,
})
export type PreviewOpenInput = typeof PreviewOpenInput.Type

export const PreviewNavigateInput = Schema.Struct({
  resolvedTitle: Schema.optional(PreviewTitle),
  tabId: PreviewTabId,
  url: PreviewUrl,
  workspaceId: PreviewWorkspaceId,
})
export type PreviewNavigateInput = typeof PreviewNavigateInput.Type

export const PreviewResizeInput = Schema.Struct({
  tabId: PreviewTabId,
  viewport: PreviewViewportSetting,
  workspaceId: PreviewWorkspaceId,
})
export type PreviewResizeInput = typeof PreviewResizeInput.Type

export const PreviewRefreshInput = Schema.Struct({
  tabId: PreviewTabId,
  workspaceId: PreviewWorkspaceId,
})
export type PreviewRefreshInput = typeof PreviewRefreshInput.Type

export const PreviewCloseInput = Schema.Struct({
  tabId: Schema.optional(PreviewTabId),
  workspaceId: PreviewWorkspaceId,
})
export type PreviewCloseInput = typeof PreviewCloseInput.Type

export const PreviewListInput = Schema.Struct({
  workspaceId: PreviewWorkspaceId,
})
export type PreviewListInput = typeof PreviewListInput.Type

export const PreviewReportStatusInput = Schema.Struct({
  canGoBack: Schema.Boolean,
  canGoForward: Schema.Boolean,
  navStatus: PreviewNavStatus,
  tabId: PreviewTabId,
  workspaceId: PreviewWorkspaceId,
})
export type PreviewReportStatusInput = typeof PreviewReportStatusInput.Type

export const PreviewListResult = Schema.Struct({
  revision: NonNegativeInt,
  serverEpoch: Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1)),
  sessions: Schema.Array(PreviewSessionSnapshot),
})
export type PreviewListResult = typeof PreviewListResult.Type

const PreviewEventBase = Schema.Struct({
  createdAt: Schema.String,
  revision: PositiveInt,
  serverEpoch: Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1)),
  tabId: PreviewTabId,
  workspaceId: PreviewWorkspaceId,
})

export const PreviewEvent = Schema.Union([
  Schema.Struct({
    ...PreviewEventBase.fields,
    snapshot: PreviewSessionSnapshot,
    type: Schema.Literal('opened'),
  }),
  Schema.Struct({
    ...PreviewEventBase.fields,
    snapshot: PreviewSessionSnapshot,
    type: Schema.Literal('navigated'),
  }),
  Schema.Struct({
    ...PreviewEventBase.fields,
    snapshot: PreviewSessionSnapshot,
    type: Schema.Literal('resized'),
  }),
  Schema.Struct({
    ...PreviewEventBase.fields,
    code: Schema.Int,
    description: Schema.String,
    title: PreviewTitle,
    type: Schema.Literal('failed'),
    url: PreviewUrl,
  }),
  Schema.Struct({
    ...PreviewEventBase.fields,
    type: Schema.Literal('closed'),
  }),
])
export type PreviewEvent = typeof PreviewEvent.Type

export const DiscoveredLocalServer = Schema.Struct({
  host: Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1)),
  pid: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  port: Schema.Int.check(
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(65_535)
  ),
  processName: Schema.NullOr(
    Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1))
  ),
  terminal: Schema.NullOr(
    Schema.Struct({
      terminalId: Schema.String.check(
        Schema.isTrimmed(),
        Schema.isMinLength(1)
      ),
      workspaceId: PreviewWorkspaceId,
    })
  ),
  url: PreviewUrl,
})
export type DiscoveredLocalServer = typeof DiscoveredLocalServer.Type

export const DiscoveredLocalServerList = Schema.Struct({
  configuredUrlProbing: Schema.optional(Schema.Literal(true)),
  scannedAt: Schema.String,
  servers: Schema.Array(DiscoveredLocalServer),
})
export type DiscoveredLocalServerList = typeof DiscoveredLocalServerList.Type

export class PreviewSessionLookupError extends Schema.TaggedError<PreviewSessionLookupError>()(
  'PreviewSessionLookupError',
  {
    tabId: Schema.String,
    workspaceId: Schema.String,
  }
) {
  override get message(): string {
    return `Unknown preview session: workspace=${this.workspaceId}, tab=${this.tabId}`
  }
}

export class PreviewInvalidUrlError extends Schema.TaggedError<PreviewInvalidUrlError>()(
  'PreviewInvalidUrlError',
  {
    cause: Schema.Defect(),
    inputLength: Schema.Number,
    protocol: Schema.optional(Schema.String),
    reason: Schema.Literals([
      'empty',
      'parse',
      'unsupported-protocol',
      'unexpected',
    ]),
  }
) {
  override get message(): string {
    const protocol = this.protocol === undefined ? '' : `: ${this.protocol}`
    return `Invalid preview URL (${this.reason}${protocol}; input length ${String(this.inputLength)}).`
  }
}

export const PreviewError = Schema.Union([
  PreviewSessionLookupError,
  PreviewInvalidUrlError,
])
export type PreviewError = typeof PreviewError.Type

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
  type: Schema.Literals(['text', 'binary']),
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
  status: Schema.Literals(['added', 'deleted', 'modified']),
})

export type FileInfo = typeof FileInfo.Type

/**
 * A single changed file with its unified diff patch, returned by `file.diff`.
 *
 * The batched diff endpoint returns one entry per changed file. Tracked
 * changes come from a single `git diff --patch HEAD` invocation split per
 * file; untracked files are diffed against `/dev/null` via
 * `git diff --no-index`.
 *
 * When a patch exceeds the per-file or total byte budget it is omitted and
 * `truncated` is set so the client can render a placeholder instead of
 * hanging or ballooning memory.
 *
 * @see opencode `Vcs.FileDiff` — the shape this endpoint is modeled on
 */
export const FileDiffEntry = Schema.Struct({
  /** Path of the changed file, relative to the worktree root. */
  path: Schema.String,
  /** Number of lines added relative to HEAD. */
  added: Schema.Number,
  /** Number of lines removed relative to HEAD. */
  removed: Schema.Number,
  /** The type of change: added (untracked), deleted, or modified. */
  status: Schema.Literals(['added', 'deleted', 'modified']),
  /**
   * Unified diff patch text for this file. Absent for binary files and
   * for files whose patch was truncated by the size budget.
   */
  patch: Schema.optional(Schema.String),
  /** True when the patch was omitted because it exceeded the size budget. */
  truncated: Schema.Boolean,
})

export type FileDiffEntry = typeof FileDiffEntry.Type

/**
 * What `file.diff` measures the worktree against.
 *
 * A worktree holds two different stories at once: what the agent has not
 * committed yet, and everything the branch has done since it forked. The
 * diff pane needs both, so the target is part of the request rather than a
 * property of the server.
 *
 * - `working` — the worktree against `HEAD`. Uncommitted work only. This is
 *   the default so existing callers keep the behaviour they were written for.
 * - `branch` — the worktree against the merge-base of the branch and its base
 *   branch. Everything the branch changed, committed and uncommitted alike.
 * - `ref` — the same merge-base treatment against a caller-chosen ref, for a
 *   base-ref menu (`origin/main`, a tag, a sha).
 *
 * `branch` and `ref` deliberately resolve the merge-base themselves instead of
 * asking git for `base...HEAD`: three-dot syntax needs two commits on both
 * sides, so it can never include the working tree. Diffing from the merge-base
 * to the worktree gives three-dot *semantics* — only what this branch did,
 * never base-branch commits shown inverted — with uncommitted work included.
 */
export const DiffTarget = Schema.Union([
  Schema.TaggedStruct('working', {}),
  Schema.TaggedStruct('branch', {}),
  Schema.TaggedStruct('ref', {
    /** Any revision git can resolve: branch, tag, sha, `origin/main`. */
    ref: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  }),
])

export type DiffTarget = typeof DiffTarget.Type

/**
 * `file.diff` could not work out what to measure against.
 *
 * These are the ordinary ways a repository declines to answer, not faults:
 * a worktree whose project never recorded a base branch and has no
 * `origin/HEAD`, a branch grafted onto an unrelated history, or a ref the
 * caller named that this repository does not have. Each carries the ref it
 * was working with so the pane can say which base failed.
 */
export class DiffTargetUnresolved extends Schema.TaggedError<DiffTargetUnresolved>()(
  'DiffTargetUnresolved',
  {
    message: Schema.String,
    /**
     * - `NO_BASE_BRANCH` — nothing names a base branch for this worktree.
     * - `REF_NOT_FOUND` — the requested ref does not resolve here.
     * - `MERGE_BASE_FAILED` — no common ancestor with the base.
     */
    reason: Schema.Literals([
      'NO_BASE_BRANCH',
      'REF_NOT_FOUND',
      'MERGE_BASE_FAILED',
    ]),
    /** The ref that was being resolved, when one was known. */
    ref: Schema.NullOr(Schema.String),
  }
) {}

/**
 * The change types `file.diffContents` will serve.
 *
 * These are the three the diff viewer's hunk-expansion loader can actually
 * use. `new` and `deleted` are deliberately absent: a patch for either
 * already carries its whole existing side, so there is no unchanged context
 * to expand into and nothing for a loader to fetch.
 */
export const DiffContentsChangeType = Schema.Literals([
  'change',
  'rename-pure',
  'rename-changed',
])

export type DiffContentsChangeType = typeof DiffContentsChangeType.Type

/**
 * Both sides of one file in full, returned by `file.diffContents`.
 *
 * The old side is the blob at the revision the patch was cut against; the
 * new side is the worktree file, byte-for-byte. Neither is trimmed: a
 * viewer counts lines from these strings, and silently dropping a trailing
 * newline would leave its line count short of the file's.
 *
 * `oldContents` is empty exactly when the change type is `rename-pure`
 * — there the old side is the new side, so it is not read at all — and
 * an empty string otherwise means the file really is empty. A file that
 * is not there at all is a {@link DiffContentsUnavailable} failure, never
 * an empty string.
 *
 * The `truncated` flags are the server admitting it cut a side off at the
 * byte cap. A truncated side has fewer lines than the file, so a client
 * that hydrates with it will disagree with the real file; the flags exist
 * so the client can decline to hydrate rather than discover the shortfall
 * after rendering.
 */
export const FileDiffContents = Schema.Struct({
  /** Full contents of the old side at the diff's base revision. */
  oldContents: Schema.String,
  /** Full contents of the new side as it is in the worktree. */
  newContents: Schema.String,
  /** True when the old side was cut short by the per-side byte cap. */
  oldTruncated: Schema.Boolean,
  /** True when the new side was cut short by the per-side byte cap. */
  newTruncated: Schema.Boolean,
})

export type FileDiffContents = typeof FileDiffContents.Type

/**
 * `file.diffContents` will not serve this file's contents.
 *
 * Distinct from {@link RpcError} because none of these are faults: they are
 * the honest answers to "give me both sides of this file", and each one
 * tells the client to keep rendering the patch it already has rather than
 * enable hunk expansion.
 *
 * `OLD_PATH_ABSENT` and `NEW_PATH_ABSENT` are what make "the file is not
 * there" distinguishable from "the file is empty", which `file.read` cannot
 * express — it answers both with empty content.
 */
export class DiffContentsUnavailable extends Schema.TaggedError<DiffContentsUnavailable>()(
  'DiffContentsUnavailable',
  {
    message: Schema.String,
    /**
     * - `OLD_PATH_ABSENT` — the base revision has no blob at the old path.
     * - `NEW_PATH_ABSENT` — the worktree has no file at the new path.
     * - `BINARY_FILE` — the file is not text, so there are no lines to
     *   expand into and returning it as a string would mangle it.
     */
    reason: Schema.Literals([
      'OLD_PATH_ABSENT',
      'NEW_PATH_ABSENT',
      'BINARY_FILE',
    ]),
    /** The path that could not be served. */
    path: Schema.String,
  }
) {}

// ---------------------------------------------------------------------------
// File Tree Schemas
// ---------------------------------------------------------------------------

/**
 * Git status type for a single file, compatible with `@pierre/trees`.
 * Maps the full porcelain v2 status codes down to three types.
 */
export const GitStatusEntry = Schema.Struct({
  path: Schema.String,
  status: Schema.Literals(['added', 'deleted', 'modified']),
})

export type GitStatusEntry = typeof GitStatusEntry.Type

// ---------------------------------------------------------------------------
// Pull Request Conversation Schemas
// ---------------------------------------------------------------------------

/**
 * Where a pull request timeline entry came from on GitHub.
 *
 * - `issue` — a conversation comment on the pull request itself
 * - `review` — a submitted review, carrying a verdict and an optional body
 * - `reviewComment` — a comment anchored to a file and line in the diff
 */
export const PullRequestCommentKind = Schema.Literals([
  'issue',
  'review',
  'reviewComment',
])

export type PullRequestCommentKind = typeof PullRequestCommentKind.Type

/** The verdict a submitted review carries. Mirrors the GitHub review states. */
export const PullRequestReviewState = Schema.Literals([
  'approved',
  'changesRequested',
  'commented',
  'dismissed',
  'pending',
])

export type PullRequestReviewState = typeof PullRequestReviewState.Type

/**
 * The eight reactions GitHub takes, under Laborer's own camelCase spellings.
 */
export const PullRequestReactionContent = Schema.Literals([
  'thumbsUp',
  'thumbsDown',
  'laugh',
  'hooray',
  'confused',
  'heart',
  'rocket',
  'eyes',
])

export type PullRequestReactionContent = typeof PullRequestReactionContent.Type

/** One reaction pill: what it is, how many stand behind it, and whether the
 *  reader is one of them — which is what pressing the pill toggles. */
export const PullRequestReaction = Schema.Struct({
  content: PullRequestReactionContent,
  count: Schema.Int,
  viewerHasReacted: Schema.Boolean,
})

export type PullRequestReaction = typeof PullRequestReaction.Type

/**
 * One entry in a pull request's conversation, normalized across the three
 * GitHub endpoints that feed it: issue comments, reviews, and review
 * comments. Every entry can be rendered as the same timeline item — an
 * author, a verb derived from {@link PullRequestCommentKind} plus
 * {@link PullRequestReviewState}, a timestamp, and an optional markdown body.
 *
 * A review with an empty body still belongs in the timeline: "approved your
 * pull request" is the whole message.
 */
export const PullRequestComment = Schema.Struct({
  /** GitHub's numeric id, unique per endpoint but not across them. */
  id: Schema.Int,
  /** Which endpoint produced this entry. */
  kind: PullRequestCommentKind,
  /** The commenter's GitHub login. */
  authorLogin: Schema.String,
  /** Avatar image URL, absent for ghost or deleted accounts. */
  authorAvatarUrl: Schema.NullOr(Schema.String),
  /** The commenter's GitHub profile URL. */
  authorUrl: Schema.NullOr(Schema.String),
  /** Markdown body. Empty for reviews submitted without a comment. */
  body: Schema.String,
  /** ISO 8601 creation (or review submission) timestamp. */
  createdAt: Schema.String,
  /** Permalink to this entry on github.com. */
  url: Schema.String,
  /** The verdict, for `review` entries only. */
  reviewState: Schema.NullOr(PullRequestReviewState),
  /** Repository-relative path, for `reviewComment` entries only. */
  filePath: Schema.NullOr(Schema.String),
  /** Line in the file the comment is anchored to, when GitHub still knows it. */
  line: Schema.NullOr(Schema.Int),
  /** The id of the entry this one replies to, for threaded review comments. */
  inReplyToId: Schema.NullOr(Schema.Int),
  /**
   * GitHub's GraphQL node id, when the activity read resolved one. It is what
   * `pullRequest.setReaction` addresses; an entry without one cannot be
   * reacted to from the timeline.
   */
  nodeId: Schema.optional(Schema.String),
  /** Reactions on this entry, when the activity read carried them. */
  reactions: Schema.optional(Schema.Array(PullRequestReaction)),
})

export type PullRequestComment = typeof PullRequestComment.Type

/**
 * A workspace's pull request conversation, returned by
 * `pullRequest.comments` in chronological order.
 */
export const PullRequestConversation = Schema.Struct({
  /** The pull request the conversation belongs to. */
  number: Schema.Int,
  /** Pull request title, when the workspace has it cached. */
  title: Schema.NullOr(Schema.String),
  /** Permalink to the pull request. */
  url: Schema.NullOr(Schema.String),
  /** Every timeline entry, oldest first. */
  comments: Schema.Array(PullRequestComment),
})

export type PullRequestConversation = typeof PullRequestConversation.Type

// ---------------------------------------------------------------------------
// Pull Request Panel — detail, activity, diff, and mutations
// ---------------------------------------------------------------------------

/** Somebody GitHub names: a user, a bot, or a team wearing its slug. */
export const PullRequestActor = Schema.Struct({
  avatarUrl: Schema.NullOr(Schema.String),
  login: Schema.String,
  name: Schema.NullOr(Schema.String),
})

export type PullRequestActor = typeof PullRequestActor.Type

export const PullRequestLabel = Schema.Struct({
  /** Hex color without the `#`, as GitHub reports it. Null when unknown. */
  color: Schema.NullOr(Schema.String),
  name: Schema.String,
})

export type PullRequestLabel = typeof PullRequestLabel.Type

export const PullRequestCheckStatus = Schema.Literals([
  'pending',
  'success',
  'failure',
  'skipped',
  'neutral',
  'cancelled',
])

export type PullRequestCheckStatus = typeof PullRequestCheckStatus.Type

export const PullRequestCheck = Schema.Struct({
  description: Schema.NullOr(Schema.String),
  name: Schema.String,
  status: PullRequestCheckStatus,
  url: Schema.NullOr(Schema.String),
})

export type PullRequestCheck = typeof PullRequestCheck.Type

export const PullRequestState = Schema.Literals(['open', 'closed', 'merged'])

export type PullRequestState = typeof PullRequestState.Type

export const PullRequestMergeability = Schema.Literals([
  'mergeable',
  'conflicting',
  'unknown',
])

export type PullRequestMergeability = typeof PullRequestMergeability.Type

export const PullRequestMergeMethod = Schema.Literals([
  'merge',
  'squash',
  'rebase',
])

export type PullRequestMergeMethod = typeof PullRequestMergeMethod.Type

/** How a stale branch catches up with its base. */
export const PullRequestUpdateMethod = Schema.Literals(['merge', 'rebase'])

export type PullRequestUpdateMethod = typeof PullRequestUpdateMethod.Type

/**
 * The lifecycle actions `pullRequest.action` can carry out, each mapping to
 * one `gh pr` subcommand.
 */
export const PullRequestActionKind = Schema.Literals([
  'merge',
  'ready',
  'draft',
  'close',
  'reopen',
  'updateBranch',
  'enableAutoMerge',
  'disableAutoMerge',
])

export type PullRequestActionKind = typeof PullRequestActionKind.Type

/** The merge strategies the repository's own settings allow. */
export const PullRequestMergeCapabilities = Schema.Struct({
  merge: Schema.Boolean,
  rebase: Schema.Boolean,
  squash: Schema.Boolean,
})

export type PullRequestMergeCapabilities =
  typeof PullRequestMergeCapabilities.Type

/**
 * The fast, header-shaped half of a pull request: everything the summary tab
 * and the action bar need, read in one round trip. The conversation and the
 * diff are separate reads so a long review history cannot hold the title,
 * checks, and buttons off screen.
 */
export const PullRequestDetail = Schema.Struct({
  additions: Schema.Int,
  author: Schema.NullOr(PullRequestActor),
  /**
   * Whether GitHub is already armed to merge this on its own. Null when
   * GitHub did not answer for auto-merge at all, which is not the same as
   * off: offering to arm something already armed is a write nobody asked for.
   */
  autoMergeEnabled: Schema.NullOr(Schema.Boolean),
  baseBranch: Schema.String,
  body: Schema.String,
  changedFiles: Schema.Int,
  checks: Schema.Array(PullRequestCheck),
  closedAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  deletions: Schema.Int,
  headBranch: Schema.String,
  isDraft: Schema.Boolean,
  labels: Schema.Array(PullRequestLabel),
  mergeability: PullRequestMergeability,
  mergeCapabilities: PullRequestMergeCapabilities,
  mergedAt: Schema.NullOr(Schema.String),
  number: Schema.Int,
  reviewDecision: Schema.NullOr(PullRequestReviewDecision),
  /** Outstanding review requests. The full roster arrives with the activity. */
  reviewers: Schema.Array(PullRequestActor),
  state: PullRequestState,
  title: Schema.String,
  updatedAt: Schema.String,
  url: Schema.String,
  /** Who GitHub says the reader is, for telling their remarks from others'. */
  viewer: Schema.NullOr(Schema.String),
  /** Whether the viewer's role on the repository can push, which is what
   *  merging and closing somebody else's pull request need. */
  viewerCanWrite: Schema.Boolean,
})

export type PullRequestDetail = typeof PullRequestDetail.Type

/**
 * Which file a diff line belongs to: `left` is the version before the
 * change, `right` the version after.
 */
export const PullRequestDiffSide = Schema.Literals(['left', 'right'])

export type PullRequestDiffSide = typeof PullRequestDiffSide.Type

/** One remark inside a review thread, addressed by its GraphQL node id. */
export const PullRequestThreadComment = Schema.Struct({
  author: Schema.NullOr(PullRequestActor),
  body: Schema.String,
  createdAt: Schema.String,
  /** GraphQL node id — what replies, edits, and reactions address. */
  id: Schema.String,
  reactions: Schema.Array(PullRequestReaction),
  url: Schema.NullOr(Schema.String),
})

export type PullRequestThreadComment = typeof PullRequestThreadComment.Type

/**
 * A conversation anchored to a line of the diff. The activity carries these
 * alongside the flat `comments` timeline: the same remarks, read two ways —
 * chronological for the timeline, whole threads pinned to a line for the
 * diff.
 */
export const PullRequestReviewThread = Schema.Struct({
  comments: Schema.Array(PullRequestThreadComment),
  /** GraphQL node id — what `pullRequest.replyToThread` and
   *  `pullRequest.setThreadResolution` address. */
  id: Schema.String,
  /** The line the thread was written against has left the diff, so it is
   *  listed rather than pinned to a line it no longer has. */
  isOutdated: Schema.Boolean,
  isResolved: Schema.Boolean,
  /** Null when the thread anchors to a file rather than a line. */
  line: Schema.NullOr(Schema.Int),
  path: Schema.String,
  side: PullRequestDiffSide,
})

export type PullRequestReviewThread = typeof PullRequestReviewThread.Type

export const PullRequestCommit = Schema.Struct({
  additions: Schema.NullOr(Schema.Int),
  authors: Schema.Array(PullRequestActor),
  committedDate: Schema.String,
  deletions: Schema.NullOr(Schema.Int),
  messageHeadline: Schema.String,
  oid: Schema.String,
})

export type PullRequestCommit = typeof PullRequestCommit.Type

/**
 * The conversation-shaped half of a pull request, returned by
 * `pullRequest.activity`.
 */
export const PullRequestActivity = Schema.Struct({
  /** Every timeline entry, oldest first, enriched with node ids and
   *  reactions where GitHub's GraphQL read resolved them. */
  comments: Schema.Array(PullRequestComment),
  /** The newest hundred commits, oldest first. */
  commits: Schema.Array(PullRequestCommit),
  /** Reactions on the pull request's own description. */
  reactions: Schema.Array(PullRequestReaction),
  /** Everyone on the review: still asked, or already answered. */
  reviewers: Schema.Array(PullRequestActor),
  reviewThreads: Schema.Array(PullRequestReviewThread),
  /** A bound of the read stopped before GitHub ran out of threads. */
  threadsTruncated: Schema.Boolean,
})

export type PullRequestActivity = typeof PullRequestActivity.Type

/** Real line counts for a file whose hunks GitHub withheld from the patch. */
export const PullRequestOmittedFileStat = Schema.Struct({
  additions: Schema.Int,
  deletions: Schema.Int,
  path: Schema.String,
})

export type PullRequestOmittedFileStat = typeof PullRequestOmittedFileStat.Type

/**
 * One slice of the pull request's unified patch — a whole number of files,
 * never a file cut in half, so each slice parses on its own.
 */
export const PullRequestDiffResult = Schema.Struct({
  /** Where the next slice starts, or null once the diff is whole. */
  nextCursor: Schema.NullOr(Schema.String),
  /** GitHub's own counts for files whose hunks it withheld. */
  omittedFileStats: Schema.Array(PullRequestOmittedFileStat),
  patch: Schema.String,
  /** Something inside this slice could not be shown — a binary file, or a
   *  hunk GitHub declined to inline. Not the same as there being more
   *  slices, which `nextCursor` answers. */
  truncated: Schema.Boolean,
})

export type PullRequestDiffResult = typeof PullRequestDiffResult.Type

/** How one file in the pull request diff changed, for content expansion. */
export const PullRequestDiffChangeType = Schema.Literals([
  'change',
  'rename-pure',
  'rename-changed',
  'new',
  'deleted',
])

export type PullRequestDiffChangeType = typeof PullRequestDiffChangeType.Type

/** Both sides of one diff file in full, for expanding omitted context. */
export const PullRequestFileContents = Schema.Struct({
  newContents: Schema.String,
  oldContents: Schema.String,
})

export type PullRequestFileContents = typeof PullRequestFileContents.Type

/** What submitting a review says about the change, beyond the words in it. */
export const PullRequestReviewVerdict = Schema.Literals([
  'approve',
  'comment',
  'requestChanges',
])

export type PullRequestReviewVerdict = typeof PullRequestReviewVerdict.Type

/** The coordinates of one line in a pull request diff. */
export const PullRequestReviewPosition = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('added'),
    newLine: Schema.Int,
  }),
  Schema.Struct({
    kind: Schema.Literal('deleted'),
    oldLine: Schema.Int,
  }),
  Schema.Struct({
    kind: Schema.Literal('context'),
    newLine: Schema.Int,
    oldLine: Schema.Int,
    /** Which copy of an unchanged line the reviewer selected in a split diff. */
    side: PullRequestDiffSide,
  }),
])

export type PullRequestReviewPosition = typeof PullRequestReviewPosition.Type

/** One remark in a review that has not been sent yet, anchored to a line. */
export const PullRequestReviewCommentDraft = Schema.Struct({
  body: Schema.String,
  path: Schema.String,
  position: PullRequestReviewPosition,
})

export type PullRequestReviewCommentDraft =
  typeof PullRequestReviewCommentDraft.Type

/** Whether a reviewer is a person or a team GitHub addresses as one. */
export const PullRequestReviewerKind = Schema.Literals(['user', 'team'])

export type PullRequestReviewerKind = typeof PullRequestReviewerKind.Type

/** Somebody a review may be asked of. */
export const PullRequestReviewerCandidate = Schema.Struct({
  avatarUrl: Schema.NullOr(Schema.String),
  /** How GitHub addresses this reviewer: a login, or a team slug. */
  id: Schema.String,
  /** A review has already been asked of them, so pressing them takes the
   *  request back. */
  isRequested: Schema.Boolean,
  kind: PullRequestReviewerKind,
  login: Schema.String,
  name: Schema.NullOr(Schema.String),
})

export type PullRequestReviewerCandidate =
  typeof PullRequestReviewerCandidate.Type

export const PullRequestReviewerCandidateList = Schema.Struct({
  /** Never includes the author: GitHub refuses a self-request. */
  candidates: Schema.Array(PullRequestReviewerCandidate),
  /** GitHub has more people with access than one read returns. */
  truncated: Schema.Boolean,
})

export type PullRequestReviewerCandidateList =
  typeof PullRequestReviewerCandidateList.Type

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
  // Project RPCs
  // -----------------------------------------------------------------------
  Rpc.make('project.add', {
    success: ProjectResponse,
    error: RpcError,
    payload: {
      id: Schema.String,
      operationId: OperationId,
      repoPath: Schema.String,
    },
  }),

  Rpc.make('project.remove', {
    error: RpcError,
    payload: {
      operationId: OperationId,
      projectId: Schema.String,
    },
  }),

  Rpc.make('project.list', {
    success: Schema.Array(ProjectResponse),
    error: RpcError,
  }),

  /**
   * Lists child directories on the daemon host for the browser folder picker.
   * An omitted path starts at the daemon user's home directory.
   */
  Rpc.make('local.directory.list', {
    success: Schema.Struct({
      directories: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          path: Schema.String,
        })
      ),
      parentPath: Schema.NullOr(Schema.String),
      path: Schema.String,
      truncated: Schema.Boolean,
    }),
    error: RpcError,
    payload: {
      path: Schema.optional(Schema.String),
    },
  }),

  /** Atomic revision-CAS rank assignments for one project reorder intent. */
  Rpc.make('project.reorder', {
    success: Schema.Struct({
      cursor: NonNegativeInt,
      rows: Schema.Array(SharedProjectRow),
    }),
    error: RpcError,
    payload: {
      assignments: Schema.Array(
        Schema.Struct({
          expectedRevision: PositiveInt,
          projectId: Schema.String,
          sortOrder: Schema.NullOr(Schema.Finite),
        })
      ),
      operationId: OperationId,
    },
  }),

  /**
   * Streams a full shared-task-db snapshot followed by ledger-driven deltas.
   * The server is the only SQLite reader; ending the subscription ends polling.
   */
  Rpc.make('task.board.subscribe', {
    success: TaskBoardEvent,
    error: RpcError,
    stream: true,
  }),

  Rpc.make('state.subscribe', {
    success: SharedStateUpdate,
    error: RpcError,
    stream: true,
  }),

  /** Revision-CAS write for a global app setting. Revision 0 means absent. */
  Rpc.make('appSetting.set', {
    success: Schema.Struct({
      cursor: NonNegativeInt,
      row: SharedSettingRow,
    }),
    error: RpcError,
    payload: {
      expectedRevision: NonNegativeInt,
      key: Schema.String.check(
        Schema.isMinLength(1),
        Schema.isMaxLength(APP_SETTING_KEY_MAX_LENGTH)
      ),
      operationId: OperationId,
      value: Schema.String.check(
        Schema.isMaxLength(APP_SETTING_VALUE_MAX_LENGTH)
      ),
    },
  }),

  Rpc.make('task.create', {
    success: Schema.Struct({
      /** Stored task description to inject when creation provisions a workspace. */
      description: Schema.NullOr(Schema.String),
      id: Schema.String,
      source: Schema.Literals(['manual', 'slack_url']),
      status: Schema.Literals(['todo', 'in_progress', 'in_review', 'done']),
      /** Non-null only when creating directly in In Progress provisioned a workspace. */
      workspaceId: Schema.NullOr(Schema.String),
    }),
    error: RpcError,
    payload: {
      /**
       * Renderer-minted task ULID so the optimistic card and the stored row
       * share one identity. Re-sending the same id is an idempotent retry.
       * Omitted by older callers; the server then mints the id itself.
       */
      id: Schema.optional(Schema.String),
      operationId: OperationId,
      projectId: Schema.String,
      status: Schema.Literals(['todo', 'in_progress', 'in_review', 'done']),
      text: Schema.String.check(
        Schema.isMaxLength(SLACK_MESSAGE_URL_MAX_LENGTH)
      ),
    },
  }),

  /** Revision-CAS status/manual-order write used by card drags and cancellation. */
  Rpc.make('task.move', {
    success: Schema.Struct({
      cursor: NonNegativeInt,
      /** Non-null only when this move provisioned a new workspace. */
      workspaceId: Schema.NullOr(Schema.String),
      /** Stored task description to inject into the newly launched agent. */
      description: Schema.NullOr(Schema.String),
      revision: Schema.Int,
      row: SharedTaskRow,
      status: StoredTaskStatus,
      updatedAt: Schema.Int,
    }),
    error: RpcError,
    payload: {
      expectedRevision: PositiveInt,
      operationId: OperationId,
      sortOrder: Schema.NullOr(Schema.Finite),
      status: StoredTaskStatus,
      taskId: Schema.String,
    },
  }),

  /** Human-authored title/description edits from the task detail dialog. */
  Rpc.make('task.update', {
    success: Schema.Struct({
      description: Schema.NullOr(Schema.String),
      revision: Schema.Int,
      title: Schema.String,
      updatedAt: Schema.Int,
    }),
    error: RpcError,
    payload: {
      description: Schema.NullOr(Schema.String),
      expectedRevision: Schema.Int,
      operationId: OperationId,
      taskId: Schema.String,
      title: Schema.String,
    },
  }),

  // -----------------------------------------------------------------------
  // Label RPCs
  // -----------------------------------------------------------------------

  /**
   * Creates an app-wide label. The renderer mints the id so an inline
   * "create label" row can select it optimistically; resending the same id is
   * an idempotent retry. Omitting `color` derives one from the name.
   */
  Rpc.make('label.create', {
    success: Schema.Struct({
      cursor: NonNegativeInt,
      row: SharedLabelRow,
    }),
    error: RpcError,
    payload: {
      color: Schema.optional(LabelColor),
      id: Schema.optional(Schema.String),
      operationId: OperationId,
      name: Schema.String.check(
        Schema.isMinLength(1),
        Schema.isMaxLength(LABEL_NAME_MAX_LENGTH)
      ),
    },
  }),

  /** Revision-CAS rename/recolor from the label settings surface. */
  Rpc.make('label.update', {
    success: Schema.Struct({
      cursor: NonNegativeInt,
      row: SharedLabelRow,
    }),
    error: RpcError,
    payload: {
      color: Schema.optional(LabelColor),
      expectedRevision: PositiveInt,
      labelId: Schema.String,
      operationId: OperationId,
      name: Schema.optional(
        Schema.String.check(
          Schema.isMinLength(1),
          Schema.isMaxLength(LABEL_NAME_MAX_LENGTH)
        )
      ),
    },
  }),

  /**
   * Hard-deletes a label and strips its id from every task that carries it,
   * so a task's stored ids never outlive the labels they name.
   */
  Rpc.make('label.delete', {
    success: Schema.Struct({ cursor: NonNegativeInt }),
    error: RpcError,
    payload: {
      expectedRevision: PositiveInt,
      labelId: Schema.String,
      operationId: OperationId,
    },
  }),

  /** Revision-CAS replacement of a task's whole label set. */
  Rpc.make('task.labels.set', {
    success: Schema.Struct({
      cursor: NonNegativeInt,
      revision: Schema.Int,
      row: SharedTaskRow,
      updatedAt: Schema.Int,
    }),
    error: RpcError,
    payload: {
      expectedRevision: PositiveInt,
      labelIds: Schema.Array(Schema.String),
      operationId: OperationId,
      taskId: Schema.String,
    },
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
        conflictPrompt: Schema.optional(Schema.String),
        shortName: Schema.optional(Schema.String),
        worktreeDir: Schema.optional(Schema.String),
        setupScripts: Schema.optional(Schema.Array(Schema.String)),
        previewUrls: Schema.optional(ConfiguredLocalServerUrls),
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

  /**
   * The `provider/model` ids OpenCode has credentials for on this machine.
   *
   * Read from OpenCode rather than kept as a list here, so the picker can
   * never offer a model that would fail the moment it was used.
   */
  Rpc.make('opencode.models', {
    success: Schema.Struct({ models: Schema.Array(Schema.String) }),
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
  // Workspace RPCs
  // -----------------------------------------------------------------------
  Rpc.make('workspace.create', {
    success: WorkspaceResponse,
    error: RpcError,
    payload: {
      operationId: OperationId,
      projectId: Schema.String,
      branchName: Schema.optional(Schema.String),
      /**
       * Creates a sub-workspace: the new worktree branches from this
       * workspace's current HEAD and its PR targets that workspace's branch.
       */
      baseWorkspaceId: Schema.optional(Schema.String),
    },
  }),

  Rpc.make('workspace.planFromSlack', {
    success: SlackWorkspacePlanResponse,
    error: RpcError,
    payload: {
      slackUrl: Schema.String.check(
        Schema.isMaxLength(SLACK_MESSAGE_URL_MAX_LENGTH)
      ),
    },
  }),

  Rpc.make('workspace.destroy', {
    error: RpcError,
    payload: {
      operationId: OperationId,
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

  /**
   * Stage everything in the worktree and commit it under one message.
   *
   * Omitting the message asks the server to have a model write one from the
   * staged diff, which is what the one-click button does.
   */
  Rpc.make('workspace.commit', {
    success: WorkspaceSyncStatusResponse,
    error: RpcError,
    payload: {
      workspaceId: Schema.String,
      message: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
    },
  }),

  /** Open a pull request for the workspace's branch via the GitHub CLI. */
  Rpc.make('workspace.createPr', {
    success: PrStatusResponse,
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
      /** Prompt passed to a supported interactive agent when it starts. */
      initialPrompt: Schema.optional(Schema.String),
    },
  }),

  // -----------------------------------------------------------------------
  // Browser Preview RPCs
  // -----------------------------------------------------------------------
  Rpc.make('preview.open', {
    success: PreviewSessionSnapshot,
    error: Schema.Union([PreviewError, RpcError]),
    payload: PreviewOpenInput.fields,
  }),

  Rpc.make('preview.navigate', {
    success: PreviewSessionSnapshot,
    error: Schema.Union([PreviewError, RpcError]),
    payload: PreviewNavigateInput.fields,
  }),

  Rpc.make('preview.resize', {
    success: PreviewSessionSnapshot,
    error: Schema.Union([PreviewError, RpcError]),
    payload: PreviewResizeInput.fields,
  }),

  Rpc.make('preview.refresh', {
    error: Schema.Union([PreviewError, RpcError]),
    payload: PreviewRefreshInput.fields,
  }),

  Rpc.make('preview.close', {
    error: Schema.Union([PreviewError, RpcError]),
    payload: PreviewCloseInput.fields,
  }),

  Rpc.make('preview.list', {
    success: PreviewListResult,
    error: RpcError,
    payload: PreviewListInput.fields,
  }),

  Rpc.make('preview.reportStatus', {
    error: Schema.Union([PreviewError, RpcError]),
    payload: PreviewReportStatusInput.fields,
  }),

  Rpc.make('preview.events', {
    success: PreviewEvent,
    stream: true,
  }),

  Rpc.make('preview.discoveredLocalServers', {
    success: DiscoveredLocalServerList,
    error: RpcError,
    stream: true,
    payload: {
      workspaceId: PreviewWorkspaceId,
      configuredUrls: Schema.optional(ConfiguredLocalServerUrls),
    },
  }),

  Rpc.make('browserControl.connect', {
    success: BrowserControlEvent,
    error: RpcError,
    stream: true,
    payload: BrowserControlHost.fields,
  }),
  Rpc.make('browserControl.respond', {
    error: BrowserControlError,
    payload: BrowserControlResponse.fields,
  }),
  Rpc.make('browserControl.invoke', {
    success: Schema.Unknown,
    error: Schema.Union([BrowserControlError, RpcError]),
    payload: {
      workspaceId: PreviewWorkspaceId,
      controllerId: Schema.String,
      tabId: Schema.optional(PreviewTabId),
      operation: BrowserControlOperation,
      input: Schema.Unknown,
      timeoutMs: Schema.optional(Schema.Int),
    },
  }),
  Rpc.make('browserControl.cancel', {
    payload: { workspaceId: PreviewWorkspaceId, controllerId: Schema.String },
  }),
  Rpc.make('browserContext.deliver', {
    success: BrowserContextItem,
    error: Schema.Union([BrowserContextError, RpcError]),
    payload: { workspaceId: PreviewWorkspaceId, annotation: BrowserAnnotation },
  }),
  Rpc.make('browserContext.list', {
    success: Schema.Array(BrowserContextItem),
    error: Schema.Union([BrowserContextError, RpcError]),
    payload: {
      workspaceId: PreviewWorkspaceId,
      includeConsumed: Schema.optional(Schema.Boolean),
    },
  }),
  Rpc.make('browserContext.consume', {
    success: BrowserContextItem,
    error: Schema.Union([BrowserContextError, RpcError]),
    payload: { workspaceId: PreviewWorkspaceId, id: Schema.String },
  }),

  /** Mint a scoped daemon URL for one browser-previewable workspace file. */
  Rpc.make('workspace.assetUrl', {
    success: Schema.Struct({
      expiresAt: Schema.Number,
      relativeUrl: Schema.String,
    }),
    error: RpcError,
    payload: {
      relativePath: PreviewUrl,
      workspaceId: PreviewWorkspaceId,
    },
  }),

  /** Spawn a shell using the task's shared-db worktree path as plain cwd. */
  Rpc.make('task.terminal.attach', {
    success: Schema.Struct({
      botOwned: Schema.Boolean,
      terminal: TerminalResponse,
    }),
    error: RpcError,
    payload: {
      taskId: Schema.String,
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

  /**
   * The GitHub login of whoever this machine is authenticated as.
   *
   * Null means the question has no answer right now — `gh` is not installed,
   * not logged in, or offline. Callers read that as "attribute nothing to me"
   * rather than as an error, because an unattributed workspace is a normal
   * state, not a failure.
   */
  Rpc.make('github.currentUser', {
    success: Schema.Struct({
      login: Schema.NullOr(Schema.String),
    }),
    error: RpcError,
    payload: {},
  }),

  /**
   * Every open pull request in a project's repository, checked out here or not.
   *
   * The sidebar files a branch under the login that opened it, but only once
   * that branch has a worktree. This answers the other half of the author's
   * heading — what they have open that is not here yet — so the gap is visible
   * and can be closed with one action.
   *
   * An empty list is the answer whenever GitHub cannot be asked: no `gh`, no
   * login, no GitHub remote, or no network. None of those are failures the
   * sidebar acts on differently, so none of them raise.
   */
  Rpc.make('github.pullRequests', {
    success: Schema.Struct({
      pullRequests: Schema.Array(OpenPullRequest),
    }),
    error: RpcError,
    payload: {
      projectId: Schema.String,
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
   * List every file and directory in a workspace's worktree as one flat,
   * recursive listing.
   *
   * This backs the right panel's file explorer (`@pierre/trees` wants the
   * whole path list up front). Noisy directories, OS metadata files, and
   * gitignored entries are skipped; the walk stops at an entry cap and
   * reports `truncated` instead of unbounded output.
   */
  Rpc.make('file.listEntries', {
    success: FileEntriesResult,
    error: RpcError,
    payload: {
      workspaceId: Schema.String,
    },
  }),

  /**
   * Read a text file's verbatim contents for the file preview/editor
   * surface.
   *
   * Unlike `file.read` this does not trim trailing whitespace or compute a
   * diff — an editor must see the file exactly as it is — and it caps the
   * text at a preview limit (1 MB), reporting the file's true byte length
   * and a `truncated` flag instead of shipping the whole file.
   *
   * Fails with code `BINARY_FILE` for files that are not text (the image
   * preview keeps using `file.read`, which serves base64), `NOT_FOUND`
   * when the path does not exist, and `PATH_TRAVERSAL` when the path
   * escapes the worktree.
   */
  Rpc.make('file.readText', {
    success: FileTextContent,
    error: RpcError,
    payload: {
      workspaceId: Schema.String,
      filePath: Schema.String,
    },
  }),

  /**
   * Write a text file inside a workspace's worktree, creating parent
   * directories as needed.
   *
   * Backs the file editor's debounced save. The path must stay inside the
   * worktree (`PATH_TRAVERSAL` otherwise); the contents are written
   * verbatim as UTF-8.
   */
  Rpc.make('file.write', {
    success: FileWriteResult,
    error: RpcError,
    payload: {
      workspaceId: Schema.String,
      filePath: Schema.String,
      contents: Schema.String,
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
   * Return all changed files in a workspace with their unified diff patches
   * in a single batched call.
   *
   * Tracked changes are computed with one `git diff --patch <base>` invocation
   * whose output is split per file; untracked files are diffed against
   * `/dev/null` via `git diff --no-index`. Patches that exceed the size
   * budget are omitted with `truncated: true`.
   *
   * `target` chooses what `<base>` is — see {@link DiffTarget}. It defaults to
   * `{ _tag: 'working' }`, the diff against `HEAD`. `ignoreWhitespace` adds
   * `-w`, so a reindent stops drowning the change that matters.
   *
   * This is the diff viewer's data source — one round-trip per refresh
   * instead of one `file.read` per changed file.
   */
  Rpc.make('file.diff', {
    success: Schema.Array(FileDiffEntry),
    error: Schema.Union([RpcError, DiffTargetUnresolved]),
    payload: {
      workspaceId: Schema.String,
      target: Schema.optional(DiffTarget),
      ignoreWhitespace: Schema.optional(Schema.Boolean),
    },
  }),

  /**
   * Return both full sides of one changed file so the diff viewer can
   * expand unchanged context around a hunk.
   *
   * A patch carries only the lines inside its hunks, so expanding past them
   * needs the files themselves. The old side is read with
   * `git show <base>:<oldPath>` where `<base>` is the exact revision the
   * patch was cut against — `HEAD` for the `working` target, the resolved
   * merge-base for `branch` and `ref`. That resolution is the whole reason
   * this RPC exists: `file.read` only ever sees the worktree, so using it
   * for the old side would render the wrong code without saying so.
   * `target` is therefore required, not defaulted — the client must name the
   * same target it asked `file.diff` for.
   *
   * The new side is the worktree file verbatim, including any trailing
   * newline. Each side is capped at 2 MB and reports its own `truncated`
   * flag; the cap sits well under `file.diff`'s 10 MB patch budget because
   * this is a per-expansion round trip rather than one whole-workspace
   * batch. `maxBytes` may lower that cap but never raise it.
   *
   * A file `file.diff` returned with `truncated: true` cannot reach here:
   * that entry has no patch text, so nothing parses into a diff, no hunks
   * render, and there is no expansion control to press.
   *
   * `ignoreWhitespace` is deliberately not a parameter. `-w` shapes which
   * lines git puts in the hunks; it says nothing about what the files
   * contain. Whitespace-only lines the flag suppressed from the hunks
   * reappear as ordinary context once a region is expanded, which is the
   * intended reading of "ignore whitespace": hide those changes from the
   * summary, do not pretend the file does not contain them.
   */
  Rpc.make('file.diffContents', {
    success: FileDiffContents,
    error: Schema.Union([
      RpcError,
      DiffTargetUnresolved,
      DiffContentsUnavailable,
    ]),
    payload: {
      workspaceId: Schema.String,
      /** The target the patch being expanded was produced under. */
      target: DiffTarget,
      /** The viewer's change type for this file. */
      changeType: DiffContentsChangeType,
      /** Path at the base revision. Equal to `newPath` when unrenamed. */
      oldPath: Schema.String,
      /** Path in the worktree. */
      newPath: Schema.String,
      /** Optional lower per-side byte cap. */
      maxBytes: Schema.optional(PositiveInt),
    },
  }),

  /**
   * Return the pull request conversation for a workspace's branch.
   *
   * Reads GitHub directly through the `gh` CLI — issue comments, submitted
   * reviews, and line-anchored review comments — and merges them into one
   * chronological timeline.
   *
   * Fails with code `PR_NOT_FOUND` when the workspace's branch has no pull
   * request yet, which the client renders as an empty state rather than an
   * error.
   */
  Rpc.make('pullRequest.comments', {
    success: PullRequestConversation,
    error: RpcError,
    payload: {
      workspaceId: Schema.String,
    },
  }),

  /**
   * The header-shaped half of the workspace's pull request: title, body,
   * author, state, branches, checks, labels, mergeability, and what the
   * repository's settings and the viewer's role allow.
   *
   * Fails with code `PR_NOT_FOUND` when the workspace's branch has no pull
   * request yet, like every read below.
   */
  Rpc.make('pullRequest.detail', {
    success: PullRequestDetail,
    error: RpcError,
    payload: {
      workspaceId: Schema.String,
    },
  }),

  /**
   * The conversation-shaped half: the flat timeline, review threads pinned
   * to their diff lines, commits, the reviewer roster, and reactions.
   */
  Rpc.make('pullRequest.activity', {
    success: PullRequestActivity,
    error: RpcError,
    payload: {
      workspaceId: Schema.String,
    },
  }),

  /**
   * One slice of the pull request's unified patch, assembled from GitHub's
   * files API so it pages a whole number of files at a time. An omitted
   * `cursor` asks for the first slice; `commit` narrows the diff to one
   * commit of the change.
   */
  Rpc.make('pullRequest.diff', {
    success: PullRequestDiffResult,
    error: RpcError,
    payload: {
      workspaceId: Schema.String,
      cursor: Schema.optional(Schema.String),
      commit: Schema.optional(Schema.String),
    },
  }),

  /**
   * Both sides of one diff file in full, for expanding context the patch
   * does not carry. The old side reads at the base (or parent-commit)
   * revision, the new side at the head.
   */
  Rpc.make('pullRequest.diffContents', {
    success: PullRequestFileContents,
    error: RpcError,
    payload: {
      workspaceId: Schema.String,
      changeType: PullRequestDiffChangeType,
      oldPath: Schema.String,
      newPath: Schema.String,
      commit: Schema.optional(Schema.String),
    },
  }),

  /** Post a conversation comment on the workspace's pull request. */
  Rpc.make('pullRequest.comment', {
    error: RpcError,
    payload: {
      workspaceId: Schema.String,
      body: Schema.String,
    },
  }),

  /**
   * Rewrite the pull request's own title and/or body. A field left out is
   * kept as it was; a request naming neither is refused.
   */
  Rpc.make('pullRequest.edit', {
    error: RpcError,
    payload: {
      workspaceId: Schema.String,
      title: Schema.optional(Schema.String),
      body: Schema.optional(Schema.String),
    },
  }),

  /**
   * Run one lifecycle action: merge, ready/draft, close/reopen, update the
   * branch, or arm/disarm auto-merge. `mergeMethod` is read for `merge` and
   * `enableAutoMerge`; `updateMethod` only for `updateBranch`.
   */
  Rpc.make('pullRequest.action', {
    error: RpcError,
    payload: {
      workspaceId: Schema.String,
      action: PullRequestActionKind,
      mergeMethod: Schema.optional(PullRequestMergeMethod),
      updateMethod: Schema.optional(PullRequestUpdateMethod),
    },
  }),

  /**
   * Submit a whole review in one request — verdict, summary, and any line
   * comments — so nothing is visible to anyone else until it is sent.
   */
  Rpc.make('pullRequest.submitReview', {
    error: RpcError,
    payload: {
      workspaceId: Schema.String,
      verdict: PullRequestReviewVerdict,
      body: Schema.String,
      comments: Schema.Array(PullRequestReviewCommentDraft),
    },
  }),

  /** Reply to a review thread, named by its GraphQL node id. */
  Rpc.make('pullRequest.replyToThread', {
    error: RpcError,
    payload: {
      workspaceId: Schema.String,
      threadId: Schema.String,
      body: Schema.String,
    },
  }),

  /** Mark a review thread resolved, or unresolved again. */
  Rpc.make('pullRequest.setThreadResolution', {
    error: RpcError,
    payload: {
      workspaceId: Schema.String,
      threadId: Schema.String,
      resolved: Schema.Boolean,
    },
  }),

  /**
   * Add a reaction to a remark, or take it back. An omitted `subjectId`
   * reacts to the pull request itself, which is where its description's
   * reactions live.
   */
  Rpc.make('pullRequest.setReaction', {
    error: RpcError,
    payload: {
      workspaceId: Schema.String,
      subjectId: Schema.optional(Schema.String),
      content: PullRequestReactionContent,
      reacted: Schema.Boolean,
    },
  }),

  /** Who this pull request may be sent to, and who it already has been. */
  Rpc.make('pullRequest.reviewerCandidates', {
    success: PullRequestReviewerCandidateList,
    error: RpcError,
    payload: {
      workspaceId: Schema.String,
    },
  }),

  /**
   * Ask somebody for a review, or take the request back — one operation
   * with `requested` turned around.
   */
  Rpc.make('pullRequest.requestReviewers', {
    error: RpcError,
    payload: {
      workspaceId: Schema.String,
      reviewers: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          kind: PullRequestReviewerKind,
        })
      ),
      requested: Schema.Boolean,
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
  }),

  // -----------------------------------------------------------------------
  // Review Comment RPCs
  // -----------------------------------------------------------------------

  /**
   * List every review conversation anchored in a workspace, oldest thread
   * first, each with its full reply chain.
   *
   * Resolved threads are omitted unless `includeResolved` asks for them, so
   * the diff viewer's default is the work still outstanding.
   *
   * This is a first read, not a poll: `state.subscribe` publishes every later
   * change — including the agent's replies over MCP — as a `reviewComments`
   * table update carrying the whole thread. `cursor` is the state-ledger
   * position this read reflects.
   */
  Rpc.make('reviewComment.list', {
    success: Schema.Struct({
      cursor: NonNegativeInt,
      rows: Schema.Array(ReviewCommentThread),
    }),
    error: RpcError,
    payload: {
      includeResolved: Schema.optional(Schema.Boolean),
      workspaceId: Schema.String,
    },
  }),

  /**
   * Open a review conversation on a line range, with the human's first
   * message. The thread and its opening reply are written together, so a
   * thread never exists without the words that opened it.
   *
   * The renderer may mint `id` and `replyId` so an optimistic thread and the
   * stored row share one identity; re-sending a stored id is an idempotent
   * retry. The reply is authored `human` because this is the web boundary —
   * no payload carries an author. `operationId` correlates the optimistic
   * write with the authoritative row when it arrives on `state.subscribe`.
   */
  Rpc.make('reviewComment.create', {
    success: Schema.Struct({
      cursor: NonNegativeInt,
      row: ReviewCommentThread,
    }),
    error: RpcError,
    payload: {
      body: ReviewCommentBody,
      endLine: PositiveInt,
      filePath: Schema.String,
      id: Schema.optional(Schema.String),
      operationId: OperationId,
      replyId: Schema.optional(Schema.String),
      side: ReviewCommentSide,
      startLine: PositiveInt,
      workspaceId: Schema.String,
    },
  }),

  /**
   * Append a human message to an existing conversation and return the whole
   * thread as it now stands.
   *
   * Appending deliberately takes no expected revision: a reply is an
   * append-only child of the thread, so it never invalidates the revision
   * another client is holding to resolve or delete that thread.
   */
  Rpc.make('reviewComment.reply', {
    success: Schema.Struct({
      cursor: NonNegativeInt,
      row: ReviewCommentThread,
    }),
    error: RpcError,
    payload: {
      body: ReviewCommentBody,
      id: Schema.optional(Schema.String),
      operationId: OperationId,
      threadId: Schema.String,
    },
  }),

  /**
   * Edit the body of a human-authored reply and return the whole thread.
   *
   * A boundary may only rewrite its own words, so this fails with
   * `AUTHOR_MISMATCH` when `replyId` names a reply the agent wrote.
   */
  Rpc.make('reviewComment.update', {
    success: Schema.Struct({
      cursor: NonNegativeInt,
      row: ReviewCommentThread,
    }),
    error: RpcError,
    payload: {
      body: ReviewCommentBody,
      operationId: OperationId,
      replyId: Schema.String,
    },
  }),

  /**
   * Resolve or reopen a conversation under revision CAS, so the human can
   * close out a thread the agent has answered — the same write the agent's
   * `resolve_review_comment` MCP tool performs.
   */
  Rpc.make('reviewComment.setStatus', {
    success: Schema.Struct({
      cursor: NonNegativeInt,
      row: ReviewCommentThread,
    }),
    error: RpcError,
    payload: {
      expectedRevision: PositiveInt,
      operationId: OperationId,
      status: ReviewCommentStatus,
      threadId: Schema.String,
    },
  }),

  /**
   * Hard-delete a conversation and every reply in it under revision CAS,
   * for a comment the human decides they never meant to leave.
   */
  Rpc.make('reviewComment.delete', {
    success: Schema.Struct({ cursor: NonNegativeInt }),
    error: RpcError,
    payload: {
      expectedRevision: PositiveInt,
      operationId: OperationId,
      threadId: Schema.String,
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
  type: Schema.Literals(['add', 'change', 'delete']),
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
export const ProcessCategorySchema = Schema.Literals([
  'agent',
  'editor',
  'devServer',
  'shell',
  'unknown',
])

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

/** Semantic lifecycle state reported for an agent in a terminal. */
export const AgentStatusSchema = Schema.Literals([
  'working',
  'needs_input',
  'idle',
  'unknown',
])

export type AgentStatus = typeof AgentStatusSchema.Type

/** Detector that supplied the effective agent status. */
export const AgentStatusSourceSchema = Schema.Literals(['hook', 'ps'])

export type AgentStatusSource = typeof AgentStatusSourceSchema.Type

/** Ephemeral status together with provenance and diagnostic age. */
export const AgentStatusSnapshotSchema = Schema.Struct({
  status: AgentStatusSchema,
  source: AgentStatusSourceSchema,
  changedAt: Schema.Number,
  stale: Schema.Boolean,
  /** Whether the operator has viewed this terminal since its last completion. */
  seen: Schema.Boolean,
})

export type AgentStatusSnapshot = typeof AgentStatusSnapshotSchema.Type

/** Sequence-guarded lifecycle evidence accepted from an agent hook. */
export const AgentStatusReportSchema = Schema.Struct({
  status: AgentStatusSchema,
  sequence: NonNegativeInt,
})

export type AgentStatusReport = typeof AgentStatusReportSchema.Type

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
  agentStatus: Schema.NullOr(AgentStatusSnapshotSchema),
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
  /**
   * Title of the agent session currently focused inside the terminal,
   * parsed from the terminal's OSC 0/2 title. Lets the sidebar name a row
   * after the work it is doing ("OpenCode 2 · Fix the flaky spawn test")
   * rather than repeating the agent name on every row. Null when the
   * terminal runs no session-aware agent, the agent is on a screen with no
   * session identity, or the terminal is stopped.
   */
  sessionTitle: Schema.NullOr(Schema.String),
  status: TerminalStatus,
})

export type TerminalInfo = typeof TerminalInfo.Type

/**
 * RPC group for the standalone terminal service (`@laborer/terminal`).
 *
 * These endpoints operate on terminal instances and detached-host health
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
      /** Shell command to execute (e.g., "bash" or "opencode"). */
      command: Schema.String,
      /** Command arguments (optional, default []). */
      args: Schema.optional(Schema.Array(Schema.String)),
      /** Working directory for the PTY process. */
      cwd: Schema.String,
      /** Environment variables to inject into the PTY process. */
      env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
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

  /** Cursor-replay terminal stream used by browser clients on the shared WS. */
  Rpc.make('terminal.attach', {
    success: TerminalAttachEvent,
    error: TerminalRpcError,
    payload: {
      id: Schema.String,
      leaseId: Schema.String,
      cursor: Schema.optional(NonNegativeInt),
      epoch: Schema.optional(Schema.String),
    },
    stream: true,
  }),

  /** Commit output only after xterm has parsed and rendered it. */
  Rpc.make('terminal.ack', {
    error: TerminalRpcError,
    payload: {
      id: Schema.String,
      leaseId: Schema.String,
      cursor: NonNegativeInt,
    },
  }),

  /** Bounded-transport diagnostics for terminal/WS fairness. */
  Rpc.make('terminal.transportMetrics', {
    success: Schema.Struct({
      ackLatencyMs: NonNegativeInt,
      backlogBytes: NonNegativeInt,
      resetCount: NonNegativeInt,
      wsBufferedBytes: Schema.NullOr(NonNegativeInt),
    }),
    error: TerminalRpcError,
    payload: { id: Schema.String },
  }),

  /** Advisory health for the detached pty host. Heartbeat silence never kills it. */
  Rpc.make('terminal.hostStatus', {
    success: TerminalHostStatus,
    error: TerminalRpcError,
  }),

  /** Explicit checkpoint → host restart → revival action. */
  Rpc.make('terminal.restartHost', {
    success: TerminalHostStatus,
    error: TerminalRpcError,
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
   * Reports are rejected when their sequence is not newer than the last
   * accepted report for the terminal.
   */
  Rpc.make('terminal.setAgentStatus', {
    error: TerminalRpcError,
    payload: {
      id: Schema.String,
      report: AgentStatusReportSchema,
    },
  }),

  /** Refresh one mission-control client's focused-workspace presence lease. */
  Rpc.make('terminal.reportWorkspacePresence', {
    payload: {
      clientId: Schema.String.check(
        Schema.isMinLength(1),
        Schema.isMaxLength(PRESENCE_CLIENT_ID_MAX_LENGTH)
      ),
      /** Monotonic per-client ordering guard for overlapping refreshes. */
      sequence: NonNegativeInt,
      workspaceIds: Schema.Array(
        Schema.String.check(
          Schema.isMinLength(1),
          Schema.isMaxLength(PRESENCE_WORKSPACE_ID_MAX_LENGTH)
        )
      ).check(Schema.isMaxLength(PRESENCE_WORKSPACE_MAX_ITEMS)),
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

/** Public status of the source Slack daemon managed from mission control. */
export const SlackDaemonStatus = Schema.Struct({
  status: Schema.Literals(['running', 'stopped', 'error']),
})

export type SlackDaemonStatus = typeof SlackDaemonStatus.Type

export class SlackDaemonStartError extends Schema.TaggedError<SlackDaemonStartError>()(
  'SlackDaemonStartError',
  {
    code: Schema.Literal('SLACK_DAEMON_START_FAILED'),
    message: Schema.String,
  }
) {}

export class SlackDaemonStopError extends Schema.TaggedError<SlackDaemonStopError>()(
  'SlackDaemonStopError',
  {
    code: Schema.Literal('SLACK_DAEMON_STOP_FAILED'),
    message: Schema.String,
  }
) {}

/** Machine-local source Slack daemon capabilities. */
export class SlackDaemonRpcs extends RpcGroup.make(
  Rpc.make('slackDaemon.status', {
    success: SlackDaemonStatus,
  }),
  Rpc.make('slackDaemon.start', {
    error: SlackDaemonStartError,
    success: SlackDaemonStatus,
  }),
  Rpc.make('slackDaemon.stop', {
    error: SlackDaemonStopError,
    success: SlackDaemonStatus,
  })
) {}

/** All mission-control capabilities carried by the daemon's single socket. */
export const DaemonRpcs = LaborerRpcs.merge(
  // Both legacy groups contain `terminal.spawn`. The public daemon keeps the
  // orchestration-aware Laborer contract; all other terminal manager methods
  // come from TerminalRpcs.
  TerminalRpcs.omit('terminal.spawn'),
  FileWatcherRpcs,
  SlackDaemonRpcs
)
