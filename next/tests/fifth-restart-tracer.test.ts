import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Array as EffectArray, Ref } from "effect";
import { ThreadId } from "../src/prototype/domain.ts";
import { makePrototypeHarness } from "../src/prototype/runtime.ts";
import {
  LABORER_SLACK_ID,
  normalizedEvent,
} from "../src/prototype/scenario.ts";
import { makeFileStoreLayer } from "../src/prototype/store.ts";
import {
  type ConversationAgentRequest,
  ImplementationAgent,
  type ImplementationAgentRecoveryRequest,
  type ImplementationAgentRequest,
  makeFileApplicationRepository,
  makeReferenceCodingApplication,
  WorktreeManager,
} from "../src/reference-coding-application.ts";
import { makeTempDirectoryScoped } from "./support/temp-directory.ts";

describe("fifth restart tracer", () => {
  it.effect(
    "preserves Conversation identity and session continuity across an application restart",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-fifth-conversation-restart-"
          );
          const runnerSnapshotPath = join(root, "runner.json");
          const applicationSnapshotPath = join(root, "application.json");
          const requests = yield* Ref.make<readonly ConversationAgentRequest[]>(
            []
          );
          const delivered = yield* Ref.make<readonly string[]>([]);
          const conversationAgent = {
            handle: (request: ConversationAgentRequest) =>
              Ref.update(requests, (current) =>
                EffectArray.append(current, request)
              ).pipe(
                Effect.as([
                  {
                    replyId: `${request.turnId}:reply`,
                    text: `handled ${request.promptId}`,
                  },
                ])
              ),
          };
          const makeApplication = Effect.gen(function* () {
            const repository = yield* makeFileApplicationRepository(
              applicationSnapshotPath,
              root
            );
            return yield* makeReferenceCodingApplication({
              conversationAgent,
              implementationAgent: ImplementationAgent.of({
                start: () =>
                  Effect.succeed({
                    completion: Effect.void,
                    resume: () => Effect.void,
                    sessionId: "unused",
                  }),
              }),
              repository,
              worktreeManager: WorktreeManager.of({
                create: () =>
                  Effect.succeed({ workingDirectory: "/tmp/unused" }),
              }),
            });
          });
          const slack = {
            postThreadMessage: (request: { readonly text: string }) =>
              Ref.update(delivered, (current) =>
                EffectArray.append(current, request.text)
              ).pipe(Effect.as({ ts: `reply-${request.text}` })),
            readActivationContext: () => Effect.succeed([]),
          };

          yield* Effect.scoped(
            Effect.gen(function* () {
              const application = yield* makeApplication;
              const harness = yield* makePrototypeHarness({
                application,
                laborerSlackId: LABORER_SLACK_ID,
                slack,
                storeLayer: makeFileStoreLayer(
                  LABORER_SLACK_ID,
                  runnerSnapshotPath,
                  root
                ),
              });
              yield* harness.runner.inject(
                normalizedEvent({
                  authorSlackId: "UHUMAN",
                  channelId: "CRESTART",
                  eventId: "event:restart:first",
                  messageTs: "1.0",
                  text: `<@${LABORER_SLACK_ID}> remember this Conversation`,
                })
              );
            })
          );

          yield* Effect.scoped(
            Effect.gen(function* () {
              const application = yield* makeApplication;
              const harness = yield* makePrototypeHarness({
                application,
                laborerSlackId: LABORER_SLACK_ID,
                slack,
                storeLayer: makeFileStoreLayer(
                  LABORER_SLACK_ID,
                  runnerSnapshotPath,
                  root
                ),
              });
              yield* harness.runner.inject(
                normalizedEvent({
                  authorSlackId: "UHUMAN",
                  channelId: "CRESTART",
                  eventId: "event:restart:second",
                  messageTs: "2.0",
                  text: "is this the same Conversation?",
                  threadTs: "1.0",
                })
              );
            })
          );

          const observed = yield* Ref.get(requests);
          assert.strictEqual(observed.length, 2);
          assert.strictEqual(observed[0]?.conversationId, "CRESTART:1.0");
          assert.strictEqual(observed[1]?.conversationId, "CRESTART:1.0");
          assert.strictEqual(
            observed[0]?.conversationSessionId,
            observed[1]?.conversationSessionId
          );
          assert.notStrictEqual(observed[0]?.promptId, observed[1]?.promptId);
          assert.deepStrictEqual(yield* Ref.get(delivered), [
            `handled ${observed[0]?.promptId}`,
            `handled ${observed[1]?.promptId}`,
          ]);
        })
      )
  );

  it.effect(
    "recovers one in-flight Execution without repeating staged side effects",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-fifth-execution-restart-"
          );
          const runnerSnapshotPath = join(root, "runner.json");
          const applicationSnapshotPath = join(root, "application.json");
          const actionInvocations = yield* Ref.make(0);
          const worktreeCreates = yield* Ref.make<readonly string[]>([]);
          const implementationStarts = yield* Ref.make<
            readonly ImplementationAgentRequest[]
          >([]);
          const implementationRecoveries = yield* Ref.make<
            readonly ImplementationAgentRecoveryRequest[]
          >([]);
          const observedExecutions = yield* Ref.make<
            readonly ConversationAgentRequest["executions"][]
          >([]);
          const delivered = yield* Ref.make<readonly string[]>([]);
          const responseAccepted = yield* Deferred.make<void>();
          const conversationAgent = {
            handle: (request: ConversationAgentRequest) =>
              Effect.gen(function* () {
                const message = request.messages.at(-1)?.text ?? "";
                if (message.includes("start restartable work")) {
                  yield* Ref.update(actionInvocations, (count) => count + 1);
                  const action = request.actions.find(
                    (candidate) => candidate.name === "create-feature"
                  );
                  assert.ok(action);
                  const accepted = yield* action.invoke({
                    prompt: "Implement the exact restart-safe behavior.",
                    worktreeName: "restart-safe-work",
                  });
                  return [
                    {
                      replyId: `${request.turnId}:started`,
                      text: `Started ${accepted.executionId}.`,
                    },
                  ];
                }
                yield* Ref.update(observedExecutions, (current) =>
                  EffectArray.append(current, request.executions)
                );
                return [
                  {
                    replyId: `${request.turnId}:handled`,
                    text: `Handled ${request.turnId}.`,
                  },
                ];
              }),
            recover: (_request: ConversationAgentRequest) =>
              Effect.die(
                new Error("a completed Conversation prompt must not recover")
              ),
          };
          const slack = {
            postThreadMessage: (request: { readonly text: string }) =>
              Ref.update(delivered, (current) =>
                EffectArray.append(current, request.text)
              ).pipe(Effect.as({ ts: `reply-${request.text}` })),
            readActivationContext: () => Effect.succeed([]),
          };
          const makeApplication = (isRecovery: boolean) =>
            Effect.gen(function* () {
              const repository = yield* makeFileApplicationRepository(
                applicationSnapshotPath,
                root
              );
              return yield* makeReferenceCodingApplication({
                conversationAgent,
                implementationAgent: ImplementationAgent.of({
                  recover: (request, acceptResponse) =>
                    Ref.update(implementationRecoveries, (current) =>
                      EffectArray.append(current, request)
                    ).pipe(
                      Effect.as({
                        completion: Effect.gen(function* () {
                          yield* acceptResponse({
                            responseId: "response-1",
                            text: "restart-safe implementation response",
                          });
                          yield* acceptResponse({
                            responseId: "response-1",
                            text: "restart-safe implementation response",
                          });
                          yield* Deferred.succeed(responseAccepted, undefined);
                        }),
                        resume: () => Effect.void,
                        sessionId: request.implementationSessionId,
                      })
                    ),
                  start: (request) =>
                    isRecovery
                      ? Effect.die(
                          new Error(
                            "recovery must not submit the implementation prompt again"
                          )
                        )
                      : Ref.update(implementationStarts, (current) =>
                          EffectArray.append(current, request)
                        ).pipe(
                          Effect.as({
                            completion: Effect.never,
                            resume: () => Effect.void,
                            sessionId: request.implementationSessionId,
                          })
                        ),
                }),
                repository,
                worktreeManager: WorktreeManager.of({
                  create: (request) =>
                    Ref.update(worktreeCreates, (current) =>
                      EffectArray.append(current, request.worktreeName)
                    ).pipe(
                      Effect.as({
                        workingDirectory: `/tmp/laborer-worktrees/${request.worktreeName}`,
                      })
                    ),
                  recover: () =>
                    Effect.die(
                      new Error("a persisted worktree path must be reused")
                    ),
                }),
              });
            });

          yield* Effect.scoped(
            Effect.gen(function* () {
              const application = yield* makeApplication(false);
              const harness = yield* makePrototypeHarness({
                application,
                laborerSlackId: LABORER_SLACK_ID,
                slack,
                storeLayer: makeFileStoreLayer(
                  LABORER_SLACK_ID,
                  runnerSnapshotPath,
                  root
                ),
              });
              yield* harness.runner.inject(
                normalizedEvent({
                  authorSlackId: "UHUMAN",
                  channelId: "CEXECRESTART",
                  eventId: "event:execution:start",
                  messageTs: "1.0",
                  text: `<@${LABORER_SLACK_ID}> start restartable work`,
                })
              );
            })
          );

          yield* Effect.scoped(
            Effect.gen(function* () {
              const application = yield* makeApplication(true);
              const harness = yield* makePrototypeHarness({
                application,
                laborerSlackId: LABORER_SLACK_ID,
                slack,
                storeLayer: makeFileStoreLayer(
                  LABORER_SLACK_ID,
                  runnerSnapshotPath,
                  root
                ),
              });
              yield* Deferred.await(responseAccepted);
              yield* harness.runner.drain(
                // The public Runner remains ignorant of Execution semantics.
                ThreadId.make((yield* harness.store.threadIds)[0] ?? "")
              );
              yield* harness.runner.inject(
                normalizedEvent({
                  authorSlackId: "UHUMAN",
                  channelId: "CEXECRESTART",
                  eventId: "event:execution:status",
                  messageTs: "2.0",
                  text: "show the recovered identity",
                  threadTs: "1.0",
                })
              );
            })
          );

          assert.strictEqual(yield* Ref.get(actionInvocations), 1);
          assert.deepStrictEqual(yield* Ref.get(worktreeCreates), [
            "restart-safe-work",
          ]);
          const starts = yield* Ref.get(implementationStarts);
          const recoveries = yield* Ref.get(implementationRecoveries);
          assert.strictEqual(starts.length, 1);
          assert.strictEqual(recoveries.length, 1);
          assert.strictEqual(
            recoveries[0]?.executionId,
            starts[0]?.executionId
          );
          assert.strictEqual(
            recoveries[0]?.implementationSessionId,
            starts[0]?.implementationSessionId
          );
          assert.strictEqual(recoveries[0]?.promptId, starts[0]?.promptId);
          assert.strictEqual(
            recoveries[0]?.prompt,
            "Implement the exact restart-safe behavior."
          );
          assert.strictEqual(
            recoveries[0]?.workingDirectory,
            "/tmp/laborer-worktrees/restart-safe-work"
          );
          const execution = (yield* Ref.get(observedExecutions)).at(-1)?.[0];
          assert.deepStrictEqual(execution, {
            actionName: "create-feature",
            activePromptId: starts[0]?.promptId ?? null,
            conversationId: ThreadId.make("CEXECRESTART:1.0"),
            executionId: "CEXECRESTART:1.0:execution:1",
            implementationSessionId: starts[0]?.implementationSessionId ?? null,
            status: "completed",
            workingDirectory: "/tmp/laborer-worktrees/restart-safe-work",
            worktreeName: "restart-safe-work",
          });
          assert.deepStrictEqual(yield* Ref.get(delivered), [
            "Started CEXECRESTART:1.0:execution:1.",
            "Handled CEXECRESTART:1.0:execution:1:response:response-1.",
            "Handled turn:CEXECRESTART:2.0.",
          ]);
        })
      )
  );

  it.effect(
    "recovers an ambiguously created worktree before starting implementation once",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-fifth-worktree-stage-"
          );
          const runnerSnapshotPath = join(root, "runner.json");
          const applicationSnapshotPath = join(root, "application.json");
          const worktreeCreateStarted = yield* Deferred.make<void>();
          const implementationStarted = yield* Deferred.make<void>();
          const actionInvocations = yield* Ref.make(0);
          const worktreeCreates = yield* Ref.make(0);
          const worktreeRecoveries = yield* Ref.make(0);
          const implementationStarts = yield* Ref.make(0);
          const implementationRecoveries = yield* Ref.make(0);
          const conversationAgent = {
            handle: (request: ConversationAgentRequest) =>
              Effect.gen(function* () {
                yield* Ref.update(actionInvocations, (count) => count + 1);
                const action = request.actions.find(
                  (candidate) => candidate.name === "create-feature"
                );
                assert.ok(action);
                yield* action.invoke({
                  prompt: "prompt after ambiguous worktree creation",
                  worktreeName: "ambiguous-worktree",
                });
                return [
                  {
                    replyId: `${request.turnId}:started`,
                    text: "work started",
                  },
                ];
              }),
            recover: (request: ConversationAgentRequest) =>
              Effect.succeed([
                {
                  replyId: `${request.turnId}:started`,
                  text: "work started",
                },
              ]),
          };
          const slack = {
            postThreadMessage: () => Effect.succeed({ ts: "delivered" }),
            readActivationContext: () => Effect.succeed([]),
          };
          const makeApplication = (isRecovery: boolean) =>
            Effect.gen(function* () {
              const repository = yield* makeFileApplicationRepository(
                applicationSnapshotPath,
                root
              );
              return yield* makeReferenceCodingApplication({
                conversationAgent,
                implementationAgent: ImplementationAgent.of({
                  recover: () =>
                    Ref.update(
                      implementationRecoveries,
                      (count) => count + 1
                    ).pipe(
                      Effect.as({
                        completion: Effect.never,
                        resume: () => Effect.void,
                        sessionId: "must-not-recover",
                      })
                    ),
                  start: (request) =>
                    Ref.update(implementationStarts, (count) => count + 1).pipe(
                      Effect.andThen(
                        Deferred.succeed(implementationStarted, undefined)
                      ),
                      Effect.as({
                        completion: Effect.never,
                        resume: () => Effect.void,
                        sessionId: request.implementationSessionId,
                      })
                    ),
                }),
                repository,
                worktreeManager: WorktreeManager.of({
                  create: () =>
                    Ref.update(worktreeCreates, (count) => count + 1).pipe(
                      Effect.andThen(
                        Deferred.succeed(worktreeCreateStarted, undefined)
                      ),
                      Effect.andThen(Effect.never)
                    ),
                  recover: () =>
                    isRecovery
                      ? Ref.update(
                          worktreeRecoveries,
                          (count) => count + 1
                        ).pipe(
                          Effect.as({
                            workingDirectory:
                              "/tmp/laborer-worktrees/ambiguous-worktree",
                          })
                        )
                      : Effect.die(new Error("unexpected worktree recovery")),
                }),
              });
            });

          yield* Effect.scoped(
            Effect.gen(function* () {
              const application = yield* makeApplication(false);
              const harness = yield* makePrototypeHarness({
                application,
                laborerSlackId: LABORER_SLACK_ID,
                slack,
                storeLayer: makeFileStoreLayer(
                  LABORER_SLACK_ID,
                  runnerSnapshotPath,
                  root
                ),
              });
              yield* harness.runner
                .inject(
                  normalizedEvent({
                    authorSlackId: "UHUMAN",
                    channelId: "CWORKTREESTAGE",
                    eventId: "event:worktree-stage",
                    messageTs: "1.0",
                    text: `<@${LABORER_SLACK_ID}> create ambiguous worktree`,
                  })
                )
                .pipe(Effect.forkChild);
              yield* Deferred.await(worktreeCreateStarted);
            })
          );

          yield* Effect.scoped(
            Effect.gen(function* () {
              const application = yield* makeApplication(true);
              yield* makePrototypeHarness({
                application,
                laborerSlackId: LABORER_SLACK_ID,
                slack,
                storeLayer: makeFileStoreLayer(
                  LABORER_SLACK_ID,
                  runnerSnapshotPath,
                  root
                ),
              });
              yield* Deferred.await(implementationStarted);
            })
          );

          assert.strictEqual(yield* Ref.get(actionInvocations), 1);
          assert.strictEqual(yield* Ref.get(worktreeCreates), 1);
          assert.strictEqual(yield* Ref.get(worktreeRecoveries), 1);
          assert.strictEqual(yield* Ref.get(implementationStarts), 1);
          assert.strictEqual(yield* Ref.get(implementationRecoveries), 0);
        })
      )
  );

  it.effect(
    "recovers an ambiguously started implementation prompt without resubmitting it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-fifth-implementation-stage-"
          );
          const runnerSnapshotPath = join(root, "runner.json");
          const applicationSnapshotPath = join(root, "application.json");
          const implementationStartEntered = yield* Deferred.make<void>();
          const implementationRecovered = yield* Deferred.make<void>();
          const starts = yield* Ref.make<readonly ImplementationAgentRequest[]>(
            []
          );
          const recoveries = yield* Ref.make<
            readonly ImplementationAgentRecoveryRequest[]
          >([]);
          const worktreeCreates = yield* Ref.make(0);
          const worktreeRecoveries = yield* Ref.make(0);
          const conversationAgent = {
            handle: (request: ConversationAgentRequest) =>
              Effect.gen(function* () {
                const action = request.actions.find(
                  (candidate) => candidate.name === "create-feature"
                );
                assert.ok(action);
                yield* action.invoke({
                  prompt: "the exact ambiguously submitted prompt",
                  worktreeName: "implementation-stage",
                });
                return [
                  {
                    replyId: `${request.turnId}:started`,
                    text: "implementation started",
                  },
                ];
              }),
            recover: (request: ConversationAgentRequest) =>
              Effect.succeed([
                {
                  replyId: `${request.turnId}:started`,
                  text: "implementation started",
                },
              ]),
          };
          const slack = {
            postThreadMessage: () => Effect.succeed({ ts: "delivered" }),
            readActivationContext: () => Effect.succeed([]),
          };
          const makeApplication = Effect.gen(function* () {
            const repository = yield* makeFileApplicationRepository(
              applicationSnapshotPath,
              root
            );
            return yield* makeReferenceCodingApplication({
              conversationAgent,
              implementationAgent: ImplementationAgent.of({
                recover: (request) =>
                  Ref.update(recoveries, (current) =>
                    EffectArray.append(current, request)
                  ).pipe(
                    Effect.andThen(
                      Deferred.succeed(implementationRecovered, undefined)
                    ),
                    Effect.as({
                      completion: Effect.never,
                      resume: () => Effect.void,
                      sessionId: request.implementationSessionId,
                    })
                  ),
                start: (request) =>
                  Ref.update(starts, (current) =>
                    EffectArray.append(current, request)
                  ).pipe(
                    Effect.andThen(
                      Deferred.succeed(implementationStartEntered, undefined)
                    ),
                    Effect.andThen(Effect.never)
                  ),
              }),
              repository,
              worktreeManager: WorktreeManager.of({
                create: () =>
                  Ref.update(worktreeCreates, (count) => count + 1).pipe(
                    Effect.as({
                      workingDirectory:
                        "/tmp/laborer-worktrees/implementation-stage",
                    })
                  ),
                recover: () =>
                  Ref.update(worktreeRecoveries, (count) => count + 1).pipe(
                    Effect.as({
                      workingDirectory:
                        "/tmp/laborer-worktrees/implementation-stage",
                    })
                  ),
              }),
            });
          });

          yield* Effect.scoped(
            Effect.gen(function* () {
              const application = yield* makeApplication;
              const harness = yield* makePrototypeHarness({
                application,
                laborerSlackId: LABORER_SLACK_ID,
                slack,
                storeLayer: makeFileStoreLayer(
                  LABORER_SLACK_ID,
                  runnerSnapshotPath,
                  root
                ),
              });
              yield* harness.runner
                .inject(
                  normalizedEvent({
                    authorSlackId: "UHUMAN",
                    channelId: "CIMPLEMENTATIONSTAGE",
                    eventId: "event:implementation-stage",
                    messageTs: "1.0",
                    text: `<@${LABORER_SLACK_ID}> stage implementation`,
                  })
                )
                .pipe(Effect.forkChild);
              yield* Deferred.await(implementationStartEntered);
            })
          );

          yield* Effect.scoped(
            Effect.gen(function* () {
              const application = yield* makeApplication;
              yield* makePrototypeHarness({
                application,
                laborerSlackId: LABORER_SLACK_ID,
                slack,
                storeLayer: makeFileStoreLayer(
                  LABORER_SLACK_ID,
                  runnerSnapshotPath,
                  root
                ),
              });
              yield* Deferred.await(implementationRecovered);
            })
          );

          const submitted = yield* Ref.get(starts);
          const recovered = yield* Ref.get(recoveries);
          assert.strictEqual(submitted.length, 1);
          assert.strictEqual(recovered.length, 1);
          assert.strictEqual(recovered[0]?.promptId, submitted[0]?.promptId);
          assert.strictEqual(
            recovered[0]?.implementationSessionId,
            submitted[0]?.implementationSessionId
          );
          assert.strictEqual(
            recovered[0]?.prompt,
            "the exact ambiguously submitted prompt"
          );
          assert.strictEqual(yield* Ref.get(worktreeCreates), 1);
          assert.strictEqual(yield* Ref.get(worktreeRecoveries), 0);
        })
      )
  );

  it.effect(
    "preserves the exact active follow-up prompt identity across restart",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-fifth-follow-up-restart-"
          );
          const runnerSnapshotPath = join(root, "runner.json");
          const applicationSnapshotPath = join(root, "application.json");
          const followUpSubmitted = yield* Deferred.make<void>();
          const followUpRecovered = yield* Deferred.make<void>();
          const resumeRequests = yield* Ref.make<
            readonly {
              readonly implementationSessionId?: string;
              readonly prompt: string;
              readonly promptId?: string;
            }[]
          >([]);
          const recoveries = yield* Ref.make<
            readonly ImplementationAgentRecoveryRequest[]
          >([]);
          const conversationAgent = {
            handle: (request: ConversationAgentRequest) =>
              Effect.gen(function* () {
                const text = request.messages.at(-1)?.text ?? "";
                if (text.includes("start follow-up target")) {
                  const action = request.actions.find(
                    (candidate) => candidate.name === "create-feature"
                  );
                  assert.ok(action);
                  yield* action.invoke({
                    prompt: "initial completed prompt",
                    worktreeName: "follow-up-target",
                  });
                } else if (text.includes("send durable follow-up")) {
                  const action = request.executionControls.find(
                    (candidate) => candidate.name === "prompt"
                  );
                  assert.ok(action);
                  yield* action.invoke({
                    executionId: "CFOLLOWUP:1.0:execution:1",
                    prompt: "exact active follow-up prompt",
                  });
                }
                return [
                  {
                    replyId: `${request.turnId}:handled`,
                    text: "handled",
                  },
                ];
              }),
          };
          const makeApplication = Effect.gen(function* () {
            const repository = yield* makeFileApplicationRepository(
              applicationSnapshotPath,
              root
            );
            return yield* makeReferenceCodingApplication({
              conversationAgent,
              implementationAgent: ImplementationAgent.of({
                recover: (request) =>
                  Ref.update(recoveries, (current) =>
                    EffectArray.append(current, request)
                  ).pipe(
                    Effect.andThen(
                      Deferred.succeed(followUpRecovered, undefined)
                    ),
                    Effect.as({
                      completion: Effect.never,
                      resume: () => Effect.void,
                      sessionId: request.implementationSessionId,
                    })
                  ),
                start: (request) =>
                  Effect.succeed({
                    completion: Effect.void,
                    resume: (resumeRequest) =>
                      Ref.update(resumeRequests, (current) =>
                        EffectArray.append(current, resumeRequest)
                      ).pipe(
                        Effect.andThen(
                          Deferred.succeed(followUpSubmitted, undefined)
                        ),
                        Effect.andThen(Effect.never)
                      ),
                    sessionId: request.implementationSessionId,
                  }),
              }),
              repository,
              worktreeManager: WorktreeManager.of({
                create: () =>
                  Effect.succeed({
                    workingDirectory: "/tmp/laborer-worktrees/follow-up-target",
                  }),
              }),
            });
          });
          const slack = {
            postThreadMessage: () => Effect.succeed({ ts: "delivered" }),
            readActivationContext: () => Effect.succeed([]),
          };

          yield* Effect.scoped(
            Effect.gen(function* () {
              const application = yield* makeApplication;
              const harness = yield* makePrototypeHarness({
                application,
                laborerSlackId: LABORER_SLACK_ID,
                slack,
                storeLayer: makeFileStoreLayer(
                  LABORER_SLACK_ID,
                  runnerSnapshotPath,
                  root
                ),
              });
              yield* harness.runner.inject(
                normalizedEvent({
                  authorSlackId: "UHUMAN",
                  channelId: "CFOLLOWUP",
                  eventId: "event:follow-up:start",
                  messageTs: "1.0",
                  text: `<@${LABORER_SLACK_ID}> start follow-up target`,
                })
              );
              yield* Effect.yieldNow;
              yield* harness.runner.inject(
                normalizedEvent({
                  authorSlackId: "UHUMAN",
                  channelId: "CFOLLOWUP",
                  eventId: "event:follow-up:send",
                  messageTs: "2.0",
                  text: "send durable follow-up",
                  threadTs: "1.0",
                })
              );
              yield* Deferred.await(followUpSubmitted);
            })
          );

          yield* Effect.scoped(
            Effect.gen(function* () {
              const application = yield* makeApplication;
              yield* makePrototypeHarness({
                application,
                laborerSlackId: LABORER_SLACK_ID,
                slack,
                storeLayer: makeFileStoreLayer(
                  LABORER_SLACK_ID,
                  runnerSnapshotPath,
                  root
                ),
              });
              yield* Deferred.await(followUpRecovered);
            })
          );

          const submitted = (yield* Ref.get(resumeRequests))[0];
          const recovered = (yield* Ref.get(recoveries))[0];
          assert.ok(submitted);
          assert.ok(recovered);
          assert.strictEqual(recovered.promptId, submitted.promptId);
          assert.strictEqual(
            recovered.implementationSessionId,
            submitted.implementationSessionId
          );
          assert.strictEqual(recovered.prompt, "exact active follow-up prompt");
          assert.strictEqual(recovered.promptKind, "resume");
        })
      )
  );
});
