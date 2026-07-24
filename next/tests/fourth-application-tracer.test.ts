import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Array as EffectArray, Ref } from "effect";
import { ThreadId } from "../src/prototype/domain.ts";
import { HandlerFailure } from "../src/prototype/errors.ts";
import { makePrototypeHarness } from "../src/prototype/runtime.ts";
import {
  LABORER_SLACK_ID,
  normalizedEvent,
} from "../src/prototype/scenario.ts";
import {
  type ConversationAgentRequest,
  ImplementationAgent,
  makeReferenceCodingApplication,
  WorktreeManager,
} from "../src/reference-coding-application.ts";

describe("fourth Application tracer", () => {
  it.effect("selects deal-with-bug with bug workflow identities", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const completion = yield* Deferred.make<void>();
        const conversationRequests = yield* Ref.make<
          readonly ConversationAgentRequest[]
        >([]);
        const implementationRequests = yield* Ref.make<
          readonly {
            readonly actionName: "create-feature" | "deal-with-bug";
            readonly conversationId: string;
            readonly executionId: string;
            readonly implementationSessionId: string;
            readonly prompt: string;
            readonly promptId: string;
            readonly workingDirectory: string;
          }[]
        >([]);
        const delivered = yield* Ref.make<readonly string[]>([]);
        const conversationAgent = {
          handle: Effect.fn("BugConversation.handle")(function* (
            request: ConversationAgentRequest
          ) {
            yield* Ref.update(conversationRequests, (requests) =>
              EffectArray.append(requests, request)
            );
            const input = request.messages.at(-1)?.text ?? "";
            if (input.includes("fix the broken export")) {
              const action = request.actions.find(
                (candidate) => candidate.name === "deal-with-bug"
              );
              assert.ok(action);
              const accepted = yield* action.invoke({
                prompt: "Diagnose and fix the broken export.",
                worktreeName: "bug-broken-export",
              });
              return [
                {
                  replyId: `${request.turnId}:started`,
                  text: `Started ${accepted.executionId}.`,
                },
              ];
            }
            return [
              {
                replyId: `${request.turnId}:status`,
                text: `${request.executions[0]?.actionName ?? "none"} is running.`,
              },
            ];
          }),
        };
        const application = yield* makeReferenceCodingApplication({
          conversationAgent,
          implementationAgent: ImplementationAgent.of({
            start: (request) =>
              Ref.update(implementationRequests, (requests) =>
                EffectArray.append(requests, request)
              ).pipe(
                Effect.as({
                  completion: Deferred.await(completion),
                  resume: () => Effect.void,
                  sessionId: request.implementationSessionId,
                })
              ),
          }),
          worktreeManager: WorktreeManager.of({
            create: (request) =>
              Effect.succeed({
                workingDirectory: `/tmp/laborer-worktrees/${request.worktreeName}`,
              }),
          }),
        });
        const harness = yield* makePrototypeHarness({
          application,
          laborerSlackId: LABORER_SLACK_ID,
          slack: {
            postThreadMessage: (request) =>
              Ref.update(delivered, (messages) =>
                EffectArray.append(messages, request.text)
              ).pipe(Effect.as({ ts: `reply-${request.text}` })),
            readActivationContext: () => Effect.succeed([]),
          },
        });

        yield* harness.runner.inject(
          normalizedEvent({
            authorSlackId: "UHUMAN",
            channelId: "CBUG",
            eventId: "event:bug:start",
            messageTs: "1.0",
            text: `<@${LABORER_SLACK_ID}> fix the broken export`,
          })
        );
        yield* harness.runner.inject(
          normalizedEvent({
            authorSlackId: "UHUMAN",
            channelId: "CBUG",
            eventId: "event:bug:status",
            messageTs: "2.0",
            text: "what is running?",
            threadTs: "1.0",
          })
        );

        assert.deepStrictEqual(yield* Ref.get(implementationRequests), [
          {
            actionName: "deal-with-bug",
            conversationId: "CBUG:1.0",
            executionId: "CBUG:1.0:execution:1",
            implementationSessionId:
              "CBUG:1.0:execution:1:implementation-session:1",
            prompt: "Diagnose and fix the broken export.",
            promptId: "CBUG:1.0:execution:1:prompt:1",
            workingDirectory: "/tmp/laborer-worktrees/bug-broken-export",
          },
        ]);
        assert.deepStrictEqual(
          (yield* Ref.get(conversationRequests))[1]?.executions,
          [
            {
              actionName: "deal-with-bug",
              activePromptId: "CBUG:1.0:execution:1:prompt:1",
              conversationId: ThreadId.make("CBUG:1.0"),
              executionId: "CBUG:1.0:execution:1",
              implementationSessionId:
                "CBUG:1.0:execution:1:implementation-session:1",
              status: "running",
              workingDirectory: "/tmp/laborer-worktrees/bug-broken-export",
              worktreeName: "bug-broken-export",
            },
          ]
        );
        assert.deepStrictEqual(yield* Ref.get(delivered), [
          "Started CBUG:1.0:execution:1.",
          "deal-with-bug is running.",
        ]);
      })
    )
  );

  it.effect(
    "runs feature and bug Executions concurrently with isolated response routing",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const releaseFeature = yield* Deferred.make<void>();
          const releaseBug = yield* Deferred.make<void>();
          const featureResponseAccepted = yield* Deferred.make<void>();
          const bugResponseAccepted = yield* Deferred.make<void>();
          const conversationRequests = yield* Ref.make<
            readonly ConversationAgentRequest[]
          >([]);
          const worktreeRequests = yield* Ref.make<
            readonly {
              readonly executionId: string;
              readonly worktreeName: string;
            }[]
          >([]);
          const implementationRequests = yield* Ref.make<
            readonly {
              readonly actionName: "create-feature" | "deal-with-bug";
              readonly executionId: string;
              readonly workingDirectory: string;
            }[]
          >([]);
          const delivered = yield* Ref.make<readonly string[]>([]);
          const conversationAgent = {
            handle: Effect.fn("ConcurrentConversation.handle")(function* (
              request: ConversationAgentRequest
            ) {
              yield* Ref.update(conversationRequests, (requests) =>
                EffectArray.append(requests, request)
              );
              const input = request.messages.at(-1)?.text ?? "";
              if (input.includes("start feature and bug")) {
                const featureAction = request.actions.find(
                  (candidate) => candidate.name === "create-feature"
                );
                const bugAction = request.actions.find(
                  (candidate) => candidate.name === "deal-with-bug"
                );
                assert.ok(featureAction);
                assert.ok(bugAction);
                const feature = yield* featureAction.invoke({
                  prompt: "Implement the export feature.",
                  worktreeName: "feature-export",
                });
                const bug = yield* bugAction.invoke({
                  prompt: "Fix the import bug.",
                  worktreeName: "bug-import",
                });
                return [
                  {
                    replyId: `${request.turnId}:started`,
                    text: `Started ${feature.executionId} and ${bug.executionId}.`,
                  },
                ];
              }
              if (request.source === "implementation-agent") {
                return [
                  {
                    replyId: `${request.turnId}:routed`,
                    text: `Conversation routed ${request.turnId}.`,
                  },
                ];
              }
              return [
                {
                  replyId: `${request.turnId}:status`,
                  text: `${request.executions.length} Executions are visible.`,
                },
              ];
            }),
          };
          const application = yield* makeReferenceCodingApplication({
            conversationAgent,
            implementationAgent: ImplementationAgent.of({
              start: (request, acceptResponse) =>
                Ref.update(implementationRequests, (requests) =>
                  EffectArray.append(requests, {
                    actionName: request.actionName,
                    executionId: request.executionId,
                    workingDirectory: request.workingDirectory,
                  })
                ).pipe(
                  Effect.as({
                    completion: Effect.gen(function* () {
                      const isFeature = request.actionName === "create-feature";
                      yield* Deferred.await(
                        isFeature ? releaseFeature : releaseBug
                      );
                      yield* acceptResponse({
                        responseId: "response-1",
                        text: isFeature
                          ? "feature implementation response"
                          : "bug implementation response",
                      });
                      yield* Deferred.succeed(
                        isFeature
                          ? featureResponseAccepted
                          : bugResponseAccepted,
                        undefined
                      );
                    }),
                    resume: () => Effect.void,
                    sessionId: request.implementationSessionId,
                  })
                ),
            }),
            worktreeManager: WorktreeManager.of({
              create: (request) =>
                Ref.update(worktreeRequests, (requests) =>
                  EffectArray.append(requests, {
                    executionId: request.executionId,
                    worktreeName: request.worktreeName,
                  })
                ).pipe(
                  Effect.as({
                    workingDirectory: `/tmp/laborer-worktrees/${request.worktreeName}`,
                  })
                ),
            }),
          });
          const harness = yield* makePrototypeHarness({
            application,
            laborerSlackId: LABORER_SLACK_ID,
            slack: {
              postThreadMessage: (request) =>
                Ref.update(delivered, (messages) =>
                  EffectArray.append(messages, request.text)
                ).pipe(Effect.as({ ts: `reply-${request.text}` })),
              readActivationContext: () => Effect.succeed([]),
            },
          });

          yield* harness.runner.inject(
            normalizedEvent({
              authorSlackId: "UHUMAN",
              channelId: "CCONCURRENT",
              eventId: "event:concurrent:start",
              messageTs: "1.0",
              text: `<@${LABORER_SLACK_ID}> start feature and bug`,
            })
          );
          yield* harness.runner.inject(
            normalizedEvent({
              authorSlackId: "UHUMAN",
              channelId: "CCONCURRENT",
              eventId: "event:concurrent:status",
              messageTs: "2.0",
              text: "show both running Executions",
              threadTs: "1.0",
            })
          );

          const requestsBeforeResponses = yield* Ref.get(conversationRequests);
          assert.deepStrictEqual(requestsBeforeResponses[1]?.executions, [
            {
              actionName: "create-feature",
              activePromptId: "CCONCURRENT:1.0:execution:1:prompt:1",
              conversationId: ThreadId.make("CCONCURRENT:1.0"),
              executionId: "CCONCURRENT:1.0:execution:1",
              implementationSessionId:
                "CCONCURRENT:1.0:execution:1:implementation-session:1",
              status: "running",
              workingDirectory: "/tmp/laborer-worktrees/feature-export",
              worktreeName: "feature-export",
            },
            {
              actionName: "deal-with-bug",
              activePromptId: "CCONCURRENT:1.0:execution:2:prompt:1",
              conversationId: ThreadId.make("CCONCURRENT:1.0"),
              executionId: "CCONCURRENT:1.0:execution:2",
              implementationSessionId:
                "CCONCURRENT:1.0:execution:2:implementation-session:1",
              status: "running",
              workingDirectory: "/tmp/laborer-worktrees/bug-import",
              worktreeName: "bug-import",
            },
          ]);
          assert.deepStrictEqual(yield* Ref.get(worktreeRequests), [
            {
              executionId: "CCONCURRENT:1.0:execution:1",
              worktreeName: "feature-export",
            },
            {
              executionId: "CCONCURRENT:1.0:execution:2",
              worktreeName: "bug-import",
            },
          ]);
          assert.deepStrictEqual(yield* Ref.get(implementationRequests), [
            {
              actionName: "create-feature",
              executionId: "CCONCURRENT:1.0:execution:1",
              workingDirectory: "/tmp/laborer-worktrees/feature-export",
            },
            {
              actionName: "deal-with-bug",
              executionId: "CCONCURRENT:1.0:execution:2",
              workingDirectory: "/tmp/laborer-worktrees/bug-import",
            },
          ]);

          yield* Deferred.succeed(releaseFeature, undefined);
          yield* Deferred.succeed(releaseBug, undefined);
          yield* Deferred.await(featureResponseAccepted);
          yield* Deferred.await(bugResponseAccepted);
          yield* harness.runner.drain(ThreadId.make("CCONCURRENT:1.0"));

          const externalInputs = EffectArray.filter(
            yield* Ref.get(conversationRequests),
            (request) => request.source === "implementation-agent"
          ).map((request) => request.input);
          assert.strictEqual(externalInputs.length, 2);
          assert.ok(
            externalInputs.includes(
              '<application-event source="implementation-agent" action-name="create-feature" execution-id="CCONCURRENT:1.0:execution:1" response-id="response-1">feature implementation response</application-event>'
            )
          );
          assert.ok(
            externalInputs.includes(
              '<application-event source="implementation-agent" action-name="deal-with-bug" execution-id="CCONCURRENT:1.0:execution:2" response-id="response-1">bug implementation response</application-event>'
            )
          );
          const messages = yield* Ref.get(delivered);
          assert.ok(
            messages.includes(
              "Conversation routed CCONCURRENT:1.0:execution:1:response:response-1."
            )
          );
          assert.ok(
            messages.includes(
              "Conversation routed CCONCURRENT:1.0:execution:2:response:response-1."
            )
          );
        })
      )
  );

  it.effect(
    "returns a worktree collision to the Conversation and rolls back the Action",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const existingWorktree = {
            mutationCount: 0,
            owner: "pre-existing-execution",
            workingDirectory: "/tmp/laborer-worktrees/taken-name",
          };
          const worktreeState = yield* Ref.make(existingWorktree);
          const worktreeRequests = yield* Ref.make<readonly string[]>([]);
          const implementationStarts = yield* Ref.make<readonly string[]>([]);
          const executionsAfterCollision = yield* Ref.make<
            readonly ConversationAgentRequest["executions"][]
          >([]);
          const delivered = yield* Ref.make<readonly string[]>([]);
          const conversationAgent = {
            handle: Effect.fn("CollisionConversation.handle")(function* (
              request: ConversationAgentRequest
            ) {
              const input = request.messages.at(-1)?.text ?? "";
              if (input.includes("use the taken worktree")) {
                const action = request.actions.find(
                  (candidate) => candidate.name === "deal-with-bug"
                );
                assert.ok(action);
                const outcome = yield* Effect.result(
                  action.invoke({
                    prompt: "Fix the collision bug.",
                    worktreeName: "taken-name",
                  })
                );
                assert.strictEqual(outcome._tag, "Failure");
                if (outcome._tag === "Success") {
                  return [];
                }
                return [
                  {
                    replyId: `${request.turnId}:collision`,
                    text: `Conversation rejected collision: ${outcome.failure.safeDetail}.`,
                  },
                ];
              }
              yield* Ref.update(executionsAfterCollision, (observed) =>
                EffectArray.append(observed, request.executions)
              );
              return [
                {
                  replyId: `${request.turnId}:status`,
                  text: `${request.executions.length} Executions remain.`,
                },
              ];
            }),
          };
          const application = yield* makeReferenceCodingApplication({
            conversationAgent,
            implementationAgent: ImplementationAgent.of({
              start: (request) =>
                Ref.update(implementationStarts, (starts) =>
                  EffectArray.append(starts, request.executionId)
                ).pipe(
                  Effect.as({
                    completion: Effect.void,
                    resume: () => Effect.void,
                    sessionId: "must-not-start",
                  })
                ),
            }),
            worktreeManager: WorktreeManager.of({
              create: (request) =>
                Ref.update(worktreeRequests, (requests) =>
                  EffectArray.append(requests, request.worktreeName)
                ).pipe(
                  Effect.andThen(Ref.get(worktreeState)),
                  Effect.flatMap((existing) => {
                    assert.strictEqual(
                      existing.workingDirectory,
                      `/tmp/laborer-worktrees/${request.worktreeName}`
                    );
                    return HandlerFailure.make({
                      category: "protocol",
                      safeDetail: "worktree name already exists",
                    });
                  })
                ),
            }),
          });
          const harness = yield* makePrototypeHarness({
            application,
            laborerSlackId: LABORER_SLACK_ID,
            slack: {
              postThreadMessage: (request) =>
                Ref.update(delivered, (messages) =>
                  EffectArray.append(messages, request.text)
                ).pipe(Effect.as({ ts: `reply-${request.text}` })),
              readActivationContext: () => Effect.succeed([]),
            },
          });

          yield* harness.runner.inject(
            normalizedEvent({
              authorSlackId: "UHUMAN",
              channelId: "CCOLLISION",
              eventId: "event:collision:start",
              messageTs: "1.0",
              text: `<@${LABORER_SLACK_ID}> use the taken worktree`,
            })
          );
          yield* harness.runner.inject(
            normalizedEvent({
              authorSlackId: "UHUMAN",
              channelId: "CCOLLISION",
              eventId: "event:collision:inspect",
              messageTs: "2.0",
              text: "inspect collision rollback",
              threadTs: "1.0",
            })
          );

          assert.deepStrictEqual(yield* Ref.get(worktreeRequests), [
            "taken-name",
          ]);
          assert.deepStrictEqual(yield* Ref.get(worktreeState), {
            mutationCount: 0,
            owner: "pre-existing-execution",
            workingDirectory: "/tmp/laborer-worktrees/taken-name",
          });
          assert.deepStrictEqual(yield* Ref.get(implementationStarts), []);
          assert.deepStrictEqual(yield* Ref.get(executionsAfterCollision), [
            [],
          ]);
          assert.deepStrictEqual(yield* Ref.get(delivered), [
            "Conversation rejected collision: worktree name already exists.",
            "0 Executions remain.",
          ]);
        })
      )
  );
});
