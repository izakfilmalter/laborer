import { Effect, Layer, Option, Schema } from 'effect'
import { McpServer, Tool, Toolkit } from 'effect/unstable/ai'
import {
  HttpMiddleware,
  HttpServerRequest,
  HttpServerResponse,
} from 'effect/unstable/http'
import { AgentTaskError, AgentTaskService } from './agent-task-service.js'

const TaskStatus = Schema.Literal(
  'todo',
  'in_progress',
  'in_review',
  'done',
  'cancelled'
)
const Task = Schema.Struct({
  actionName: Schema.NullOr(Schema.String),
  branchName: Schema.NullOr(Schema.String),
  createdAt: Schema.Int,
  description: Schema.NullOr(Schema.String),
  executionId: Schema.NullOr(Schema.String),
  executionStatus: Schema.NullOr(
    Schema.Literal(
      'queued',
      'running',
      'cancelling',
      'completed',
      'failed',
      'cancelled',
      'needs-attention'
    )
  ),
  id: Schema.String,
  revision: Schema.Int,
  rootPath: Schema.String,
  slackPermalink: Schema.NullOr(Schema.String),
  source: Schema.Literal(
    'execution',
    'manual',
    'slack_url',
    'agent',
    'worktree'
  ),
  status: TaskStatus,
  title: Schema.String,
  updatedAt: Schema.Int,
  worktreePath: Schema.NullOr(Schema.String),
})

const ListProjects = Tool.make('list_projects', {
  description:
    'List registered Laborer projects and their canonical repository paths.',
  success: Schema.Struct({
    projects: Schema.Array(
      Schema.Struct({ name: Schema.String, repoPath: Schema.String })
    ),
  }),
})
const CreateTask = Tool.make('create_task', {
  description:
    'Stage a todo task on the Laborer board. This never starts work or provisions a worktree.',
  parameters: {
    description: Schema.optional(Schema.NullOr(Schema.String)),
    path: Schema.String,
    title: Schema.String,
  },
  success: Task,
  failure: AgentTaskError,
})
const UpdateTask = Tool.make('update_task', {
  description:
    'Update only the title and/or description of a non-Execution task using revision CAS.',
  parameters: {
    description: Schema.optional(Schema.NullOr(Schema.String)),
    expected_revision: Schema.Positive.pipe(Schema.isInt()),
    id: Schema.String,
    title: Schema.optional(Schema.String),
  },
  success: Task,
  failure: AgentTaskError,
})
const DeleteTask = Tool.make('delete_task', {
  description:
    'Soft-delete a task by changing its status to cancelled using revision CAS.',
  parameters: {
    expected_revision: Schema.Positive.pipe(Schema.isInt()),
    id: Schema.String,
  },
  success: Task,
  failure: AgentTaskError,
})
const ListTasks = Tool.make('list_tasks', {
  description:
    'List board tasks, excluding cancelled tasks by default. Search matches title and branch.',
  parameters: {
    include_cancelled: Schema.optional(Schema.Boolean),
    path: Schema.optional(Schema.String),
    search: Schema.optional(Schema.String),
    status: Schema.optional(TaskStatus),
  },
  success: Schema.Struct({ tasks: Schema.Array(Task) }),
  failure: AgentTaskError,
})
const GetTask = Tool.make('get_task', {
  description: 'Fetch the full shared task row by id.',
  parameters: { id: Schema.String },
  success: Task,
  failure: AgentTaskError,
})

export const TaskToolkit = Toolkit.make(
  ListProjects,
  CreateTask,
  UpdateTask,
  DeleteTask,
  ListTasks,
  GetTask
)

const TaskToolkitHandlers = TaskToolkit.toLayer(
  Effect.gen(function* () {
    const service = yield* AgentTaskService
    return TaskToolkit.of({
      list_projects: () =>
        service.listProjects().pipe(Effect.map((projects) => ({ projects }))),
      create_task: ({ description, path, title }) =>
        service.createTask({
          ...(description === undefined ? {} : { description }),
          path,
          title,
        }),
      update_task: ({ description, expected_revision, id, title }) =>
        service.updateTask({
          ...(description === undefined ? {} : { description }),
          ...(title === undefined ? {} : { title }),
          expectedRevision: expected_revision,
          id,
        }),
      delete_task: ({ expected_revision, id }) =>
        service.deleteTask(id, expected_revision),
      list_tasks: ({ include_cancelled, path, search, status }) =>
        service
          .listTasks({
            ...(include_cancelled === undefined
              ? {}
              : { includeCancelled: include_cancelled }),
            ...(path === undefined ? {} : { path }),
            ...(search === undefined ? {} : { search }),
            ...(status === undefined ? {} : { status }),
          })
          .pipe(Effect.map((tasks) => ({ tasks }))),
      get_task: ({ id }) => service.getTask(id),
    })
  })
)

export const TaskMcpToolsLayer = McpServer.toolkit(TaskToolkit).pipe(
  Layer.provide(TaskToolkitHandlers)
)

export const TaskMcpProtocolLayer = McpServer.layerHttp({
  name: 'laborer-current',
  path: '/mcp',
  version: '1.0.0',
})

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', '::1', 'localhost'])

export const isAllowedMcpOrigin = (origin: string): boolean => {
  try {
    const url = new URL(origin)
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      LOOPBACK_HOSTS.has(url.hostname)
    )
  } catch {
    return false
  }
}

/**
 * Streamable HTTP requires Origin validation to keep an arbitrary web page
 * from using a visitor's browser to mutate this deliberately token-free local
 * endpoint. Native MCP clients normally omit Origin and remain unaffected.
 */
export const mcpOriginGuard = HttpMiddleware.make((app) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const url = HttpServerRequest.toURL(request)
    const origin = request.headers.origin
    if (
      Option.isSome(url) &&
      url.value.pathname === '/mcp' &&
      origin !== undefined &&
      !isAllowedMcpOrigin(origin)
    ) {
      return yield* HttpServerResponse.text('Forbidden MCP origin', {
        status: 403,
      })
    }
    return yield* app
  })
)
