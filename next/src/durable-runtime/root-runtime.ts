import { createHash } from "node:crypto";
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Array as EffectArray,
  Layer,
  Option,
  pipe,
  Schedule,
  Schema,
  Semaphore,
} from "effect";
import { ClusterWorkflowEngine, SingleRunner } from "effect/unstable/cluster";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { Activity, Workflow, WorkflowEngine } from "effect/unstable/workflow";
import { canonicalActionInput } from "../action-catalog.ts";
import {
  ApplicationConversationMessageChunk,
  type ApplicationPublicOutput,
  ApplicationPublicReply,
  ParticipantInputEvent,
} from "../application.ts";
import {
  ACTION_NAME_MAX_LENGTH,
  ACTION_REVISION_MAX_LENGTH,
  ActionRegistrationError,
  type RegisteredAction,
  type RegisteredActionCatalog,
  type RegisteredActionContext,
} from "./action.ts";

const RUNTIME_SCHEMA_VERSION = 2;
export const RUNTIME_PAYLOAD_MAX_BYTES = 64 * 1024;
export const RUNTIME_CONVERSATION_ID_MAX_LENGTH = 512;
export const RUNTIME_INVOCATION_ID_MAX_LENGTH = 512;
export const RUNTIME_ROOT_IDENTITY_MAX_LENGTH = 4096;
export const RUNTIME_EXECUTION_ID_MAX_LENGTH = 160;
export const RUNTIME_EVENT_ID_MAX_LENGTH = 256;
export const RUNTIME_PROGRESS_ID_MAX_LENGTH = 256;
export const RUNTIME_WORKSPACE_ID_MAX_LENGTH = 256;
const RUNTIME_CATALOG_FINGERPRINT_MAX_LENGTH = 64;
const RUNTIME_ACTION_FINGERPRINT_MAX_LENGTH = 64;
const NONBLANK_PATTERN = /\S/;

const boundedNonBlankString = (maximumLength: number) =>
  Schema.String.check(
    Schema.isPattern(NONBLANK_PATTERN),
    Schema.isMaxLength(maximumLength)
  );
export const RuntimeConversationId = boundedNonBlankString(
  RUNTIME_CONVERSATION_ID_MAX_LENGTH
);
export const RuntimeInvocationId = boundedNonBlankString(
  RUNTIME_INVOCATION_ID_MAX_LENGTH
);
export const RuntimeRootIdentity = boundedNonBlankString(
  RUNTIME_ROOT_IDENTITY_MAX_LENGTH
);
export const RuntimeExecutionId = boundedNonBlankString(
  RUNTIME_EXECUTION_ID_MAX_LENGTH
);
export const RuntimeEventId = boundedNonBlankString(
  RUNTIME_EVENT_ID_MAX_LENGTH
);
export const RuntimeProgressId = boundedNonBlankString(
  RUNTIME_PROGRESS_ID_MAX_LENGTH
);
export const RuntimeWorkspaceId = boundedNonBlankString(
  RUNTIME_WORKSPACE_ID_MAX_LENGTH
);
export const ExecutionStatus = Schema.Literals([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "needs-attention",
]);
export type ExecutionStatus = typeof ExecutionStatus.Type;

export const StartExecutionRequest = Schema.Struct({
  actionName: boundedNonBlankString(ACTION_NAME_MAX_LENGTH),
  conversationId: RuntimeConversationId,
  input: Schema.Unknown,
  invocationId: RuntimeInvocationId,
  rootIdentity: RuntimeRootIdentity,
});
export type StartExecutionRequest = typeof StartExecutionRequest.Type;

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
    Schema.Literals(["action-failed", "invalid-result", "needs-attention"])
  ),
  invocationId: RuntimeInvocationId,
  result: Schema.NullOr(Schema.Unknown),
  status: ExecutionStatus,
});
export type ExecutionSnapshot = typeof ExecutionSnapshot.Type;

export const ExecutionEvent = Schema.Struct({
  conversationId: RuntimeConversationId,
  eventId: RuntimeEventId,
  executionId: RuntimeExecutionId,
  kind: Schema.Literals(["progress", "completed", "failed"]),
  payload: Schema.Unknown,
  sequence: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type ExecutionEvent = typeof ExecutionEvent.Type;

export const ConversationOutput = Schema.Union([
  ApplicationConversationMessageChunk,
  ApplicationPublicReply,
]);
export type ConversationOutput = typeof ConversationOutput.Type;

export const RunConversationRequest = Schema.Struct({
  event: ParticipantInputEvent,
  rootIdentity: RuntimeRootIdentity,
  workspaceId: RuntimeWorkspaceId,
});
export type RunConversationRequest = typeof RunConversationRequest.Type;

export const ConversationReceipt = Schema.Struct({
  conversationId: RuntimeConversationId,
  eventId: RuntimeInvocationId,
  outputs: Schema.Array(ConversationOutput),
  sequence: Schema.Int.check(Schema.isGreaterThan(0)),
  sessionId: boundedNonBlankString(RUNTIME_EXECUTION_ID_MAX_LENGTH),
  workspaceId: RuntimeWorkspaceId,
});
export type ConversationReceipt = typeof ConversationReceipt.Type;

export class DurableRuntimeError extends Schema.TaggedErrorClass<DurableRuntimeError>()(
  "DurableRuntimeError",
  {
    reason: Schema.Literals([
      "conflicting-invocation",
      "execution-not-found",
      "invalid-payload",
      "conversation-handler-unavailable",
      "storage-failure",
      "unavailable-action",
    ]),
  }
) {}

const runtimeError = (
  reason: DurableRuntimeError["reason"]
): DurableRuntimeError => DurableRuntimeError.make({ reason });

const RegisteredActionWorkflowFailure = Schema.Struct({
  category: Schema.Literals([
    "action-failed",
    "invalid-result",
    "needs-attention",
  ]),
});

const RegisteredActionActivityOutcome = Schema.Union([
  Schema.TaggedStruct("Success", {
    encodedResult: Schema.String.check(
      Schema.isMaxLength(RUNTIME_PAYLOAD_MAX_BYTES)
    ),
  }),
  Schema.TaggedStruct("Failure", {
    ...RegisteredActionWorkflowFailure.fields,
  }),
]);

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
});
type RegisteredActionWorkflowPayload =
  typeof RegisteredActionWorkflowPayload.Type;

export const RegisteredActionExecutionWorkflow = Workflow.make(
  "Laborer/RegisteredActionExecution/v1",
  {
    error: RegisteredActionWorkflowFailure,
    idempotencyKey: (payload) =>
      createHash("sha256")
        .update("laborer-execution-v1\0", "utf8")
        .update(payload.rootIdentity, "utf8")
        .update("\0", "utf8")
        .update(payload.invocationId, "utf8")
        .digest("base64url"),
    payload: RegisteredActionWorkflowPayload,
    success: Schema.Void,
  }
);

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
});
type ConversationWorkflowPayload = typeof ConversationWorkflowPayload.Type;

const ConversationActivityOutcome = Schema.Union([
  Schema.TaggedStruct("Success", {
    outputs: Schema.Array(ConversationOutput),
  }),
  Schema.TaggedStruct("Failure", {}),
]);

export const ConversationWorkflow = Workflow.make("Laborer/Conversation/v1", {
  error: DurableRuntimeError,
  idempotencyKey: (payload) =>
    createHash("sha256")
      .update("laborer-conversation-event-v1\0", "utf8")
      .update(payload.rootIdentity, "utf8")
      .update("\0", "utf8")
      .update(payload.workspaceId, "utf8")
      .update("\0", "utf8")
      .update(payload.eventId, "utf8")
      .digest("base64url"),
  payload: ConversationWorkflowPayload,
  success: ConversationReceipt,
});

class ActionRegistry extends Context.Service<
  ActionRegistry,
  RegisteredActionCatalog
>()("@laborer/durable-runtime/ActionRegistry") {}

class RootIdentity extends Context.Service<RootIdentity, string>()(
  "@laborer/durable-runtime/RootIdentity"
) {}

export interface ConversationHandler {
  readonly handle: (
    event: ParticipantInputEvent
  ) => Effect.Effect<readonly ApplicationPublicOutput[], unknown>;
}

interface ConversationHandlerRegistryShape {
  readonly get: (
    workspaceId: string
  ) => Effect.Effect<ConversationHandler, DurableRuntimeError>;
  readonly register: (
    workspaceId: string,
    handler: ConversationHandler
  ) => Effect.Effect<void, DurableRuntimeError, import("effect").Scope.Scope>;
  readonly withPermit: <A, E, R>(
    conversationId: string,
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E, R>;
}

class ConversationHandlerRegistry extends Context.Service<
  ConversationHandlerRegistry,
  ConversationHandlerRegistryShape
>()("@laborer/durable-runtime/ConversationHandlerRegistry") {}

const makeConversationHandlerRegistry = Effect.gen(function* () {
  const handlers = new Map<string, ConversationHandler>();
  const handlerWaiters = new Map<
    string,
    Deferred.Deferred<ConversationHandler>
  >();
  const conversationPermits = new Map<string, Semaphore.Semaphore>();
  return ConversationHandlerRegistry.of({
    get: (workspaceId) => {
      const handler = handlers.get(workspaceId);
      if (handler !== undefined) {
        return Effect.succeed(handler);
      }
      let waiter = handlerWaiters.get(workspaceId);
      if (waiter === undefined) {
        waiter = Deferred.makeUnsafe<ConversationHandler>();
        handlerWaiters.set(workspaceId, waiter);
      }
      // Cluster restoration can begin before the workspace Runner has built
      // its ACP application. Waiting here keeps the durable workflow pending
      // instead of permanently failing it during that startup window.
      return Deferred.await(waiter);
    },
    register: (workspaceId, handler) =>
      Effect.acquireRelease(
        Effect.suspend(() => {
          if (handlers.has(workspaceId)) {
            return Effect.fail(
              runtimeError("conversation-handler-unavailable")
            );
          }
          handlers.set(workspaceId, handler);
          let waiter = handlerWaiters.get(workspaceId);
          if (waiter === undefined) {
            waiter = Deferred.makeUnsafe<ConversationHandler>();
            handlerWaiters.set(workspaceId, waiter);
          }
          return Deferred.succeed(waiter, handler).pipe(Effect.asVoid);
        }),
        () =>
          Effect.sync(() => {
            if (handlers.get(workspaceId) === handler) {
              handlers.delete(workspaceId);
              handlerWaiters.delete(workspaceId);
            }
          })
      ),
    withPermit: (conversationId, effect) => {
      let permit = conversationPermits.get(conversationId);
      if (permit === undefined) {
        permit = Semaphore.makeUnsafe(1);
        conversationPermits.set(conversationId, permit);
      }
      return permit.withPermit(effect);
    },
  });
});

const decodeStoredJson = (
  encoded: string
): Effect.Effect<unknown, DurableRuntimeError> =>
  Effect.try({
    catch: () => runtimeError("storage-failure"),
    try: () => JSON.parse(encoded) as unknown,
  });

const boundedPayloadJson = (
  payload: unknown
): Effect.Effect<string, DurableRuntimeError> =>
  canonicalActionInput(payload).pipe(
    Effect.mapError(() => runtimeError("invalid-payload")),
    Effect.filterOrFail(
      (encoded) =>
        Buffer.byteLength(encoded, "utf8") <= RUNTIME_PAYLOAD_MAX_BYTES,
      () => runtimeError("invalid-payload")
    )
  );

const nextEventSequence = Effect.fn("nextExecutionEventSequence")(function* (
  executionId: string
) {
  const sql = yield* SqlClient;
  const rows = yield* sql<{ readonly sequence: number }>`
      SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
      FROM laborer_execution_events
      WHERE execution_id = ${executionId}
    `;
  return pipe(
    rows,
    EffectArray.head,
    Option.map((row) => row.sequence),
    Option.getOrElse(() => 1)
  );
});

const persistEvent = Effect.fn("persistExecutionEvent")(function* (options: {
  readonly conversationId: string;
  readonly executionId: string;
  readonly kind: "progress" | "completed" | "failed";
  readonly payload: unknown;
  readonly progressId?: string;
}) {
  const sql = yield* SqlClient;
  const encodedPayload = yield* boundedPayloadJson(options.payload);
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      // Acquire SQLite's write lock before inspecting event identity or sequence.
      // This keeps concurrent reporters from allocating the same next sequence.
      yield* sql`
        UPDATE laborer_executions
        SET execution_id = execution_id
        WHERE execution_id = ${options.executionId}
      `;
      const stableEventId =
        options.progressId === undefined
          ? undefined
          : `execution:${options.executionId}:progress:${createHash("sha256")
              .update("laborer-execution-progress-v1\0", "utf8")
              .update(options.progressId, "utf8")
              .digest("base64url")}`;
      if (stableEventId !== undefined) {
        const existing = yield* sql<{
          readonly conversationId: string;
          readonly executionId: string;
          readonly kind: string;
          readonly payloadJson: string;
        }>`
          SELECT
            conversation_id AS conversationId,
            execution_id AS executionId,
            kind,
            payload_json AS payloadJson
          FROM laborer_execution_events
          WHERE event_id = ${stableEventId}
        `;
        const event = pipe(existing, EffectArray.head);
        if (Option.isSome(event)) {
          if (
            event.value.conversationId !== options.conversationId ||
            event.value.executionId !== options.executionId ||
            event.value.kind !== options.kind ||
            event.value.payloadJson !== encodedPayload
          ) {
            return yield* runtimeError("invalid-payload");
          }
          return stableEventId;
        }
      }
      const sequence = yield* nextEventSequence(options.executionId);
      const eventId =
        stableEventId ?? `execution:${options.executionId}:event:${sequence}`;
      yield* sql`
        INSERT INTO laborer_execution_events (
          event_id, execution_id, conversation_id, sequence, kind, payload_json
        ) VALUES (
          ${eventId}, ${options.executionId}, ${options.conversationId},
          ${sequence}, ${options.kind}, ${encodedPayload}
        )
      `;
      yield* sql`
        INSERT INTO laborer_execution_outbox (event_id, acknowledged)
        VALUES (${eventId}, 0)
      `;
      return eventId;
    })
  );
});

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
          boundedPayloadJson(result).pipe(
            Effect.map((encodedResult) => ({
              _tag: "Success" as const,
              encodedResult,
            })),
            Effect.mapError(() => ({ category: "invalid-result" as const }))
          )
        ),
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.interrupt;
          }
          const failure = cause.reasons.find(Cause.isFailReason)?.error;
          return Effect.succeed({
            _tag: "Failure" as const,
            category:
              failure instanceof ActionRegistrationError &&
              failure.reason === "invalid-result"
                ? ("invalid-result" as const)
                : ("action-failed" as const),
          });
        })
      ),
      interruptRetryPolicy:
        action.recoveryPolicy === "idempotent-retry"
          ? undefined
          : Schedule.recurs(0),
      name: "Laborer/RegisteredActionExecution/run/v1",
      success: RegisteredActionActivityOutcome,
    });
    if (activityOutcome._tag === "Failure") {
      return yield* Effect.fail({ category: activityOutcome.category });
    }
    return activityOutcome.encodedResult;
  });

const actionForWorkflowPayload = Effect.fn("actionForWorkflowPayload")(
  function* (payload: RegisteredActionWorkflowPayload) {
    const catalog = yield* ActionRegistry;
    const action = yield* catalog
      .get(payload.actionName, payload.actionRevision)
      .pipe(Effect.mapError(() => ({ category: "needs-attention" as const })));
    if (action.fingerprint !== payload.actionFingerprint) {
      return yield* Effect.fail({ category: "needs-attention" as const });
    }
    return action;
  }
);

const conversationWorkflowLayer = ConversationWorkflow.toLayer((payload) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const registry = yield* ConversationHandlerRegistry;
    const event = yield* decodeStoredJson(payload.encodedEvent).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(ParticipantInputEvent, {
          onExcessProperty: "error",
        })
      ),
      Effect.mapError(() => runtimeError("storage-failure"))
    );

    // Cluster may schedule accepted events concurrently. Do not let a later
    // sequence race ahead merely because its workflow fiber obtained a permit
    // first; durable Conversation order is defined by the SQL sequence.
    let precedingEventIsRunning = true;
    while (precedingEventIsRunning) {
      const preceding = yield* sql<{ readonly present: number }>`
        SELECT 1 AS present
        FROM laborer_conversation_events
        WHERE conversation_id = ${payload.conversationId}
          AND sequence < ${payload.sequence}
          AND status IN ('accepted', 'running')
        LIMIT 1
      `.pipe(Effect.mapError(() => runtimeError("storage-failure")));
      precedingEventIsRunning = preceding.length > 0;
      if (precedingEventIsRunning) {
        yield* Effect.sleep("25 millis");
      }
    }

    return yield* registry.withPermit(
      payload.conversationId,
      Effect.gen(function* () {
        // Re-read after taking the permit. Concurrent replay of one event must
        // observe the first completion instead of invoking ACP a second time.
        const rows = yield* sql<{
          readonly conversationId: string;
          readonly eventJson: string;
          readonly outputsJson: string | null;
          readonly requestHash: string;
          readonly sequence: number;
          readonly status: string;
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
        `.pipe(Effect.mapError(() => runtimeError("storage-failure")));
        const stored = pipe(rows, EffectArray.head);
        if (
          Option.isNone(stored) ||
          stored.value.conversationId !== payload.conversationId ||
          stored.value.eventJson !== payload.encodedEvent ||
          stored.value.requestHash !== payload.requestHash ||
          stored.value.sequence !== payload.sequence
        ) {
          return yield* runtimeError("storage-failure");
        }
        if (
          stored.value.status === "completed" &&
          stored.value.outputsJson !== null
        ) {
          const outputs = yield* decodeStoredJson(
            stored.value.outputsJson
          ).pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(Schema.Array(ConversationOutput), {
                onExcessProperty: "error",
              })
            ),
            Effect.mapError(() => runtimeError("storage-failure"))
          );
          return ConversationReceipt.make({
            conversationId: payload.conversationId,
            eventId: payload.eventId,
            outputs,
            sequence: payload.sequence,
            sessionId: payload.sessionId,
            workspaceId: payload.workspaceId,
          });
        }
        if (
          stored.value.status !== "accepted" &&
          stored.value.status !== "running"
        ) {
          return yield* runtimeError(
            stored.value.status === "failed"
              ? "conversation-handler-unavailable"
              : "storage-failure"
          );
        }
        yield* sql`
          UPDATE laborer_conversation_events
          SET status = 'running'
          WHERE event_id = ${payload.eventId}
            AND workspace_id = ${payload.workspaceId}
            AND status = 'accepted'
        `.pipe(Effect.mapError(() => runtimeError("storage-failure")));
        const handler = yield* registry.get(payload.workspaceId);
        const outcome = yield* Activity.make({
          execute: handler.handle(event).pipe(
            Effect.flatMap((candidate) =>
              Schema.decodeUnknownEffect(Schema.Array(ConversationOutput), {
                onExcessProperty: "error",
              })(candidate)
            ),
            Effect.flatMap((outputs) =>
              boundedPayloadJson(outputs).pipe(Effect.as(outputs))
            ),
            Effect.map((outputs) => ({ _tag: "Success" as const, outputs })),
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : Effect.succeed({ _tag: "Failure" as const })
            )
          ),
          name: "Laborer/Conversation/respond/v1",
          success: ConversationActivityOutcome,
        });
        if (outcome._tag === "Failure") {
          yield* sql`
            UPDATE laborer_conversation_events
            SET status = 'failed'
            WHERE event_id = ${payload.eventId}
              AND workspace_id = ${payload.workspaceId}
              AND request_hash = ${payload.requestHash}
          `.pipe(Effect.mapError(() => runtimeError("storage-failure")));
          return yield* runtimeError("conversation-handler-unavailable");
        }
        const outputsJson = yield* boundedPayloadJson(outcome.outputs);
        yield* sql`
          UPDATE laborer_conversation_events
          SET status = 'completed', outputs_json = ${outputsJson}
          WHERE event_id = ${payload.eventId}
            AND workspace_id = ${payload.workspaceId}
            AND request_hash = ${payload.requestHash}
        `.pipe(Effect.mapError(() => runtimeError("storage-failure")));
        return ConversationReceipt.make({
          conversationId: payload.conversationId,
          eventId: payload.eventId,
          outputs: outcome.outputs,
          sequence: payload.sequence,
          sessionId: payload.sessionId,
          workspaceId: payload.workspaceId,
        });
      })
    );
  })
);

const workflowHandlerLayer = RegisteredActionExecutionWorkflow.toLayer(
  (payload, executionId) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const statuses = yield* sql<{
        readonly failureCategory: string | null;
        readonly status: string;
      }>`
        SELECT status, failure_category AS failureCategory
        FROM laborer_executions
        WHERE execution_id = ${executionId}
      `.pipe(Effect.orDie);
      const durableExecution = pipe(
        statuses,
        EffectArray.head,
        Option.getOrElse(() => ({ failureCategory: null, status: "missing" }))
      );
      if (
        durableExecution.status === "completed" ||
        durableExecution.status === "cancelled"
      ) {
        return;
      }
      if (durableExecution.status === "failed") {
        if (
          durableExecution.failureCategory !== "action-failed" &&
          durableExecution.failureCategory !== "invalid-result"
        ) {
          return yield* Effect.die(
            new Error("failed Execution has an invalid failure category")
          );
        }
        const category = durableExecution.failureCategory;
        return yield* Effect.fail({ category } as const);
      }
      if (durableExecution.status === "needs-attention") {
        if (durableExecution.failureCategory !== "needs-attention") {
          return yield* Effect.die(
            new Error(
              "needs-attention Execution has an invalid failure category"
            )
          );
        }
        return yield* Effect.fail({ category: "needs-attention" as const });
      }
      if (
        durableExecution.status !== "queued" &&
        durableExecution.status !== "running"
      ) {
        return yield* Effect.die(
          new Error("Execution has an invalid durable status")
        );
      }
      const action = yield* actionForWorkflowPayload(payload);
      if (
        durableExecution.status === "running" &&
        action.recoveryPolicy === "fail-closed"
      ) {
        return yield* Effect.fail({ category: "needs-attention" as const });
      }
      yield* sql`
        UPDATE laborer_executions
        SET status = 'running'
        WHERE execution_id = ${executionId} AND status = 'queued'
      `.pipe(Effect.orDie);
      const context: RegisteredActionContext = {
        conversationId: payload.conversationId,
        executionId,
        reportProgress: (progressId, progress) =>
          Schema.decodeUnknownEffect(RuntimeProgressId)(progressId).pipe(
            Effect.mapError(() => runtimeError("invalid-payload")),
            Effect.flatMap((validatedProgressId) =>
              persistEvent({
                conversationId: payload.conversationId,
                executionId,
                kind: "progress",
                payload: progress,
                progressId: validatedProgressId,
              }).pipe(Effect.provideService(SqlClient, sql))
            ),
            Effect.asVoid
          ),
        rootIdentity: payload.rootIdentity,
      };
      const decodedInput = yield* decodeStoredJson(payload.encodedInput).pipe(
        Effect.orDie
      );
      const encodedResult = yield* executeRegisteredActionActivity(
        action,
        decodedInput,
        context
      );
      const result = yield* decodeStoredJson(encodedResult).pipe(Effect.orDie);
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`
            UPDATE laborer_executions
            SET status = 'completed', result_json = ${encodedResult}
            WHERE execution_id = ${executionId}
          `;
            yield* persistEvent({
              conversationId: payload.conversationId,
              executionId,
              kind: "completed",
              payload: result,
            }).pipe(Effect.provideService(SqlClient, sql));
          })
        )
        .pipe(Effect.orDie);
    }).pipe(
      Effect.catch(
        (failure: {
          readonly category:
            | "action-failed"
            | "invalid-result"
            | "needs-attention";
        }) =>
          Effect.gen(function* () {
            const sql = yield* SqlClient;
            const terminalStatus =
              failure.category === "needs-attention"
                ? "needs-attention"
                : "failed";
            yield* sql
              .withTransaction(
                Effect.gen(function* () {
                  const statuses = yield* sql<{ readonly status: string }>`
                    SELECT status
                    FROM laborer_executions
                    WHERE execution_id = ${executionId}
                  `;
                  const status = pipe(
                    statuses,
                    EffectArray.head,
                    Option.map((row) => row.status),
                    Option.getOrElse(() => "missing")
                  );
                  if (
                    status === "failed" ||
                    status === "needs-attention" ||
                    status === "cancelled"
                  ) {
                    return;
                  }
                  if (status === "completed") {
                    return yield* Effect.die(
                      new Error("completed Execution cannot become failed")
                    );
                  }
                  yield* sql`
                UPDATE laborer_executions
                SET status = ${terminalStatus}, failure_category = ${failure.category}
                WHERE execution_id = ${executionId}
              `;
                  yield* persistEvent({
                    conversationId: payload.conversationId,
                    executionId,
                    kind: "failed",
                    payload: { category: failure.category },
                  }).pipe(Effect.provideService(SqlClient, sql));
                })
              )
              .pipe(Effect.orDie);
            return yield* Effect.fail(failure);
          })
      )
    )
);

const initializeLaborerTables = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`
        CREATE TABLE IF NOT EXISTS laborer_schema_versions (
          component TEXT PRIMARY KEY,
          version INTEGER NOT NULL
        )
      `;
      const versions = yield* sql<{ readonly version: number }>`
        SELECT version
        FROM laborer_schema_versions
        WHERE component = 'runtime'
      `;
      const version = pipe(
        versions,
        EffectArray.head,
        Option.map((row) => row.version)
      );
      if (
        Option.isSome(version) &&
        (version.value < 1 || version.value > RUNTIME_SCHEMA_VERSION)
      ) {
        return yield* Effect.die(
          new Error("incompatible Laborer runtime schema version")
        );
      }
      yield* sql`
        CREATE TABLE IF NOT EXISTS laborer_runtime_metadata (
          root_identity TEXT PRIMARY KEY,
          catalog_fingerprint TEXT NOT NULL
        )
      `;
      yield* sql`
        CREATE TABLE IF NOT EXISTS laborer_conversations (
          conversation_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          session_id TEXT NOT NULL UNIQUE
        )
      `;
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
          UNIQUE (conversation_id, sequence),
          FOREIGN KEY (conversation_id) REFERENCES laborer_conversations(conversation_id)
        )
      `;
      yield* sql`
        CREATE INDEX IF NOT EXISTS laborer_conversation_events_order
        ON laborer_conversation_events (conversation_id, sequence)
      `;
      yield* sql`
        CREATE TABLE IF NOT EXISTS laborer_executions (
          execution_id TEXT PRIMARY KEY,
          invocation_id TEXT NOT NULL UNIQUE,
          conversation_id TEXT NOT NULL,
          action_name TEXT NOT NULL,
          action_revision TEXT NOT NULL,
          action_fingerprint TEXT NOT NULL,
          catalog_fingerprint TEXT NOT NULL,
          input_hash TEXT NOT NULL,
          input_json TEXT NOT NULL,
          status TEXT NOT NULL,
          result_json TEXT,
          failure_category TEXT
        )
      `;
      yield* sql`
        CREATE TABLE IF NOT EXISTS laborer_execution_events (
          event_id TEXT PRIMARY KEY,
          execution_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          kind TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          UNIQUE (execution_id, sequence)
        )
      `;
      yield* sql`
        CREATE TABLE IF NOT EXISTS laborer_execution_outbox (
          outbox_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL UNIQUE,
          acknowledged INTEGER NOT NULL
        )
      `;
      yield* sql`
        CREATE INDEX IF NOT EXISTS laborer_execution_outbox_pending
        ON laborer_execution_outbox (acknowledged, outbox_sequence)
      `;
      yield* sql`
        CREATE INDEX IF NOT EXISTS laborer_execution_events_conversation
        ON laborer_execution_events (conversation_id, event_id)
      `;
      yield* sql`
        INSERT INTO laborer_schema_versions (component, version)
        VALUES ('runtime', ${RUNTIME_SCHEMA_VERSION})
        ON CONFLICT(component) DO UPDATE SET version = excluded.version
      `;
    })
  );
});

const validateRootRegistration = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const catalog = yield* ActionRegistry;
  const rootIdentity = yield* RootIdentity;
  yield* Schema.decodeUnknownEffect(RuntimeRootIdentity)(rootIdentity).pipe(
    Effect.orDie
  );
  const roots = yield* sql<{
    readonly catalogFingerprint: string;
    readonly rootIdentity: string;
  }>`
    SELECT
      root_identity AS rootIdentity,
      catalog_fingerprint AS catalogFingerprint
    FROM laborer_runtime_metadata
  `;
  const existingRoot = pipe(roots, EffectArray.head);
  if (
    roots.length > 1 ||
    (Option.isSome(existingRoot) &&
      existingRoot.value.rootIdentity !== rootIdentity)
  ) {
    return yield* Effect.die(
      new Error("runtime database belongs to a different Laborer root")
    );
  }
  const conversations = yield* sql<{
    readonly conversationId: string;
    readonly sessionId: string;
    readonly workspaceId: string;
  }>`
    SELECT
      conversation_id AS conversationId,
      session_id AS sessionId,
      workspace_id AS workspaceId
    FROM laborer_conversations
  `;
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
  );
  const conversationEvents = yield* sql<{
    readonly conversationId: string;
    readonly eventId: string;
    readonly eventJson: string;
    readonly outputsJson: string | null;
    readonly ownerWorkspaceId: string;
    readonly requestHash: string;
    readonly sequence: number;
    readonly status: string;
    readonly workspaceId: string;
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
      ON conversations.conversation_id = events.conversation_id
    ORDER BY events.conversation_id, events.sequence
  `;
  yield* Effect.forEach(
    conversationEvents,
    (stored) =>
      Effect.gen(function* () {
        const event = yield* decodeStoredJson(stored.eventJson).pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(ParticipantInputEvent, {
              onExcessProperty: "error",
            })
          ),
          Effect.orDie
        );
        const canonicalEvent = yield* boundedPayloadJson(event).pipe(
          Effect.orDie
        );
        const expectedHash = createHash("sha256")
          .update("laborer-conversation-request-v1\0", "utf8")
          .update(canonicalEvent, "utf8")
          .digest("base64url");
        if (
          event.turnId !== stored.eventId ||
          event.conversationId !== stored.conversationId ||
          stored.workspaceId !== stored.ownerWorkspaceId ||
          stored.requestHash !== expectedHash ||
          stored.eventJson !== canonicalEvent ||
          !Number.isSafeInteger(stored.sequence) ||
          stored.sequence < 1 ||
          (stored.status !== "accepted" &&
            stored.status !== "running" &&
            stored.status !== "failed" &&
            stored.status !== "completed") ||
          (stored.status === "completed") !== (stored.outputsJson !== null)
        ) {
          return yield* Effect.die(
            new Error("invalid durable Conversation event")
          );
        }
        if (stored.outputsJson !== null) {
          const outputs = yield* decodeStoredJson(stored.outputsJson).pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(Schema.Array(ConversationOutput), {
                onExcessProperty: "error",
              })
            ),
            Effect.orDie
          );
          const canonicalOutputs = yield* boundedPayloadJson(outputs).pipe(
            Effect.orDie
          );
          if (canonicalOutputs !== stored.outputsJson) {
            return yield* Effect.die(
              new Error("invalid durable Conversation output")
            );
          }
        }
      }),
    { discard: true }
  );
  const nonterminal = yield* sql<{
    readonly actionFingerprint: string;
    readonly actionName: string;
    readonly actionRevision: string;
  }>`
    SELECT DISTINCT
      action_name AS actionName,
      action_revision AS actionRevision,
      action_fingerprint AS actionFingerprint
    FROM laborer_executions
    WHERE status IN ('queued', 'running', 'needs-attention')
  `;
  yield* Effect.forEach(
    nonterminal,
    (execution) =>
      catalog.get(execution.actionName, execution.actionRevision).pipe(
        Effect.filterOrFail(
          (action) => action.fingerprint === execution.actionFingerprint,
          () => ActionRegistrationError.make({ reason: "unavailable-revision" })
        ),
        Effect.catch(() =>
          Effect.die(
            new Error(
              "nonterminal Execution requires an unavailable Action revision"
            )
          )
        )
      ),
    { discard: true }
  );
  yield* sql`
    INSERT INTO laborer_runtime_metadata (root_identity, catalog_fingerprint)
    VALUES (${rootIdentity}, ${catalog.fingerprint})
    ON CONFLICT(root_identity) DO UPDATE
      SET catalog_fingerprint = excluded.catalog_fingerprint
  `;
});

interface StoredExecutionRow {
  readonly actionFingerprint: string;
  readonly actionName: string;
  readonly actionRevision: string;
  readonly catalogFingerprint: string;
  readonly conversationId: string;
  readonly executionId: string;
  readonly failureCategory: string | null;
  readonly inputHash: string;
  readonly inputJson: string;
  readonly invocationId: string;
  readonly resultJson: string | null;
  readonly status: string;
}

const executionSelect = `
  SELECT
    execution_id AS executionId,
    invocation_id AS invocationId,
    conversation_id AS conversationId,
    action_name AS actionName,
    action_revision AS actionRevision,
    action_fingerprint AS actionFingerprint,
    catalog_fingerprint AS catalogFingerprint,
    input_hash AS inputHash,
    input_json AS inputJson,
    status,
    result_json AS resultJson,
    failure_category AS failureCategory
  FROM laborer_executions
`;

const snapshotFromRow = (
  row: StoredExecutionRow
): Effect.Effect<ExecutionSnapshot, DurableRuntimeError> =>
  Effect.gen(function* () {
    const result =
      row.resultJson === null ? null : yield* decodeStoredJson(row.resultJson);
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
    }).pipe(Effect.mapError(() => runtimeError("storage-failure")));
  });

export interface RootDurableRuntimeShape {
  readonly acknowledgeEvent: (
    eventId: string,
    conversationId: string
  ) => Effect.Effect<void, DurableRuntimeError>;
  readonly getExecution: (
    executionId: string,
    conversationId: string
  ) => Effect.Effect<ExecutionSnapshot, DurableRuntimeError>;
  readonly pendingEvents: (
    conversationId: string,
    limit?: number
  ) => Effect.Effect<readonly ExecutionEvent[], DurableRuntimeError>;
  readonly registerConversationHandler: (
    workspaceId: string,
    handler: ConversationHandler
  ) => Effect.Effect<void, DurableRuntimeError, import("effect").Scope.Scope>;
  readonly runConversation: (
    request: RunConversationRequest
  ) => Effect.Effect<ConversationReceipt, DurableRuntimeError>;
  readonly startExecution: (
    request: StartExecutionRequest
  ) => Effect.Effect<ExecutionSnapshot, DurableRuntimeError>;
}

export class RootDurableRuntime extends Context.Service<
  RootDurableRuntime,
  RootDurableRuntimeShape
>()("@laborer/durable-runtime/RootDurableRuntime") {}

const makeRuntimeService = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const catalog = yield* ActionRegistry;
  const rootIdentity = yield* RootIdentity;
  const conversationHandlers = yield* ConversationHandlerRegistry;
  const workflowEngine = yield* WorkflowEngine.WorkflowEngine;

  const runConversation = Effect.fn("RootDurableRuntime.runConversation")(
    function* (request: RunConversationRequest) {
      const validatedRequest = yield* Schema.decodeUnknownEffect(
        RunConversationRequest,
        { onExcessProperty: "error" }
      )(request).pipe(Effect.mapError(() => runtimeError("invalid-payload")));
      if (validatedRequest.rootIdentity !== rootIdentity) {
        return yield* runtimeError("invalid-payload");
      }
      const eventJson = yield* boundedPayloadJson(validatedRequest.event);
      const requestHash = createHash("sha256")
        .update("laborer-conversation-request-v1\0", "utf8")
        .update(eventJson, "utf8")
        .digest("base64url");
      const sessionId = `conversation:${createHash("sha256")
        .update("laborer-conversation-session-v1\0", "utf8")
        .update(rootIdentity, "utf8")
        .update("\0", "utf8")
        .update(validatedRequest.workspaceId, "utf8")
        .update("\0", "utf8")
        .update(validatedRequest.event.conversationId, "utf8")
        .digest("base64url")}`;
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
            `;
            // Acquire the Conversation's SQLite write lock before allocating
            // its next durable event sequence.
            yield* sql`
              UPDATE laborer_conversations
              SET conversation_id = conversation_id
              WHERE conversation_id = ${validatedRequest.event.conversationId}
            `;
            const conversations = yield* sql<{
              readonly sessionId: string;
              readonly workspaceId: string;
            }>`
              SELECT session_id AS sessionId, workspace_id AS workspaceId
              FROM laborer_conversations
              WHERE conversation_id = ${validatedRequest.event.conversationId}
            `;
            const conversation = pipe(
              conversations,
              EffectArray.head,
              Option.getOrElse(() => ({ sessionId: "", workspaceId: "" }))
            );
            if (
              conversation.workspaceId !== validatedRequest.workspaceId ||
              conversation.sessionId !== sessionId
            ) {
              return yield* runtimeError("invalid-payload");
            }
            const existing = yield* sql<{
              readonly conversationId: string;
              readonly eventJson: string;
              readonly requestHash: string;
              readonly sequence: number;
              readonly sessionId: string;
              readonly workspaceId: string;
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
                ON conversations.conversation_id = events.conversation_id
              WHERE events.event_id = ${validatedRequest.event.turnId}
                AND events.workspace_id = ${validatedRequest.workspaceId}
            `;
            const existingEvent = pipe(existing, EffectArray.head);
            if (Option.isSome(existingEvent)) {
              if (
                existingEvent.value.conversationId !==
                  validatedRequest.event.conversationId ||
                existingEvent.value.workspaceId !==
                  validatedRequest.workspaceId ||
                existingEvent.value.requestHash !== requestHash ||
                existingEvent.value.eventJson !== eventJson
              ) {
                return yield* runtimeError("invalid-payload");
              }
              return existingEvent.value;
            }
            const sequences = yield* sql<{ readonly sequence: number }>`
              SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
              FROM laborer_conversation_events
              WHERE conversation_id = ${validatedRequest.event.conversationId}
            `;
            const sequence = pipe(
              sequences,
              EffectArray.head,
              Option.map((row) => row.sequence),
              Option.getOrElse(() => 1)
            );
            yield* sql`
              INSERT INTO laborer_conversation_events (
                event_id, conversation_id, workspace_id, sequence,
                request_hash, event_json, status
              ) VALUES (
                ${validatedRequest.event.turnId},
                ${validatedRequest.event.conversationId},
                ${validatedRequest.workspaceId}, ${sequence}, ${requestHash},
                ${eventJson}, 'accepted'
              )
            `;
            return {
              conversationId: validatedRequest.event.conversationId,
              eventJson,
              requestHash,
              sequence,
              sessionId,
              workspaceId: validatedRequest.workspaceId,
            };
          })
        )
        .pipe(Effect.mapError(() => runtimeError("storage-failure")));
      const payload: ConversationWorkflowPayload = {
        conversationId: accepted.conversationId,
        encodedEvent: accepted.eventJson,
        eventId: validatedRequest.event.turnId,
        requestHash: accepted.requestHash,
        rootIdentity,
        sequence: accepted.sequence,
        sessionId: accepted.sessionId,
        workspaceId: accepted.workspaceId,
      };
      yield* Effect.uninterruptible(
        ConversationWorkflow.execute(payload, { discard: true }).pipe(
          Effect.provideService(WorkflowEngine.WorkflowEngine, workflowEngine)
        )
      );
      return yield* ConversationWorkflow.execute(payload, {
        discard: false,
      }).pipe(
        Effect.provideService(WorkflowEngine.WorkflowEngine, workflowEngine)
      );
    }
  );

  const getExecution = Effect.fn("RootDurableRuntime.getExecution")(function* (
    executionId: string,
    conversationId: string
  ) {
    const validatedExecutionId = yield* Schema.decodeUnknownEffect(
      RuntimeExecutionId
    )(executionId).pipe(Effect.mapError(() => runtimeError("invalid-payload")));
    const validatedConversationId = yield* Schema.decodeUnknownEffect(
      RuntimeConversationId
    )(conversationId).pipe(
      Effect.mapError(() => runtimeError("invalid-payload"))
    );
    const rows = yield* sql
      .unsafe<StoredExecutionRow>(
        `${executionSelect} WHERE execution_id = ? AND conversation_id = ?`,
        [validatedExecutionId, validatedConversationId]
      )
      .pipe(Effect.mapError(() => runtimeError("storage-failure")));
    const row = yield* pipe(
      rows,
      EffectArray.head,
      Option.match({
        onNone: () => Effect.fail(runtimeError("execution-not-found")),
        onSome: Effect.succeed,
      })
    );
    return yield* snapshotFromRow(row);
  });

  const startExecution = Effect.fn("RootDurableRuntime.startExecution")(
    function* (request: StartExecutionRequest) {
      const validatedRequest = yield* Schema.decodeUnknownEffect(
        StartExecutionRequest,
        { onExcessProperty: "error" }
      )(request).pipe(Effect.mapError(() => runtimeError("invalid-payload")));
      if (validatedRequest.rootIdentity !== rootIdentity) {
        return yield* runtimeError("conflicting-invocation");
      }
      const action = yield* catalog
        .get(validatedRequest.actionName)
        .pipe(Effect.mapError(() => runtimeError("unavailable-action")));
      yield* action
        .decodeInput(validatedRequest.input)
        .pipe(Effect.mapError(() => runtimeError("invalid-payload")));
      const encodedInput = yield* boundedPayloadJson(validatedRequest.input);
      const inputHash = createHash("sha256")
        .update(encodedInput, "utf8")
        .digest("base64url");
      const payload: RegisteredActionWorkflowPayload = {
        actionFingerprint: action.fingerprint,
        actionName: action.name,
        actionRevision: action.revision,
        catalogFingerprint: catalog.fingerprint,
        conversationId: validatedRequest.conversationId,
        encodedInput,
        invocationId: validatedRequest.invocationId,
        rootIdentity: validatedRequest.rootIdentity,
      };
      const executionId =
        yield* RegisteredActionExecutionWorkflow.executionId(payload);
      const acceptedRow = yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const row = yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql`
                INSERT OR IGNORE INTO laborer_executions (
                  execution_id, invocation_id, conversation_id, action_name,
                  action_revision, action_fingerprint, catalog_fingerprint,
                  input_hash, input_json, status
                ) VALUES (
                  ${executionId}, ${validatedRequest.invocationId},
                  ${validatedRequest.conversationId}, ${action.name}, ${action.revision},
                  ${action.fingerprint}, ${catalog.fingerprint}, ${inputHash},
                  ${encodedInput}, 'queued'
                )
              `;
                const rows = yield* sql.unsafe<StoredExecutionRow>(
                  `${executionSelect} WHERE invocation_id = ?`,
                  [validatedRequest.invocationId]
                );
                return yield* pipe(
                  rows,
                  EffectArray.head,
                  Option.match({
                    onNone: () =>
                      Effect.die(
                        new Error("accepted Execution was not durable")
                      ),
                    onSome: Effect.succeed,
                  })
                );
              })
            )
            .pipe(Effect.mapError(() => runtimeError("storage-failure")));
          if (
            row.inputHash !== inputHash ||
            row.actionName !== action.name ||
            row.actionRevision !== action.revision ||
            row.actionFingerprint !== action.fingerprint ||
            row.conversationId !== validatedRequest.conversationId ||
            row.executionId !== executionId
          ) {
            return yield* runtimeError("conflicting-invocation");
          }
          yield* RegisteredActionExecutionWorkflow.execute(payload, {
            discard: true,
          }).pipe(
            Effect.provideService(WorkflowEngine.WorkflowEngine, workflowEngine)
          );
          return row;
        })
      );
      return yield* getExecution(
        acceptedRow.executionId,
        validatedRequest.conversationId
      );
    }
  );

  const pendingEvents = Effect.fn("RootDurableRuntime.pendingEvents")(
    function* (conversationId: string, requestedLimit = 32) {
      const validatedConversationId = yield* Schema.decodeUnknownEffect(
        RuntimeConversationId
      )(conversationId).pipe(
        Effect.mapError(() => runtimeError("invalid-payload"))
      );
      if (
        !Number.isSafeInteger(requestedLimit) ||
        requestedLimit < 1 ||
        requestedLimit > 128
      ) {
        return yield* runtimeError("invalid-payload");
      }
      const limit = requestedLimit;
      const rows = yield* sql<{
        readonly conversationId: string;
        readonly eventId: string;
        readonly executionId: string;
        readonly kind: string;
        readonly payloadJson: string;
        readonly sequence: number;
      }>`
        SELECT
          events.event_id AS eventId,
          events.execution_id AS executionId,
          events.conversation_id AS conversationId,
          events.sequence,
          events.kind,
          events.payload_json AS payloadJson
        FROM laborer_execution_outbox AS outbox
        INNER JOIN laborer_execution_events AS events
          ON events.event_id = outbox.event_id
        WHERE outbox.acknowledged = 0
          AND events.conversation_id = ${validatedConversationId}
        ORDER BY outbox.outbox_sequence
        LIMIT ${limit}
      `.pipe(Effect.mapError(() => runtimeError("storage-failure")));
      return yield* Effect.forEach(rows, (row) =>
        Effect.gen(function* () {
          const payload = yield* decodeStoredJson(row.payloadJson);
          return yield* Schema.decodeUnknownEffect(ExecutionEvent)({
            conversationId: row.conversationId,
            eventId: row.eventId,
            executionId: row.executionId,
            kind: row.kind,
            payload,
            sequence: row.sequence,
          }).pipe(Effect.mapError(() => runtimeError("storage-failure")));
        })
      );
    }
  );

  const acknowledgeEvent = Effect.fn("RootDurableRuntime.acknowledgeEvent")(
    function* (eventId: string, conversationId: string) {
      const validatedEventId = yield* Schema.decodeUnknownEffect(
        RuntimeEventId
      )(eventId).pipe(Effect.mapError(() => runtimeError("invalid-payload")));
      const validatedConversationId = yield* Schema.decodeUnknownEffect(
        RuntimeConversationId
      )(conversationId).pipe(
        Effect.mapError(() => runtimeError("invalid-payload"))
      );
      yield* sql`
        UPDATE laborer_execution_outbox
        SET acknowledged = 1
        WHERE event_id = ${validatedEventId}
          AND EXISTS (
            SELECT 1
            FROM laborer_execution_events AS events
            WHERE events.event_id = laborer_execution_outbox.event_id
              AND events.conversation_id = ${validatedConversationId}
          )
      `.pipe(Effect.mapError(() => runtimeError("storage-failure")));
    }
  );

  const queued = yield* sql.unsafe<StoredExecutionRow>(
    `${executionSelect} WHERE status = 'queued' ORDER BY execution_id`
  );
  yield* Effect.forEach(
    queued,
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
        },
        { discard: true }
      ).pipe(
        Effect.provideService(WorkflowEngine.WorkflowEngine, workflowEngine)
      ),
    { discard: true }
  );

  return {
    acknowledgeEvent,
    getExecution,
    pendingEvents,
    registerConversationHandler: (workspaceId, handler) =>
      Schema.decodeUnknownEffect(RuntimeWorkspaceId)(workspaceId).pipe(
        Effect.mapError(() => runtimeError("invalid-payload")),
        Effect.flatMap((validatedWorkspaceId) =>
          conversationHandlers.register(validatedWorkspaceId, handler)
        )
      ),
    runConversation,
    startExecution,
  } satisfies RootDurableRuntimeShape;
});

const clusterLayer = ClusterWorkflowEngine.layer.pipe(
  Layer.provideMerge(
    SingleRunner.layer({
      runnerStorage: "sql",
      shardingConfig: {
        entityMessagePollInterval: 10,
        entityReplyPollInterval: 10,
        entityTerminationTimeout: 100,
        refreshAssignmentsInterval: 10,
        sendRetryInterval: 10,
      },
    })
  )
);

export const makeRootDurableRuntimeLayer = (
  sqliteLayer: Layer.Layer<SqlClient, unknown>,
  catalog: RegisteredActionCatalog,
  rootIdentity: string
) => {
  const registryLayer = Layer.succeed(ActionRegistry, catalog);
  const conversationRegistryLayer = Layer.effect(
    ConversationHandlerRegistry,
    makeConversationHandlerRegistry
  );
  const rootIdentityLayer = Layer.succeed(RootIdentity, rootIdentity);
  const migrationsLayer = Layer.effectDiscard(initializeLaborerTables).pipe(
    Layer.provide(sqliteLayer)
  );
  const registrationLayer = Layer.effectDiscard(validateRootRegistration).pipe(
    Layer.provideMerge(registryLayer),
    Layer.provideMerge(rootIdentityLayer),
    Layer.provideMerge(sqliteLayer),
    Layer.provideMerge(migrationsLayer)
  );
  const workflowLayer = Layer.merge(
    workflowHandlerLayer,
    conversationWorkflowLayer
  ).pipe(
    Layer.provideMerge(clusterLayer),
    Layer.provideMerge(registryLayer),
    Layer.provideMerge(conversationRegistryLayer),
    Layer.provideMerge(rootIdentityLayer),
    Layer.provideMerge(sqliteLayer),
    Layer.provideMerge(migrationsLayer),
    Layer.provideMerge(registrationLayer)
  );
  return Layer.effect(RootDurableRuntime, makeRuntimeService).pipe(
    Layer.provideMerge(workflowLayer),
    Layer.provideMerge(registryLayer),
    Layer.provideMerge(conversationRegistryLayer),
    Layer.provideMerge(rootIdentityLayer),
    Layer.provideMerge(sqliteLayer),
    Layer.provideMerge(migrationsLayer),
    Layer.provideMerge(registrationLayer)
  );
};
