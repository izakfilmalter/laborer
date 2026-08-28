import { realpathSync } from 'node:fs'
import { BrowserAgentRpcs } from '@laborer/shared/browser-agent-rpc'
import { BrowserContextItem } from '@laborer/shared/browser-control'
import { taskDatabasePath } from '@laborer/task-db/path'
import { Context, Effect, Layer, Schema } from 'effect'
import { Tool, Toolkit } from 'effect/unstable/ai'
import { RpcClient } from 'effect/unstable/rpc'
import { AgentTaskError } from './agent-task-service.js'
import { NativeLaborerDatabase } from './native-laborer-database.js'

const Target = { tab_id: Schema.optional(Schema.String) }
const Timeout = Schema.optional(
  Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(60_000))
)
const ActionResult = Schema.Struct({})

const PreviewStatus = Tool.make('preview_status', {
  description:
    'Report the current collaborative browser tab URL, title, visibility, and loading state. Pass tab_id to inspect a specific tab.',
  parameters: Schema.Struct(Target),
  success: Schema.Unknown,
  failure: AgentTaskError,
})
const PreviewSnapshot = Tool.make('preview_snapshot', {
  description:
    'Inspect the page before interacting. Returns page state, semantic elements, diagnostics, action history, and a PNG screenshot.',
  parameters: Schema.Struct(Target),
  success: Schema.Unknown,
  failure: AgentTaskError,
})
const PreviewClick = Tool.make('preview_click', {
  description:
    'Click one target. Prefer a snapshot-provided locator; selector accepts legacy CSS, or supply x and y coordinates.',
  parameters: Schema.Struct({
    ...Target,
    locator: Schema.optional(Schema.String),
    selector: Schema.optional(Schema.String),
    x: Schema.optional(Schema.Finite),
    y: Schema.optional(Schema.Finite),
    timeout_ms: Timeout,
  }),
  success: ActionResult,
  failure: AgentTaskError,
})
const PreviewType = Tool.make('preview_type', {
  description:
    'Insert literal text into one input. Prefer a snapshot-provided locator and set clear=true to replace existing text.',
  parameters: Schema.Struct({
    ...Target,
    locator: Schema.optional(Schema.String),
    selector: Schema.optional(Schema.String),
    text: Schema.String,
    clear: Schema.optional(Schema.Boolean),
    timeout_ms: Timeout,
  }),
  success: ActionResult,
  failure: AgentTaskError,
})
const PreviewPress = Tool.make('preview_press', {
  description:
    'Press one keyboard key, optionally with Alt, Control, Meta, or Shift modifiers.',
  parameters: Schema.Struct({
    ...Target,
    key: Schema.String,
    modifiers: Schema.optional(
      Schema.Array(Schema.Literals(['Alt', 'Control', 'Meta', 'Shift']))
    ),
  }),
  success: ActionResult,
  failure: AgentTaskError,
})
const PreviewScroll = Tool.make('preview_scroll', {
  description:
    'Scroll the page or a targeted container. Positive delta_y scrolls down and positive delta_x scrolls right.',
  parameters: Schema.Struct({
    ...Target,
    locator: Schema.optional(Schema.String),
    selector: Schema.optional(Schema.String),
    delta_x: Schema.optional(Schema.Finite),
    delta_y: Schema.optional(Schema.Finite),
  }),
  success: ActionResult,
  failure: AgentTaskError,
})
const PreviewEvaluate = Tool.make('preview_evaluate', {
  description:
    'Evaluate JavaScript in the selected browser tab and return its serializable result.',
  parameters: Schema.Struct({
    ...Target,
    expression: Schema.String,
    await_promise: Schema.optional(Schema.Boolean),
    return_by_value: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Unknown,
  failure: AgentTaskError,
})
const PreviewWaitFor = Tool.make('preview_wait_for', {
  description:
    'Wait until all supplied locator, selector, text, and URL conditions match.',
  parameters: Schema.Struct({
    ...Target,
    locator: Schema.optional(Schema.String),
    selector: Schema.optional(Schema.String),
    text: Schema.optional(Schema.String),
    url_includes: Schema.optional(Schema.String),
    timeout_ms: Timeout,
  }),
  success: ActionResult,
  failure: AgentTaskError,
})
const ListBrowserContext = Tool.make('list_browser_context', {
  description:
    'List pending structured browser annotations delivered by the human for this workspace.',
  success: Schema.Struct({ items: Schema.Array(BrowserContextItem) }),
  failure: AgentTaskError,
})
const ConsumeBrowserContext = Tool.make('consume_browser_context', {
  description:
    'Mark one browser annotation consumed after reading its metadata and screenshot artifact.',
  parameters: Schema.Struct({ id: Schema.String }),
  success: BrowserContextItem,
  failure: AgentTaskError,
})

export const BrowserToolkit = Toolkit.make(
  PreviewStatus,
  PreviewSnapshot,
  PreviewClick,
  PreviewType,
  PreviewPress,
  PreviewScroll,
  PreviewEvaluate,
  PreviewWaitFor,
  ListBrowserContext,
  ConsumeBrowserContext
)

const makeDaemonClient = RpcClient.make(BrowserAgentRpcs)
type DaemonClient = Effect.Success<typeof makeDaemonClient>

export class BrowserAgentClient extends Context.Service<
  BrowserAgentClient,
  { readonly client: DaemonClient }
>()('@laborer/server/BrowserAgentClient') {
  static readonly layer = Layer.effect(
    BrowserAgentClient,
    makeDaemonClient.pipe(
      Effect.map((client) => BrowserAgentClient.of({ client }))
    )
  )
}

const currentWorkspaceId = Effect.try({
  try: () => {
    const cwd = realpathSync(process.cwd())
    const database = NativeLaborerDatabase.open(taskDatabasePath())
    try {
      const task = database.snapshot().tasks.find((row) => {
        if (row.worktreePath === null) {
          return false
        }
        try {
          return realpathSync(row.worktreePath) === cwd
        } catch {
          return false
        }
      })
      if (!task) {
        throw new Error('Current directory is not a Laborer workspace')
      }
      return task.id
    } finally {
      database.close()
    }
  },
  catch: (cause) =>
    new AgentTaskError({
      code: 'WORKSPACE_NOT_FOUND',
      message: cause instanceof Error ? cause.message : 'Workspace not found',
    }),
})

const rpcFailure = (error: unknown) =>
  new AgentTaskError({
    code:
      typeof error === 'object' &&
      error !== null &&
      '_tag' in error &&
      error._tag === 'BrowserControlError' &&
      'code' in error &&
      typeof error.code === 'string'
        ? error.code
        : 'BROWSER_RPC_FAILED',
    message:
      error instanceof Error ? error.message : 'Browser daemon request failed',
  })

export const browserInvocation = (values: {
  readonly [key: string]: unknown
}) => {
  const { tab_id, timeout_ms, ...raw } = values
  return {
    input: Object.fromEntries(
      [
        ...Object.entries(raw),
        ...(typeof timeout_ms === 'number'
          ? [['timeout_ms', timeout_ms] as const]
          : []),
      ].map(([key, value]) => [
        key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
        value,
      ])
    ),
    ...(typeof tab_id === 'string' ? { tabId: tab_id } : {}),
    ...(typeof timeout_ms === 'number' ? { timeoutMs: timeout_ms } : {}),
  }
}

const invoke = (
  client: DaemonClient,
  operation:
    | 'status'
    | 'snapshot'
    | 'click'
    | 'type'
    | 'press'
    | 'scroll'
    | 'evaluate'
    | 'waitFor',
  values: { readonly [key: string]: unknown }
) =>
  Effect.gen(function* () {
    const workspaceId = yield* currentWorkspaceId
    return yield* client['browserControl.invoke']({
      workspaceId,
      controllerId: `mcp-${String(process.pid)}`,
      operation,
      ...browserInvocation(values),
    }).pipe(Effect.mapError(rpcFailure))
  })

export const BrowserToolkitHandlers = BrowserToolkit.toLayer(
  Effect.gen(function* () {
    const { client } = yield* BrowserAgentClient
    return BrowserToolkit.of({
      preview_status: (input) => invoke(client, 'status', input ?? {}),
      preview_snapshot: (input) => invoke(client, 'snapshot', input ?? {}),
      preview_click: (input) =>
        invoke(client, 'click', input).pipe(Effect.as({})),
      preview_type: (input) =>
        invoke(client, 'type', input).pipe(Effect.as({})),
      preview_press: (input) =>
        invoke(client, 'press', input).pipe(Effect.as({})),
      preview_scroll: (input) =>
        invoke(client, 'scroll', input).pipe(Effect.as({})),
      preview_evaluate: (input) =>
        invoke(client, 'evaluate', input).pipe(
          Effect.map((result) => result ?? null)
        ),
      preview_wait_for: (input) =>
        invoke(client, 'waitFor', input).pipe(Effect.as({})),
      list_browser_context: () =>
        currentWorkspaceId.pipe(
          Effect.flatMap((workspaceId) =>
            client['browserContext.list']({ workspaceId })
          ),
          Effect.map((items) => ({ items })),
          Effect.mapError(rpcFailure)
        ),
      consume_browser_context: ({ id }) =>
        currentWorkspaceId.pipe(
          Effect.flatMap((workspaceId) =>
            client['browserContext.consume']({ workspaceId, id })
          ),
          Effect.mapError(rpcFailure)
        ),
    })
  })
)
