import { PositiveInt } from '@laborer/shared/rpc'
import { Effect, Layer, Schema } from 'effect'
import { McpServer, Tool, Toolkit } from 'effect/unstable/ai'
import { AgentTaskError, AgentTaskService } from './agent-task-service.js'

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

export const TaskToolkit = Toolkit.make(
  ListProjects,
  CreateTask,
  UpdateTask,
  DeleteTask,
  ListTasks,
  GetTask
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
    })
  })
)

export const TaskMcpToolsLayer = McpServer.toolkit(TaskToolkit).pipe(
  Layer.provide(TaskToolkitHandlers)
)

export const TaskMcpStdioProtocolLayer = McpServer.layerStdio({
  name: 'laborer-current',
  version: '1.0.0',
})
