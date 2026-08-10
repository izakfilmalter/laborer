import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect } from "effect";
import {
  type AcceptApplicationEvent,
  ExternalInputEvent,
} from "../src/application.ts";
import { ThreadId } from "../src/core/domain.ts";
import {
  type ConversationAgentRequest,
  ImplementationAgent,
  makeFileApplicationRepository,
  makeReferenceCodingApplication,
  WorktreeManager,
} from "../src/reference-coding-application.ts";
import { makeTempDirectoryScoped } from "./support/temp-directory.ts";

const publishNothing = () => Effect.void;

const makeAcceptEvent = () => {
  const events = new Map<string, ExternalInputEvent>();
  const calls: string[] = [];
  const accept: AcceptApplicationEvent = (event) =>
    Effect.sync(() => {
      calls.push(event.eventId);
      const existing = events.get(event.eventId);
      if (existing !== undefined) {
        assert.deepStrictEqual(event, existing);
        return {
          decision: { _tag: "Duplicate" as const, eventId: event.eventId },
          scheduling: "AlreadyDurable" as const,
        };
      }
      events.set(event.eventId, event);
      return {
        decision: { _tag: "Accepted" as const, eventId: event.eventId },
        scheduling: "Scheduled" as const,
      };
    });
  return { accept, calls, events };
};

const actionEvent = (conversationId: ThreadId) =>
  ExternalInputEvent.make({
    conversationId,
    eventId: "participant:251:start",
    payload: {},
    source: "test-participant",
  });

describe("in-flight Execution restart boundaries", () => {
  for (const boundary of ["allocated", "worktree-created"] as const) {
    it.effect(
      `reuses every durable identity after restart when ${boundary}`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const root = yield* makeTempDirectoryScoped(
              `laborer-251-${boundary}-`
            );
            const repository = yield* makeFileApplicationRepository(
              join(root, "application.json"),
              root
            );
            const conversationId = ThreadId.make("workspace:T251:C251:251.1");
            const reachedBoundary = yield* Deferred.make<void>();
            let worktreeExists = false;
            let worktreeCreates = 0;
            let implementationExists = false;
            let implementationStarts = 0;
            let implementationRecoveries = 0;

            const conversationAgent = {
              handle: (request: ConversationAgentRequest) => {
                const action = request.actions.find(
                  ({ name }) => name === "create-feature"
                );
                assert.ok(action);
                return action
                  .invoke({
                    prompt: "Implement exactly once across restart.",
                    title: "Execution task",
                    worktreeName: "resume-boundary",
                  })
                  .pipe(Effect.as([] as const));
              },
              recover: (request: ConversationAgentRequest) => {
                const action = request.actions.find(
                  ({ name }) => name === "create-feature"
                );
                assert.ok(action);
                return action
                  .invoke({
                    prompt: "Implement exactly once across restart.",
                    title: "Execution task",
                    worktreeName: "resume-boundary",
                  })
                  .pipe(Effect.as([] as const));
              },
            };
            const makeApplication = (crashBoundary: typeof boundary | null) =>
              makeReferenceCodingApplication({
                conversationAgent,
                implementationAgent: ImplementationAgent.of({
                  inspect: (request) =>
                    Effect.succeed(
                      implementationExists
                        ? {
                            certainty: "definitive" as const,
                            evidence: "exact-owned-resource" as const,
                            resource: {
                              sessionId: request.implementationSessionId,
                            },
                            status: "available" as const,
                          }
                        : {
                            certainty: "definitive" as const,
                            evidence: "definitively-absent" as const,
                            status: "recoverable" as const,
                          }
                    ),
                  recover: (request) =>
                    Effect.sync(() => {
                      implementationRecoveries += 1;
                      return {
                        completion: Effect.never,
                        resume: () => Effect.void,
                        sessionId: request.implementationSessionId,
                      };
                    }),
                  start: (request) =>
                    Effect.sync(() => {
                      implementationExists = true;
                      implementationStarts += 1;
                      return {
                        completion: Effect.never,
                        resume: () => Effect.void,
                        sessionId: request.implementationSessionId,
                      };
                    }),
                }),
                repository,
                ...(crashBoundary === null
                  ? {}
                  : {
                      testHooks: {
                        ...(crashBoundary === "allocated"
                          ? {
                              afterExecutionAllocated: () =>
                                Deferred.succeed(
                                  reachedBoundary,
                                  undefined
                                ).pipe(
                                  Effect.andThen(Effect.never),
                                  Effect.runPromise
                                ),
                            }
                          : {
                              afterWorktreeCreated: () =>
                                Deferred.succeed(
                                  reachedBoundary,
                                  undefined
                                ).pipe(
                                  Effect.andThen(Effect.never),
                                  Effect.runPromise
                                ),
                            }),
                      },
                    }),
                worktreeManager: WorktreeManager.of({
                  create: () =>
                    Effect.sync(() => {
                      worktreeCreates += 1;
                      worktreeExists = true;
                      return {
                        workingDirectory: join(root, "resume-boundary"),
                      };
                    }),
                  inspect: () =>
                    Effect.succeed(
                      worktreeExists
                        ? {
                            certainty: "definitive" as const,
                            evidence: "exact-owned-resource" as const,
                            resource: {
                              workingDirectory: join(root, "resume-boundary"),
                            },
                            status: "available" as const,
                          }
                        : {
                            certainty: "definitive" as const,
                            evidence: "definitively-absent" as const,
                            status: "recoverable" as const,
                          }
                    ),
                }),
              });

            yield* Effect.scoped(
              Effect.gen(function* () {
                const application = yield* makeApplication(boundary);
                yield* application
                  .handle(
                    actionEvent(conversationId),
                    publishNothing,
                    makeAcceptEvent().accept
                  )
                  .pipe(Effect.forkScoped);
                yield* Deferred.await(reachedBoundary);
              })
            );

            const before = (yield* repository.load).executions[0];
            assert.ok(before);
            const restarted = yield* makeApplication(null);
            yield* restarted.recover?.(makeAcceptEvent().accept) ?? Effect.void;
            yield* restarted.handle(
              actionEvent(conversationId),
              publishNothing,
              makeAcceptEvent().accept
            );

            const after = (yield* repository.load).executions[0];
            assert.ok(after);
            assert.strictEqual((yield* repository.load).executions.length, 1);
            assert.strictEqual(after.executionId, before.executionId);
            assert.strictEqual(
              after.implementationSessionId,
              before.implementationSessionId
            );
            assert.strictEqual(
              after.prompts[0]?.promptId,
              before.prompts[0]?.promptId
            );
            assert.strictEqual(after.prompts[0]?.text, before.prompts[0]?.text);
            assert.strictEqual(
              after.workingDirectory,
              join(root, "resume-boundary")
            );
            assert.strictEqual(worktreeCreates, 1);
            assert.strictEqual(implementationStarts, 1);
            assert.strictEqual(implementationRecoveries, 0);
          })
        )
    );
  }

  for (const boundary of ["response-staged", "event-accepted"] as const) {
    it.effect(
      `creates one Conversation wake after restart when ${boundary}`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const root = yield* makeTempDirectoryScoped(
              `laborer-251-${boundary}-`
            );
            const repository = yield* makeFileApplicationRepository(
              join(root, "application.json"),
              root
            );
            const conversationId = ThreadId.make("workspace:T251:C251:251.2");
            const reachedBoundary = yield* Deferred.make<void>();
            const accepted = makeAcceptEvent();
            const observedSources: string[] = [];
            let starts = 0;
            let recoveries = 0;
            let responseProductions = 0;

            const makeApplication = (crash: boolean) =>
              makeReferenceCodingApplication({
                conversationAgent: {
                  handle: (request) => {
                    observedSources.push(request.source);
                    if (request.source !== "test-participant") {
                      return Effect.succeed([]);
                    }
                    const action = request.actions.find(
                      ({ name }) => name === "create-feature"
                    );
                    assert.ok(action);
                    return action
                      .invoke({
                        prompt: "Produce one durable response.",
                        title: "Execution task",
                        worktreeName: "response-boundary",
                      })
                      .pipe(Effect.as([] as const));
                  },
                },
                implementationAgent: ImplementationAgent.of({
                  inspect: (request) =>
                    Effect.succeed({
                      certainty: "definitive",
                      evidence: "exact-owned-resource",
                      resource: { sessionId: request.implementationSessionId },
                      status: "available",
                    }),
                  recover: (request) =>
                    Effect.sync(() => {
                      recoveries += 1;
                      return {
                        completion: Effect.void,
                        resume: () => Effect.void,
                        sessionId: request.implementationSessionId,
                      };
                    }),
                  start: (request, acceptResponse) =>
                    Effect.sync(() => {
                      starts += 1;
                      return {
                        completion: Effect.sync(() => {
                          responseProductions += 1;
                        }).pipe(
                          Effect.andThen(
                            acceptResponse({
                              responseId: "response:251",
                              text: "Persist this response exactly once.",
                            })
                          )
                        ),
                        resume: () => Effect.void,
                        sessionId: request.implementationSessionId,
                      };
                    }),
                }),
                repository,
                ...(crash
                  ? {
                      testHooks: {
                        ...(boundary === "response-staged"
                          ? {
                              afterImplementationResponseStaged: () =>
                                Deferred.succeed(
                                  reachedBoundary,
                                  undefined
                                ).pipe(
                                  Effect.andThen(Effect.never),
                                  Effect.runPromise
                                ),
                            }
                          : {
                              afterExecutionEventAccepted: ({
                                recordKind,
                              }: {
                                readonly recordKind: string;
                              }) =>
                                recordKind === "response"
                                  ? Deferred.succeed(
                                      reachedBoundary,
                                      undefined
                                    ).pipe(
                                      Effect.andThen(Effect.never),
                                      Effect.runPromise
                                    )
                                  : Promise.resolve(),
                            }),
                      },
                    }
                  : {}),
                worktreeManager: WorktreeManager.of({
                  create: () =>
                    Effect.succeed({
                      workingDirectory: join(root, "response-boundary"),
                    }),
                  inspect: () =>
                    Effect.succeed({
                      certainty: "definitive",
                      evidence: "exact-owned-resource",
                      resource: {
                        workingDirectory: join(root, "response-boundary"),
                      },
                      status: "available",
                    }),
                }),
              });

            yield* Effect.scoped(
              Effect.gen(function* () {
                const application = yield* makeApplication(true);
                yield* application.handle(
                  actionEvent(conversationId),
                  publishNothing,
                  accepted.accept
                );
                yield* Deferred.await(reachedBoundary);
              })
            );

            const restarted = yield* makeApplication(false);
            yield* restarted.recover?.(accepted.accept) ?? Effect.void;
            for (const event of accepted.events.values()) {
              yield* restarted.handle(event, publishNothing, accepted.accept);
            }

            const state = yield* repository.load;
            const execution = state.executions[0];
            assert.ok(execution);
            assert.strictEqual(state.executions.length, 1);
            assert.strictEqual(execution.responses.length, 1);
            assert.strictEqual(execution.responses[0]?.status, "delivered");
            assert.strictEqual(starts, 1);
            assert.strictEqual(recoveries, 1);
            assert.strictEqual(responseProductions, 1);
            assert.deepStrictEqual(
              [...accepted.events.values()].map(({ source }) => source),
              ["implementation-agent", "action-terminal"]
            );
            assert.deepStrictEqual(observedSources, [
              "test-participant",
              "implementation-agent",
              "action-terminal",
            ]);
            const responseEventId = `${execution.executionId}:response:response:251`;
            assert.ok(
              accepted.calls.filter((eventId) => eventId === responseEventId)
                .length >= (boundary === "event-accepted" ? 2 : 1)
            );
            assert.strictEqual(
              state.executionEventOutbox.filter(
                ({ status }) => status !== "settled"
              ).length,
              0
            );
          })
        )
    );
  }
});
