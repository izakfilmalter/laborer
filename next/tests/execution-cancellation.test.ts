import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Ref, Schema } from "effect";
import { ExternalInputEvent } from "../src/application.ts";
import { ThreadId } from "../src/core/domain.ts";
import { HandlerFailure } from "../src/core/errors.ts";
import {
  CancelExecutionResult,
  executionCancelOperationId,
  InspectExecutionsResult,
} from "../src/execution-control-catalog.ts";
import {
  type ConversationExecutionControl,
  ImplementationAgent,
  makeFileApplicationRepository,
  makeInMemoryApplicationRepository,
  makeReferenceCodingApplication,
  WorktreeManager,
} from "../src/reference-coding-application.ts";
import { makeTempDirectoryScoped } from "./support/temp-directory.ts";

const publishNothing = () => Effect.void;

describe("issue #249 durable Execution cancellation", () => {
  it.effect(
    "inspects and concurrently cancels once while fencing late completion",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped("execution-cancel-");
          const worktree = join(root, "preserved-worktree");
          const marker = join(worktree, ".laborer-marker");
          const uncommitted = join(worktree, "uncommitted.txt");
          yield* Effect.promise(() => mkdir(worktree));
          yield* Effect.promise(() => writeFile(marker, "marker", "utf8"));
          yield* Effect.promise(() =>
            writeFile(uncommitted, "preserve me", "utf8")
          );
          const repository = yield* makeFileApplicationRepository(
            join(root, "application.json"),
            root
          );
          const conversationId = ThreadId.make("workspace:T249:C249:249.1");
          const implementationCompletion = yield* Deferred.make<void>();
          const interruptStarted = yield* Deferred.make<void>();
          const releaseInterrupt = yield* Deferred.make<void>();
          const lateClaimantPaused = yield* Deferred.make<void>();
          const releaseLateClaimant = yield* Deferred.make<void>();
          const runPromise = Effect.runPromiseWith(
            yield* Effect.context<never>()
          );
          const interruptCount = yield* Ref.make(0);
          const inspectResult = yield* Ref.make<
            typeof InspectExecutionsResult.Type | null
          >(null);
          const cancelResults = yield* Ref.make<
            readonly (typeof CancelExecutionResult.Type)[]
          >([]);
          const promptControl =
            yield* Ref.make<ConversationExecutionControl | null>(null);
          const executionId = yield* Ref.make<string | null>(null);
          const acceptedEvents = yield* Ref.make<readonly ExternalInputEvent[]>(
            []
          );
          const application = yield* makeReferenceCodingApplication({
            conversationAgent: {
              handle: (request) => {
                if (request.source !== "start") {
                  return Effect.succeed([]);
                }
                return Effect.gen(function* () {
                  const action = request.actions.find(
                    ({ name }) => name === "create-feature"
                  );
                  const inspect = request.executionControls.find(
                    ({ name }) => name === "inspect-executions"
                  );
                  const cancel = request.executionControls.find(
                    ({ name }) => name === "cancel-execution"
                  );
                  const prompt = request.executionControls.find(
                    ({ name }) => name === "prompt-execution"
                  );
                  assert.ok(action);
                  assert.ok(inspect);
                  assert.ok(cancel);
                  assert.ok(prompt);
                  const started = yield* action.invoke({
                    prompt: "Implement cancellation fencing.",
                    worktreeName: "preserved-worktree",
                  });
                  yield* Ref.set(executionId, started.executionId);
                  yield* Ref.set(promptControl, prompt);
                  const inspected = yield* inspect.invoke({ limit: 20 });
                  yield* Ref.set(
                    inspectResult,
                    yield* Schema.decodeUnknownEffect(InspectExecutionsResult)(
                      inspected
                    ).pipe(Effect.orDie)
                  );
                  const results = yield* Effect.all(
                    [
                      cancel.invoke({ executionId: started.executionId }),
                      cancel.invoke({ executionId: started.executionId }),
                    ],
                    { concurrency: "unbounded" }
                  );
                  const terminalDuplicate = yield* cancel.invoke({
                    executionId: started.executionId,
                  });
                  yield* Ref.set(
                    cancelResults,
                    yield* Effect.forEach(
                      [...results, terminalDuplicate],
                      (result) =>
                        Schema.decodeUnknownEffect(CancelExecutionResult)(
                          result
                        ).pipe(Effect.orDie)
                    )
                  );
                  return [];
                });
              },
            },
            implementationAgent: ImplementationAgent.of({
              start: (request) =>
                Effect.succeed({
                  completion: Deferred.await(implementationCompletion),
                  control: () =>
                    Ref.update(interruptCount, (count) => count + 1).pipe(
                      Effect.andThen(
                        Deferred.succeed(interruptStarted, undefined)
                      ),
                      Effect.andThen(Deferred.await(releaseInterrupt))
                    ),
                  resume: () => Effect.void,
                  sessionId: request.implementationSessionId,
                }),
            }),
            repository,
            testHooks: {
              afterCancellationFlightStarted: async ({ owner }) => {
                if (!owner) {
                  await runPromise(
                    Deferred.succeed(lateClaimantPaused, undefined)
                  );
                  await runPromise(Deferred.await(releaseLateClaimant));
                }
              },
            },
            worktreeManager: WorktreeManager.of({
              create: () => Effect.succeed({ workingDirectory: worktree }),
              validate: () => Effect.void,
            }),
          });
          const acceptEvent = (event: ExternalInputEvent) =>
            Ref.update(acceptedEvents, (events) => [...events, event]).pipe(
              Effect.as({
                decision: {
                  _tag: "Accepted" as const,
                  eventId: event.eventId,
                },
                scheduling: "Scheduled" as const,
              })
            );
          const handling = yield* application
            .handle(
              ExternalInputEvent.make({
                conversationId,
                eventId: "event:start",
                payload: {},
                source: "start",
              }),
              publishNothing,
              acceptEvent
            )
            .pipe(Effect.forkChild);
          yield* Deferred.await(interruptStarted);
          yield* Deferred.await(lateClaimantPaused);
          const pendingPrompt = yield* Ref.get(promptControl);
          const pendingExecutionId = yield* Ref.get(executionId);
          assert.ok(pendingPrompt);
          assert.ok(pendingExecutionId);
          assert.ok(
            Exit.isFailure(
              yield* Effect.exit(
                pendingPrompt.invoke({
                  executionId: pendingExecutionId,
                  prompt: "must reject while cancelling",
                })
              )
            )
          );
          yield* Deferred.succeed(releaseInterrupt, undefined);
          for (let attempt = 0; attempt < 100; attempt += 1) {
            if (
              (yield* repository.load).executions[0]?.status === "cancelled"
            ) {
              break;
            }
            yield* Effect.promise(
              () => new Promise<void>((resolve) => setTimeout(resolve, 2))
            );
          }
          yield* Deferred.succeed(releaseLateClaimant, undefined);
          yield* Fiber.join(handling);
          assert.ok(
            Exit.isFailure(
              yield* Effect.exit(
                pendingPrompt.invoke({
                  executionId: pendingExecutionId,
                  prompt: "must reject after cancellation",
                })
              )
            )
          );

          assert.deepStrictEqual(yield* Ref.get(inspectResult), {
            executions: [
              {
                actionName: "create-feature",
                canCancel: true,
                canPrompt: true,
                executionId: "workspace:T249:C249:249.1:execution:1",
                status: "running",
                worktreeName: "preserved-worktree",
              },
            ],
            schemaVersion: 1,
            truncated: false,
          });
          assert.strictEqual(yield* Ref.get(interruptCount), 1);
          assert.deepStrictEqual(
            (yield* Ref.get(cancelResults))
              .map(({ deduplicated }) => deduplicated)
              .sort(),
            [false, true, true]
          );
          const cancelled = (yield* repository.load).executions[0];
          assert.strictEqual(cancelled?.status, "cancelled");
          assert.strictEqual(cancelled?.cancellation?.attemptCount, 1);
          assert.strictEqual(
            cancelled?.cancellation?.terminalEventId,
            "workspace:T249:C249:249.1:execution:1:control:cancel"
          );
          assert.strictEqual(
            cancelled?.events.filter(
              ({ eventId }) =>
                eventId ===
                "workspace:T249:C249:249.1:execution:1:control:cancel"
            ).length,
            1
          );
          assert.strictEqual(
            (yield* repository.load).actionOperations[0]?.terminalEventId,
            cancelled?.cancellation?.terminalEventId
          );
          assert.deepStrictEqual(
            (yield* Ref.get(acceptedEvents)).map(({ eventId, source }) => ({
              eventId,
              source,
            })),
            [
              {
                eventId: "workspace:T249:C249:249.1:execution:1:control:cancel",
                source: "execution-control",
              },
            ]
          );

          yield* Deferred.succeed(implementationCompletion, undefined);
          yield* Effect.yieldNow;
          assert.strictEqual(
            (yield* repository.load).executions[0]?.status,
            "cancelled"
          );
          assert.strictEqual(
            (yield* repository.load).executions[0]?.events.some(
              ({ source }) => source === "action-terminal"
            ),
            false
          );
          assert.strictEqual(
            yield* Effect.promise(() => readFile(marker, "utf8")),
            "marker"
          );
          assert.strictEqual(
            yield* Effect.promise(() => readFile(uncommitted, "utf8")),
            "preserve me"
          );
        })
      ),
    10_000
  );

  it.effect(
    "coalesces terminal event redrive after acceptance fails",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* makeInMemoryApplicationRepository();
          const conversationId = ThreadId.make("workspace:T249:C249:redrive");
          const cancelControl =
            yield* Ref.make<ConversationExecutionControl | null>(null);
          const executionId = yield* Ref.make<string | null>(null);
          const interruptCount = yield* Ref.make(0);
          const acceptanceAttempts = yield* Ref.make(0);
          const application = yield* makeReferenceCodingApplication({
            conversationAgent: {
              handle: (request) =>
                Effect.gen(function* () {
                  const action = request.actions.find(
                    ({ name }) => name === "create-feature"
                  );
                  const cancel = request.executionControls.find(
                    ({ name }) => name === "cancel-execution"
                  );
                  assert.ok(action);
                  assert.ok(cancel);
                  const started = yield* action.invoke({
                    prompt: "Exercise terminal event redrive.",
                    worktreeName: "redrive-worktree",
                  });
                  yield* Ref.set(cancelControl, cancel);
                  yield* Ref.set(executionId, started.executionId);
                  return [];
                }),
            },
            implementationAgent: ImplementationAgent.of({
              start: (request) =>
                Effect.succeed({
                  completion: Effect.never,
                  control: () =>
                    Ref.update(interruptCount, (count) => count + 1),
                  resume: () => Effect.void,
                  sessionId: request.implementationSessionId,
                }),
            }),
            repository,
            worktreeManager: WorktreeManager.of({
              create: () =>
                Effect.succeed({ workingDirectory: "/tmp/redrive-worktree" }),
            }),
          });
          const acceptEvent = (event: ExternalInputEvent) =>
            Ref.getAndUpdate(acceptanceAttempts, (count) => count + 1).pipe(
              Effect.flatMap((attempt) =>
                attempt === 0
                  ? HandlerFailure.make({
                      category: "protocol",
                      safeDetail: "injected acceptance failure",
                    })
                  : Effect.succeed({
                      decision: {
                        _tag: "Accepted" as const,
                        eventId: event.eventId,
                      },
                      scheduling: "Scheduled" as const,
                    })
              )
            );
          yield* application.handle(
            ExternalInputEvent.make({
              conversationId,
              eventId: "event:redrive:start",
              payload: {},
              source: "start",
            }),
            publishNothing,
            acceptEvent
          );
          const cancel = yield* Ref.get(cancelControl);
          const id = yield* Ref.get(executionId);
          assert.ok(cancel);
          assert.ok(id);

          assert.ok(
            Exit.isFailure(
              yield* Effect.exit(cancel.invoke({ executionId: id }))
            )
          );
          const staged = (yield* repository.load).executions[0];
          assert.strictEqual(staged?.status, "cancelled");
          assert.strictEqual(staged?.events[0]?.status, "staged");
          assert.strictEqual(yield* Ref.get(interruptCount), 1);
          assert.strictEqual(yield* Ref.get(acceptanceAttempts), 1);

          const retries = yield* Effect.all(
            Array.from({ length: 300 }, () =>
              cancel.invoke({ executionId: id })
            ),
            { concurrency: "unbounded" }
          );
          assert.strictEqual(retries.length, 300);
          assert.ok(retries.every((result) => result.deduplicated === true));
          const accepted = (yield* repository.load).executions[0];
          assert.strictEqual(accepted?.events[0]?.status, "accepted");
          assert.strictEqual(accepted?.events.length, 1);
          assert.strictEqual(yield* Ref.get(interruptCount), 1);
          assert.strictEqual(yield* Ref.get(acceptanceAttempts), 2);

          yield* cancel.invoke({ executionId: id });
          assert.strictEqual(yield* Ref.get(acceptanceAttempts), 2);
        })
      ),
    10_000
  );

  it.effect("lets completion win before the durable cancellation claim", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repository = yield* makeInMemoryApplicationRepository();
        const conversationId = ThreadId.make(
          "workspace:T249:C249:completion-first"
        );
        const completion = yield* Deferred.make<void>();
        const beforeClaim = yield* Deferred.make<void>();
        const releaseClaim = yield* Deferred.make<void>();
        const runPromise = Effect.runPromiseWith(
          yield* Effect.context<never>()
        );
        const cancelControl =
          yield* Ref.make<ConversationExecutionControl | null>(null);
        const executionId = yield* Ref.make<string | null>(null);
        const interruptCount = yield* Ref.make(0);
        const application = yield* makeReferenceCodingApplication({
          conversationAgent: {
            handle: (request) =>
              Effect.gen(function* () {
                const action = request.actions.find(
                  ({ name }) => name === "create-feature"
                );
                const cancel = request.executionControls.find(
                  ({ name }) => name === "cancel-execution"
                );
                assert.ok(action);
                assert.ok(cancel);
                const started = yield* action.invoke({
                  prompt: "Complete at the cancellation boundary.",
                  worktreeName: "completion-first",
                });
                yield* Ref.set(cancelControl, cancel);
                yield* Ref.set(executionId, started.executionId);
                return [];
              }),
          },
          implementationAgent: ImplementationAgent.of({
            start: (request) =>
              Effect.succeed({
                completion: Deferred.await(completion),
                control: () => Ref.update(interruptCount, (count) => count + 1),
                resume: () => Effect.void,
                sessionId: request.implementationSessionId,
              }),
          }),
          repository,
          testHooks: {
            beforeCancellationClaim: async () => {
              await runPromise(Deferred.succeed(beforeClaim, undefined));
              await runPromise(Deferred.await(releaseClaim));
            },
          },
          worktreeManager: WorktreeManager.of({
            create: () =>
              Effect.succeed({ workingDirectory: "/tmp/completion-first" }),
          }),
        });
        const acceptEvent = (event: ExternalInputEvent) =>
          Effect.succeed({
            decision: { _tag: "Accepted" as const, eventId: event.eventId },
            scheduling: "Scheduled" as const,
          });
        yield* application.handle(
          ExternalInputEvent.make({
            conversationId,
            eventId: "event:completion-first:start",
            payload: {},
            source: "start",
          }),
          publishNothing,
          acceptEvent
        );
        const cancel = yield* Ref.get(cancelControl);
        const id = yield* Ref.get(executionId);
        assert.ok(cancel);
        assert.ok(id);
        const cancellation = yield* cancel
          .invoke({ executionId: id })
          .pipe(Effect.forkChild);
        yield* Deferred.await(beforeClaim);
        yield* Deferred.succeed(completion, undefined);
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if ((yield* repository.load).executions[0]?.status === "completed") {
            break;
          }
          yield* Effect.promise(
            () => new Promise<void>((resolve) => setTimeout(resolve, 2))
          );
        }
        yield* Deferred.succeed(releaseClaim, undefined);
        assert.ok(Exit.isFailure(yield* Fiber.await(cancellation)));
        const completed = (yield* repository.load).executions[0];
        assert.strictEqual(completed?.status, "completed");
        assert.strictEqual(
          completed?.events.filter(({ source }) => source === "action-terminal")
            .length,
          1
        );
        assert.strictEqual(
          completed?.events.some(
            ({ source }) => source === "execution-control"
          ),
          false
        );
        assert.strictEqual(yield* Ref.get(interruptCount), 0);
      })
    )
  );

  it.effect(
    "keeps parent reconciliation after the cancel caller is interrupted",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* makeInMemoryApplicationRepository();
          const conversationId = ThreadId.make(
            "workspace:T249:C249:caller-cancel"
          );
          const flightStarted = yield* Deferred.make<void>();
          const holdCaller = yield* Deferred.make<void>();
          const interruptStarted = yield* Deferred.make<void>();
          const releaseInterrupt = yield* Deferred.make<void>();
          const runPromise = Effect.runPromiseWith(
            yield* Effect.context<never>()
          );
          const cancelControl =
            yield* Ref.make<ConversationExecutionControl | null>(null);
          const executionId = yield* Ref.make<string | null>(null);
          const interruptCount = yield* Ref.make(0);
          const accepted = yield* Ref.make<readonly string[]>([]);
          const application = yield* makeReferenceCodingApplication({
            conversationAgent: {
              handle: (request) =>
                Effect.gen(function* () {
                  const action = request.actions.find(
                    ({ name }) => name === "create-feature"
                  );
                  const cancel = request.executionControls.find(
                    ({ name }) => name === "cancel-execution"
                  );
                  assert.ok(action);
                  assert.ok(cancel);
                  const started = yield* action.invoke({
                    prompt: "Outlive the cancelled caller.",
                    worktreeName: "caller-cancel",
                  });
                  yield* Ref.set(cancelControl, cancel);
                  yield* Ref.set(executionId, started.executionId);
                  return [];
                }),
            },
            implementationAgent: ImplementationAgent.of({
              start: (request) =>
                Effect.succeed({
                  completion: Effect.never,
                  control: () =>
                    Ref.update(interruptCount, (count) => count + 1).pipe(
                      Effect.andThen(
                        Deferred.succeed(interruptStarted, undefined)
                      ),
                      Effect.andThen(Deferred.await(releaseInterrupt))
                    ),
                  resume: () => Effect.void,
                  sessionId: request.implementationSessionId,
                }),
            }),
            repository,
            testHooks: {
              afterCancellationFlightStarted: async ({ owner }) => {
                if (owner) {
                  await runPromise(Deferred.succeed(flightStarted, undefined));
                  await runPromise(Deferred.await(holdCaller));
                }
              },
            },
            worktreeManager: WorktreeManager.of({
              create: () =>
                Effect.succeed({ workingDirectory: "/tmp/caller-cancel" }),
            }),
          });
          const acceptEvent = (event: ExternalInputEvent) =>
            Ref.update(accepted, (events) => [...events, event.eventId]).pipe(
              Effect.as({
                decision: { _tag: "Accepted" as const, eventId: event.eventId },
                scheduling: "Scheduled" as const,
              })
            );
          yield* application.handle(
            ExternalInputEvent.make({
              conversationId,
              eventId: "event:caller-cancel:start",
              payload: {},
              source: "start",
            }),
            publishNothing,
            acceptEvent
          );
          const cancel = yield* Ref.get(cancelControl);
          const id = yield* Ref.get(executionId);
          assert.ok(cancel);
          assert.ok(id);
          const caller = yield* cancel
            .invoke({ executionId: id })
            .pipe(Effect.forkChild);
          yield* Deferred.await(flightStarted);
          yield* Deferred.await(interruptStarted);
          yield* Fiber.interrupt(caller);
          yield* Deferred.succeed(releaseInterrupt, undefined);
          for (let attempt = 0; attempt < 100; attempt += 1) {
            if (
              (yield* repository.load).executions[0]?.status === "cancelled"
            ) {
              break;
            }
            yield* Effect.promise(
              () => new Promise<void>((resolve) => setTimeout(resolve, 2))
            );
          }
          assert.strictEqual(
            (yield* repository.load).executions[0]?.status,
            "cancelled"
          );
          assert.strictEqual(yield* Ref.get(interruptCount), 1);
          assert.deepStrictEqual(yield* Ref.get(accepted), [
            "workspace:T249:C249:caller-cancel:execution:1:control:cancel",
          ]);
        })
      )
  );

  it.effect(
    "rejects unknown, foreign, terminal, and cancelled follow-ups",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const controls = yield* Ref.make<
            readonly ConversationExecutionControl[]
          >([]);
          const application = yield* makeReferenceCodingApplication({
            conversationAgent: {
              handle: (request) =>
                Ref.set(controls, request.executionControls).pipe(
                  Effect.as([] as const)
                ),
            },
            implementationAgent: ImplementationAgent.of({
              start: (request) =>
                Effect.succeed({
                  completion: Effect.void,
                  control: () => Effect.void,
                  resume: () => Effect.void,
                  sessionId: request.implementationSessionId,
                }),
            }),
            worktreeManager: WorktreeManager.of({
              create: () => Effect.succeed({ workingDirectory: "/tmp/unused" }),
            }),
          });
          yield* application.handle(
            ExternalInputEvent.make({
              conversationId: ThreadId.make("workspace:T249:C249:foreign"),
              eventId: "event:foreign",
              payload: {},
              source: "test",
            }),
            publishNothing,
            (event) =>
              Effect.succeed({
                decision: { _tag: "Accepted" as const, eventId: event.eventId },
                scheduling: "Scheduled" as const,
              })
          );
          const inspect = (yield* Ref.get(controls)).find(
            ({ name }) => name === "inspect-executions"
          );
          const cancel = (yield* Ref.get(controls)).find(
            ({ name }) => name === "cancel-execution"
          );
          const prompt = (yield* Ref.get(controls)).find(
            ({ name }) => name === "prompt-execution"
          );
          assert.ok(inspect);
          assert.ok(cancel);
          assert.ok(prompt);
          const unknownInspect = yield* Effect.exit(
            inspect.invoke({ executionId: "unknown" })
          );
          const unknownCancel = yield* Effect.exit(
            cancel.invoke({ executionId: "unknown" })
          );
          assert.ok(Exit.isFailure(unknownInspect));
          assert.ok(Exit.isFailure(unknownCancel));
          if (Exit.isFailure(unknownInspect) && Exit.isFailure(unknownCancel)) {
            assert.strictEqual(
              String(unknownInspect.cause),
              String(unknownCancel.cause)
            );
          }
          assert.ok(
            Exit.isFailure(
              yield* Effect.exit(
                prompt.invoke({ executionId: "unknown", prompt: "resume" })
              )
            )
          );
        })
      )
  );

  it.effect(
    "fails closed across the persisted ownership and terminal matrix",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped("execution-misuse-");
          const statePath = join(root, "application.json");
          const conversationId = ThreadId.make("workspace:T249:C249:owner");
          const persistedExecution = (options: {
            readonly conversationId: string;
            readonly executionId: string;
            readonly ownerWorkspaceId: string;
            readonly status: "cancelled" | "completed" | "failed" | "running";
          }) => ({
            actionInvocationId: `action-${options.executionId}`,
            actionName: "create-feature",
            cancellation: null,
            conversationId: options.conversationId,
            events: [],
            executionId: options.executionId,
            implementationSessionId: `session-${options.executionId}`,
            ownerWorkspaceId: options.ownerWorkspaceId,
            prompts: [],
            responses: [],
            status: options.status,
            workingDirectory: null,
            worktreeName: "safe-worktree",
          });
          yield* Effect.promise(() =>
            writeFile(
              statePath,
              JSON.stringify({
                actionOperationTombstones: [],
                actionOperations: [],
                conversations: [],
                executionPromptOperations: [],
                executions: [
                  persistedExecution({
                    conversationId,
                    executionId: "owned-completed",
                    ownerWorkspaceId: "T249",
                    status: "completed",
                  }),
                  persistedExecution({
                    conversationId,
                    executionId: "owned-failed",
                    ownerWorkspaceId: "T249",
                    status: "failed",
                  }),
                  persistedExecution({
                    conversationId,
                    executionId: "owned-legacy-cancelled",
                    ownerWorkspaceId: "T249",
                    status: "cancelled",
                  }),
                  persistedExecution({
                    conversationId: "workspace:T249:C249:foreign-conversation",
                    executionId: "foreign-conversation",
                    ownerWorkspaceId: "T249",
                    status: "running",
                  }),
                  persistedExecution({
                    conversationId: "workspace:T250:C249:owner",
                    executionId: "foreign-workspace",
                    ownerWorkspaceId: "T250",
                    status: "running",
                  }),
                ],
                schemaVersion: 11,
              }),
              { mode: 0o600 }
            )
          );
          const repository = yield* makeFileApplicationRepository(
            statePath,
            root
          );
          const controls = yield* Ref.make<
            readonly ConversationExecutionControl[]
          >([]);
          const application = yield* makeReferenceCodingApplication({
            conversationAgent: {
              handle: (request) =>
                Ref.set(controls, request.executionControls).pipe(
                  Effect.as([] as const)
                ),
            },
            implementationAgent: ImplementationAgent.of({
              start: () => Effect.die("implementation must not start"),
            }),
            repository,
            worktreeManager: WorktreeManager.of({
              create: () => Effect.die("worktree must not be created"),
            }),
          });
          yield* application.handle(
            ExternalInputEvent.make({
              conversationId,
              eventId: "event:misuse",
              payload: {},
              source: "test",
            }),
            publishNothing,
            (event) =>
              Effect.succeed({
                decision: { _tag: "Accepted" as const, eventId: event.eventId },
                scheduling: "Scheduled" as const,
              })
          );
          const inspect = (yield* Ref.get(controls)).find(
            ({ name }) => name === "inspect-executions"
          );
          const cancel = (yield* Ref.get(controls)).find(
            ({ name }) => name === "cancel-execution"
          );
          assert.ok(inspect);
          assert.ok(cancel);
          const list = yield* Schema.decodeUnknownEffect(
            InspectExecutionsResult
          )(yield* inspect.invoke({})).pipe(Effect.orDie);
          assert.deepStrictEqual(
            list.executions.map(({ executionId, status }) => ({
              executionId,
              status,
            })),
            [
              { executionId: "owned-completed", status: "completed" },
              { executionId: "owned-failed", status: "failed" },
              {
                executionId: "owned-legacy-cancelled",
                status: "cancelled",
              },
            ]
          );
          const beforeMisuse = JSON.stringify(yield* repository.load);
          const inspectFailures = yield* Effect.forEach(
            ["unknown", "foreign-conversation", "foreign-workspace"],
            (executionId) => inspect.invoke({ executionId }).pipe(Effect.flip)
          );
          const cancelFailures = yield* Effect.forEach(
            [
              "unknown",
              "foreign-conversation",
              "foreign-workspace",
              "owned-completed",
              "owned-failed",
              "owned-legacy-cancelled",
            ],
            (executionId) => cancel.invoke({ executionId }).pipe(Effect.flip)
          );
          const failureShapes = [...inspectFailures, ...cancelFailures].map(
            ({ category, safeDetail }) => ({ category, safeDetail })
          );
          assert.ok(
            failureShapes.every(
              (failure) =>
                JSON.stringify(failure) === JSON.stringify(failureShapes[0])
            )
          );
          assert.strictEqual(
            JSON.stringify(yield* repository.load),
            beforeMisuse
          );
        })
      )
  );

  it.effect(
    "restarts from cancelling to retry interruption without a prompt",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "execution-cancel-restart-"
          );
          const worktree = join(root, "restart-worktree");
          yield* Effect.promise(() => mkdir(worktree));
          const repository = yield* makeFileApplicationRepository(
            join(root, "application.json"),
            root
          );
          const conversationId = ThreadId.make("workspace:T249:C249:restart");
          const executionId = "workspace:T249:C249:restart:execution:1";
          const operationId = executionCancelOperationId({
            conversationId,
            executionId,
            workspaceId: "T249",
          });
          yield* Effect.promise(() =>
            writeFile(
              join(root, "application.json"),
              JSON.stringify({
                actionOperationTombstones: [],
                actionOperations: [],
                conversations: [],
                executionPromptOperations: [],
                executions: [
                  {
                    actionInvocationId: "action-restart",
                    actionName: "create-feature",
                    cancellation: {
                      attemptCount: 1,
                      failureCategory: "exit",
                      operationId,
                      requestedAt: 1,
                      resultEvidence: null,
                      terminalEventId: null,
                    },
                    conversationId,
                    events: [],
                    executionId,
                    implementationSessionId: "session-restart",
                    ownerWorkspaceId: "T249",
                    prompts: [
                      {
                        kind: "initial",
                        promptId: "prompt-restart",
                        status: "running",
                        text: "Never resume this prompt after restart.",
                      },
                    ],
                    responses: [],
                    status: "cancelling",
                    workingDirectory: worktree,
                    worktreeName: "restart-worktree",
                  },
                ],
                schemaVersion: 11,
              }),
              { mode: 0o600 }
            )
          );

          const recoverCount = yield* Ref.make(0);
          const retryInterrupts = yield* Ref.make(0);
          const completionEvaluations = yield* Ref.make(0);
          const accepted = yield* Ref.make<readonly string[]>([]);
          const recoveredApplication = yield* makeReferenceCodingApplication({
            conversationAgent: { handle: () => Effect.succeed([]) },
            implementationAgent: ImplementationAgent.of({
              recover: (request) =>
                Ref.update(recoverCount, (count) => count + 1).pipe(
                  Effect.as({
                    completion: Ref.update(
                      completionEvaluations,
                      (count) => count + 1
                    ),
                    control: () =>
                      Ref.update(retryInterrupts, (count) => count + 1),
                    resume: () => Effect.die("prompt resumed"),
                    sessionId: request.implementationSessionId,
                  })
                ),
              start: () => Effect.die("implementation restarted"),
            }),
            repository,
            worktreeManager: WorktreeManager.of({
              create: () => Effect.die("worktree recreated"),
              validate: () => Effect.void,
            }),
          });
          const recover = recoveredApplication.recover;
          assert.ok(recover);
          yield* recover((event) =>
            Ref.update(accepted, (events) => [...events, event.eventId]).pipe(
              Effect.as({
                decision: {
                  _tag: "Accepted" as const,
                  eventId: event.eventId,
                },
                scheduling: "Scheduled" as const,
              })
            )
          );
          for (let attempt = 0; attempt < 100; attempt += 1) {
            if (
              (yield* repository.load).executions[0]?.status === "cancelled" &&
              (yield* Ref.get(accepted)).length === 1
            ) {
              break;
            }
            yield* Effect.promise(
              () => new Promise<void>((resolve) => setTimeout(resolve, 5))
            );
          }
          assert.strictEqual(yield* Ref.get(recoverCount), 1);
          assert.strictEqual(yield* Ref.get(retryInterrupts), 1);
          assert.strictEqual(yield* Ref.get(completionEvaluations), 0);
          assert.strictEqual(
            (yield* repository.load).executions[0]?.status,
            "cancelled"
          );
          assert.deepStrictEqual(yield* Ref.get(accepted), [
            "workspace:T249:C249:restart:execution:1:control:cancel",
          ]);
        })
      ),
    15_000
  );

  it.effect("redacts every unsafe migrated worktree name in snapshots", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped("execution-snapshot-path-");
        const statePath = join(root, "application.json");
        const conversationId = ThreadId.make("workspace:T249:C249:paths");
        const unsafeNames = [
          "/Users/private/project",
          "../private-project",
          "..\\private-project",
          "C:\\private\\project",
          "~/private-project",
          ".hidden-project",
          "nested/private-project",
          "\\\\server\\private-project",
        ];
        yield* Effect.promise(() =>
          writeFile(
            statePath,
            JSON.stringify({
              actionOperationTombstones: [],
              actionOperations: [],
              conversations: [],
              executionPromptOperations: [],
              executions: unsafeNames.map((worktreeName, index) => ({
                actionInvocationId: `legacy-action-${index}`,
                actionName: "create-feature",
                cancellation: null,
                conversationId,
                events: [],
                executionId: `legacy-execution-${index}`,
                implementationSessionId: `legacy-session-${index}`,
                ownerWorkspaceId: "T249",
                prompts: [],
                responses: [],
                status: "failed",
                workingDirectory: null,
                worktreeName,
              })),
              schemaVersion: 11,
            }),
            { mode: 0o600 }
          )
        );
        const repository = yield* makeFileApplicationRepository(
          statePath,
          root
        );
        const inspected = yield* Ref.make<
          typeof InspectExecutionsResult.Type | null
        >(null);
        const application = yield* makeReferenceCodingApplication({
          conversationAgent: {
            handle: (request) =>
              Effect.gen(function* () {
                const inspect = request.executionControls.find(
                  ({ name }) => name === "inspect-executions"
                );
                assert.ok(inspect);
                yield* Ref.set(
                  inspected,
                  yield* Schema.decodeUnknownEffect(InspectExecutionsResult)(
                    yield* inspect.invoke({ limit: 20 })
                  ).pipe(Effect.orDie)
                );
                return [];
              }),
          },
          implementationAgent: ImplementationAgent.of({
            start: () => Effect.die("implementation must not start"),
          }),
          repository,
          worktreeManager: WorktreeManager.of({
            create: () => Effect.die("worktree must not be created"),
          }),
        });
        yield* application.handle(
          ExternalInputEvent.make({
            conversationId,
            eventId: "event:paths:inspect",
            payload: {},
            source: "inspect",
          }),
          publishNothing,
          (event) =>
            Effect.succeed({
              decision: { _tag: "Accepted" as const, eventId: event.eventId },
              scheduling: "Scheduled" as const,
            })
        );
        const result = yield* Ref.get(inspected);
        assert.ok(result);
        assert.strictEqual(result.executions.length, unsafeNames.length);
        assert.ok(
          result.executions.every(
            ({ worktreeName }) => worktreeName === "redacted-worktree"
          )
        );
        const encoded = JSON.stringify(result);
        assert.ok(Buffer.byteLength(encoded, "utf8") <= 64 * 1024);
        for (const unsafeName of unsafeNames) {
          assert.ok(!encoded.includes(unsafeName));
        }
        assert.ok(!encoded.includes("/"));
        assert.ok(!encoded.includes("\\"));
        assert.ok(!encoded.includes("~"));
        assert.ok(!encoded.includes(".hidden"));
      })
    )
  );
});
