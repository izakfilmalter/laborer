/** Mandatory adversarial regressions for the THROWAWAY issue #204 prototype. */

import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { type FetchFunction, WebClient } from "@slack/web-api";
import { Clock, Effect, Layer, Ref } from "effect";
import {
  type NormalizedInboundEvent,
  type OutboundItem,
  type PrototypeState,
  ReplyId,
  ThreadId,
  type TurnState,
} from "../src/prototype/domain.ts";
import {
  classifySlackError,
  makeSlackGateway,
} from "../src/prototype/emulated-slack.ts";
import {
  ContextReadError,
  DeliveryError,
  StoreError,
} from "../src/prototype/errors.ts";
import {
  fixtureHandlerOptions,
  makeProcessHandler,
  type ProcessHandlerOptions,
} from "../src/prototype/process-handler.ts";
import {
  makePrototypeHarness,
  type PrototypeHarness,
  type SlackGatewayShape,
  type WorkHandlerShape,
} from "../src/prototype/runtime.ts";
import {
  LABORER_SLACK_ID,
  normalizedEvent,
} from "../src/prototype/scenario.ts";
import {
  makeControlledStoreLayer,
  makeFileStoreLayer,
} from "../src/prototype/store.ts";

const noContextGateway = (): SlackGatewayShape => ({
  readActivationContext: () => Effect.succeed([]),
  postThreadMessage: () => Effect.succeed({ ts: "posted" }),
});

const noReplyHandler: WorkHandlerShape = {
  invoke: () => Effect.void,
};

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitFor = Effect.fnUntraced(function* <A>(
  read: Effect.Effect<A, StoreError>,
  predicate: (value: A) => boolean,
  attempts = 300
) {
  let lastValue: A | null = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = yield* read;
    lastValue = value;
    if (predicate(value)) {
      return value;
    }
    yield* Effect.sleep("10 millis");
  }
  return yield* StoreError.make({
    operation: "waitFor",
    reason: `condition-not-reached:${JSON.stringify(lastValue)}`,
  });
});

const activationEvent = (options?: {
  readonly eventId?: string;
  readonly text?: string;
  readonly ts?: string;
  readonly channelId?: string;
}): NormalizedInboundEvent =>
  normalizedEvent({
    authorSlackId: "UHUMAN",
    channelId: options?.channelId ?? "CVERIFY",
    eventId: options?.eventId ?? "event:activation",
    messageTs: options?.ts ?? "1.0",
    text: options?.text ?? `<@${LABORER_SLACK_ID}> verify`,
  });

const makeFilesystemHarness = (options: {
  readonly handler: WorkHandlerShape;
  readonly snapshotPath: string;
  readonly slack?: SlackGatewayShape;
}): Effect.Effect<PrototypeHarness, StoreError, import("effect").Scope.Scope> =>
  makePrototypeHarness({
    handler: options.handler,
    laborerSlackId: LABORER_SLACK_ID,
    slack: options.slack ?? noContextGateway(),
    storeLayer: makeFileStoreLayer(LABORER_SLACK_ID, options.snapshotPath),
  });

describe("identity and semantic invariants", () => {
  it.effect(
    "deduplicates a stable Slack message identity across unlimited event IDs",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makePrototypeHarness({
            handler: noReplyHandler,
            laborerSlackId: LABORER_SLACK_ID,
            slack: noContextGateway(),
          });
          yield* harness.runner.inject(activationEvent());
          for (let index = 0; index < 1100; index += 1) {
            const decision = yield* harness.runner.inject(
              activationEvent({ eventId: `event:duplicate:${index}` })
            );
            assert.strictEqual(decision._tag, "Ignored");
            assert.strictEqual(
              decision._tag === "Ignored" ? decision.reason : "",
              "duplicate-message"
            );
          }
          const state = yield* harness.store.snapshot;
          assert.strictEqual(state.threads.length, 1);
          assert.strictEqual(state.threads[0]?.turns.length, 1);
          assert.strictEqual(state.threads[0]?.turns[0]?.attempts.length, 1);
          const conflict = yield* Effect.result(
            harness.runner.inject(
              activationEvent({
                eventId: "event:conflict",
                text: `<@${LABORER_SLACK_ID}> changed payload`,
              })
            )
          );
          assert.strictEqual(conflict._tag, "Failure");
          assert.strictEqual(
            conflict._tag === "Failure" ? conflict.failure._tag : "",
            "StoreError"
          );
        })
      ),
    30_000
  );

  it.effect(
    "fails snapshot loading on structurally valid but semantically impossible state",
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.promise(() =>
          mkdtemp(join(tmpdir(), "laborer-204-semantic-"))
        );
        const snapshotPath = join(directory, "state.json");
        const first = yield* Effect.scoped(
          Effect.gen(function* () {
            const harness = yield* makeFilesystemHarness({
              handler: noReplyHandler,
              snapshotPath,
            });
            yield* harness.runner.inject(activationEvent());
            return yield* harness.store.snapshot;
          })
        );
        const thread = first.threads[0];
        assert.ok(thread);
        const turn = thread.turns[0];
        const message = turn?.messages[0];
        assert.ok(turn);
        assert.ok(message);
        const firstReplyId = `reply:${turn.id}:semantic`;
        const firstPendingOutbound = {
          deliveryAttempts: 0,
          id: `reply:${firstReplyId}`,
          kind: "public_reply",
          lastErrorCategory: null,
          replyId: firstReplyId,
          retryAtMillis: null,
          slackTs: null,
          status: "pending",
          text: "pending despite settled turn",
          turnId: turn.id,
        };
        const secondMessage = {
          ...message,
          id: "CVERIFY:2.0",
          isActivation: false,
          slackTs: "2.0",
          text: "second turn",
        };
        const secondTurnId = "turn:CVERIFY:2.0";
        const secondTurn = {
          ...turn,
          id: secondTurnId,
          messages: [secondMessage],
        };
        const deliveredFor = (turnId: string, suffix: string) => ({
          deliveryAttempts: 1,
          id: `reply:reply:${turnId}:${suffix}`,
          kind: "public_reply",
          lastErrorCategory: null,
          replyId: `reply:${turnId}:${suffix}`,
          retryAtMillis: null,
          slackTs: `${suffix}.0`,
          status: "delivered",
          text: suffix,
          turnId,
        });
        const invalidStates = [
          {
            ...first,
            threads: [{ ...thread, turns: [...thread.turns, turn] }],
          },
          {
            ...first,
            threads: [
              {
                ...thread,
                turns: [
                  {
                    ...turn,
                    messages: [{ ...message, id: "not-canonical" }],
                  },
                ],
              },
            ],
          },
          {
            ...first,
            threads: [
              {
                ...thread,
                turns: [
                  {
                    ...turn,
                    attempts: [{ number: 1, status: "interrupted" }],
                  },
                ],
              },
            ],
          },
          {
            ...first,
            threads: [
              {
                ...thread,
                turns: [
                  {
                    ...turn,
                    outcome: {
                      category: "spawn",
                      kind: "success",
                      safeDetail: null,
                    },
                  },
                ],
              },
            ],
          },
          {
            ...first,
            threads: [
              {
                ...thread,
                outbox: [firstPendingOutbound],
              },
            ],
          },
          {
            ...first,
            threads: [
              {
                ...thread,
                turns: [{ ...turn, status: "awaiting_delivery" }],
              },
            ],
          },
          {
            ...first,
            threads: [
              {
                ...thread,
                outbox: [
                  {
                    ...deliveredFor("turn:CVERIFY:missing", "missing"),
                  },
                ],
              },
            ],
          },
          {
            ...first,
            threads: [
              {
                ...thread,
                outbox: [
                  deliveredFor(secondTurnId, "second"),
                  deliveredFor(turn.id, "first"),
                ],
                turns: [turn, secondTurn],
              },
            ],
          },
          {
            ...first,
            threads: [
              {
                ...thread,
                turns: [
                  {
                    ...turn,
                    attempts: [{ number: 1, status: "failed" }],
                    outcome: {
                      category: "exit",
                      kind: "failure",
                      safeDetail: "exit code 1",
                    },
                    status: "failed",
                  },
                ],
              },
            ],
          },
        ];
        for (const invalid of invalidStates) {
          yield* Effect.promise(() =>
            writeFile(snapshotPath, JSON.stringify(invalid), "utf8")
          );
          const result = yield* Effect.result(
            Effect.scoped(
              Layer.build(makeFileStoreLayer(LABORER_SLACK_ID, snapshotPath))
            )
          );
          assert.strictEqual(result._tag, "Failure");
        }
      })
  );

  it.effect(
    "exhaustively validates queued and turn-status outbound settlement combinations",
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.promise(() =>
          mkdtemp(join(tmpdir(), "laborer-204-settlement-table-"))
        );
        const snapshotPath = join(directory, "state.json");
        const base = yield* Effect.scoped(
          Effect.gen(function* () {
            const harness = yield* makeFilesystemHarness({
              handler: noReplyHandler,
              snapshotPath,
            });
            yield* harness.runner.inject(activationEvent());
            return yield* harness.store.snapshot;
          })
        );
        const thread = base.threads[0];
        const turn = thread?.turns[0];
        const activation = turn?.messages[0];
        assert.ok(thread);
        assert.ok(turn);
        assert.ok(activation);

        const makeOutbound = (
          turnStatus: TurnState["status"],
          status: OutboundItem["status"]
        ) => {
          const isFailureNotice = turnStatus === "failed";
          const hasAttempt = status !== "pending";
          const hasFailure = status === "blocked" || status === "abandoned";
          return {
            deliveryAttempts: hasAttempt ? 1 : 0,
            id: isFailureNotice
              ? `notice:${turn.id}:exit`
              : `reply:reply:${turn.id}:settlement`,
            kind: isFailureNotice ? "operational_notice" : "public_reply",
            lastErrorCategory: hasFailure ? "invalid_arguments" : null,
            replyId: isFailureNotice ? null : `reply:${turn.id}:settlement`,
            retryAtMillis: null,
            slackTs: status === "delivered" ? "2.0" : null,
            status,
            text: isFailureNotice ? "Turn failed." : "reply",
            turnId: turn.id,
          };
        };
        const attemptStatusFor = (
          status: TurnState["status"]
        ): "failed" | "running" | "succeeded" => {
          if (status === "running") {
            return "running";
          }
          return status === "failed" ? "failed" : "succeeded";
        };
        const outcomeFor = (status: TurnState["status"]) => {
          if (status === "running") {
            return null;
          }
          if (status === "failed") {
            return {
              category: "exit" as const,
              kind: "failure" as const,
              safeDetail: "exit code 1",
            };
          }
          return { category: null, kind: "success" as const, safeDetail: null };
        };
        const makeTurn = (status: TurnState["status"]) => ({
          ...turn,
          attempts: [{ number: 1, status: attemptStatusFor(status) }],
          outcome: outcomeFor(status),
          status,
        });
        const cases: readonly {
          readonly expected: "Failure" | "Success";
          readonly label: string;
          readonly outboundStatus: OutboundItem["status"];
          readonly turnStatus: TurnState["status"];
        }[] = [
          {
            expected: "Success",
            label: "running/pending",
            outboundStatus: "pending",
            turnStatus: "running",
          },
          ...(["delivering", "delivered", "blocked", "abandoned"] as const).map(
            (outboundStatus) => ({
              expected: "Failure" as const,
              label:
                outboundStatus === "delivered"
                  ? "running/delivered verifier reproduction"
                  : `running/${outboundStatus}`,
              outboundStatus,
              turnStatus: "running" as const,
            })
          ),
          ...(["pending", "delivering", "blocked"] as const).map(
            (outboundStatus) => ({
              expected: "Success" as const,
              label: `awaiting_delivery/${outboundStatus}`,
              outboundStatus,
              turnStatus: "awaiting_delivery" as const,
            })
          ),
          ...(["delivered", "abandoned"] as const).map((outboundStatus) => ({
            expected: "Failure" as const,
            label: `awaiting_delivery/${outboundStatus}`,
            outboundStatus,
            turnStatus: "awaiting_delivery" as const,
          })),
          ...(["pending", "delivering", "blocked"] as const).flatMap(
            (outboundStatus) =>
              (["completed", "failed"] as const).map((turnStatus) => ({
                expected: "Failure" as const,
                label: `${turnStatus}/${outboundStatus}`,
                outboundStatus,
                turnStatus,
              }))
          ),
          ...(["delivered", "abandoned"] as const).flatMap((outboundStatus) =>
            (["completed", "failed"] as const).map((turnStatus) => ({
              expected: "Success" as const,
              label: `${turnStatus}/${outboundStatus}`,
              outboundStatus,
              turnStatus,
            }))
          ),
        ];

        for (const testCase of cases) {
          const state = {
            ...base,
            threads: [
              {
                ...thread,
                outbox: [
                  makeOutbound(testCase.turnStatus, testCase.outboundStatus),
                ],
                turns: [makeTurn(testCase.turnStatus)],
              },
            ],
          };
          yield* Effect.promise(() =>
            writeFile(snapshotPath, JSON.stringify(state), "utf8")
          );
          const result = yield* Effect.result(
            Effect.scoped(
              Layer.build(makeFileStoreLayer(LABORER_SLACK_ID, snapshotPath))
            )
          );
          assert.strictEqual(result._tag, testCase.expected, testCase.label);
        }

        const queuedCases = [
          { expected: "Success" as const, outbox: [], label: "queued/empty" },
          {
            expected: "Failure" as const,
            outbox: [makeOutbound("running", "pending")],
            label: "queued/outbound-without-turn",
          },
        ];
        for (const testCase of queuedCases) {
          const state = {
            ...base,
            threads: [
              {
                ...thread,
                outbox: testCase.outbox,
                turns: [],
                unassigned: [activation],
              },
            ],
          };
          yield* Effect.promise(() =>
            writeFile(snapshotPath, JSON.stringify(state), "utf8")
          );
          const result = yield* Effect.result(
            Effect.scoped(
              Layer.build(makeFileStoreLayer(LABORER_SLACK_ID, snapshotPath))
            )
          );
          assert.strictEqual(result._tag, testCase.expected, testCase.label);
        }
      })
  );
});

describe("automatic durable recovery", () => {
  it.effect("uses duplicate event delivery as a safe recovery wake-up", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const failOutcome = yield* Ref.make(true);
        const harness = yield* makePrototypeHarness({
          handler: noReplyHandler,
          laborerSlackId: LABORER_SLACK_ID,
          slack: noContextGateway(),
          storeLayer: makeControlledStoreLayer({
            laborerSlackId: LABORER_SLACK_ID,
            persist: (state) =>
              Effect.gen(function* () {
                const shouldFail = yield* Ref.get(failOutcome);
                const hasOutcome = state.threads.some((thread) =>
                  thread.turns.some((turn) => turn.outcome !== null)
                );
                if (shouldFail && hasOutcome) {
                  return yield* StoreError.make({
                    operation: "persist",
                    reason: "injected-outcome-failure",
                  });
                }
              }),
          }),
        });
        const event = activationEvent();
        const first = yield* Effect.result(harness.runner.inject(event));
        assert.strictEqual(first._tag, "Failure");
        yield* Ref.set(failOutcome, false);
        const duplicate = yield* harness.runner.inject(event);
        assert.strictEqual(duplicate._tag, "Ignored");
        const turn = (yield* harness.store.snapshot).threads[0]?.turns[0];
        assert.strictEqual(turn?.status, "completed");
        assert.deepStrictEqual(
          turn?.attempts.map((attempt) => attempt.status),
          ["interrupted", "succeeded"]
        );
      })
    )
  );

  it.live(
    "automatically replays a persisted attempt and deduplicates its separately replayed reply",
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.promise(() =>
          mkdtemp(join(tmpdir(), "laborer-204-replay-"))
        );
        const snapshotPath = join(directory, "state.json");
        const handlerOptions = fixtureHandlerOptions(process.cwd());
        const text = `<@${LABORER_SLACK_ID}> [fixture:reply-then-interrupt]`;

        yield* Effect.scoped(
          Effect.gen(function* () {
            const processHandler = yield* makeProcessHandler(handlerOptions);
            const harness = yield* makeFilesystemHarness({
              handler: processHandler.handler,
              snapshotPath,
            });
            yield* Effect.result(
              harness.runner
                .inject(activationEvent({ text }))
                .pipe(Effect.timeout("200 millis"))
            );
            const state = yield* harness.store.snapshot;
            assert.strictEqual(state.threads[0]?.outbox.length, 1);
          })
        );

        yield* Effect.scoped(
          Effect.gen(function* () {
            const processHandler = yield* makeProcessHandler(handlerOptions);
            const harness = yield* makeFilesystemHarness({
              handler: processHandler.handler,
              snapshotPath,
            });
            const state = yield* waitFor(
              harness.store.snapshot,
              (candidate) =>
                candidate.threads[0]?.turns[0]?.status === "completed"
            );
            const turn = state.threads[0]?.turns[0];
            assert.ok(turn);
            assert.deepStrictEqual(
              turn.attempts.map((attempt) => attempt.status),
              ["interrupted", "succeeded"]
            );
            assert.strictEqual(state.threads[0]?.outbox.length, 1);
            assert.ok(
              turn.attempts.every((attempt) => attempt.status !== "running")
            );
          })
        );
      }),
    10_000
  );

  it.live(
    "automatically resumes pending delivery after a fresh harness restart",
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.promise(() =>
          mkdtemp(join(tmpdir(), "laborer-204-delivery-restart-"))
        );
        const snapshotPath = join(directory, "state.json");
        const handlerOptions = fixtureHandlerOptions(process.cwd());
        const firstGateway: SlackGatewayShape = {
          readActivationContext: () => Effect.succeed([]),
          postThreadMessage: () =>
            DeliveryError.make({
              category: "ratelimited",
              disposition: "transient",
              retryAfterMillis: 2000,
            }),
        };
        yield* Effect.scoped(
          Effect.gen(function* () {
            const processHandler = yield* makeProcessHandler(handlerOptions);
            const harness = yield* makeFilesystemHarness({
              handler: processHandler.handler,
              slack: firstGateway,
              snapshotPath,
            });
            yield* Effect.result(
              harness.runner
                .inject(activationEvent())
                .pipe(Effect.timeout("500 millis"))
            );
            const state = yield* harness.store.snapshot;
            assert.ok(state.threads[0]?.outbox[0]?.retryAtMillis !== null);
          })
        );
        const deliveries = yield* Ref.make(0);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const recoveryStarted = yield* Clock.currentTimeMillis;
            const processHandler = yield* makeProcessHandler(handlerOptions);
            const harness = yield* makeFilesystemHarness({
              handler: processHandler.handler,
              snapshotPath,
              slack: {
                readActivationContext: () => Effect.succeed([]),
                postThreadMessage: () =>
                  Ref.update(deliveries, (count) => count + 1).pipe(
                    Effect.as({ ts: "recovered" })
                  ),
              },
            });
            const state = yield* waitFor(
              harness.store.snapshot,
              (candidate) =>
                candidate.threads[0]?.turns[0]?.status === "completed"
            );
            assert.strictEqual(
              state.threads[0]?.outbox[0]?.status,
              "delivered"
            );
            assert.strictEqual(yield* Ref.get(deliveries), 1);
            const recoveredAt = yield* Clock.currentTimeMillis;
            assert.ok(recoveredAt - recoveryStarted >= 1000);
          })
        );
      })
  );

  it.live(
    "automatically resumes persisted context retry without a new event",
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.promise(() =>
          mkdtemp(join(tmpdir(), "laborer-204-context-restart-"))
        );
        const snapshotPath = join(directory, "state.json");
        const transientGateway: SlackGatewayShape = {
          readActivationContext: () =>
            ContextReadError.make({
              category: "temporarily_unavailable",
              isTransient: true,
              partial: [],
            }),
          postThreadMessage: () => Effect.succeed({ ts: "unused" }),
        };
        yield* Effect.scoped(
          Effect.gen(function* () {
            const harness = yield* makeFilesystemHarness({
              handler: noReplyHandler,
              slack: transientGateway,
              snapshotPath,
            });
            yield* Effect.result(
              harness.runner
                .inject(activationEvent())
                .pipe(Effect.timeout("100 millis"))
            );
            const state = yield* harness.store.snapshot;
            assert.strictEqual(state.threads[0]?.contextStatus, "pending");
            assert.ok(state.threads[0]?.contextRetryAtMillis !== null);
            assert.strictEqual(state.threads[0]?.turns.length, 0);
          })
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const harness = yield* makeFilesystemHarness({
              handler: noReplyHandler,
              snapshotPath,
            });
            const state = yield* waitFor(
              harness.store.snapshot,
              (candidate) =>
                candidate.threads[0]?.turns[0]?.status === "completed"
            );
            assert.strictEqual(state.threads[0]?.contextStatus, "ready");
            assert.strictEqual(state.threads[0]?.contextRetryAtMillis, null);
          })
        );
      })
  );
});

describe("process supervision", () => {
  const runProcessCase = (options: {
    readonly handlerOptions?: ProcessHandlerOptions;
    readonly text: string;
  }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const processHandler = yield* makeProcessHandler(
          options.handlerOptions ?? fixtureHandlerOptions(process.cwd())
        );
        const harness = yield* makePrototypeHarness({
          handler: processHandler.handler,
          laborerSlackId: LABORER_SLACK_ID,
          slack: noContextGateway(),
        });
        const started = yield* Clock.currentTimeMillis;
        yield* harness.runner.inject(activationEvent({ text: options.text }));
        const finished = yield* Clock.currentTimeMillis;
        return {
          elapsed: finished - started,
          evidence: yield* processHandler.snapshot,
          state: yield* harness.store.snapshot,
        };
      })
    );

  it.live("caps inherited-pipe drain at one second", () =>
    Effect.gen(function* () {
      const result = yield* runProcessCase({
        text: `<@${LABORER_SLACK_ID}> [fixture:inherited-pipe]`,
      });
      assert.ok(result.elapsed >= 900);
      assert.ok(result.elapsed < 1800);
      assert.strictEqual(
        result.state.threads[0]?.turns[0]?.status,
        "completed"
      );
    })
  );

  it.live(
    "times out a SIGTERM-resistant process, SIGKILLs it, and waits for reap",
    () =>
      Effect.gen(function* () {
        const handlerOptions = {
          ...fixtureHandlerOptions(process.cwd()),
          timeout: "200 millis",
        } satisfies ProcessHandlerOptions;
        const result = yield* runProcessCase({
          handlerOptions,
          text: `<@${LABORER_SLACK_ID}> [fixture:no-reply] [fixture:term-resistant]`,
        });
        assert.ok(result.elapsed >= 10_000);
        const turn = result.state.threads[0]?.turns[0];
        assert.strictEqual(turn?.outcome?.category, "timeout");
        const pid = result.evidence.invocations[0]?.pid;
        assert.ok(pid !== null && pid !== undefined);
        assert.strictEqual(isProcessAlive(pid), false);
      }),
    15_000
  );

  it.live(
    "records direct signal termination and oversized unterminated protocol lines",
    () =>
      Effect.gen(function* () {
        const signaled = yield* runProcessCase({
          text: `<@${LABORER_SLACK_ID}> [fixture:no-reply] [fixture:signal]`,
        });
        assert.strictEqual(
          signaled.state.threads[0]?.turns[0]?.outcome?.category,
          "signal"
        );
        const oversized = yield* runProcessCase({
          text: `<@${LABORER_SLACK_ID}> [fixture:oversized-unterminated]`,
        });
        assert.strictEqual(
          oversized.state.threads[0]?.turns[0]?.outcome?.category,
          "protocol"
        );
        assert.strictEqual(
          oversized.state.threads[0]?.outbox[0]?.kind,
          "public_reply"
        );
      })
  );

  it.live(
    "passes the exact envelope and creates an owner-only stable state directory",
    () =>
      Effect.gen(function* () {
        const result = yield* runProcessCase({
          text: `<@${LABORER_SLACK_ID}> envelope`,
        });
        const invocation = result.evidence.invocations[0];
        assert.ok(invocation);
        assert.strictEqual(invocation.envelope.protocolVersion, 1);
        assert.strictEqual(invocation.envelope.turnId, invocation.turnId);
        assert.strictEqual(
          invocation.envelope.workThreadId,
          invocation.threadId
        );
        assert.deepStrictEqual(
          invocation.envelope.messages.map((message) => message.text),
          [`<@${LABORER_SLACK_ID}> envelope`]
        );
        const directoryStat = yield* Effect.promise(() =>
          stat(invocation.envelope.stateDirectory)
        );
        assert.strictEqual(directoryStat.mode % 512, 0o700);
      })
  );

  it.live(
    "tightens a pre-existing state directory to owner-only before invocation",
    () =>
      Effect.gen(function* () {
        const stateRoot = yield* Effect.promise(async () =>
          realpath(await mkdtemp(join(tmpdir(), "laborer-204-state-mode-")))
        );
        const stateDirectory = join(
          stateRoot,
          encodeURIComponent("CVERIFY:1.0")
        );
        yield* Effect.promise(() => mkdir(stateDirectory));
        yield* Effect.promise(() => chmod(stateDirectory, 0o777));
        assert.strictEqual(
          (yield* Effect.promise(() => stat(stateDirectory))).mode % 512,
          0o777
        );
        const result = yield* runProcessCase({
          handlerOptions: {
            ...fixtureHandlerOptions(process.cwd()),
            stateRoot,
          },
          text: `<@${LABORER_SLACK_ID}> existing directory`,
        });
        const invocation = result.evidence.invocations[0];
        assert.ok(invocation);
        assert.strictEqual(invocation.envelope.stateDirectory, stateDirectory);
        assert.strictEqual(
          (yield* Effect.promise(() => stat(stateDirectory))).mode % 512,
          0o700
        );
      })
  );

  it.live("turns spawn failure into a known sanitized outcome", () =>
    Effect.gen(function* () {
      const result = yield* runProcessCase({
        handlerOptions: {
          ...fixtureHandlerOptions(process.cwd()),
          command: "/definitely/missing/laborer-handler",
        },
        text: `<@${LABORER_SLACK_ID}> spawn`,
      });
      assert.strictEqual(
        result.state.threads[0]?.turns[0]?.outcome?.category,
        "spawn"
      );
      assert.strictEqual(
        result.state.threads[0]?.outbox[0]?.kind,
        "operational_notice"
      );
    })
  );
});

describe("storage failure posture", () => {
  it.effect("does not accept ingress when persistence fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makePrototypeHarness({
          handler: noReplyHandler,
          laborerSlackId: LABORER_SLACK_ID,
          slack: noContextGateway(),
          storeLayer: makeControlledStoreLayer({
            laborerSlackId: LABORER_SLACK_ID,
            persist: () =>
              StoreError.make({ operation: "persist", reason: "injected" }),
          }),
        });
        const result = yield* Effect.result(
          harness.runner.inject(activationEvent())
        );
        assert.strictEqual(result._tag, "Failure");
        assert.deepStrictEqual((yield* harness.store.snapshot).threads, []);
      })
    )
  );

  it.effect(
    "does not consume a running turn or emit a false notice when reply persistence fails",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const handler: WorkHandlerShape = {
            invoke: (turn, acceptReply) =>
              acceptReply({
                protocolVersion: 1,
                replyId: ReplyId.make(`reply:${turn.id}:storage`),
                text: "must not be accepted",
                type: "public_reply",
              }),
          };
          const harness = yield* makePrototypeHarness({
            handler,
            laborerSlackId: LABORER_SLACK_ID,
            slack: noContextGateway(),
            storeLayer: makeControlledStoreLayer({
              laborerSlackId: LABORER_SLACK_ID,
              persist: (state) =>
                state.threads.some((thread) => thread.outbox.length > 0)
                  ? StoreError.make({
                      operation: "persist",
                      reason: "reply-write-failed",
                    })
                  : Effect.void,
            }),
          });
          const result = yield* Effect.result(
            harness.runner.inject(activationEvent())
          );
          assert.strictEqual(result._tag, "Failure");
          const state = yield* harness.store.snapshot;
          assert.strictEqual(state.threads[0]?.turns[0]?.status, "running");
          assert.strictEqual(state.threads[0]?.turns[0]?.outcome, null);
          assert.deepStrictEqual(state.threads[0]?.outbox, []);
        })
      )
  );

  it.effect(
    "does not consume a turn when handler-outcome persistence fails",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makePrototypeHarness({
            handler: noReplyHandler,
            laborerSlackId: LABORER_SLACK_ID,
            slack: noContextGateway(),
            storeLayer: makeControlledStoreLayer({
              laborerSlackId: LABORER_SLACK_ID,
              persist: (state) =>
                state.threads.some((thread) =>
                  thread.turns.some((turn) => turn.outcome !== null)
                )
                  ? StoreError.make({
                      operation: "persist",
                      reason: "outcome-write-failed",
                    })
                  : Effect.void,
            }),
          });
          const result = yield* Effect.result(
            harness.runner.inject(activationEvent())
          );
          assert.strictEqual(result._tag, "Failure");
          const state = yield* harness.store.snapshot;
          assert.strictEqual(state.threads[0]?.turns[0]?.status, "running");
          assert.strictEqual(state.threads[0]?.turns[0]?.outcome, null);
          assert.deepStrictEqual(state.threads[0]?.outbox, []);
        })
      )
  );

  it.effect(
    "closes handles and removes temporary snapshots after rename failure",
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.promise(() =>
          mkdtemp(join(tmpdir(), "laborer-204-temp-cleanup-"))
        );
        const snapshotPath = join(directory, "state.json");
        yield* Effect.scoped(
          Effect.gen(function* () {
            const harness = yield* makeFilesystemHarness({
              handler: noReplyHandler,
              snapshotPath,
            });
            yield* Effect.promise(() => rm(snapshotPath));
            yield* Effect.promise(() => mkdir(snapshotPath));
            const result = yield* Effect.result(
              harness.runner.inject(activationEvent())
            );
            assert.strictEqual(result._tag, "Failure");
          })
        );
        const entries = yield* Effect.promise(() => readdir(directory));
        assert.ok(entries.every((entry) => !entry.endsWith(".tmp")));
      })
  );

  it.effect(
    "fails closed for unreadable and unwritable snapshot locations",
    () =>
      Effect.gen(function* () {
        const unreadable = yield* Effect.result(
          Effect.scoped(
            Layer.build(
              makeFileStoreLayer(LABORER_SLACK_ID, "/dev/null/state.json")
            )
          )
        );
        assert.strictEqual(unreadable._tag, "Failure");

        const directory = yield* Effect.promise(() =>
          mkdtemp(join(tmpdir(), "laborer-204-unwritable-"))
        );
        const snapshotPath = join(directory, "state.json");
        yield* Effect.scoped(
          Layer.build(makeFileStoreLayer(LABORER_SLACK_ID, snapshotPath))
        );
        yield* Effect.promise(() => chmod(directory, 0o500));
        const result = yield* Effect.result(
          Effect.scoped(
            Effect.gen(function* () {
              const harness = yield* makeFilesystemHarness({
                handler: noReplyHandler,
                snapshotPath,
              });
              yield* harness.runner.inject(activationEvent());
            })
          )
        );
        yield* Effect.promise(() => chmod(directory, 0o700));
        assert.strictEqual(result._tag, "Failure");
        const persisted = yield* Effect.promise(() =>
          readFile(snapshotPath, "utf8")
        );
        const decoded = JSON.parse(persisted) as PrototypeState;
        assert.deepStrictEqual(decoded.threads, []);
      })
  );
});

describe("real WebClient error and partial-context integration", () => {
  const makeClient = (fetch: FetchFunction): WebClient =>
    new WebClient("prototype-web-client-token", {
      fetch,
      rejectRateLimitedCalls: true,
      retryConfig: { retries: 0 },
      slackApiUrl: "https://slack.invalid/api/",
    });

  it.live(
    "classifies representative platform failures through the real gateway without hot-loop defaults",
    () =>
      Effect.gen(function* () {
        const cases = [
          ["invalid_auth", "destination-permanent", 0],
          ["token_revoked", "destination-permanent", 0],
          ["missing_scope", "destination-permanent", 0],
          ["msg_too_long", "item-permanent", 0],
          ["invalid_arguments", "item-permanent", 0],
          ["internal_error", "transient", 1000],
          ["service_unavailable", "transient", 1000],
          ["undocumented_platform_failure", "destination-permanent", 0],
        ] as const;
        for (const [category, disposition, retryAfterMillis] of cases) {
          let calls = 0;
          const client = makeClient(() => {
            calls += 1;
            return Promise.resolve(
              Response.json({ error: category, ok: false })
            );
          });
          const gateway = makeSlackGateway({ botClient: client, pageSize: 2 });
          const result = yield* Effect.result(
            gateway.postThreadMessage({
              channelId: "C1",
              rootTs: "1.0",
              text: "classification probe",
            })
          );
          assert.strictEqual(result._tag, "Failure");
          if (result._tag === "Failure") {
            assert.strictEqual(result.failure.category, category);
            assert.strictEqual(result.failure.disposition, disposition);
            assert.strictEqual(
              result.failure.retryAfterMillis,
              retryAfterMillis
            );
          }
          assert.strictEqual(calls, 1);
        }
      })
  );

  it.live(
    "preserves WebAPIRateLimitedError Retry-After through the gateway",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let calls = 0;
          const client = makeClient(() => {
            calls += 1;
            return Promise.resolve(
              calls === 1
                ? new Response("rate limited", {
                    headers: {
                      "content-type": "text/plain",
                      "retry-after": "2",
                    },
                    status: 429,
                    statusText: "Too Many Requests",
                  })
                : Response.json({ channel: "C1", ok: true, ts: "2.0" })
            );
          });
          const webGateway = makeSlackGateway({
            botClient: client,
            pageSize: 2,
          });
          const handler: WorkHandlerShape = {
            invoke: (turn, acceptReply) =>
              acceptReply({
                protocolVersion: 1,
                replyId: ReplyId.make(`reply:${turn.id}:rate-limit`),
                text: "retry me",
                type: "public_reply",
              }),
          };
          const harness = yield* makePrototypeHarness({
            handler,
            laborerSlackId: LABORER_SLACK_ID,
            slack: {
              readActivationContext: () => Effect.succeed([]),
              postThreadMessage: webGateway.postThreadMessage,
            },
          });
          const started = yield* Clock.currentTimeMillis;
          yield* harness.runner.inject(activationEvent());
          const finished = yield* Clock.currentTimeMillis;
          assert.ok(finished - started >= 1900);
          assert.strictEqual(calls, 2);
          const state = yield* harness.store.snapshot;
          assert.strictEqual(state.threads[0]?.outbox[0]?.deliveryAttempts, 2);
          assert.strictEqual(state.threads[0]?.outbox[0]?.status, "delivered");
        })
      )
  );

  it.live(
    "normalizes, sorts, deduplicates, filters, and bounds partial paginated context",
    () =>
      Effect.gen(function* () {
        let requestCount = 0;
        const client = makeClient(() => {
          requestCount += 1;
          if (requestCount === 1) {
            return Promise.resolve(
              Response.json({
                ok: true,
                messages: [
                  { ts: "12", text: "twelve", user: "U1" },
                  { ts: "3", text: "three", user: "U1" },
                  { ts: "2", text: "two", user: "U1" },
                  { ts: "2", text: "two", user: "U1" },
                  { ts: "1", text: " ", user: "U1" },
                  ...Array.from({ length: 9 }, (_, index) => ({
                    ts: `${index + 4}`,
                    text: `message-${index + 4}`,
                    user: "U1",
                  })),
                ],
                response_metadata: { next_cursor: "next" },
              })
            );
          }
          return Promise.resolve(
            Response.json({ error: "channel_not_found", ok: false })
          );
        });
        const gateway = makeSlackGateway({ botClient: client, pageSize: 20 });
        const result = yield* Effect.result(
          gateway.readActivationContext({
            activationTs: "20",
            channelId: "C1",
            isReplyActivation: false,
            retryAtMillis: null,
            rootTs: "20",
            threadId: ThreadId.make("C1:20"),
          })
        );
        assert.strictEqual(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.strictEqual(result.failure.isTransient, false);
          assert.strictEqual(result.failure.partial.length, 10);
          assert.deepStrictEqual(
            result.failure.partial.map((message) => message.slackTs),
            ["3", "4", "5", "6", "7", "8", "9", "10", "11", "12"]
          );
        }
        assert.deepStrictEqual(classifySlackError(new Error("network")), {
          category: "unknown",
          disposition: "destination-permanent",
          retryAfterMillis: 0,
        });
      })
  );

  it.live(
    "bounds reply partials through the activation when a later page fails",
    () =>
      Effect.gen(function* () {
        let requestCount = 0;
        const client = makeClient(() => {
          requestCount += 1;
          return Promise.resolve(
            requestCount === 1
              ? Response.json({
                  ok: true,
                  messages: [
                    { ts: "5", text: "activation", user: "U1" },
                    { ts: "4", text: "four", user: "U1" },
                    { ts: "2", text: "two", user: "U1" },
                    { ts: "2", text: "two", user: "U1" },
                    { ts: "6", text: "later", user: "U1" },
                    {
                      ts: "3",
                      text: "edited",
                      user: "U1",
                      subtype: "message_changed",
                    },
                    { ts: "1", text: "root", user: "U1" },
                  ],
                  response_metadata: { next_cursor: "next" },
                })
              : Response.json({ error: "channel_not_found", ok: false })
          );
        });
        const gateway = makeSlackGateway({ botClient: client, pageSize: 10 });
        const result = yield* Effect.result(
          gateway.readActivationContext({
            activationTs: "5",
            channelId: "C1",
            isReplyActivation: true,
            retryAtMillis: null,
            rootTs: "1",
            threadId: ThreadId.make("C1:1"),
          })
        );
        assert.strictEqual(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.deepStrictEqual(
            result.failure.partial.map((message) => message.slackTs),
            ["1", "2", "4"]
          );
        }
      })
  );
});
