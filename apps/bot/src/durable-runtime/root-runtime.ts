import { createHash } from 'node:crypto'
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Array as EffectArray,
  Exit,
  Layer,
  Option,
  pipe,
  Schedule,
  Schema,
  Semaphore,
} from 'effect'
import { ClusterWorkflowEngine, SingleRunner } from 'effect/unstable/cluster'
import { SqlClient } from 'effect/unstable/sql/SqlClient'
import { Activity, Workflow, WorkflowEngine } from 'effect/unstable/workflow'
import { canonicalActionInput } from '../action-catalog.ts'
import {
  ApplicationConversationMessageChunk,
  ApplicationEvent,
  type ApplicationPublicOutput,
  ApplicationPublicReply,
  ExternalInputEvent,
  ParticipantInputEvent,
} from '../application.ts'
import { ThreadId } from '../core/domain.ts'
import {
  ACTION_NAME_MAX_LENGTH,
  ACTION_REVISION_MAX_LENGTH,
  ActionRegistrationError,
  type RegisteredAction,
  type RegisteredActionCatalog,
  type RegisteredActionContext,
} from './action.ts'
import {
  ExecutionTaskEmission,
  type ExecutionTaskEmitter,
  noopExecutionTaskEmitter,
} from './execution-task-emitter.ts'

const RUNTIME_SCHEMA_VERSION = 6
export const RUNTIME_MAX_CONCURRENT_EXECUTIONS = 8
export const RUNTIME_PAYLOAD_MAX_BYTES = 64 * 1024
const RUNTIME_EXECUTION_EVENT_PAYLOAD_MAX_BYTES = 48 * 1024
export const RUNTIME_CONVERSATION_ID_MAX_LENGTH = 512
export const RUNTIME_INVOCATION_ID_MAX_LENGTH = 512
export const RUNTIME_ROOT_IDENTITY_MAX_LENGTH = 4096
export const RUNTIME_EXECUTION_ID_MAX_LENGTH = 160
export const RUNTIME_EVENT_ID_MAX_LENGTH = 256
export const RUNTIME_PROGRESS_ID_MAX_LENGTH = 256
export const RUNTIME_CONTROL_ID_MAX_LENGTH = 256
export const RUNTIME_FOLLOW_UP_MAX_LENGTH = 16 * 1024
export const RUNTIME_WORKSPACE_ID_MAX_LENGTH = 256
const RUNTIME_CATALOG_FINGERPRINT_MAX_LENGTH = 64
const RUNTIME_ACTION_FINGERPRINT_MAX_LENGTH = 64
const SHA256_BASE64URL_PATTERN = /^[\w-]{43}$/u
const NONBLANK_PATTERN = /\S/

const boundedNonBlankString = (maximumLength: number) =>
  Schema.String.check(
    Schema.isPattern(NONBLANK_PATTERN),
    Schema.isMaxLength(maximumLength)
  )
export const RuntimeConversationId = boundedNonBlankString(
  RUNTIME_CONVERSATION_ID_MAX_LENGTH
)
export const RuntimeInvocationId = boundedNonBlankString(
  RUNTIME_INVOCATION_ID_MAX_LENGTH
)
export const RuntimeRootIdentity = boundedNonBlankString(
  RUNTIME_ROOT_IDENTITY_MAX_LENGTH
)
export const RuntimeExecutionId = boundedNonBlankString(
  RUNTIME_EXECUTION_ID_MAX_LENGTH
)
export const RuntimeEventId = boundedNonBlankString(RUNTIME_EVENT_ID_MAX_LENGTH)
export const RuntimeProgressId = boundedNonBlankString(
  RUNTIME_PROGRESS_ID_MAX_LENGTH
)
export const RuntimeControlId = boundedNonBlankString(
  RUNTIME_CONTROL_ID_MAX_LENGTH
)
export const RuntimeWorkspaceId = boundedNonBlankString(
  RUNTIME_WORKSPACE_ID_MAX_LENGTH
)
export const ExecutionStatus = Schema.Literals([
  'queued',
  'running',
  'cancelling',
  'completed',
  'failed',
  'cancelled',
  'needs-attention',
])
export type ExecutionStatus = typeof ExecutionStatus.Type

export const StartExecutionRequest = Schema.Struct({
  actionName: boundedNonBlankString(ACTION_NAME_MAX_LENGTH),
  conversationId: RuntimeConversationId,
  input: Schema.Unknown,
  invocationId: RuntimeInvocationId,
  rootIdentity: RuntimeRootIdentity,
  workspaceId: RuntimeWorkspaceId,
})
export type StartExecutionRequest = typeof StartExecutionRequest.Type

export const ExecutionSnapshot = Schema.Struct({
  actionFingerprint: boundedNonBlankString(
    RUNTIME_ACTION_FINGERPRINT_MAX_LENGTH
  ),
  actionName: boundedNonBlankString(ACTION_NAME_MAX_LENGTH),
  actionRevision: boundedNonBlankString(ACTION_REVISION_MAX_LENGTH),
  catalogFingerprint: boundedNonBlankString(
    RUNTIME_CATALOG_FINGERPRINT_MAX_LENGTH
  ),
  conversationId: RuntimeConversationId,
  executionId: RuntimeExecutionId,
  failureCategory: Schema.NullOr(
    Schema.Literals([
      'action-failed',
      'invalid-result',
      'needs-attention',
      'unexpected-failure',
    ])
  ),
  invocationId: RuntimeInvocationId,
  result: Schema.NullOr(Schema.Unknown),
  status: ExecutionStatus,
  workspaceId: RuntimeWorkspaceId,
})
export type ExecutionSnapshot = typeof ExecutionSnapshot.Type

export const ExecutionEvent = Schema.Struct({
  conversationId: RuntimeConversationId,
  eventId: RuntimeEventId,
  executionId: RuntimeExecutionId,
  kind: Schema.Literals(['progress', 'completed', 'failed', 'cancelled']),
  payload: Schema.Unknown,
  sequence: Schema.Int.check(Schema.isGreaterThan(0)),
  workspaceId: RuntimeWorkspaceId,
})
export type ExecutionEvent = typeof ExecutionEvent.Type

export const ExecutionControlSnapshot = Schema.Struct({
  actionName: boundedNonBlankString(ACTION_NAME_MAX_LENGTH),
  actionRevision: boundedNonBlankString(ACTION_REVISION_MAX_LENGTH),
  canCancel: Schema.Boolean,
  canFollowUp: Schema.Boolean,
  conversationId: RuntimeConversationId,
  executionId: RuntimeExecutionId,
  status: ExecutionStatus,
  workspaceId: RuntimeWorkspaceId,
})
export type ExecutionControlSnapshot = typeof ExecutionControlSnapshot.Type

const ExecutionControlRequestBase = {
  controlId: RuntimeControlId,
  conversationId: RuntimeConversationId,
  executionId: RuntimeExecutionId,
  workspaceId: RuntimeWorkspaceId,
} as const
export const InspectExecutionRequest = Schema.Struct(
  ExecutionControlRequestBase
)
export type InspectExecutionRequest = typeof InspectExecutionRequest.Type
export const FollowUpExecutionRequest = Schema.Struct({
  ...ExecutionControlRequestBase,
  content: boundedNonBlankString(RUNTIME_FOLLOW_UP_MAX_LENGTH),
})
export type FollowUpExecutionRequest = typeof FollowUpExecutionRequest.Type
export const CancelExecutionRequest = Schema.Struct(ExecutionControlRequestBase)
export type CancelExecutionRequest = typeof CancelExecutionRequest.Type
export const ExecutionControlReceipt = Schema.Struct({
  controlId: RuntimeControlId,
  deduplicated: Schema.Boolean,
  execution: ExecutionControlSnapshot,
})
export type ExecutionControlReceipt = typeof ExecutionControlReceipt.Type

export const ConversationOutput = Schema.Union([
  ApplicationConversationMessageChunk,
  ApplicationPublicReply,
])
export type ConversationOutput = typeof ConversationOutput.Type

export const RunConversationRequest = Schema.Struct({
  event: ParticipantInputEvent,
  rootIdentity: RuntimeRootIdentity,
  workspaceId: RuntimeWorkspaceId,
})
export type RunConversationRequest = typeof RunConversationRequest.Type

export const ConversationReceipt = Schema.Struct({
  conversationId: RuntimeConversationId,
  eventId: RuntimeInvocationId,
  outputs: Schema.Array(ConversationOutput),
  sequence: Schema.Int.check(Schema.isGreaterThan(0)),
  sessionId: boundedNonBlankString(RUNTIME_EXECUTION_ID_MAX_LENGTH),
  workspaceId: RuntimeWorkspaceId,
})
export type ConversationReceipt = typeof ConversationReceipt.Type

export const ConversationClientCompatibility = Schema.Struct({
  actionCatalogFingerprint: boundedNonBlankString(
    RUNTIME_CATALOG_FINGERPRINT_MAX_LENGTH
  ),
})
export type ConversationClientCompatibility =
  typeof ConversationClientCompatibility.Type

export class DurableRuntimeError extends Schema.TaggedErrorClass<DurableRuntimeError>()(
  'DurableRuntimeError',
  {
    reason: Schema.Literals([
      'conflicting-invocation',
      'conflicting-control',
      'control-failed',
      'execution-not-active',
      'execution-not-found',
      'invalid-payload',
      'incompatible-client',
      'conversation-handler-unavailable',
      'storage-failure',
      'unsupported-control',
      'unavailable-action',
    ]),
  }
) {}

const runtimeError = (
  reason: DurableRuntimeError['reason']
): DurableRuntimeError => DurableRuntimeError.make({ reason })

const RegisteredActionWorkflowFailure = Schema.Struct({
  category: Schema.Literals([
    'action-failed',
    'invalid-result',
    'needs-attention',
    'unexpected-failure',
  ]),
})

const RegisteredActionActivityOutcome = Schema.Union([
  Schema.TaggedStruct('Success', {
    encodedResult: Schema.String.check(
      Schema.isMaxLength(RUNTIME_PAYLOAD_MAX_BYTES)
    ),
  }),
  Schema.TaggedStruct('Failure', {
    ...RegisteredActionWorkflowFailure.fields,
  }),
])

const RegisteredActionWorkflowPayload = Schema.Struct({
  actionFingerprint: boundedNonBlankString(
    RUNTIME_ACTION_FINGERPRINT_MAX_LENGTH
  ),
  actionName: boundedNonBlankString(ACTION_NAME_MAX_LENGTH),
  actionRevision: boundedNonBlankString(ACTION_REVISION_MAX_LENGTH),
  catalogFingerprint: boundedNonBlankString(
    RUNTIME_CATALOG_FINGERPRINT_MAX_LENGTH
  ),
  conversationId: RuntimeConversationId,
  encodedInput: Schema.String.check(
    Schema.isMaxLength(RUNTIME_PAYLOAD_MAX_BYTES)
  ),
  invocationId: RuntimeInvocationId,
  rootIdentity: RuntimeRootIdentity,
  workspaceId: RuntimeWorkspaceId,
})
type RegisteredActionWorkflowPayload =
  typeof RegisteredActionWorkflowPayload.Type

export const RegisteredActionExecutionWorkflow = Workflow.make(
  'Laborer/RegisteredActionExecution/v1',
  {
    error: RegisteredActionWorkflowFailure,
    idempotencyKey: (payload) =>
      createHash('sha256')
        .update('laborer-execution-v1\0', 'utf8')
        .update(payload.rootIdentity, 'utf8')
        .update('\0', 'utf8')
        .update(payload.workspaceId, 'utf8')
        .update('\0', 'utf8')
        .update(payload.invocationId, 'utf8')
        .digest('base64url'),
    payload: RegisteredActionWorkflowPayload,
    success: Schema.Void,
  }
)

const ConversationWorkflowPayload = Schema.Struct({
  conversationId: RuntimeConversationId,
  encodedEvent: Schema.String.check(
    Schema.isMaxLength(RUNTIME_PAYLOAD_MAX_BYTES)
  ),
  eventId: RuntimeInvocationId,
  requestHash: boundedNonBlankString(64),
  rootIdentity: RuntimeRootIdentity,
  sequence: Schema.Int.check(Schema.isGreaterThan(0)),
  sessionId: boundedNonBlankString(RUNTIME_EXECUTION_ID_MAX_LENGTH),
  workspaceId: RuntimeWorkspaceId,
})
type ConversationWorkflowPayload = typeof ConversationWorkflowPayload.Type

const ConversationActivityOutcome = Schema.Union([
  Schema.TaggedStruct('Success', {
    outputs: Schema.Array(ConversationOutput),
  }),
  Schema.TaggedStruct('Failure', {}),
])

export const ConversationWorkflow = Workflow.make('Laborer/Conversation/v1', {
  error: DurableRuntimeError,
  idempotencyKey: (payload) =>
    createHash('sha256')
      .update('laborer-conversation-event-v1\0', 'utf8')
      .update(payload.rootIdentity, 'utf8')
      .update('\0', 'utf8')
      .update(payload.workspaceId, 'utf8')
      .update('\0', 'utf8')
      .update(payload.eventId, 'utf8')
      .digest('base64url'),
  payload: ConversationWorkflowPayload,
  success: ConversationReceipt,
})

class ActionRegistry extends Context.Service<
  ActionRegistry,
  RegisteredActionCatalog
>()('@laborer/durable-runtime/ActionRegistry') {}

class RootIdentity extends Context.Service<RootIdentity, string>()(
  '@laborer/durable-runtime/RootIdentity'
) {}

class ExecutionGate extends Context.Service<
  ExecutionGate,
  Semaphore.Semaphore
>()('@laborer/durable-runtime/ExecutionGate') {}

interface ExecutionControlGateShape {
  readonly withPermit: <A, E, R>(
    executionId: string,
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E, R>
}

class ExecutionControlGate extends Context.Service<
  ExecutionControlGate,
  ExecutionControlGateShape
>()('@laborer/durable-runtime/ExecutionControlGate') {}

const makeExecutionControlGate = Effect.sync(() => {
  const permits = new Map<
    string,
    { readonly permit: Semaphore.Semaphore; references: number }
  >()
  return ExecutionControlGate.of({
    withPermit: (executionId, effect) => {
      let entry = permits.get(executionId)
      if (entry === undefined) {
        entry = { permit: Semaphore.makeUnsafe(1), references: 0 }
        permits.set(executionId, entry)
      }
      entry.references += 1
      const retained = entry
      return retained.permit.withPermit(effect).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            retained.references -= 1
            if (
              retained.references === 0 &&
              permits.get(executionId) === retained
            ) {
              permits.delete(executionId)
            }
          })
        )
      )
    },
  })
})

export interface ConversationHandler {
  readonly handle: (
    event: ApplicationEvent
  ) => Effect.Effect<readonly ApplicationPublicOutput[], unknown>
}

interface ConversationHandlerRegistryShape {
  readonly get: (
    workspaceId: string
  ) => Effect.Effect<ConversationHandler, DurableRuntimeError>
  readonly register: (
    workspaceId: string,
    handler: ConversationHandler
  ) => Effect.Effect<void, DurableRuntimeError, import('effect').Scope.Scope>
  readonly withPermit: <A, E, R>(
    conversationId: string,
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E, R>
}

class ConversationHandlerRegistry extends Context.Service<
  ConversationHandlerRegistry,
  ConversationHandlerRegistryShape
>()('@laborer/durable-runtime/ConversationHandlerRegistry') {}

const makeConversationHandlerRegistry = Effect.gen(function* () {
  const handlers = new Map<string, ConversationHandler>()
  const handlerWaiters = new Map<
    string,
    Deferred.Deferred<ConversationHandler>
  >()
  const conversationPermits = new Map<string, Semaphore.Semaphore>()
  return ConversationHandlerRegistry.of({
    get: (workspaceId) => {
      const handler = handlers.get(workspaceId)
      if (handler !== undefined) {
        return Effect.succeed(handler)
      }
      let waiter = handlerWaiters.get(workspaceId)
      if (waiter === undefined) {
        waiter = Deferred.makeUnsafe<ConversationHandler>()
        handlerWaiters.set(workspaceId, waiter)
      }
      // Cluster restoration can begin before the workspace application has built
      // its ACP application. Waiting here keeps the durable workflow pending
      // instead of permanently failing it during that startup window.
      return Deferred.await(waiter)
    },
    register: (workspaceId, handler) =>
      Effect.acquireRelease(
        Effect.suspend(() => {
          if (handlers.has(workspaceId)) {
            return Effect.fail(runtimeError('conversation-handler-unavailable'))
          }
          handlers.set(workspaceId, handler)
          let waiter = handlerWaiters.get(workspaceId)
          if (waiter === undefined) {
            waiter = Deferred.makeUnsafe<ConversationHandler>()
            handlerWaiters.set(workspaceId, waiter)
          }
          return Deferred.succeed(waiter, handler).pipe(Effect.asVoid)
        }),
        () =>
          Effect.sync(() => {
            if (handlers.get(workspaceId) === handler) {
              handlers.delete(workspaceId)
              handlerWaiters.delete(workspaceId)
            }
          })
      ),
    withPermit: (conversationId, effect) => {
      let permit = conversationPermits.get(conversationId)
      if (permit === undefined) {
        permit = Semaphore.makeUnsafe(1)
        conversationPermits.set(conversationId, permit)
      }
      return permit.withPermit(effect)
    },
  })
})

const decodeStoredJson = (
  encoded: string
): Effect.Effect<unknown, DurableRuntimeError> =>
  Effect.try({
    catch: () => runtimeError('storage-failure'),
    try: () => JSON.parse(encoded) as unknown,
  })

const boundedPayloadJson = (
  payload: unknown
): Effect.Effect<string, DurableRuntimeError> =>
  canonicalActionInput(payload).pipe(
    Effect.mapError(() => runtimeError('invalid-payload')),
    Effect.filterOrFail(
      (encoded) =>
        Buffer.byteLength(encoded, 'utf8') <= RUNTIME_PAYLOAD_MAX_BYTES,
      () => runtimeError('invalid-payload')
    )
  )

const boundedExecutionEventPayloadJson = (
  payload: unknown
): Effect.Effect<string, DurableRuntimeError> =>
  canonicalActionInput(payload).pipe(
    Effect.mapError(() => runtimeError('invalid-payload')),
    Effect.filterOrFail(
      (encoded) =>
        Buffer.byteLength(encoded, 'utf8') <=
        RUNTIME_EXECUTION_EVENT_PAYLOAD_MAX_BYTES,
      () => runtimeError('invalid-payload')
    )
  )

const applicationEventId = (event: typeof ApplicationEvent.Type): string =>
  event._tag === 'ParticipantInput' ? event.turnId : event.eventId

const validateRegisteredActionConversationEvent = Effect.fn(
  'validateRegisteredActionConversationEvent'
)(function* (event: typeof ApplicationEvent.Type, workspaceId: string) {
  if (event._tag !== 'ExternalInput' || event.source !== 'registered-action') {
    return
  }
  const executionEvent = yield* Schema.decodeUnknownEffect(ExecutionEvent, {
    onExcessProperty: 'error',
  })(event.payload).pipe(Effect.orDie)
  if (
    executionEvent.eventId !== event.eventId ||
    executionEvent.conversationId !== event.conversationId ||
    executionEvent.workspaceId !== workspaceId
  ) {
    return yield* Effect.die(
      new Error('invalid durable registered Action event')
    )
  }
})

const nextEventSequence = Effect.fn('nextExecutionEventSequence')(function* (
  executionId: string
) {
  const sql = yield* SqlClient
  const rows = yield* sql<{ readonly sequence: number }>`
      SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
      FROM laborer_execution_events
      WHERE execution_id = ${executionId}
    `
  return pipe(
    rows,
    EffectArray.head,
    Option.map((row) => row.sequence),
    Option.getOrElse(() => 1)
  )
})

const persistEvent = Effect.fn('persistExecutionEvent')(function* (options: {
  readonly conversationId: string
  readonly executionId: string
  readonly kind: 'progress' | 'completed' | 'failed' | 'cancelled'
  readonly payload: unknown
  readonly progressId?: string
  readonly workspaceId: string
}) {
  const sql = yield* SqlClient
  const encodedPayload = yield* boundedExecutionEventPayloadJson(
    options.payload
  )
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      // Acquire SQLite's write lock before inspecting event identity or sequence.
      // This keeps concurrent reporters from allocating the same next sequence.
      yield* sql`
        UPDATE laborer_executions
        SET execution_id = execution_id
        WHERE execution_id = ${options.executionId}
      `
      let stableEventId: string | undefined
      if (options.progressId !== undefined) {
        stableEventId = `execution:${options.executionId}:progress:${createHash(
          'sha256'
        )
          .update('laborer-execution-progress-v1\0', 'utf8')
          .update(options.progressId, 'utf8')
          .digest('base64url')}`
      } else if (options.kind !== 'progress') {
        stableEventId = `execution:${options.executionId}:terminal`
      }
      if (stableEventId !== undefined) {
        const existing = yield* sql<{
          readonly conversationId: string
          readonly executionId: string
          readonly kind: string
          readonly payloadJson: string
          readonly sequence: number
          readonly workspaceId: string
        }>`
          SELECT
            conversation_id AS conversationId,
            execution_id AS executionId,
            kind,
            payload_json AS payloadJson,
            sequence,
            workspace_id AS workspaceId
          FROM laborer_execution_events
          WHERE event_id = ${stableEventId}
        `
        const event = pipe(existing, EffectArray.head)
        if (Option.isSome(event)) {
          if (
            event.value.conversationId !== options.conversationId ||
            event.value.executionId !== options.executionId ||
            event.value.kind !== options.kind ||
            event.value.payloadJson !== encodedPayload ||
            event.value.workspaceId !== options.workspaceId
          ) {
            return yield* runtimeError('invalid-payload')
          }
          return yield* Schema.decodeUnknownEffect(ExecutionEvent)({
            conversationId: event.value.conversationId,
            eventId: stableEventId,
            executionId: event.value.executionId,
            kind: event.value.kind,
            payload: options.payload,
            sequence: event.value.sequence,
            workspaceId: event.value.workspaceId,
          }).pipe(Effect.mapError(() => runtimeError('storage-failure')))
        }
      }
      const sequence = yield* nextEventSequence(options.executionId)
      const eventId =
        stableEventId ?? `execution:${options.executionId}:event:${sequence}`
      yield* sql`
        INSERT INTO laborer_execution_events (
          event_id, execution_id, conversation_id, workspace_id, sequence,
          kind, payload_json
        ) VALUES (
          ${eventId}, ${options.executionId}, ${options.conversationId},
          ${options.workspaceId}, ${sequence}, ${options.kind}, ${encodedPayload}
        )
      `
      yield* sql`
        INSERT INTO laborer_execution_outbox (event_id, acknowledged)
        VALUES (${eventId}, 0)
      `
      return ExecutionEvent.make({
        conversationId: options.conversationId,
        eventId,
        executionId: options.executionId,
        kind: options.kind,
        payload: options.payload,
        sequence,
        workspaceId: options.workspaceId,
      })
    })
  )
})

const executeRegisteredActionActivity = (
  action: RegisteredAction,
  decodedInput: unknown,
  context: RegisteredActionContext
) =>
  Effect.gen(function* () {
    const activityOutcome = yield* Activity.make({
      execute: action.execute(decodedInput, context).pipe(
        Effect.flatMap(action.encodeResult),
        Effect.flatMap((result) =>
          boundedExecutionEventPayloadJson(result).pipe(
            Effect.map((encodedResult) => ({
              _tag: 'Success' as const,
              encodedResult,
            })),
            Effect.mapError(() => ({ category: 'invalid-result' as const }))
          )
        ),
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.interrupt
          }
          const failure = cause.reasons.find(Cause.isFailReason)?.error
          let category:
            | 'action-failed'
            | 'invalid-result'
            | 'unexpected-failure' = 'action-failed'
          if (failure === undefined) {
            category = 'unexpected-failure'
          } else if (
            failure instanceof ActionRegistrationError &&
            failure.reason === 'invalid-result'
          ) {
            category = 'invalid-result'
          }
          return Effect.succeed({
            _tag: 'Failure' as const,
            category,
          })
        })
      ),
      interruptRetryPolicy:
        action.recoveryPolicy === 'idempotent-retry'
          ? undefined
          : Schedule.recurs(0),
      name: 'Laborer/RegisteredActionExecution/run/v1',
      success: RegisteredActionActivityOutcome,
    })
    if (activityOutcome._tag === 'Failure') {
      return yield* Effect.fail({ category: activityOutcome.category })
    }
    return activityOutcome.encodedResult
  })

const actionForWorkflowPayload = Effect.fn('actionForWorkflowPayload')(
  function* (payload: RegisteredActionWorkflowPayload) {
    const catalog = yield* ActionRegistry
    const action = yield* catalog
      .get(payload.actionName, payload.actionRevision)
      .pipe(Effect.mapError(() => ({ category: 'needs-attention' as const })))
    if (action.fingerprint !== payload.actionFingerprint) {
      return yield* Effect.fail({ category: 'needs-attention' as const })
    }
    return action
  }
)

const conversationWorkflowLayer = ConversationWorkflow.toLayer((payload) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const registry = yield* ConversationHandlerRegistry
    const event = yield* decodeStoredJson(payload.encodedEvent).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(ApplicationEvent, {
          onExcessProperty: 'error',
        })
      ),
      Effect.mapError(() => runtimeError('storage-failure'))
    )

    // Cluster may schedule accepted events concurrently. Do not let a later
    // sequence race ahead merely because its workflow fiber obtained a permit
    // first; durable Conversation order is defined by the SQL sequence.
    let precedingEventIsRunning = true
    while (precedingEventIsRunning) {
      const preceding = yield* sql<{ readonly present: number }>`
        SELECT 1 AS present
        FROM laborer_conversation_events
        WHERE conversation_id = ${payload.conversationId}
          AND workspace_id = ${payload.workspaceId}
          AND sequence < ${payload.sequence}
          AND status IN ('accepted', 'running')
        LIMIT 1
      `.pipe(Effect.mapError(() => runtimeError('storage-failure')))
      precedingEventIsRunning = preceding.length > 0
      if (precedingEventIsRunning) {
        yield* Effect.sleep('25 millis')
      }
    }

    return yield* registry.withPermit(
      `${payload.workspaceId}\0${payload.conversationId}`,
      Effect.gen(function* () {
        // Re-read after taking the permit. Concurrent replay of one event must
        // observe the first completion instead of invoking ACP a second time.
        const rows = yield* sql<{
          readonly conversationId: string
          readonly eventJson: string
          readonly outputsJson: string | null
          readonly requestHash: string
          readonly sequence: number
          readonly status: string
        }>`
          SELECT
            conversation_id AS conversationId,
            event_json AS eventJson,
            outputs_json AS outputsJson,
            request_hash AS requestHash,
            sequence,
            status
          FROM laborer_conversation_events
          WHERE event_id = ${payload.eventId}
            AND workspace_id = ${payload.workspaceId}
        `.pipe(Effect.mapError(() => runtimeError('storage-failure')))
        const stored = pipe(rows, EffectArray.head)
        if (
          Option.isNone(stored) ||
          stored.value.conversationId !== payload.conversationId ||
          stored.value.eventJson !== payload.encodedEvent ||
          stored.value.requestHash !== payload.requestHash ||
          stored.value.sequence !== payload.sequence
        ) {
          return yield* runtimeError('storage-failure')
        }
        if (
          stored.value.status === 'completed' &&
          stored.value.outputsJson !== null
        ) {
          const outputs = yield* decodeStoredJson(
            stored.value.outputsJson
          ).pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(Schema.Array(ConversationOutput), {
                onExcessProperty: 'error',
              })
            ),
            Effect.mapError(() => runtimeError('storage-failure'))
          )
          return ConversationReceipt.make({
            conversationId: payload.conversationId,
            eventId: payload.eventId,
            outputs,
            sequence: payload.sequence,
            sessionId: payload.sessionId,
            workspaceId: payload.workspaceId,
          })
        }
        if (
          stored.value.status !== 'accepted' &&
          stored.value.status !== 'running'
        ) {
          return yield* runtimeError(
            stored.value.status === 'failed'
              ? 'conversation-handler-unavailable'
              : 'storage-failure'
          )
        }
        yield* sql`
          UPDATE laborer_conversation_events
          SET status = 'running'
          WHERE event_id = ${payload.eventId}
            AND workspace_id = ${payload.workspaceId}
            AND status = 'accepted'
        `.pipe(Effect.mapError(() => runtimeError('storage-failure')))
        const handler = yield* registry.get(payload.workspaceId)
        const outcome = yield* Activity.make({
          execute: handler.handle(event).pipe(
            Effect.flatMap((candidate) =>
              Schema.decodeUnknownEffect(Schema.Array(ConversationOutput), {
                onExcessProperty: 'error',
              })(candidate)
            ),
            Effect.flatMap((outputs) =>
              boundedPayloadJson(outputs).pipe(Effect.as(outputs))
            ),
            Effect.map((outputs) => ({ _tag: 'Success' as const, outputs })),
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : Effect.succeed({ _tag: 'Failure' as const })
            )
          ),
          name: 'Laborer/Conversation/respond/v1',
          success: ConversationActivityOutcome,
        })
        if (outcome._tag === 'Failure') {
          yield* sql`
            UPDATE laborer_conversation_events
            SET status = 'failed'
            WHERE event_id = ${payload.eventId}
              AND workspace_id = ${payload.workspaceId}
              AND request_hash = ${payload.requestHash}
          `.pipe(Effect.mapError(() => runtimeError('storage-failure')))
          return yield* runtimeError('conversation-handler-unavailable')
        }
        const outputsJson = yield* boundedPayloadJson(outcome.outputs)
        yield* sql`
          UPDATE laborer_conversation_events
          SET status = 'completed', outputs_json = ${outputsJson}
          WHERE event_id = ${payload.eventId}
            AND workspace_id = ${payload.workspaceId}
            AND request_hash = ${payload.requestHash}
        `.pipe(Effect.mapError(() => runtimeError('storage-failure')))
        return ConversationReceipt.make({
          conversationId: payload.conversationId,
          eventId: payload.eventId,
          outputs: outcome.outputs,
          sequence: payload.sequence,
          sessionId: payload.sessionId,
          workspaceId: payload.workspaceId,
        })
      })
    )
  })
)

const acceptExecutionEventIntoConversation = Effect.fn(
  'acceptExecutionEventIntoConversation'
)(function* (
  event: ExecutionEvent,
  rootIdentity: string,
  workflowEngine: typeof WorkflowEngine.WorkflowEngine.Service
) {
  const sql = yield* SqlClient
  const applicationEvent = ExternalInputEvent.make({
    conversationId: ThreadId.make(event.conversationId),
    eventId: event.eventId,
    payload: event,
    source: 'registered-action',
  })
  const eventJson = yield* boundedPayloadJson(applicationEvent)
  const requestHash = createHash('sha256')
    .update('laborer-conversation-request-v1\0', 'utf8')
    .update(eventJson, 'utf8')
    .digest('base64url')
  const accepted = yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`
        UPDATE laborer_conversations
        SET conversation_id = conversation_id
        WHERE conversation_id = ${event.conversationId}
          AND workspace_id = ${event.workspaceId}
      `
      const conversations = yield* sql<{
        readonly sessionId: string
      }>`
        SELECT session_id AS sessionId
        FROM laborer_conversations
        WHERE conversation_id = ${event.conversationId}
          AND workspace_id = ${event.workspaceId}
      `
      const conversation = pipe(conversations, EffectArray.head)
      if (Option.isNone(conversation)) {
        return Option.none<ConversationWorkflowPayload>()
      }
      const existing = yield* sql<{
        readonly conversationId: string
        readonly eventJson: string
        readonly requestHash: string
        readonly sequence: number
      }>`
        SELECT
          conversation_id AS conversationId,
          event_json AS eventJson,
          request_hash AS requestHash,
          sequence
        FROM laborer_conversation_events
        WHERE event_id = ${event.eventId}
          AND workspace_id = ${event.workspaceId}
      `
      const existingEvent = pipe(existing, EffectArray.head)
      if (Option.isSome(existingEvent)) {
        if (
          existingEvent.value.conversationId !== event.conversationId ||
          existingEvent.value.eventJson !== eventJson ||
          existingEvent.value.requestHash !== requestHash
        ) {
          return yield* runtimeError('storage-failure')
        }
        return Option.some({
          conversationId: event.conversationId,
          encodedEvent: eventJson,
          eventId: event.eventId,
          requestHash,
          rootIdentity,
          sequence: existingEvent.value.sequence,
          sessionId: conversation.value.sessionId,
          workspaceId: event.workspaceId,
        })
      }
      const sequences = yield* sql<{ readonly sequence: number }>`
        SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
        FROM laborer_conversation_events
        WHERE conversation_id = ${event.conversationId}
          AND workspace_id = ${event.workspaceId}
      `
      const sequence = pipe(
        sequences,
        EffectArray.head,
        Option.map((row) => row.sequence),
        Option.getOrElse(() => 1)
      )
      yield* sql`
        INSERT INTO laborer_conversation_events (
          event_id, conversation_id, workspace_id, sequence,
          request_hash, event_json, status
        ) VALUES (
          ${event.eventId}, ${event.conversationId}, ${event.workspaceId},
          ${sequence}, ${requestHash}, ${eventJson}, 'accepted'
        )
      `
      return Option.some({
        conversationId: event.conversationId,
        encodedEvent: eventJson,
        eventId: event.eventId,
        requestHash,
        rootIdentity,
        sequence,
        sessionId: conversation.value.sessionId,
        workspaceId: event.workspaceId,
      })
    })
  )
  if (Option.isNone(accepted)) {
    return
  }
  yield* Effect.uninterruptible(
    ConversationWorkflow.execute(accepted.value, { discard: true }).pipe(
      Effect.provideService(WorkflowEngine.WorkflowEngine, workflowEngine)
    )
  )
  yield* sql`
    UPDATE laborer_execution_outbox
    SET acknowledged = 1
    WHERE event_id = ${event.eventId}
  `
})

const workflowHandlerLayer = RegisteredActionExecutionWorkflow.toLayer(
  (payload, executionId) =>
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the workflow deliberately keeps all terminal fencing in one auditable state machine.
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const workflowEngine = yield* WorkflowEngine.WorkflowEngine
      const executionGate = yield* ExecutionGate
      const executionControlGate = yield* ExecutionControlGate
      const taskEmission = yield* ExecutionTaskEmission
      const statuses = yield* sql<{
        readonly acceptedAtUnixMs: number | null
        readonly failureCategory: string | null
        readonly status: string
      }>`
        SELECT status, failure_category AS failureCategory,
          accepted_at_unix_ms AS acceptedAtUnixMs
        FROM laborer_executions
        WHERE execution_id = ${executionId}
      `.pipe(Effect.orDie)
      const durableExecution = pipe(
        statuses,
        EffectArray.head,
        Option.getOrElse(() => ({
          acceptedAtUnixMs: null,
          failureCategory: null,
          status: 'missing',
        }))
      )
      if (
        durableExecution.status === 'completed' ||
        durableExecution.status === 'cancelled'
      ) {
        return
      }
      if (durableExecution.status === 'failed') {
        if (
          durableExecution.failureCategory !== 'action-failed' &&
          durableExecution.failureCategory !== 'invalid-result' &&
          durableExecution.failureCategory !== 'unexpected-failure'
        ) {
          return yield* Effect.die(
            new Error('failed Execution has an invalid failure category')
          )
        }
        const category = durableExecution.failureCategory
        return yield* Effect.fail({ category } as const)
      }
      if (durableExecution.status === 'needs-attention') {
        if (durableExecution.failureCategory !== 'needs-attention') {
          return yield* Effect.die(
            new Error(
              'needs-attention Execution has an invalid failure category'
            )
          )
        }
        return yield* Effect.fail({ category: 'needs-attention' as const })
      }
      if (
        durableExecution.status !== 'queued' &&
        durableExecution.status !== 'running'
      ) {
        return yield* Effect.die(
          new Error('Execution has an invalid durable status')
        )
      }
      const action = yield* actionForWorkflowPayload(payload)
      if (
        durableExecution.status === 'running' &&
        action.recoveryPolicy === 'fail-closed'
      ) {
        return yield* Effect.fail({ category: 'needs-attention' as const })
      }
      yield* sql`
        UPDATE laborer_executions
        SET status = 'running'
        WHERE execution_id = ${executionId} AND status = 'queued'
      `.pipe(Effect.orDie)
      const started = yield* sql<{ readonly count: number }>`
        SELECT changes() AS count
      `.pipe(Effect.orDie)
      if (started[0]?.count === 1) {
        yield* taskEmission.emit({
          acceptedAtUnixMs: durableExecution.acceptedAtUnixMs ?? 0,
          actionName: payload.actionName,
          conversationId: payload.conversationId,
          executionId,
          input: yield* decodeStoredJson(payload.encodedInput).pipe(
            Effect.orDie
          ),
          status: 'running',
          workspaceId: payload.workspaceId,
        })
      }
      const context: RegisteredActionContext = {
        conversationId: payload.conversationId,
        executionId,
        reportProgress: (progressId, progress) =>
          Schema.decodeUnknownEffect(RuntimeProgressId)(progressId).pipe(
            Effect.mapError(() => runtimeError('invalid-payload')),
            Effect.flatMap((validatedProgressId) =>
              persistEvent({
                conversationId: payload.conversationId,
                executionId,
                kind: 'progress',
                payload: progress,
                progressId: validatedProgressId,
                workspaceId: payload.workspaceId,
              }).pipe(Effect.provideService(SqlClient, sql))
            ),
            Effect.flatMap((event) =>
              acceptExecutionEventIntoConversation(
                event,
                payload.rootIdentity,
                workflowEngine
              ).pipe(Effect.provideService(SqlClient, sql))
            ),
            Effect.asVoid
          ),
        rootIdentity: payload.rootIdentity,
        workspaceId: payload.workspaceId,
      }
      const decodedInput = yield* decodeStoredJson(payload.encodedInput).pipe(
        Effect.orDie
      )
      const encodedResult = yield* executionGate.withPermit(
        executeRegisteredActionActivity(action, decodedInput, context)
      )
      const result = yield* decodeStoredJson(encodedResult).pipe(Effect.orDie)
      const completedEvent = yield* executionControlGate
        .withPermit(
          executionId,
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`
              UPDATE laborer_executions
              SET status = 'completed', result_json = ${encodedResult}
              WHERE execution_id = ${executionId} AND status = 'running'
            `
              const changes = yield* sql<{ readonly count: number }>`
              SELECT changes() AS count
            `
              if (changes[0]?.count !== 1) {
                return
              }
              return yield* persistEvent({
                conversationId: payload.conversationId,
                executionId,
                kind: 'completed',
                payload: result,
                workspaceId: payload.workspaceId,
              }).pipe(Effect.provideService(SqlClient, sql))
            })
          )
        )
        .pipe(Effect.orDie)
      if (completedEvent !== undefined) {
        yield* taskEmission.emit({
          acceptedAtUnixMs: durableExecution.acceptedAtUnixMs ?? 0,
          actionName: payload.actionName,
          conversationId: payload.conversationId,
          executionId,
          input: decodedInput,
          status: 'completed',
          workspaceId: payload.workspaceId,
        })
        yield* acceptExecutionEventIntoConversation(
          completedEvent,
          payload.rootIdentity,
          workflowEngine
        ).pipe(Effect.provideService(SqlClient, sql), Effect.orDie)
      }
    }).pipe(
      Effect.catch(
        (failure: {
          readonly category:
            | 'action-failed'
            | 'invalid-result'
            | 'needs-attention'
            | 'unexpected-failure'
        }) =>
          Effect.gen(function* () {
            const sql = yield* SqlClient
            const workflowEngine = yield* WorkflowEngine.WorkflowEngine
            const executionControlGate = yield* ExecutionControlGate
            const taskEmission = yield* ExecutionTaskEmission
            const terminalStatus =
              failure.category === 'needs-attention'
                ? 'needs-attention'
                : 'failed'
            const failedEvent = yield* executionControlGate
              .withPermit(
                executionId,
                sql.withTransaction(
                  Effect.gen(function* () {
                    const statuses = yield* sql<{
                      readonly acceptedAtUnixMs: number | null
                      readonly status: string
                    }>`
                    SELECT status, accepted_at_unix_ms AS acceptedAtUnixMs
                    FROM laborer_executions
                    WHERE execution_id = ${executionId}
                  `
                    const status = pipe(
                      statuses,
                      EffectArray.head,
                      Option.map((row) => row.status),
                      Option.getOrElse(() => 'missing')
                    )
                    if (
                      status === 'failed' ||
                      status === 'needs-attention' ||
                      status === 'cancelled'
                    ) {
                      return
                    }
                    if (status === 'completed') {
                      return yield* Effect.die(
                        new Error('completed Execution cannot become failed')
                      )
                    }
                    yield* sql`
                UPDATE laborer_executions
                SET status = ${terminalStatus}, failure_category = ${failure.category}
                WHERE execution_id = ${executionId}
              `
                    return yield* persistEvent({
                      conversationId: payload.conversationId,
                      executionId,
                      kind: 'failed',
                      payload: { category: failure.category },
                      workspaceId: payload.workspaceId,
                    }).pipe(Effect.provideService(SqlClient, sql))
                  })
                )
              )
              .pipe(Effect.orDie)
            if (failedEvent !== undefined) {
              const accepted = yield* sql<{
                readonly acceptedAtUnixMs: number | null
              }>`
                SELECT accepted_at_unix_ms AS acceptedAtUnixMs
                FROM laborer_executions
                WHERE execution_id = ${executionId}
              `.pipe(Effect.orDie)
              yield* taskEmission.emit({
                acceptedAtUnixMs: accepted[0]?.acceptedAtUnixMs ?? 0,
                actionName: payload.actionName,
                conversationId: payload.conversationId,
                executionId,
                input: yield* decodeStoredJson(payload.encodedInput).pipe(
                  Effect.orDie
                ),
                status: terminalStatus,
                workspaceId: payload.workspaceId,
              })
              yield* acceptExecutionEventIntoConversation(
                failedEvent,
                payload.rootIdentity,
                workflowEngine
              ).pipe(Effect.provideService(SqlClient, sql), Effect.orDie)
            }
            return yield* Effect.fail(failure)
          })
      )
    )
)

const initializeLaborerTables = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`
        CREATE TABLE IF NOT EXISTS laborer_schema_versions (
          component TEXT PRIMARY KEY,
          version INTEGER NOT NULL
        )
      `
      const versions = yield* sql<{ readonly version: number }>`
        SELECT version
        FROM laborer_schema_versions
        WHERE component = 'runtime'
      `
      const version = pipe(
        versions,
        EffectArray.head,
        Option.map((row) => row.version)
      )
      if (
        Option.isSome(version) &&
        (version.value < 1 || version.value > RUNTIME_SCHEMA_VERSION)
      ) {
        return yield* Effect.die(
          new Error('incompatible Laborer runtime schema version')
        )
      }
      yield* sql`
        CREATE TABLE IF NOT EXISTS laborer_runtime_metadata (
          root_identity TEXT PRIMARY KEY,
          catalog_fingerprint TEXT NOT NULL
        )
      `
      yield* sql`
        CREATE TABLE IF NOT EXISTS laborer_conversations (
          conversation_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          session_id TEXT NOT NULL UNIQUE,
          PRIMARY KEY (workspace_id, conversation_id)
        )
      `
      yield* sql`
        CREATE TABLE IF NOT EXISTS laborer_conversation_events (
          event_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          request_hash TEXT NOT NULL,
          event_json TEXT NOT NULL,
          status TEXT NOT NULL,
          outputs_json TEXT,
          PRIMARY KEY (workspace_id, event_id),
          UNIQUE (workspace_id, conversation_id, sequence),
          FOREIGN KEY (workspace_id, conversation_id)
            REFERENCES laborer_conversations(workspace_id, conversation_id)
        )
      `
      yield* sql`
        CREATE INDEX IF NOT EXISTS laborer_conversation_events_order
        ON laborer_conversation_events (workspace_id, conversation_id, sequence)
      `
      yield* sql`
        CREATE TABLE IF NOT EXISTS laborer_executions (
          execution_id TEXT PRIMARY KEY,
          invocation_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          action_name TEXT NOT NULL,
          action_revision TEXT NOT NULL,
          action_fingerprint TEXT NOT NULL,
          catalog_fingerprint TEXT NOT NULL,
          input_hash TEXT NOT NULL,
          input_json TEXT NOT NULL,
          status TEXT NOT NULL,
          accepted_at_unix_ms INTEGER NOT NULL,
          result_json TEXT,
          failure_category TEXT,
          workspace_id TEXT NOT NULL,
          UNIQUE (workspace_id, invocation_id)
        )
      `
      yield* sql`
        CREATE TABLE IF NOT EXISTS laborer_execution_events (
          event_id TEXT PRIMARY KEY,
          execution_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          kind TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          UNIQUE (execution_id, sequence)
        )
      `
      yield* sql`
        CREATE TABLE IF NOT EXISTS laborer_execution_controls (
          control_id TEXT NOT NULL,
          execution_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          kind TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          result_json TEXT,
          status TEXT NOT NULL,
          PRIMARY KEY (workspace_id, control_id),
          UNIQUE (execution_id, sequence),
          FOREIGN KEY (execution_id) REFERENCES laborer_executions(execution_id)
        )
      `
      yield* sql`
        CREATE INDEX IF NOT EXISTS laborer_execution_controls_order
        ON laborer_execution_controls (execution_id, sequence)
      `
      if (Option.isSome(version) && version.value < 3) {
        yield* sql`ALTER TABLE laborer_executions ADD COLUMN workspace_id TEXT`
        yield* sql`ALTER TABLE laborer_execution_events ADD COLUMN workspace_id TEXT`
        yield* sql`
          UPDATE laborer_executions
          SET workspace_id = (
            SELECT conversations.workspace_id
            FROM laborer_conversations AS conversations
            WHERE conversations.conversation_id = laborer_executions.conversation_id
            LIMIT 1
          )
          WHERE (
            SELECT COUNT(*)
            FROM laborer_conversations AS conversations
            WHERE conversations.conversation_id = laborer_executions.conversation_id
          ) = 1
        `
        yield* sql`
          UPDATE laborer_execution_events
          SET workspace_id = (
            SELECT executions.workspace_id
            FROM laborer_executions AS executions
            WHERE executions.execution_id = laborer_execution_events.execution_id
          )
        `
        const ambiguous = yield* sql<{ readonly count: number }>`
          SELECT (
            (SELECT COUNT(*) FROM laborer_executions WHERE workspace_id IS NULL) +
            (SELECT COUNT(*) FROM laborer_execution_events WHERE workspace_id IS NULL)
          ) AS count
        `
        if ((ambiguous[0]?.count ?? 1) !== 0) {
          return yield* Effect.die(
            new Error('cannot infer workspace ownership for durable Execution')
          )
        }
      }
      if (Option.isSome(version) && version.value < 5) {
        yield* sql`
          CREATE TABLE laborer_executions_v5 (
            execution_id TEXT PRIMARY KEY,
            invocation_id TEXT NOT NULL,
            conversation_id TEXT NOT NULL,
            action_name TEXT NOT NULL,
            action_revision TEXT NOT NULL,
            action_fingerprint TEXT NOT NULL,
            catalog_fingerprint TEXT NOT NULL,
            input_hash TEXT NOT NULL,
            input_json TEXT NOT NULL,
            status TEXT NOT NULL,
            result_json TEXT,
            failure_category TEXT,
            workspace_id TEXT NOT NULL,
            UNIQUE (workspace_id, invocation_id)
          )
        `
        yield* sql`
          INSERT INTO laborer_executions_v5
          SELECT execution_id, invocation_id, conversation_id, action_name,
            action_revision, action_fingerprint, catalog_fingerprint,
            input_hash, input_json, status, result_json, failure_category,
            workspace_id
          FROM laborer_executions
        `
        yield* sql`
          CREATE TABLE laborer_execution_controls_v5 (
            control_id TEXT NOT NULL,
            execution_id TEXT NOT NULL,
            conversation_id TEXT NOT NULL,
            workspace_id TEXT NOT NULL,
            sequence INTEGER NOT NULL,
            kind TEXT NOT NULL,
            request_hash TEXT NOT NULL,
            result_json TEXT,
            status TEXT NOT NULL,
            PRIMARY KEY (workspace_id, control_id),
            UNIQUE (execution_id, sequence),
            FOREIGN KEY (execution_id)
              REFERENCES laborer_executions_v5(execution_id)
          )
        `
        yield* sql`
          INSERT INTO laborer_execution_controls_v5
          SELECT control_id, execution_id, conversation_id, workspace_id,
            sequence, kind, request_hash, result_json, status
          FROM laborer_execution_controls
        `
        yield* sql`DROP TABLE laborer_execution_controls`
        yield* sql`DROP TABLE laborer_executions`
        yield* sql`
          ALTER TABLE laborer_executions_v5 RENAME TO laborer_executions
        `
        yield* sql`
          ALTER TABLE laborer_execution_controls_v5
          RENAME TO laborer_execution_controls
        `
        yield* sql`
          CREATE INDEX laborer_execution_controls_order
          ON laborer_execution_controls (execution_id, sequence)
        `
      }
      if (Option.isSome(version) && version.value < 6) {
        yield* sql`
          ALTER TABLE laborer_executions
          ADD COLUMN accepted_at_unix_ms INTEGER
        `
      }
      yield* sql`
        CREATE TABLE IF NOT EXISTS laborer_execution_outbox (
          outbox_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL UNIQUE,
          acknowledged INTEGER NOT NULL
        )
      `
      yield* sql`
        CREATE INDEX IF NOT EXISTS laborer_execution_outbox_pending
        ON laborer_execution_outbox (acknowledged, outbox_sequence)
      `
      yield* sql`
        CREATE INDEX IF NOT EXISTS laborer_execution_events_conversation
        ON laborer_execution_events (conversation_id, event_id)
      `
      // A process can stop after a control is durably accepted but before its
      // user-owned capability reports an outcome. Replaying that capability
      // could duplicate an external side effect, so recovery fails the control
      // closed before Cluster resumes. An ambiguous cancellation terminally
      // fences its Execution instead of leaving it stuck cancelling.
      const interruptedCancellations = yield* sql<{
        readonly conversationId: string
        readonly executionId: string
        readonly workspaceId: string
      }>`
        SELECT controls.execution_id AS executionId,
          controls.conversation_id AS conversationId,
          controls.workspace_id AS workspaceId
        FROM laborer_execution_controls AS controls
        WHERE controls.status = 'accepted' AND controls.kind = 'cancel'
        ORDER BY controls.execution_id, controls.sequence
      `
      yield* sql`
        UPDATE laborer_execution_controls
        SET status = 'failed'
        WHERE status = 'accepted'
      `
      yield* Effect.forEach(
        interruptedCancellations,
        (control) =>
          Effect.gen(function* () {
            yield* sql`
              UPDATE laborer_executions
              SET status = 'needs-attention',
                failure_category = 'needs-attention'
              WHERE execution_id = ${control.executionId}
                AND status = 'cancelling'
            `
            const changes = yield* sql<{ readonly count: number }>`
              SELECT changes() AS count
            `
            if (changes[0]?.count !== 1) {
              return
            }
            yield* persistEvent({
              conversationId: control.conversationId,
              executionId: control.executionId,
              kind: 'failed',
              payload: { category: 'needs-attention' },
              workspaceId: control.workspaceId,
            }).pipe(Effect.provideService(SqlClient, sql))
          }),
        { concurrency: 1, discard: true }
      )
      yield* sql`
        INSERT INTO laborer_schema_versions (component, version)
        VALUES ('runtime', ${RUNTIME_SCHEMA_VERSION})
        ON CONFLICT(component) DO UPDATE SET version = excluded.version
      `
    })
  )
})

const validateRootRegistration = Effect.gen(function* () {
  const sql = yield* SqlClient
  const catalog = yield* ActionRegistry
  const rootIdentity = yield* RootIdentity
  yield* Schema.decodeUnknownEffect(RuntimeRootIdentity)(rootIdentity).pipe(
    Effect.orDie
  )
  const roots = yield* sql<{
    readonly catalogFingerprint: string
    readonly rootIdentity: string
  }>`
    SELECT
      root_identity AS rootIdentity,
      catalog_fingerprint AS catalogFingerprint
    FROM laborer_runtime_metadata
  `
  const existingRoot = pipe(roots, EffectArray.head)
  if (
    roots.length > 1 ||
    (Option.isSome(existingRoot) &&
      existingRoot.value.rootIdentity !== rootIdentity)
  ) {
    return yield* Effect.die(
      new Error('runtime database belongs to a different Laborer root')
    )
  }
  const conversations = yield* sql<{
    readonly conversationId: string
    readonly sessionId: string
    readonly workspaceId: string
  }>`
    SELECT
      conversation_id AS conversationId,
      session_id AS sessionId,
      workspace_id AS workspaceId
    FROM laborer_conversations
  `
  yield* Effect.forEach(
    conversations,
    (conversation) =>
      Effect.all([
        Schema.decodeUnknownEffect(RuntimeConversationId)(
          conversation.conversationId
        ),
        Schema.decodeUnknownEffect(RuntimeWorkspaceId)(
          conversation.workspaceId
        ),
        Schema.decodeUnknownEffect(
          boundedNonBlankString(RUNTIME_EXECUTION_ID_MAX_LENGTH)
        )(conversation.sessionId),
      ]).pipe(Effect.orDie),
    { discard: true }
  )
  const conversationEvents = yield* sql<{
    readonly conversationId: string
    readonly eventId: string
    readonly eventJson: string
    readonly outputsJson: string | null
    readonly ownerWorkspaceId: string
    readonly requestHash: string
    readonly sequence: number
    readonly status: string
    readonly workspaceId: string
  }>`
    SELECT
      events.event_id AS eventId,
      events.conversation_id AS conversationId,
      events.workspace_id AS workspaceId,
      conversations.workspace_id AS ownerWorkspaceId,
      events.sequence,
      events.request_hash AS requestHash,
      events.event_json AS eventJson,
      events.status,
      events.outputs_json AS outputsJson
    FROM laborer_conversation_events AS events
    LEFT JOIN laborer_conversations AS conversations
      ON conversations.workspace_id = events.workspace_id
      AND conversations.conversation_id = events.conversation_id
    ORDER BY events.conversation_id, events.sequence
  `
  yield* Effect.forEach(
    conversationEvents,
    (stored) =>
      Effect.gen(function* () {
        const event = yield* decodeStoredJson(stored.eventJson).pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(ApplicationEvent, {
              onExcessProperty: 'error',
            })
          ),
          Effect.orDie
        )
        const canonicalEvent = yield* boundedPayloadJson(event).pipe(
          Effect.orDie
        )
        yield* validateRegisteredActionConversationEvent(
          event,
          stored.workspaceId
        )
        const expectedHash = createHash('sha256')
          .update('laborer-conversation-request-v1\0', 'utf8')
          .update(canonicalEvent, 'utf8')
          .digest('base64url')
        if (
          applicationEventId(event) !== stored.eventId ||
          event.conversationId !== stored.conversationId ||
          stored.workspaceId !== stored.ownerWorkspaceId ||
          stored.requestHash !== expectedHash ||
          stored.eventJson !== canonicalEvent ||
          !Number.isSafeInteger(stored.sequence) ||
          stored.sequence < 1 ||
          (stored.status !== 'accepted' &&
            stored.status !== 'running' &&
            stored.status !== 'failed' &&
            stored.status !== 'completed') ||
          (stored.status === 'completed') !== (stored.outputsJson !== null)
        ) {
          return yield* Effect.die(
            new Error('invalid durable Conversation event')
          )
        }
        if (stored.outputsJson !== null) {
          const outputs = yield* decodeStoredJson(stored.outputsJson).pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(Schema.Array(ConversationOutput), {
                onExcessProperty: 'error',
              })
            ),
            Effect.orDie
          )
          const canonicalOutputs = yield* boundedPayloadJson(outputs).pipe(
            Effect.orDie
          )
          if (canonicalOutputs !== stored.outputsJson) {
            return yield* Effect.die(
              new Error('invalid durable Conversation output')
            )
          }
        }
      }),
    { discard: true }
  )
  const controls = yield* sql<{
    readonly controlId: string
    readonly conversationId: string
    readonly executionId: string
    readonly kind: string
    readonly ownerConversationId: string
    readonly ownerWorkspaceId: string
    readonly requestHash: string
    readonly resultJson: string | null
    readonly sequence: number
    readonly status: string
    readonly workspaceId: string
  }>`
    SELECT controls.control_id AS controlId,
      controls.execution_id AS executionId,
      controls.conversation_id AS conversationId,
      controls.workspace_id AS workspaceId, controls.sequence, controls.kind,
      controls.request_hash AS requestHash, controls.result_json AS resultJson,
      controls.status, executions.conversation_id AS ownerConversationId,
      executions.workspace_id AS ownerWorkspaceId
    FROM laborer_execution_controls AS controls
    LEFT JOIN laborer_executions AS executions
      ON executions.execution_id = controls.execution_id
    ORDER BY controls.execution_id, controls.sequence
  `
  yield* Effect.forEach(
    controls,
    (control) =>
      Effect.gen(function* () {
        yield* Effect.all([
          Schema.decodeUnknownEffect(RuntimeControlId)(control.controlId),
          Schema.decodeUnknownEffect(RuntimeExecutionId)(control.executionId),
          Schema.decodeUnknownEffect(RuntimeConversationId)(
            control.conversationId
          ),
          Schema.decodeUnknownEffect(RuntimeWorkspaceId)(control.workspaceId),
        ]).pipe(Effect.orDie)
        if (
          control.ownerConversationId !== control.conversationId ||
          control.ownerWorkspaceId !== control.workspaceId ||
          !Number.isSafeInteger(control.sequence) ||
          control.sequence < 1 ||
          !SHA256_BASE64URL_PATTERN.test(control.requestHash) ||
          (control.kind !== 'inspect' &&
            control.kind !== 'follow-up' &&
            control.kind !== 'cancel') ||
          (control.status !== 'completed' && control.status !== 'failed') ||
          (control.status === 'completed') !== (control.resultJson !== null)
        ) {
          return yield* Effect.die(
            new Error('invalid durable Execution control')
          )
        }
        if (control.resultJson !== null) {
          const receipt = yield* decodeStoredJson(control.resultJson).pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(ExecutionControlReceipt, {
                onExcessProperty: 'error',
              })
            ),
            Effect.orDie
          )
          const canonicalReceipt = yield* boundedPayloadJson(receipt).pipe(
            Effect.orDie
          )
          if (
            canonicalReceipt !== control.resultJson ||
            receipt.controlId !== control.controlId ||
            receipt.deduplicated ||
            receipt.execution.executionId !== control.executionId ||
            receipt.execution.conversationId !== control.conversationId ||
            receipt.execution.workspaceId !== control.workspaceId
          ) {
            return yield* Effect.die(
              new Error('invalid durable Execution control receipt')
            )
          }
        }
      }),
    { discard: true }
  )
  const nonterminal = yield* sql<{
    readonly actionFingerprint: string
    readonly actionName: string
    readonly actionRevision: string
  }>`
    SELECT DISTINCT
      action_name AS actionName,
      action_revision AS actionRevision,
      action_fingerprint AS actionFingerprint
    FROM laborer_executions
    WHERE status IN ('queued', 'running', 'needs-attention')
  `
  yield* Effect.forEach(
    nonterminal,
    (execution) =>
      catalog.get(execution.actionName, execution.actionRevision).pipe(
        Effect.filterOrFail(
          (action) => action.fingerprint === execution.actionFingerprint,
          () => ActionRegistrationError.make({ reason: 'unavailable-revision' })
        ),
        Effect.catch(() =>
          Effect.die(
            new Error(
              'nonterminal Execution requires an unavailable Action revision'
            )
          )
        )
      ),
    { discard: true }
  )
  yield* sql`
    INSERT INTO laborer_runtime_metadata (root_identity, catalog_fingerprint)
    VALUES (${rootIdentity}, ${catalog.fingerprint})
    ON CONFLICT(root_identity) DO UPDATE
      SET catalog_fingerprint = excluded.catalog_fingerprint
  `
})

interface StoredExecutionRow {
  readonly acceptedAtUnixMs: number | null
  readonly actionFingerprint: string
  readonly actionName: string
  readonly actionRevision: string
  readonly catalogFingerprint: string
  readonly conversationId: string
  readonly executionId: string
  readonly failureCategory: string | null
  readonly inputHash: string
  readonly inputJson: string
  readonly invocationId: string
  readonly resultJson: string | null
  readonly status: string
  readonly workspaceId: string
}

interface StoredConversationRecoveryRow {
  readonly conversationId: string
  readonly eventId: string
  readonly eventJson: string
  readonly requestHash: string
  readonly sequence: number
  readonly sessionId: string
  readonly workspaceId: string
}

const executionSelect = `
  SELECT
    execution_id AS executionId,
    invocation_id AS invocationId,
    conversation_id AS conversationId,
    action_name AS actionName,
    action_revision AS actionRevision,
    action_fingerprint AS actionFingerprint,
    accepted_at_unix_ms AS acceptedAtUnixMs,
    catalog_fingerprint AS catalogFingerprint,
    input_hash AS inputHash,
    input_json AS inputJson,
    status,
    result_json AS resultJson,
    failure_category AS failureCategory,
    workspace_id AS workspaceId
  FROM laborer_executions
`

const snapshotFromRow = (
  row: StoredExecutionRow
): Effect.Effect<ExecutionSnapshot, DurableRuntimeError> =>
  Effect.gen(function* () {
    const result =
      row.resultJson === null ? null : yield* decodeStoredJson(row.resultJson)
    return yield* Schema.decodeUnknownEffect(ExecutionSnapshot)({
      actionFingerprint: row.actionFingerprint,
      actionName: row.actionName,
      actionRevision: row.actionRevision,
      catalogFingerprint: row.catalogFingerprint,
      conversationId: row.conversationId,
      executionId: row.executionId,
      failureCategory: row.failureCategory,
      invocationId: row.invocationId,
      result,
      status: row.status,
      workspaceId: row.workspaceId,
    }).pipe(Effect.mapError(() => runtimeError('storage-failure')))
  })

export interface RootDurableRuntimeShape {
  readonly acknowledgeEvent: (
    eventId: string,
    conversationId: string,
    workspaceId: string
  ) => Effect.Effect<void, DurableRuntimeError>
  readonly actions: RegisteredActionCatalog
  readonly attachConversationClient: (
    compatibility: ConversationClientCompatibility,
    workspaceId: string,
    handler: ConversationHandler
  ) => Effect.Effect<void, DurableRuntimeError, import('effect').Scope.Scope>
  readonly cancelExecution: (
    request: CancelExecutionRequest
  ) => Effect.Effect<ExecutionControlReceipt, DurableRuntimeError>
  readonly checkConversationClientCompatibility: (
    compatibility: ConversationClientCompatibility
  ) => Effect.Effect<void, DurableRuntimeError>
  readonly followUpExecution: (
    request: FollowUpExecutionRequest
  ) => Effect.Effect<ExecutionControlReceipt, DurableRuntimeError>
  readonly getExecution: (
    executionId: string,
    conversationId: string,
    workspaceId: string
  ) => Effect.Effect<ExecutionSnapshot, DurableRuntimeError>
  readonly inspectExecution: (
    request: InspectExecutionRequest
  ) => Effect.Effect<ExecutionControlReceipt, DurableRuntimeError>
  readonly nonterminalExecutionActivity?: (
    workspaceId: string
  ) => Effect.Effect<
    readonly {
      readonly actionName: string
      readonly conversationId: string
      readonly executionId: string
      readonly lifecycle:
        | 'allocated'
        | 'cancelling'
        | 'recovery-blocked'
        | 'running'
      readonly startedAtUnixMs: number | null
      readonly workspaceId: string
    }[],
    DurableRuntimeError
  >
  readonly pendingEvents: (
    conversationId: string,
    workspaceId: string,
    limit?: number
  ) => Effect.Effect<readonly ExecutionEvent[], DurableRuntimeError>
  readonly runConversation: (
    request: RunConversationRequest
  ) => Effect.Effect<ConversationReceipt, DurableRuntimeError>
  readonly startExecution: (
    request: StartExecutionRequest
  ) => Effect.Effect<ExecutionSnapshot, DurableRuntimeError>
  /** A bounded, read-only projection of the durable state used by operators. */
  readonly workThreadActivity: (
    workspaceId: string
  ) => Effect.Effect<readonly DurableWorkThreadActivity[], DurableRuntimeError>
}

export interface DurableWorkThreadActivity {
  readonly channelId: string
  readonly conversationId: string
  readonly conversationInProgress: boolean
  readonly evidenceAtUnixMs: number
  readonly excerpt: string
  readonly executions: readonly {
    readonly actionName: string
    readonly executionId: string
    readonly lifecycle:
      | 'allocated'
      | 'cancelling'
      | 'recovery-blocked'
      | 'running'
    readonly startedAtUnixMs: number | null
  }[]
  readonly rootTs: string
  readonly workspaceId: string
}

export class RootDurableRuntime extends Context.Service<
  RootDurableRuntime,
  RootDurableRuntimeShape
>()('@laborer/durable-runtime/RootDurableRuntime') {}

const makeRuntimeService = Effect.gen(function* () {
  const sql = yield* SqlClient
  const catalog = yield* ActionRegistry
  const rootIdentity = yield* RootIdentity
  const conversationHandlers = yield* ConversationHandlerRegistry
  const executionControlGate = yield* ExecutionControlGate
  const taskEmission = yield* ExecutionTaskEmission
  const workflowEngine = yield* WorkflowEngine.WorkflowEngine

  const deliverPendingExecutionEvents = Effect.fn(
    'RootDurableRuntime.deliverPendingExecutionEvents'
  )(function* (workspaceId: string, conversationId?: string) {
    let batchSize = 128
    while (batchSize === 128) {
      const rows = yield* sql<{
        readonly conversationId: string
        readonly eventId: string
        readonly executionId: string
        readonly kind: string
        readonly payloadJson: string
        readonly sequence: number
        readonly workspaceId: string
      }>`
        SELECT
          events.event_id AS eventId,
          events.execution_id AS executionId,
          events.conversation_id AS conversationId,
          events.workspace_id AS workspaceId,
          events.sequence,
          events.kind,
          events.payload_json AS payloadJson
        FROM laborer_execution_outbox AS outbox
        INNER JOIN laborer_execution_events AS events
          ON events.event_id = outbox.event_id
        INNER JOIN laborer_conversations AS conversations
          ON conversations.workspace_id = events.workspace_id
          AND conversations.conversation_id = events.conversation_id
        WHERE outbox.acknowledged = 0
          AND events.workspace_id = ${workspaceId}
          AND (${conversationId ?? null} IS NULL
            OR events.conversation_id = ${conversationId ?? null})
        ORDER BY outbox.outbox_sequence
        LIMIT 128
      `
      batchSize = rows.length
      yield* Effect.forEach(
        rows,
        (row) =>
          decodeStoredJson(row.payloadJson).pipe(
            Effect.flatMap((payload) =>
              Schema.decodeUnknownEffect(ExecutionEvent, {
                onExcessProperty: 'error',
              })({
                conversationId: row.conversationId,
                eventId: row.eventId,
                executionId: row.executionId,
                kind: row.kind,
                payload,
                sequence: row.sequence,
                workspaceId: row.workspaceId,
              })
            ),
            Effect.mapError(() => runtimeError('storage-failure')),
            Effect.flatMap((event) =>
              acceptExecutionEventIntoConversation(
                event,
                rootIdentity,
                workflowEngine
              ).pipe(Effect.provideService(SqlClient, sql))
            )
          ),
        { concurrency: RUNTIME_MAX_CONCURRENT_EXECUTIONS, discard: true }
      )
    }
  })

  const runConversation = Effect.fn('RootDurableRuntime.runConversation')(
    function* (request: RunConversationRequest) {
      const validatedRequest = yield* Schema.decodeUnknownEffect(
        RunConversationRequest,
        { onExcessProperty: 'error' }
      )(request).pipe(Effect.mapError(() => runtimeError('invalid-payload')))
      if (validatedRequest.rootIdentity !== rootIdentity) {
        return yield* runtimeError('invalid-payload')
      }
      const eventId = applicationEventId(validatedRequest.event)
      const eventJson = yield* boundedPayloadJson(validatedRequest.event)
      const requestHash = createHash('sha256')
        .update('laborer-conversation-request-v1\0', 'utf8')
        .update(eventJson, 'utf8')
        .digest('base64url')
      const sessionId = `conversation:${createHash('sha256')
        .update('laborer-conversation-session-v1\0', 'utf8')
        .update(rootIdentity, 'utf8')
        .update('\0', 'utf8')
        .update(validatedRequest.workspaceId, 'utf8')
        .update('\0', 'utf8')
        .update(validatedRequest.event.conversationId, 'utf8')
        .digest('base64url')}`
      const accepted = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT OR IGNORE INTO laborer_conversations (
                conversation_id, workspace_id, session_id
              ) VALUES (
                ${validatedRequest.event.conversationId},
                ${validatedRequest.workspaceId}, ${sessionId}
              )
            `
            // Acquire the Conversation's SQLite write lock before allocating
            // its next durable event sequence.
            yield* sql`
              UPDATE laborer_conversations
              SET conversation_id = conversation_id
              WHERE conversation_id = ${validatedRequest.event.conversationId}
                AND workspace_id = ${validatedRequest.workspaceId}
            `
            const conversations = yield* sql<{
              readonly sessionId: string
              readonly workspaceId: string
            }>`
              SELECT session_id AS sessionId, workspace_id AS workspaceId
              FROM laborer_conversations
              WHERE conversation_id = ${validatedRequest.event.conversationId}
                AND workspace_id = ${validatedRequest.workspaceId}
            `
            const conversation = pipe(
              conversations,
              EffectArray.head,
              Option.getOrElse(() => ({ sessionId: '', workspaceId: '' }))
            )
            if (
              conversation.workspaceId !== validatedRequest.workspaceId ||
              conversation.sessionId !== sessionId
            ) {
              return yield* runtimeError('invalid-payload')
            }
            const existing = yield* sql<{
              readonly conversationId: string
              readonly eventJson: string
              readonly requestHash: string
              readonly sequence: number
              readonly sessionId: string
              readonly workspaceId: string
            }>`
              SELECT
                events.conversation_id AS conversationId,
                events.event_json AS eventJson,
                events.request_hash AS requestHash,
                events.sequence,
                conversations.session_id AS sessionId,
                events.workspace_id AS workspaceId
              FROM laborer_conversation_events AS events
              INNER JOIN laborer_conversations AS conversations
                ON conversations.workspace_id = events.workspace_id
                AND conversations.conversation_id = events.conversation_id
              WHERE events.event_id = ${eventId}
                AND events.workspace_id = ${validatedRequest.workspaceId}
            `
            const existingEvent = pipe(existing, EffectArray.head)
            if (Option.isSome(existingEvent)) {
              if (
                existingEvent.value.conversationId !==
                  validatedRequest.event.conversationId ||
                existingEvent.value.workspaceId !==
                  validatedRequest.workspaceId ||
                existingEvent.value.requestHash !== requestHash ||
                existingEvent.value.eventJson !== eventJson
              ) {
                return yield* runtimeError('invalid-payload')
              }
              return existingEvent.value
            }
            const sequences = yield* sql<{ readonly sequence: number }>`
              SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
              FROM laborer_conversation_events
              WHERE conversation_id = ${validatedRequest.event.conversationId}
                AND workspace_id = ${validatedRequest.workspaceId}
            `
            const sequence = pipe(
              sequences,
              EffectArray.head,
              Option.map((row) => row.sequence),
              Option.getOrElse(() => 1)
            )
            yield* sql`
              INSERT INTO laborer_conversation_events (
                event_id, conversation_id, workspace_id, sequence,
                request_hash, event_json, status
              ) VALUES (
                ${eventId},
                ${validatedRequest.event.conversationId},
                ${validatedRequest.workspaceId}, ${sequence}, ${requestHash},
                ${eventJson}, 'accepted'
              )
            `
            return {
              conversationId: validatedRequest.event.conversationId,
              eventJson,
              requestHash,
              sequence,
              sessionId,
              workspaceId: validatedRequest.workspaceId,
            }
          })
        )
        .pipe(Effect.mapError(() => runtimeError('storage-failure')))
      const payload: ConversationWorkflowPayload = {
        conversationId: accepted.conversationId,
        encodedEvent: accepted.eventJson,
        eventId,
        requestHash: accepted.requestHash,
        rootIdentity,
        sequence: accepted.sequence,
        sessionId: accepted.sessionId,
        workspaceId: accepted.workspaceId,
      }
      yield* Effect.uninterruptible(
        ConversationWorkflow.execute(payload, { discard: true }).pipe(
          Effect.provideService(WorkflowEngine.WorkflowEngine, workflowEngine)
        )
      )
      const receipt = yield* ConversationWorkflow.execute(payload, {
        discard: false,
      }).pipe(
        Effect.provideService(WorkflowEngine.WorkflowEngine, workflowEngine)
      )
      yield* deliverPendingExecutionEvents(
        validatedRequest.workspaceId,
        validatedRequest.event.conversationId
      ).pipe(Effect.mapError(() => runtimeError('storage-failure')))
      return receipt
    }
  )

  const getExecution = Effect.fn('RootDurableRuntime.getExecution')(function* (
    executionId: string,
    conversationId: string,
    workspaceId: string
  ) {
    const validatedExecutionId = yield* Schema.decodeUnknownEffect(
      RuntimeExecutionId
    )(executionId).pipe(Effect.mapError(() => runtimeError('invalid-payload')))
    const validatedConversationId = yield* Schema.decodeUnknownEffect(
      RuntimeConversationId
    )(conversationId).pipe(
      Effect.mapError(() => runtimeError('invalid-payload'))
    )
    const validatedWorkspaceId = yield* Schema.decodeUnknownEffect(
      RuntimeWorkspaceId
    )(workspaceId).pipe(Effect.mapError(() => runtimeError('invalid-payload')))
    const rows = yield* sql
      .unsafe<StoredExecutionRow>(
        `${executionSelect} WHERE execution_id = ? AND conversation_id = ? AND workspace_id = ?`,
        [validatedExecutionId, validatedConversationId, validatedWorkspaceId]
      )
      .pipe(Effect.mapError(() => runtimeError('storage-failure')))
    const row = yield* pipe(
      rows,
      EffectArray.head,
      Option.match({
        onNone: () => Effect.fail(runtimeError('execution-not-found')),
        onSome: Effect.succeed,
      })
    )
    return yield* snapshotFromRow(row)
  })

  const ownedExecutionRow = Effect.fn('ownedExecutionRow')(function* (
    executionId: string,
    conversationId: string,
    workspaceId: string
  ) {
    const rows = yield* sql
      .unsafe<StoredExecutionRow>(
        `${executionSelect} WHERE execution_id = ? AND conversation_id = ? AND workspace_id = ?`,
        [executionId, conversationId, workspaceId]
      )
      .pipe(Effect.mapError(() => runtimeError('storage-failure')))
    return yield* pipe(
      rows,
      EffectArray.head,
      Option.match({
        onNone: () => Effect.fail(runtimeError('execution-not-found')),
        onSome: Effect.succeed,
      })
    )
  })

  const controlSnapshot = Effect.fn('executionControlSnapshot')(function* (
    row: StoredExecutionRow
  ) {
    const durable = yield* snapshotFromRow(row)
    const action = yield* catalog
      .get(row.actionName, row.actionRevision)
      .pipe(Effect.mapError(() => runtimeError('storage-failure')))
    if (action.fingerprint !== row.actionFingerprint) {
      return yield* runtimeError('storage-failure')
    }
    return ExecutionControlSnapshot.make({
      actionName: row.actionName,
      actionRevision: row.actionRevision,
      canCancel:
        action.controls.cancel !== undefined && durable.status === 'running',
      canFollowUp:
        action.controls.followUp !== undefined && durable.status === 'running',
      conversationId: row.conversationId,
      executionId: row.executionId,
      status: durable.status,
      workspaceId: row.workspaceId,
    })
  })

  interface StoredControlRow {
    readonly conversationId: string
    readonly executionId: string
    readonly kind: string
    readonly requestHash: string
    readonly resultJson: string | null
    readonly status: string
    readonly workspaceId: string
  }
  const storedControl = (controlId: string, workspaceId: string) =>
    sql<StoredControlRow>`
      SELECT execution_id AS executionId, conversation_id AS conversationId,
        workspace_id AS workspaceId, kind, request_hash AS requestHash,
        result_json AS resultJson, status
      FROM laborer_execution_controls
      WHERE control_id = ${controlId} AND workspace_id = ${workspaceId}
    `.pipe(Effect.mapError(() => runtimeError('storage-failure')))
  const decodeStoredControlReceipt = (encoded: string) =>
    decodeStoredJson(encoded).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(ExecutionControlReceipt, {
          onExcessProperty: 'error',
        })
      ),
      Effect.mapError(() => runtimeError('storage-failure'))
    )
  const controlRequestHash = (kind: string, request: unknown) =>
    boundedPayloadJson({ kind, request }).pipe(
      Effect.map((encoded) =>
        createHash('sha256').update(encoded, 'utf8').digest('base64url')
      )
    )

  const inspectExecution = Effect.fn('RootDurableRuntime.inspectExecution')(
    function* (untrustedRequest: InspectExecutionRequest) {
      const request = yield* Schema.decodeUnknownEffect(
        InspectExecutionRequest,
        {
          onExcessProperty: 'error',
        }
      )(untrustedRequest).pipe(
        Effect.mapError(() => runtimeError('invalid-payload'))
      )
      const requestHash = yield* controlRequestHash('inspect', request)
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`
              UPDATE laborer_executions SET execution_id = execution_id
              WHERE execution_id = ${request.executionId}
            `
            const row = yield* ownedExecutionRow(
              request.executionId,
              request.conversationId,
              request.workspaceId
            )
            const existing = pipe(
              yield* storedControl(request.controlId, request.workspaceId),
              EffectArray.head
            )
            if (Option.isSome(existing)) {
              if (
                existing.value.kind !== 'inspect' ||
                existing.value.requestHash !== requestHash ||
                existing.value.executionId !== request.executionId ||
                existing.value.conversationId !== request.conversationId ||
                existing.value.workspaceId !== request.workspaceId
              ) {
                return yield* runtimeError('conflicting-control')
              }
              if (existing.value.resultJson === null) {
                return yield* runtimeError('storage-failure')
              }
              const prior = yield* decodeStoredControlReceipt(
                existing.value.resultJson
              )
              return { ...prior, deduplicated: true }
            }
            const execution = yield* controlSnapshot(row)
            const receipt = ExecutionControlReceipt.make({
              controlId: request.controlId,
              deduplicated: false,
              execution,
            })
            const resultJson = yield* boundedPayloadJson(receipt)
            const sequences = yield* sql<{ readonly sequence: number }>`
            SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
            FROM laborer_execution_controls
            WHERE execution_id = ${request.executionId}
          `
            yield* sql`
            INSERT INTO laborer_execution_controls (
              control_id, execution_id, conversation_id, workspace_id,
              sequence, kind, request_hash, result_json, status
            ) VALUES (
              ${request.controlId}, ${request.executionId},
              ${request.conversationId}, ${request.workspaceId},
              ${sequences[0]?.sequence ?? 1}, 'inspect', ${requestHash},
              ${resultJson}, 'completed'
            )
          `
            return receipt
          })
        )
        .pipe(
          Effect.mapError((error) =>
            error instanceof DurableRuntimeError
              ? error
              : runtimeError('storage-failure')
          )
        )
    }
  )

  const mutateExecution = Effect.fn('RootDurableRuntime.mutateExecution')(
    function* (
      kind: 'follow-up' | 'cancel',
      untrustedRequest: FollowUpExecutionRequest | CancelExecutionRequest
    ) {
      const request = yield* Schema.decodeUnknownEffect(
        kind === 'follow-up'
          ? FollowUpExecutionRequest
          : CancelExecutionRequest,
        { onExcessProperty: 'error' }
      )(untrustedRequest).pipe(
        Effect.mapError(() => runtimeError('invalid-payload'))
      )
      const requestHash = yield* controlRequestHash(kind, request)
      return yield* Effect.uninterruptible(
        executionControlGate.withPermit(
          request.executionId,
          // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: durable idempotency, ownership, and terminal fencing are intentionally co-located.
          Effect.gen(function* () {
            const row = yield* ownedExecutionRow(
              request.executionId,
              request.conversationId,
              request.workspaceId
            )
            const existing = pipe(
              yield* storedControl(request.controlId, request.workspaceId),
              EffectArray.head
            )
            if (Option.isSome(existing)) {
              if (
                existing.value.kind !== kind ||
                existing.value.requestHash !== requestHash ||
                existing.value.executionId !== request.executionId ||
                existing.value.conversationId !== request.conversationId ||
                existing.value.workspaceId !== request.workspaceId
              ) {
                return yield* runtimeError('conflicting-control')
              }
              if (existing.value.resultJson === null) {
                return yield* runtimeError('control-failed')
              }
              const prior = yield* decodeStoredControlReceipt(
                existing.value.resultJson
              )
              return { ...prior, deduplicated: true }
            }
            const action = yield* catalog
              .get(row.actionName, row.actionRevision)
              .pipe(Effect.mapError(() => runtimeError('storage-failure')))
            const capability =
              kind === 'cancel'
                ? action.controls.cancel
                : action.controls.followUp
            if (capability === undefined) {
              return yield* runtimeError('unsupported-control')
            }
            if (
              (kind === 'follow-up' && row.status !== 'running') ||
              (kind === 'cancel' && row.status !== 'running')
            ) {
              return yield* runtimeError('execution-not-active')
            }
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`
                  UPDATE laborer_executions SET execution_id = execution_id
                  WHERE execution_id = ${request.executionId}
                `
                const current = yield* ownedExecutionRow(
                  request.executionId,
                  request.conversationId,
                  request.workspaceId
                )
                if (
                  (kind === 'follow-up' && current.status !== 'running') ||
                  (kind === 'cancel' && current.status !== 'running')
                ) {
                  return yield* runtimeError('execution-not-active')
                }
                const sequences = yield* sql<{ readonly sequence: number }>`
                  SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
                  FROM laborer_execution_controls
                  WHERE execution_id = ${request.executionId}
                `
                yield* sql`
                  INSERT INTO laborer_execution_controls (
                    control_id, execution_id, conversation_id, workspace_id,
                    sequence, kind, request_hash, result_json, status
                  ) VALUES (
                    ${request.controlId}, ${request.executionId},
                    ${request.conversationId}, ${request.workspaceId},
                    ${sequences[0]?.sequence ?? 1}, ${kind}, ${requestHash},
                    NULL, 'accepted'
                  )
                `
                if (kind === 'cancel') {
                  yield* sql`
                    UPDATE laborer_executions SET status = 'cancelling'
                    WHERE execution_id = ${request.executionId}
                  `
                }
              })
            )
            if (kind === 'cancel') {
              yield* taskEmission.emit({
                acceptedAtUnixMs: row.acceptedAtUnixMs ?? 0,
                actionName: row.actionName,
                conversationId: row.conversationId,
                executionId: row.executionId,
                input: yield* decodeStoredJson(row.inputJson).pipe(
                  Effect.orDie
                ),
                status: 'cancelling',
                workspaceId: row.workspaceId,
              })
            }
            const controlContext = {
              controlId: request.controlId,
              conversationId: request.conversationId,
              executionId: request.executionId,
              rootIdentity,
              workspaceId: request.workspaceId,
            }
            let controlEffect: Effect.Effect<void, unknown> | undefined
            if (kind === 'cancel') {
              controlEffect = action.controls.cancel?.(controlContext)
            } else if (
              'content' in request &&
              typeof request.content === 'string'
            ) {
              controlEffect = action.controls.followUp?.(
                request.content,
                controlContext
              )
            }
            if (controlEffect === undefined) {
              return yield* runtimeError('storage-failure')
            }
            const outcome = yield* Effect.exit(controlEffect)
            if (Exit.isFailure(outcome)) {
              yield* sql.withTransaction(
                Effect.gen(function* () {
                  yield* sql`
                    UPDATE laborer_execution_controls SET status = 'failed'
                     WHERE control_id = ${request.controlId}
                       AND workspace_id = ${request.workspaceId}
                       AND status = 'accepted'
                  `
                  if (kind === 'cancel') {
                    yield* sql`
                      UPDATE laborer_executions SET status = 'running'
                      WHERE execution_id = ${request.executionId} AND status = 'cancelling'
                    `
                  }
                })
              )
              if (kind === 'cancel') {
                yield* taskEmission.emit({
                  acceptedAtUnixMs: row.acceptedAtUnixMs ?? 0,
                  actionName: row.actionName,
                  conversationId: row.conversationId,
                  executionId: row.executionId,
                  input: yield* decodeStoredJson(row.inputJson).pipe(
                    Effect.orDie
                  ),
                  status: 'running',
                  workspaceId: row.workspaceId,
                })
              }
              return yield* runtimeError('control-failed')
            }
            let cancelledEvent: ExecutionEvent | undefined
            if (kind === 'cancel') {
              cancelledEvent = yield* sql.withTransaction(
                Effect.gen(function* () {
                  yield* sql`
                    UPDATE laborer_executions SET status = 'cancelled'
                    WHERE execution_id = ${request.executionId} AND status = 'cancelling'
                  `
                  const changes = yield* sql<{ readonly count: number }>`
                    SELECT changes() AS count
                  `
                  if (changes[0]?.count !== 1) {
                    return yield* runtimeError('storage-failure')
                  }
                  return yield* persistEvent({
                    conversationId: request.conversationId,
                    executionId: request.executionId,
                    kind: 'cancelled',
                    payload: { category: 'cancelled' },
                    workspaceId: request.workspaceId,
                  }).pipe(Effect.provideService(SqlClient, sql))
                })
              )
            }
            const finalRow = yield* ownedExecutionRow(
              request.executionId,
              request.conversationId,
              request.workspaceId
            )
            const receipt = ExecutionControlReceipt.make({
              controlId: request.controlId,
              deduplicated: false,
              execution: yield* controlSnapshot(finalRow),
            })
            const resultJson = yield* boundedPayloadJson(receipt)
            yield* sql`
              UPDATE laborer_execution_controls
              SET status = 'completed', result_json = ${resultJson}
               WHERE control_id = ${request.controlId}
                 AND workspace_id = ${request.workspaceId}
                 AND status = 'accepted'
            `
            if (cancelledEvent !== undefined) {
              yield* taskEmission.emit({
                acceptedAtUnixMs: row.acceptedAtUnixMs ?? 0,
                actionName: row.actionName,
                conversationId: row.conversationId,
                executionId: row.executionId,
                input: yield* decodeStoredJson(row.inputJson).pipe(
                  Effect.orDie
                ),
                status: 'cancelled',
                workspaceId: row.workspaceId,
              })
              yield* acceptExecutionEventIntoConversation(
                cancelledEvent,
                rootIdentity,
                workflowEngine
              ).pipe(Effect.provideService(SqlClient, sql))
            }
            return receipt
          })
        )
      ).pipe(
        Effect.mapError((error) =>
          error instanceof DurableRuntimeError
            ? error
            : runtimeError('storage-failure')
        )
      )
    }
  )

  const startExecution = Effect.fn('RootDurableRuntime.startExecution')(
    function* (request: StartExecutionRequest) {
      const validatedRequest = yield* Schema.decodeUnknownEffect(
        StartExecutionRequest,
        { onExcessProperty: 'error' }
      )(request).pipe(Effect.mapError(() => runtimeError('invalid-payload')))
      if (validatedRequest.rootIdentity !== rootIdentity) {
        return yield* runtimeError('conflicting-invocation')
      }
      const action = yield* catalog
        .get(validatedRequest.actionName)
        .pipe(Effect.mapError(() => runtimeError('unavailable-action')))
      yield* action
        .decodeInput(validatedRequest.input)
        .pipe(Effect.mapError(() => runtimeError('invalid-payload')))
      const encodedInput = yield* boundedPayloadJson(validatedRequest.input)
      const inputHash = createHash('sha256')
        .update(encodedInput, 'utf8')
        .digest('base64url')
      const payload: RegisteredActionWorkflowPayload = {
        actionFingerprint: action.fingerprint,
        actionName: action.name,
        actionRevision: action.revision,
        catalogFingerprint: catalog.fingerprint,
        conversationId: validatedRequest.conversationId,
        encodedInput,
        invocationId: validatedRequest.invocationId,
        rootIdentity: validatedRequest.rootIdentity,
        workspaceId: validatedRequest.workspaceId,
      }
      const executionId =
        yield* RegisteredActionExecutionWorkflow.executionId(payload)
      const acceptedRow = yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const row = yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql`
                INSERT OR IGNORE INTO laborer_executions (
                  execution_id, invocation_id, conversation_id, action_name,
                  action_revision, action_fingerprint, catalog_fingerprint,
                  input_hash, input_json, status, accepted_at_unix_ms, workspace_id
                ) VALUES (
                  ${executionId}, ${validatedRequest.invocationId},
                  ${validatedRequest.conversationId}, ${action.name}, ${action.revision},
                  ${action.fingerprint}, ${catalog.fingerprint}, ${inputHash},
                  ${encodedInput}, 'queued', ${Date.now()}, ${validatedRequest.workspaceId}
                )
              `
                const changes = yield* sql<{ readonly count: number }>`
                  SELECT changes() AS count
                `
                const rows = yield* sql.unsafe<StoredExecutionRow>(
                  `${executionSelect} WHERE invocation_id = ? AND workspace_id = ?`,
                  [validatedRequest.invocationId, validatedRequest.workspaceId]
                )
                const accepted = yield* pipe(
                  rows,
                  EffectArray.head,
                  Option.match({
                    onNone: () =>
                      Effect.die(
                        new Error('accepted Execution was not durable')
                      ),
                    onSome: Effect.succeed,
                  })
                )
                return { accepted, inserted: changes[0]?.count === 1 }
              })
            )
            .pipe(Effect.mapError(() => runtimeError('storage-failure')))
          if (
            row.accepted.inputHash !== inputHash ||
            row.accepted.actionName !== action.name ||
            row.accepted.actionRevision !== action.revision ||
            row.accepted.actionFingerprint !== action.fingerprint ||
            row.accepted.conversationId !== validatedRequest.conversationId ||
            row.accepted.workspaceId !== validatedRequest.workspaceId ||
            row.accepted.executionId !== executionId
          ) {
            return yield* runtimeError('conflicting-invocation')
          }
          if (row.inserted && row.accepted.acceptedAtUnixMs !== null) {
            yield* taskEmission.emit({
              acceptedAtUnixMs: row.accepted.acceptedAtUnixMs,
              actionName: action.name,
              conversationId: validatedRequest.conversationId,
              executionId,
              input: validatedRequest.input,
              status: 'queued',
              workspaceId: validatedRequest.workspaceId,
            })
          }
          yield* RegisteredActionExecutionWorkflow.execute(payload, {
            discard: true,
          }).pipe(
            Effect.provideService(WorkflowEngine.WorkflowEngine, workflowEngine)
          )
          return row.accepted
        })
      )
      return yield* getExecution(
        acceptedRow.executionId,
        validatedRequest.conversationId,
        validatedRequest.workspaceId
      )
    }
  )

  const pendingEvents = Effect.fn('RootDurableRuntime.pendingEvents')(
    function* (
      conversationId: string,
      workspaceId: string,
      requestedLimit = 32
    ) {
      const validatedConversationId = yield* Schema.decodeUnknownEffect(
        RuntimeConversationId
      )(conversationId).pipe(
        Effect.mapError(() => runtimeError('invalid-payload'))
      )
      if (
        !Number.isSafeInteger(requestedLimit) ||
        requestedLimit < 1 ||
        requestedLimit > 128
      ) {
        return yield* runtimeError('invalid-payload')
      }
      const limit = requestedLimit
      const validatedWorkspaceId = yield* Schema.decodeUnknownEffect(
        RuntimeWorkspaceId
      )(workspaceId).pipe(
        Effect.mapError(() => runtimeError('invalid-payload'))
      )
      const rows = yield* sql<{
        readonly conversationId: string
        readonly eventId: string
        readonly executionId: string
        readonly kind: string
        readonly payloadJson: string
        readonly sequence: number
        readonly workspaceId: string
      }>`
        SELECT
          events.event_id AS eventId,
          events.execution_id AS executionId,
          events.conversation_id AS conversationId,
          events.sequence,
          events.kind,
          events.payload_json AS payloadJson,
          events.workspace_id AS workspaceId
        FROM laborer_execution_outbox AS outbox
        INNER JOIN laborer_execution_events AS events
          ON events.event_id = outbox.event_id
        WHERE outbox.acknowledged = 0
          AND events.conversation_id = ${validatedConversationId}
          AND events.workspace_id = ${validatedWorkspaceId}
        ORDER BY outbox.outbox_sequence
        LIMIT ${limit}
      `.pipe(Effect.mapError(() => runtimeError('storage-failure')))
      return yield* Effect.forEach(rows, (row) =>
        Effect.gen(function* () {
          const payload = yield* decodeStoredJson(row.payloadJson)
          return yield* Schema.decodeUnknownEffect(ExecutionEvent)({
            conversationId: row.conversationId,
            eventId: row.eventId,
            executionId: row.executionId,
            kind: row.kind,
            payload,
            sequence: row.sequence,
            workspaceId: row.workspaceId,
          }).pipe(Effect.mapError(() => runtimeError('storage-failure')))
        })
      )
    }
  )

  const acknowledgeEvent = Effect.fn('RootDurableRuntime.acknowledgeEvent')(
    function* (eventId: string, conversationId: string, workspaceId: string) {
      const validatedEventId = yield* Schema.decodeUnknownEffect(
        RuntimeEventId
      )(eventId).pipe(Effect.mapError(() => runtimeError('invalid-payload')))
      const validatedConversationId = yield* Schema.decodeUnknownEffect(
        RuntimeConversationId
      )(conversationId).pipe(
        Effect.mapError(() => runtimeError('invalid-payload'))
      )
      const validatedWorkspaceId = yield* Schema.decodeUnknownEffect(
        RuntimeWorkspaceId
      )(workspaceId).pipe(
        Effect.mapError(() => runtimeError('invalid-payload'))
      )
      yield* sql`
        UPDATE laborer_execution_outbox
        SET acknowledged = 1
        WHERE event_id = ${validatedEventId}
          AND EXISTS (
            SELECT 1
            FROM laborer_execution_events AS events
            WHERE events.event_id = laborer_execution_outbox.event_id
              AND events.conversation_id = ${validatedConversationId}
              AND events.workspace_id = ${validatedWorkspaceId}
          )
      `.pipe(Effect.mapError(() => runtimeError('storage-failure')))
    }
  )

  // Re-submit every recoverable domain projection through Workflow's public
  // idempotent execute API. Cluster normally restores persisted messages by
  // itself, but a domain row can be ahead of the journal after a process
  // death. Re-submission closes that acceptance window without inspecting
  // Cluster's private SQL tables. Running Workflows replay completed
  // activities from their journals; each Action recovery policy fences any
  // unfinished external boundary.
  let conversationWorkspaceCursor = ''
  let conversationEventCursor = ''
  let conversationRecoveryBatchSize = 128
  while (conversationRecoveryBatchSize === 128) {
    const recoverable = yield* sql.unsafe<StoredConversationRecoveryRow>(
      `SELECT
         events.event_id AS eventId,
         events.conversation_id AS conversationId,
         events.workspace_id AS workspaceId,
         events.sequence,
         events.request_hash AS requestHash,
         events.event_json AS eventJson,
         conversations.session_id AS sessionId
       FROM laborer_conversation_events AS events
       INNER JOIN laborer_conversations AS conversations
         ON conversations.workspace_id = events.workspace_id
         AND conversations.conversation_id = events.conversation_id
       WHERE events.status IN ('accepted', 'running')
         AND (
           events.workspace_id > ?
           OR (events.workspace_id = ? AND events.event_id > ?)
         )
       ORDER BY events.workspace_id, events.event_id
       LIMIT 128`,
      [
        conversationWorkspaceCursor,
        conversationWorkspaceCursor,
        conversationEventCursor,
      ]
    )
    conversationRecoveryBatchSize = recoverable.length
    yield* Effect.forEach(
      recoverable,
      (row) =>
        ConversationWorkflow.execute(
          {
            conversationId: row.conversationId,
            encodedEvent: row.eventJson,
            eventId: row.eventId,
            requestHash: row.requestHash,
            rootIdentity,
            sequence: row.sequence,
            sessionId: row.sessionId,
            workspaceId: row.workspaceId,
          },
          { discard: true }
        ).pipe(
          Effect.provideService(WorkflowEngine.WorkflowEngine, workflowEngine)
        ),
      {
        concurrency: RUNTIME_MAX_CONCURRENT_EXECUTIONS,
        discard: true,
      }
    )
    const lastConversation = recoverable.at(-1)
    if (lastConversation !== undefined) {
      conversationWorkspaceCursor = lastConversation.workspaceId
      conversationEventCursor = lastConversation.eventId
    }
  }

  let recoveryCursor = ''
  let recoveryBatchSize = 128
  while (recoveryBatchSize === 128) {
    const recoverable = yield* sql.unsafe<StoredExecutionRow>(
      `${executionSelect}
       WHERE status IN ('queued', 'running') AND execution_id > ?
       ORDER BY execution_id
       LIMIT 128`,
      [recoveryCursor]
    )
    recoveryBatchSize = recoverable.length
    yield* Effect.forEach(
      recoverable,
      (row) =>
        RegisteredActionExecutionWorkflow.execute(
          {
            actionName: row.actionName,
            actionRevision: row.actionRevision,
            actionFingerprint: row.actionFingerprint,
            catalogFingerprint: row.catalogFingerprint,
            conversationId: row.conversationId,
            encodedInput: row.inputJson,
            invocationId: row.invocationId,
            rootIdentity,
            workspaceId: row.workspaceId,
          },
          { discard: true }
        ).pipe(
          Effect.provideService(WorkflowEngine.WorkflowEngine, workflowEngine)
        ),
      {
        concurrency: RUNTIME_MAX_CONCURRENT_EXECUTIONS,
        discard: true,
      }
    )
    recoveryCursor = recoverable.at(-1)?.executionId ?? recoveryCursor
  }

  // The private runtime row is the source of truth. Reconcile only after the
  // recovery submissions so a process death between either database commit
  // converges on the next startup without an outbox or polling loop.
  let taskCursor = ''
  let taskBatchSize = 128
  while (taskBatchSize === 128) {
    const executions = yield* sql.unsafe<StoredExecutionRow>(
      `${executionSelect}
       WHERE execution_id > ?
       ORDER BY execution_id
       LIMIT 128`,
      [taskCursor]
    )
    taskBatchSize = executions.length
    yield* Effect.forEach(
      executions,
      (row) =>
        decodeStoredJson(row.inputJson).pipe(
          Effect.flatMap((input) =>
            Schema.decodeUnknownEffect(ExecutionStatus)(row.status).pipe(
              Effect.flatMap((status) =>
                taskEmission.emit({
                  acceptedAtUnixMs: row.acceptedAtUnixMs ?? 0,
                  actionName: row.actionName,
                  conversationId: row.conversationId,
                  executionId: row.executionId,
                  input,
                  status,
                  workspaceId: row.workspaceId,
                })
              )
            )
          ),
          Effect.ignore
        ),
      { concurrency: 1, discard: true }
    )
    taskCursor = executions.at(-1)?.executionId ?? taskCursor
  }

  const checkConversationClientCompatibility = Effect.fn(
    'RootDurableRuntime.checkConversationClientCompatibility'
  )(function* (compatibility: ConversationClientCompatibility) {
    const validatedCompatibility = yield* Schema.decodeUnknownEffect(
      ConversationClientCompatibility,
      { onExcessProperty: 'error' }
    )(compatibility).pipe(
      Effect.mapError(() => runtimeError('incompatible-client'))
    )
    if (
      validatedCompatibility.actionCatalogFingerprint !== catalog.fingerprint
    ) {
      return yield* runtimeError('incompatible-client')
    }
  })

  const nonterminalExecutionActivity = Effect.fn(
    'RootDurableRuntime.nonterminalExecutionActivity'
  )(function* (workspaceId: string) {
    const validatedWorkspaceId = yield* Schema.decodeUnknownEffect(
      RuntimeWorkspaceId
    )(workspaceId).pipe(Effect.mapError(() => runtimeError('invalid-payload')))
    const rows = yield* sql<{
      readonly acceptedAtUnixMs: number | null
      readonly actionName: string
      readonly conversationId: string
      readonly executionId: string
      readonly status: 'cancelling' | 'needs-attention' | 'queued' | 'running'
      readonly workspaceId: string
    }>`
      SELECT execution_id AS executionId, action_name AS actionName,
        conversation_id AS conversationId, workspace_id AS workspaceId,
        accepted_at_unix_ms AS acceptedAtUnixMs, status
      FROM laborer_executions
      WHERE workspace_id = ${validatedWorkspaceId}
        AND status IN ('queued', 'running', 'cancelling', 'needs-attention')
      ORDER BY accepted_at_unix_ms, execution_id
      LIMIT 513
    `.pipe(Effect.mapError(() => runtimeError('storage-failure')))
    if (rows.length > 512) {
      return yield* runtimeError('storage-failure')
    }
    if (
      rows.some(
        (row) =>
          row.workspaceId !== validatedWorkspaceId ||
          (row.acceptedAtUnixMs !== null &&
            (!Number.isSafeInteger(row.acceptedAtUnixMs) ||
              row.acceptedAtUnixMs < 0))
      )
    ) {
      return yield* runtimeError('storage-failure')
    }
    const lifecycleForStatus = (
      status: (typeof rows)[number]['status']
    ): 'allocated' | 'cancelling' | 'recovery-blocked' | 'running' => {
      if (status === 'queued') {
        return 'allocated'
      }
      if (status === 'needs-attention') {
        return 'recovery-blocked'
      }
      return status
    }
    return rows.map((row) => ({
      actionName: row.actionName,
      conversationId: row.conversationId,
      executionId: row.executionId,
      lifecycle: lifecycleForStatus(row.status),
      startedAtUnixMs: row.acceptedAtUnixMs,
      workspaceId: row.workspaceId,
    }))
  })

  const workThreadActivity = Effect.fn('RootDurableRuntime.workThreadActivity')(
    function* (workspaceId: string) {
      const validatedWorkspaceId = yield* Schema.decodeUnknownEffect(
        RuntimeWorkspaceId
      )(workspaceId).pipe(
        Effect.mapError(() => runtimeError('invalid-payload'))
      )
      const rows = yield* sql<{
        readonly conversationId: string
        readonly inProgress: number
        readonly latestParticipantEventJson: string
        readonly workspaceId: string
      }>`
      SELECT conversations.conversation_id AS conversationId,
        conversations.workspace_id AS workspaceId,
        EXISTS (
          SELECT 1 FROM laborer_conversation_events AS pending
          WHERE pending.workspace_id = conversations.workspace_id
            AND pending.conversation_id = conversations.conversation_id
            AND pending.status IN ('accepted', 'running')
        ) AS inProgress,
        (
          SELECT participant.event_json
          FROM laborer_conversation_events AS participant
          WHERE participant.workspace_id = conversations.workspace_id
            AND participant.conversation_id = conversations.conversation_id
            AND json_extract(participant.event_json, '$._tag') = 'ParticipantInput'
          ORDER BY participant.sequence DESC
          LIMIT 1
        ) AS latestParticipantEventJson
      FROM laborer_conversations AS conversations
      WHERE conversations.workspace_id = ${validatedWorkspaceId}
      ORDER BY conversations.conversation_id
      LIMIT 513
    `.pipe(Effect.mapError(() => runtimeError('storage-failure')))
      if (rows.length > 512) {
        return yield* runtimeError('storage-failure')
      }
      const executions =
        yield* nonterminalExecutionActivity(validatedWorkspaceId)
      const conversationIds = new Set(rows.map((row) => row.conversationId))
      if (
        executions.some(
          (execution) => !conversationIds.has(execution.conversationId)
        )
      ) {
        return yield* runtimeError('storage-failure')
      }
      return yield* Effect.forEach(rows, (row) =>
        Effect.gen(function* () {
          if (
            row.workspaceId !== validatedWorkspaceId ||
            (row.inProgress !== 0 && row.inProgress !== 1) ||
            typeof row.latestParticipantEventJson !== 'string'
          ) {
            return yield* runtimeError('storage-failure')
          }
          const event = yield* decodeStoredJson(
            row.latestParticipantEventJson
          ).pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(ParticipantInputEvent, {
                onExcessProperty: 'error',
              })
            ),
            Effect.mapError(() => runtimeError('storage-failure'))
          )
          if (
            event.conversationId !== row.conversationId ||
            event.messages.length === 0
          ) {
            return yield* runtimeError('storage-failure')
          }
          const latest = event.messages.at(-1)
          if (latest === undefined) {
            return yield* runtimeError('storage-failure')
          }
          const threadExecutions = executions
            .filter(
              (execution) => execution.conversationId === row.conversationId
            )
            .map((execution) => ({
              actionName: execution.actionName,
              executionId: execution.executionId,
              lifecycle: execution.lifecycle,
              startedAtUnixMs: execution.startedAtUnixMs,
            }))
          const slackSeconds = Number(latest.slackTs)
          const messageEvidence = Number.isFinite(slackSeconds)
            ? Math.max(0, Math.floor(slackSeconds * 1000))
            : 0
          return {
            channelId: event.channelId,
            conversationId: row.conversationId,
            conversationInProgress: row.inProgress === 1,
            evidenceAtUnixMs: Math.max(
              messageEvidence,
              ...threadExecutions.map(
                (execution) => execution.startedAtUnixMs ?? 0
              )
            ),
            excerpt: latest.text,
            executions: threadExecutions,
            rootTs: event.rootTs,
            workspaceId: row.workspaceId,
          } satisfies DurableWorkThreadActivity
        })
      )
    }
  )

  return {
    acknowledgeEvent,
    actions: catalog,
    cancelExecution: (request) => mutateExecution('cancel', request),
    checkConversationClientCompatibility,
    followUpExecution: (request) => mutateExecution('follow-up', request),
    getExecution,
    inspectExecution,
    nonterminalExecutionActivity,
    pendingEvents,
    attachConversationClient: (compatibility, workspaceId, handler) =>
      Effect.gen(function* () {
        yield* checkConversationClientCompatibility(compatibility)
        const validatedWorkspaceId = yield* Schema.decodeUnknownEffect(
          RuntimeWorkspaceId
        )(workspaceId).pipe(
          Effect.mapError(() => runtimeError('invalid-payload'))
        )
        yield* conversationHandlers
          .register(validatedWorkspaceId, handler)
          .pipe(
            Effect.tap(() =>
              deliverPendingExecutionEvents(validatedWorkspaceId).pipe(
                Effect.mapError(() => runtimeError('storage-failure')),
                Effect.forkScoped
              )
            )
          )
      }),
    runConversation,
    startExecution,
    workThreadActivity,
  } satisfies RootDurableRuntimeShape
})

const clusterLayer = ClusterWorkflowEngine.layer.pipe(
  Layer.provideMerge(
    SingleRunner.layer({
      runnerStorage: 'sql',
      shardingConfig: {
        entityMessagePollInterval: 10,
        entityReplyPollInterval: 10,
        entityTerminationTimeout: 100,
        refreshAssignmentsInterval: 10,
        sendRetryInterval: 10,
      },
    })
  )
)

export const makeRootDurableRuntimeLayer = (
  sqliteLayer: Layer.Layer<SqlClient, unknown>,
  catalog: RegisteredActionCatalog,
  rootIdentity: string,
  taskEmitter: ExecutionTaskEmitter = noopExecutionTaskEmitter
) => {
  const registryLayer = Layer.succeed(ActionRegistry, catalog)
  const conversationRegistryLayer = Layer.effect(
    ConversationHandlerRegistry,
    makeConversationHandlerRegistry
  )
  const executionGateLayer = Layer.sync(ExecutionGate, () =>
    Semaphore.makeUnsafe(RUNTIME_MAX_CONCURRENT_EXECUTIONS)
  )
  const executionControlGateLayer = Layer.effect(
    ExecutionControlGate,
    makeExecutionControlGate
  )
  const rootIdentityLayer = Layer.succeed(RootIdentity, rootIdentity)
  const taskEmissionLayer = Layer.succeed(ExecutionTaskEmission, taskEmitter)
  const migrationsLayer = Layer.effectDiscard(initializeLaborerTables).pipe(
    Layer.provide(sqliteLayer)
  )
  const registrationLayer = Layer.effectDiscard(validateRootRegistration).pipe(
    Layer.provideMerge(registryLayer),
    Layer.provideMerge(rootIdentityLayer),
    Layer.provideMerge(taskEmissionLayer),
    Layer.provideMerge(sqliteLayer),
    Layer.provideMerge(migrationsLayer)
  )
  const workflowLayer = Layer.merge(
    workflowHandlerLayer,
    conversationWorkflowLayer
  ).pipe(
    Layer.provideMerge(clusterLayer),
    Layer.provideMerge(registryLayer),
    Layer.provideMerge(conversationRegistryLayer),
    Layer.provideMerge(executionGateLayer),
    Layer.provideMerge(executionControlGateLayer),
    Layer.provideMerge(rootIdentityLayer),
    Layer.provideMerge(taskEmissionLayer),
    Layer.provideMerge(sqliteLayer),
    Layer.provideMerge(migrationsLayer),
    Layer.provideMerge(registrationLayer)
  )
  return Layer.effect(RootDurableRuntime, makeRuntimeService).pipe(
    Layer.provideMerge(workflowLayer),
    Layer.provideMerge(registryLayer),
    Layer.provideMerge(conversationRegistryLayer),
    Layer.provideMerge(executionGateLayer),
    Layer.provideMerge(executionControlGateLayer),
    Layer.provideMerge(rootIdentityLayer),
    Layer.provideMerge(taskEmissionLayer),
    Layer.provideMerge(sqliteLayer),
    Layer.provideMerge(migrationsLayer),
    Layer.provideMerge(registrationLayer)
  )
}
