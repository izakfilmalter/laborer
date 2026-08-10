import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Ref } from "effect";
import {
  actionInputHash,
  createFeatureAction,
  makeProductionActionCatalog,
  productionActionCatalog,
} from "../src/action-catalog.ts";
import { ExternalInputEvent } from "../src/application.ts";
import { ThreadId } from "../src/core/domain.ts";
import { HandlerFailure } from "../src/core/errors.ts";
import {
  type ActionInvocationAccepted,
  type ConversationAgentRequest,
  ImplementationAgent,
  makeFileApplicationRepository,
  makeReferenceCodingApplication,
  WorktreeManager,
} from "../src/reference-coding-application.ts";
import { makeTempDirectoryScoped } from "./support/temp-directory.ts";

const publishNothing = () => Effect.void;
const acceptEvent = (event: ExternalInputEvent) =>
  Effect.succeed({
    decision: { _tag: "Accepted" as const, eventId: event.eventId },
    scheduling: "Scheduled" as const,
  });

const event = (id: string, source = "test") =>
  ExternalInputEvent.make({
    conversationId: ThreadId.make("workspace:T246:C246:1.0"),
    eventId: id,
    payload: {},
    source,
  });

const ownerScopeDigest = (scope: {
  readonly actionName: "create-feature" | "deal-with-bug";
  readonly catalogFingerprint: string;
  readonly conversationId: string;
  readonly turnId: string;
}): string =>
  createHash("sha256")
    .update("laborer-action-operation-owner-scope-v1\0", "utf8")
    .update(JSON.stringify(scope), "utf8")
    .digest("base64url");

describe("durable Action operation ledger", () => {
  it.live(
    "requires full directory durability at both pre-side-effect boundaries",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          for (const boundary of [
            "worktree_staged",
            "implementation_start_staged",
          ] as const) {
            for (const hookName of [
              "afterRename",
              "beforeDirectorySync",
            ] as const) {
              const root = yield* makeTempDirectoryScoped(
                `laborer-action-durability-${boundary}-${hookName}-`
              );
              const snapshotPath = join(root, "application.json");
              let injectFailure = true;
              const failAtBoundary = async (): Promise<void> => {
                const snapshot = JSON.parse(
                  await readFile(snapshotPath, "utf8")
                ) as {
                  readonly executions?: readonly { readonly status?: string }[];
                };
                if (
                  injectFailure &&
                  snapshot.executions?.some(
                    (execution) => execution.status === boundary
                  )
                ) {
                  injectFailure = false;
                  throw new Error(`injected ${hookName} durability failure`);
                }
              };
              const repository = yield* makeFileApplicationRepository(
                snapshotPath,
                root,
                hookName === "afterRename"
                  ? { afterRename: failAtBoundary }
                  : { beforeDirectorySync: failAtBoundary }
              );
              const input = {
                prompt: `Do not cross ${boundary} without full durability.`,
                title: "Execution task",
                worktreeName: `durability-${boundary}-${hookName}`,
              };
              const inputHash = yield* actionInputHash(
                "create-feature",
                productionActionCatalog.fingerprint,
                input
              );
              const worktreeCreates = yield* Ref.make(0);
              const implementationStarts = yield* Ref.make(0);
              const failures = yield* Ref.make<readonly string[]>([]);
              const retries = yield* Ref.make<
                readonly ActionInvocationAccepted[]
              >([]);
              const application = yield* makeReferenceCodingApplication({
                conversationAgent: {
                  handle: (request) => {
                    const action = request.actions.find(
                      (candidate) => candidate.name === "create-feature"
                    );
                    assert.ok(action);
                    return Effect.result(
                      action.invoke(input, {
                        capabilityExpiresAt: Number.MAX_SAFE_INTEGER,
                        inputHash,
                        operationId: `operation:${boundary}:${hookName}`,
                        schemaFingerprint: productionActionCatalog.fingerprint,
                      })
                    ).pipe(
                      Effect.tap((result) =>
                        result._tag === "Failure"
                          ? Ref.update(failures, (current) => [
                              ...current,
                              result.failure.safeDetail ?? "failure",
                            ])
                          : Ref.update(retries, (current) => [
                              ...current,
                              result.success,
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
                repository,
                worktreeManager: WorktreeManager.of({
                  create: () =>
                    Ref.update(worktreeCreates, (count) => count + 1).pipe(
                      Effect.as({ workingDirectory: root })
                    ),
                }),
              });

              yield* application.handle(
                event(`event:${boundary}:${hookName}`),
                publishNothing,
                acceptEvent
              );
              yield* application.handle(
                event(`event:${boundary}:${hookName}:retry`),
                publishNothing,
                acceptEvent
              );

              assert.deepStrictEqual(yield* Ref.get(failures), [
                "Application state durability is uncertain",
                "Action invocation identity conflicts",
              ]);
              assert.strictEqual((yield* Ref.get(retries)).length, 0);
              assert.strictEqual(
                yield* Ref.get(worktreeCreates),
                boundary === "worktree_staged" ? 0 : 1
              );
              assert.strictEqual(yield* Ref.get(implementationStarts), 0);
              const persisted = JSON.parse(
                yield* Effect.promise(() => readFile(snapshotPath, "utf8"))
              ) as {
                readonly actionOperations: readonly {
                  readonly operationId: string;
                }[];
                readonly executions: readonly {
                  readonly executionId: string;
                  readonly status: string;
                }[];
              };
              assert.strictEqual(persisted.actionOperations.length, 1);
              assert.strictEqual(
                persisted.actionOperations[0]?.operationId,
                `operation:${boundary}:${hookName}`
              );
              assert.strictEqual(persisted.executions[0]?.status, boundary);
            }
          }
        })
      ),
    30_000
  );

  it.effect(
    "deduplicates each trusted Action before and after external effects",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          for (const actionName of [
            "create-feature",
            "deal-with-bug",
          ] as const) {
            yield* Effect.scoped(
              Effect.gen(function* () {
                const input = {
                  prompt: `Run exactly one ${actionName} operation.`,
                  title: "Execution task",
                  worktreeName: `one-${actionName}`,
                };
                const inputHash = yield* actionInputHash(
                  actionName,
                  productionActionCatalog.fingerprint,
                  input
                );
                const worktrees = yield* Ref.make(0);
                const starts = yield* Ref.make(0);
                const results = yield* Ref.make<readonly unknown[]>([]);
                const application = yield* makeReferenceCodingApplication({
                  conversationAgent: {
                    handle: (request: ConversationAgentRequest) => {
                      const action = request.actions.find(
                        (candidate) => candidate.name === actionName
                      );
                      assert.ok(action);
                      return action
                        .invoke(input, {
                          capabilityExpiresAt: Number.MAX_SAFE_INTEGER,
                          inputHash,
                          operationId: `operation:fixed:${actionName}`,
                          schemaFingerprint:
                            productionActionCatalog.fingerprint,
                        })
                        .pipe(
                          Effect.tap((result) =>
                            Ref.update(results, (current) => [
                              ...current,
                              result,
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
                      Ref.update(worktrees, (count) => count + 1).pipe(
                        Effect.as({
                          workingDirectory: `/tmp/one-${actionName}`,
                        })
                      ),
                  }),
                });

                yield* application.handle(
                  event(`event:${actionName}:first`),
                  publishNothing,
                  acceptEvent
                );
                const crossTurnReplay = yield* Effect.result(
                  application.handle(
                    event(`event:${actionName}:duplicate`),
                    publishNothing,
                    acceptEvent
                  )
                );

                assert.strictEqual(yield* Ref.get(worktrees), 1);
                assert.strictEqual(yield* Ref.get(starts), 1);
                const snapshots = yield* Ref.get(results);
                assert.strictEqual(snapshots.length, 1);
                assert.strictEqual(crossTurnReplay._tag, "Failure");
                if (
                  crossTurnReplay._tag === "Failure" &&
                  "safeDetail" in crossTurnReplay.failure
                ) {
                  assert.strictEqual(
                    crossTurnReplay.failure.safeDetail,
                    "Action invocation identity conflicts"
                  );
                }
              })
            );
          }
        })
      )
  );

  it.effect(
    "allows exactly one input to win a concurrent stable-slot race",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-action-slot-race-"
          );
          const snapshotPath = join(root, "application.json");
          const repository = yield* makeFileApplicationRepository(
            snapshotPath,
            root
          );
          const inputA = {
            prompt: "Build input A.",
            title: "Execution task",
            worktreeName: "stable-slot",
          };
          const inputB = {
            prompt: "Build input B.",
            title: "Execution task",
            worktreeName: "stable-slot",
          };
          const [inputHashA, inputHashB] = yield* Effect.all([
            actionInputHash(
              "create-feature",
              productionActionCatalog.fingerprint,
              inputA
            ),
            actionInputHash(
              "create-feature",
              productionActionCatalog.fingerprint,
              inputB
            ),
          ]);
          const outcomes = yield* Ref.make<readonly string[]>([]);
          const worktrees = yield* Ref.make(0);
          const starts = yield* Ref.make(0);
          const application = yield* makeReferenceCodingApplication({
            conversationAgent: {
              handle: (request) => {
                const action = request.actions.find(
                  (candidate) => candidate.name === "create-feature"
                );
                assert.ok(action);
                return Effect.all(
                  [
                    Effect.result(
                      action.invoke(inputA, {
                        capabilityExpiresAt: Number.MAX_SAFE_INTEGER,
                        inputHash: inputHashA,
                        operationId: "operation:stable-turn-slot",
                        schemaFingerprint: productionActionCatalog.fingerprint,
                      })
                    ),
                    Effect.result(
                      action.invoke(inputB, {
                        capabilityExpiresAt: Number.MAX_SAFE_INTEGER,
                        inputHash: inputHashB,
                        operationId: "operation:stable-turn-slot",
                        schemaFingerprint: productionActionCatalog.fingerprint,
                      })
                    ),
                  ],
                  { concurrency: "unbounded" }
                ).pipe(
                  Effect.tap((results) =>
                    Ref.set(
                      outcomes,
                      results.map((result) =>
                        result._tag === "Success"
                          ? "success"
                          : (result.failure.safeDetail ?? "failure")
                      )
                    )
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
            repository,
            worktreeManager: WorktreeManager.of({
              create: () =>
                Ref.update(worktrees, (count) => count + 1).pipe(
                  Effect.as({ workingDirectory: join(root, "worktree") })
                ),
            }),
          });

          yield* application.handle(
            event("event:stable-slot-race"),
            publishNothing,
            acceptEvent
          );

          const observed = yield* Ref.get(outcomes);
          assert.strictEqual(
            observed.filter((outcome) => outcome === "success").length,
            1
          );
          assert.strictEqual(
            observed.filter(
              (outcome) => outcome === "Action invocation identity conflicts"
            ).length,
            1
          );
          assert.strictEqual(yield* Ref.get(worktrees), 1);
          assert.strictEqual(yield* Ref.get(starts), 1);
          const persisted = JSON.parse(
            yield* Effect.promise(() => readFile(snapshotPath, "utf8"))
          ) as {
            readonly actionOperations: readonly {
              readonly inputHash: string;
            }[];
            readonly executions: readonly unknown[];
          };
          assert.strictEqual(persisted.actionOperations.length, 1);
          assert.strictEqual(persisted.executions.length, 1);
          assert.ok(
            persisted.actionOperations[0]?.inputHash === inputHashA ||
              persisted.actionOperations[0]?.inputHash === inputHashB
          );
        })
      )
  );

  it.effect(
    "keeps a running feature isolated from bug identity conflicts and worktree collisions",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-mixed-action-isolation-"
          );
          const snapshotPath = join(root, "application.json");
          const repository = yield* makeFileApplicationRepository(
            snapshotPath,
            root
          );
          const sharedInput = {
            prompt: "Use the same requested worktree without sharing it.",
            title: "Execution task",
            worktreeName: "shared-name",
          };
          const [featureHash, bugHash] = yield* Effect.all([
            actionInputHash(
              "create-feature",
              productionActionCatalog.fingerprint,
              sharedInput
            ),
            actionInputHash(
              "deal-with-bug",
              productionActionCatalog.fingerprint,
              sharedInput
            ),
          ]);
          const outcomes = yield* Ref.make<readonly string[]>([]);
          const conversationTurns = yield* Ref.make(0);
          const worktreeRequests = yield* Ref.make<readonly string[]>([]);
          const implementationStarts = yield* Ref.make<readonly string[]>([]);
          const application = yield* makeReferenceCodingApplication({
            conversationAgent: {
              handle: (request) =>
                Effect.gen(function* () {
                  const turn = yield* Ref.updateAndGet(
                    conversationTurns,
                    (current) => current + 1
                  );
                  const actionName =
                    turn === 1 ? "create-feature" : "deal-with-bug";
                  const action = request.actions.find(
                    (candidate) => candidate.name === actionName
                  );
                  assert.ok(action);
                  const result = yield* Effect.result(
                    action.invoke(sharedInput, {
                      capabilityExpiresAt: Number.MAX_SAFE_INTEGER,
                      inputHash:
                        actionName === "create-feature" ? featureHash : bugHash,
                      operationId:
                        turn <= 2
                          ? "operation:mixed-feature"
                          : "operation:mixed-deal-with-bug",
                      schemaFingerprint: productionActionCatalog.fingerprint,
                    })
                  );
                  yield* Ref.update(outcomes, (current) => [
                    ...current,
                    result._tag === "Success"
                      ? `${result.success.actionName}:${result.success.status}`
                      : (result.failure.safeDetail ?? "failure"),
                  ]);
                  return [] as const;
                }),
            },
            implementationAgent: ImplementationAgent.of({
              start: (request) =>
                Ref.update(implementationStarts, (current) => [
                  ...current,
                  request.actionName,
                ]).pipe(
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
                Ref.update(worktreeRequests, (current) => [
                  ...current,
                  request.executionId,
                ]).pipe(
                  Effect.flatMap(() =>
                    request.operationId === "operation:mixed-deal-with-bug"
                      ? HandlerFailure.make({
                          category: "protocol",
                          safeDetail: "worktree name already exists",
                        })
                      : Effect.succeed({
                          workingDirectory: join(root, "feature-worktree"),
                        })
                  )
                ),
            }),
          });

          yield* application.handle(
            event("event:mixed:feature", "feature"),
            publishNothing,
            acceptEvent
          );
          yield* application.handle(
            event("event:mixed:conflict", "conflict"),
            publishNothing,
            acceptEvent
          );
          yield* application.handle(
            event("event:mixed:collision", "collision"),
            publishNothing,
            acceptEvent
          );

          assert.deepStrictEqual(yield* Ref.get(outcomes), [
            "create-feature:running",
            "Action invocation identity conflicts",
            "worktree name already exists",
          ]);
          assert.strictEqual((yield* Ref.get(worktreeRequests)).length, 2);
          assert.deepStrictEqual(yield* Ref.get(implementationStarts), [
            "create-feature",
          ]);
          const persisted = JSON.parse(
            yield* Effect.promise(() => readFile(snapshotPath, "utf8"))
          ) as {
            readonly actionOperations: readonly {
              readonly actionName: string;
              readonly operationId: string;
            }[];
            readonly executions: readonly {
              readonly actionName: string;
              readonly status: string;
              readonly worktreeName: string;
            }[];
          };
          assert.deepStrictEqual(
            persisted.actionOperations.map(({ actionName, operationId }) => ({
              actionName,
              operationId,
            })),
            [
              {
                actionName: "create-feature",
                operationId: "operation:mixed-feature",
              },
            ]
          );
          assert.strictEqual(persisted.executions.length, 1);
          assert.strictEqual(
            persisted.executions[0]?.actionName,
            "create-feature"
          );
          assert.strictEqual(persisted.executions[0]?.status, "running");
          assert.strictEqual(
            persisted.executions[0]?.worktreeName,
            "shared-name"
          );
        })
      )
  );

  it.effect("fails closed when v7 state duplicates an operation identity", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped(
          "laborer-action-duplicate-slot-"
        );
        const snapshotPath = join(root, "application.json");
        const operation = {
          actionName: "create-feature",
          catalogFingerprint: productionActionCatalog.fingerprint,
          conversationId: "workspace:T246:C246:1.0",
          createdAt: 1,
          executionId: null,
          failureCode: "conflict",
          inputHash: "input-a",
          operationId: "operation:duplicate-stable-slot",
          state: "failed",
          terminalEventId: null,
          updatedAt: 1,
        } as const;
        yield* Effect.promise(() =>
          writeFile(
            snapshotPath,
            JSON.stringify({
              actionOperations: [
                operation,
                { ...operation, inputHash: "input-b" },
              ],
              conversations: [],
              executions: [],
              schemaVersion: 7,
            }),
            { mode: 0o600 }
          )
        );
        const repository = yield* Effect.exit(
          makeFileApplicationRepository(snapshotPath, root)
        );
        assert.strictEqual(repository._tag, "Failure");
      })
    )
  );

  it.effect(
    "migrates v6 operation metadata without changing Execution IDs",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-action-v6-operation-migration-"
          );
          const snapshotPath = join(root, "application.json");
          yield* Effect.promise(() =>
            writeFile(
              snapshotPath,
              JSON.stringify({
                conversations: [],
                executions: [
                  {
                    actionInvocationId: "legacy-action-invocation",
                    actionName: "create-feature",
                    conversationId: "workspace:T246:C246:1.0",
                    events: [],
                    executionId: "legacy-execution-must-remain",
                    implementationSessionId: "legacy-implementation-session",
                    prompts: [
                      {
                        kind: "initial",
                        promptId: "legacy-implementation-prompt",
                        status: "completed",
                        text: "Legacy implementation input.",
                      },
                    ],
                    responses: [],
                    status: "completed",
                    workingDirectory: root,
                    worktreeName: "legacy-worktree",
                  },
                ],
                schemaVersion: 6,
              }),
              { mode: 0o600 }
            )
          );
          yield* makeFileApplicationRepository(snapshotPath, root);
          const migrated = JSON.parse(
            yield* Effect.promise(() => readFile(snapshotPath, "utf8"))
          ) as {
            readonly actionOperations: readonly {
              readonly executionId: string | null;
              readonly inputHash: string;
            }[];
            readonly executions: readonly { readonly executionId: string }[];
            readonly schemaVersion: number;
          };
          assert.strictEqual(migrated.schemaVersion, 16);
          assert.strictEqual(
            migrated.executions[0]?.executionId,
            "legacy-execution-must-remain"
          );
          assert.strictEqual(
            migrated.actionOperations[0]?.executionId,
            "legacy-execution-must-remain"
          );
          assert.ok(migrated.actionOperations[0]?.inputHash);
        })
      )
  );

  it.effect(
    "recovers an in-flight feature snapshot without rewriting its old catalog identity",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-old-catalog-feature-recovery-"
          );
          const snapshotPath = join(root, "application.json");
          const input = {
            prompt:
              "Keep this in-flight feature unchanged across catalog growth.",
            title: "Execution task",
            worktreeName: "old-catalog-feature",
          };
          const inputHash = yield* actionInputHash(
            "create-feature",
            productionActionCatalog.fingerprint,
            input
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              const repository = yield* makeFileApplicationRepository(
                snapshotPath,
                root
              );
              const application = yield* makeReferenceCodingApplication({
                conversationAgent: {
                  handle: (request) => {
                    const action = request.actions.find(
                      (candidate) => candidate.name === "create-feature"
                    );
                    assert.ok(action);
                    return action
                      .invoke(input, {
                        capabilityExpiresAt: Number.MAX_SAFE_INTEGER,
                        inputHash,
                        operationId: "operation:old-catalog-feature",
                        schemaFingerprint: productionActionCatalog.fingerprint,
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
                      workingDirectory: join(root, "old-catalog-worktree"),
                    }),
                }),
              });
              yield* application.handle(
                event("event:old-catalog:start"),
                publishNothing,
                acceptEvent
              );
            })
          );

          const oldCatalogFingerprint = "old-catalog-fingerprint-before-bug";
          const oldInputHash = "old-feature-input-hash-before-bug";
          const oldState = JSON.parse(
            yield* Effect.promise(() => readFile(snapshotPath, "utf8"))
          ) as {
            actionOperations: {
              catalogFingerprint: string;
              inputHash: string;
              operationId: string;
            }[];
            executions: {
              actionName: string;
              executionId: string;
              implementationSessionId: string;
              status: string;
              workingDirectory: string;
              worktreeName: string;
            }[];
          };
          assert.ok(oldState.actionOperations[0]);
          oldState.actionOperations[0].catalogFingerprint =
            oldCatalogFingerprint;
          oldState.actionOperations[0].inputHash = oldInputHash;
          yield* Effect.promise(() =>
            writeFile(snapshotPath, JSON.stringify(oldState), { mode: 0o600 })
          );
          const executionBeforeRecovery = oldState.executions[0];
          assert.ok(executionBeforeRecovery);
          const recoveries = yield* Ref.make(0);
          const repository = yield* makeFileApplicationRepository(
            snapshotPath,
            root
          );
          const recoveredApplication = yield* makeReferenceCodingApplication({
            conversationAgent: {
              handle: () => Effect.succeed([]),
            },
            implementationAgent: ImplementationAgent.of({
              recover: (request) =>
                Ref.update(recoveries, (count) => count + 1).pipe(
                  Effect.as({
                    completion: Effect.never,
                    resume: () => Effect.void,
                    sessionId: request.implementationSessionId,
                  })
                ),
              start: () =>
                Effect.die(
                  new Error("old in-flight feature must recover, not restart")
                ),
            }),
            repository,
            worktreeManager: WorktreeManager.of({
              create: () =>
                Effect.die(
                  new Error("old in-flight feature must not recreate worktree")
                ),
            }),
          });
          assert.ok(recoveredApplication.recover);
          yield* recoveredApplication.recover(acceptEvent);
          for (
            let attempt = 0;
            attempt < 100 && (yield* Ref.get(recoveries)) === 0;
            attempt += 1
          ) {
            yield* Effect.sleep("5 millis");
          }
          assert.strictEqual(yield* Ref.get(recoveries), 1);
          const afterRecovery = JSON.parse(
            yield* Effect.promise(() => readFile(snapshotPath, "utf8"))
          ) as typeof oldState;
          assert.deepStrictEqual(afterRecovery.actionOperations[0], {
            ...oldState.actionOperations[0],
            catalogFingerprint: oldCatalogFingerprint,
            inputHash: oldInputHash,
          });
          const normalizedExecution = {
            ...(afterRecovery.executions[0] as Record<string, unknown>),
            attachment: (
              executionBeforeRecovery as typeof executionBeforeRecovery & {
                readonly attachment?: unknown;
              }
            ).attachment,
          };
          assert.deepStrictEqual(
            normalizedExecution as unknown,
            executionBeforeRecovery as unknown
          );
        })
      )
  );

  it.effect(
    "returns the same operation after repository restart without replaying effects",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-action-restart-"
          );
          const snapshotPath = join(root, "application.json");
          const input = {
            prompt: "Persist this operation before restart.",
            title: "Execution task",
            worktreeName: "restart-safe",
          };
          const inputHash = yield* actionInputHash(
            "create-feature",
            productionActionCatalog.fingerprint,
            input
          );
          const invocation = {
            capabilityExpiresAt: Number.MAX_SAFE_INTEGER,
            inputHash,
            operationId: "operation:restart-246",
            schemaFingerprint: productionActionCatalog.fingerprint,
          };
          const firstWorktrees = yield* Ref.make(0);
          const firstStarts = yield* Ref.make(0);
          yield* Effect.scoped(
            Effect.gen(function* () {
              const repository = yield* makeFileApplicationRepository(
                snapshotPath,
                root
              );
              const application = yield* makeReferenceCodingApplication({
                conversationAgent: {
                  handle: (request) => {
                    const action = request.actions.find(
                      (candidate) => candidate.name === "create-feature"
                    );
                    assert.ok(action);
                    return action
                      .invoke(input, invocation)
                      .pipe(Effect.as([] as const));
                  },
                },
                implementationAgent: ImplementationAgent.of({
                  start: (request) =>
                    Ref.update(firstStarts, (count) => count + 1).pipe(
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
                    Ref.update(firstWorktrees, (count) => count + 1).pipe(
                      Effect.as({ workingDirectory: root })
                    ),
                }),
              });
              yield* application.handle(
                event("event:restart:first"),
                publishNothing,
                acceptEvent
              );
            })
          );

          const replayWorktrees = yield* Ref.make(0);
          const replayStarts = yield* Ref.make(0);
          const replayResults = yield* Ref.make<
            readonly ActionInvocationAccepted[]
          >([]);
          const repository = yield* makeFileApplicationRepository(
            snapshotPath,
            root
          );
          const restarted = yield* makeReferenceCodingApplication({
            conversationAgent: {
              handle: (request) => {
                const action = request.actions.find(
                  (candidate) => candidate.name === "create-feature"
                );
                assert.ok(action);
                return action.invoke(input, invocation).pipe(
                  Effect.tap((result) =>
                    Ref.update(replayResults, (current) => [...current, result])
                  ),
                  Effect.as([] as const)
                );
              },
            },
            implementationAgent: ImplementationAgent.of({
              start: (request) =>
                Ref.update(replayStarts, (count) => count + 1).pipe(
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
                Ref.update(replayWorktrees, (count) => count + 1).pipe(
                  Effect.as({ workingDirectory: root })
                ),
            }),
          });
          const replay = yield* Effect.result(
            restarted.handle(
              event("event:restart:duplicate"),
              publishNothing,
              acceptEvent
            )
          );

          assert.strictEqual(yield* Ref.get(firstWorktrees), 1);
          assert.strictEqual(yield* Ref.get(firstStarts), 1);
          assert.strictEqual(yield* Ref.get(replayWorktrees), 0);
          assert.strictEqual(yield* Ref.get(replayStarts), 0);
          assert.strictEqual((yield* Ref.get(replayResults)).length, 0);
          assert.strictEqual(replay._tag, "Failure");
        })
      )
  );

  it.effect(
    "persists a definite worktree collision without a visible Execution",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-action-collision-"
          );
          const snapshotPath = join(root, "application.json");
          const repository = yield* makeFileApplicationRepository(
            snapshotPath,
            root
          );
          const input = {
            prompt: "Do not adopt the colliding worktree.",
            title: "Execution task",
            worktreeName: "already-owned",
          };
          const inputHash = yield* actionInputHash(
            "create-feature",
            productionActionCatalog.fingerprint,
            input
          );
          const observedExecutionCounts = yield* Ref.make<readonly number[]>(
            []
          );
          const failures = yield* Ref.make<readonly string[]>([]);
          const implementationStarts = yield* Ref.make(0);
          const application = yield* makeReferenceCodingApplication({
            conversationAgent: {
              handle: (request) => {
                if (request.source === "inspect") {
                  return Ref.update(observedExecutionCounts, (current) => [
                    ...current,
                    request.executions.length,
                  ]).pipe(Effect.as([] as const));
                }
                const action = request.actions.find(
                  (candidate) => candidate.name === "create-feature"
                );
                assert.ok(action);
                return Effect.result(
                  action.invoke(input, {
                    capabilityExpiresAt: Number.MAX_SAFE_INTEGER,
                    inputHash,
                    operationId: "operation:collision-246",
                    schemaFingerprint: productionActionCatalog.fingerprint,
                  })
                ).pipe(
                  Effect.tap((result) =>
                    Ref.update(failures, (current) => [
                      ...current,
                      result._tag === "Failure"
                        ? (result.failure.safeDetail ?? "failure")
                        : "unexpected-success",
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
            repository,
            worktreeManager: WorktreeManager.of({
              create: () =>
                HandlerFailure.make({
                  category: "protocol",
                  safeDetail: "worktree name already exists",
                }),
            }),
          });

          yield* application.handle(
            event("event:collision"),
            publishNothing,
            acceptEvent
          );
          yield* application.handle(
            event("event:collision-duplicate"),
            publishNothing,
            acceptEvent
          );
          yield* application.handle(
            event("event:inspect", "inspect"),
            publishNothing,
            acceptEvent
          );

          assert.deepStrictEqual(yield* Ref.get(failures), [
            "worktree name already exists",
            "Action invocation identity conflicts",
          ]);
          assert.deepStrictEqual(yield* Ref.get(observedExecutionCounts), [0]);
          assert.strictEqual(yield* Ref.get(implementationStarts), 0);
          const persisted = JSON.parse(
            yield* Effect.promise(() => readFile(snapshotPath, "utf8"))
          ) as {
            readonly actionOperationTombstones: readonly {
              readonly failureCode: string;
              readonly state: string;
            }[];
            readonly actionOperations: readonly unknown[];
            readonly executions: readonly unknown[];
            readonly schemaVersion: number;
          };
          assert.strictEqual(persisted.schemaVersion, 16);
          assert.strictEqual(persisted.executions.length, 0);
          assert.strictEqual(persisted.actionOperations.length, 0);
          assert.strictEqual(persisted.actionOperationTombstones.length, 1);
          assert.strictEqual(
            persisted.actionOperationTombstones[0]?.failureCode,
            "worktree-name-collision"
          );
          assert.strictEqual(
            persisted.actionOperationTombstones[0]?.state,
            "failed"
          );
        })
      )
  );

  it.live(
    "protects a recoverable failed-operation tombstone through pressure and compacts it only when unreachable",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-failed-action-tombstone-retention-"
          );
          const snapshotPath = join(root, "application.json");
          const originalOperationId = "operation:protected-failure-246";
          const originalEvent = event("event:protected-failure-246");
          const originalInput = {
            prompt: "Retain this failed operation while its turn can recover.",
            title: "Execution task",
            worktreeName: "protected-failure",
          };
          const changedInput = {
            ...originalInput,
            prompt: "Do not reuse this operation for changed input.",
          };
          const capabilityExpiresAt = Date.now() + 60_000;
          const worktreeCreates = yield* Ref.make(0);
          const implementationStarts = yield* Ref.make(0);
          const outcomes = yield* Ref.make<readonly string[]>([]);

          const runAttempt = (
            operationId: string,
            invocationEvent: ExternalInputEvent,
            input: typeof originalInput,
            expiresAt: number
          ) =>
            Effect.scoped(
              Effect.gen(function* () {
                const repository = yield* makeFileApplicationRepository(
                  snapshotPath,
                  root
                );
                const inputHash = yield* actionInputHash(
                  "create-feature",
                  productionActionCatalog.fingerprint,
                  input
                );
                const invoke = (request: ConversationAgentRequest) => {
                  const action = request.actions.find(
                    (candidate) => candidate.name === "create-feature"
                  );
                  assert.ok(action);
                  return Effect.result(
                    action.invoke(input, {
                      capabilityExpiresAt: expiresAt,
                      inputHash,
                      operationId,
                      schemaFingerprint: productionActionCatalog.fingerprint,
                    })
                  ).pipe(
                    Effect.tap((result) =>
                      Ref.update(outcomes, (current) => [
                        ...current,
                        result._tag === "Failure"
                          ? (result.failure.safeDetail ?? "failure")
                          : "unexpected-success",
                      ])
                    ),
                    Effect.flatMap(() =>
                      HandlerFailure.make({
                        category: "protocol",
                        safeDetail: "keep owner turn recoverable",
                      })
                    )
                  );
                };
                const application = yield* makeReferenceCodingApplication({
                  conversationAgent: { handle: invoke, recover: invoke },
                  implementationAgent: ImplementationAgent.of({
                    start: (request) =>
                      Ref.update(
                        implementationStarts,
                        (count) => count + 1
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
                    create: () =>
                      Ref.update(worktreeCreates, (count) => count + 1).pipe(
                        Effect.flatMap(() =>
                          HandlerFailure.make({
                            category: "protocol",
                            safeDetail: "worktree name already exists",
                          })
                        )
                      ),
                  }),
                });
                yield* Effect.result(
                  application.handle(
                    invocationEvent,
                    publishNothing,
                    acceptEvent
                  )
                );
              })
            );

          yield* runAttempt(
            originalOperationId,
            originalEvent,
            originalInput,
            capabilityExpiresAt
          );
          const afterFailure = JSON.parse(
            yield* Effect.promise(() => readFile(snapshotPath, "utf8"))
          ) as {
            actionOperationTombstones: Record<string, unknown>[];
            conversations: {
              agentSessionBinding: unknown;
              conversationId: string;
              prompts: {
                fingerprint: string;
                promptId: string;
                replies: unknown[];
                status: string;
              }[];
              sessionId: string;
            }[];
          };
          const originalTombstone = afterFailure.actionOperationTombstones[0];
          const ownerConversation = afterFailure.conversations[0];
          assert.ok(originalTombstone);
          assert.ok(ownerConversation);
          assert.deepStrictEqual(Object.keys(originalTombstone).sort(), [
            "actionName",
            "catalogFingerprint",
            "conversationId",
            "failureCode",
            "identityVersion",
            "inputHash",
            "operationId",
            "ownerScopeDigest",
            "retentionExpiresAt",
            "state",
            "terminalAt",
            "turnId",
          ]);
          const terminalBase = Date.now() + 10_000;
          const subsequentPrompts = Array.from(
            { length: 1025 },
            (_, index) => ({
              fingerprint: `terminal-fingerprint-${index}`,
              promptId: `terminal-prompt-${index}`,
              replies: [],
              status: "completed",
            })
          );
          yield* Effect.promise(() =>
            writeFile(
              snapshotPath,
              JSON.stringify({
                ...afterFailure,
                actionOperationTombstones: [
                  originalTombstone,
                  ...subsequentPrompts.map((prompt, index) => ({
                    actionName: "create-feature",
                    catalogFingerprint: productionActionCatalog.fingerprint,
                    conversationId: ownerConversation.conversationId,
                    failureCode: "historical-terminal-failure",
                    identityVersion: "action-operation-v2",
                    inputHash: `terminal-input-${index}`,
                    operationId: `terminal-operation-${index}`,
                    ownerScopeDigest: ownerScopeDigest({
                      actionName: "create-feature",
                      catalogFingerprint: productionActionCatalog.fingerprint,
                      conversationId: ownerConversation.conversationId,
                      turnId: prompt.promptId,
                    }),
                    retentionExpiresAt: 0,
                    state: "failed",
                    terminalAt: terminalBase + index,
                    turnId: prompt.promptId,
                  })),
                ],
                conversations: [
                  {
                    ...ownerConversation,
                    prompts: [
                      ...ownerConversation.prompts,
                      ...subsequentPrompts,
                    ],
                  },
                ],
              })
            )
          );

          yield* runAttempt(
            originalOperationId,
            originalEvent,
            originalInput,
            capabilityExpiresAt
          );
          yield* runAttempt(
            originalOperationId,
            originalEvent,
            changedInput,
            capabilityExpiresAt
          );
          assert.deepStrictEqual(yield* Ref.get(outcomes), [
            "worktree name already exists",
            "Action operation previously failed",
            "Action invocation identity conflicts",
          ]);
          assert.strictEqual(yield* Ref.get(worktreeCreates), 1);
          assert.strictEqual(yield* Ref.get(implementationStarts), 0);

          const oldCatalogFingerprint = makeProductionActionCatalog([
            createFeatureAction,
          ]).fingerprint;
          assert.notStrictEqual(
            oldCatalogFingerprint,
            productionActionCatalog.fingerprint
          );
          const oldCatalogInputHash = yield* actionInputHash(
            "create-feature",
            oldCatalogFingerprint,
            originalInput
          );
          const activeOldCatalogState = JSON.parse(
            yield* Effect.promise(() => readFile(snapshotPath, "utf8"))
          ) as typeof afterFailure;
          const activeOldCatalogTombstone =
            activeOldCatalogState.actionOperationTombstones.find(
              (candidate) => candidate.operationId === originalOperationId
            );
          assert.ok(activeOldCatalogTombstone);
          const ownerTurnId = activeOldCatalogTombstone.turnId;
          assert.strictEqual(typeof ownerTurnId, "string");
          activeOldCatalogTombstone.catalogFingerprint = oldCatalogFingerprint;
          activeOldCatalogTombstone.inputHash = oldCatalogInputHash;
          activeOldCatalogTombstone.ownerScopeDigest = ownerScopeDigest({
            actionName: "create-feature",
            catalogFingerprint: oldCatalogFingerprint,
            conversationId: ownerConversation.conversationId,
            turnId: ownerTurnId as string,
          });
          activeOldCatalogTombstone.retentionExpiresAt = 0;
          yield* Effect.promise(() =>
            writeFile(snapshotPath, JSON.stringify(activeOldCatalogState))
          );

          yield* runAttempt(
            "operation:active-owner-compaction",
            event("event:active-owner-compaction"),
            {
              prompt: "Do not compact an old-catalog active owner.",
              title: "Execution task",
              worktreeName: "active-owner-compaction",
            },
            Number.MAX_SAFE_INTEGER
          );
          const whileOwnerActive = JSON.parse(
            yield* Effect.promise(() => readFile(snapshotPath, "utf8"))
          ) as {
            readonly actionOperationTombstones: readonly {
              readonly operationId: string;
            }[];
          };
          assert.ok(
            whileOwnerActive.actionOperationTombstones.some(
              ({ operationId }) => operationId === originalOperationId
            )
          );

          const terminalized = JSON.parse(
            yield* Effect.promise(() => readFile(snapshotPath, "utf8"))
          ) as typeof afterFailure;
          terminalized.conversations[0]?.prompts.splice(0, 1, {
            ...(terminalized.conversations[0]?.prompts[0] ?? {
              fingerprint: "missing",
              promptId: "missing",
              replies: [],
            }),
            status: "completed",
          });
          terminalized.actionOperationTombstones =
            terminalized.actionOperationTombstones.map((tombstone) =>
              tombstone.operationId === originalOperationId
                ? {
                    ...tombstone,
                    retentionExpiresAt: capabilityExpiresAt,
                  }
                : tombstone
            );
          yield* Effect.promise(() =>
            writeFile(snapshotPath, JSON.stringify(terminalized))
          );

          yield* runAttempt(
            "operation:pre-expiry-compaction",
            event("event:pre-expiry-compaction"),
            {
              prompt: "Compact only unreachable history before expiry.",
              title: "Execution task",
              worktreeName: "pre-expiry-compaction",
            },
            Number.MAX_SAFE_INTEGER
          );
          const beforeExpiry = JSON.parse(
            yield* Effect.promise(() => readFile(snapshotPath, "utf8"))
          ) as {
            readonly actionOperationTombstones: readonly {
              readonly operationId: string;
            }[];
          };
          assert.ok(
            beforeExpiry.actionOperationTombstones.some(
              ({ operationId }) => operationId === originalOperationId
            )
          );

          const expiredCapabilityEvidence = JSON.parse(
            yield* Effect.promise(() => readFile(snapshotPath, "utf8"))
          ) as {
            actionOperationTombstones: {
              operationId: string;
              retentionExpiresAt: number;
            }[];
          };
          expiredCapabilityEvidence.actionOperationTombstones =
            expiredCapabilityEvidence.actionOperationTombstones.map(
              (tombstone) =>
                tombstone.operationId === originalOperationId
                  ? { ...tombstone, retentionExpiresAt: 0 }
                  : tombstone
            );
          yield* Effect.promise(() =>
            writeFile(snapshotPath, JSON.stringify(expiredCapabilityEvidence))
          );
          yield* runAttempt(
            "operation:post-expiry-compaction",
            event("event:post-expiry-compaction"),
            {
              prompt: "Compact the now-unreachable failed identity.",
              title: "Execution task",
              worktreeName: "post-expiry-compaction",
            },
            Number.MAX_SAFE_INTEGER
          );
          const afterExpiry = JSON.parse(
            yield* Effect.promise(() => readFile(snapshotPath, "utf8"))
          ) as {
            readonly actionOperationTombstones: readonly {
              readonly operationId: string;
            }[];
          };
          assert.ok(
            !afterExpiry.actionOperationTombstones.some(
              ({ operationId }) => operationId === originalOperationId
            )
          );
          assert.ok(afterExpiry.actionOperationTombstones.length <= 1024);
          yield* makeFileApplicationRepository(snapshotPath, root);
          const afterRestart = JSON.parse(
            yield* Effect.promise(() => readFile(snapshotPath, "utf8"))
          ) as typeof afterExpiry;
          assert.ok(
            !afterRestart.actionOperationTombstones.some(
              ({ operationId }) => operationId === originalOperationId
            )
          );
        })
      ),
    60_000
  );

  it.effect(
    "fails allocation closed when protected tombstones fill bounds",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-protected-action-tombstone-capacity-"
          );
          const snapshotPath = join(root, "application.json");
          yield* Effect.promise(() =>
            writeFile(
              snapshotPath,
              JSON.stringify({
                actionOperationTombstones: Array.from(
                  { length: 1024 },
                  (_, index) => ({
                    failureCode: "legacy-protected",
                    identityVersion: "legacy-v7",
                    inputHash: `legacy-input-${index}`,
                    operationId: `legacy-operation-${index}`,
                    ownerScopeDigest: `legacy-scope-${index}`,
                    retentionExpiresAt: Number.MAX_SAFE_INTEGER,
                    state: "failed",
                    terminalAt: index,
                  })
                ),
                actionOperations: [],
                conversations: [],
                executions: [],
                schemaVersion: 8,
              })
            )
          );
          const repository = yield* makeFileApplicationRepository(
            snapshotPath,
            root
          );
          const worktrees = yield* Ref.make(0);
          const failures = yield* Ref.make<readonly string[]>([]);
          const input = {
            prompt: "This allocation must fail before effects.",
            title: "Execution task",
            worktreeName: "capacity-closed",
          };
          const inputHash = yield* actionInputHash(
            "create-feature",
            productionActionCatalog.fingerprint,
            input
          );
          const application = yield* makeReferenceCodingApplication({
            conversationAgent: {
              handle: (request) => {
                const action = request.actions.find(
                  (candidate) => candidate.name === "create-feature"
                );
                assert.ok(action);
                return Effect.result(
                  action.invoke(input, {
                    capabilityExpiresAt: Number.MAX_SAFE_INTEGER,
                    inputHash,
                    operationId: "operation:capacity-closed",
                    schemaFingerprint: productionActionCatalog.fingerprint,
                  })
                ).pipe(
                  Effect.tap((result) =>
                    Ref.set(failures, [
                      result._tag === "Failure"
                        ? (result.failure.safeDetail ?? "failure")
                        : "unexpected-success",
                    ])
                  ),
                  Effect.as([] as const)
                );
              },
            },
            implementationAgent: ImplementationAgent.of({
              start: () =>
                HandlerFailure.make({
                  category: "protocol",
                  safeDetail: "must not start",
                }),
            }),
            repository,
            worktreeManager: WorktreeManager.of({
              create: () =>
                Ref.update(worktrees, (count) => count + 1).pipe(
                  Effect.as({ workingDirectory: root })
                ),
            }),
          });
          yield* application.handle(
            event("event:capacity-closed"),
            publishNothing,
            acceptEvent
          );
          assert.deepStrictEqual(yield* Ref.get(failures), [
            "Action operation ledger capacity exceeded",
          ]);
          assert.strictEqual(yield* Ref.get(worktrees), 0);
        })
      )
  );

  it.live(
    "accepts new operations beyond the old lifetime ceiling and compacts terminal history",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-action-ledger-retention-"
          );
          const snapshotPath = join(root, "application.json");
          const historicalOperationCount = 1100;
          yield* Effect.promise(() =>
            writeFile(
              snapshotPath,
              JSON.stringify({
                actionOperations: Array.from(
                  { length: historicalOperationCount },
                  (_, index) => ({
                    actionName: "create-feature",
                    catalogFingerprint: productionActionCatalog.fingerprint,
                    conversationId: "workspace:T246:C246:1.0",
                    createdAt: index,
                    executionId: `historical-execution-${index}`,
                    failureCode: null,
                    inputHash: `historical-input-${index}`,
                    operationId: `historical-operation-${index}`,
                    state: "completed",
                    terminalEventId: `historical-execution-${index}:terminal`,
                    updatedAt: index,
                  })
                ),
                conversations: [],
                executions: [],
                schemaVersion: 7,
              })
            )
          );
          const repository = yield* makeFileApplicationRepository(
            snapshotPath,
            root
          );
          const input = {
            prompt: "Allocate after more than 1,024 terminal operations.",
            title: "Execution task",
            worktreeName: "after-ledger-retention",
          };
          const inputHash = yield* actionInputHash(
            "create-feature",
            productionActionCatalog.fingerprint,
            input
          );
          const starts = yield* Ref.make(0);
          const application = yield* makeReferenceCodingApplication({
            conversationAgent: {
              handle: (request) => {
                const action = request.actions.find(
                  (candidate) => candidate.name === "create-feature"
                );
                assert.ok(action);
                return action
                  .invoke(input, {
                    capabilityExpiresAt: Number.MAX_SAFE_INTEGER,
                    inputHash,
                    operationId: "operation:after-retention",
                    schemaFingerprint: productionActionCatalog.fingerprint,
                  })
                  .pipe(Effect.as([] as const));
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
            repository,
            worktreeManager: WorktreeManager.of({
              create: () =>
                Effect.succeed({ workingDirectory: join(root, "worktree") }),
            }),
          });

          yield* application.handle(
            event("event:after-retention"),
            publishNothing,
            acceptEvent
          );

          assert.strictEqual(yield* Ref.get(starts), 1);
          const persisted = JSON.parse(
            yield* Effect.promise(() => readFile(snapshotPath, "utf8"))
          ) as {
            readonly actionOperations: readonly {
              readonly operationId: string;
            }[];
          };
          assert.ok(persisted.actionOperations.length <= 1024);
          assert.ok(
            persisted.actionOperations.some(
              ({ operationId }) => operationId === "operation:after-retention"
            )
          );
          assert.ok(
            !persisted.actionOperations.some(
              ({ operationId }) => operationId === "historical-operation-0"
            )
          );
        })
      ),
    30_000
  );
});
