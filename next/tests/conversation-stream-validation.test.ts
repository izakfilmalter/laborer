import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { ApplicationConversationMessageChunk } from "../src/application.ts";
import { makeConversationStreamDelivery } from "../src/prototype/conversation-stream-delivery.ts";
import { canonicalThreadId } from "../src/prototype/domain.ts";
import type { SlackGatewayShape } from "../src/prototype/runtime.ts";
import { makePrototypeHarness } from "../src/prototype/runtime.ts";
import {
  LABORER_SLACK_ID,
  normalizedEvent,
} from "../src/prototype/scenario.ts";
import { makeFileStoreLayer, PrototypeStore } from "../src/prototype/store.ts";
import { makeTempDirectoryScoped } from "./support/temp-directory.ts";

const writeState = (path: string, state: unknown): Effect.Effect<void> =>
  Effect.promise(() =>
    writeFile(path, JSON.stringify(state), { encoding: "utf8", mode: 0o600 })
  );

describe("Conversation stream cross-record validation", () => {
  it.effect(
    "fails closed on cross-thread, workspace, owner, recipient, and tombstone corruption",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-stream-cross-record-validation-"
          );
          const validPath = join(root, "valid.json");
          const context = yield* Layer.build(
            makeFileStoreLayer(LABORER_SLACK_ID, validPath, root)
          );
          const store = yield* PrototypeStore.pipe(Effect.provide(context));
          const rootTs = "253.100";
          const threadId = canonicalThreadId("CVALIDATE", rootTs, "TVALIDATE");
          yield* store.accept(
            normalizedEvent({
              authorSlackId: "UVALIDATE",
              channelId: "CVALIDATE",
              eventId: "event:stream:validate",
              messageTs: rootTs,
              text: `<@${LABORER_SLACK_ID}> validate stream state`,
              workspaceId: "TVALIDATE",
            })
          );
          yield* store.completeContext(threadId, [], false);
          const turn = yield* store.claimNextTurn(threadId);
          assert.ok(turn !== null);
          const slack: SlackGatewayShape = {
            nativeStreaming: {
              append: () => Effect.void,
              start: () => Effect.succeed({ ts: "validated-stream" }),
              stop: () => Effect.void,
            },
            postThreadMessage: () => Effect.succeed({ ts: "unused" }),
            readActivationContext: () => Effect.succeed([]),
          };
          const delivery = yield* makeConversationStreamDelivery({
            slack,
            store,
          });
          const publisher = delivery.publisherFor({
            ownerId: turn.id,
            ownerKind: "participant-turn",
            threadId,
          });
          yield* publisher.publish(
            ApplicationConversationMessageChunk.make({
              messageId: "validated-message",
              sequence: 0,
              text: "valid",
            })
          );
          const liveValid = yield* store.snapshot;
          const stream = liveValid.conversationStreams[0];
          assert.ok(stream !== undefined);
          yield* publisher.finalize("completed");
          yield* store.completeHandler(threadId, turn.id, { _tag: "Success" });
          const valid = yield* store.snapshot;
          const tombstone = valid.conversationStreamTombstones[0];
          assert.ok(tombstone !== undefined);
          const operation = stream.operations[0];
          const terminalOperation = tombstone.operations[0];
          assert.ok(operation !== undefined);
          assert.ok(terminalOperation !== undefined);

          const corruptions: readonly {
            readonly name: string;
            readonly state: unknown;
          }[] = [
            {
              name: "workspace",
              state: {
                ...liveValid,
                conversationStreams: [{ ...stream, workspaceId: "TOTHER" }],
              },
            },
            {
              name: "channel",
              state: {
                ...liveValid,
                conversationStreams: [{ ...stream, channelId: "COTHER" }],
              },
            },
            {
              name: "root",
              state: {
                ...liveValid,
                conversationStreams: [{ ...stream, rootTs: "253.999" }],
              },
            },
            {
              name: "owner",
              state: {
                ...liveValid,
                conversationStreams: [{ ...stream, ownerId: "turn:missing" }],
              },
            },
            {
              name: "recipient",
              state: {
                ...liveValid,
                conversationStreams: [{ ...stream, recipientUserId: "UOTHER" }],
              },
            },
            {
              name: "stable identity",
              state: {
                ...liveValid,
                conversationStreams: [{ ...stream, id: "stream:wrong" }],
              },
            },
            {
              name: "duplicate owner message",
              state: {
                ...liveValid,
                conversationStreams: [stream, { ...stream }],
              },
            },
            {
              name: "operation mode mismatch",
              state: {
                ...liveValid,
                conversationStreams: [{ ...stream, mode: "fallback" }],
              },
            },
            {
              name: "active native append overlaps confirmed prefix",
              state: {
                ...liveValid,
                conversationStreams: [
                  {
                    ...stream,
                    operations: [
                      operation,
                      {
                        ...operation,
                        attempt: 0,
                        id: `${stream.id}:operation:overlapping-native-append`,
                        inFlightAtMillis: null,
                        kind: "native-append",
                        payloadEndOffset: stream.confirmedOffset,
                        payloadStartOffset: 0,
                        retryAtMillis: null,
                        settledAtMillis: null,
                        status: "prepared",
                      },
                    ],
                  },
                ],
              },
            },
            {
              name: "acknowledged operation without settlement",
              state: {
                ...liveValid,
                conversationStreams: [
                  {
                    ...stream,
                    operations: [{ ...operation, settledAtMillis: null }],
                  },
                ],
              },
            },
            {
              name: "operation timestamp inversion",
              state: {
                ...liveValid,
                conversationStreams: [
                  {
                    ...stream,
                    operations: [
                      {
                        ...operation,
                        inFlightAtMillis: operation.preparedAtMillis - 1,
                      },
                    ],
                  },
                ],
              },
            },
            {
              name: "replay cursor beyond boundary",
              state: {
                ...liveValid,
                conversationStreams: [
                  {
                    ...stream,
                    replayBoundaryOffset: 1,
                    replayCursorOffset: 2,
                  },
                ],
              },
            },
            {
              name: "live stream owned by completed turn",
              state: {
                ...valid,
                conversationStreams: [stream],
                conversationStreamTombstones: [],
              },
            },
            {
              name: "tombstone workspace",
              state: {
                ...valid,
                conversationStreams: [],
                conversationStreamTombstones: [
                  { ...tombstone, workspaceId: "TOTHER" },
                ],
              },
            },
            {
              name: "tombstone operation mode mismatch",
              state: {
                ...valid,
                conversationStreamTombstones: [
                  { ...tombstone, mode: "fallback" },
                ],
              },
            },
            {
              name: "tombstone rejected operation without definite certainty",
              state: {
                ...valid,
                conversationStreamTombstones: [
                  {
                    ...tombstone,
                    lifecycle: "unresolved",
                    operations: [
                      {
                        ...terminalOperation,
                        errorCategory: "permanent-failure",
                        errorCertainty: "unknown",
                        status: "rejected",
                      },
                    ],
                  },
                ],
              },
            },
            {
              name: "tombstone operation timestamp inversion",
              state: {
                ...valid,
                conversationStreamTombstones: [
                  {
                    ...tombstone,
                    operations: [
                      {
                        ...terminalOperation,
                        settledAtMillis:
                          (terminalOperation.inFlightAtMillis ?? 0) - 1,
                      },
                    ],
                  },
                ],
              },
            },
          ];
          let slackCalls = 0;
          const forbiddenSlack: SlackGatewayShape = {
            nativeStreaming: {
              append: () =>
                Effect.sync(() => {
                  slackCalls += 1;
                }),
              start: () =>
                Effect.sync(() => {
                  slackCalls += 1;
                  return { ts: "forbidden" };
                }),
              stop: () =>
                Effect.sync(() => {
                  slackCalls += 1;
                }),
            },
            postThreadMessage: () =>
              Effect.sync(() => {
                slackCalls += 1;
                return { ts: "forbidden" };
              }),
            readActivationContext: () => Effect.succeed([]),
          };
          for (const [index, corruption] of corruptions.entries()) {
            const path = join(root, `corrupt-${index}.json`);
            yield* writeState(path, corruption.state);
            const result = yield* Effect.result(
              Effect.scoped(
                makePrototypeHarness({
                  application: { handle: () => Effect.void },
                  laborerSlackId: LABORER_SLACK_ID,
                  slack: forbiddenSlack,
                  storeLayer: makeFileStoreLayer(LABORER_SLACK_ID, path, root),
                })
              )
            );
            assert.strictEqual(result._tag, "Failure", corruption.name);
          }
          assert.strictEqual(slackCalls, 0);

          const tombstonePath = join(root, "valid-tombstone.json");
          yield* writeState(tombstonePath, {
            ...valid,
            conversationStreams: [],
            conversationStreamTombstones: [tombstone],
          });
          const tombstoneContext = yield* Layer.build(
            makeFileStoreLayer(LABORER_SLACK_ID, tombstonePath, root)
          );
          const tombstoneStore = yield* PrototypeStore.pipe(
            Effect.provide(tombstoneContext)
          );
          assert.strictEqual(
            (yield* tombstoneStore.snapshot).conversationStreamTombstones
              .length,
            1
          );

          const legacyPath = join(root, "legacy-stream-state.json");
          const {
            compactedConfirmedHash: _compactedConfirmedHash,
            compactedConfirmedOffset: _compactedConfirmedOffset,
            compactedOperationCount: _compactedOperationCount,
            createdAtMillis: _createdAtMillis,
            replayBoundaryOffset: _replayBoundaryOffset,
            replayCursorOffset: _replayCursorOffset,
            stoppedAtMillis: _stoppedAtMillis,
            ...legacyStream
          } = stream;
          const legacyOperations = legacyStream.operations.map(
            ({ errorCertainty: _errorCertainty, ...operation }) => operation
          );
          const {
            conversationStreamTombstones: _conversationStreamTombstones,
            ...legacyState
          } = liveValid;
          yield* writeState(legacyPath, {
            ...legacyState,
            conversationStreamRateBudgets: [
              {
                channelId: "CVALIDATE",
                method: "native-stop",
                nextAvailableAtMillis: 1000,
                workspaceId: "TVALIDATE",
              },
            ],
            conversationStreams: [
              { ...legacyStream, operations: legacyOperations },
            ],
          });
          const legacyContext = yield* Layer.build(
            makeFileStoreLayer(LABORER_SLACK_ID, legacyPath, root)
          );
          const migrated = yield* PrototypeStore.pipe(
            Effect.provide(legacyContext)
          );
          const migratedState = yield* migrated.snapshot;
          assert.strictEqual(
            migratedState.conversationStreams[0]?.stoppedAtMillis,
            null
          );
          assert.deepStrictEqual(
            migratedState.conversationStreamRateBudgets.map(
              ({ channelId, method, scope }) => ({ channelId, method, scope })
            ),
            [
              {
                channelId: null,
                method: "chat.stopStream",
                scope: "method",
              },
            ]
          );
        })
      )
  );
});
