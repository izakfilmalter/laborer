import { assert, describe, it } from "@effect/vitest";
import { Effect, Ref } from "effect";
import {
  makeOpenCodeImplementationAgent,
  type OpenCodeSessionClient,
} from "../src/adapters/opencode-agents.ts";
import { ExternalInputEvent } from "../src/application.ts";
import { ThreadId } from "../src/prototype/domain.ts";
import { HandlerFailure } from "../src/prototype/errors.ts";
import {
  ImplementationAgent,
  makeInMemoryApplicationRepository,
  makeReferenceCodingApplication,
  type ReferenceCodingApplicationRepository,
  WorktreeManager,
} from "../src/reference-coding-application.ts";

const UNTRUSTED_REFERENCE_PATTERN = /trust="untrusted-reference-only"/;
const PRIVATE_RECOVERY_DETAIL_PATTERN =
  /\/tmp\/resource-254|raw adapter error/i;

const publishNothing = () => Effect.void;

const acceptedEvent = (event: ExternalInputEvent) =>
  Effect.succeed({
    decision: { _tag: "Accepted" as const, eventId: event.eventId },
    scheduling: "Scheduled" as const,
  });

const exactWorktree = (workingDirectory: string) =>
  Effect.succeed({
    certainty: "definitive" as const,
    evidence: "exact-owned-resource" as const,
    resource: { workingDirectory },
    status: "available" as const,
  });

const exactSession = (sessionId: string) =>
  Effect.succeed({
    certainty: "definitive" as const,
    evidence: "exact-owned-resource" as const,
    resource: { sessionId },
    status: "available" as const,
  });

const startExecution = (
  repository: ReferenceCodingApplicationRepository,
  conversationId: ThreadId,
  workingDirectory: string
) =>
  Effect.scoped(
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
                prompt: "Implement the persisted recovery fixture.",
                worktreeName: "resource-recovery",
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
          create: () => Effect.succeed({ workingDirectory }),
        }),
      });
      yield* application.handle(
        ExternalInputEvent.make({
          conversationId,
          eventId: "event:start-resource-recovery",
          payload: {},
          source: "test",
        }),
        publishNothing,
        acceptedEvent
      );
    })
  );

describe("Execution resource recovery v14", () => {
  it.effect(
    "keeps cleanup failures safely unresolved without a duplicate session or prompt",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* makeInMemoryApplicationRepository();
          const conversationId = ThreadId.make(
            "workspace:T254:C254:permission-cleanup"
          );
          const workingDirectory = "/tmp/permission-cleanup-254";
          yield* startExecution(repository, conversationId, workingDirectory);
          let cleanupAttempts = 0;
          let creates = 0;
          let prompts = 0;
          const client: OpenCodeSessionClient = {
            createSession: () =>
              Effect.sync(() => {
                creates += 1;
              }),
            interrupt: () => Effect.void,
            prepareSessionForReuse: () => {
              cleanupAttempts += 1;
              return HandlerFailure.make({
                category: "exit",
                safeDetail: "OpenCode legacy permission cleanup failed",
              });
            },
            readMessages: () => Effect.succeed([]),
            sessionExists: () => Effect.succeed(true),
            submitPrompt: () =>
              Effect.sync(() => {
                prompts += 1;
              }),
            wait: () => Effect.void,
          };
          const before = (yield* repository.load).executions[0];
          assert.ok(before);
          const application = yield* makeReferenceCodingApplication({
            conversationAgent: { handle: () => Effect.succeed([]) },
            implementationAgent: makeOpenCodeImplementationAgent({ client }),
            repository,
            worktreeManager: WorktreeManager.of({
              create: () => Effect.die(new Error("must not create worktree")),
              inspect: () => exactWorktree(workingDirectory),
            }),
          });

          yield* application.recover?.(acceptedEvent) ?? Effect.void;
          yield* application.recover?.(acceptedEvent) ?? Effect.void;

          const after = (yield* repository.load).executions[0];
          assert.ok(after);
          assert.strictEqual(cleanupAttempts, 2);
          assert.strictEqual(creates, 0);
          assert.strictEqual(prompts, 0);
          assert.strictEqual(after.executionId, before.executionId);
          assert.strictEqual(
            after.implementationSessionId,
            before.implementationSessionId
          );
          assert.strictEqual(after.workingDirectory, before.workingDirectory);
          assert.strictEqual(after.attachment?.state, "unresolved");
          assert.strictEqual(after.recoveryFailure, null);
          assert.strictEqual(after.prompts[0]?.attempt?.state, "unresolved");
        })
      )
  );

  it.effect(
    "keeps a missing session unresolved when prompt admission is unknown",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* makeInMemoryApplicationRepository();
          const conversationId = ThreadId.make("workspace:T254:C254:unknown");
          yield* startExecution(
            repository,
            conversationId,
            "/tmp/unknown-session-254"
          );
          yield* repository.transact((state) => {
            const execution = state.executions[0];
            const prompt = execution?.prompts[0];
            assert.ok(execution);
            assert.ok(prompt?.attempt);
            return [
              undefined,
              {
                ...state,
                executions: [
                  {
                    ...execution,
                    prompts: [
                      {
                        ...prompt,
                        attempt: {
                          ...prompt.attempt,
                          certainty: "unknown" as const,
                          state: "submitting" as const,
                        },
                        status: "submitting" as const,
                      },
                    ],
                    status: "implementation_start_staged" as const,
                  },
                ],
              },
            ];
          });
          const starts = yield* Ref.make(0);
          const inspections = yield* Ref.make<readonly string[]>([]);
          const application = yield* makeReferenceCodingApplication({
            conversationAgent: { handle: () => Effect.succeed([]) },
            implementationAgent: ImplementationAgent.of({
              inspect: (request) =>
                Ref.update(inspections, (states) => [
                  ...states,
                  request.creationState,
                ]).pipe(
                  Effect.as({
                    certainty: "definitive" as const,
                    evidence: "definitively-absent" as const,
                    status: "missing" as const,
                  })
                ),
              start: () =>
                Ref.update(starts, (count) => count + 1).pipe(
                  Effect.andThen(Effect.die(new Error("must not start")))
                ),
            }),
            repository,
            worktreeManager: WorktreeManager.of({
              create: () => Effect.die(new Error("must not create worktree")),
              inspect: () => exactWorktree("/tmp/unknown-session-254"),
            }),
          });
          yield* application.recover?.(acceptedEvent) ?? Effect.void;

          const execution = (yield* repository.load).executions[0];
          assert.deepStrictEqual(yield* Ref.get(inspections), ["unknown"]);
          assert.strictEqual(yield* Ref.get(starts), 0);
          assert.strictEqual(execution?.recoveryFailure, null);
          assert.strictEqual(execution?.attachment?.state, "unresolved");
          assert.strictEqual(
            execution?.prompts[0]?.attempt?.certainty,
            "unknown"
          );
          assert.strictEqual(
            execution?.prompts[0]?.attempt?.state,
            "unresolved"
          );
        })
      )
  );

  it.effect(
    "persists unknown admission before recoverable start and never starts twice after a boundary failure",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* makeInMemoryApplicationRepository();
          const conversationId = ThreadId.make(
            "workspace:T251:C251:submitting-boundary"
          );
          yield* startExecution(
            repository,
            conversationId,
            "/tmp/submitting-boundary-251"
          );
          yield* repository.transact((state) => {
            const execution = state.executions[0];
            const prompt = execution?.prompts[0];
            assert.ok(execution);
            assert.ok(prompt?.attempt);
            return [
              undefined,
              {
                ...state,
                executions: [
                  {
                    ...execution,
                    prompts: [
                      {
                        ...prompt,
                        attempt: {
                          ...prompt.attempt,
                          admittedAt: null,
                          certainty: "pre-admission" as const,
                          runningAt: null,
                          state: "prepared" as const,
                          submittingAt: null,
                        },
                        status: "staged" as const,
                      },
                    ],
                    status: "implementation_ready" as const,
                  },
                ],
              },
            ];
          });
          const starts = yield* Ref.make(0);
          const makeApplication = (failAfterSubmitting: boolean) =>
            makeReferenceCodingApplication({
              conversationAgent: { handle: () => Effect.succeed([]) },
              implementationAgent: ImplementationAgent.of({
                inspect: (request) =>
                  request.creationState === "staged"
                    ? Effect.succeed({
                        certainty: "definitive" as const,
                        evidence: "definitively-absent" as const,
                        status: "recoverable" as const,
                      })
                    : Effect.succeed({
                        certainty: "definitive" as const,
                        evidence: "definitively-absent" as const,
                        status: "missing" as const,
                      }),
                start: () =>
                  Ref.update(starts, (count) => count + 1).pipe(
                    Effect.andThen(Effect.never)
                  ),
              }),
              repository,
              ...(failAfterSubmitting
                ? {
                    testHooks: {
                      afterImplementationPromptSubmitting: () =>
                        Promise.reject(
                          new Error("simulated crash after durable submitting")
                        ),
                    },
                  }
                : {}),
              worktreeManager: WorktreeManager.of({
                create: () => Effect.die(new Error("must not create worktree")),
                inspect: () => exactWorktree("/tmp/submitting-boundary-251"),
              }),
            });

          const first = yield* makeApplication(true);
          yield* first.recover?.(acceptedEvent) ?? Effect.void;
          const afterBoundary = (yield* repository.load).executions[0];
          assert.strictEqual(afterBoundary?.prompts[0]?.status, "submitting");
          assert.strictEqual(
            afterBoundary?.prompts[0]?.attempt?.certainty,
            "unknown"
          );
          assert.strictEqual(
            afterBoundary?.prompts[0]?.attempt?.state,
            "unresolved"
          );
          assert.strictEqual(yield* Ref.get(starts), 0);

          const restarted = yield* makeApplication(false);
          yield* restarted.recover?.(acceptedEvent) ?? Effect.void;
          assert.strictEqual(yield* Ref.get(starts), 0);
          assert.strictEqual(
            (yield* repository.load).executions[0]?.recoveryFailure,
            null
          );
        })
      )
  );

  it.effect(
    "terminalizes a definitively missing persisted worktree once without recreation",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* makeInMemoryApplicationRepository();
          const conversationId = ThreadId.make("workspace:T254:C254:1.0");
          const accepted = yield* Ref.make<readonly ExternalInputEvent[]>([]);
          const acpInputs = yield* Ref.make<readonly string[]>([]);
          const publicReplies = yield* Ref.make<readonly string[]>([]);
          const creates = yield* Ref.make(0);
          yield* startExecution(
            repository,
            conversationId,
            "/tmp/resource-254"
          );
          yield* repository.transact((state) => {
            const execution = state.executions[0];
            assert.ok(execution);
            return [
              undefined,
              {
                ...state,
                executions: [
                  {
                    ...execution,
                    events: Array.from({ length: 512 }, (_, index) => ({
                      eventId: `capacity:${index}`,
                      payload: {},
                      source: "capacity-fixture",
                      status: "accepted" as const,
                    })),
                  },
                ],
              },
            ];
          });
          const application = yield* makeReferenceCodingApplication({
            conversationAgent: {
              handle: (request) =>
                Ref.update(acpInputs, (inputs) => [
                  ...inputs,
                  request.input,
                ]).pipe(
                  Effect.as([
                    {
                      replyId: "sanitized-recovery-reply",
                      text: "The coding execution can no longer continue because a required resource is unavailable.",
                    },
                  ])
                ),
            },
            implementationAgent: ImplementationAgent.of({
              inspect: () =>
                Effect.die(new Error("session must not be inspected")),
              start: () => Effect.die(new Error("session must not be created")),
            }),
            repository,
            worktreeManager: WorktreeManager.of({
              create: () =>
                Ref.update(creates, (count) => count + 1).pipe(
                  Effect.andThen(Effect.die(new Error("must not recreate")))
                ),
              inspect: () =>
                Effect.succeed({
                  certainty: "definitive",
                  evidence: "definitively-absent",
                  status: "missing",
                }),
            }),
          });
          assert.ok(application.recover);
          const accept = (event: ExternalInputEvent) =>
            Ref.update(accepted, (events) => [...events, event]).pipe(
              Effect.andThen(acceptedEvent(event))
            );
          yield* application.recover(accept);
          yield* application.recover(accept);

          const execution = (yield* repository.load).executions[0];
          assert.ok(execution);
          assert.strictEqual(execution.status, "failed");
          assert.deepStrictEqual(
            execution.recoveryFailure === null
              ? null
              : { ...execution.recoveryFailure },
            {
              delivery: "accepted",
              eventId: `${execution.executionId}:recovery-failure`,
              reason: "missing",
              resource: "worktree",
            }
          );
          assert.strictEqual(execution.events.length, 512);
          assert.strictEqual(yield* Ref.get(creates), 0);
          assert.deepStrictEqual(
            (yield* Ref.get(accepted)).map((event) => event.payload),
            [
              {
                executionId: execution?.executionId,
                kind: "missing",
                resource: "worktree",
              },
            ]
          );
          const recoveryEvent = (yield* Ref.get(accepted))[0];
          assert.ok(recoveryEvent);
          yield* application.handle(
            recoveryEvent,
            (output) =>
              output._tag === "PublicReply"
                ? Ref.update(publicReplies, (replies) => [
                    ...replies,
                    output.text,
                  ])
                : Effect.void,
            acceptedEvent
          );
          assert.match(
            (yield* Ref.get(acpInputs))[0] ?? "",
            UNTRUSTED_REFERENCE_PATTERN
          );
          assert.strictEqual(
            PRIVATE_RECOVERY_DETAIL_PATTERN.test(
              (yield* Ref.get(acpInputs))[0] ?? ""
            ),
            false
          );
          assert.deepStrictEqual(yield* Ref.get(publicReplies), [
            "The coding execution can no longer continue because a required resource is unavailable.",
          ]);
          assert.strictEqual(
            (yield* repository.load).executions[0]?.recoveryFailure?.delivery,
            "settled"
          );
          const unknown = yield* Effect.result(
            application.handle(
              ExternalInputEvent.make({
                conversationId,
                eventId: "unknown-recovery-event",
                payload: {
                  executionId: "unknown-execution",
                  kind: "missing",
                  resource: "worktree",
                },
                source: "execution-recovery",
              }),
              publishNothing,
              acceptedEvent
            )
          );
          const foreign = yield* Effect.result(
            application.handle(
              ExternalInputEvent.make({
                conversationId: ThreadId.make("workspace:FOREIGN:C254:1.0"),
                eventId: recoveryEvent.eventId,
                payload: recoveryEvent.payload,
                source: "execution-recovery",
              }),
              publishNothing,
              acceptedEvent
            )
          );
          assert.strictEqual(unknown._tag, "Failure");
          assert.strictEqual(foreign._tag, "Failure");
          if (unknown._tag === "Failure" && foreign._tag === "Failure") {
            assert.strictEqual(unknown.failure._tag, "HandlerFailure");
            assert.strictEqual(foreign.failure._tag, "HandlerFailure");
            if (
              unknown.failure._tag === "HandlerFailure" &&
              foreign.failure._tag === "HandlerFailure"
            ) {
              assert.strictEqual(
                unknown.failure.safeDetail,
                foreign.failure.safeDetail
              );
            }
          }
        })
      )
  );

  it.effect(
    "never recreates a definitively missing confirmed implementation session",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* makeInMemoryApplicationRepository();
          const conversationId = ThreadId.make("workspace:T254:C254:2.0");
          yield* startExecution(repository, conversationId, "/tmp/session-254");
          const starts = yield* Ref.make(0);
          const recoveries = yield* Ref.make(0);
          const application = yield* makeReferenceCodingApplication({
            conversationAgent: { handle: () => Effect.succeed([]) },
            implementationAgent: ImplementationAgent.of({
              inspect: () =>
                Effect.succeed({
                  certainty: "definitive",
                  evidence: "definitively-absent",
                  status: "missing",
                }),
              recover: () =>
                Ref.update(recoveries, (count) => count + 1).pipe(
                  Effect.andThen(Effect.die(new Error("must not recover")))
                ),
              start: () =>
                Ref.update(starts, (count) => count + 1).pipe(
                  Effect.andThen(Effect.die(new Error("must not create")))
                ),
            }),
            repository,
            worktreeManager: WorktreeManager.of({
              create: () => Effect.die(new Error("must not create worktree")),
              inspect: () => exactWorktree("/tmp/session-254"),
            }),
          });
          assert.ok(application.recover);
          yield* application.recover(acceptedEvent);

          const execution = (yield* repository.load).executions[0];
          assert.strictEqual(execution?.status, "failed");
          assert.strictEqual(
            execution?.recoveryFailure?.resource,
            "implementation-session"
          );
          assert.strictEqual(yield* Ref.get(starts), 0);
          assert.strictEqual(yield* Ref.get(recoveries), 0);
        })
      )
  );

  it.effect(
    "defers ambiguous inspection without an event and later reattaches exact identities",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* makeInMemoryApplicationRepository();
          const conversationId = ThreadId.make("workspace:T254:C254:3.0");
          yield* startExecution(
            repository,
            conversationId,
            "/tmp/ambiguous-254"
          );
          const accepted = yield* Ref.make(0);
          const ambiguous = yield* makeReferenceCodingApplication({
            conversationAgent: { handle: () => Effect.succeed([]) },
            implementationAgent: ImplementationAgent.of({
              start: () => Effect.die(new Error("must not create session")),
            }),
            repository,
            worktreeManager: WorktreeManager.of({
              create: () => Effect.die(new Error("must not create worktree")),
              inspect: () =>
                Effect.succeed({
                  certainty: "unknown",
                  evidence: "git-inspection-failed",
                  status: "ambiguous",
                }),
            }),
          });
          assert.ok(ambiguous.recover);
          yield* ambiguous.recover((event) =>
            Ref.update(accepted, (count) => count + 1).pipe(
              Effect.andThen(acceptedEvent(event))
            )
          );
          assert.strictEqual(
            (yield* repository.load).executions[0]?.status,
            "running"
          );
          assert.strictEqual(yield* Ref.get(accepted), 0);

          const recovered = yield* Ref.make(0);
          const exact = yield* makeReferenceCodingApplication({
            conversationAgent: { handle: () => Effect.succeed([]) },
            implementationAgent: ImplementationAgent.of({
              inspect: (request) =>
                exactSession(request.implementationSessionId),
              recover: (request) =>
                Ref.update(recovered, (count) => count + 1).pipe(
                  Effect.as({
                    completion: Effect.never,
                    resume: () => Effect.void,
                    sessionId: request.implementationSessionId,
                  })
                ),
              start: () => Effect.die(new Error("must reuse the session")),
            }),
            repository,
            worktreeManager: WorktreeManager.of({
              create: () => Effect.die(new Error("must reuse the worktree")),
              inspect: () => exactWorktree("/tmp/ambiguous-254"),
            }),
          });
          assert.ok(exact.recover);
          yield* exact.recover(acceptedEvent);
          const execution = (yield* repository.load).executions[0];
          assert.strictEqual(execution?.status, "running");
          assert.strictEqual(execution?.attachment?.state, "attached");
          assert.strictEqual(yield* Ref.get(recovered), 1);
        })
      )
  );

  it.effect("terminalizes definitive resource loss before a follow-up", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repository = yield* makeInMemoryApplicationRepository();
        const conversationId = ThreadId.make("workspace:T254:C254:4.0");
        const accepted = yield* Ref.make<readonly ExternalInputEvent[]>([]);
        let turn = 0;
        const application = yield* makeReferenceCodingApplication({
          conversationAgent: {
            handle: (request) => {
              turn += 1;
              if (turn === 1) {
                const action = request.actions.find(
                  (candidate) => candidate.name === "create-feature"
                );
                assert.ok(action);
                return action
                  .invoke({
                    prompt: "Create a follow-up target.",
                    worktreeName: "follow-up-loss",
                  })
                  .pipe(Effect.as([] as const));
              }
              const prompt = request.executionControls.find(
                (candidate) => candidate.name === "prompt-execution"
              );
              assert.ok(prompt);
              return Effect.result(
                prompt.invoke({
                  executionId: request.executions[0]?.executionId,
                  prompt: "Continue after loss.",
                })
              ).pipe(Effect.as([] as const));
            },
          },
          implementationAgent: ImplementationAgent.of({
            inspect: (request) => exactSession(request.implementationSessionId),
            start: (request) =>
              Effect.succeed({
                completion: Effect.never,
                resume: () => Effect.die(new Error("must not resume")),
                sessionId: request.implementationSessionId,
              }),
          }),
          repository,
          worktreeManager: WorktreeManager.of({
            create: () =>
              Effect.succeed({ workingDirectory: "/tmp/follow-up-loss" }),
            inspect: () =>
              Effect.succeed({
                certainty: "definitive",
                evidence: "definitively-absent",
                status: "missing",
              }),
          }),
        });
        const accept = (event: ExternalInputEvent) =>
          Ref.update(accepted, (events) => [...events, event]).pipe(
            Effect.andThen(acceptedEvent(event))
          );
        yield* application.handle(
          ExternalInputEvent.make({
            conversationId,
            eventId: "event:start-follow-up-loss",
            payload: {},
            source: "test",
          }),
          publishNothing,
          accept
        );
        yield* application.handle(
          ExternalInputEvent.make({
            conversationId,
            eventId: "event:request-follow-up-after-loss",
            payload: {},
            source: "test",
          }),
          publishNothing,
          accept
        );

        const execution = (yield* repository.load).executions[0];
        assert.strictEqual(execution?.status, "failed");
        assert.strictEqual(execution?.recoveryFailure?.reason, "missing");
        assert.strictEqual((yield* Ref.get(accepted)).length, 1);
      })
    )
  );
});
