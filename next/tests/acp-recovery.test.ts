import { assert, describe, it } from "@effect/vitest";
import { Effect, Ref } from "effect";
import { Application, ConversationBlocked } from "../src/application.ts";
import { makePrototypeHarness } from "../src/prototype/runtime.ts";
import {
  LABORER_SLACK_ID,
  normalizedEvent,
} from "../src/prototype/scenario.ts";

describe("issue #253 ambiguous ACP recovery", () => {
  it.effect(
    "blocks the durable owner and releases FIFO work only after abandon",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const calls = yield* Ref.make<readonly string[]>([]);
          const application = Application.of({
            decideConversationRecovery: (request) =>
              Effect.succeed({
                acknowledgeDuplicateSideEffects:
                  request.acknowledgeDuplicateSideEffects,
                attemptId: request.attemptId,
                conversationId: request.conversationId,
                decisionId: request.decisionId,
                duplicate: false,
                kind: request.kind,
                ownerId: request.ownerId,
                ownerKind: request.ownerKind,
                promptId: request.promptId,
                replacementAttemptId: null,
                sessionDisposition: "replaced" as const,
                workspaceId: request.workspaceId,
              }),
            handle: (event) =>
              Effect.gen(function* () {
                const ownerId =
                  event._tag === "ParticipantInput"
                    ? event.turnId
                    : event.eventId;
                const observed = yield* Ref.get(calls);
                yield* Ref.set(calls, [...observed, ownerId]);
                if (observed.length === 0) {
                  return yield* ConversationBlocked.make({
                    attemptId: "attempt-253",
                    bindingGeneration: 7,
                    blockedAt: 100,
                    conversationId: event.conversationId,
                    decisionId: null,
                    decisionKind: null,
                    ownerId,
                    ownerKind:
                      event._tag === "ParticipantInput"
                        ? "participant-turn"
                        : "application-event",
                    processGeneration: 4,
                    promptId: "prompt-253",
                    replacementAttemptId: null,
                    sessionDisposition: null,
                    workspaceId: "T253",
                  });
                }
              }),
          });
          const harness = yield* makePrototypeHarness({
            application,
            laborerSlackId: LABORER_SLACK_ID,
            slack: {
              postThreadMessage: () => Effect.succeed({ ts: "notice-ts" }),
              readActivationContext: () => Effect.succeed([]),
            },
          });
          yield* harness.runner.inject(
            normalizedEvent({
              authorSlackId: "U253",
              channelId: "C253",
              eventId: "event-253-1",
              messageTs: "1.0",
              text: `<@${LABORER_SLACK_ID}> begin`,
              workspaceId: "T253",
            })
          );
          yield* harness.runner.inject(
            normalizedEvent({
              authorSlackId: "U253",
              channelId: "C253",
              eventId: "event-253-2",
              messageTs: "2.0",
              text: "later work",
              threadTs: "1.0",
              workspaceId: "T253",
            })
          );
          const listConversationBlocks = harness.runner.listConversationBlocks;
          assert.ok(listConversationBlocks !== undefined);
          const blocked = (yield* listConversationBlocks)[0];
          assert.ok(blocked);
          const before = (yield* harness.store.snapshot).threads[0];
          assert.strictEqual(before?.turns[0]?.status, "blocked");
          assert.strictEqual(before?.applicationInputQueue.length, 1);
          assert.deepStrictEqual(yield* Ref.get(calls), [blocked.ownerId]);

          const decide = harness.runner.decideConversationRecovery;
          assert.ok(decide !== undefined);
          yield* decide({
            acknowledgeDuplicateSideEffects: false,
            actorUid: process.getuid?.() ?? 0,
            attemptId: blocked.attemptId,
            bindingGeneration: blocked.bindingGeneration,
            conversationId: blocked.conversationId,
            decisionId: "decision-253-abandon",
            kind: "abandon",
            ownerId: blocked.ownerId,
            ownerKind: blocked.ownerKind,
            processGeneration: blocked.processGeneration,
            promptId: blocked.promptId,
            timestamp: 200,
            workspaceId: blocked.workspaceId,
          });
          const after = (yield* harness.store.snapshot).threads[0];
          assert.deepStrictEqual(
            after?.turns.map((turn) => turn.status),
            ["completed", "completed"]
          );
          const secondTurn = after?.turns[1];
          assert.ok(secondTurn);
          assert.deepStrictEqual(yield* Ref.get(calls), [
            blocked.ownerId,
            secondTurn.id,
          ]);
          assert.strictEqual(
            after?.outbox.filter((item) => item.id.includes("recovery:blocked"))
              .length,
            1
          );
          assert.strictEqual(
            after?.outbox.filter((item) => item.id.includes("recovery:abandon"))
              .length,
            1
          );
        })
      )
  );

  it.effect(
    "retries under a fresh attempt and then releases queued work in FIFO order",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const calls = yield* Ref.make<readonly string[]>([]);
          const application = Application.of({
            decideConversationRecovery: (request) =>
              Effect.succeed({
                acknowledgeDuplicateSideEffects:
                  request.acknowledgeDuplicateSideEffects,
                attemptId: request.attemptId,
                conversationId: request.conversationId,
                decisionId: request.decisionId,
                duplicate: false,
                kind: request.kind,
                ownerId: request.ownerId,
                ownerKind: request.ownerKind,
                promptId: request.promptId,
                replacementAttemptId: "replacement-attempt-253",
                sessionDisposition: "replaced" as const,
                workspaceId: request.workspaceId,
              }),
            handle: (event) =>
              Effect.gen(function* () {
                const ownerId =
                  event._tag === "ParticipantInput"
                    ? event.turnId
                    : event.eventId;
                const observed = yield* Ref.get(calls);
                yield* Ref.set(calls, [...observed, ownerId]);
                if (observed.length === 0) {
                  return yield* ConversationBlocked.make({
                    attemptId: "attempt-253-retry",
                    bindingGeneration: 7,
                    blockedAt: 100,
                    conversationId: event.conversationId,
                    decisionId: null,
                    decisionKind: null,
                    ownerId,
                    ownerKind:
                      event._tag === "ParticipantInput"
                        ? "participant-turn"
                        : "application-event",
                    processGeneration: 4,
                    promptId: "prompt-253-retry",
                    replacementAttemptId: null,
                    sessionDisposition: null,
                    workspaceId: "T253",
                  });
                }
              }),
          });
          const harness = yield* makePrototypeHarness({
            application,
            laborerSlackId: LABORER_SLACK_ID,
            slack: {
              postThreadMessage: () => Effect.succeed({ ts: "notice-ts" }),
              readActivationContext: () => Effect.succeed([]),
            },
          });
          yield* harness.runner.inject(
            normalizedEvent({
              authorSlackId: "U253",
              channelId: "C253",
              eventId: "event-253-retry-1",
              messageTs: "3.0",
              text: `<@${LABORER_SLACK_ID}> begin`,
              workspaceId: "T253",
            })
          );
          yield* harness.runner.inject(
            normalizedEvent({
              authorSlackId: "U253",
              channelId: "C253",
              eventId: "event-253-retry-2",
              messageTs: "4.0",
              text: "later work",
              threadTs: "3.0",
              workspaceId: "T253",
            })
          );
          const listConversationBlocks = harness.runner.listConversationBlocks;
          const decide = harness.runner.decideConversationRecovery;
          assert.ok(listConversationBlocks !== undefined);
          assert.ok(decide !== undefined);
          const blocked = (yield* listConversationBlocks)[0];
          assert.ok(blocked);
          yield* decide({
            acknowledgeDuplicateSideEffects: true,
            actorUid: process.getuid?.() ?? 0,
            attemptId: blocked.attemptId,
            bindingGeneration: blocked.bindingGeneration,
            conversationId: blocked.conversationId,
            decisionId: "decision-253-retry",
            kind: "retry",
            ownerId: blocked.ownerId,
            ownerKind: blocked.ownerKind,
            processGeneration: blocked.processGeneration,
            promptId: blocked.promptId,
            timestamp: 200,
            workspaceId: blocked.workspaceId,
          });
          const thread = (yield* harness.store.snapshot).threads[0];
          assert.deepStrictEqual(
            thread?.turns.map((turn) => turn.status),
            ["completed", "completed"]
          );
          assert.deepStrictEqual(
            thread?.turns[0]?.attempts.map((attempt) => attempt.status),
            ["interrupted", "interrupted", "succeeded"]
          );
          const secondTurn = thread?.turns[1];
          assert.ok(secondTurn);
          assert.deepStrictEqual(yield* Ref.get(calls), [
            blocked.ownerId,
            blocked.ownerId,
            secondTurn.id,
          ]);
          assert.strictEqual(
            thread?.outbox.filter((item) => item.id.includes("recovery:retry"))
              .length,
            1
          );
        })
      )
  );
});
