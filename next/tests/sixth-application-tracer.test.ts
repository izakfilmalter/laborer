import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Array as EffectArray, Ref } from "effect";
import { ThreadId } from "../src/prototype/domain.ts";
import { HandlerFailure } from "../src/prototype/errors.ts";
import { makePrototypeHarness } from "../src/prototype/runtime.ts";
import {
  LABORER_SLACK_ID,
  normalizedEvent,
} from "../src/prototype/scenario.ts";
import { makeFileStoreLayer } from "../src/prototype/store.ts";
import {
  type ConversationAgentRequest,
  ImplementationAgent,
  type ImplementationAgentControlRequest,
  makeFileApplicationRepository,
  makeReferenceCodingApplication,
  WorktreeManager,
} from "../src/reference-coding-application.ts";
import { makeTempDirectoryScoped } from "./support/temp-directory.ts";

describe("sixth Application tracer", () => {
  it.effect(
    "cancels owned active and queued work through Conversation control without touching its worktree",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const executionId = "CCANCEL:1.0:execution:1";
          const activeWorkStopped = yield* Deferred.make<void>();
          const activeWorkRelease = yield* Deferred.make<void>();
          const controlRequests = yield* Ref.make<
            readonly ImplementationAgentControlRequest[]
          >([]);
          const resumeCalls = yield* Ref.make(0);
          const worktreeState = yield* Ref.make({
            createCalls: 0,
            deleteCalls: 0,
            revision: "original",
          });
          const conversationRequests = yield* Ref.make<
            readonly ConversationAgentRequest[]
          >([]);
          const delivered = yield* Ref.make<readonly string[]>([]);
          const promptRejections = yield* Ref.make<readonly string[]>([]);
          const conversationAgent = {
            handle: (request: ConversationAgentRequest) =>
              Effect.gen(function* () {
                yield* Ref.update(conversationRequests, (current) =>
                  EffectArray.append(current, request)
                );
                const message = request.messages.at(-1)?.text ?? "";
                if (message.includes("start cancellable work")) {
                  const action = request.actions.find(
                    (candidate) => candidate.name === "create-feature"
                  );
                  assert.ok(action);
                  yield* action.invoke({
                    prompt: "run until cancelled",
                    worktreeName: "cancellable-work",
                  });
                  return [];
                }
                if (message.includes("queue more work")) {
                  const action = request.executionControls.find(
                    (candidate) => candidate.name === "prompt"
                  );
                  assert.ok(action);
                  yield* action.invoke({
                    executionId,
                    prompt: "must never start",
                  });
                  return [];
                }
                if (message.includes("cancel all work")) {
                  const action = request.executionControls.find(
                    (candidate) => candidate.name === "cancel"
                  );
                  assert.ok(action);
                  const first = yield* action.invoke({
                    control: "cancel",
                    executionId,
                  });
                  const duplicate = yield* action.invoke({
                    control: "cancel",
                    executionId,
                  });
                  assert.strictEqual(first.status, "cancelled");
                  assert.strictEqual(duplicate.status, "cancelled");
                  return [];
                }
                if (message.includes("prompt cancelled work")) {
                  const action = request.executionControls.find(
                    (candidate) => candidate.name === "prompt"
                  );
                  assert.ok(action);
                  const result = yield* Effect.result(
                    action.invoke({ executionId, prompt: "too late" })
                  );
                  assert.strictEqual(result._tag, "Failure");
                  if (result._tag === "Failure") {
                    yield* Ref.update(promptRejections, (current) =>
                      EffectArray.append(
                        current,
                        result.failure.safeDetail ?? "missing safe detail"
                      )
                    );
                  }
                  return [];
                }
                if (request.source === "execution-control") {
                  return [
                    {
                      replyId: `${request.turnId}:cancelled`,
                      text: `Conversation reported ${executionId} cancelled.`,
                    },
                  ];
                }
                return [];
              }),
          };
          const application = yield* makeReferenceCodingApplication({
            conversationAgent,
            implementationAgent: ImplementationAgent.of({
              start: (request) =>
                Effect.succeed({
                  completion: Deferred.await(activeWorkRelease).pipe(
                    Effect.ensuring(
                      Deferred.succeed(activeWorkStopped, undefined)
                    )
                  ),
                  control: (controlRequest) =>
                    Ref.update(controlRequests, (current) =>
                      EffectArray.append(current, controlRequest)
                    ),
                  resume: () => Ref.update(resumeCalls, (count) => count + 1),
                  sessionId: request.implementationSessionId,
                }),
            }),
            worktreeManager: WorktreeManager.of({
              create: () =>
                Ref.update(worktreeState, (current) => ({
                  ...current,
                  createCalls: current.createCalls + 1,
                })).pipe(
                  Effect.as({
                    workingDirectory: "/tmp/laborer-worktrees/cancellable-work",
                  })
                ),
            }),
          });
          const harness = yield* makePrototypeHarness({
            application,
            laborerSlackId: LABORER_SLACK_ID,
            slack: {
              postThreadMessage: (request) =>
                Ref.update(delivered, (current) =>
                  EffectArray.append(current, request.text)
                ).pipe(Effect.as({ ts: `reply-${request.text}` })),
              readActivationContext: () => Effect.succeed([]),
            },
          });
          const inject = (eventId: string, messageTs: string, text: string) =>
            harness.runner.inject(
              normalizedEvent({
                authorSlackId: "UHUMAN",
                channelId: "CCANCEL",
                eventId,
                messageTs,
                text,
                ...(messageTs === "1.0" ? {} : { threadTs: "1.0" }),
              })
            );

          yield* inject(
            "event:cancel:start",
            "1.0",
            `<@${LABORER_SLACK_ID}> start cancellable work`
          );
          yield* inject("event:cancel:queue", "2.0", "queue more work");
          yield* inject("event:cancel:control", "3.0", "cancel all work");
          yield* Deferred.await(activeWorkStopped);
          yield* Effect.yieldNow;
          yield* inject(
            "event:cancel:rejected-prompt",
            "4.0",
            "prompt cancelled work"
          );
          yield* harness.runner.drain(ThreadId.make("CCANCEL:1.0"));

          assert.deepStrictEqual(yield* Ref.get(controlRequests), [
            {
              control: "cancel",
              conversationId: ThreadId.make("CCANCEL:1.0"),
              executionId,
              implementationSessionId:
                "ses_b8340d6cd8b35a863b611c7416ecaa36c62ea6a967dd504168f060da8d39",
              workingDirectory: "/tmp/laborer-worktrees/cancellable-work",
            },
          ]);
          assert.strictEqual(yield* Ref.get(resumeCalls), 0);
          assert.deepStrictEqual(yield* Ref.get(worktreeState), {
            createCalls: 1,
            deleteCalls: 0,
            revision: "original",
          });
          assert.deepStrictEqual(yield* Ref.get(promptRejections), [
            "Execution is terminal and cannot accept prompts",
          ]);
          const requests = yield* Ref.get(conversationRequests);
          const cancellationEvents = requests.filter(
            (request) => request.source === "execution-control"
          );
          assert.strictEqual(cancellationEvents.length, 1);
          assert.strictEqual(
            cancellationEvents[0]?.input,
            `<application-event source="execution-control" execution-id="${executionId}" control="cancel" status="cancelled" />`
          );
          assert.strictEqual(
            requests.at(-1)?.executions[0]?.status,
            "cancelled"
          );
          assert.deepStrictEqual(yield* Ref.get(delivered), [
            `Conversation reported ${executionId} cancelled.`,
          ]);
        })
      )
  );

  it.effect(
    "fails recovery once when its persisted worktree is inaccessible without replacing anything",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-sixth-missing-worktree-"
          );
          const applicationSnapshotPath = join(root, "application.json");
          const runnerSnapshotPath = join(root, "runner.json");
          const executionId = "CMISSINGWORKTREE:1.0:execution:1";
          const recoveryEventHandled = yield* Deferred.make<void>();
          const worktreeCalls = yield* Ref.make({
            create: 0,
            recover: 0,
            remove: 0,
            validate: 0,
          });
          const implementationCalls = yield* Ref.make({ recover: 0, start: 0 });
          const conversationRequests = yield* Ref.make<
            readonly ConversationAgentRequest[]
          >([]);
          const delivered = yield* Ref.make<readonly string[]>([]);
          const conversationAgent = {
            handle: (request: ConversationAgentRequest) =>
              Effect.gen(function* () {
                yield* Ref.update(conversationRequests, (current) =>
                  EffectArray.append(current, request)
                );
                if (request.source === "execution-recovery") {
                  yield* Deferred.succeed(recoveryEventHandled, undefined);
                  return [
                    {
                      replyId: `${request.turnId}:reported`,
                      text: `Conversation reported ${executionId} recovery failed.`,
                    },
                  ];
                }
                const message = request.messages.at(-1)?.text ?? "";
                if (message.includes("start work with persisted worktree")) {
                  const action = request.actions.find(
                    (candidate) => candidate.name === "create-feature"
                  );
                  assert.ok(action);
                  yield* action.invoke({
                    prompt: "persist this implementation",
                    worktreeName: "missing-after-restart",
                  });
                }
                return [];
              }),
          };
          const makeApplication = Effect.gen(function* () {
            const repository = yield* makeFileApplicationRepository(
              applicationSnapshotPath,
              root
            );
            const worktreeManager = {
              create: () =>
                Ref.update(worktreeCalls, (current) => ({
                  ...current,
                  create: current.create + 1,
                })).pipe(
                  Effect.as({
                    workingDirectory:
                      "/tmp/laborer-worktrees/missing-after-restart",
                  })
                ),
              recover: () =>
                Ref.update(worktreeCalls, (current) => ({
                  ...current,
                  recover: current.recover + 1,
                })).pipe(
                  Effect.andThen(
                    HandlerFailure.make({
                      category: "protocol",
                      safeDetail: "must not recover a persisted worktree",
                    })
                  )
                ),
              remove: () =>
                Ref.update(worktreeCalls, (current) => ({
                  ...current,
                  remove: current.remove + 1,
                })),
              validate: () =>
                Ref.update(worktreeCalls, (current) => ({
                  ...current,
                  validate: current.validate + 1,
                })).pipe(
                  Effect.andThen(
                    HandlerFailure.make({
                      category: "protocol",
                      safeDetail: "persisted worktree is inaccessible",
                    })
                  )
                ),
            };
            return yield* makeReferenceCodingApplication({
              conversationAgent,
              implementationAgent: ImplementationAgent.of({
                recover: () =>
                  Ref.update(implementationCalls, (current) => ({
                    ...current,
                    recover: current.recover + 1,
                  })).pipe(
                    Effect.andThen(
                      HandlerFailure.make({
                        category: "protocol",
                        safeDetail: "must not recover without a worktree",
                      })
                    )
                  ),
                start: (request) =>
                  Ref.update(implementationCalls, (current) => ({
                    ...current,
                    start: current.start + 1,
                  })).pipe(
                    Effect.as({
                      completion: Effect.never,
                      resume: () => Effect.void,
                      sessionId: request.implementationSessionId,
                    })
                  ),
              }),
              repository,
              worktreeManager,
            });
          });
          const slack = {
            postThreadMessage: (request: { readonly text: string }) =>
              Ref.update(delivered, (current) =>
                EffectArray.append(current, request.text)
              ).pipe(Effect.as({ ts: `reply-${request.text}` })),
            readActivationContext: () => Effect.succeed([]),
          };
          const makeHarness = Effect.gen(function* () {
            const application = yield* makeApplication;
            return yield* makePrototypeHarness({
              application,
              laborerSlackId: LABORER_SLACK_ID,
              slack,
              storeLayer: makeFileStoreLayer(
                LABORER_SLACK_ID,
                runnerSnapshotPath,
                root
              ),
            });
          });

          yield* Effect.scoped(
            Effect.gen(function* () {
              const harness = yield* makeHarness;
              yield* harness.runner.inject(
                normalizedEvent({
                  authorSlackId: "UHUMAN",
                  channelId: "CMISSINGWORKTREE",
                  eventId: "event:missing-worktree:start",
                  messageTs: "1.0",
                  text: `<@${LABORER_SLACK_ID}> start work with persisted worktree`,
                })
              );
            })
          );

          yield* Effect.scoped(
            Effect.gen(function* () {
              const harness = yield* makeHarness;
              yield* Deferred.await(recoveryEventHandled);
              yield* harness.runner.drain(
                ThreadId.make("CMISSINGWORKTREE:1.0")
              );
            })
          );

          yield* Effect.scoped(
            Effect.gen(function* () {
              const harness = yield* makeHarness;
              yield* harness.runner.inject(
                normalizedEvent({
                  authorSlackId: "UHUMAN",
                  channelId: "CMISSINGWORKTREE",
                  eventId: "event:missing-worktree:status",
                  messageTs: "2.0",
                  text: "show failed recovery",
                  threadTs: "1.0",
                })
              );
            })
          );

          assert.deepStrictEqual(yield* Ref.get(worktreeCalls), {
            create: 1,
            recover: 0,
            remove: 0,
            validate: 1,
          });
          assert.deepStrictEqual(yield* Ref.get(implementationCalls), {
            recover: 0,
            start: 1,
          });
          const requests = yield* Ref.get(conversationRequests);
          const recoveryRequests = requests.filter(
            (request) => request.source === "execution-recovery"
          );
          assert.strictEqual(recoveryRequests.length, 1);
          assert.strictEqual(
            recoveryRequests[0]?.input,
            `<application-event source="execution-recovery" execution-id="${executionId}" kind="recovery-failure" resource="worktree" />`
          );
          assert.strictEqual(requests.at(-1)?.executions[0]?.status, "failed");
          assert.deepStrictEqual(yield* Ref.get(delivered), [
            `Conversation reported ${executionId} recovery failed.`,
          ]);
        })
      )
  );

  it.effect(
    "fails recovery once when its implementation session is missing without starting a replacement",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-sixth-missing-session-"
          );
          const applicationSnapshotPath = join(root, "application.json");
          const runnerSnapshotPath = join(root, "runner.json");
          const executionId = "CMISSINGSESSION:1.0:execution:1";
          const recoveryEventHandled = yield* Deferred.make<void>();
          const worktreeCalls = yield* Ref.make({
            create: 0,
            recover: 0,
            remove: 0,
            validate: 0,
          });
          const implementationCalls = yield* Ref.make({ recover: 0, start: 0 });
          const conversationRequests = yield* Ref.make<
            readonly ConversationAgentRequest[]
          >([]);
          const delivered = yield* Ref.make<readonly string[]>([]);
          const conversationAgent = {
            handle: (request: ConversationAgentRequest) =>
              Effect.gen(function* () {
                yield* Ref.update(conversationRequests, (current) =>
                  EffectArray.append(current, request)
                );
                if (request.source === "execution-recovery") {
                  yield* Deferred.succeed(recoveryEventHandled, undefined);
                  return [
                    {
                      replyId: `${request.turnId}:reported`,
                      text: `Conversation reported ${executionId} session recovery failed.`,
                    },
                  ];
                }
                const message = request.messages.at(-1)?.text ?? "";
                if (message.includes("start work with persisted session")) {
                  const action = request.actions.find(
                    (candidate) => candidate.name === "create-feature"
                  );
                  assert.ok(action);
                  yield* action.invoke({
                    prompt: "persist this session",
                    worktreeName: "session-missing-after-restart",
                  });
                }
                return [];
              }),
          };
          const makeApplication = Effect.gen(function* () {
            const repository = yield* makeFileApplicationRepository(
              applicationSnapshotPath,
              root
            );
            const worktreeManager = {
              create: () =>
                Ref.update(worktreeCalls, (current) => ({
                  ...current,
                  create: current.create + 1,
                })).pipe(
                  Effect.as({
                    workingDirectory:
                      "/tmp/laborer-worktrees/session-missing-after-restart",
                  })
                ),
              recover: () =>
                Ref.update(worktreeCalls, (current) => ({
                  ...current,
                  recover: current.recover + 1,
                })).pipe(
                  Effect.andThen(
                    HandlerFailure.make({
                      category: "protocol",
                      safeDetail: "must not recover a persisted worktree",
                    })
                  )
                ),
              remove: () =>
                Ref.update(worktreeCalls, (current) => ({
                  ...current,
                  remove: current.remove + 1,
                })),
              validate: () =>
                Ref.update(worktreeCalls, (current) => ({
                  ...current,
                  validate: current.validate + 1,
                })),
            };
            return yield* makeReferenceCodingApplication({
              conversationAgent,
              implementationAgent: ImplementationAgent.of({
                recover: () =>
                  Ref.update(implementationCalls, (current) => ({
                    ...current,
                    recover: current.recover + 1,
                  })).pipe(
                    Effect.andThen(
                      HandlerFailure.make({
                        category: "protocol",
                        safeDetail: "implementation session is missing",
                      })
                    )
                  ),
                start: (request) =>
                  Ref.update(implementationCalls, (current) => ({
                    ...current,
                    start: current.start + 1,
                  })).pipe(
                    Effect.as({
                      completion: Effect.never,
                      resume: () => Effect.void,
                      sessionId: request.implementationSessionId,
                    })
                  ),
              }),
              repository,
              worktreeManager,
            });
          });
          const slack = {
            postThreadMessage: (request: { readonly text: string }) =>
              Ref.update(delivered, (current) =>
                EffectArray.append(current, request.text)
              ).pipe(Effect.as({ ts: `reply-${request.text}` })),
            readActivationContext: () => Effect.succeed([]),
          };
          const makeHarness = Effect.gen(function* () {
            const application = yield* makeApplication;
            return yield* makePrototypeHarness({
              application,
              laborerSlackId: LABORER_SLACK_ID,
              slack,
              storeLayer: makeFileStoreLayer(
                LABORER_SLACK_ID,
                runnerSnapshotPath,
                root
              ),
            });
          });

          yield* Effect.scoped(
            Effect.gen(function* () {
              const harness = yield* makeHarness;
              yield* harness.runner.inject(
                normalizedEvent({
                  authorSlackId: "UHUMAN",
                  channelId: "CMISSINGSESSION",
                  eventId: "event:missing-session:start",
                  messageTs: "1.0",
                  text: `<@${LABORER_SLACK_ID}> start work with persisted session`,
                })
              );
            })
          );

          yield* Effect.scoped(
            Effect.gen(function* () {
              const harness = yield* makeHarness;
              yield* Deferred.await(recoveryEventHandled);
              yield* harness.runner.drain(ThreadId.make("CMISSINGSESSION:1.0"));
            })
          );

          yield* Effect.scoped(
            Effect.gen(function* () {
              const harness = yield* makeHarness;
              yield* harness.runner.inject(
                normalizedEvent({
                  authorSlackId: "UHUMAN",
                  channelId: "CMISSINGSESSION",
                  eventId: "event:missing-session:status",
                  messageTs: "2.0",
                  text: "show failed session recovery",
                  threadTs: "1.0",
                })
              );
            })
          );

          assert.deepStrictEqual(yield* Ref.get(worktreeCalls), {
            create: 1,
            recover: 0,
            remove: 0,
            validate: 1,
          });
          assert.deepStrictEqual(yield* Ref.get(implementationCalls), {
            recover: 1,
            start: 1,
          });
          const requests = yield* Ref.get(conversationRequests);
          const recoveryRequests = requests.filter(
            (request) => request.source === "execution-recovery"
          );
          assert.strictEqual(recoveryRequests.length, 1);
          assert.strictEqual(
            recoveryRequests[0]?.input,
            `<application-event source="execution-recovery" execution-id="${executionId}" kind="recovery-failure" resource="implementation-session" />`
          );
          assert.strictEqual(requests.at(-1)?.executions[0]?.status, "failed");
          assert.deepStrictEqual(yield* Ref.get(delivered), [
            `Conversation reported ${executionId} session recovery failed.`,
          ]);
        })
      )
  );
});
