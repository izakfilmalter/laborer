import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { ThreadId } from "../src/prototype/domain.ts";
import {
  makeFileApplicationRepository,
  makeReferenceCodingApplication,
} from "../src/reference-coding-application.ts";
import { makeTempDirectoryScoped } from "./support/temp-directory.ts";

describe("issue #252 Application v9 prompt attempts", () => {
  it.effect(
    "migrates v8 completed, staged, and running prompts conservatively",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped("application-v9-");
          const path = join(root, "application.json");
          yield* Effect.promise(() =>
            writeFile(
              path,
              JSON.stringify({
                actionOperationTombstones: [],
                actionOperations: [],
                conversations: [
                  {
                    agentSessionBinding: null,
                    conversationId: "conversation-v8",
                    prompts: [
                      {
                        fingerprint: "staged",
                        promptId: "prompt-staged",
                        replies: [],
                        status: "staged",
                      },
                      {
                        fingerprint: "running",
                        promptId: "prompt-running",
                        replies: [],
                        status: "running",
                      },
                      {
                        fingerprint: "completed",
                        promptId: "prompt-completed",
                        replies: [],
                        status: "completed",
                      },
                    ],
                    sessionId: "logical-session",
                  },
                ],
                executions: [],
                schemaVersion: 8,
              }),
              { mode: 0o600 }
            )
          );
          const repository = yield* makeFileApplicationRepository(path, root);
          const state = yield* repository.load;
          assert.strictEqual(state.schemaVersion, 16);
          const prompts = state.conversations[0]?.prompts ?? [];
          assert.strictEqual(prompts[0]?.attempts.length, 0);
          assert.strictEqual(
            prompts[1]?.attempts[0]?.recoveryClass,
            "unresolved"
          );
          assert.strictEqual(prompts[1]?.attempts[0]?.phase, "interrupted");
          assert.strictEqual(
            prompts[2]?.attempts[0]?.recoveryClass,
            "terminal"
          );
          assert.strictEqual(prompts[2]?.attempts[0]?.outcome, "unknown_stop");
          assert.ok(
            (yield* Effect.promise(() => readFile(path, "utf8"))).includes(
              '"schemaVersion":16'
            )
          );
        })
      )
  );

  it.effect("migrates v10 Executions to bounded v11 cancellation records", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped("application-v11-");
        const path = join(root, "application.json");
        yield* Effect.promise(() =>
          writeFile(
            path,
            JSON.stringify({
              actionOperationTombstones: [],
              actionOperations: [],
              conversations: [],
              executionPromptOperations: [],
              executions: [
                {
                  actionInvocationId: "action-v10",
                  actionName: "create-feature",
                  conversationId: "workspace:T249:C249:249.1",
                  events: [],
                  executionId: "execution-v10",
                  implementationSessionId: "session-v10",
                  prompts: [
                    {
                      kind: "initial",
                      promptId: "prompt-v10",
                      status: "running",
                      text: "Continue v10 work.",
                    },
                  ],
                  responses: [],
                  status: "running",
                  workingDirectory: "/tmp/v10-worktree",
                  worktreeName: "v10-worktree",
                },
              ],
              schemaVersion: 10,
            }),
            { mode: 0o600 }
          )
        );
        const repository = yield* makeFileApplicationRepository(path, root);
        const state = yield* repository.load;
        assert.strictEqual(state.schemaVersion, 16);
        assert.strictEqual(state.executions[0]?.cancellation, null);
        assert.strictEqual(state.executions[0]?.ownerWorkspaceId, "T249");
        assert.ok(
          (yield* Effect.promise(() => readFile(path, "utf8"))).includes(
            '"schemaVersion":16'
          )
        );
      })
    )
  );

  it.effect(
    "requires explicit duplicate-risk acknowledgement and rejects conflicting recovery decisions",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "application-v12-recovery-decision-"
          );
          const path = join(root, "application.json");
          const conversationId = ThreadId.make("workspace:T253:C253:1.0");
          yield* Effect.promise(() =>
            writeFile(
              path,
              JSON.stringify({
                actionOperationTombstones: [],
                actionOperations: [],
                conversations: [
                  {
                    agentSessionBinding: null,
                    conversationId,
                    prompts: [
                      {
                        attempts: [
                          {
                            attemptId: "attempt-v11-recovery",
                            bindingGeneration: 3,
                            cancellationIntent: null,
                            interruptedAt: 20,
                            outcome: null,
                            phase: "interrupted",
                            preparedAt: 10,
                            processGeneration: 4,
                            publicOutputObserved: true,
                            recoveryClass: "unresolved",
                            sessionDigest: "session-digest-v11",
                            submittedAt: 15,
                            terminalAt: null,
                          },
                        ],
                        fingerprint: "bounded fingerprint",
                        ownerId: "turn-253",
                        ownerKind: "participant-turn",
                        promptId: "prompt-v11-recovery",
                        replies: [],
                        status: "running",
                        workspaceId: "T253",
                      },
                    ],
                    sessionId: "logical-v11",
                  },
                ],
                executionPromptOperations: [],
                executions: [],
                schemaVersion: 11,
              }),
              { mode: 0o600 }
            )
          );
          const repository = yield* makeFileApplicationRepository(path, root);
          const application = yield* makeReferenceCodingApplication({
            conversationAgent: {
              handle: () => Effect.never,
              recover: () => Effect.never,
              replaceAmbiguousSession: () => Effect.void,
            },
            implementationAgent: { start: () => Effect.never },
            repository,
            worktreeManager: { create: () => Effect.never },
          });
          const decide = application.decideConversationRecovery;
          assert.ok(decide !== undefined);
          const request = {
            acknowledgeDuplicateSideEffects: false,
            actorUid: process.getuid?.() ?? 0,
            attemptId: "attempt-v11-recovery",
            bindingGeneration: 3,
            conversationId,
            decisionId: "decision-v12-retry",
            kind: "retry" as const,
            ownerId: "turn-253",
            ownerKind: "participant-turn" as const,
            processGeneration: 4,
            promptId: "prompt-v11-recovery",
            timestamp: 30,
            workspaceId: "T253",
          };
          const unacknowledged = yield* Effect.result(decide(request));
          assert.strictEqual(unacknowledged._tag, "Failure");
          if (unacknowledged._tag === "Failure") {
            assert.strictEqual(
              unacknowledged.failure._tag,
              "ConversationRecoveryDecisionRejected"
            );
            assert.strictEqual(
              unacknowledged.failure._tag ===
                "ConversationRecoveryDecisionRejected"
                ? unacknowledged.failure.reason
                : null,
              "duplicate-risk-not-acknowledged"
            );
          }

          const accepted = yield* decide({
            ...request,
            acknowledgeDuplicateSideEffects: true,
          });
          assert.strictEqual(accepted.duplicate, false);
          assert.ok(accepted.replacementAttemptId !== null);
          const duplicate = yield* decide({
            ...request,
            acknowledgeDuplicateSideEffects: true,
            timestamp: 31,
          });
          assert.strictEqual(duplicate.duplicate, true);
          assert.strictEqual(
            duplicate.replacementAttemptId,
            accepted.replacementAttemptId
          );
          const conflicting = yield* Effect.result(
            decide({
              ...request,
              acknowledgeDuplicateSideEffects: false,
              kind: "abandon",
              timestamp: 32,
            })
          );
          assert.strictEqual(conflicting._tag, "Failure");
          if (conflicting._tag === "Failure") {
            assert.strictEqual(
              conflicting.failure._tag ===
                "ConversationRecoveryDecisionRejected"
                ? conflicting.failure.reason
                : null,
              "conflict"
            );
          }
          const state = yield* repository.load;
          assert.strictEqual(state.recoveryDecisions.length, 1);
          assert.strictEqual(
            state.conversations[0]?.prompts[0]?.attempts[0]
              ?.resolutionDecisionId,
            request.decisionId
          );
        })
      )
  );

  it.effect("migrates v11 without compacting unresolved attempt evidence", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped("application-v12-");
        const path = join(root, "application.json");
        yield* Effect.promise(() =>
          writeFile(
            path,
            JSON.stringify({
              actionOperationTombstones: [],
              actionOperations: [],
              conversations: [
                {
                  agentSessionBinding: null,
                  conversationId: "workspace:T253:C253:1.0",
                  prompts: [
                    {
                      attempts: [
                        {
                          attemptId: "attempt-v11-unresolved",
                          bindingGeneration: 3,
                          cancellationIntent: null,
                          interruptedAt: 20,
                          outcome: null,
                          phase: "interrupted",
                          preparedAt: 10,
                          processGeneration: 4,
                          publicOutputObserved: true,
                          recoveryClass: "unresolved",
                          sessionDigest: "session-digest-v11",
                          submittedAt: 15,
                          terminalAt: null,
                        },
                      ],
                      fingerprint: "bounded fingerprint",
                      promptId: "prompt-v11-unresolved",
                      replies: [],
                      status: "running",
                    },
                  ],
                  sessionId: "logical-v11",
                },
              ],
              executionPromptOperations: [],
              executions: [],
              schemaVersion: 11,
            }),
            { mode: 0o600 }
          )
        );
        const repository = yield* makeFileApplicationRepository(path, root);
        const state = yield* repository.load;
        assert.strictEqual(state.schemaVersion, 16);
        const attempt = state.conversations[0]?.prompts[0]?.attempts[0];
        assert.strictEqual(attempt?.attemptId, "attempt-v11-unresolved");
        assert.strictEqual(attempt?.recoveryClass, "unresolved");
        assert.strictEqual(attempt?.publicOutputObserved, true);
        assert.deepStrictEqual(state.recoveryDecisions, []);
      })
    )
  );
});
