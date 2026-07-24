import { readdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Ref } from "effect";
import { ExternalInputEvent } from "../src/application.ts";
import { ThreadId } from "../src/prototype/domain.ts";
import { HandlerFailure } from "../src/prototype/errors.ts";
import {
  type ConversationAgentRequest,
  ImplementationAgent,
  type ImplementationAgentResumeRequest,
  makeFileApplicationRepository,
  makeInMemoryApplicationRepository,
  makeReferenceCodingApplication,
  WorktreeManager,
} from "../src/reference-coding-application.ts";
import { makeTempDirectoryScoped } from "./support/temp-directory.ts";

const acceptEvent = (event: ExternalInputEvent) =>
  Effect.succeed({
    decision: { _tag: "Accepted" as const, eventId: event.eventId },
    scheduling: "Scheduled" as const,
  });

const publishNothing = () => Effect.void;

const duplicateActionEvent = ExternalInputEvent.make({
  conversationId: ThreadId.make("CDUPLICATE:1.0"),
  eventId: "event:duplicate-action",
  payload: {},
  source: "test",
});

describe("eighth reference coding Application review", () => {
  it.effect(
    "returns an exact duplicate Action invocation without repeating either side effect",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const worktreeCreates = yield* Ref.make(0);
          const implementationStarts = yield* Ref.make(0);
          const acceptedExecutionIds = yield* Ref.make<readonly string[]>([]);
          const invokeAction = Effect.fnUntraced(function* (
            request: ConversationAgentRequest
          ) {
            const action = request.actions.find(
              (candidate) => candidate.name === "create-feature"
            );
            assert.ok(action);
            const accepted = yield* action.invoke({
              prompt: "Implement exact idempotency.",
              worktreeName: "exact-idempotency",
            });
            yield* Ref.update(acceptedExecutionIds, (current) => [
              ...current,
              accepted.executionId,
            ]);
          });
          const application = yield* makeReferenceCodingApplication({
            conversationAgent: {
              handle: (request) =>
                invokeAction(request).pipe(
                  Effect.andThen(
                    HandlerFailure.make({
                      category: "protocol",
                      safeDetail: "interrupt after Action acceptance",
                    })
                  )
                ),
              recover: (request) =>
                invokeAction(request).pipe(Effect.as([] as const)),
            },
            implementationAgent: ImplementationAgent.of({
              start: (request) =>
                Ref.update(implementationStarts, (count) => count + 1).pipe(
                  Effect.as({
                    completion: Effect.never,
                    resume: () => Effect.void,
                    sessionId: request.implementationSessionId,
                  })
                ),
            }),
            worktreeManager: WorktreeManager.of({
              create: () =>
                Ref.update(worktreeCreates, (count) => count + 1).pipe(
                  Effect.as({ workingDirectory: "/tmp/exact-idempotency" })
                ),
            }),
          });

          const first = yield* Effect.result(
            application.handle(
              duplicateActionEvent,
              publishNothing,
              acceptEvent
            )
          );
          assert.strictEqual(first._tag, "Failure");
          yield* application.handle(
            duplicateActionEvent,
            publishNothing,
            acceptEvent
          );

          assert.strictEqual(yield* Ref.get(worktreeCreates), 1);
          assert.strictEqual(yield* Ref.get(implementationStarts), 1);
          assert.deepStrictEqual(yield* Ref.get(acceptedExecutionIds), [
            "CDUPLICATE:1.0:execution:1",
            "CDUPLICATE:1.0:execution:1",
          ]);
        })
      )
  );

  it.effect(
    "fails closed when an Action invocation identity is reused with conflicting input",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const worktreeCreates = yield* Ref.make(0);
          const implementationStarts = yield* Ref.make(0);
          const conflictDetails = yield* Ref.make<readonly (string | null)[]>(
            []
          );
          const inspectedExecutionIds = yield* Ref.make<readonly string[]>([]);
          const application = yield* makeReferenceCodingApplication({
            conversationAgent: {
              handle: (request) => {
                if (request.source === "inspect") {
                  return Ref.set(
                    inspectedExecutionIds,
                    request.executions.map((execution) => execution.executionId)
                  ).pipe(Effect.as([] as const));
                }
                const action = request.actions.find(
                  (candidate) => candidate.name === "create-feature"
                );
                assert.ok(action);
                return action
                  .invoke({
                    prompt: "Preserve this original prompt.",
                    worktreeName: "preserved-worktree",
                  })
                  .pipe(
                    Effect.andThen(
                      HandlerFailure.make({
                        category: "protocol",
                        safeDetail: "interrupt after original Action",
                      })
                    )
                  );
              },
              recover: (request) => {
                const action = request.actions.find(
                  (candidate) => candidate.name === "create-feature"
                );
                assert.ok(action);
                return Effect.result(
                  action.invoke({
                    prompt: "Conflicting replacement prompt.",
                    worktreeName: "replacement-worktree",
                  })
                ).pipe(
                  Effect.tap((result) =>
                    Ref.update(conflictDetails, (current) => [
                      ...current,
                      result._tag === "Failure"
                        ? result.failure.safeDetail
                        : "unexpected success",
                    ])
                  ),
                  Effect.as([] as const)
                );
              },
            },
            implementationAgent: ImplementationAgent.of({
              start: (request) =>
                Ref.update(implementationStarts, (count) => count + 1).pipe(
                  Effect.as({
                    completion: Effect.never,
                    resume: () => Effect.void,
                    sessionId: request.implementationSessionId,
                  })
                ),
            }),
            worktreeManager: WorktreeManager.of({
              create: () =>
                Ref.update(worktreeCreates, (count) => count + 1).pipe(
                  Effect.as({ workingDirectory: "/tmp/preserved-worktree" })
                ),
            }),
          });

          yield* Effect.result(
            application.handle(
              duplicateActionEvent,
              publishNothing,
              acceptEvent
            )
          );
          yield* application.handle(
            duplicateActionEvent,
            publishNothing,
            acceptEvent
          );
          yield* application.handle(
            ExternalInputEvent.make({
              conversationId: duplicateActionEvent.conversationId,
              eventId: "event:inspect-preserved-execution",
              payload: {},
              source: "inspect",
            }),
            publishNothing,
            acceptEvent
          );

          assert.deepStrictEqual(yield* Ref.get(conflictDetails), [
            "Action invocation identity conflicts",
          ]);
          assert.strictEqual(yield* Ref.get(worktreeCreates), 1);
          assert.strictEqual(yield* Ref.get(implementationStarts), 1);
          assert.deepStrictEqual(yield* Ref.get(inspectedExecutionIds), [
            "CDUPLICATE:1.0:execution:1",
          ]);
        })
      )
  );

  it.effect(
    "fails a typed implementation run once and emits one Execution-tagged Conversation event",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const completionEntered = yield* Deferred.make<void>();
          const acceptedEvents = yield* Ref.make<readonly ExternalInputEvent[]>(
            []
          );
          const observedFailureRequests = yield* Ref.make<
            readonly ConversationAgentRequest[]
          >([]);
          const implementationStarts = yield* Ref.make(0);
          const implementationRecoveries = yield* Ref.make(0);
          const conversationAgent = {
            handle: (request: ConversationAgentRequest) => {
              if (request.source === "implementation-failure") {
                return Ref.update(observedFailureRequests, (current) => [
                  ...current,
                  request,
                ]).pipe(Effect.as([] as const));
              }
              const action = request.actions.find(
                (candidate) => candidate.name === "create-feature"
              );
              assert.ok(action);
              return action
                .invoke({
                  prompt: "Fail this implementation in a typed way.",
                  worktreeName: "typed-failure",
                })
                .pipe(Effect.as([] as const));
            },
          };
          const application = yield* makeReferenceCodingApplication({
            conversationAgent,
            implementationAgent: ImplementationAgent.of({
              recover: () =>
                Ref.update(implementationRecoveries, (count) => count + 1).pipe(
                  Effect.andThen(
                    HandlerFailure.make({
                      category: "protocol",
                      safeDetail: "failed Execution must not recover",
                    })
                  )
                ),
              start: (request) =>
                Ref.update(implementationStarts, (count) => count + 1).pipe(
                  Effect.as({
                    completion: Deferred.succeed(
                      completionEntered,
                      undefined
                    ).pipe(
                      Effect.andThen(
                        HandlerFailure.make({
                          category: "exit",
                          safeDetail: "implementation command failed",
                        })
                      )
                    ),
                    resume: () => Effect.void,
                    sessionId: request.implementationSessionId,
                  })
                ),
            }),
            worktreeManager: WorktreeManager.of({
              create: () =>
                Effect.succeed({ workingDirectory: "/tmp/typed-failure" }),
            }),
          });
          const captureEvent = (event: ExternalInputEvent) =>
            Ref.update(acceptedEvents, (current) => [...current, event]).pipe(
              Effect.as({
                decision: {
                  _tag: "Accepted" as const,
                  eventId: event.eventId,
                },
                scheduling: "Scheduled" as const,
              })
            );

          yield* application.handle(
            ExternalInputEvent.make({
              conversationId: ThreadId.make("CFAILURE:1.0"),
              eventId: "event:start-typed-failure",
              payload: {},
              source: "test",
            }),
            publishNothing,
            captureEvent
          );
          yield* Deferred.await(completionEntered);
          yield* Effect.yieldNow;

          const events = yield* Ref.get(acceptedEvents);
          assert.strictEqual(events.length, 1);
          const failureEvent = events[0];
          assert.ok(failureEvent);
          assert.strictEqual(failureEvent.source, "implementation-failure");
          assert.deepStrictEqual(failureEvent.payload, {
            category: "exit",
            executionId: "CFAILURE:1.0:execution:1",
            kind: "implementation-failure",
            promptId:
              "msg_3c7c70858ba682c5cb827fade0368b338367c203a18156327a8b20ca7853a1c8",
          });
          yield* application.handle(failureEvent, publishNothing, captureEvent);
          assert.ok(application.recover);
          yield* application.recover(captureEvent);
          yield* Effect.yieldNow;

          assert.strictEqual((yield* Ref.get(acceptedEvents)).length, 1);
          assert.strictEqual(yield* Ref.get(implementationStarts), 1);
          assert.strictEqual(yield* Ref.get(implementationRecoveries), 0);
          const failureRequests = yield* Ref.get(observedFailureRequests);
          assert.strictEqual(failureRequests.length, 1);
          assert.strictEqual(
            failureRequests[0]?.executions[0]?.status,
            "failed"
          );
          assert.ok(
            failureRequests[0]?.input.includes(
              'source="implementation-failure" execution-id="CFAILURE:1.0:execution:1"'
            )
          );
        })
      )
  );

  it.effect(
    "re-drives a durably staged cancellation notice after interruption before Runner acceptance",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const acceptedEvents = yield* Ref.make<readonly ExternalInputEvent[]>(
            []
          );
          const application = yield* makeReferenceCodingApplication({
            conversationAgent: {
              handle: (request) => {
                const isCancellation = request.source === "cancel-request";
                const operation = isCancellation
                  ? request.executionControls.find(
                      (candidate) => candidate.name === "cancel"
                    )
                  : request.actions.find(
                      (candidate) => candidate.name === "create-feature"
                    );
                assert.ok(operation);
                return operation
                  .invoke(
                    isCancellation
                      ? {
                          control: "cancel",
                          executionId: "CCANCELDURABLE:1.0:execution:1",
                        }
                      : {
                          prompt: "Start cancellable durable work.",
                          worktreeName: "cancellation-outbox",
                        }
                  )
                  .pipe(Effect.as([] as const));
              },
            },
            implementationAgent: ImplementationAgent.of({
              start: (request) =>
                Effect.succeed({
                  completion: Effect.never,
                  control: () => Effect.void,
                  resume: () => Effect.void,
                  sessionId: request.implementationSessionId,
                }),
            }),
            worktreeManager: WorktreeManager.of({
              create: () =>
                Effect.succeed({
                  workingDirectory: "/tmp/cancellation-outbox",
                }),
            }),
          });
          const startEvent = ExternalInputEvent.make({
            conversationId: ThreadId.make("CCANCELDURABLE:1.0"),
            eventId: "event:start-cancellation-outbox",
            payload: {},
            source: "start-request",
          });
          yield* application.handle(startEvent, publishNothing, acceptEvent);
          const interruptCancellationAcceptance = (
            event: ExternalInputEvent
          ) =>
            event.source === "execution-control"
              ? Effect.interrupt
              : acceptEvent(event);
          yield* Effect.exit(
            application.handle(
              ExternalInputEvent.make({
                conversationId: startEvent.conversationId,
                eventId: "event:cancel-durable-work",
                payload: {},
                source: "cancel-request",
              }),
              publishNothing,
              interruptCancellationAcceptance
            )
          );
          const captureEvent = (event: ExternalInputEvent) =>
            Ref.update(acceptedEvents, (current) => [...current, event]).pipe(
              Effect.as({
                decision: {
                  _tag: "Accepted" as const,
                  eventId: event.eventId,
                },
                scheduling: "Scheduled" as const,
              })
            );

          assert.ok(application.recover);
          yield* application.recover(captureEvent);
          yield* application.recover(captureEvent);

          const events = yield* Ref.get(acceptedEvents);
          assert.strictEqual(events.length, 1);
          assert.strictEqual(events[0]?.source, "execution-control");
          assert.strictEqual(
            events[0]?.eventId,
            "CCANCELDURABLE:1.0:execution:1:control:cancel"
          );
        })
      )
  );

  it.effect(
    "re-drives a durably staged recovery failure after interruption before Runner acceptance",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* makeInMemoryApplicationRepository();
          const startEvent = ExternalInputEvent.make({
            conversationId: ThreadId.make("CRECOVERYOUTBOX:1.0"),
            eventId: "event:start-recovery-outbox",
            payload: {},
            source: "start-request",
          });
          yield* Effect.scoped(
            Effect.gen(function* () {
              const application = yield* makeReferenceCodingApplication({
                conversationAgent: {
                  handle: (request) => {
                    const action = request.actions.find(
                      (candidate) => candidate.name === "create-feature"
                    );
                    assert.ok(action);
                    return action
                      .invoke({
                        prompt: "Persist work for failed recovery.",
                        worktreeName: "recovery-failure-outbox",
                      })
                      .pipe(Effect.as([] as const));
                  },
                },
                implementationAgent: ImplementationAgent.of({
                  start: (request) =>
                    Effect.succeed({
                      completion: Effect.never,
                      resume: () => Effect.void,
                      sessionId: request.implementationSessionId,
                    }),
                }),
                repository,
                worktreeManager: WorktreeManager.of({
                  create: () =>
                    Effect.succeed({
                      workingDirectory: "/tmp/recovery-failure-outbox",
                    }),
                }),
              });
              yield* application.handle(
                startEvent,
                publishNothing,
                acceptEvent
              );
            })
          );

          const acceptanceAttempted = yield* Deferred.make<void>();
          yield* Effect.scoped(
            Effect.gen(function* () {
              const application = yield* makeReferenceCodingApplication({
                conversationAgent: { handle: () => Effect.succeed([]) },
                implementationAgent: ImplementationAgent.of({
                  recover: () =>
                    Effect.die(
                      new Error("invalid worktree must stop session recovery")
                    ),
                  start: () =>
                    Effect.die(new Error("recovery must not start a session")),
                }),
                repository,
                worktreeManager: WorktreeManager.of({
                  create: () =>
                    Effect.die(
                      new Error("recovery must not create a worktree")
                    ),
                  validate: () =>
                    HandlerFailure.make({
                      category: "protocol",
                      safeDetail: "persisted worktree is unavailable",
                    }),
                }),
              });
              assert.ok(application.recover);
              yield* application.recover((event) =>
                event.source === "execution-recovery"
                  ? Deferred.succeed(acceptanceAttempted, undefined).pipe(
                      Effect.andThen(Effect.interrupt)
                    )
                  : acceptEvent(event)
              );
              yield* Deferred.await(acceptanceAttempted);
            })
          );

          const acceptedEvents = yield* Ref.make<readonly ExternalInputEvent[]>(
            []
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              const application = yield* makeReferenceCodingApplication({
                conversationAgent: { handle: () => Effect.succeed([]) },
                implementationAgent: ImplementationAgent.of({
                  start: () =>
                    Effect.die(new Error("failed recovery must not retry")),
                }),
                repository,
                worktreeManager: WorktreeManager.of({
                  create: () =>
                    Effect.die(new Error("failed recovery must not retry")),
                }),
              });
              assert.ok(application.recover);
              yield* application.recover((event) =>
                Ref.update(acceptedEvents, (current) => [
                  ...current,
                  event,
                ]).pipe(
                  Effect.as({
                    decision: {
                      _tag: "Accepted" as const,
                      eventId: event.eventId,
                    },
                    scheduling: "Scheduled" as const,
                  })
                )
              );
            })
          );

          const events = yield* Ref.get(acceptedEvents);
          assert.strictEqual(events.length, 1);
          assert.strictEqual(events[0]?.source, "execution-recovery");
          assert.strictEqual(
            events[0]?.eventId,
            "CRECOVERYOUTBOX:1.0:execution:1:recovery-failure:worktree"
          );
        })
      )
  );

  it.effect(
    "rehydrates a completed Execution for follow-ups without re-running its completed prompt",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* makeInMemoryApplicationRepository();
          const initialCompletionEntered = yield* Deferred.make<void>();
          const resumeStarted = yield* Deferred.make<void>();
          const recoveries = yield* Ref.make(0);
          const resumeRequests = yield* Ref.make<
            readonly ImplementationAgentResumeRequest[]
          >([]);
          const conversationId = ThreadId.make("CCOMPLETEDRESTART:1.0");
          yield* Effect.scoped(
            Effect.gen(function* () {
              const application = yield* makeReferenceCodingApplication({
                conversationAgent: {
                  handle: (request) => {
                    const action = request.actions.find(
                      (candidate) => candidate.name === "create-feature"
                    );
                    assert.ok(action);
                    return action
                      .invoke({
                        prompt: "Complete before restart.",
                        worktreeName: "completed-restart",
                      })
                      .pipe(Effect.as([] as const));
                  },
                },
                implementationAgent: ImplementationAgent.of({
                  start: (request) =>
                    Effect.succeed({
                      completion: Deferred.succeed(
                        initialCompletionEntered,
                        undefined
                      ),
                      resume: () => Effect.void,
                      sessionId: request.implementationSessionId,
                    }),
                }),
                repository,
                worktreeManager: WorktreeManager.of({
                  create: () =>
                    Effect.succeed({
                      workingDirectory: "/tmp/completed-restart",
                    }),
                }),
              });
              yield* application.handle(
                ExternalInputEvent.make({
                  conversationId,
                  eventId: "event:start-completed-restart",
                  payload: {},
                  source: "start-request",
                }),
                publishNothing,
                acceptEvent
              );
              yield* Deferred.await(initialCompletionEntered);
              yield* Effect.yieldNow;
            })
          );

          yield* Effect.scoped(
            Effect.gen(function* () {
              const application = yield* makeReferenceCodingApplication({
                conversationAgent: {
                  handle: (request) => {
                    assert.strictEqual(
                      request.executions[0]?.status,
                      "completed"
                    );
                    const prompt = request.executionControls.find(
                      (candidate) => candidate.name === "prompt"
                    );
                    assert.ok(prompt);
                    return prompt
                      .invoke({
                        executionId: "CCOMPLETEDRESTART:1.0:execution:1",
                        prompt: "Continue after restart.",
                      })
                      .pipe(Effect.as([] as const));
                  },
                },
                implementationAgent: ImplementationAgent.of({
                  recover: (request) =>
                    Ref.update(recoveries, (count) => count + 1).pipe(
                      Effect.as({
                        completion: Effect.die(
                          new Error("completed prompt must not run again")
                        ),
                        resume: (resumeRequest) =>
                          Ref.update(resumeRequests, (current) => [
                            ...current,
                            resumeRequest,
                          ]).pipe(
                            Effect.andThen(
                              Deferred.succeed(resumeStarted, undefined)
                            )
                          ),
                        sessionId: request.implementationSessionId,
                      })
                    ),
                  start: () =>
                    Effect.die(
                      new Error("completed Execution must not start again")
                    ),
                }),
                repository,
                worktreeManager: WorktreeManager.of({
                  create: () =>
                    Effect.die(
                      new Error("completed Execution must reuse its worktree")
                    ),
                  validate: () => Effect.void,
                }),
              });
              assert.ok(application.recover);
              yield* application.recover(acceptEvent);
              yield* Effect.yieldNow;
              assert.strictEqual(yield* Ref.get(recoveries), 1);
              yield* application.handle(
                ExternalInputEvent.make({
                  conversationId,
                  eventId: "event:follow-up-after-completed-restart",
                  payload: {},
                  source: "follow-up-request",
                }),
                publishNothing,
                acceptEvent
              );
              yield* Deferred.await(resumeStarted);
            })
          );

          assert.deepStrictEqual(yield* Ref.get(resumeRequests), [
            {
              conversationId,
              executionId: "CCOMPLETEDRESTART:1.0:execution:1",
              implementationSessionId:
                "ses_6cbad5829b1f21a13aa316a0275ce71ea4b8c5beeddea27dce82f53313f7",
              prompt: "Continue after restart.",
              promptId:
                "msg_b926db375ee45e478c3c29e0dd11693e97e9e82a0eb3ce2039832d0084f4b563",
              workingDirectory: "/tmp/completed-restart",
            },
          ]);
        })
      )
  );

  it.effect(
    "states explicitly whether the Conversation session is being created for the first time",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* makeInMemoryApplicationRepository();
          const sessionFacts = yield* Ref.make<
            readonly (boolean | undefined)[]
          >([]);
          const conversationAgent = {
            handle: (request: ConversationAgentRequest) =>
              Ref.update(sessionFacts, (current) => [
                ...current,
                (
                  request as ConversationAgentRequest & {
                    readonly conversationSessionIsNew?: boolean;
                  }
                ).conversationSessionIsNew,
              ]).pipe(Effect.as([] as const)),
          };
          const makeApplication = makeReferenceCodingApplication({
            conversationAgent,
            implementationAgent: ImplementationAgent.of({
              start: () =>
                Effect.die(new Error("this test does not start Executions")),
            }),
            repository,
            worktreeManager: WorktreeManager.of({
              create: () =>
                Effect.die(new Error("this test does not create worktrees")),
            }),
          });
          const conversationId = ThreadId.make("CSESSIONFACT:1.0");
          const input = (eventId: string) =>
            ExternalInputEvent.make({
              conversationId,
              eventId,
              payload: {},
              source: "test",
            });

          yield* Effect.scoped(
            Effect.gen(function* () {
              const application = yield* makeApplication;
              yield* application.handle(
                input("event:session-fact:first"),
                publishNothing,
                acceptEvent
              );
              yield* application.handle(
                input("event:session-fact:second"),
                publishNothing,
                acceptEvent
              );
            })
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              const application = yield* makeApplication;
              yield* application.handle(
                input("event:session-fact:after-restart"),
                publishNothing,
                acceptEvent
              );
            })
          );

          assert.deepStrictEqual(yield* Ref.get(sessionFacts), [
            true,
            false,
            false,
          ]);
        })
      )
  );

  it.effect("refuses to load an Application snapshot through a symlink", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped(
          "laborer-eighth-application-snapshot-"
        );
        const realSnapshot = join(root, "real-application.json");
        const linkedSnapshot = join(root, "linked-application.json");
        yield* makeFileApplicationRepository(realSnapshot, root);
        yield* Effect.promise(() => symlink(realSnapshot, linkedSnapshot));

        const result = yield* Effect.result(
          makeFileApplicationRepository(linkedSnapshot, root)
        );

        assert.strictEqual(result._tag, "Failure");
      })
    )
  );

  it.effect(
    "cleans unpublished temporary snapshots and distinguishes ancillary post-publication failure",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-eighth-application-publication-"
          );
          const snapshot = join(root, "application.json");
          let failurePoint: "before" | "after" | null = null;
          const repository = yield* makeFileApplicationRepository(
            snapshot,
            root,
            {
              afterRename: () =>
                failurePoint === "after"
                  ? Promise.reject(new Error("injected after rename"))
                  : Promise.resolve(),
              beforeRename: () =>
                failurePoint === "before"
                  ? Promise.reject(new Error("injected before rename"))
                  : Promise.resolve(),
            }
          );
          const state = yield* repository.load;

          failurePoint = "before";
          const unpublished = yield* Effect.result(repository.save(state));
          assert.strictEqual(unpublished._tag, "Failure");
          assert.deepStrictEqual(
            (yield* Effect.promise(() => readdir(root))).filter((name) =>
              name.endsWith(".tmp")
            ),
            []
          );

          failurePoint = "after";
          const published = yield* repository.save(state);
          assert.deepStrictEqual(published, {
            _tag: "PublishedWithError",
            failureStage: "after-rename-hook",
          });
          assert.deepStrictEqual(yield* repository.load, state);
        })
      )
  );

  it.effect(
    "fails an implementation start once instead of leaving it eligible for automatic recovery",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const acceptedEvents = yield* Ref.make<readonly ExternalInputEvent[]>(
            []
          );
          const observedStatuses = yield* Ref.make<readonly string[]>([]);
          const starts = yield* Ref.make(0);
          const application = yield* makeReferenceCodingApplication({
            conversationAgent: {
              handle: (request) => {
                if (request.source === "inspect") {
                  return Ref.set(
                    observedStatuses,
                    request.executions.map((execution) => execution.status)
                  ).pipe(Effect.as([] as const));
                }
                const action = request.actions.find(
                  (candidate) => candidate.name === "create-feature"
                );
                assert.ok(action);
                return Effect.result(
                  action.invoke({
                    prompt: "Fail while starting.",
                    worktreeName: "failed-start",
                  })
                ).pipe(Effect.as([] as const));
              },
            },
            implementationAgent: ImplementationAgent.of({
              start: () =>
                Ref.update(starts, (count) => count + 1).pipe(
                  Effect.andThen(
                    HandlerFailure.make({
                      category: "exit",
                      safeDetail: "implementation failed to start",
                    })
                  )
                ),
            }),
            worktreeManager: WorktreeManager.of({
              create: () =>
                Effect.succeed({ workingDirectory: "/tmp/failed-start" }),
            }),
          });
          const captureEvent = (event: ExternalInputEvent) =>
            Ref.update(acceptedEvents, (current) => [...current, event]).pipe(
              Effect.as({
                decision: {
                  _tag: "Accepted" as const,
                  eventId: event.eventId,
                },
                scheduling: "Scheduled" as const,
              })
            );
          const conversationId = ThreadId.make("CFAILEDSTART:1.0");

          yield* application.handle(
            ExternalInputEvent.make({
              conversationId,
              eventId: "event:failed-start",
              payload: {},
              source: "test",
            }),
            publishNothing,
            captureEvent
          );
          assert.ok(application.recover);
          yield* application.recover(captureEvent);
          yield* Effect.yieldNow;
          yield* application.handle(
            ExternalInputEvent.make({
              conversationId,
              eventId: "event:inspect-failed-start",
              payload: {},
              source: "inspect",
            }),
            publishNothing,
            captureEvent
          );

          assert.strictEqual(yield* Ref.get(starts), 1);
          assert.deepStrictEqual(yield* Ref.get(observedStatuses), ["failed"]);
          const failureEvents = (yield* Ref.get(acceptedEvents)).filter(
            (event) => event.source === "implementation-failure"
          );
          assert.strictEqual(failureEvents.length, 1);
        })
      )
  );

  it.effect(
    "does not run queued prompts after a typed implementation failure",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const releaseInitial = yield* Deferred.make<void>();
          const failureAccepted = yield* Deferred.make<void>();
          const resumes = yield* Ref.make(0);
          const conversationId = ThreadId.make("CFAILEDQUEUE:1.0");
          const application = yield* makeReferenceCodingApplication({
            conversationAgent: {
              handle: (request) => {
                const operation =
                  request.source === "queue-request"
                    ? request.executionControls.find(
                        (candidate) => candidate.name === "prompt"
                      )
                    : request.actions.find(
                        (candidate) => candidate.name === "create-feature"
                      );
                assert.ok(operation);
                return operation
                  .invoke(
                    request.source === "queue-request"
                      ? {
                          executionId: "CFAILEDQUEUE:1.0:execution:1",
                          prompt: "Must remain unsubmitted.",
                        }
                      : {
                          prompt: "Fail before the queue advances.",
                          worktreeName: "failed-queue",
                        }
                  )
                  .pipe(Effect.as([] as const));
              },
            },
            implementationAgent: ImplementationAgent.of({
              start: (request) =>
                Effect.succeed({
                  completion: Deferred.await(releaseInitial).pipe(
                    Effect.andThen(
                      HandlerFailure.make({
                        category: "exit",
                        safeDetail: "initial implementation failed",
                      })
                    )
                  ),
                  resume: () => Ref.update(resumes, (count) => count + 1),
                  sessionId: request.implementationSessionId,
                }),
            }),
            worktreeManager: WorktreeManager.of({
              create: () =>
                Effect.succeed({ workingDirectory: "/tmp/failed-queue" }),
            }),
          });
          const captureEvent = (event: ExternalInputEvent) =>
            (event.source === "implementation-failure"
              ? Deferred.succeed(failureAccepted, undefined)
              : Effect.void
            ).pipe(
              Effect.as({
                decision: {
                  _tag: "Accepted" as const,
                  eventId: event.eventId,
                },
                scheduling: "Scheduled" as const,
              })
            );

          yield* application.handle(
            ExternalInputEvent.make({
              conversationId,
              eventId: "event:start-failed-queue",
              payload: {},
              source: "start-request",
            }),
            publishNothing,
            captureEvent
          );
          yield* application.handle(
            ExternalInputEvent.make({
              conversationId,
              eventId: "event:queue-before-failure",
              payload: {},
              source: "queue-request",
            }),
            publishNothing,
            captureEvent
          );
          yield* Deferred.succeed(releaseInitial, undefined);
          yield* Deferred.await(failureAccepted);
          yield* Effect.yieldNow;

          assert.strictEqual(yield* Ref.get(resumes), 0);
        })
      )
  );
});
