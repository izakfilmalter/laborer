/**
 * THROWAWAY PROTOTYPE: proves the co-located conversation-to-execution tracer.
 * See README.md for the intentionally narrow question and deferred production work.
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunRuntime } from "@effect/platform-bun";
import { layerNet as bunSocketLayerNet } from "@effect/platform-bun/BunSocket";
import { layer as bunSocketServerLayer } from "@effect/platform-bun/BunSocketServer";
import {
  SqliteClient as BunSqliteClient,
  layer as makeSqliteLayer,
} from "@effect/sql-sqlite-bun/SqliteClient";
import {
  Clock,
  Console,
  Deferred,
  Effect,
  Array as EffectArray,
  Layer,
  Option,
  pipe,
  Queue,
  Record,
  Ref,
  Schema,
} from "effect";
import { ClusterWorkflowEngine, SingleRunner } from "effect/unstable/cluster";
import {
  Rpc,
  RpcClient,
  type RpcClientError,
  RpcGroup,
  RpcSerialization,
  RpcServer,
} from "effect/unstable/rpc";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { Workflow } from "effect/unstable/workflow";

const prototypeDirectory = join(
  tmpdir(),
  "laborer-conversation-execution-tracer-prototype"
);
const databasePath = join(prototypeDirectory, "prototype.sqlite");
const socketPath = join(prototypeDirectory, "execution.sock");

rmSync(prototypeDirectory, { force: true, recursive: true });
mkdirSync(prototypeDirectory, { recursive: true });

// One parameterized, module-level layer instance is deliberately shared by the
// application tables and SingleRunner's Cluster persistence.
const sqliteLayer = makeSqliteLayer({ filename: databasePath });

const threadId = "thread-wayfinder-tracer";
const sessionId = "session-wayfinder-tracer";
const actionKey = "deterministic-slow-action";
const startPrompt = "Run the deterministic slow action.";
const statusPrompt = "Can you still talk while it runs?";
const pollInterval = "10 millis";
const maximumPollAttempts = 500;

const ExecutionStatus = Schema.Literals(["queued", "running", "completed"]);
const ExecutionSnapshot = Schema.Struct({
  executionId: Schema.String,
  progress: Schema.Number,
  result: Schema.NullOr(Schema.String),
  status: ExecutionStatus,
});
type ExecutionSnapshot = typeof ExecutionSnapshot.Type;

const StartActionResult = Schema.Struct({
  executionId: Schema.String,
  status: Schema.Literal("queued"),
});

const StartAction = Rpc.make("StartAction", {
  payload: { actionKey: Schema.String },
  success: StartActionResult,
});
const GetExecution = Rpc.make("GetExecution", {
  payload: { executionId: Schema.String },
  success: ExecutionSnapshot,
});
const ExecutionRpcs = RpcGroup.make(StartAction, GetExecution);
type ExecutionClient = RpcClient.FromGroup<
  typeof ExecutionRpcs,
  RpcClientError.RpcClientError
>;

const SlowActionWorkflow = Workflow.make("Prototype/SlowAction", {
  payload: { actionKey: Schema.String },
  success: Schema.String,
  idempotencyKey: ({ actionKey: key }) => key,
});

const stableCompletionEventId = (executionId: string): string =>
  `execution:${executionId}:completed`;

const slowActionWorkflowLayer = SlowActionWorkflow.toLayer(
  (_payload, executionId) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql`
        UPDATE prototype_executions
        SET status = 'running', progress = 20, workflow_runs = workflow_runs + 1
        WHERE execution_id = ${executionId}
      `;
      yield* Effect.sleep("350 millis");
      yield* sql`
        UPDATE prototype_executions
        SET progress = 60
        WHERE execution_id = ${executionId}
      `;
      yield* Effect.sleep("550 millis");
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
            UPDATE prototype_executions
            SET status = 'completed', progress = 100, result = 'artifact-ready'
            WHERE execution_id = ${executionId}
          `;
          yield* sql`
            INSERT OR IGNORE INTO prototype_outbox (
              event_id, event_type, execution_id, delivered
            ) VALUES (
              ${stableCompletionEventId(executionId)},
              'execution.completed',
              ${executionId},
              0
            )
          `;
        })
      );
      return "artifact-ready";
    }).pipe(Effect.orDie)
);

const readExecution = (executionId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql<ExecutionSnapshot>`
      SELECT
        execution_id AS executionId,
        status,
        progress,
        result
      FROM prototype_executions
      WHERE execution_id = ${executionId}
    `;
    const row = yield* EffectArray.head(rows).pipe(
      Option.match({
        onNone: () => Effect.die(new Error(`Missing execution ${executionId}`)),
        onSome: Effect.succeed,
      })
    );
    return yield* Schema.decodeUnknownEffect(ExecutionSnapshot)(row);
  }).pipe(Effect.orDie);

const executionHandlers = ExecutionRpcs.toLayer(
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    return {
      GetExecution: ({ executionId }: { readonly executionId: string }) =>
        readExecution(executionId),
      StartAction: ({
        actionKey: requestedAction,
      }: {
        readonly actionKey: string;
      }) =>
        Effect.gen(function* () {
          const executionId = yield* SlowActionWorkflow.executionId({
            actionKey: requestedAction,
          });
          yield* sql`
            INSERT OR IGNORE INTO prototype_executions (
              execution_id, action_key, status, progress, result, workflow_runs
            ) VALUES (
              ${executionId}, ${requestedAction}, 'queued', 0, NULL, 0
            )
          `;
          yield* SlowActionWorkflow.execute(
            { actionKey: requestedAction },
            { discard: true }
          );
          return { executionId, status: "queued" as const };
        }).pipe(Effect.orDie),
    };
  })
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

const workflowRuntimeLayer = slowActionWorkflowLayer.pipe(
  Layer.provideMerge(clusterLayer)
);

const executionServerLayer = RpcServer.layer(ExecutionRpcs).pipe(
  Layer.provide(executionHandlers),
  Layer.provideMerge(RpcServer.layerProtocolSocketServer),
  Layer.provideMerge(bunSocketServerLayer({ path: socketPath })),
  Layer.provide(RpcSerialization.layerNdjson)
);

const rootRuntimeLayer = executionServerLayer.pipe(
  Layer.provideMerge(workflowRuntimeLayer),
  Layer.provideMerge(sqliteLayer)
);

const conversationClientLayer = RpcClient.layerProtocolSocket().pipe(
  Layer.provide(bunSocketLayerNet({ path: socketPath })),
  Layer.provide(RpcSerialization.layerNdjson)
);

interface PublicOutput {
  readonly body: string;
  readonly opaqueResponseId: string;
  readonly threadId: string;
  readonly type: "conversation.response.completed";
}

interface ConversationReceipt {
  readonly executionId: string | null;
  readonly responseId: string;
  readonly sequence: number;
  readonly sessionId: string;
  readonly snapshot: ExecutionSnapshot | null;
}

interface HumanCommand {
  readonly _tag: "Human";
  readonly acknowledgement: Deferred.Deferred<ConversationReceipt>;
  readonly sourceEventId: string;
  readonly text: string;
}

interface TerminalCommand {
  readonly _tag: "Terminal";
  readonly acknowledgement: Deferred.Deferred<ConversationReceipt>;
  readonly executionId: string;
  readonly sourceEventId: string;
}

type ConversationCommand = HumanCommand | TerminalCommand;

interface PersistedEvent {
  readonly sequence: number;
  readonly sessionId: string;
}

interface ConversationRuntime {
  readonly acceptHuman: (
    sourceEventId: string,
    text: string
  ) => Effect.Effect<ConversationReceipt>;
  readonly acceptTerminal: (
    sourceEventId: string,
    executionId: string
  ) => Effect.Effect<ConversationReceipt>;
}

const initializeApplicationTables = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql`
    CREATE TABLE prototype_executions (
      execution_id TEXT PRIMARY KEY,
      action_key TEXT NOT NULL,
      status TEXT NOT NULL,
      progress INTEGER NOT NULL,
      result TEXT,
      workflow_runs INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE prototype_outbox (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      delivered INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE prototype_threads (
      thread_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE prototype_thread_executions (
      thread_id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE prototype_conversation_events (
      thread_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      source_event_id TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL,
      event_kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (thread_id, sequence)
    )
  `;
  yield* sql`
    CREATE TABLE prototype_conversation_responses (
      response_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      event_sequence INTEGER NOT NULL,
      body TEXT NOT NULL
    )
  `;
});

const persistConversationEvent = Effect.fn("persistConversationEvent")(
  function* (options: {
    readonly eventKind: "human" | "terminal-execution";
    readonly payload: string;
    readonly sourceEventId: string;
  }) {
    const sql = yield* SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          INSERT OR IGNORE INTO prototype_threads (thread_id, session_id)
          VALUES (${threadId}, ${sessionId})
        `;
        const threadRows = yield* sql<{ readonly sessionId: string }>`
          SELECT session_id AS sessionId
          FROM prototype_threads
          WHERE thread_id = ${threadId}
        `;
        const thread = yield* EffectArray.head(threadRows).pipe(
          Option.match({
            onNone: () =>
              Effect.die(new Error("Conversation thread was not durable")),
            onSome: Effect.succeed,
          })
        );
        const sequenceRows = yield* sql<{ readonly sequence: number }>`
          SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
          FROM prototype_conversation_events
          WHERE thread_id = ${threadId}
        `;
        const sequenceRow = yield* EffectArray.head(sequenceRows).pipe(
          Option.match({
            onNone: () =>
              Effect.die(new Error("Could not allocate conversation sequence")),
            onSome: Effect.succeed,
          })
        );
        yield* sql`
          INSERT INTO prototype_conversation_events (
            thread_id, sequence, source_event_id, session_id, event_kind, payload
          ) VALUES (
            ${threadId},
            ${sequenceRow.sequence},
            ${options.sourceEventId},
            ${thread.sessionId},
            ${options.eventKind},
            ${options.payload}
          )
        `;
        return {
          sequence: sequenceRow.sequence,
          sessionId: thread.sessionId,
        } satisfies PersistedEvent;
      })
    );
  }
);

const currentThreadExecutionId = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql<{ readonly executionId: string }>`
    SELECT execution_id AS executionId
    FROM prototype_thread_executions
    WHERE thread_id = ${threadId}
  `;
  return yield* EffectArray.head(rows).pipe(
    Option.match({
      onNone: () => Effect.die(new Error("Thread has no execution")),
      onSome: ({ executionId }) => Effect.succeed(executionId),
    })
  );
});

const makeConversationRuntime = Effect.fn("makeConversationRuntime")(function* (
  client: ExecutionClient,
  publicOutputs: PublicOutput[],
  executionWakeCount: Ref.Ref<number>
) {
  const sql = yield* SqlClient;
  const commands = yield* Queue.unbounded<ConversationCommand>();

  const completeResponse = Effect.fn("completeConversationResponse")(function* (
    event: PersistedEvent,
    body: string,
    executionId: string | null,
    snapshot: ExecutionSnapshot | null
  ) {
    const responseId = `opaque-response-${event.sequence}`;
    yield* sql`
          INSERT INTO prototype_conversation_responses (
            response_id, thread_id, event_sequence, body
          ) VALUES (${responseId}, ${threadId}, ${event.sequence}, ${body})
        `;
    yield* Effect.sync(() => {
      publicOutputs.push({
        body,
        opaqueResponseId: responseId,
        threadId,
        type: "conversation.response.completed",
      });
    });
    return {
      executionId,
      responseId,
      sequence: event.sequence,
      sessionId: event.sessionId,
      snapshot,
    } satisfies ConversationReceipt;
  });

  const processHuman = Effect.fn("processHuman")(function* (
    command: HumanCommand
  ) {
    const event = yield* persistConversationEvent({
      eventKind: "human",
      payload: command.text,
      sourceEventId: command.sourceEventId,
    });
    if (command.text === startPrompt) {
      const accepted = yield* client.StartAction({ actionKey });
      yield* sql`
          INSERT OR REPLACE INTO prototype_thread_executions (
            thread_id, execution_id
          ) VALUES (${threadId}, ${accepted.executionId})
        `;
      return yield* completeResponse(
        event,
        "I accepted the action and will report its terminal result here.",
        accepted.executionId,
        null
      );
    }
    if (command.text === statusPrompt) {
      const executionId = yield* currentThreadExecutionId;
      const snapshot = yield* client.GetExecution({ executionId });
      return yield* completeResponse(
        event,
        "The work is still underway, and this conversation remains responsive.",
        executionId,
        snapshot
      );
    }
    return yield* Effect.die(
      new Error(`Unexpected scripted prompt: ${command.text}`)
    );
  });

  const processTerminal = Effect.fn("processTerminal")(function* (
    command: TerminalCommand
  ) {
    const event = yield* persistConversationEvent({
      eventKind: "terminal-execution",
      payload: "completed",
      sourceEventId: command.sourceEventId,
    });
    yield* Ref.update(executionWakeCount, (count) => count + 1);
    return yield* completeResponse(
      event,
      "The requested action finished successfully.",
      command.executionId,
      null
    );
  });

  const worker = Effect.forever(
    Effect.gen(function* () {
      const command = yield* Queue.take(commands);
      const receipt =
        command._tag === "Human"
          ? yield* processHuman(command)
          : yield* processTerminal(command);
      yield* Deferred.succeed(command.acknowledgement, receipt);
    })
  );
  yield* Effect.forkScoped(worker);

  const acceptHuman = Effect.fn("ConversationRuntime.acceptHuman")(function* (
    sourceEventId: string,
    text: string
  ) {
    const acknowledgement = yield* Deferred.make<ConversationReceipt>();
    yield* Queue.offer(commands, {
      _tag: "Human",
      acknowledgement,
      sourceEventId,
      text,
    });
    return yield* Deferred.await(acknowledgement);
  });
  const acceptTerminal = Effect.fn("ConversationRuntime.acceptTerminal")(
    function* (sourceEventId: string, executionId: string) {
      const acknowledgement = yield* Deferred.make<ConversationReceipt>();
      yield* Queue.offer(commands, {
        _tag: "Terminal",
        acknowledgement,
        executionId,
        sourceEventId,
      });
      return yield* Deferred.await(acknowledgement);
    }
  );
  return { acceptHuman, acceptTerminal } satisfies ConversationRuntime;
});

const runOutboxPump = Effect.fn("runOutboxPump")(function* (
  conversation: ConversationRuntime,
  terminalReceipt: Deferred.Deferred<ConversationReceipt>
) {
  const sql = yield* SqlClient;
  return yield* Effect.forever(
    Effect.gen(function* () {
      const rows = yield* sql<{
        readonly eventId: string;
        readonly executionId: string;
      }>`
        SELECT event_id AS eventId, execution_id AS executionId
        FROM prototype_outbox
        WHERE delivered = 0 AND event_type = 'execution.completed'
        ORDER BY event_id
        LIMIT 1
      `;
      const row = EffectArray.head(rows);
      if (Option.isNone(row)) {
        yield* Effect.sleep(pollInterval);
        return;
      }
      const receipt = yield* conversation.acceptTerminal(
        row.value.eventId,
        row.value.executionId
      );
      yield* sql`
        UPDATE prototype_outbox
        SET delivered = 1
        WHERE event_id = ${row.value.eventId}
      `;
      yield* Deferred.succeed(terminalReceipt, receipt);
    })
  );
});

const waitForSnapshot = Effect.fn("waitForSnapshot")(function* (
  client: ExecutionClient,
  executionId: string,
  predicate: (snapshot: ExecutionSnapshot) => boolean
) {
  for (let attempt = 0; attempt < maximumPollAttempts; attempt += 1) {
    const snapshot = yield* client.GetExecution({ executionId });
    if (predicate(snapshot)) {
      return snapshot;
    }
    yield* Effect.sleep(pollInterval);
  }
  return yield* Effect.die(
    new Error(`Execution ${executionId} did not reach the expected state`)
  );
});

const assertInvariant = (
  condition: boolean,
  message: string
): Effect.Effect<void> =>
  condition
    ? Effect.void
    : Effect.die(new Error(`Invariant failed: ${message}`));

const readScalarCount = Effect.fn("readScalarCount")(function* (query: string) {
  const sql = yield* SqlClient;
  const rows = yield* sql.unsafe<{ readonly count: number }>(query);
  const row = yield* EffectArray.head(rows).pipe(
    Option.match({
      onNone: () =>
        Effect.die(new Error(`Count query returned no row: ${query}`)),
      onSome: Effect.succeed,
    })
  );
  return row.count;
});

const verifyAndPrintEvidence = Effect.fn("verifyAndPrintEvidence")(
  function* (options: {
    readonly firstReceipt: ConversationReceipt;
    readonly progressSnapshot: ExecutionSnapshot;
    readonly publicOutputs: readonly PublicOutput[];
    readonly queuedResult: typeof StartActionResult.Type;
    readonly secondReceipt: ConversationReceipt;
    readonly startElapsedMillis: number;
    readonly terminalReceipt: ConversationReceipt;
    readonly wakesBeforeTerminal: number;
  }) {
    const sql = yield* SqlClient;
    const executionId = options.queuedResult.executionId;
    const finalSnapshot = yield* readExecution(executionId);
    const executionRows = yield* sql<{
      readonly workflowRuns: number;
    }>`
      SELECT workflow_runs AS workflowRuns
      FROM prototype_executions
      WHERE execution_id = ${executionId}
    `;
    const executionRow = yield* EffectArray.head(executionRows).pipe(
      Option.match({
        onNone: () =>
          Effect.die(new Error("Execution evidence was not durable")),
        onSome: Effect.succeed,
      })
    );
    const eventRows = yield* sql<{
      readonly eventKind: string;
      readonly sequence: number;
      readonly sessionId: string;
      readonly sourceEventId: string;
    }>`
      SELECT
        sequence,
        session_id AS sessionId,
        source_event_id AS sourceEventId,
        event_kind AS eventKind
      FROM prototype_conversation_events
      ORDER BY sequence
    `;
    const outboxRows = yield* sql<{
      readonly delivered: number;
      readonly eventId: string;
    }>`
      SELECT event_id AS eventId, delivered
      FROM prototype_outbox
    `;
    const clusterTables = yield* sql<{ readonly name: string }>`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'cluster_%'
      ORDER BY name
    `;
    const genericSql = yield* SqlClient;
    const bunSql = yield* BunSqliteClient;
    const publicKeysAreOpaque = EffectArray.every(
      options.publicOutputs,
      (output) => {
        const keys = Record.keys(output);
        return (
          keys.length === 4 && output.type === "conversation.response.completed"
        );
      }
    );
    const publicPayload = JSON.stringify(options.publicOutputs);
    const noRawExecutionData = EffectArray.every(
      ["executionId", "progress", "snapshot", "diagnostic", executionId],
      (forbidden) => !publicPayload.includes(forbidden)
    );
    const sessions = pipe(
      eventRows,
      EffectArray.map((event) => event.sessionId)
    );
    const sequences = pipe(
      eventRows,
      EffectArray.map((event) => event.sequence)
    );
    const eventKinds = pipe(
      eventRows,
      EffectArray.map((event) => event.eventKind)
    );
    const outbox = yield* EffectArray.head(outboxRows).pipe(
      Option.match({
        onNone: () => Effect.die(new Error("Terminal outbox event is missing")),
        onSome: Effect.succeed,
      })
    );
    const wakeCount = yield* readScalarCount(
      "SELECT COUNT(*) AS count FROM prototype_conversation_events WHERE event_kind = 'terminal-execution'"
    );

    yield* assertInvariant(
      genericSql === bunSql,
      "application SQL services are not one Bun SQLite client"
    );
    yield* assertInvariant(
      clusterTables.length >= 5,
      "Effect Cluster did not create SQL persistence tables"
    );
    yield* assertInvariant(
      options.queuedResult.status === "queued",
      "Action start did not return queued"
    );
    yield* assertInvariant(
      options.firstReceipt.executionId === executionId,
      "conversation did not retain Action execution"
    );
    yield* assertInvariant(
      options.progressSnapshot.status === "running",
      "progress snapshot was not running"
    );
    yield* assertInvariant(
      options.progressSnapshot.progress === 60,
      "expected deterministic progress was not observed"
    );
    yield* assertInvariant(
      options.secondReceipt.snapshot?.status === "running",
      "second human event did not read a running RPC snapshot"
    );
    yield* assertInvariant(
      executionRow.workflowRuns === 1,
      "idempotent workflow ran more than once"
    );
    yield* assertInvariant(
      finalSnapshot.status === "completed",
      "workflow did not complete"
    );
    yield* assertInvariant(
      options.wakesBeforeTerminal === 0,
      "queued/running progress woke the conversation"
    );
    yield* assertInvariant(
      wakeCount === 1,
      "terminal completion did not wake exactly once"
    );
    yield* assertInvariant(
      outbox.eventId === stableCompletionEventId(executionId),
      "outbox event ID was not stable"
    );
    yield* assertInvariant(
      outbox.delivered === 1,
      "terminal outbox event was not delivered"
    );
    yield* assertInvariant(
      sequences.join(",") === "1,2,3",
      "conversation events were not serialized"
    );
    yield* assertInvariant(
      eventKinds.join(",") === "human,human,terminal-execution",
      "conversation event order is wrong"
    );
    yield* assertInvariant(
      EffectArray.every(sessions, (value) => value === sessionId),
      "conversation session ID changed"
    );
    yield* assertInvariant(
      options.terminalReceipt.sequence === 3,
      "terminal event was not serialized after human events"
    );
    yield* assertInvariant(
      options.publicOutputs.length === 3,
      "public sink did not receive exactly completed conversation responses"
    );
    yield* assertInvariant(
      publicKeysAreOpaque && noRawExecutionData,
      "raw execution data crossed the public-output boundary"
    );

    yield* Console.log(
      `PASS root       pid=${process.pid}; owners=conversation+execution; child-processes=0`
    );
    yield* Console.log(
      `PASS boundary   Effect typed RPC + NDJSON over unix://${socketPath}`
    );
    yield* Console.log(
      `PASS storage    one Bun SQLite client; app tables + ${clusterTables.length} Cluster tables`
    );
    yield* Console.log(
      `PASS action     start=${options.queuedResult.status} in ${options.startElapsedMillis}ms; duplicate execution id; workflow-runs=1`
    );
    yield* Console.log(
      `PASS conversation session=${sessionId}; durable order=${eventKinds.join(" -> ")}; running snapshot=${options.progressSnapshot.progress}%`
    );
    yield* Console.log(
      `PASS wake       queued/running=0; terminal=1; outbox=${outbox.eventId}`
    );
    yield* Console.log(
      `PASS sink       ${options.publicOutputs.length} opaque conversation.response.completed envelopes; raw execution fields=0`
    );
    yield* Console.log(
      "VERDICT two peer runtimes in one Bun root work for this tracer"
    );
  }
);

const demo = Effect.gen(function* () {
  yield* initializeApplicationTables;
  const client = yield* RpcClient.make(ExecutionRpcs);
  const publicOutputs: PublicOutput[] = [];
  const executionWakeCount = yield* Ref.make(0);
  const terminalReceiptDeferred = yield* Deferred.make<ConversationReceipt>();
  const conversation = yield* makeConversationRuntime(
    client,
    publicOutputs,
    executionWakeCount
  );
  yield* Effect.forkScoped(
    runOutboxPump(conversation, terminalReceiptDeferred)
  );

  const startTime = yield* Clock.currentTimeMillis;
  const firstReceipt = yield* conversation.acceptHuman(
    "human-event-1",
    startPrompt
  );
  const startElapsedMillis = (yield* Clock.currentTimeMillis) - startTime;
  const executionId = firstReceipt.executionId ?? "";
  yield* assertInvariant(
    executionId.length > 0,
    "first conversation response omitted its internal execution ID"
  );

  const duplicateStart = yield* client.StartAction({ actionKey });
  yield* assertInvariant(
    duplicateStart.executionId === executionId,
    "idempotent Action start returned another execution ID"
  );
  yield* assertInvariant(
    duplicateStart.status === "queued",
    "idempotent Action start did not acknowledge queued"
  );

  const runningSnapshot = yield* waitForSnapshot(
    client,
    executionId,
    (snapshot) => snapshot.status === "running"
  );
  yield* assertInvariant(
    runningSnapshot.status !== "completed",
    "Action completed before queued acknowledgement was observed"
  );
  const secondReceipt = yield* conversation.acceptHuman(
    "human-event-2",
    statusPrompt
  );
  const progressSnapshot = yield* waitForSnapshot(
    client,
    executionId,
    (snapshot) => snapshot.status === "running" && snapshot.progress === 60
  );
  const wakesBeforeTerminal = yield* Ref.get(executionWakeCount);
  const outboxBeforeTerminal = yield* readScalarCount(
    "SELECT COUNT(*) AS count FROM prototype_outbox"
  );
  yield* assertInvariant(
    outboxBeforeTerminal === 0,
    "nonterminal progress emitted an outbox event"
  );

  const terminalReceipt = yield* Deferred.await(terminalReceiptDeferred).pipe(
    Effect.timeout("5 seconds"),
    Effect.orDie
  );
  yield* waitForSnapshot(
    client,
    executionId,
    (snapshot) => snapshot.status === "completed"
  );

  yield* verifyAndPrintEvidence({
    firstReceipt,
    progressSnapshot,
    publicOutputs,
    queuedResult: duplicateStart,
    secondReceipt,
    startElapsedMillis,
    terminalReceipt,
    wakesBeforeTerminal,
  });
});

demo.pipe(
  Effect.provide([conversationClientLayer, rootRuntimeLayer]),
  Effect.scoped,
  BunRuntime.runMain
);
