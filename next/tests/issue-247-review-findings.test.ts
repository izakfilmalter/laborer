import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Ref } from "effect";
import { ExternalInputEvent } from "../src/application.ts";
import { ThreadId } from "../src/prototype/domain.ts";
import { HandlerFailure } from "../src/prototype/errors.ts";
import { makePrototypeHarness } from "../src/prototype/runtime.ts";
import { normalizedEvent } from "../src/prototype/scenario.ts";
import {
  type AcceptImplementationAgentResponse,
  type ConversationAgentRequest,
  ImplementationAgent,
  makeFileApplicationRepository,
  makeInMemoryApplicationRepository,
  makeReferenceCodingApplication,
  WorktreeManager,
} from "../src/reference-coding-application.ts";
import { makeTempDirectoryScoped } from "./support/temp-directory.ts";

const acceptedEvent = (event: ExternalInputEvent) =>
  Effect.succeed({
    decision: { _tag: "Accepted" as const, eventId: event.eventId },
    scheduling: "Scheduled" as const,
  });

const failedExecutionState = (conversationId: ThreadId) => ({
  actionOperationTombstones: [],
  actionOperations: [],
  conversations: [],
  executionPromptOperations: [],
  executions: [
    {
      actionInvocationId: "operation:failed-response",
      actionName: "create-feature",
      conversationId,
      events: [],
      executionId: "execution:failed-response",
      implementationSessionId: "session:failed-response",
      prompts: [
        {
          kind: "initial",
          promptId: "prompt:failed-response",
          status: "failed",
          text: "Implement response recovery.",
        },
      ],
      responses: [
        {
          eventId: "execution:failed-response:response:response-1",
          responseId: "response-1",
          status: "staged",
          text: "Durable implementation output.",
        },
      ],
      status: "failed",
      workingDirectory: "/tmp/failed-response",
      worktreeName: "failed-response",
    },
  ],
  schemaVersion: 10,
});

describe("issue #247 review findings", () => {
  it.effect(
    "ignores empty implementation output without losing the next nonempty response",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const conversationId = ThreadId.make("C247NONEMPTY:1.0");
          const sources = yield* Ref.make<readonly string[]>([]);
          const delivered = yield* Ref.make<readonly string[]>([]);
          const repository = yield* makeInMemoryApplicationRepository();
          const application = yield* makeReferenceCodingApplication({
            conversationAgent: {
              handle: (request) =>
                Effect.gen(function* () {
                  yield* Ref.update(sources, (current) => [
                    ...current,
                    request.source,
                  ]);
                  if (request.source === "slack") {
                    const action = request.actions.find(
                      (candidate) => candidate.name === "create-feature"
                    );
                    assert.ok(action);
                    yield* action.invoke({
                      prompt: "Produce one meaningful response.",
                      worktreeName: "nonempty-response",
                    });
                    return [];
                  }
                  if (request.source === "implementation-agent") {
                    return [
                      {
                        replyId: "nonempty-reviewed",
                        text: "Meaningful implementation output reviewed.",
                      },
                    ];
                  }
                  return [];
                }),
            },
            implementationAgent: ImplementationAgent.of({
              start: (request, acceptResponse) =>
                Effect.succeed({
                  completion: acceptResponse({
                    responseId: "empty-response",
                    text: "  \n ",
                  }).pipe(
                    Effect.andThen(
                      acceptResponse({
                        responseId: "meaningful-response",
                        text: "Durable implementation output.",
                      })
                    )
                  ),
                  resume: () => Effect.void,
                  sessionId: request.implementationSessionId,
                }),
            }),
            repository,
            worktreeManager: WorktreeManager.of({
              create: () =>
                Effect.succeed({ workingDirectory: "/tmp/nonempty-response" }),
            }),
          });
          const harness = yield* makePrototypeHarness({
            application,
            laborerSlackId: "U247LABORER",
            slack: {
              postThreadMessage: ({ text }) =>
                Ref.update(delivered, (messages) => [...messages, text]).pipe(
                  Effect.as({ ts: `message-${text}` })
                ),
              readActivationContext: () => Effect.succeed([]),
            },
          });
          yield* harness.runner.accept(
            normalizedEvent({
              authorSlackId: "U247HUMAN",
              channelId: "C247NONEMPTY",
              eventId: "event:247:nonempty",
              messageTs: "1.0",
              text: "<@U247LABORER> start response work",
            })
          );
          yield* harness.runner.drain(conversationId);

          assert.deepStrictEqual(yield* Ref.get(sources), [
            "slack",
            "implementation-agent",
            "action-terminal",
          ]);
          assert.deepStrictEqual(yield* Ref.get(delivered), [
            "Meaningful implementation output reviewed.",
          ]);
          assert.deepStrictEqual(
            (yield* repository.load).executions[0]?.responses.map(
              ({ responseId, status, text }) => ({ responseId, status, text })
            ),
            [
              {
                responseId: "meaningful-response",
                status: "delivered",
                text: "Durable implementation output.",
              },
            ]
          );
        })
      )
  );

  it.effect(
    "keeps implementation output FIFO behind an active human turn",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const conversationId = ThreadId.make("C247FIFO:1.0");
          const activeTurn = yield* Deferred.make<void>();
          const releaseTurn = yield* Deferred.make<void>();
          const sessionIds = yield* Ref.make<readonly string[]>([]);
          const sources = yield* Ref.make<readonly string[]>([]);
          const delivered = yield* Ref.make<readonly string[]>([]);
          const repository = yield* makeInMemoryApplicationRepository();
          const application = yield* makeReferenceCodingApplication({
            conversationAgent: {
              handle: (request) =>
                Effect.gen(function* () {
                  yield* Ref.update(sessionIds, (ids) => [
                    ...ids,
                    request.conversationSessionId,
                  ]);
                  yield* Ref.update(sources, (current) => [
                    ...current,
                    request.source,
                  ]);
                  if (request.source === "slack") {
                    const action = request.actions.find(
                      (candidate) => candidate.name === "create-feature"
                    );
                    assert.ok(action);
                    yield* action.invoke({
                      prompt: "Emit output while permission is pending.",
                      worktreeName: "permission-fifo",
                    });
                    yield* Deferred.succeed(activeTurn, undefined);
                    yield* Deferred.await(releaseTurn);
                    return [
                      {
                        replyId: "permission-settled",
                        text: "Permission settled.",
                      },
                    ];
                  }
                  if (request.source === "implementation-agent") {
                    return [
                      {
                        replyId: "implementation-reviewed",
                        text: "Implementation update reviewed.",
                      },
                    ];
                  }
                  return [];
                }),
            },
            implementationAgent: ImplementationAgent.of({
              start: (request, acceptResponse) =>
                Effect.succeed({
                  completion: acceptResponse({
                    responseId: "permission-response",
                    text: "Private implementation output.",
                  }),
                  resume: () => Effect.void,
                  sessionId: request.implementationSessionId,
                }),
            }),
            repository,
            worktreeManager: WorktreeManager.of({
              create: () =>
                Effect.succeed({ workingDirectory: "/tmp/permission-fifo" }),
            }),
          });
          const harness = yield* makePrototypeHarness({
            application,
            laborerSlackId: "U247LABORER",
            slack: {
              postThreadMessage: ({ text }) =>
                Ref.update(delivered, (messages) => [...messages, text]).pipe(
                  Effect.as({ ts: `message-${text}` })
                ),
              readActivationContext: () => Effect.succeed([]),
            },
          });
          yield* harness.runner.accept(
            normalizedEvent({
              authorSlackId: "U247HUMAN",
              channelId: "C247FIFO",
              eventId: "event:247:fifo",
              messageTs: "1.0",
              text: "<@U247LABORER> start guarded work",
            })
          );
          yield* Deferred.await(activeTurn);
          for (let attempt = 0; attempt < 100; attempt += 1) {
            const response = (yield* repository.load).executions[0]
              ?.responses[0];
            if (response?.status === "enqueued") {
              break;
            }
            yield* Effect.promise(
              () => new Promise<void>((resolve) => setTimeout(resolve, 5))
            );
          }
          const queued = (yield* harness.store.snapshot).threads.find(
            (thread) => thread.id === conversationId
          );
          assert.strictEqual(queued?.turns[0]?.status, "running");
          assert.strictEqual(queued?.applicationEvents[0]?.status, "pending");
          assert.strictEqual(
            (yield* repository.load).executions[0]?.responses[0]?.status,
            "enqueued"
          );
          assert.deepStrictEqual(yield* Ref.get(sources), ["slack"]);

          yield* Deferred.succeed(releaseTurn, undefined);
          yield* harness.runner.drain(conversationId);
          assert.deepStrictEqual(yield* Ref.get(sources), [
            "slack",
            "implementation-agent",
            "action-terminal",
          ]);
          assert.strictEqual(new Set(yield* Ref.get(sessionIds)).size, 1);
          assert.deepStrictEqual(yield* Ref.get(delivered), [
            "Permission settled.",
            "Implementation update reviewed.",
          ]);
          assert.strictEqual(
            (yield* repository.load).executions[0]?.responses[0]?.status,
            "delivered"
          );
        })
      )
  );

  it.effect(
    "retries a failed Execution's staged response independently until it is delivered once",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-247-failed-response-"
          );
          const statePath = join(root, "application.json");
          const conversationId = ThreadId.make("workspace:T247:C247:1.0");
          yield* Effect.promise(() =>
            writeFile(
              statePath,
              JSON.stringify(failedExecutionState(conversationId))
            )
          );
          const accepted = yield* Ref.make<readonly ExternalInputEvent[]>([]);
          const handled = yield* Ref.make(0);
          const published = yield* Ref.make<readonly string[]>([]);
          const makeApplication = Effect.gen(function* () {
            const repository = yield* makeFileApplicationRepository(
              statePath,
              root
            );
            const application = yield* makeReferenceCodingApplication({
              conversationAgent: {
                handle: (request) =>
                  Ref.update(handled, (count) => count + 1).pipe(
                    Effect.as([
                      {
                        replyId: `${request.turnId}:reply`,
                        text: "Implementation output reviewed.",
                      },
                    ])
                  ),
              },
              implementationAgent: ImplementationAgent.of({
                start: () =>
                  Effect.die(
                    new Error(
                      "failed Execution must not restart implementation"
                    )
                  ),
              }),
              repository,
              worktreeManager: WorktreeManager.of({
                create: () =>
                  Effect.die(
                    new Error("failed Execution must not create work")
                  ),
              }),
            });
            return { application, repository };
          });

          for (const attempt of [1, 2]) {
            const { application, repository } = yield* makeApplication;
            const recovery = yield* Effect.result(
              application.recover?.(() =>
                HandlerFailure.make({
                  category: "protocol",
                  safeDetail: `transient accept failure ${attempt}`,
                })
              ) ?? Effect.void
            );
            assert.strictEqual(recovery._tag, "Failure");
            const execution = (yield* repository.load).executions[0];
            assert.strictEqual(execution?.status, "failed");
            assert.strictEqual(execution?.responses[0]?.status, "staged");
          }

          const { application, repository } = yield* makeApplication;
          yield* application.recover?.((event) =>
            Ref.update(accepted, (events) => [...events, event]).pipe(
              Effect.andThen(acceptedEvent(event))
            )
          ) ?? Effect.void;
          assert.strictEqual((yield* Ref.get(accepted)).length, 1);
          assert.strictEqual(
            (yield* repository.load).executions[0]?.responses[0]?.status,
            "enqueued"
          );

          const restarted = yield* makeApplication;
          yield* restarted.application.recover?.((event) =>
            Ref.update(accepted, (events) => [...events, event]).pipe(
              Effect.andThen(acceptedEvent(event))
            )
          ) ?? Effect.void;
          assert.strictEqual((yield* Ref.get(accepted)).length, 1);
          const event = (yield* Ref.get(accepted))[0];
          assert.ok(event);
          yield* restarted.application.handle(
            event,
            (output) =>
              output._tag === "PublicReply"
                ? Ref.update(published, (messages) => [
                    ...messages,
                    output.text,
                  ])
                : Effect.void,
            acceptedEvent
          );
          assert.strictEqual(yield* Ref.get(handled), 1);
          assert.deepStrictEqual(yield* Ref.get(published), [
            "Implementation output reviewed.",
          ]);
          const delivered = (yield* restarted.repository.load).executions[0];
          assert.strictEqual(delivered?.status, "failed");
          assert.strictEqual(delivered?.responses[0]?.status, "delivered");
        })
      )
  );

  it.effect(
    "migrates near-limit v9 history losslessly while enforcing new append limits",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-247-v9-large-migration-"
          );
          const statePath = join(root, "application.json");
          const conversationId = ThreadId.make("workspace:T247:C247:2.0");
          const executionId = "execution:legacy-large";
          const prompts = Array.from({ length: 129 }, (_, index) => ({
            kind: index === 0 ? "initial" : "resume",
            promptId: `legacy-prompt-${index}`,
            status: "completed",
            text: `Legacy prompt ${index}`,
          }));
          const responses = Array.from({ length: 257 }, (_, index) => ({
            eventId: `${executionId}:response:legacy-response-${index}`,
            responseId: `legacy-response-${index}`,
            status: "accepted",
            text:
              index === 0 ? "legacy placeholder" : `Legacy response ${index}`,
          }));
          const events = Array.from({ length: 513 }, (_, index) => ({
            eventId: `${executionId}:legacy-event:${index}`,
            payload: { index },
            source: "legacy-test",
            status: "accepted",
          }));
          const legacy = {
            actionOperationTombstones: [],
            actionOperations: [],
            conversations: [],
            executions: [
              {
                actionInvocationId: "legacy-operation",
                actionName: "create-feature",
                conversationId,
                events,
                executionId,
                implementationSessionId: "legacy-session",
                prompts,
                responses,
                status: "completed",
                workingDirectory: "/tmp/legacy-large",
                worktreeName: "legacy-large",
              },
            ],
            schemaVersion: 9,
          };
          const targetBytes = 4 * 1024 * 1024 - 64 * 1024;
          const baseBytes = Buffer.byteLength(JSON.stringify(legacy), "utf8");
          const firstResponse = responses[0];
          assert.ok(firstResponse);
          responses[0] = {
            ...firstResponse,
            text: "x".repeat(targetBytes - baseBytes),
          };
          const serialized = JSON.stringify(legacy);
          assert.ok(Buffer.byteLength(serialized, "utf8") < 4 * 1024 * 1024);
          assert.ok(
            Buffer.byteLength(serialized, "utf8") > 4 * 1024 * 1024 - 128 * 1024
          );
          assert.ok((responses[0]?.text.length ?? 0) > 16_384);
          yield* Effect.promise(() => writeFile(statePath, serialized));

          const recoveredResponse = yield* Ref.make<
            AcceptImplementationAgentResponse | undefined
          >(undefined);
          const controlResult = yield* Ref.make<"Failure" | "Success" | null>(
            null
          );
          const repository = yield* makeFileApplicationRepository(
            statePath,
            root
          );
          const application = yield* makeReferenceCodingApplication({
            conversationAgent: {
              handle: (request: ConversationAgentRequest) => {
                const control = request.executionControls.find(
                  (candidate) => candidate.name === "prompt-execution"
                );
                assert.ok(control);
                return Effect.result(
                  control.invoke({ executionId, prompt: "A new prompt" })
                ).pipe(
                  Effect.tap((result) => Ref.set(controlResult, result._tag)),
                  Effect.as([] as const)
                );
              },
            },
            implementationAgent: ImplementationAgent.of({
              recover: (request, acceptResponse) =>
                Ref.set(recoveredResponse, acceptResponse).pipe(
                  Effect.as({
                    completion: Effect.void,
                    resume: () => Effect.void,
                    sessionId: request.implementationSessionId,
                  })
                ),
              start: () =>
                Effect.die(
                  new Error("legacy completed work must be recovered")
                ),
            }),
            repository,
            worktreeManager: WorktreeManager.of({
              create: () =>
                Effect.die(new Error("legacy worktree must not be recreated")),
              validate: () => Effect.void,
            }),
          });
          yield* application.recover?.(acceptedEvent) ?? Effect.void;
          const migrated = yield* repository.load;
          const execution = migrated.executions[0];
          assert.strictEqual(migrated.schemaVersion, 16);
          assert.strictEqual(execution?.executionId, executionId);
          assert.strictEqual(execution?.prompts.length, 129);
          assert.strictEqual(execution?.responses.length, 257);
          assert.strictEqual(execution?.events.length, 513);
          assert.strictEqual(execution?.responses[0]?.status, "enqueued");
          assert.strictEqual(execution?.responses[0]?.text, responses[0]?.text);

          const acceptResponse = yield* Ref.get(recoveredResponse);
          assert.ok(acceptResponse);
          const responseAppend = yield* Effect.result(
            acceptResponse({ responseId: "new-response", text: "new output" })
          );
          assert.strictEqual(responseAppend._tag, "Failure");
          assert.strictEqual(
            (yield* repository.load).executions[0]?.responses.length,
            257
          );

          yield* application.handle(
            ExternalInputEvent.make({
              conversationId,
              eventId: "event:legacy-capacity",
              payload: {},
              source: "test",
            }),
            () => Effect.void,
            acceptedEvent
          );
          assert.strictEqual(yield* Ref.get(controlResult), "Failure");
          assert.strictEqual(
            (yield* repository.load).executions[0]?.prompts.length,
            129
          );
        })
      )
  );

  it.effect(
    "rejects a foreign source-tagged response before ACP or state mutation",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-247-owned-source-event-"
          );
          const statePath = join(root, "application.json");
          const owner = ThreadId.make("workspace:T247:C247:3.0");
          const foreign = ThreadId.make("workspace:T247:C247:4.0");
          const state = failedExecutionState(owner);
          const response = state.executions[0]?.responses[0];
          assert.ok(response);
          response.status = "enqueued";
          yield* Effect.promise(() =>
            writeFile(statePath, JSON.stringify(state))
          );
          const repository = yield* makeFileApplicationRepository(
            statePath,
            root
          );
          const acpCalls = yield* Ref.make(0);
          const publishes = yield* Ref.make(0);
          const application = yield* makeReferenceCodingApplication({
            conversationAgent: {
              handle: () =>
                Ref.update(acpCalls, (count) => count + 1).pipe(Effect.as([])),
            },
            implementationAgent: ImplementationAgent.of({
              start: () => Effect.die(new Error("must not start")),
            }),
            repository,
            worktreeManager: WorktreeManager.of({
              create: () => Effect.die(new Error("must not create")),
            }),
          });
          const before = JSON.stringify(yield* repository.load);
          const result = yield* Effect.result(
            application.handle(
              ExternalInputEvent.make({
                conversationId: foreign,
                eventId: "execution:failed-response:response:response-1",
                payload: {
                  actionName: "create-feature",
                  executionId: "execution:failed-response",
                  responseId: "response-1",
                  text: "Durable implementation output.",
                },
                source: "implementation-agent",
              }),
              () => Ref.update(publishes, (count) => count + 1),
              acceptedEvent
            )
          );
          assert.strictEqual(result._tag, "Failure");
          assert.strictEqual(yield* Ref.get(acpCalls), 0);
          assert.strictEqual(yield* Ref.get(publishes), 0);
          assert.strictEqual(JSON.stringify(yield* repository.load), before);
        })
      )
  );
});
