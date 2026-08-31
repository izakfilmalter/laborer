import { realpathSync } from 'node:fs'
import { BrowserAgentRpcs } from '@laborer/shared/browser-agent-rpc'
import {
  BrowserContextItem,
  BrowserControlNavigateInput,
  BrowserControlOpenInput,
  BrowserControlRecordingArtifact,
  BrowserControlRecordingStatus,
  BrowserControlResizeInput,
  BrowserControlResizeResult,
  BrowserControlStatus,
  BrowserControlViewportPresetId,
} from '@laborer/shared/browser-control'
import { taskDatabasePath } from '@laborer/task-db/path'
import { Context, Effect, Layer, Schema } from 'effect'
import { Tool, Toolkit } from 'effect/unstable/ai'
import { RpcClient } from 'effect/unstable/rpc'
import { AgentTaskError } from './agent-task-service.js'
import { NativeLaborerDatabase } from './native-laborer-database.js'

/**
 * Every advertised parameter here is a flat, unchecked JSON Schema type, and
 * the constraints live in `validateInvocation` below instead. Effect's JSON
 * Schema emitter renders a `check` as an anonymous `allOf` fragment and
 * `Schema.optional` as an `anyOf` with a `null` member that no JSON caller can
 * send, and MCP clients that normalise `inputSchema` drop properties they
 * cannot map — a required one, like `preview_navigate.url`, disappearing from
 * the signature while the server still demands it. Decoding the assembled
 * payload against the shared browser-control contract keeps every rule,
 * including the cross-field ones that were never enforced here before.
 */
const TAB_ID = Schema.String.annotate({
  description:
    'Which collaborative browser tab to act on. Defaults to the tab preview_status reports.',
})
const Target = { tab_id: Schema.optionalKey(TAB_ID) }
const TimeoutMs = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(60_000)
)
const Timeout = Schema.optionalKey(Schema.Int)
const Locator = Schema.optionalKey(
  Schema.String.annotate({
    description: 'A locator from the latest preview_snapshot. Prefer this.',
  })
)
const Selector = Schema.optionalKey(
  Schema.String.annotate({
    description: 'A legacy CSS selector, used only when no locator fits.',
  })
)
const ActionResult = Schema.Struct({})

const PreviewStatus = Tool.make('preview_status', {
  description:
    'Report the current collaborative browser tab URL, title, visibility, and loading state. Pass tab_id to inspect a specific tab.',
  parameters: Schema.Struct(Target),
  success: BrowserControlStatus,
  failure: AgentTaskError,
})
const PreviewOpen = Tool.make('preview_open', {
  description:
    'Initialize a collaborative browser tab. Reuses the current tab by default; set reuse_existing_tab=false to create another tab.',
  parameters: Schema.Struct({
    ...Target,
    url: Schema.optionalKey(
      Schema.String.annotate({
        description:
          'Absolute URL to load into the tab. Omit it to initialize an empty tab.',
      })
    ),
    open: Schema.optionalKey(
      Schema.Boolean.annotate({
        description: 'Set false to prepare the tab without revealing it.',
      })
    ),
    reuse_existing_tab: Schema.optionalKey(
      Schema.Boolean.annotate({
        description:
          'Set false to create another tab. It cannot be combined with tab_id.',
      })
    ),
  }),
  success: BrowserControlStatus,
  failure: AgentTaskError,
})
const PreviewNavigate = Tool.make('preview_navigate', {
  description:
    'Navigate the selected collaborative browser tab and optionally wait for load or DOM readiness. timeout_ms is milliseconds, from 1 to 60000.',
  parameters: Schema.Struct({
    ...Target,
    url: Schema.String.annotate({
      description: 'Absolute URL to load into the tab.',
    }),
    readiness: Schema.optionalKey(
      Schema.Literals(['load', 'domContentLoaded', 'none']).annotate({
        description: 'How long to wait before reporting the tab state back.',
      })
    ),
    timeout_ms: Timeout,
  }),
  success: BrowserControlStatus,
  failure: AgentTaskError,
})
const PreviewResize = Tool.make('preview_resize', {
  description:
    'Resize the selected browser tab using fill, exact freeform dimensions, or a named device preset. Freeform takes width and height only, both 240 to 3840 pixels; preset takes a preset and an optional orientation; fill takes neither.',
  parameters: Schema.Struct({
    ...Target,
    mode: Schema.Literals(['fill', 'freeform', 'preset']).annotate({
      description:
        'Which sizing rule applies, and therefore which other keys are accepted.',
    }),
    preset: Schema.optionalKey(
      BrowserControlViewportPresetId.annotate({
        description: 'The device preset to size the tab to, in preset mode.',
      })
    ),
    width: Schema.optionalKey(Schema.Int),
    height: Schema.optionalKey(Schema.Int),
    orientation: Schema.optionalKey(
      Schema.Literals(['portrait', 'landscape']).annotate({
        description: 'How to rotate the preset, in preset mode.',
      })
    ),
    timeout_ms: Timeout,
  }),
  success: BrowserControlResizeResult,
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
    'Click one target. Prefer a snapshot-provided locator; selector accepts legacy CSS, or supply x and y coordinates. timeout_ms is milliseconds, from 1 to 60000.',
  parameters: Schema.Struct({
    ...Target,
    locator: Locator,
    selector: Selector,
    x: Schema.optionalKey(Schema.Finite),
    y: Schema.optionalKey(Schema.Finite),
    timeout_ms: Timeout,
  }),
  success: ActionResult,
  failure: AgentTaskError,
})
const PreviewType = Tool.make('preview_type', {
  description:
    'Insert literal text into one input. Prefer a snapshot-provided locator and set clear=true to replace existing text. timeout_ms is milliseconds, from 1 to 60000.',
  parameters: Schema.Struct({
    ...Target,
    locator: Locator,
    selector: Selector,
    text: Schema.String.annotate({
      description: 'The literal text to insert, typed as written.',
    }),
    clear: Schema.optionalKey(
      Schema.Boolean.annotate({
        description:
          'Set true to replace the field contents instead of appending.',
      })
    ),
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
    key: Schema.String.annotate({
      description: 'The key name to press, such as Enter, Tab, or a.',
    }),
    modifiers: Schema.optionalKey(
      Schema.Array(
        Schema.Literals(['Alt', 'Control', 'Meta', 'Shift'])
      ).annotate({ description: 'Modifiers held while the key is pressed.' })
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
    locator: Locator,
    selector: Selector,
    delta_x: Schema.optionalKey(Schema.Finite),
    delta_y: Schema.optionalKey(Schema.Finite),
  }),
  success: ActionResult,
  failure: AgentTaskError,
})
const PreviewEvaluate = Tool.make('preview_evaluate', {
  description:
    'Evaluate JavaScript in the selected browser tab and return its serializable result.',
  parameters: Schema.Struct({
    ...Target,
    expression: Schema.String.annotate({
      description: 'The JavaScript expression to evaluate in the page.',
    }),
    await_promise: Schema.optionalKey(
      Schema.Boolean.annotate({
        description: 'Set true to await a promise the expression returns.',
      })
    ),
    return_by_value: Schema.optionalKey(
      Schema.Boolean.annotate({
        description: 'Set false to return a handle rather than a copy.',
      })
    ),
  }),
  success: Schema.Unknown,
  failure: AgentTaskError,
})
const PreviewWaitFor = Tool.make('preview_wait_for', {
  description:
    'Wait until all supplied locator, selector, text, and URL conditions match. timeout_ms is milliseconds, from 1 to 60000.',
  parameters: Schema.Struct({
    ...Target,
    locator: Locator,
    selector: Selector,
    text: Schema.optionalKey(
      Schema.String.annotate({
        description: 'Text that must appear on the page before returning.',
      })
    ),
    url_includes: Schema.optionalKey(
      Schema.String.annotate({
        description: 'A substring the tab URL must contain before returning.',
      })
    ),
    timeout_ms: Timeout,
  }),
  success: ActionResult,
  failure: AgentTaskError,
})
const PreviewRecordingStart = Tool.make('preview_recording_start', {
  description: 'Start recording the selected collaborative browser tab.',
  parameters: Schema.Struct(Target),
  success: BrowserControlRecordingStatus,
  failure: AgentTaskError,
})
const PreviewRecordingStop = Tool.make('preview_recording_stop', {
  description:
    'Stop recording the selected collaborative browser tab and save a local evidence artifact.',
  parameters: Schema.Struct(Target),
  success: BrowserControlRecordingArtifact,
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
  parameters: Schema.Struct({
    id: Schema.String.annotate({
      description:
        'The id of the annotation, as returned by list_browser_context.',
    }),
  }),
  success: BrowserContextItem,
  failure: AgentTaskError,
})

export const BrowserToolkit = Toolkit.make(
  PreviewStatus,
  PreviewOpen,
  PreviewNavigate,
  PreviewResize,
  PreviewSnapshot,
  PreviewClick,
  PreviewType,
  PreviewPress,
  PreviewScroll,
  PreviewEvaluate,
  PreviewWaitFor,
  PreviewRecordingStart,
  PreviewRecordingStop,
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

type BrowserOperation =
  | 'status'
  | 'open'
  | 'navigate'
  | 'resize'
  | 'snapshot'
  | 'click'
  | 'type'
  | 'press'
  | 'scroll'
  | 'evaluate'
  | 'waitFor'
  | 'recordingStart'
  | 'recordingStop'

const invalidInput = (message: string) =>
  new AgentTaskError({ code: 'INVALID_INPUT', message })

const decodeOpen = Schema.decodeUnknownEffect(BrowserControlOpenInput)
const decodeNavigate = Schema.decodeUnknownEffect(BrowserControlNavigateInput)
const decodeResize = Schema.decodeUnknownEffect(BrowserControlResizeInput)
const decodeTimeout = Schema.decodeUnknownEffect(TimeoutMs)

const decodeOperationInput = (
  operation: BrowserOperation,
  payload: { readonly [key: string]: unknown }
) => {
  switch (operation) {
    case 'open':
      return decodeOpen(payload)
    case 'navigate':
      return decodeNavigate(payload)
    case 'resize':
      return decodeResize(payload)
    default:
      return undefined
  }
}

/**
 * The contract each operation's assembled payload must satisfy. The advertised
 * parameter schemas are deliberately unchecked so they stay flat, so this is
 * where a blank URL, an out-of-range viewport or timeout, or an impossible
 * resize combination is rejected — by the same shared schemas the daemon
 * documents, including the cross-field rules nothing checked here before.
 */
export const validateInvocation = (
  operation: BrowserOperation,
  invocation: ReturnType<typeof browserInvocation>
) =>
  Effect.gen(function* () {
    const { timeoutMs } = invocation
    if (timeoutMs !== undefined) {
      yield* decodeTimeout(timeoutMs).pipe(
        Effect.mapError((error) => invalidInput(`timeout_ms: ${error.message}`))
      )
    }
    const payload = {
      ...invocation.input,
      ...('tabId' in invocation ? { tabId: invocation.tabId } : {}),
    }
    const decoded = decodeOperationInput(operation, payload)
    if (decoded !== undefined) {
      yield* decoded.pipe(
        Effect.mapError((error) =>
          invalidInput(`${operation}: ${error.message}`)
        )
      )
    }
  })

const invoke = (
  client: DaemonClient,
  operation: BrowserOperation,
  values: { readonly [key: string]: unknown }
) =>
  Effect.gen(function* () {
    const workspaceId = yield* currentWorkspaceId
    const invocation = browserInvocation(values)
    yield* validateInvocation(operation, invocation)
    return yield* client['browserControl.invoke']({
      workspaceId,
      controllerId: `mcp-${String(process.pid)}`,
      operation,
      ...invocation,
    }).pipe(Effect.mapError(rpcFailure))
  })

export const BrowserToolkitHandlers = BrowserToolkit.toLayer(
  Effect.gen(function* () {
    const { client } = yield* BrowserAgentClient
    return BrowserToolkit.of({
      preview_status: (input) =>
        invoke(client, 'status', input ?? {}).pipe(
          Effect.map((result) => result as typeof BrowserControlStatus.Type)
        ),
      preview_open: (input) =>
        invoke(client, 'open', input).pipe(
          Effect.map((result) => result as typeof BrowserControlStatus.Type)
        ),
      preview_navigate: (input) =>
        invoke(client, 'navigate', input).pipe(
          Effect.map((result) => result as typeof BrowserControlStatus.Type)
        ),
      preview_resize: (input) =>
        invoke(client, 'resize', input).pipe(
          Effect.map(
            (result) => result as typeof BrowserControlResizeResult.Type
          )
        ),
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
      preview_recording_start: (input) =>
        invoke(client, 'recordingStart', input ?? {}).pipe(
          Effect.map(
            (result) => result as typeof BrowserControlRecordingStatus.Type
          )
        ),
      preview_recording_stop: (input) =>
        invoke(client, 'recordingStop', input ?? {}).pipe(
          Effect.map(
            (result) => result as typeof BrowserControlRecordingArtifact.Type
          )
        ),
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
