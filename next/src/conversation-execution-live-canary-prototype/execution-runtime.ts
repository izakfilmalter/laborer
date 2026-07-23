/** THROWAWAY ISSUE #217 CANARY — durable execution peer. */

import { NodeSocketServer } from "@effect/platform-node";
import {
  Context,
  Effect,
  Array as EffectArray,
  Layer,
  Option,
  Result,
} from "effect";
import { ClusterWorkflowEngine, SingleRunner } from "effect/unstable/cluster";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { runOpenCode } from "./opencode-runner.ts";
import {
  ActionSnapshot,
  CanaryActionWorkflow,
  ExecutionRpcs,
  StartActionResult,
} from "./protocol.ts";

const ACTION_DELAY = "45 seconds";
const ACTION_TIMEOUT_MILLIS = 120_000;
const MAX_ACTION_RESULT_CHARACTERS = 1000;

class ApplicationTables extends Context.Service<
  ApplicationTables,
  { readonly ready: true }
>()("@laborer/canary/ApplicationTables") {}

const initializeApplicationTables = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS canary_executions (
      execution_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      thread_id TEXT NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      updated_at INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS canary_thread_executions (
      thread_id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS canary_terminal_outbox (
      event_id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL UNIQUE,
      thread_id TEXT NOT NULL,
      status TEXT NOT NULL,
      result TEXT NOT NULL,
      delivery_state TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `;
  return ApplicationTables.of({ ready: true });
});

const terminalEventId = (executionId: string): string =>
  `execution:${executionId}:terminal`;

const readCurrentAction = Effect.fn("readCurrentAction")(function* (
  threadId: string
) {
  const sql = yield* SqlClient;
  const rows = yield* sql<{
    readonly result: string | null;
    readonly status: "queued" | "running" | "succeeded" | "failed";
  }>`
    SELECT execution.result, execution.status
    FROM canary_thread_executions AS route
    JOIN canary_executions AS execution
      ON execution.execution_id = route.execution_id
    WHERE route.thread_id = ${threadId}
    LIMIT 1
  `;
  const current = EffectArray.head(rows);
  if (Option.isNone(current)) {
    return ActionSnapshot.make({ result: null, status: "idle" });
  }
  return ActionSnapshot.make(current.value);
});

export const makeExecutionRuntimeLayer = (options: {
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly socketPath: string;
}) => {
  const tablesLayer = Layer.effect(
    ApplicationTables,
    initializeApplicationTables
  );

  const workflowLayer = CanaryActionWorkflow.toLayer((_payload, executionId) =>
    Effect.gen(function* () {
      yield* ApplicationTables;
      const sql = yield* SqlClient;
      const now = Date.now();
      yield* sql`
          UPDATE canary_executions
          SET status = 'running', updated_at = ${now}
          WHERE execution_id = ${executionId}
        `;
      yield* Effect.sleep(ACTION_DELAY);
      const completion = yield* Effect.result(
        runOpenCode({
          cwd: options.cwd,
          environment: {
            ...options.environment,
            OPENCODE_PERMISSION: '{"*":"deny"}',
          },
          prompt:
            "Reply with exactly one short sentence confirming that the deliberately slow canary action completed. Do not use any tools.",
          timeoutMillis: ACTION_TIMEOUT_MILLIS,
        })
      );
      const succeeded = Result.isSuccess(completion);
      const result = succeeded
        ? completion.success.text.slice(0, MAX_ACTION_RESULT_CHARACTERS)
        : "The separate completion agent failed safely.";
      const status = succeeded ? "succeeded" : "failed";
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
              UPDATE canary_executions
              SET status = ${status}, result = ${result}, updated_at = ${Date.now()}
              WHERE execution_id = ${executionId}
            `;
          yield* sql`
              INSERT OR IGNORE INTO canary_terminal_outbox (
                event_id,
                execution_id,
                thread_id,
                status,
                result,
                delivery_state,
                created_at
              ) VALUES (
                ${terminalEventId(executionId)},
                ${executionId},
                ${_payload.threadId},
                ${status},
                ${result},
                'pending',
                ${Date.now()}
              )
            `;
        })
      );
      return result;
    }).pipe(Effect.orDie)
  ).pipe(Layer.provideMerge(tablesLayer));

  const clusterLayer = ClusterWorkflowEngine.layer.pipe(
    Layer.provideMerge(
      SingleRunner.layer({
        runnerStorage: "sql",
        shardingConfig: {
          entityMessagePollInterval: 100,
          entityReplyPollInterval: 100,
          entityTerminationTimeout: 1000,
          refreshAssignmentsInterval: 100,
          sendRetryInterval: 100,
        },
      })
    )
  );
  const workflowRuntimeLayer = workflowLayer.pipe(
    Layer.provideMerge(clusterLayer)
  );

  const handlersLayer = ExecutionRpcs.toLayer(
    Effect.gen(function* () {
      yield* ApplicationTables;
      const sql = yield* SqlClient;
      return {
        GetCurrentAction: ({ threadId }: { readonly threadId: string }) =>
          readCurrentAction(threadId).pipe(Effect.orDie),
        StartCanaryAction: ({
          requestId,
          threadId,
        }: {
          readonly requestId: string;
          readonly threadId: string;
        }) =>
          Effect.gen(function* () {
            const payload = { requestId, threadId };
            const executionId =
              yield* CanaryActionWorkflow.executionId(payload);
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`
                  INSERT OR IGNORE INTO canary_executions (
                    execution_id,
                    request_id,
                    thread_id,
                    status,
                    result,
                    updated_at
                  ) VALUES (
                    ${executionId},
                    ${requestId},
                    ${threadId},
                    'queued',
                    NULL,
                    ${Date.now()}
                  )
                `;
                yield* sql`
                  INSERT INTO canary_thread_executions (thread_id, execution_id)
                  VALUES (${threadId}, ${executionId})
                  ON CONFLICT(thread_id) DO UPDATE SET execution_id = excluded.execution_id
                `;
              })
            );
            yield* CanaryActionWorkflow.execute(payload, { discard: true });
            return StartActionResult.make({ status: "queued" });
          }).pipe(Effect.orDie),
      };
    })
  ).pipe(Layer.provideMerge(tablesLayer));

  const serverLayer = RpcServer.layer(ExecutionRpcs).pipe(
    Layer.provide(handlersLayer),
    Layer.provideMerge(RpcServer.layerProtocolSocketServer),
    Layer.provideMerge(NodeSocketServer.layer({ path: options.socketPath })),
    Layer.provide(RpcSerialization.layerNdjson)
  );

  return serverLayer.pipe(
    Layer.provideMerge(workflowRuntimeLayer),
    Layer.provideMerge(tablesLayer)
  );
};
