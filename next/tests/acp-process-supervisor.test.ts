import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { makeAcpProcessStateRepository } from "../src/acp-runtime/acp-process-state.ts";
import type { AcpGenerationContext } from "../src/acp-runtime/acp-process-supervisor.ts";
import { makeAcpConversationProcessSupervisor } from "../src/acp-runtime/acp-process-supervisor.ts";
import { HandlerFailure } from "../src/core/errors.ts";
import type { ConversationAgentShape } from "../src/reference-coding-application.ts";
import { makeTempDirectoryScoped } from "./support/temp-directory.ts";

const idleAgent: ConversationAgentShape = {
  handle: () => Effect.succeed([]),
};

const request = (conversationId: string) => ({
  actions: [],
  context: [],
  conversationId,
  conversationSessionId: `session:${conversationId}`,
  conversationSessionIsNew: true,
  executionControls: [],
  executions: [],
  input: conversationId,
  messages: [],
  promptId: `prompt:${conversationId}`,
  source: "slack" as const,
  turnId: `turn:${conversationId}`,
});

const waitFor = (predicate: () => boolean): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (predicate()) {
        return;
      }
      yield* Effect.promise(
        () => new Promise<void>((resolve) => setTimeout(resolve, 2))
      );
    }
    return yield* Effect.die(new Error("condition was not observed"));
  });

const processIsRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const stopTestChild = (
  child: ChildProcess,
  observeFinalizer: () => void
): Effect.Effect<void> =>
  Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        observeFinalizer();
        let settled = false;
        const settle = (): void => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeout);
          child.off("error", settle);
          child.off("exit", settle);
          resolve();
        };
        const timeout = setTimeout(settle, 1000);
        child.once("error", settle);
        child.once("exit", settle);
        if (child.exitCode !== null || child.signalCode !== null) {
          settle();
          return;
        }
        child.kill("SIGKILL");
      })
  );

describe("issue #252 ACP process supervisor", () => {
  it.effect(
    "restarts an idle generation without reusing its durable number",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped("acp-supervisor-");
          const repository = yield* makeAcpProcessStateRepository({
            path: join(root, "acp-process-state.json"),
            trustedRoot: root,
          });
          const generations: AcpGenerationContext[] = [];
          const supervisor = yield* makeAcpConversationProcessSupervisor({
            jitter: () => 0,
            makeGeneration: (context) =>
              Effect.sync(() => {
                generations.push(context);
                context.observeHealth({
                  generation: context.generation,
                  status: "ready",
                });
                return idleAgent;
              }),
            repository,
            workspaceId: "workspace-a",
          });
          yield* waitFor(() => generations.length === 1);
          assert.strictEqual((yield* supervisor.health).generation, 1);
          yield* supervisor.agent.handle({
            actions: [],
            context: [],
            conversationId: "conversation-a",
            conversationSessionId: "session-a",
            conversationSessionIsNew: true,
            executionControls: [],
            executions: [],
            input: "hello",
            messages: [],
            promptId: "prompt-a",
            source: "slack",
            turnId: "turn-a",
          });
          assert.strictEqual((yield* supervisor.health).activeSessions, 1);

          generations[0]?.observeExit({ code: 17, signal: null });
          generations[0]?.observeHealth({ generation: 1, status: "closed" });
          yield* TestClock.adjust("1 millis");
          yield* waitFor(() => generations.length === 2);
          assert.deepStrictEqual(
            generations.map(({ generation }) => generation),
            [1, 2]
          );
          const state = yield* repository.load;
          assert.strictEqual(state.nextGeneration, 3);
          assert.strictEqual(state.lastStop?.code, 17);
          assert.strictEqual((yield* supervisor.health).activeSessions, 0);
        })
      )
  );

  it.effect(
    "resolves a queued prompt only after admission to the replacement generation",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped("acp-admission-");
          const repository = yield* makeAcpProcessStateRepository({
            path: join(root, "acp-process-state.json"),
            trustedRoot: root,
          });
          const firstStarted = yield* Deferred.make<void>();
          const releaseFirst = yield* Deferred.make<void>();
          const generations: AcpGenerationContext[] = [];
          const handled: Array<readonly [number, string]> = [];
          const supervisor = yield* makeAcpConversationProcessSupervisor({
            jitter: () => 0,
            makeGeneration: (context) =>
              Effect.sync(() => {
                generations.push(context);
                context.observeHealth({
                  generation: context.generation,
                  status: "ready",
                });
                return {
                  handle: (prompt) =>
                    Effect.gen(function* () {
                      handled.push([context.generation, prompt.conversationId]);
                      if (context.generation === 1) {
                        yield* Deferred.succeed(firstStarted, undefined);
                        yield* Deferred.await(releaseFirst);
                        return yield* HandlerFailure.make({
                          category: "exit",
                          safeDetail: "generation one was lost",
                        });
                      }
                      return [];
                    }),
                } satisfies ConversationAgentShape;
              }),
            repository,
            workspaceId: "workspace-a",
          });
          const first = yield* Effect.forkChild(
            Effect.result(supervisor.agent.handle(request("conversation-a")))
          );
          yield* Deferred.await(firstStarted);
          const queued = yield* Effect.forkChild(
            Effect.result(supervisor.agent.handle(request("conversation-b")))
          );
          generations[0]?.observeExit({ code: 31, signal: null });
          generations[0]?.observeHealth({ generation: 1, status: "closed" });
          yield* TestClock.adjust("1 millis");
          yield* waitFor(() => generations.length === 2);
          assert.deepStrictEqual(handled, [[1, "conversation-a"]]);
          yield* Deferred.succeed(releaseFirst, undefined);

          assert.strictEqual((yield* Fiber.join(first))._tag, "Failure");
          assert.strictEqual((yield* Fiber.join(queued))._tag, "Success");
          assert.deepStrictEqual(handled, [
            [1, "conversation-a"],
            [2, "conversation-b"],
          ]);
        })
      )
  );

  it.effect(
    "retains the prompt stop phase after the interrupted caller settles",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped("acp-prompt-phase-");
          const repository = yield* makeAcpProcessStateRepository({
            path: join(root, "acp-process-state.json"),
            trustedRoot: root,
          });
          const promptStarted = yield* Deferred.make<void>();
          const promptFailed = yield* Deferred.make<never, HandlerFailure>();
          const generations: AcpGenerationContext[] = [];
          const supervisor = yield* makeAcpConversationProcessSupervisor({
            jitter: () => 0,
            makeGeneration: (context) =>
              Effect.sync(() => {
                generations.push(context);
                context.observeHealth({
                  generation: context.generation,
                  status: "ready",
                });
                return {
                  handle: () =>
                    Effect.gen(function* () {
                      yield* Deferred.succeed(promptStarted, undefined);
                      return yield* Deferred.await(promptFailed);
                    }),
                } satisfies ConversationAgentShape;
              }),
            repository,
            workspaceId: "workspace-a",
          });
          const interrupted = yield* Effect.forkChild(
            Effect.result(supervisor.agent.handle(request("conversation-a")))
          );
          yield* Deferred.await(promptStarted);

          generations[0]?.observeExit({ code: 37, signal: null });
          generations[0]?.observeHealth({ generation: 1, status: "closed" });
          yield* Deferred.fail(
            promptFailed,
            HandlerFailure.make({
              category: "exit",
              safeDetail: "generation one was lost",
            })
          );
          yield* Fiber.join(interrupted);
          yield* TestClock.adjust("1 millis");
          yield* waitFor(() => generations.length === 2);

          const state = yield* repository.load;
          assert.strictEqual(state.lastStop?.generation, 1);
          assert.strictEqual(state.lastStop?.phase, "prompt");
        })
      )
  );

  it.effect("fails construction closed when its supervisor fiber defects", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped("acp-supervisor-defect-");
        const repository = yield* makeAcpProcessStateRepository({
          path: join(root, "acp-process-state.json"),
          trustedRoot: root,
        });
        const supervisor = yield* makeAcpConversationProcessSupervisor({
          makeGeneration: () => Effect.succeed(idleAgent),
          repository,
          testHooks: {
            afterGenerationReservedBeforeSpawn: () =>
              Effect.die(new Error("simulated supervisor defect")),
          },
          workspaceId: "workspace-a",
        });

        assert.strictEqual((yield* supervisor.health).health, "quarantined");
        assert.strictEqual(
          (yield* Effect.result(
            supervisor.agent.handle({
              actions: [],
              context: [],
              conversationId: "conversation-a",
              conversationSessionId: "session-a",
              conversationSessionIsNew: true,
              executionControls: [],
              executions: [],
              input: "hello",
              messages: [],
              promptId: "prompt-a",
              source: "slack",
              turnId: "turn-a",
            })
          ))._tag,
          "Failure"
        );
      })
    )
  );

  it.live(
    "reaps an acquired generation before durably quarantining a ready-transition defect",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const defectiveRoot = yield* makeTempDirectoryScoped(
            "acp-supervisor-ready-defect-"
          );
          const defectivePath = join(defectiveRoot, "acp-process-state.json");
          const durableRepository = yield* makeAcpProcessStateRepository({
            path: defectivePath,
            trustedRoot: defectiveRoot,
          });
          let failReadyTransition = true;
          const defectingRepository = {
            ...durableRepository,
            transition: (
              change: Parameters<typeof durableRepository.transition>[0]
            ) => {
              if (failReadyTransition && change.health === "ready") {
                failReadyTransition = false;
                return Effect.die(
                  new Error("simulated ready-transition repository defect")
                );
              }
              return durableRepository.transition(change);
            },
          };
          let defectiveChildPid = 0;
          let defectiveFinalizers = 0;
          let defectiveSpawns = 0;
          const makeDefectiveGeneration = (context: AcpGenerationContext) =>
            Effect.gen(function* () {
              yield* Effect.acquireRelease(
                Effect.sync(() => {
                  defectiveSpawns += 1;
                  const spawned = spawn(
                    process.execPath,
                    ["-e", "setInterval(() => undefined, 1000)"],
                    { stdio: "ignore" }
                  );
                  defectiveChildPid = spawned.pid ?? 0;
                  return spawned;
                }),
                (spawned) =>
                  stopTestChild(spawned, () => {
                    defectiveFinalizers += 1;
                  })
              );
              context.observeHealth({
                generation: context.generation,
                status: "ready",
              });
              return idleAgent;
            });
          yield* Effect.scoped(
            Effect.gen(function* () {
              const supervisor = yield* makeAcpConversationProcessSupervisor({
                makeGeneration: makeDefectiveGeneration,
                repository: defectingRepository,
                testHooks: { supervisorDefectSettlementMillis: 1000 },
                workspaceId: "workspace-defective",
              });
              assert.strictEqual(
                (yield* supervisor.health).health,
                "quarantined"
              );
              assert.strictEqual(
                (yield* Effect.result(
                  supervisor.agent.handle(request("rejected-after-defect"))
                ))._tag,
                "Failure"
              );
            })
          );
          assert.strictEqual(defectiveSpawns, 1);
          assert.strictEqual(defectiveFinalizers, 1);
          assert.ok(defectiveChildPid > 0);
          assert.strictEqual(processIsRunning(defectiveChildPid), false);

          const persisted = yield* durableRepository.load;
          assert.strictEqual(persisted.activeGeneration, null);
          assert.strictEqual(persisted.health, "quarantined");
          assert.strictEqual(persisted.readySince, null);
          assert.strictEqual(persisted.lastStop?.cause, "unknown");
          assert.strictEqual(persisted.lastStop?.expected, false);
          assert.strictEqual(
            persisted.transitions.at(-1)?.health,
            "quarantined"
          );

          const reopened = yield* makeAcpProcessStateRepository({
            path: defectivePath,
            trustedRoot: defectiveRoot,
          });
          yield* Effect.scoped(
            Effect.gen(function* () {
              const restarted = yield* makeAcpConversationProcessSupervisor({
                makeGeneration: makeDefectiveGeneration,
                repository: reopened,
                workspaceId: "workspace-defective",
              });
              assert.strictEqual(
                (yield* restarted.health).health,
                "quarantined"
              );
            })
          );
          assert.strictEqual(defectiveSpawns, 1);

          const healthyRoot = yield* makeTempDirectoryScoped(
            "acp-supervisor-healthy-neighbor-"
          );
          const healthyRepository = yield* makeAcpProcessStateRepository({
            path: join(healthyRoot, "acp-process-state.json"),
            trustedRoot: healthyRoot,
          });
          let healthyChildPid = 0;
          let healthyFinalizers = 0;
          yield* Effect.scoped(
            Effect.gen(function* () {
              const healthy = yield* makeAcpConversationProcessSupervisor({
                makeGeneration: (context) =>
                  Effect.gen(function* () {
                    yield* Effect.acquireRelease(
                      Effect.sync(() => {
                        const spawned = spawn(
                          process.execPath,
                          ["-e", "setInterval(() => undefined, 1000)"],
                          { stdio: "ignore" }
                        );
                        healthyChildPid = spawned.pid ?? 0;
                        return spawned;
                      }),
                      (spawned) =>
                        stopTestChild(spawned, () => {
                          healthyFinalizers += 1;
                        })
                    );
                    context.observeHealth({
                      generation: context.generation,
                      status: "ready",
                    });
                    return idleAgent;
                  }),
                repository: healthyRepository,
                workspaceId: "workspace-healthy",
              });
              yield* healthy.agent.handle(request("healthy-conversation"));
              assert.strictEqual((yield* healthy.health).health, "ready");
              assert.ok(healthyChildPid > 0);
              assert.strictEqual(processIsRunning(healthyChildPid), true);
              assert.strictEqual(healthyFinalizers, 0);
            })
          );
          assert.strictEqual(healthyFinalizers, 1);
          assert.strictEqual(processIsRunning(healthyChildPid), false);
        })
      ),
    20_000
  );

  it.effect("does not respawn a durably quarantined workspace", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped("acp-supervisor-reopen-");
        const repository = yield* makeAcpProcessStateRepository({
          path: join(root, "acp-process-state.json"),
          trustedRoot: root,
        });
        yield* repository.transition({
          health: "quarantined",
          timestamp: 1,
        });
        let attempts = 0;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const supervisor = yield* makeAcpConversationProcessSupervisor({
              makeGeneration: () =>
                Effect.sync(() => {
                  attempts += 1;
                  return idleAgent;
                }),
              repository,
              workspaceId: "workspace-a",
            });
            assert.strictEqual(
              (yield* supervisor.health).health,
              "quarantined"
            );
          })
        );
        assert.strictEqual(attempts, 0);
        assert.strictEqual((yield* repository.load).health, "quarantined");
      })
    )
  );

  it.effect("resumes a persisted circuit with one half-open generation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped("acp-supervisor-circuit-");
        const repository = yield* makeAcpProcessStateRepository({
          path: join(root, "acp-process-state.json"),
          trustedRoot: root,
        });
        yield* repository.transition({
          activeGeneration: null,
          circuitCooldownMillis: 1000,
          circuitOpenedAt: 0,
          health: "circuit_open",
          timestamp: 0,
        });
        let attempts = 0;
        const supervisor = yield* makeAcpConversationProcessSupervisor({
          makeGeneration: (context) =>
            Effect.sync(() => {
              attempts += 1;
              context.observeHealth({
                generation: context.generation,
                status: "ready",
              });
              return idleAgent;
            }),
          repository,
          workspaceId: "workspace-a",
        });

        assert.strictEqual((yield* supervisor.health).health, "circuit_open");
        assert.strictEqual(attempts, 0);
        yield* TestClock.adjust("999 millis");
        assert.strictEqual(attempts, 0);
        yield* TestClock.adjust("1 millis");
        yield* waitFor(() => attempts === 1);
        for (let turn = 0; turn < 100; turn += 1) {
          if ((yield* supervisor.health).health === "ready") {
            break;
          }
          yield* Effect.promise(
            () => new Promise<void>((resolve) => setTimeout(resolve, 2))
          );
        }
        assert.strictEqual((yield* supervisor.health).health, "ready");
      })
    )
  );

  it.effect("quarantines a deterministic incompatibility without retry", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped("acp-quarantine-");
        const repository = yield* makeAcpProcessStateRepository({
          path: join(root, "acp-process-state.json"),
          trustedRoot: root,
        });
        let attempts = 0;
        const supervisor = yield* makeAcpConversationProcessSupervisor({
          jitter: () => 0,
          makeGeneration: (context) =>
            Effect.gen(function* () {
              attempts += 1;
              context.observeFailureClassification(
                "deterministic",
                "protocol_incompatible"
              );
              return yield* HandlerFailure.make({
                category: "protocol",
                safeDetail: "incompatible",
              });
            }),
          repository,
          workspaceId: "workspace-a",
        });
        yield* waitFor(() => attempts === 1);
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if ((yield* supervisor.health).health === "quarantined") {
            break;
          }
          yield* Effect.promise(
            () => new Promise<void>((resolve) => setTimeout(resolve, 2))
          );
        }
        assert.strictEqual((yield* supervisor.health).health, "quarantined");
        yield* TestClock.adjust("1 hour");
        assert.strictEqual(attempts, 1);
      })
    )
  );

  it.effect("opens a bounded circuit and admits one half-open generation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped("acp-circuit-");
        const repository = yield* makeAcpProcessStateRepository({
          path: join(root, "acp-process-state.json"),
          trustedRoot: root,
        });
        let attempts = 0;
        const supervisor = yield* makeAcpConversationProcessSupervisor({
          jitter: () => 0,
          makeGeneration: () =>
            Effect.gen(function* () {
              attempts += 1;
              return yield* HandlerFailure.make({
                category: "protocol",
                safeDetail: "temporary",
              });
            }),
          repository,
          testHooks: {
            circuitCooldownMillis: 1000,
            circuitFailureCount: 3,
            failureWindowMillis: 1,
            maxEpisodeAttempts: 3,
          },
          workspaceId: "workspace-a",
        });
        yield* waitFor(() => attempts >= 1);
        for (let turn = 0; turn < 100 && attempts < 3; turn += 1) {
          yield* TestClock.adjust("1 second");
          yield* Effect.promise(
            () => new Promise<void>((resolve) => setTimeout(resolve, 5))
          );
        }
        for (let turn = 0; turn < 100; turn += 1) {
          if ((yield* supervisor.health).health === "circuit_open") {
            break;
          }
          yield* Effect.promise(
            () => new Promise<void>((resolve) => setTimeout(resolve, 2))
          );
        }
        assert.strictEqual(attempts, 3);
        assert.strictEqual((yield* supervisor.health).health, "circuit_open");
        for (let turn = 0; turn < 200 && attempts < 4; turn += 1) {
          yield* Effect.promise(
            () => new Promise<void>((resolve) => setTimeout(resolve, 5))
          );
          yield* TestClock.adjust("1 second");
        }
        for (let turn = 0; turn < 100; turn += 1) {
          if ((yield* supervisor.health).health === "circuit_open") {
            break;
          }
          yield* Effect.promise(
            () => new Promise<void>((resolve) => setTimeout(resolve, 2))
          );
        }
        assert.strictEqual(attempts, 4);
        assert.strictEqual((yield* supervisor.health).health, "circuit_open");
        yield* TestClock.adjust("100 millis");
        assert.strictEqual(attempts, 4);
      })
    )
  );
});
