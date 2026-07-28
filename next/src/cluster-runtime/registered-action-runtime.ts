import { createHash } from "node:crypto";
import {
  Cause,
  Context,
  Effect,
  Array as EffectArray,
  Exit,
  Layer,
  Option,
  Schema,
} from "effect";
import { ClusterWorkflowEngine, SingleRunner } from "effect/unstable/cluster";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { Activity, Workflow, WorkflowEngine } from "effect/unstable/workflow";
import {
  RegisteredActionBoundaryError,
  type RegisteredActionCatalog,
  type RegisteredActionProgress,
  validateDurableActionValue,
} from "./registered-action.ts";

const MAX_RUNTIME_ID_LENGTH = 256;
const MAX_PROGRESS_MESSAGE_LENGTH = 4096;

const BoundedRuntimeId = Schema.NonEmptyString.check(
  Schema.isMaxLength(MAX_RUNTIME_ID_LENGTH)
);
const BoundedStoredJson = Schema.String.check(Schema.isMaxLength(64 * 1024));
const ExecutionStatus = Schema.Literals([
  "queued",
  "running",
  "succeeded",
  "failed",
]);
export type RegisteredExecutionStatus = typeof ExecutionStatus.Type;

const StartRequest = Schema.Struct({
  actionName: Schema.NonEmptyString.check(Schema.isMaxLength(64)),
  conversationId: BoundedRuntimeId,
  input: Schema.Unknown,
  invocationId: BoundedRuntimeId,
});
export type StartRegisteredActionRequest = typeof StartRequest.Type;

const Progress = Schema.Struct({
  details: Schema.optional(Schema.Unknown),
  message: Schema.NonEmptyString.check(
    Schema.isMaxLength(MAX_PROGRESS_MESSAGE_LENGTH)
  ),
});

const ExecutionRow = Schema.Struct({
  actionName: Schema.NonEmptyString.check(Schema.isMaxLength(64)),
  actionRevision: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
  catalogFingerprint: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
  conversationId: BoundedRuntimeId,
  executionId: BoundedRuntimeId,
  failureCode: Schema.NullOr(
    Schema.NonEmptyString.check(Schema.isMaxLength(128))
  ),
  inputJson: BoundedStoredJson,
  inputHash: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
  invocationId: BoundedRuntimeId,
  progressJson: Schema.NullOr(BoundedStoredJson),
  resultJson: Schema.NullOr(BoundedStoredJson),
  status: ExecutionStatus,
});
type ExecutionRow = typeof ExecutionRow.Type;

const NonterminalExecutionRow = Schema.Struct({
  actionName: Schema.NonEmptyString.check(Schema.isMaxLength(64)),
  actionRevision: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
  catalogFingerprint: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
  conversationId: BoundedRuntimeId,
  executionId: BoundedRuntimeId,
  inputHash: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
  inputJson: BoundedStoredJson,
});
const ExecutionClaimState = Schema.Struct({
  actionName: Schema.NonEmptyString.check(Schema.isMaxLength(64)),
  actionRevision: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
  catalogFingerprint: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
  conversationId: BoundedRuntimeId,
  inputHash: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
  inputJson: BoundedStoredJson,
  status: ExecutionStatus,
});

export interface RegisteredExecutionSnapshot {
  readonly actionName: string;
  readonly actionRevision: string;
  readonly catalogFingerprint: string;
  readonly conversationId: string;
  readonly executionId: string;
  readonly failureCode: string | null;
  readonly progress: RegisteredActionProgress | null;
  readonly result: unknown | null;
  readonly status: RegisteredExecutionStatus;
}

export interface ConversationTerminalEvent {
  readonly actionName: string;
  readonly conversationId: string;
  readonly eventId: string;
  readonly executionId: string;
  readonly result: unknown | null;
  readonly status: "failed" | "succeeded";
  readonly version: 1;
}

export class RegisteredActionRuntimeError extends Schema.TaggedErrorClass<RegisteredActionRuntimeError>()(
  "RegisteredActionRuntimeError",
  {
    reason: Schema.Literals([
      "conflict",
      "invalid-input",
      "invalid-request",
      "not-found",
      "registration-unavailable",
      "storage",
      "unknown-action",
    ]),
  }
) {}

const runtimeError = (
  reason: RegisteredActionRuntimeError["reason"]
): RegisteredActionRuntimeError =>
  RegisteredActionRuntimeError.make({ reason });

const RegisteredActionWorkflow = Workflow.make(
  "Laborer/RegisteredActionExecution",
  {
    payload: {
      actionName: Schema.String,
      actionRevision: Schema.String,
      catalogFingerprint: Schema.String,
      conversationId: Schema.String,
      encodedInput: Schema.Unknown,
      executionId: Schema.String,
    },
    idempotencyKey: ({ executionId }) => executionId,
  }
);

const executionIdFor = (scope: {
  readonly conversationId: string;
  readonly invocationId: string;
}): string =>
  `execution:${createHash("sha256")
    .update("laborer-registered-action-execution-v1\0", "utf8")
    .update(scope.conversationId, "utf8")
    .update("\0", "utf8")
    .update(scope.invocationId, "utf8")
    .digest("base64url")}`;

const inputHashFor = (canonicalInput: string): string =>
  createHash("sha256")
    .update("laborer-registered-action-input-v1\0", "utf8")
    .update(canonicalInput, "utf8")
    .digest("base64url");

const claimActionActivity = Effect.fn("claimActionActivity")(function* (
  accepted: {
    readonly actionName: string;
    readonly actionRevision: string;
    readonly catalogFingerprint: string;
    readonly conversationId: string;
    readonly executionId: string;
    readonly inputHash: string;
    readonly inputJson: string;
  },
  idempotentHint: boolean
) {
  const sql = yield* SqlClient;
  yield* sql`
    UPDATE laborer_action_executions
    SET status = 'running'
    WHERE execution_id = ${accepted.executionId}
      AND action_name = ${accepted.actionName}
      AND action_revision = ${accepted.actionRevision}
      AND catalog_fingerprint = ${accepted.catalogFingerprint}
      AND conversation_id = ${accepted.conversationId}
      AND input_hash = ${accepted.inputHash}
      AND input_json = ${accepted.inputJson}
      AND status = 'queued'
  `;
  const changes = yield* sql<{ readonly claimed: number }>`
    SELECT changes() AS claimed
  `;
  if (changes[0]?.claimed === 1) {
    return true;
  }
  const stateRows = yield* sql`
    SELECT
      action_name AS actionName,
      action_revision AS actionRevision,
      catalog_fingerprint AS catalogFingerprint,
      conversation_id AS conversationId,
      input_hash AS inputHash,
      input_json AS inputJson,
      status
    FROM laborer_action_executions
    WHERE execution_id = ${accepted.executionId}
  `;
  const state = yield* EffectArray.head(stateRows).pipe(
    Option.match({
      onNone: () => Effect.die("registered Action row is missing"),
      onSome: (value) =>
        Schema.decodeUnknownEffect(ExecutionClaimState)(value).pipe(
          Effect.orDie
        ),
    })
  );
  if (
    state.actionName !== accepted.actionName ||
    state.actionRevision !== accepted.actionRevision ||
    state.catalogFingerprint !== accepted.catalogFingerprint ||
    state.conversationId !== accepted.conversationId ||
    state.inputHash !== accepted.inputHash ||
    state.inputJson !== accepted.inputJson ||
    state.status !== "running"
  ) {
    return yield* Effect.die("registered Action has an invalid activity state");
  }
  return idempotentHint;
});

const terminalEventId = (executionId: string): string =>
  `${executionId}:terminal`;

const parseStoredJson = (value: string | null): unknown | null => {
  if (value === null) {
    return null;
  }
  return JSON.parse(value) as unknown;
};

const validatedStoredInput = (
  row: Pick<ExecutionRow, "inputHash" | "inputJson">
): Effect.Effect<unknown, RegisteredActionRuntimeError> =>
  Effect.gen(function* () {
    const input = yield* Effect.try({
      try: () => JSON.parse(row.inputJson) as unknown,
      catch: () => runtimeError("storage"),
    });
    yield* validateDurableActionValue(input, "input").pipe(
      Effect.filterOrFail(
        (canonical) =>
          canonical === row.inputJson &&
          inputHashFor(canonical) === row.inputHash,
        () => runtimeError("storage")
      ),
      Effect.mapError(() => runtimeError("storage"))
    );
    return input;
  });

const snapshotFromRow = (
  row: ExecutionRow
): Effect.Effect<RegisteredExecutionSnapshot, RegisteredActionRuntimeError> =>
  Effect.gen(function* () {
    const progress = yield* Effect.try({
      try: () => parseStoredJson(row.progressJson),
      catch: () => runtimeError("storage"),
    });
    let decodedProgress: RegisteredActionProgress | null = null;
    if (progress !== null) {
      decodedProgress = yield* Schema.decodeUnknownEffect(Progress, {
        onExcessProperty: "error",
      })(progress).pipe(Effect.mapError(() => runtimeError("storage")));
      yield* validateDurableActionValue(progress, "progress").pipe(
        Effect.filterOrFail(
          (canonical) => canonical === row.progressJson,
          () => runtimeError("storage")
        ),
        Effect.mapError(() => runtimeError("storage"))
      );
    }
    const result = yield* Effect.try({
      try: () => parseStoredJson(row.resultJson),
      catch: () => runtimeError("storage"),
    });
    if (row.resultJson !== null) {
      yield* validateDurableActionValue(result, "result").pipe(
        Effect.filterOrFail(
          (canonical) => canonical === row.resultJson,
          () => runtimeError("storage")
        ),
        Effect.mapError(() => runtimeError("storage"))
      );
    }
    const validState =
      (row.status === "succeeded" &&
        row.failureCode === null &&
        row.resultJson !== null) ||
      (row.status === "failed" &&
        row.failureCode !== null &&
        row.resultJson === null) ||
      ((row.status === "queued" || row.status === "running") &&
        row.failureCode === null &&
        row.resultJson === null);
    if (!validState) {
      return yield* runtimeError("storage");
    }
    return {
      actionName: row.actionName,
      actionRevision: row.actionRevision,
      catalogFingerprint: row.catalogFingerprint,
      conversationId: row.conversationId,
      executionId: row.executionId,
      failureCode: row.failureCode,
      progress: decodedProgress,
      result,
      status: row.status,
    };
  });

const decodeExecutionRow = (
  value: unknown
): Effect.Effect<ExecutionRow, RegisteredActionRuntimeError> =>
  Schema.decodeUnknownEffect(ExecutionRow)(value).pipe(
    Effect.mapError(() => runtimeError("storage"))
  );

const firstExecutionRow = (
  rows: readonly unknown[],
  missingReason: "not-found" | "storage"
): Effect.Effect<ExecutionRow, RegisteredActionRuntimeError> =>
  EffectArray.head(rows).pipe(
    Option.match({
      onNone: () => Effect.fail(runtimeError(missingReason)),
      onSome: decodeExecutionRow,
    })
  );

export interface RegisteredActionRuntimeShape {
  readonly get: (
    executionId: string
  ) => Effect.Effect<RegisteredExecutionSnapshot, RegisteredActionRuntimeError>;
  readonly privateTools: RegisteredActionCatalog["privateTools"];
  readonly start: (request: unknown) => Effect.Effect<
    {
      readonly deduplicated: boolean;
      readonly executionId: string;
      readonly status: RegisteredExecutionStatus;
    },
    RegisteredActionRuntimeError
  >;
}

export class RegisteredActionRuntime extends Context.Service<
  RegisteredActionRuntime,
  RegisteredActionRuntimeShape
>()("@laborer/cluster-runtime/RegisteredActionRuntime") {}

interface RegisteredActionRuntimeOptions {
  readonly catalog: RegisteredActionCatalog;
  readonly deliverTerminal: (
    event: ConversationTerminalEvent
  ) => Effect.Effect<void>;
}

const workflowLayer = (options: RegisteredActionRuntimeOptions) =>
  RegisteredActionWorkflow.toLayer((payload) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const action = yield* options.catalog
        .require(payload.actionName, payload.actionRevision)
        .pipe(Effect.orDie);
      const inputJson = yield* validateDurableActionValue(
        payload.encodedInput,
        "input"
      ).pipe(Effect.orDie);
      const inputHash = inputHashFor(inputJson);

      const outcome = yield* Activity.make({
        name: "RunRegisteredAction",
        success: Schema.Struct({
          failureCode: Schema.NullOr(Schema.String),
          result: Schema.Unknown,
          status: Schema.Literals(["failed", "succeeded"]),
        }),
        execute: Effect.gen(function* () {
          const mayExecute = yield* claimActionActivity(
            {
              actionName: payload.actionName,
              actionRevision: payload.actionRevision,
              catalogFingerprint: payload.catalogFingerprint,
              conversationId: payload.conversationId,
              executionId: payload.executionId,
              inputHash,
              inputJson,
            },
            action.annotations.idempotentHint
          );
          if (!mayExecute) {
            return {
              failureCode: "action-recovery-required",
              result: null,
              status: "failed" as const,
            };
          }
          const reportProgress = (candidate: RegisteredActionProgress) =>
            Schema.decodeUnknownEffect(Progress, {
              onExcessProperty: "error",
            })(candidate).pipe(
              Effect.mapError(() =>
                RegisteredActionBoundaryError.make({ boundary: "progress" })
              ),
              Effect.flatMap((progress) =>
                validateDurableActionValue(progress, "progress").pipe(
                  Effect.flatMap(
                    (progressJson) => sql`
                    UPDATE laborer_action_executions
                    SET progress_json = ${progressJson}
                    WHERE execution_id = ${payload.executionId}
                      AND status = 'running'
                  `
                  )
                )
              ),
              Effect.asVoid,
              Effect.mapError(() =>
                RegisteredActionBoundaryError.make({ boundary: "progress" })
              )
            );
          const exit = yield* Effect.exit(
            action
              .execute(payload.encodedInput, {
                actionName: payload.actionName,
                actionRevision: payload.actionRevision,
                catalogFingerprint: payload.catalogFingerprint,
                conversationId: payload.conversationId,
                executionId: payload.executionId,
                reportProgress,
              })
              .pipe(
                Effect.flatMap((result) =>
                  validateDurableActionValue(result, "result")
                ),
                Effect.map((resultJson) => JSON.parse(resultJson) as unknown)
              )
          );
          if (Exit.isFailure(exit)) {
            if (Cause.hasInterrupts(exit.cause)) {
              return yield* Effect.failCause(exit.cause);
            }
            return {
              failureCode: "action-failed-or-invalid-output",
              result: null,
              status: "failed" as const,
            };
          }
          return {
            failureCode: null,
            result: exit.value,
            status: "succeeded" as const,
          };
        }).pipe(Effect.orDie),
      });

      const prepareTerminal = (candidate: typeof outcome) => {
        const event: ConversationTerminalEvent = {
          actionName: payload.actionName,
          conversationId: payload.conversationId,
          eventId: terminalEventId(payload.executionId),
          executionId: payload.executionId,
          result: candidate.status === "succeeded" ? candidate.result : null,
          status: candidate.status,
          version: 1,
        };
        return validateDurableActionValue(event, "result").pipe(
          Effect.map((eventJson) => ({ candidate, event, eventJson }))
        );
      };
      const terminal = yield* prepareTerminal(outcome).pipe(
        Effect.catch(() =>
          prepareTerminal({
            failureCode: "action-failed-or-invalid-output",
            result: null,
            status: "failed" as const,
          })
        ),
        Effect.orDie
      );
      const resultJson =
        terminal.candidate.status === "succeeded"
          ? yield* validateDurableActionValue(
              terminal.candidate.result,
              "result"
            ).pipe(Effect.orDie)
          : null;

      yield* Activity.make({
        name: "PersistRegisteredActionTerminal",
        execute: sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`
              UPDATE laborer_action_executions
              SET
                status = ${terminal.candidate.status},
                result_json = ${resultJson},
                failure_code = ${terminal.candidate.failureCode}
              WHERE execution_id = ${payload.executionId}
            `;
              yield* sql`
              INSERT OR IGNORE INTO laborer_execution_terminal_outbox (
                event_id, execution_id, conversation_id, event_json, delivered
              ) VALUES (
                ${terminal.event.eventId}, ${terminal.event.executionId},
                ${terminal.event.conversationId}, ${terminal.eventJson}, 0
              )
            `;
            })
          )
          .pipe(Effect.orDie),
      });

      yield* Activity.make({
        name: "DeliverRegisteredActionTerminal",
        execute: Effect.gen(function* () {
          const pending = yield* sql<{ readonly delivered: number }>`
            SELECT delivered
            FROM laborer_execution_terminal_outbox
            WHERE event_id = ${terminal.event.eventId}
          `;
          if (pending[0]?.delivered === 1) {
            return;
          }
          yield* options.deliverTerminal(terminal.event);
          yield* sql`
            UPDATE laborer_execution_terminal_outbox
            SET delivered = 1
            WHERE event_id = ${terminal.event.eventId}
          `;
        }).pipe(Effect.orDie),
      });
    }).pipe(Effect.orDie)
  );

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

const initializeApplicationTables = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS laborer_action_executions (
      execution_id TEXT PRIMARY KEY,
      invocation_id TEXT NOT NULL UNIQUE,
      conversation_id TEXT NOT NULL,
      action_name TEXT NOT NULL,
      action_revision TEXT NOT NULL,
      catalog_fingerprint TEXT NOT NULL,
      input_json TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('queued', 'running', 'succeeded', 'failed')
      ),
      progress_json TEXT,
      result_json TEXT,
      failure_code TEXT
    ) STRICT
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS laborer_execution_terminal_outbox (
      event_id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL UNIQUE,
      conversation_id TEXT NOT NULL,
      event_json TEXT NOT NULL,
      delivered INTEGER NOT NULL CHECK (delivered IN (0, 1)),
      FOREIGN KEY (execution_id) REFERENCES laborer_action_executions(execution_id)
    ) STRICT
  `;
});

const makeRuntime = (options: RegisteredActionRuntimeOptions) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const engine = yield* WorkflowEngine.WorkflowEngine;
    yield* initializeApplicationTables;

    const nonterminal = yield* sql`
      SELECT
        action_name AS actionName,
        action_revision AS actionRevision,
        catalog_fingerprint AS catalogFingerprint,
        conversation_id AS conversationId,
        execution_id AS executionId,
        input_hash AS inputHash,
        input_json AS inputJson
      FROM laborer_action_executions
      WHERE status IN ('queued', 'running')
    `;
    yield* Effect.forEach(
      nonterminal,
      (untrustedRecord) =>
        Effect.gen(function* () {
          const record = yield* Schema.decodeUnknownEffect(
            NonterminalExecutionRow
          )(untrustedRecord).pipe(
            Effect.mapError(() => runtimeError("storage"))
          );
          const action = yield* options.catalog
            .require(record.actionName, record.actionRevision)
            .pipe(
              Effect.mapError(() => runtimeError("registration-unavailable"))
            );
          const encodedInput = yield* validatedStoredInput(record);
          yield* action
            .decodeInput(encodedInput)
            .pipe(Effect.mapError(() => runtimeError("storage")));
          yield* RegisteredActionWorkflow.execute(
            {
              actionName: record.actionName,
              actionRevision: record.actionRevision,
              catalogFingerprint: record.catalogFingerprint,
              conversationId: record.conversationId,
              encodedInput,
              executionId: record.executionId,
            },
            { discard: true }
          ).pipe(Effect.provideService(WorkflowEngine.WorkflowEngine, engine));
        }),
      { discard: true }
    );

    const get = Effect.fn("RegisteredActionRuntime.get")(function* (
      executionId: string
    ) {
      if (
        executionId.length === 0 ||
        executionId.length > MAX_RUNTIME_ID_LENGTH
      ) {
        return yield* runtimeError("not-found");
      }
      const rows = yield* sql`
        SELECT
          action_name AS actionName,
          action_revision AS actionRevision,
          catalog_fingerprint AS catalogFingerprint,
          conversation_id AS conversationId,
          execution_id AS executionId,
          failure_code AS failureCode,
          input_json AS inputJson,
          input_hash AS inputHash,
          invocation_id AS invocationId,
          progress_json AS progressJson,
          result_json AS resultJson,
          status
        FROM laborer_action_executions
        WHERE execution_id = ${executionId}
      `;
      const row = yield* firstExecutionRow(rows, "not-found");
      return yield* snapshotFromRow(row);
    });

    const start = Effect.fn("RegisteredActionRuntime.start")(function* (
      untrustedRequest: unknown
    ) {
      const request = yield* Schema.decodeUnknownEffect(StartRequest, {
        onExcessProperty: "error",
      })(untrustedRequest).pipe(
        Effect.mapError(() => runtimeError("invalid-request"))
      );
      const action = yield* options.catalog
        .require(request.actionName)
        .pipe(Effect.mapError(() => runtimeError("unknown-action")));
      const preparedInput = yield* action
        .prepareInput(request.input)
        .pipe(Effect.mapError(() => runtimeError("invalid-input")));
      const inputJson = yield* validateDurableActionValue(
        preparedInput,
        "input"
      ).pipe(Effect.mapError(() => runtimeError("invalid-input")));
      const encodedInput = yield* Effect.try({
        try: () => JSON.parse(inputJson) as unknown,
        catch: () => runtimeError("invalid-input"),
      });
      yield* action
        .decodeInput(encodedInput)
        .pipe(Effect.mapError(() => runtimeError("invalid-input")));
      const inputHash = inputHashFor(inputJson);
      const executionId = executionIdFor(request);

      const { inserted, row } = yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
            INSERT OR IGNORE INTO laborer_action_executions (
              execution_id, invocation_id, conversation_id, action_name,
              action_revision, catalog_fingerprint, input_json, input_hash,
              status, progress_json, result_json, failure_code
            ) VALUES (
              ${executionId}, ${request.invocationId}, ${request.conversationId},
              ${request.actionName}, ${action.revision},
              ${options.catalog.fingerprint}, ${inputJson}, ${inputHash},
              'queued', NULL, NULL, NULL
            )
          `;
          const changes = yield* sql<{ readonly inserted: number }>`
            SELECT changes() AS inserted
          `;
          const rows = yield* sql`
            SELECT
              action_name AS actionName,
              action_revision AS actionRevision,
              catalog_fingerprint AS catalogFingerprint,
              conversation_id AS conversationId,
              execution_id AS executionId,
              failure_code AS failureCode,
              input_json AS inputJson,
              input_hash AS inputHash,
              invocation_id AS invocationId,
              progress_json AS progressJson,
              result_json AS resultJson,
              status
            FROM laborer_action_executions
            WHERE invocation_id = ${request.invocationId}
          `;
          return {
            inserted: changes[0]?.inserted === 1,
            row: yield* firstExecutionRow(rows, "storage"),
          };
        })
      );
      yield* snapshotFromRow(row);
      const durableInput = yield* validatedStoredInput(row);
      if (
        !inserted &&
        (row.actionName !== request.actionName ||
          row.actionRevision !== action.revision ||
          row.conversationId !== request.conversationId ||
          row.executionId !== executionId ||
          row.inputHash !== inputHash ||
          row.inputJson !== inputJson)
      ) {
        return yield* runtimeError("conflict");
      }

      yield* RegisteredActionWorkflow.execute(
        {
          actionName: row.actionName,
          actionRevision: row.actionRevision,
          catalogFingerprint: row.catalogFingerprint,
          conversationId: row.conversationId,
          encodedInput: durableInput,
          executionId: row.executionId,
        },
        { discard: true }
      ).pipe(Effect.provideService(WorkflowEngine.WorkflowEngine, engine));
      return {
        deduplicated: !inserted,
        executionId: row.executionId,
        status: row.status,
      };
    });

    return RegisteredActionRuntime.of({
      get: (executionId) =>
        get(executionId).pipe(
          Effect.mapError((error) =>
            error instanceof RegisteredActionRuntimeError
              ? error
              : runtimeError("storage")
          )
        ),
      privateTools: options.catalog.privateTools,
      start: (request) =>
        start(request).pipe(
          Effect.mapError((error) =>
            error instanceof RegisteredActionRuntimeError
              ? error
              : runtimeError("storage")
          )
        ),
    });
  });

export const makeRegisteredActionRuntimeLayer = (
  options: RegisteredActionRuntimeOptions
) => {
  const workflows = workflowLayer(options).pipe(
    Layer.provideMerge(clusterLayer),
    Layer.orDie
  );
  return Layer.effect(
    RegisteredActionRuntime,
    makeRuntime(options).pipe(Effect.orDie)
  ).pipe(Layer.provideMerge(workflows));
};
