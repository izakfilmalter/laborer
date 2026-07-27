import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Option, Ref } from "effect";
import { Application, type ExternalInputEvent } from "../src/application.ts";
import { ThreadId } from "../src/prototype/domain.ts";
import { HandlerFailure } from "../src/prototype/errors.ts";
import { makePrototypeHarness } from "../src/prototype/runtime.ts";
import { normalizedEvent } from "../src/prototype/scenario.ts";
import { makeFileStoreLayer } from "../src/prototype/store.ts";
import {
  ImplementationAgent,
  makeFileApplicationRepository,
  makeReferenceCodingApplication,
  WorktreeManager,
} from "../src/reference-coding-application.ts";
import { makeTempDirectoryScoped } from "./support/temp-directory.ts";

const acceptedEvent = (event: ExternalInputEvent) =>
  Effect.succeed({
    decision: { _tag: "Accepted" as const, eventId: event.eventId },
    scheduling: "AlreadyDurable" as const,
  });

const v12Execution = (
  conversationId: ThreadId,
  status: "completed" | "failed"
) => ({
  actionInvocationId: "operation:v12",
  actionName: "create-feature" as const,
  cancellation: null,
  conversationId,
  events: [
    {
      eventId: "execution:v12:terminal",
      payload: {
        actionName: "create-feature",
        executionId: "execution:v12",
        status,
      },
      source: "action-terminal",
      status: "staged",
    },
  ],
  executionId: "execution:v12",
  implementationSessionId: "session:v12",
  ownerWorkspaceId: "T251",
  prompts: [
    {
      kind: "initial",
      promptId: "prompt:v12",
      status,
      text: "Persisted v12 prompt",
    },
  ],
  responses: [
    {
      eventId: "execution:v12:response:response-v12",
      responseId: "response-v12",
      status: "staged",
      text: "Persisted private response",
    },
  ],
  status,
  workingDirectory: "/tmp/execution-v12",
  worktreeName: "execution-v12",
});

describe("Execution startup recovery v13", () => {
  it.effect(
    "migrates the v13 attachment shape to the v14 recovery singleton",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped("laborer-v14-migration-");
          const seedPath = join(root, "seed.json");
          const statePath = join(root, "application.json");
          const conversationId = ThreadId.make("workspace:T251:C251:0.0");
          yield* Effect.promise(() =>
            writeFile(
              seedPath,
              JSON.stringify({
                actionOperationTombstones: [],
                actionOperations: [],
                conversations: [],
                executionPromptOperations: [],
                executions: [v12Execution(conversationId, "completed")],
                recoveryDecisions: [],
                schemaVersion: 12,
              })
            )
          );
          const seededRepository = yield* makeFileApplicationRepository(
            seedPath,
            root
          );
          const seeded = yield* seededRepository.load;
          const v13 = {
            ...seeded,
            executions: seeded.executions.map((execution) => {
              const { recoveryFailure: _recoveryFailure, ...legacy } =
                execution;
              return legacy;
            }),
            schemaVersion: 13,
          };
          yield* Effect.promise(() =>
            writeFile(statePath, JSON.stringify(v13))
          );

          const repository = yield* makeFileApplicationRepository(
            statePath,
            root
          );
          const migrated = yield* repository.load;
          assert.strictEqual(migrated.schemaVersion, 16);
          assert.strictEqual(migrated.executions[0]?.recoveryFailure, null);
        })
      )
  );

  it.effect(
    "migrates v12 into one ordered Conversation outbox with stable identities",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped("laborer-v13-migration-");
          const statePath = join(root, "application.json");
          const conversationId = ThreadId.make("workspace:T251:C251:1.0");
          yield* Effect.promise(() =>
            writeFile(
              statePath,
              JSON.stringify({
                actionOperationTombstones: [],
                actionOperations: [],
                conversations: [],
                executionPromptOperations: [],
                executions: [v12Execution(conversationId, "failed")],
                recoveryDecisions: [],
                schemaVersion: 12,
              })
            )
          );
          const repository = yield* makeFileApplicationRepository(
            statePath,
            root
          );
          const accepted = yield* Ref.make<readonly string[]>([]);
          const application = yield* makeReferenceCodingApplication({
            conversationAgent: { handle: () => Effect.succeed([]) },
            implementationAgent: ImplementationAgent.of({
              start: () =>
                Effect.die(new Error("terminal work must not start")),
            }),
            repository,
            worktreeManager: WorktreeManager.of({
              create: () =>
                Effect.die(new Error("terminal worktree must not be created")),
            }),
          });

          yield* application.recover?.((event) =>
            Ref.update(accepted, (events) => [...events, event.eventId]).pipe(
              Effect.andThen(acceptedEvent(event))
            )
          ) ?? Effect.void;

          assert.deepStrictEqual(yield* Ref.get(accepted), [
            "execution:v12:response:response-v12",
            "execution:v12:terminal",
          ]);
          const migrated = yield* repository.load;
          assert.strictEqual(migrated.schemaVersion, 16);
          assert.deepStrictEqual(
            migrated.executionEventOutbox.map((item) => ({
              kind: item.recordKind,
              sequence: item.sequence,
              status: item.status,
            })),
            [
              { kind: "response", sequence: 1, status: "enqueued" },
              { kind: "event", sequence: 2, status: "enqueued" },
            ]
          );
          assert.strictEqual(
            new Set(migrated.executionEventOutbox.map((item) => item.outboxId))
              .size,
            2
          );
        })
      )
  );

  it.effect("keeps completed work completed when attachment is ambiguous", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped(
          "laborer-v13-completed-attachment-"
        );
        const statePath = join(root, "application.json");
        const conversationId = ThreadId.make("workspace:T251:C251:2.0");
        const execution = v12Execution(conversationId, "completed");
        execution.events = [];
        execution.responses = [];
        yield* Effect.promise(() =>
          writeFile(
            statePath,
            JSON.stringify({
              actionOperationTombstones: [],
              actionOperations: [],
              conversations: [],
              executionPromptOperations: [],
              executions: [execution],
              recoveryDecisions: [],
              schemaVersion: 12,
            })
          )
        );
        const repository = yield* makeFileApplicationRepository(
          statePath,
          root
        );
        const application = yield* makeReferenceCodingApplication({
          conversationAgent: { handle: () => Effect.succeed([]) },
          implementationAgent: ImplementationAgent.of({
            recover: () =>
              HandlerFailure.make({
                category: "protocol",
                safeDetail: "session admission is unknown",
              }),
            start: () => Effect.die(new Error("completed work must recover")),
          }),
          repository,
          worktreeManager: WorktreeManager.of({
            create: () => Effect.die(new Error("must not create")),
            validate: () => Effect.void,
          }),
        });

        yield* application.recover?.(acceptedEvent) ?? Effect.void;
        const recovered = (yield* repository.load).executions[0];
        assert.strictEqual(recovered?.status, "completed");
        assert.strictEqual(recovered?.attachment?.state, "unresolved");
      })
    )
  );

  it.effect("does not release a persisted queue before recovery finishes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped("laborer-v13-barrier-");
        const runnerPath = join(root, "runner.json");
        const laborerSlackId = "U251LABORER";
        const firstStarted = yield* Deferred.make<void>();
        yield* Effect.scoped(
          Effect.gen(function* () {
            const harness = yield* makePrototypeHarness({
              application: Application.of({
                handle: () =>
                  Deferred.succeed(firstStarted, undefined).pipe(
                    Effect.andThen(Effect.never)
                  ),
              }),
              laborerSlackId,
              slack: {
                postThreadMessage: () => Effect.succeed({ ts: "unused" }),
                readActivationContext: () => Effect.succeed([]),
              },
              storeLayer: makeFileStoreLayer(laborerSlackId, runnerPath, root),
            });
            yield* harness.runner
              .inject(
                normalizedEvent({
                  authorSlackId: "U251HUMAN",
                  channelId: "C251BARRIER",
                  eventId: "event:251:barrier",
                  messageTs: "1.0",
                  text: `<@${laborerSlackId}> recover before continuing`,
                })
              )
              .pipe(Effect.forkChild);
            yield* Deferred.await(firstStarted);
          })
        );

        const recoveryStarted = yield* Deferred.make<void>();
        const releaseRecovery = yield* Deferred.make<void>();
        const handled = yield* Deferred.make<void>();
        const restarted = yield* makePrototypeHarness({
          application: Application.of({
            handle: () => Deferred.succeed(handled, undefined),
            recover: () =>
              Deferred.succeed(recoveryStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseRecovery))
              ),
          }),
          laborerSlackId,
          slack: {
            postThreadMessage: () => Effect.succeed({ ts: "unused" }),
            readActivationContext: () => Effect.succeed([]),
          },
          storeLayer: makeFileStoreLayer(laborerSlackId, runnerPath, root),
        }).pipe(Effect.forkChild);

        yield* Deferred.await(recoveryStarted);
        assert.strictEqual(Option.isNone(yield* Deferred.poll(handled)), true);
        yield* Deferred.succeed(releaseRecovery, undefined);
        yield* Fiber.join(restarted);
        yield* Deferred.await(handled);
      })
    )
  );
});
