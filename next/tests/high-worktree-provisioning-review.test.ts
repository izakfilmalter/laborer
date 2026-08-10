import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Option, Ref } from "effect";
import { ExternalInputEvent } from "../src/application.ts";
import { ThreadId } from "../src/core/domain.ts";
import { HandlerFailure } from "../src/core/errors.ts";
import {
  ImplementationAgent,
  makeInMemoryApplicationRepository,
  makeReferenceCodingApplication,
  WorktreeManager,
  WorktreeProvisioningUncertain,
} from "../src/reference-coding-application.ts";

const publishNothing = () => Effect.void;
const acceptEvent = (event: ExternalInputEvent) =>
  Effect.succeed({
    decision: { _tag: "Accepted" as const, eventId: event.eventId },
    scheduling: "Scheduled" as const,
  });

describe("uncertain worktree provisioning", () => {
  it.effect(
    "retains the provisional Execution and immediately repairs an exact checkout after an ambiguous side effect",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const recoveries = yield* Ref.make(0);
          const starts = yield* Ref.make(0);
          const acceptedStatuses = yield* Ref.make<readonly string[]>([]);
          const application = yield* makeReferenceCodingApplication({
            conversationAgent: {
              handle: (request) => {
                const action = request.actions.find(
                  (candidate) => candidate.name === "create-feature"
                );
                assert.ok(action);
                return action
                  .invoke({
                    prompt: "Recover an ambiguously created checkout.",
                    title: "Execution task",
                    worktreeName: "ambiguous-create",
                  })
                  .pipe(
                    Effect.tap((accepted) =>
                      Ref.update(acceptedStatuses, (current) => [
                        ...current,
                        accepted.status,
                      ])
                    ),
                    Effect.as([] as const)
                  );
              },
            },
            implementationAgent: ImplementationAgent.of({
              start: (request) =>
                Ref.update(starts, (count) => count + 1).pipe(
                  Effect.as({
                    completion: Effect.never,
                    resume: () => Effect.void,
                    sessionId: request.implementationSessionId,
                  })
                ),
            }),
            worktreeManager: WorktreeManager.of({
              create: () =>
                WorktreeProvisioningUncertain.make({
                  failure: HandlerFailure.make({
                    category: "exit",
                    safeDetail: "Git worktree provisioning is uncertain",
                  }),
                }),
              recover: () =>
                Ref.update(recoveries, (count) => count + 1).pipe(
                  Effect.as({ workingDirectory: "/tmp/ambiguous-create" })
                ),
            }),
          });

          yield* application.handle(
            ExternalInputEvent.make({
              conversationId: ThreadId.make("CUNCERTAIN:1.0"),
              eventId: "event:ambiguous-create",
              payload: {},
              source: "test",
            }),
            publishNothing,
            acceptEvent
          );

          assert.strictEqual(yield* Ref.get(recoveries), 1);
          assert.strictEqual(yield* Ref.get(starts), 1);
          assert.deepStrictEqual(yield* Ref.get(acceptedStatuses), ["running"]);
        })
      )
  );

  it.effect(
    "keeps uncertain provisioning recoverable across repeated restarts",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* makeInMemoryApplicationRepository();
          const recoveryAttempted = yield* Deferred.make<void>();
          const implementationStarted = yield* Deferred.make<void>();
          const recoveryFailureEvents = yield* Ref.make(0);
          const conversationId = ThreadId.make("CUNCERTAINRESTART:1.0");
          const uncertain = () =>
            WorktreeProvisioningUncertain.make({
              failure: HandlerFailure.make({
                category: "exit",
                safeDetail: "Git worktree provisioning is uncertain",
              }),
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
                    return Effect.result(
                      action.invoke({
                        prompt: "Persist uncertain worktree ownership.",
                        title: "Execution task",
                        worktreeName: "uncertain-restart",
                      })
                    ).pipe(Effect.as([] as const));
                  },
                },
                implementationAgent: ImplementationAgent.of({
                  start: () =>
                    Effect.die(
                      new Error("uncertain provisioning must not start yet")
                    ),
                }),
                repository,
                worktreeManager: WorktreeManager.of({
                  create: uncertain,
                  recover: uncertain,
                }),
              });
              yield* application.handle(
                ExternalInputEvent.make({
                  conversationId,
                  eventId: "event:uncertain-start",
                  payload: {},
                  source: "test",
                }),
                publishNothing,
                acceptEvent
              );
            })
          );

          const captureEvent = (event: ExternalInputEvent) =>
            (event.source === "execution-recovery"
              ? Ref.update(recoveryFailureEvents, (count) => count + 1)
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
          yield* Effect.scoped(
            Effect.gen(function* () {
              const application = yield* makeReferenceCodingApplication({
                conversationAgent: { handle: () => Effect.succeed([]) },
                implementationAgent: ImplementationAgent.of({
                  start: () =>
                    Effect.die(
                      new Error("uncertain recovery must not start yet")
                    ),
                }),
                repository,
                worktreeManager: WorktreeManager.of({
                  create: () =>
                    Effect.die(new Error("restart must use recovery")),
                  recover: () =>
                    Deferred.succeed(recoveryAttempted, undefined).pipe(
                      Effect.andThen(uncertain())
                    ),
                }),
              });
              assert.ok(application.recover);
              yield* application.recover(captureEvent);
              yield* Deferred.await(recoveryAttempted);
            })
          );

          yield* Effect.scoped(
            Effect.gen(function* () {
              const application = yield* makeReferenceCodingApplication({
                conversationAgent: { handle: () => Effect.succeed([]) },
                implementationAgent: ImplementationAgent.of({
                  start: (request) =>
                    Deferred.succeed(implementationStarted, undefined).pipe(
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
                    Effect.die(new Error("restart must use recovery")),
                  recover: () =>
                    Effect.succeed({
                      workingDirectory: "/tmp/uncertain-restart",
                    }),
                  validate: () => Effect.void,
                }),
              });
              assert.ok(application.recover);
              yield* application.recover(captureEvent);
              yield* Effect.yieldNow;
              yield* Effect.yieldNow;
              assert.strictEqual(
                Option.isSome(yield* Deferred.poll(implementationStarted)),
                true
              );
            })
          );

          assert.strictEqual(yield* Ref.get(recoveryFailureEvents), 0);
        })
      )
  );

  it.effect(
    "discards a provisional Execution after a preflight collision without attempting adoption",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const recoveries = yield* Ref.make(0);
          const observedExecutions = yield* Ref.make<readonly string[]>([]);
          const conversationId = ThreadId.make("CPREFLIGHT:1.0");
          const application = yield* makeReferenceCodingApplication({
            conversationAgent: {
              handle: (request) => {
                if (request.source === "inspect") {
                  return Ref.set(
                    observedExecutions,
                    request.executions.map((execution) => execution.executionId)
                  ).pipe(Effect.as([] as const));
                }
                const action = request.actions.find(
                  (candidate) => candidate.name === "create-feature"
                );
                assert.ok(action);
                return Effect.result(
                  action.invoke({
                    prompt: "Do not adopt the collided checkout.",
                    title: "Execution task",
                    worktreeName: "existing-foreign-checkout",
                  })
                ).pipe(Effect.as([] as const));
              },
            },
            implementationAgent: ImplementationAgent.of({
              start: () =>
                Effect.die(new Error("a preflight collision must not start")),
            }),
            worktreeManager: WorktreeManager.of({
              create: () =>
                HandlerFailure.make({
                  category: "protocol",
                  safeDetail: "worktree name already exists",
                }),
              recover: () =>
                Ref.update(recoveries, (count) => count + 1).pipe(
                  Effect.as({ workingDirectory: "/tmp/must-not-adopt" })
                ),
            }),
          });
          const event = (eventId: string, source: string) =>
            ExternalInputEvent.make({
              conversationId,
              eventId,
              payload: {},
              source,
            });

          yield* application.handle(
            event("event:collision", "create"),
            publishNothing,
            acceptEvent
          );
          yield* application.handle(
            event("event:inspect", "inspect"),
            publishNothing,
            acceptEvent
          );

          assert.deepStrictEqual(yield* Ref.get(observedExecutions), []);
          assert.strictEqual(yield* Ref.get(recoveries), 0);
        })
      )
  );
});
