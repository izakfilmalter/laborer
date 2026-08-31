import { LabelColor, ReviewCommentThread } from '@laborer/shared/rpc'
import { Effect, Layer, Schema } from 'effect'
import { McpProtocol, McpServer, Tool, Toolkit } from 'effect/unstable/ai'
import { AgentTaskError, AgentTaskService } from './agent-task-service.js'
import { BrowserToolkit, BrowserToolkitHandlers } from './browser-mcp.js'

/**
 * The optimistic-concurrency guard agents may attach to a replace or update.
 *
 * Every shape here is chosen for what Effect's JSON Schema emitter makes of it,
 * because MCP clients normalise the advertised `inputSchema` and drop what they
 * cannot map:
 *
 * - The value is a bare `Schema.Int`. Chaining a second check onto a number —
 *   as `PositiveInt` does with `isInt` plus `isGreaterThan(0)` — renders the
 *   extra keyword as an anonymous `allOf` fragment
 *   (`{"type":"integer","allOf":[{"exclusiveMinimum":0}]}`), and the key
 *   vanished from the tool signature while the server still demanded it. A
 *   revision below the row's is rejected by the CAS check itself, so nothing is
 *   lost by describing it as a plain integer.
 * - It is `optionalKey`, not `optional`. `optional` admits `undefined`, which
 *   the emitter renders as a second `anyOf` member, so an already-nullable
 *   value came out as `anyOf: [anyOf: [T, null], null]` — the `T | null | null`
 *   agents were shown. JSON cannot carry `undefined` anyway; an absent key is
 *   the only way a client can leave one out.
 * - The `null` member is real, not an artefact: `NullOr` means an explicit
 *   `null` is accepted and, here, means the same as omitting the key. Annotating
 *   the `NullOr` union is also what keeps the description in the advertised
 *   schema, since a description hung on `Schema.Int` itself is emitted as an
 *   `allOf` fragment.
 */
const ExpectedRevision = Schema.optionalKey(Schema.NullOr(Schema.Int)).annotate(
  {
    description:
      'Optional optimistic-concurrency guard. Omit it or pass null for last-write-wins. Pass the `revision` field of the row as returned by get_task (or list_review_comments) to have the call fail with CAS_CONFLICT when someone else changed the row first.',
  }
)

/**
 * The revision to compare against, where both an absent key and an explicit
 * null mean "do not compare" — last-write-wins.
 */
const casRevision = (revision: number | null | undefined) =>
  revision ?? undefined

/** The same guard as a spreadable patch for the service's input records. */
const casGuard = (revision: number | null | undefined) => {
  const expectedRevision = casRevision(revision)
  return expectedRevision === undefined ? {} : { expectedRevision }
}

const TaskStatus = Schema.Literals([
  'todo',
  'in_progress',
  'in_review',
  'done',
  'cancelled',
])
const Task = Schema.Struct({
  actionName: Schema.NullOr(Schema.String),
  branchName: Schema.NullOr(Schema.String),
  createdAt: Schema.Int,
  description: Schema.NullOr(Schema.String),
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
  identifier: Schema.String,
  id: Schema.String,
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
  status: TaskStatus,
  taskNumber: Schema.Int,
  title: Schema.String,
  updatedAt: Schema.Int,
  worktreePath: Schema.NullOr(Schema.String),
})

/** A label, shared app-wide across every project. */
const Label = Schema.Struct({
  color: LabelColor,
  createdAt: Schema.Int,
  id: Schema.String,
  name: Schema.String,
  revision: Schema.Int,
  updatedAt: Schema.Int,
})

/**
 * The project a task belongs to. Named `path` for compatibility with existing
 * callers, but any of the three forms list_projects reports identifies a
 * project, so the value list_projects leads with works verbatim.
 */
const PROJECT_PATH = Schema.String.annotate({
  description:
    'Which project this applies to: its `name` (for example "laborer"), its task-ID `shortName` (for example "LAB"), or any absolute path inside its repository, such as a worktree. Names and short names are case-insensitive; call list_projects for the registered values.',
})

/** How every task-addressed tool names the row it acts on. */
const TASK_ID = Schema.String.annotate({
  description:
    'The readable identifier of the task, such as LAB-123, or its internal ULID. Both come back from get_task and list_tasks.',
})

const ListProjects = Tool.make('list_projects', {
  description:
    'List registered Laborer projects with their task-ID short names and canonical repository paths. Any of the three identifies a project wherever a `path` is asked for.',
  success: Schema.Struct({
    projects: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        repoPath: Schema.String,
        shortName: Schema.String,
      })
    ),
  }),
  failure: AgentTaskError,
})
const CreateTask = Tool.make('create_task', {
  description:
    'Stage a todo task on the Laborer board, optionally labeled. This never starts work or provisions a worktree.',
  parameters: Schema.Struct({
    description: Schema.optionalKey(Schema.NullOr(Schema.String)).annotate({
      description:
        'Optional markdown body for the task. Omit the key or pass null to stage it without one.',
    }),
    // optionalKey, not optional: an optional value also admits `undefined`,
    // which the JSON Schema emitter renders as `anyOf: [array, null]`. An
    // omitted key already says "no labels", so the flat array keeps the
    // advertised signature legible to clients that normalise `inputSchema`.
    label_ids: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
      description:
        'Optional label ids to apply as the task is created, saving a follow-up add_labels call. Ids come from list_labels; an id that names no label fails the call and creates nothing.',
    }),
    path: PROJECT_PATH,
    title: Schema.String.annotate({
      description: 'The task title shown on the board.',
    }),
  }),
  success: Task,
  failure: AgentTaskError,
})
const UpdateTask = Tool.make('update_task', {
  description:
    'Update only the title and/or description of a non-Execution task. The id may be a readable identifier such as LAB-123 or the internal ULID. Pass expected_revision to guard the write with revision CAS.',
  parameters: Schema.Struct({
    // Omission and an explicit null mean different things here, which is why
    // the key is `optionalKey` over a `NullOr` rather than a plain optional:
    // an absent key leaves the description untouched, null clears it.
    description: Schema.optionalKey(Schema.NullOr(Schema.String)).annotate({
      description:
        'Replacement markdown body. Pass null to clear the existing description; omit the key to leave it unchanged.',
    }),
    expected_revision: ExpectedRevision,
    id: TASK_ID,
    title: Schema.optionalKey(Schema.String).annotate({
      description:
        'Replacement title. Omit the key to leave it unchanged; a call must carry a title, a description, or both.',
    }),
  }),
  success: Task,
  failure: AgentTaskError,
})
const DeleteTask = Tool.make('delete_task', {
  description:
    'Soft-delete a task by changing its status to cancelled. The id may be a readable identifier such as LAB-123 or the internal ULID. Pass expected_revision to guard the write with revision CAS.',
  parameters: Schema.Struct({
    expected_revision: ExpectedRevision,
    id: TASK_ID,
  }),
  success: Task,
  failure: AgentTaskError,
})
const ListTasks = Tool.make('list_tasks', {
  description:
    'List board tasks, excluding cancelled tasks by default. Search matches identifier, title, and branch.',
  parameters: Schema.Struct({
    include_cancelled: Schema.optionalKey(Schema.Boolean).annotate({
      description:
        'Set true to include cancelled tasks, which delete_task produces and this tool otherwise hides.',
    }),
    // optionalKey keeps the annotated string in the advertised signature; an
    // optional value would emit an `anyOf` that buries the description.
    path: Schema.optionalKey(PROJECT_PATH),
    search: Schema.optionalKey(Schema.String).annotate({
      description:
        'Case-insensitive substring matched against the identifier, title, and branch name.',
    }),
    status: Schema.optionalKey(TaskStatus).annotate({
      description: 'Return only tasks currently in this status.',
    }),
  }),
  success: Schema.Struct({ tasks: Schema.Array(Task) }),
  failure: AgentTaskError,
})
const GetTask = Tool.make('get_task', {
  description:
    'Fetch the full shared task row by readable identifier (for example LAB-123) or internal ULID.',
  parameters: Schema.Struct({ id: TASK_ID }),
  success: Task,
  failure: AgentTaskError,
})

/** How every label-addressed tool names the label it acts on. */
const LABEL_ID = Schema.String.annotate({
  description: 'The id of the label, as returned by list_labels.',
})

/** The label ids a tool applies, replaces, or strips. */
const LABEL_IDS = Schema.Array(Schema.String).annotate({
  description:
    'Label ids from list_labels. An id that names no label fails the call and changes nothing.',
})

const ListLabels = Tool.make('list_labels', {
  description: 'List every label. Labels are app-wide, not per project.',
  success: Schema.Struct({ labels: Schema.Array(Label) }),
  failure: AgentTaskError,
})
const CreateLabel = Tool.make('create_label', {
  description:
    'Create an app-wide label usable by tasks in any project. An omitted color is derived from the name.',
  parameters: Schema.Struct({
    color: Schema.optionalKey(LabelColor).annotate({
      description:
        'Palette color for the label. Omit the key to derive one from the name.',
    }),
    name: Schema.String.annotate({ description: 'The label text.' }),
  }),
  success: Label,
  failure: AgentTaskError,
})
const UpdateLabel = Tool.make('update_label', {
  description:
    'Rename and/or recolor a label. Pass expected_revision to guard the write with revision CAS.',
  parameters: Schema.Struct({
    color: Schema.optionalKey(LabelColor).annotate({
      description:
        'Replacement palette color. Omit the key to keep the current one.',
    }),
    expected_revision: ExpectedRevision,
    id: LABEL_ID,
    name: Schema.optionalKey(Schema.String).annotate({
      description: 'Replacement label text. Omit the key to keep the current.',
    }),
  }),
  success: Label,
  failure: AgentTaskError,
})
const DeleteLabel = Tool.make('delete_label', {
  description:
    'Delete a label and strip its id from every task carrying it. Pass expected_revision to guard the write with revision CAS.',
  parameters: Schema.Struct({
    expected_revision: ExpectedRevision,
    id: LABEL_ID,
  }),
  success: Label,
  failure: AgentTaskError,
})
const SetTaskLabels = Tool.make('set_task_labels', {
  description:
    "Replace a task's whole label set, dropping every id not listed. Labels are app-wide, so any existing label id applies to any task. Prefer add_labels or remove_labels when you only mean to change some of them; those never discard a label someone else just applied.",
  parameters: Schema.Struct({
    expected_revision: ExpectedRevision,
    id: TASK_ID,
    label_ids: LABEL_IDS,
  }),
  success: Task,
  failure: AgentTaskError,
})
const AddLabels = Tool.make('add_labels', {
  description:
    'Add label ids to a task, keeping every label it already carries. Idempotent and safe to run concurrently, so it needs no revision. The id may be a readable identifier such as LAB-123 or the internal ULID; labels are app-wide, so any existing label id applies to any task.',
  parameters: Schema.Struct({
    id: TASK_ID,
    label_ids: LABEL_IDS,
  }),
  success: Task,
  failure: AgentTaskError,
})
const RemoveLabels = Tool.make('remove_labels', {
  description:
    'Remove label ids from a task, keeping every other label it carries. Idempotent and safe to run concurrently, so it needs no revision. Ids the task does not carry are ignored.',
  parameters: Schema.Struct({
    id: TASK_ID,
    label_ids: LABEL_IDS,
  }),
  success: Task,
  failure: AgentTaskError,
})

/** How the review tools name the conversation they act on. */
const THREAD_ID = Schema.String.annotate({
  description:
    'The id of the review comment thread, as returned by list_review_comments.',
})

const ListReviewComments = Tool.make('list_review_comments', {
  description:
    "Read the human's review comments on this workspace's diff: each is a conversation anchored to a file and line range, with every reply so far. This is how you find out what you have been asked to change. Answer each thread you act on with reply_to_review_comment, and call resolve_review_comment only once the request is actually addressed in the code — resolving means done, not read. Defaults to the workspace containing `path`, or the current working directory, and to unresolved threads only.",
  parameters: Schema.Struct({
    include_resolved: Schema.optionalKey(Schema.Boolean).annotate({
      description:
        'Set true to include threads already resolved, which this tool otherwise hides.',
    }),
    path: Schema.optionalKey(Schema.String).annotate({
      description:
        'An absolute path inside the workspace whose review threads you want. Defaults to the current working directory.',
    }),
    workspace_id: Schema.optionalKey(Schema.String).annotate({
      description:
        'The workspace to read instead of resolving one from `path`.',
    }),
  }),
  success: Schema.Struct({ comments: Schema.Array(ReviewCommentThread) }),
  failure: AgentTaskError,
})
const ReplyToReviewComment = Tool.make('reply_to_review_comment', {
  description:
    'Append your answer to a review comment thread and return the whole conversation. The reply is recorded as written by the agent; you cannot post as the human.',
  parameters: Schema.Struct({
    body: Schema.String.annotate({
      description: 'Your answer, as markdown, appended to the thread.',
    }),
    thread_id: THREAD_ID,
  }),
  success: ReviewCommentThread,
  failure: AgentTaskError,
})
const ResolveReviewComment = Tool.make('resolve_review_comment', {
  description:
    'Mark a review comment thread resolved using revision CAS, once its request is addressed in the code. expected_revision is required here and comes from the `revision` field of the thread as returned by list_review_comments; a stale revision means the thread moved, so re-read it before retrying.',
  parameters: Schema.Struct({
    // A bare Int, not PositiveInt, and left unannotated: see the
    // ExpectedRevision note above. A description on a required integer is
    // emitted as an `allOf` fragment, so this one lives in the tool
    // description instead.
    expected_revision: Schema.Int,
    thread_id: THREAD_ID,
  }),
  success: ReviewCommentThread,
  failure: AgentTaskError,
})

export const TaskToolkit = Toolkit.make(
  ListProjects,
  CreateTask,
  UpdateTask,
  DeleteTask,
  ListTasks,
  GetTask,
  ListLabels,
  CreateLabel,
  UpdateLabel,
  DeleteLabel,
  SetTaskLabels,
  AddLabels,
  RemoveLabels,
  ListReviewComments,
  ReplyToReviewComment,
  ResolveReviewComment
)

const exposeErrorCode = <A>(effect: Effect.Effect<A, AgentTaskError>) =>
  effect.pipe(
    Effect.mapError(
      (error) =>
        new AgentTaskError({
          code: error.code,
          message: `${error.code}: ${error.message}`,
        })
    )
  )

const TaskToolkitHandlers = TaskToolkit.toLayer(
  Effect.gen(function* () {
    const service = yield* AgentTaskService
    return TaskToolkit.of({
      list_projects: () =>
        exposeErrorCode(service.listProjects()).pipe(
          Effect.map((projects) => ({ projects }))
        ),
      create_task: ({ description, label_ids, path, title }) =>
        exposeErrorCode(
          service.createTask({
            ...(description === undefined ? {} : { description }),
            ...(label_ids === undefined ? {} : { labelIds: label_ids }),
            path,
            title,
          })
        ),
      update_task: ({ description, expected_revision, id, title }) =>
        exposeErrorCode(
          service.updateTask({
            // An absent key leaves the description alone; an explicit null
            // clears it, so only `undefined` may be dropped here.
            ...(description === undefined ? {} : { description }),
            ...(title === undefined ? {} : { title }),
            ...casGuard(expected_revision),
            id,
          })
        ),
      delete_task: ({ expected_revision, id }) =>
        exposeErrorCode(service.deleteTask(id, casRevision(expected_revision))),
      list_tasks: ({ include_cancelled, path, search, status }) =>
        exposeErrorCode(
          service.listTasks({
            ...(include_cancelled === undefined
              ? {}
              : { includeCancelled: include_cancelled }),
            ...(path === undefined ? {} : { path }),
            ...(search === undefined ? {} : { search }),
            ...(status === undefined ? {} : { status }),
          })
        ).pipe(Effect.map((tasks) => ({ tasks }))),
      get_task: ({ id }) => exposeErrorCode(service.getTask(id)),
      list_labels: () =>
        exposeErrorCode(service.listLabels()).pipe(
          Effect.map((labels) => ({ labels }))
        ),
      create_label: ({ color, name }) =>
        exposeErrorCode(
          service.createLabel({
            ...(color === undefined ? {} : { color }),
            name,
          })
        ),
      update_label: ({ color, expected_revision, id, name }) =>
        exposeErrorCode(
          service.updateLabel({
            ...(color === undefined ? {} : { color }),
            ...(name === undefined ? {} : { name }),
            ...casGuard(expected_revision),
            id,
          })
        ),
      delete_label: ({ expected_revision, id }) =>
        exposeErrorCode(
          service.deleteLabel(id, casRevision(expected_revision))
        ),
      list_review_comments: ({ include_resolved, path, workspace_id }) =>
        exposeErrorCode(
          service.listReviewComments({
            ...(include_resolved === undefined
              ? {}
              : { includeResolved: include_resolved }),
            ...(path === undefined ? {} : { path }),
            ...(workspace_id === undefined
              ? {}
              : { workspaceId: workspace_id }),
          })
        ).pipe(Effect.map((comments) => ({ comments }))),
      reply_to_review_comment: ({ body, thread_id }) =>
        exposeErrorCode(
          service.replyToReviewComment({ body, threadId: thread_id })
        ),
      resolve_review_comment: ({ expected_revision, thread_id }) =>
        exposeErrorCode(
          service.resolveReviewComment(thread_id, expected_revision)
        ),
      set_task_labels: ({ expected_revision, id, label_ids }) =>
        exposeErrorCode(
          service.setTaskLabels({
            ...casGuard(expected_revision),
            id,
            labelIds: label_ids,
          })
        ),
      add_labels: ({ id, label_ids }) =>
        exposeErrorCode(service.addTaskLabels({ id, labelIds: label_ids })),
      remove_labels: ({ id, label_ids }) =>
        exposeErrorCode(service.removeTaskLabels({ id, labelIds: label_ids })),
    })
  })
)

export const TaskMcpToolsLayer = McpServer.toolkit(TaskToolkit).pipe(
  Layer.provide(TaskToolkitHandlers)
)

export const BrowserMcpToolsLayer = McpServer.toolkit(BrowserToolkit).pipe(
  Layer.provide(BrowserToolkitHandlers)
)

export const TaskMcpStdioProtocolLayer = McpServer.layerStdio({
  name: 'laborer-current',
  protocols: [
    McpProtocol.v2024_11_05,
    McpProtocol.v2025_03_26,
    McpProtocol.v2025_06_18,
  ],
  version: '1.0.0',
})
