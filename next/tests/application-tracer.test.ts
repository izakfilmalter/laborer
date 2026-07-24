import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Array as EffectArray, Option, Ref } from "effect";
import {
  Application,
  ApplicationPublicReply,
  ExternalInputEvent,
} from "../src/application.ts";
import { ThreadId } from "../src/prototype/domain.ts";
import { makePrototypeHarness } from "../src/prototype/runtime.ts";
import {
  LABORER_SLACK_ID,
  normalizedEvent,
} from "../src/prototype/scenario.ts";
import {
  type ConversationAgentRequest,
  ImplementationAgent,
  type ImplementationAgentResponse,
  type ImplementationAgentResumeRequest,
  makeReferenceCodingApplication,
  WorktreeManager,
} from "../src/reference-coding-application.ts";

describe("event-driven Application tracer", () => {
  it.effect(
    "runs one persistent repository-aware Conversation without coding resources",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const repositoryRoot = process.cwd();
          const conversationTurns = new Map<string, number>();
          const observedEvents = yield* Ref.make<
            readonly {
              readonly conversationId: string;
              readonly source: string;
              readonly workingDirectory: string | null;
            }[]
          >([]);
          const delivered = yield* Ref.make<
            readonly {
              readonly channelId: string;
              readonly rootTs: string;
              readonly text: string;
            }[]
          >([]);
          const application = Application.of({
            handle: Effect.fn("TestRepositoryConversation.handle")(
              function* (event, publish) {
                assert.strictEqual(event._tag, "ParticipantInput");
                if (event._tag !== "ParticipantInput") {
                  return;
                }
                const packageJson = JSON.parse(
                  yield* Effect.promise(() =>
                    readFile(join(repositoryRoot, "package.json"), "utf8")
                  )
                ) as { readonly name: string };
                const turn =
                  (conversationTurns.get(event.conversationId) ?? 0) + 1;
                conversationTurns.set(event.conversationId, turn);
                yield* Ref.update(observedEvents, (events) =>
                  EffectArray.append(events, {
                    conversationId: event.conversationId,
                    source: event.source,
                    workingDirectory: event.workingDirectory,
                  })
                );
                yield* publish(
                  ApplicationPublicReply.make({
                    replyId: `${event.turnId}:conversation`,
                    text: `${packageJson.name} conversation turn ${turn}`,
                  })
                );
              }
            ),
          });
          const harness = yield* makePrototypeHarness({
            application,
            laborerSlackId: LABORER_SLACK_ID,
            slack: {
              postThreadMessage: (request) =>
                Ref.update(delivered, (messages) =>
                  EffectArray.append(messages, request)
                ).pipe(Effect.as({ ts: `reply-${request.text}` })),
              readActivationContext: () => Effect.succeed([]),
            },
          });

          yield* harness.runner.inject(
            normalizedEvent({
              authorSlackId: "UHUMAN",
              channelId: "CAPPLICATION",
              eventId: "event:application:activation",
              messageTs: "1.0",
              text: `<@${LABORER_SLACK_ID}> which repository is this?`,
            })
          );
          yield* harness.runner.inject(
            normalizedEvent({
              authorSlackId: "UHUMAN",
              channelId: "CAPPLICATION",
              eventId: "event:application:follow-up",
              messageTs: "2.0",
              text: "and is this still the same conversation?",
              threadTs: "1.0",
            })
          );

          const events = yield* Ref.get(observedEvents);
          assert.deepStrictEqual(events, [
            {
              conversationId: "CAPPLICATION:1.0",
              source: "slack",
              workingDirectory: null,
            },
            {
              conversationId: "CAPPLICATION:1.0",
              source: "slack",
              workingDirectory: null,
            },
          ]);
          assert.deepStrictEqual(yield* Ref.get(delivered), [
            {
              channelId: "CAPPLICATION",
              rootTs: "1.0",
              text: "@laborer/slack-tracer-prototype conversation turn 1",
            },
            {
              channelId: "CAPPLICATION",
              rootTs: "1.0",
              text: "@laborer/slack-tracer-prototype conversation turn 2",
            },
          ]);
          const thread = (yield* harness.store.snapshot).threads[0];
          assert.ok(thread);
          assert.strictEqual(thread.initializationStatus, "not_applicable");
          assert.strictEqual(thread.workingDirectory, null);
          assert.deepStrictEqual(
            thread.turns.map((turn) => turn.status),
            ["completed", "completed"]
          );
          assert.ok(thread.outbox.every((item) => item.status === "delivered"));
        })
      )
  );

  it.effect(
    "starts one feature Execution asynchronously while its Conversation stays responsive",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const worktreeName = "feature-action-escalation";
          const completePrompt = `Implement action escalation end to end.

Preserve the Runner boundary and prove the behavior with integration tests.`;
          const implementationCompletion = yield* Deferred.make<void>();
          const conversationRequests = yield* Ref.make<
            readonly ConversationAgentRequest[]
          >([]);
          const worktreeRequests = yield* Ref.make<
            readonly {
              readonly conversationId: string;
              readonly executionId: string;
              readonly worktreeName: string;
            }[]
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
          const delivered = yield* Ref.make<
            readonly {
              readonly channelId: string;
              readonly rootTs: string;
              readonly text: string;
            }[]
          >([]);
          const conversationAgent = {
            handle: Effect.fn("FakeConversationAgent.handle")(function* (
              request: ConversationAgentRequest
            ) {
              yield* Ref.update(conversationRequests, (requests) =>
                EffectArray.append(requests, request)
              );
              const message = request.messages.at(-1)?.text;
              if (message?.includes("implement action escalation") === true) {
                const createFeature = request.actions.find(
                  (action) => action.name === "create-feature"
                );
                assert.ok(createFeature);
                const accepted = yield* createFeature.invoke({
                  prompt: completePrompt,
                  worktreeName,
                });
                return [
                  {
                    replyId: `${request.turnId}:accepted`,
                    text: `Started ${accepted.executionId}.`,
                  },
                ];
              }
              const running = request.executions.find(
                (execution) => execution.status === "running"
              );
              return [
                {
                  replyId: `${request.turnId}:status`,
                  text:
                    running === undefined
                      ? "No implementation is running."
                      : `${running.executionId} is still running.`,
                },
              ];
            }),
          };
          const worktreeManager = WorktreeManager.of({
            create: (request) =>
              Ref.update(worktreeRequests, (requests) =>
                EffectArray.append(requests, request)
              ).pipe(
                Effect.as({
                  workingDirectory: `/tmp/laborer-worktrees/${request.worktreeName}`,
                })
              ),
          });
          const implementationAgent = ImplementationAgent.of({
            start: (request) =>
              Ref.update(implementationRequests, (requests) =>
                EffectArray.append(requests, request)
              ).pipe(
                Effect.as({
                  completion: Deferred.await(implementationCompletion),
                  resume: () => Effect.void,
                  sessionId: request.implementationSessionId,
                })
              ),
          });
          const application = yield* makeReferenceCodingApplication({
            conversationAgent,
            implementationAgent,
            worktreeManager,
          });
          const harness = yield* makePrototypeHarness({
            application,
            laborerSlackId: LABORER_SLACK_ID,
            slack: {
              postThreadMessage: (request) =>
                Ref.update(delivered, (messages) =>
                  EffectArray.append(messages, request)
                ).pipe(Effect.as({ ts: `reply-${request.text}` })),
              readActivationContext: () => Effect.succeed([]),
            },
          });

          yield* harness.runner.inject(
            normalizedEvent({
              authorSlackId: "UHUMAN",
              channelId: "CFEATURE",
              eventId: "event:feature:start",
              messageTs: "1.0",
              text: `<@${LABORER_SLACK_ID}> implement action escalation`,
            })
          );
          yield* harness.runner.inject(
            normalizedEvent({
              authorSlackId: "UHUMAN",
              channelId: "CFEATURE",
              eventId: "event:feature:status",
              messageTs: "2.0",
              text: "is the implementation still running?",
              threadTs: "1.0",
            })
          );

          const requests = yield* Ref.get(conversationRequests);
          assert.deepStrictEqual(
            requests.map((request) =>
              request.actions.map((action) => action.name)
            ),
            [
              ["create-feature", "deal-with-bug"],
              ["create-feature", "deal-with-bug"],
            ]
          );
          assert.deepStrictEqual(
            requests.map((request) =>
              request.executionControls.map((control) => control.name)
            ),
            [
              ["cancel", "prompt"],
              ["cancel", "prompt"],
            ]
          );
          assert.deepStrictEqual(
            requests[0]?.executionControls.map(
              (control) => control.description
            ),
            [
              'Cancel an owned active Execution. Input must be {"control":"cancel","executionId":"<owned id>"}.',
              'Send a follow-up prompt to an owned Execution. Input must be {"executionId":"<owned id>","prompt":"<follow-up request>"}.',
            ]
          );
          assert.strictEqual(requests[0]?.executions.length, 0);
          assert.deepStrictEqual(requests[1]?.executions, [
            {
              actionName: "create-feature",
              activePromptId:
                "msg_846dc0e98df36c83e5d06e7420ef993c7d90f33e41bcebac26fb69bb2d01834e",
              conversationId: ThreadId.make("CFEATURE:1.0"),
              executionId: "CFEATURE:1.0:execution:1",
              implementationSessionId:
                "ses_36a0106cb8f830953dbb007ab6d832441a667ddb539904667b98947d720aa6e3",
              status: "running",
              workingDirectory: `/tmp/laborer-worktrees/${worktreeName}`,
              worktreeName,
            },
          ]);
          assert.deepStrictEqual(yield* Ref.get(worktreeRequests), [
            {
              conversationId: "CFEATURE:1.0",
              executionId: "CFEATURE:1.0:execution:1",
              worktreeName,
            },
          ]);
          assert.deepStrictEqual(yield* Ref.get(implementationRequests), [
            {
              actionName: "create-feature",
              conversationId: "CFEATURE:1.0",
              executionId: "CFEATURE:1.0:execution:1",
              implementationSessionId:
                "ses_36a0106cb8f830953dbb007ab6d832441a667ddb539904667b98947d720aa6e3",
              prompt: completePrompt,
              promptId:
                "msg_846dc0e98df36c83e5d06e7420ef993c7d90f33e41bcebac26fb69bb2d01834e",
              workingDirectory: `/tmp/laborer-worktrees/${worktreeName}`,
            },
          ]);
          assert.ok(
            Option.isNone(yield* Deferred.poll(implementationCompletion)),
            "implementation must remain blocked during the status turn"
          );
          assert.deepStrictEqual(yield* Ref.get(delivered), [
            {
              channelId: "CFEATURE",
              rootTs: "1.0",
              text: "Started CFEATURE:1.0:execution:1.",
            },
            {
              channelId: "CFEATURE",
              rootTs: "1.0",
              text: "CFEATURE:1.0:execution:1 is still running.",
            },
          ]);
          const thread = (yield* harness.store.snapshot).threads[0];
          assert.deepStrictEqual(
            thread?.turns.map((turn) => turn.status),
            ["completed", "completed"]
          );
        })
      )
  );

  it.effect(
    "durably routes each implementation response through its Conversation before Slack",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const implementationFinished = yield* Deferred.make<void>();
          const conversationRequests = yield* Ref.make<
            readonly ConversationAgentRequest[]
          >([]);
          const delivered = yield* Ref.make<readonly string[]>([]);
          const conversationAgent = {
            handle: Effect.fn("ResponseConversationAgent.handle")(function* (
              request: ConversationAgentRequest
            ) {
              yield* Ref.update(conversationRequests, (requests) =>
                EffectArray.append(requests, request)
              );
              if (request.source === "slack") {
                const createFeature = request.actions.find(
                  (action) => action.name === "create-feature"
                );
                assert.ok(createFeature);
                const accepted = yield* createFeature.invoke({
                  prompt: "Implement the durable response path.",
                  worktreeName: "durable-response-path",
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
                  replyId: `${request.turnId}:reviewed`,
                  text: `Conversation reviewed ${request.turnId}.`,
                },
              ];
            }),
          };
          const implementationAgent = ImplementationAgent.of({
            start: (request, acceptResponse) => {
              const emit = (response: ImplementationAgentResponse) =>
                acceptResponse(response);
              return Effect.succeed({
                completion: Effect.gen(function* () {
                  yield* emit({ responseId: "response-1", text: "draft one" });
                  yield* emit({ responseId: "response-2", text: "draft two" });
                  yield* emit({ responseId: "response-1", text: "draft one" });
                  yield* Deferred.succeed(implementationFinished, undefined);
                }),
                resume: () => Effect.void,
                sessionId: request.implementationSessionId,
              });
            },
          });
          const application = yield* makeReferenceCodingApplication({
            conversationAgent,
            implementationAgent,
            worktreeManager: WorktreeManager.of({
              create: () =>
                Effect.succeed({
                  workingDirectory: "/tmp/durable-response-path",
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
              channelId: "CRESPONSES",
              eventId: "event:responses:start",
              messageTs: "1.0",
              text: `<@${LABORER_SLACK_ID}> implement the response path`,
            })
          );
          yield* Deferred.await(implementationFinished);
          yield* harness.runner.drain(ThreadId.make("CRESPONSES:1.0"));

          const externalRequests = EffectArray.filter(
            yield* Ref.get(conversationRequests),
            (request) => request.source === "implementation-agent"
          );
          assert.strictEqual(externalRequests.length, 2);
          assert.ok(
            externalRequests.every(
              (request) =>
                request.input.includes('source="implementation-agent"') &&
                request.input.includes(
                  'execution-id="CRESPONSES:1.0:execution:1"'
                )
            )
          );
          assert.deepStrictEqual(yield* Ref.get(delivered), [
            "Started CRESPONSES:1.0:execution:1.",
            "Conversation reviewed CRESPONSES:1.0:execution:1:response:response-1.",
            "Conversation reviewed CRESPONSES:1.0:execution:1:response:response-2.",
          ]);
          assert.deepStrictEqual(
            (yield* harness.store.snapshot).threads[0]?.applicationEvents.map(
              (event) => ({
                eventId: event.eventId,
                source: event.source,
                status: event.status,
              })
            ),
            [
              {
                eventId: "CRESPONSES:1.0:execution:1:response:response-1",
                source: "implementation-agent",
                status: "completed",
              },
              {
                eventId: "CRESPONSES:1.0:execution:1:response:response-2",
                source: "implementation-agent",
                status: "completed",
              },
            ]
          );
        })
      )
  );

  it.effect(
    "queues participant prompts serially behind a busy owned Execution",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const finishInitial = yield* Deferred.make<void>();
          const finishFirstFollowUp = yield* Deferred.make<void>();
          const firstFollowUpStarted = yield* Deferred.make<void>();
          const secondFollowUpStarted = yield* Deferred.make<void>();
          const resumedPrompts = yield* Ref.make<readonly string[]>([]);
          const conversationAgent = {
            handle: Effect.fn("QueuedPromptConversation.handle")(function* (
              request: ConversationAgentRequest
            ) {
              const text = request.messages.at(-1)?.text ?? "";
              if (text.includes("start queued work")) {
                const action = request.actions.find(
                  (candidate) => candidate.name === "create-feature"
                );
                assert.ok(action);
                yield* action.invoke({
                  prompt: "initial prompt",
                  worktreeName: "queued-work",
                });
              } else if (text.includes("first queued prompt")) {
                const action = request.executionControls.find(
                  (candidate) => candidate.name === "prompt"
                );
                assert.ok(action);
                yield* action.invoke({
                  executionId: "CQUEUE:1.0:execution:1",
                  prompt: "first follow-up",
                });
              } else if (text.includes("second queued prompt")) {
                const action = request.executionControls.find(
                  (candidate) => candidate.name === "prompt"
                );
                assert.ok(action);
                yield* action.invoke({
                  executionId: "CQUEUE:1.0:execution:1",
                  prompt: "second follow-up",
                });
              }
              return [
                {
                  replyId: `${request.turnId}:conversation`,
                  text: "Conversation accepted the prompt.",
                },
              ];
            }),
          };
          const implementationAgent = ImplementationAgent.of({
            start: (request) =>
              Effect.succeed({
                completion: Deferred.await(finishInitial),
                resume: (request: ImplementationAgentResumeRequest) =>
                  Ref.update(resumedPrompts, (prompts) =>
                    EffectArray.append(prompts, request.prompt)
                  ).pipe(
                    Effect.andThen(
                      request.prompt === "first follow-up"
                        ? Deferred.succeed(
                            firstFollowUpStarted,
                            undefined
                          ).pipe(
                            Effect.andThen(Deferred.await(finishFirstFollowUp))
                          )
                        : Deferred.succeed(secondFollowUpStarted, undefined)
                    )
                  ),
                sessionId: request.implementationSessionId,
              }),
          });
          const application = yield* makeReferenceCodingApplication({
            conversationAgent,
            implementationAgent,
            worktreeManager: WorktreeManager.of({
              create: () =>
                Effect.succeed({ workingDirectory: "/tmp/queued-work" }),
            }),
          });
          const harness = yield* makePrototypeHarness({
            application,
            laborerSlackId: LABORER_SLACK_ID,
            slack: {
              postThreadMessage: () => Effect.succeed({ ts: "delivered" }),
              readActivationContext: () => Effect.succeed([]),
            },
          });
          const inject = (eventId: string, messageTs: string, text: string) =>
            harness.runner.inject(
              normalizedEvent({
                authorSlackId: "UHUMAN",
                channelId: "CQUEUE",
                eventId,
                messageTs,
                text,
                ...(messageTs === "1.0" ? {} : { threadTs: "1.0" }),
              })
            );

          yield* inject(
            "event:queue:start",
            "1.0",
            `<@${LABORER_SLACK_ID}> start queued work`
          );
          yield* inject("event:queue:first", "2.0", "first queued prompt");
          yield* inject("event:queue:second", "3.0", "second queued prompt");
          assert.deepStrictEqual(yield* Ref.get(resumedPrompts), []);

          yield* Deferred.succeed(finishInitial, undefined);
          yield* Deferred.await(firstFollowUpStarted);
          assert.deepStrictEqual(yield* Ref.get(resumedPrompts), [
            "first follow-up",
          ]);

          yield* Deferred.succeed(finishFirstFollowUp, undefined);
          yield* Deferred.await(secondFollowUpStarted);
          assert.deepStrictEqual(yield* Ref.get(resumedPrompts), [
            "first follow-up",
            "second follow-up",
          ]);
        })
      )
  );

  it.effect("resumes a completed Execution with its original identities", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const initialCompleted = yield* Deferred.make<void>();
        const resumeStarted = yield* Deferred.make<void>();
        const finishResume = yield* Deferred.make<void>();
        const resumeRequests = yield* Ref.make<
          readonly ImplementationAgentResumeRequest[]
        >([]);
        const observedExecutions = yield* Ref.make<
          readonly {
            readonly implementationSessionId: string | null;
            readonly status: string;
            readonly worktreeName: string;
          }[]
        >([]);
        const conversationAgent = {
          handle: Effect.fn("ResumeConversation.handle")(function* (
            request: ConversationAgentRequest
          ) {
            const text = request.messages.at(-1)?.text ?? "";
            if (text.includes("start resumable work")) {
              const action = request.actions.find(
                (candidate) => candidate.name === "create-feature"
              );
              assert.ok(action);
              yield* action.invoke({
                prompt: "initial resumable prompt",
                worktreeName: "resumable-work",
              });
            } else if (text.includes("resume completed work")) {
              assert.strictEqual(request.executions[0]?.status, "completed");
              const action = request.executionControls.find(
                (candidate) => candidate.name === "prompt"
              );
              assert.ok(action);
              yield* action.invoke({
                executionId: "CRESUME:1.0:execution:1",
                prompt: "later prompt",
              });
            } else if (text.includes("observe resumed work")) {
              const execution = request.executions[0];
              assert.ok(execution);
              yield* Ref.update(observedExecutions, (observed) =>
                EffectArray.append(observed, {
                  implementationSessionId: execution.implementationSessionId,
                  status: execution.status,
                  worktreeName: execution.worktreeName,
                })
              );
            }
            return [
              {
                replyId: `${request.turnId}:conversation`,
                text: "Conversation handled the request.",
              },
            ];
          }),
        };
        const implementationAgent = ImplementationAgent.of({
          start: (request) =>
            Effect.succeed({
              completion: Deferred.succeed(initialCompleted, undefined),
              resume: (request: ImplementationAgentResumeRequest) =>
                Ref.update(resumeRequests, (requests) =>
                  EffectArray.append(requests, request)
                ).pipe(
                  Effect.andThen(Deferred.succeed(resumeStarted, undefined)),
                  Effect.andThen(Deferred.await(finishResume))
                ),
              sessionId: request.implementationSessionId,
            }),
        });
        const application = yield* makeReferenceCodingApplication({
          conversationAgent,
          implementationAgent,
          worktreeManager: WorktreeManager.of({
            create: () =>
              Effect.succeed({ workingDirectory: "/tmp/resumable-work" }),
          }),
        });
        const harness = yield* makePrototypeHarness({
          application,
          laborerSlackId: LABORER_SLACK_ID,
          slack: {
            postThreadMessage: () => Effect.succeed({ ts: "delivered" }),
            readActivationContext: () => Effect.succeed([]),
          },
        });
        const inject = (eventId: string, messageTs: string, text: string) =>
          harness.runner.inject(
            normalizedEvent({
              authorSlackId: "UHUMAN",
              channelId: "CRESUME",
              eventId,
              messageTs,
              text,
              ...(messageTs === "1.0" ? {} : { threadTs: "1.0" }),
            })
          );

        yield* inject(
          "event:resume:start",
          "1.0",
          `<@${LABORER_SLACK_ID}> start resumable work`
        );
        yield* Deferred.await(initialCompleted);
        yield* Effect.yieldNow;
        yield* inject("event:resume:later", "2.0", "resume completed work");
        yield* Deferred.await(resumeStarted);
        yield* inject("event:resume:observe", "3.0", "observe resumed work");

        assert.deepStrictEqual(yield* Ref.get(resumeRequests), [
          {
            conversationId: ThreadId.make("CRESUME:1.0"),
            executionId: "CRESUME:1.0:execution:1",
            implementationSessionId:
              "ses_c8c96f1ba2f6a74384af4714602fdfd4443867320cbaa53a3e3c6b0f188dea88",
            prompt: "later prompt",
            promptId:
              "msg_9f7c6e5249c11095641a35262c31c47fad6e074ad4d3bdc82af97cb18c70c4c8",
            workingDirectory: "/tmp/resumable-work",
          },
        ]);
        assert.deepStrictEqual(yield* Ref.get(observedExecutions), [
          {
            implementationSessionId:
              "ses_c8c96f1ba2f6a74384af4714602fdfd4443867320cbaa53a3e3c6b0f188dea88",
            status: "running",
            worktreeName: "resumable-work",
          },
        ]);
        yield* Deferred.succeed(finishResume, undefined);
      })
    )
  );

  it.effect(
    "preserves acceptance order across participant and external Application events",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const firstStarted = yield* Deferred.make<void>();
          const releaseFirst = yield* Deferred.make<void>();
          const observed = yield* Ref.make<readonly string[]>([]);
          const application = Application.of({
            handle: Effect.fn("OrderedApplication.handle")(function* (event) {
              const label =
                event._tag === "ParticipantInput"
                  ? `participant:${event.messages[0]?.text}`
                  : `external:${event.eventId}`;
              yield* Ref.update(observed, (events) =>
                EffectArray.append(events, label)
              );
              if (
                event._tag === "ParticipantInput" &&
                event.messages[0]?.slackTs === "1.0"
              ) {
                yield* Deferred.succeed(firstStarted, undefined);
                yield* Deferred.await(releaseFirst);
              }
            }),
          });
          const harness = yield* makePrototypeHarness({
            application,
            laborerSlackId: LABORER_SLACK_ID,
            slack: {
              postThreadMessage: () => Effect.succeed({ ts: "delivered" }),
              readActivationContext: () => Effect.succeed([]),
            },
          });

          yield* harness.runner.accept(
            normalizedEvent({
              authorSlackId: "UHUMAN",
              channelId: "CORDERED",
              eventId: "event:ordered:start",
              messageTs: "1.0",
              text: `<@${LABORER_SLACK_ID}> first`,
            })
          );
          yield* Deferred.await(firstStarted);
          yield* harness.runner.accept(
            normalizedEvent({
              authorSlackId: "UHUMAN",
              channelId: "CORDERED",
              eventId: "event:ordered:second",
              messageTs: "2.0",
              text: "second",
              threadTs: "1.0",
            })
          );
          yield* harness.runner.acceptApplicationEvent(
            ExternalInputEvent.make({
              conversationId: ThreadId.make("CORDERED:1.0"),
              eventId: "event:ordered:external",
              payload: { text: "third" },
              source: "implementation-agent",
            })
          );
          yield* Deferred.succeed(releaseFirst, undefined);
          yield* harness.runner.drain(ThreadId.make("CORDERED:1.0"));

          assert.deepStrictEqual(yield* Ref.get(observed), [
            `participant:<@${LABORER_SLACK_ID}> first`,
            "participant:second",
            "external:event:ordered:external",
          ]);
        })
      )
  );
});
