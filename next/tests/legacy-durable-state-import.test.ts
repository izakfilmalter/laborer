import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { layer as makeSqliteLayer } from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { ParticipantInputEvent } from "../src/application.ts";
import {
  CONVERSATION_ONLY_ACTION_CATALOG_FINGERPRINT,
  makeNodeRootDurableRuntime,
} from "../src/durable-runtime/node-root.ts";
import {
  MessageId,
  NormalizedMessage,
  ThreadId,
  TurnId,
} from "../src/prototype/domain.ts";
import { makeTempDirectoryScoped } from "./support/temp-directory.ts";

const writeLegacyFixture = async (runtimeRoot: string): Promise<void> => {
  const workspaceRoot = join(runtimeRoot, "slack-workspaces", "T-IMPORT");
  await mkdir(workspaceRoot, { mode: 0o700, recursive: true });
  await writeFile(
    join(workspaceRoot, "runner-state.json"),
    JSON.stringify({
      acknowledgements: [],
      completionReactions: [],
      conversationStreamRateBudgets: [],
      conversationStreams: [
        {
          id: "stream-existing",
          lifecycle: "finalizing",
          ownerId: "turn-existing",
        },
      ],
      conversationStreamTombstones: [],
      ignoredInbound: [],
      schemaVersion: 1,
      seenEventIds: ["slack-event-existing"],
      threads: [
        {
          applicationEvents: [
            {
              eventId: "execution-event-existing",
              payload: {
                executionId: "execution-existing",
                kind: "progress",
              },
              source: "legacy-execution",
              status: "pending",
            },
          ],
          id: "thread-existing",
          outbox: [{ id: "reply-existing", status: "pending" }],
          turns: [{ id: "turn-existing", status: "awaiting_delivery" }],
        },
      ],
    }),
    { mode: 0o600 }
  );
  await writeFile(
    join(workspaceRoot, "application-state.json"),
    JSON.stringify({
      actionOperationTombstones: [],
      actionOperations: [
        {
          actionName: "create-feature",
          catalogFingerprint: "catalog-existing",
          executionId: "execution-existing",
          operationId: "action-operation-existing",
          state: "running",
        },
      ],
      conversationAdoptions: [],
      conversations: [
        {
          agentSessionBinding: { sessionId: "acp-session-existing" },
          conversationId: "thread-existing",
          prompts: [{ promptId: "prompt-existing", status: "running" }],
          sessionId: "conversation-session-existing",
        },
      ],
      executionEventOutbox: [
        {
          outboxId: "execution-outbox-existing",
          recordId: "execution-event-existing",
          status: "staged",
        },
      ],
      executionPromptOperations: [],
      executions: [
        {
          actionInvocationId: "action-operation-existing",
          actionName: "create-feature",
          conversationId: "thread-existing",
          events: [{ eventId: "execution-event-existing", status: "staged" }],
          executionId: "execution-existing",
          implementationSessionId: "implementation-session-existing",
          ownerWorkspaceId: "T-IMPORT",
          status: "running",
          workingDirectory: "/tmp/existing-worktree",
        },
      ],
      recoveryDecisions: [],
      schemaVersion: 16,
    }),
    { mode: 0o600 }
  );
  await writeFile(
    join(workspaceRoot, "acp-authority.json"),
    JSON.stringify({
      records: [{ recordId: "permission-existing", state: "pending" }],
      schemaVersion: 2,
    }),
    { mode: 0o600 }
  );
};

describe("legacy durable state import", () => {
  it.live("imports every durable identity once through root startup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped("laborer-legacy-import-");
        const runtimeRoot = join(root, ".laborer-runtime");
        yield* Effect.promise(() => mkdir(runtimeRoot, { mode: 0o700 }));
        yield* Effect.promise(() => writeLegacyFixture(runtimeRoot));
        const databasePath = join(runtimeRoot, "runtime.sqlite");

        const runtime = yield* makeNodeRootDurableRuntime({
          databasePath,
          rootIdentity: root,
        });
        const handled: string[] = [];
        yield* runtime.attachConversationClient(
          {
            actionCatalogFingerprint:
              CONVERSATION_ONLY_ACTION_CATALOG_FINGERPRINT,
          },
          "T-IMPORT",
          {
            handle: (event) =>
              Effect.sync(() => {
                handled.push(
                  event._tag === "ExternalInput" ? event.eventId : event.turnId
                );
                return [];
              }),
          }
        );
        const importedTurn = ParticipantInputEvent.make({
          attemptNumber: 1,
          channelId: "C-IMPORT",
          context: [],
          conversationId: ThreadId.make("thread-existing"),
          initializationStatus: "not_applicable",
          messages: [
            NormalizedMessage.make({
              authorKind: "human",
              authorSlackId: "U-IMPORT",
              classification: "input",
              id: MessageId.make("message-after-import"),
              isActivation: false,
              slackTs: "2.0",
              text: "continue existing Conversation",
            }),
          ],
          rootTs: "1.0",
          source: "slack",
          turnId: TurnId.make("turn-after-import"),
          workingDirectory: null,
        });
        const request = {
          event: importedTurn,
          rootIdentity: root,
          workspaceId: "T-IMPORT",
        };
        const continued = yield* runtime.runConversation(request);
        const replay = yield* runtime.runConversation(request);
        assert.ok(continued.sessionId.startsWith("conversation:"));
        assert.strictEqual(replay.sequence, continued.sequence);
        assert.deepStrictEqual(handled, [
          "execution-event-existing",
          "turn-after-import",
        ]);

        const sqlContext = yield* Layer.build(
          makeSqliteLayer({ filename: databasePath })
        );
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient;
          const receipts = yield* sql<{
            readonly sourceCount: number;
            readonly status: string;
          }>`SELECT status, source_count AS sourceCount FROM laborer_migration_ledger`;
          assert.deepStrictEqual(receipts, [
            { sourceCount: 3, status: "completed" },
          ]);
          const records = yield* sql<{
            readonly domain: string;
            readonly recordId: string;
            readonly status: string | null;
          }>`
            SELECT domain, record_id AS recordId, status
            FROM laborer_imported_durable_records
            ORDER BY domain, record_id
          `;
          const identities = new Set(records.map(({ recordId }) => recordId));
          for (const identity of [
            "thread-existing",
            "turn-existing",
            "conversation-session-existing",
            "acp-session-existing",
            "action-operation-existing",
            "execution-existing",
            "prompt-existing",
            "execution-event-existing",
            "permission-existing",
            "stream-existing",
            "reply-existing",
          ]) {
            assert.ok(identities.has(identity), `missing imported ${identity}`);
          }
          assert.ok(
            records.some(
              ({ recordId, status }) =>
                recordId === "execution-existing" && status === "running"
            )
          );
          const before = records.length;

          yield* makeNodeRootDurableRuntime({
            databasePath,
            rootIdentity: root,
          });
          const after = yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count FROM laborer_imported_durable_records
          `;
          assert.strictEqual(after[0]?.count, before);
        }).pipe(Effect.provide(sqlContext));
      })
    )
  );

  it.effect("fails closed and records an incompatible corrupt source", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped(
          "laborer-corrupt-legacy-import-"
        );
        const runtimeRoot = join(root, ".laborer-runtime");
        yield* Effect.promise(() =>
          mkdir(runtimeRoot, { mode: 0o700, recursive: true })
        );
        yield* Effect.promise(() =>
          writeFile(
            join(runtimeRoot, "runner-state.json"),
            JSON.stringify({ schemaVersion: 999, threads: [] }),
            { mode: 0o600 }
          )
        );
        const databasePath = join(runtimeRoot, "runtime.sqlite");
        const result = yield* Effect.exit(
          makeNodeRootDurableRuntime({
            databasePath,
            legacyWorkspaceId: "T-CORRUPT",
            rootIdentity: root,
          })
        );
        assert.ok(Exit.isFailure(result));

        const sqlContext = yield* Layer.build(
          makeSqliteLayer({ filename: databasePath })
        );
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient;
          const ledger = yield* sql<{
            readonly diagnosticCode: string;
            readonly status: string;
          }>`
            SELECT status, diagnostic_code AS diagnosticCode
            FROM laborer_migration_ledger
          `;
          assert.deepStrictEqual(ledger, [
            { diagnosticCode: "invalid-source", status: "incompatible" },
          ]);
          const visible = yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count FROM laborer_imported_durable_records
          `;
          assert.strictEqual(visible[0]?.count, 0);
        }).pipe(Effect.provide(sqlContext));
      })
    )
  );
});
