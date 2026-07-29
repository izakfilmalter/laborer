import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Ref } from "effect";
import { Application, ConversationBlocked } from "../src/application.ts";
import { RECOVERY_NOTICE_TEXT } from "../src/prototype/recovery-notice.ts";
import { makePrototypeHarness } from "../src/prototype/runtime.ts";
import {
  LABORER_SLACK_ID,
  normalizedEvent,
} from "../src/prototype/scenario.ts";
import {
  inspectAcpRecoveryHealthOffline,
  inspectAcpRecoveryOffline,
} from "../src/slack/acp-recovery.ts";
import { slackCodePointLength } from "../src/slack/message-bounds.ts";
import { prepareSlackRuntimePaths } from "../src/slack/runtime-paths.ts";

const BLOCKED_NOTICE_PATTERN =
  /^\*Paused — an operator decision is needed\.\*\n.*\n• \*Abandon\* — .*\n• \*Retry\* — .*duplicate.*\n/s;
const ABANDONED_NOTICE_PATTERN =
  /^\*Resumed — the uncertain attempt was abandoned\.\*\n.*replacement agent session/s;
const RETRY_NOTICE_PATTERN =
  /^\*Resumed — the uncertain attempt was retried\.\*\n.*duplicated.*replacement agent session/s;
const UNSAFE_NOTICE_PATTERN = /attempt-|prompt-|session-|decision-|\/|--|<@/;
const UNSAFE_AUTHORITY_KEY_PATTERN = /unsafe recovery authority key/;

describe("issue #253 ambiguous ACP recovery", () => {
  it("presents both operator choices and a sanitized outcome in Slack", () => {
    assert.match(RECOVERY_NOTICE_TEXT.blocked, BLOCKED_NOTICE_PATTERN);
    assert.match(RECOVERY_NOTICE_TEXT.abandon, ABANDONED_NOTICE_PATTERN);
    assert.match(RECOVERY_NOTICE_TEXT.retry, RETRY_NOTICE_PATTERN);
    assert.include(RECOVERY_NOTICE_TEXT.blocked, "queued in order");
    for (const notice of Object.values(RECOVERY_NOTICE_TEXT)) {
      assert.isBelow(slackCodePointLength(notice), 1000);
      assert.notMatch(
        notice,
        UNSAFE_NOTICE_PATTERN,
        "recovery notices stay sanitized and free of identifiers, paths, and flags"
      );
    }
  });

  it("returns bounded opaque correlations across the recovery boundary", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "laborer-253-inspection-"));
    try {
      const paths = await Effect.runPromise(
        prepareSlackRuntimePaths(root, "T253")
      );
      const conversationId = "workspace:T253:C253:1.0";
      const attemptId = "attempt-private-253";
      const promptId = "prompt-private-253";
      await Promise.all([
        writeFile(paths.acpAuthorityKey, "authority-key-253"),
        writeFile(
          paths.acpActionAuthorityState,
          JSON.stringify({ records: [] })
        ),
        writeFile(paths.acpAuthorityState, JSON.stringify({ records: [] })),
        writeFile(paths.acpPermissionUiOutbox, JSON.stringify({ entries: [] })),
        writeFile(
          paths.acpProcessState,
          JSON.stringify({ activeGeneration: 12, health: "ready" })
        ),
        writeFile(
          paths.applicationState,
          JSON.stringify({
            conversations: [
              {
                agentSessionBinding: { sessionId: "session-private-253" },
                conversationId,
                prompts: [
                  {
                    attempts: [
                      {
                        attemptId,
                        bindingGeneration: 9,
                        processGeneration: 11,
                        recoveryClass: "unresolved",
                      },
                    ],
                    ownerId: "turn-private-253",
                    ownerKind: "participant-turn",
                    promptId,
                  },
                ],
              },
            ],
            executions: [
              {
                attachment: { state: "unresolved" },
                conversationId,
                executionId: "execution-private-253",
                status: "running",
              },
            ],
            recoveryDecisions: [],
          })
        ),
        writeFile(
          paths.runnerState,
          JSON.stringify({
            conversationStreams: [
              {
                id: "stream-private-253",
                lifecycle: "unresolved",
                ownerId: "turn-private-253",
                ownerKind: "participant-turn",
              },
            ],
            threads: [
              {
                applicationEvents: [],
                applicationInputQueue: [],
                id: conversationId,
                turns: [{ id: "turn-private-253", status: "blocked" }],
              },
            ],
          })
        ),
      ]);

      const inspection = await inspectAcpRecoveryOffline({
        attemptId,
        paths,
        workspaceId: "T253",
      });
      assert.strictEqual(inspection.correlations.bindingGeneration, 9);
      assert.strictEqual(inspection.correlations.processGeneration, 11);
      assert.lengthOf(inspection.correlations.executionDigests, 1);
      assert.lengthOf(inspection.correlations.streamDigests, 1);
      assert.strictEqual(inspection.evidence.execution.count, 1);
      assert.strictEqual(inspection.evidence.execution.nonterminalCount, 1);
      assert.strictEqual(inspection.evidence.execution.unresolvedCount, 1);
      const health = await inspectAcpRecoveryHealthOffline({
        paths,
        workspaceId: "T253",
      });
      assert.strictEqual(health.counts.executionUncertain, 2);
      assert.include(health.reasonCodes, "execution-outcome-uncertain");
      const serialized = JSON.stringify(inspection);
      for (const privateIdentity of [
        conversationId,
        "session-private-253",
        "execution-private-253",
        "stream-private-253",
        "turn-private-253",
      ]) {
        assert.notInclude(serialized, privateIdentity);
      }
      await writeFile(paths.acpAuthorityKey, Buffer.alloc(4097, "x"));
      let oversizedKeyFailure: unknown = null;
      try {
        await inspectAcpRecoveryOffline({
          attemptId,
          paths,
          workspaceId: "T253",
        });
      } catch (cause) {
        oversizedKeyFailure = cause;
      }
      assert.instanceOf(oversizedKeyFailure, Error);
      assert.match(oversizedKeyFailure.message, UNSAFE_AUTHORITY_KEY_PATTERN);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it.effect(
    "blocks the durable owner and releases FIFO work only after abandon",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const calls = yield* Ref.make<readonly string[]>([]);
          const recoveryDecisionIds = yield* Ref.make<readonly string[]>([]);
          const application = Application.of({
            decideConversationRecovery: (request) =>
              Ref.modify(recoveryDecisionIds, (decisionIds) => [
                {
                  acknowledgeDuplicateSideEffects:
                    request.acknowledgeDuplicateSideEffects,
                  attemptId: request.attemptId,
                  conversationId: request.conversationId,
                  decisionId: request.decisionId,
                  duplicate: decisionIds.includes(request.decisionId),
                  kind: request.kind,
                  ownerId: request.ownerId,
                  ownerKind: request.ownerKind,
                  promptId: request.promptId,
                  replacementAttemptId: null,
                  sessionDisposition: "replaced" as const,
                  workspaceId: request.workspaceId,
                },
                [...decisionIds, request.decisionId],
              ]),
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
          assert.match(
            before?.outbox.find((item) => item.id.includes("recovery:blocked"))
              ?.text ?? "",
            BLOCKED_NOTICE_PATTERN
          );
          assert.deepStrictEqual(yield* Ref.get(calls), [blocked.ownerId]);

          const decide = harness.runner.decideConversationRecovery;
          assert.ok(decide !== undefined);
          const request = {
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
          } as const;
          const firstDecision = yield* decide(request);
          const duplicateDecision = yield* decide(request);
          assert.isFalse(firstDecision.duplicate);
          assert.isTrue(duplicateDecision.duplicate);
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
          assert.match(
            after?.outbox.find((item) => item.id.includes("recovery:abandon"))
              ?.text ?? "",
            ABANDONED_NOTICE_PATTERN
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
            ["interrupted", "succeeded"]
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
          assert.match(
            thread?.outbox.find((item) => item.id.includes("recovery:retry"))
              ?.text ?? "",
            RETRY_NOTICE_PATTERN
          );
        })
      )
  );
});
