import { createHash } from "node:crypto";
import {
  Context,
  Effect,
  Array as EffectArray,
  Layer,
  Option,
  pipe,
  Schema,
} from "effect";
import { ClusterWorkflowEngine, SingleRunner } from "effect/unstable/cluster";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { Workflow, WorkflowEngine } from "effect/unstable/workflow";
import { canonicalActionInput } from "../action-catalog.ts";
import type {
  RegisteredActionCatalog,
  RegisteredActionContext,
} from "./action.ts";

const RUNTIME_SCHEMA_VERSION = 1;
const EVENT_PAYLOAD_MAX_BYTES = 64 * 1024;

const NonBlankString = Schema.String.check(Schema.isPattern(/\S/));
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
  actionName: NonBlankString,
  conversationId: NonBlankString,
  input: Schema.Unknown,
  invocationId: NonBlankString,
  rootIdentity: NonBlankString,
});
export type StartExecutionRequest = typeof StartExecutionRequest.Type;

export const ExecutionSnapshot = Schema.Struct({
  actionName: Schema.String,
  actionRevision: Schema.String,
  catalogFingerprint: Schema.String,
  conversationId: Schema.String,
  executionId: Schema.String,
  failureCategory: Schema.NullOr(Schema.String),
  invocationId: Schema.String,
  result: Schema.NullOr(Schema.Unknown),
  status: ExecutionStatus,
});
export type ExecutionSnapshot = typeof ExecutionSnapshot.Type;

export const ExecutionEvent = Schema.Struct({
  conversationId: Schema.String,
  eventId: Schema.String,
  executionId: Schema.String,
  kind: Schema.Literals(["progress", "completed", "failed"]),
  payload: Schema.Unknown,
  sequence: Schema.Number,
});
export type ExecutionEvent = typeof ExecutionEvent.Type;

export class DurableRuntimeError extends Schema.TaggedErrorClass<DurableRuntimeError>()(
  "DurableRuntimeError",
  {
    reason: Schema.Literals([
      "conflicting-invocation",
      "execution-not-found",
      "invalid-payload",
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

const RegisteredActionWorkflowPayload = Schema.Struct({
  actionName: Schema.String,
  actionRevision: Schema.String,
  catalogFingerprint: Schema.String,
  conversationId: Schema.String,
  encodedInput: Schema.String,
  invocationId: Schema.String,
  rootIdentity: Schema.String,
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

class ActionRegistry extends Context.Service<
  ActionRegistry,
  RegisteredActionCatalog
>()("@laborer/durable-runtime/ActionRegistry") {}

class RootIdentity extends Context.Service<RootIdentity, string>()(
  "@laborer/durable-runtime/RootIdentity"
) {}

const decodeJson = (encoded: string): unknown => JSON.parse(encoded) as unknown;

const boundedPayloadJson = (
  payload: unknown
): Effect.Effect<string, DurableRuntimeError> =>
  canonicalActionInput(payload).pipe(
    Effect.mapError(() => runtimeError("invalid-payload")),
    Effect.filterOrFail(
      (encoded) =>
        Buffer.byteLength(encoded, "utf8") <= EVENT_PAYLOAD_MAX_BYTES,
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
}) {
  const sql = yield* SqlClient;
  const encodedPayload = yield* boundedPayloadJson(options.payload);
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const sequence = yield* nextEventSequence(options.executionId);
      const eventId = `execution:${options.executionId}:event:${sequence}`;
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

const workflowHandlerLayer = RegisteredActionExecutionWorkflow.toLayer(
  (payload, executionId) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const catalog = yield* ActionRegistry;
      const action = yield* catalog
        .get(payload.actionName, payload.actionRevision)
        .pipe(
          Effect.mapError(() => ({
            category: "action-failed" as const,
          }))
        );
      const statuses = yield* sql<{ readonly status: string }>`
        SELECT status
        FROM laborer_executions
        WHERE execution_id = ${executionId}
      `.pipe(Effect.orDie);
      const durableStatus = pipe(
        statuses,
        EffectArray.head,
        Option.map((row) => row.status),
        Option.getOrElse(() => "missing")
      );
      if (
        durableStatus === "running" &&
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
        reportProgress: (progress) =>
          persistEvent({
            conversationId: payload.conversationId,
            executionId,
            kind: "progress",
            payload: progress,
          }).pipe(
            Effect.provideService(SqlClient, sql),
            Effect.orDie,
            Effect.asVoid
          ),
        rootIdentity: payload.rootIdentity,
      };
      const result = yield* action
        .execute(decodeJson(payload.encodedInput), context)
        .pipe(
          Effect.flatMap(action.decodeResult),
          Effect.mapError(() => ({ category: "action-failed" as const }))
        );
      const encodedResult = yield* boundedPayloadJson(result).pipe(
        Effect.mapError(() => ({ category: "invalid-result" as const }))
      );
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
      yield* sql`
        CREATE TABLE IF NOT EXISTS laborer_runtime_metadata (
          root_identity TEXT PRIMARY KEY,
          catalog_fingerprint TEXT NOT NULL
        )
      `;
      yield* sql`
        CREATE TABLE IF NOT EXISTS laborer_executions (
          execution_id TEXT PRIMARY KEY,
          invocation_id TEXT NOT NULL UNIQUE,
          conversation_id TEXT NOT NULL,
          action_name TEXT NOT NULL,
          action_revision TEXT NOT NULL,
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
        INSERT INTO laborer_schema_versions (component, version)
        VALUES ('runtime', ${RUNTIME_SCHEMA_VERSION})
        ON CONFLICT(component) DO NOTHING
      `;
    })
  );
  const versions = yield* sql<{ readonly version: number }>`
    SELECT version FROM laborer_schema_versions WHERE component = 'runtime'
  `;
  const version = pipe(
    versions,
    EffectArray.head,
    Option.map((row) => row.version),
    Option.getOrElse(() => -1)
  );
  if (version !== RUNTIME_SCHEMA_VERSION) {
    return yield* Effect.die(
      new Error("incompatible Laborer runtime schema version")
    );
  }
});

const validateRootRegistration = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const catalog = yield* ActionRegistry;
  const rootIdentity = yield* RootIdentity;
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
    Option.isSome(existingRoot) &&
    existingRoot.value.rootIdentity !== rootIdentity
  ) {
    return yield* Effect.die(
      new Error("runtime database belongs to a different Laborer root")
    );
  }
  const nonterminal = yield* sql<{
    readonly actionName: string;
    readonly actionRevision: string;
  }>`
    SELECT DISTINCT
      action_name AS actionName,
      action_revision AS actionRevision
    FROM laborer_executions
    WHERE status IN ('queued', 'running', 'needs-attention')
  `;
  yield* Effect.forEach(
    nonterminal,
    (execution) =>
      catalog
        .get(execution.actionName, execution.actionRevision)
        .pipe(
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
  Schema.decodeUnknownEffect(ExecutionSnapshot)({
    actionName: row.actionName,
    actionRevision: row.actionRevision,
    catalogFingerprint: row.catalogFingerprint,
    conversationId: row.conversationId,
    executionId: row.executionId,
    failureCategory: row.failureCategory,
    invocationId: row.invocationId,
    result: row.resultJson === null ? null : decodeJson(row.resultJson),
    status: row.status,
  }).pipe(Effect.mapError(() => runtimeError("storage-failure")));

export interface RootDurableRuntimeShape {
  readonly acknowledgeEvent: (
    eventId: string
  ) => Effect.Effect<void, DurableRuntimeError>;
  readonly getExecution: (
    executionId: string
  ) => Effect.Effect<ExecutionSnapshot, DurableRuntimeError>;
  readonly pendingEvents: (
    conversationId: string,
    limit?: number
  ) => Effect.Effect<readonly ExecutionEvent[], DurableRuntimeError>;
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
  const workflowEngine = yield* WorkflowEngine.WorkflowEngine;

  const getExecution = Effect.fn("RootDurableRuntime.getExecution")(function* (
    executionId: string
  ) {
    const rows = yield* sql
      .unsafe<StoredExecutionRow>(`${executionSelect} WHERE execution_id = ?`, [
        executionId,
      ])
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
      if (request.rootIdentity !== rootIdentity) {
        return yield* runtimeError("conflicting-invocation");
      }
      const action = yield* catalog
        .get(request.actionName)
        .pipe(Effect.mapError(() => runtimeError("unavailable-action")));
      const input = yield* action
        .decodeInput(request.input)
        .pipe(Effect.mapError(() => runtimeError("invalid-payload")));
      const encodedInput = yield* canonicalActionInput(input).pipe(
        Effect.mapError(() => runtimeError("invalid-payload"))
      );
      const inputHash = createHash("sha256")
        .update(encodedInput, "utf8")
        .digest("base64url");
      const payload: RegisteredActionWorkflowPayload = {
        actionName: action.name,
        actionRevision: action.revision,
        catalogFingerprint: catalog.fingerprint,
        conversationId: request.conversationId,
        encodedInput,
        invocationId: request.invocationId,
        rootIdentity: request.rootIdentity,
      };
      const executionId =
        yield* RegisteredActionExecutionWorkflow.executionId(payload);
      const acceptedRow = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT OR IGNORE INTO laborer_executions (
                execution_id, invocation_id, conversation_id, action_name,
                action_revision, catalog_fingerprint, input_hash, input_json,
                status
              ) VALUES (
                ${executionId}, ${request.invocationId},
                ${request.conversationId}, ${action.name}, ${action.revision},
                ${catalog.fingerprint}, ${inputHash}, ${encodedInput}, 'queued'
              )
            `;
            const rows = yield* sql.unsafe<StoredExecutionRow>(
              `${executionSelect} WHERE invocation_id = ?`,
              [request.invocationId]
            );
            return yield* pipe(
              rows,
              EffectArray.head,
              Option.match({
                onNone: () =>
                  Effect.die(new Error("accepted Execution was not durable")),
                onSome: Effect.succeed,
              })
            );
          })
        )
        .pipe(Effect.mapError(() => runtimeError("storage-failure")));
      if (
        acceptedRow.inputHash !== inputHash ||
        acceptedRow.actionName !== action.name ||
        acceptedRow.actionRevision !== action.revision ||
        acceptedRow.conversationId !== request.conversationId ||
        acceptedRow.executionId !== executionId
      ) {
        return yield* runtimeError("conflicting-invocation");
      }
      yield* RegisteredActionExecutionWorkflow.execute(payload, {
        discard: true,
      }).pipe(
        Effect.provideService(WorkflowEngine.WorkflowEngine, workflowEngine)
      );
      return yield* getExecution(executionId);
    }
  );

  const pendingEvents = Effect.fn("RootDurableRuntime.pendingEvents")(
    function* (conversationId: string, requestedLimit = 32) {
      const limit = Math.max(1, Math.min(128, Math.floor(requestedLimit)));
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
          AND events.conversation_id = ${conversationId}
        ORDER BY outbox.outbox_sequence
        LIMIT ${limit}
      `.pipe(Effect.mapError(() => runtimeError("storage-failure")));
      return yield* Effect.forEach(rows, (row) =>
        Schema.decodeUnknownEffect(ExecutionEvent)({
          conversationId: row.conversationId,
          eventId: row.eventId,
          executionId: row.executionId,
          kind: row.kind,
          payload: decodeJson(row.payloadJson),
          sequence: row.sequence,
        }).pipe(Effect.mapError(() => runtimeError("storage-failure")))
      );
    }
  );

  const acknowledgeEvent = Effect.fn("RootDurableRuntime.acknowledgeEvent")(
    function* (eventId: string) {
      yield* sql`
        UPDATE laborer_execution_outbox
        SET acknowledged = 1
        WHERE event_id = ${eventId}
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
  const workflowLayer = workflowHandlerLayer.pipe(
    Layer.provideMerge(clusterLayer),
    Layer.provideMerge(registryLayer),
    Layer.provideMerge(rootIdentityLayer),
    Layer.provideMerge(sqliteLayer),
    Layer.provideMerge(migrationsLayer),
    Layer.provideMerge(registrationLayer)
  );
  return Layer.effect(RootDurableRuntime, makeRuntimeService).pipe(
    Layer.provideMerge(workflowLayer),
    Layer.provideMerge(registryLayer),
    Layer.provideMerge(rootIdentityLayer),
    Layer.provideMerge(sqliteLayer),
    Layer.provideMerge(migrationsLayer),
    Layer.provideMerge(registrationLayer)
  );
};
