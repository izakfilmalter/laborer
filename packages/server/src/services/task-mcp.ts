import {
  LabelColor,
  PositiveInt,
  ReviewCommentThread,
} from '@laborer/shared/rpc'
import { Effect, Layer, Schema } from 'effect'
import { McpProtocol, McpServer, Tool, Toolkit } from 'effect/unstable/ai'
import { AgentTaskError, AgentTaskService } from './agent-task-service.js'
import { BrowserToolkit, BrowserToolkitHandlers } from './browser-mcp.js'

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

const ListProjects = Tool.make('list_projects', {
  description:
    'List registered Laborer projects with their task-ID short names and canonical repository paths.',
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
    'Stage a todo task on the Laborer board. This never starts work or provisions a worktree.',
  parameters: Schema.Struct({
    description: Schema.optional(Schema.NullOr(Schema.String)),
    path: Schema.String,
    title: Schema.String,
  }),
  success: Task,
  failure: AgentTaskError,
})
const UpdateTask = Tool.make('update_task', {
  description:
    'Update only the title and/or description of a non-Execution task using revision CAS. The id may be a readable identifier such as LAB-123 or the internal ULID.',
  parameters: Schema.Struct({
    description: Schema.optional(Schema.NullOr(Schema.String)),
    expected_revision: PositiveInt,
    id: Schema.String,
    title: Schema.optional(Schema.String),
  }),
  success: Task,
  failure: AgentTaskError,
})
const DeleteTask = Tool.make('delete_task', {
  description:
    'Soft-delete a task by changing its status to cancelled using revision CAS. The id may be a readable identifier such as LAB-123 or the internal ULID.',
  parameters: Schema.Struct({
    expected_revision: PositiveInt,
    id: Schema.String,
  }),
  success: Task,
  failure: AgentTaskError,
})
const ListTasks = Tool.make('list_tasks', {
  description:
    'List board tasks, excluding cancelled tasks by default. Search matches identifier, title, and branch.',
  parameters: Schema.Struct({
    include_cancelled: Schema.optional(Schema.Boolean),
    path: Schema.optional(Schema.String),
    search: Schema.optional(Schema.String),
    status: Schema.optional(TaskStatus),
  }),
  success: Schema.Struct({ tasks: Schema.Array(Task) }),
  failure: AgentTaskError,
})
const GetTask = Tool.make('get_task', {
  description:
    'Fetch the full shared task row by readable identifier (for example LAB-123) or internal ULID.',
  parameters: Schema.Struct({ id: Schema.String }),
  success: Task,
  failure: AgentTaskError,
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
    color: Schema.optional(LabelColor),
    name: Schema.String,
  }),
  success: Label,
  failure: AgentTaskError,
})
const UpdateLabel = Tool.make('update_label', {
  description: 'Rename and/or recolor a label using revision CAS.',
  parameters: Schema.Struct({
    color: Schema.optional(LabelColor),
    expected_revision: PositiveInt,
    id: Schema.String,
    name: Schema.optional(Schema.String),
  }),
  success: Label,
  failure: AgentTaskError,
})
const DeleteLabel = Tool.make('delete_label', {
  description:
    'Delete a label using revision CAS and strip its id from every task carrying it.',
  parameters: Schema.Struct({
    expected_revision: PositiveInt,
    id: Schema.String,
  }),
  success: Label,
  failure: AgentTaskError,
})
const SetTaskLabels = Tool.make('set_task_labels', {
  description:
    "Replace a task's whole label set using revision CAS. Labels are app-wide, so any existing label id applies to any task.",
  parameters: Schema.Struct({
    expected_revision: PositiveInt,
    id: Schema.String,
    label_ids: Schema.Array(Schema.String),
  }),
  success: Task,
  failure: AgentTaskError,
})

const ListReviewComments = Tool.make('list_review_comments', {
  description:
    "Read the human's review comments on this workspace's diff: each is a conversation anchored to a file and line range, with every reply so far. This is how you find out what you have been asked to change. Answer each thread you act on with reply_to_review_comment, and call resolve_review_comment only once the request is actually addressed in the code — resolving means done, not read. Defaults to the workspace containing `path`, or the current working directory, and to unresolved threads only.",
  parameters: Schema.Struct({
    include_resolved: Schema.optional(Schema.Boolean),
    path: Schema.optional(Schema.String),
    workspace_id: Schema.optional(Schema.String),
  }),
  success: Schema.Struct({ comments: Schema.Array(ReviewCommentThread) }),
  failure: AgentTaskError,
})
const ReplyToReviewComment = Tool.make('reply_to_review_comment', {
  description:
    'Append your answer to a review comment thread and return the whole conversation. The reply is recorded as written by the agent; you cannot post as the human.',
  parameters: Schema.Struct({
    body: Schema.String,
    thread_id: Schema.String,
  }),
  success: ReviewCommentThread,
  failure: AgentTaskError,
})
const ResolveReviewComment = Tool.make('resolve_review_comment', {
  description:
    'Mark a review comment thread resolved using revision CAS, once its request is addressed in the code. The revision comes from list_review_comments; a stale revision means the thread moved, so re-read it before retrying.',
  parameters: Schema.Struct({
    expected_revision: PositiveInt,
    thread_id: Schema.String,
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
      create_task: ({ description, path, title }) =>
        exposeErrorCode(
          service.createTask({
            ...(description === undefined ? {} : { description }),
            path,
            title,
          })
        ),
      update_task: ({ description, expected_revision, id, title }) =>
        exposeErrorCode(
          service.updateTask({
            ...(description === undefined ? {} : { description }),
            ...(title === undefined ? {} : { title }),
            expectedRevision: expected_revision,
            id,
          })
        ),
      delete_task: ({ expected_revision, id }) =>
        exposeErrorCode(service.deleteTask(id, expected_revision)),
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
            expectedRevision: expected_revision,
            id,
          })
        ),
      delete_label: ({ expected_revision, id }) =>
        exposeErrorCode(service.deleteLabel(id, expected_revision)),
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
            expectedRevision: expected_revision,
            id,
            labelIds: label_ids,
          })
        ),
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
