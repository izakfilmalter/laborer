import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Record } from "effect";
import {
  type ClaimedTurn,
  EventId,
  IgnoredInbound,
  NormalizedMessage,
  type PrototypeState,
  stableMessageId,
  ThreadId,
  TurnId,
} from "../src/prototype/domain.ts";
import { DeliveryError } from "../src/prototype/errors.ts";
import {
  boundEvidence,
  makeProcessHandler,
  type ProcessHandlerOptions,
} from "../src/prototype/process-handler.ts";
import { makePrototypeHarness } from "../src/prototype/runtime.ts";
import {
  LABORER_SLACK_ID,
  normalizedEvent,
} from "../src/prototype/scenario.ts";
import {
  makeControlledStoreLayer,
  makeFileStoreLayer,
} from "../src/prototype/store.ts";
import { environmentForConfiguredHandler } from "../src/slack/handler-environment.ts";
import { makeTempDirectoryScoped } from "./support/temp-directory.ts";

const projectRoot = process.cwd();
const processTreeFixture = resolve(
  projectRoot,
  "tests/fixtures/process-tree-handler.ts"
);

const slack = {
  postThreadMessage: () => Effect.succeed({ ts: "delivered" }),
  readActivationContext: () => Effect.succeed([]),
};

const activation = (channelId: string, eventId: string) =>
  normalizedEvent({
    authorSlackId: "UHUMAN",
    channelId,
    eventId,
    messageTs: "1.0",
    text: `<@${LABORER_SLACK_ID}> fourth review`,
  });

const makeTurn = (suffix = "1.0"): ClaimedTurn => {
  const channelId = "CFOURTH";
  const message = NormalizedMessage.make({
    authorKind: "human",
    authorSlackId: "UHUMAN",
    classification: "input",
    id: stableMessageId(channelId, suffix),
    isActivation: true,
    slackTs: suffix,
    text: "process boundary",
  });
  return {
    attemptNumber: 1,
    channelId,
    context: [],
    id: TurnId.make(`turn:${message.id}`),
    initializationStatus: "not_applicable",
    messages: [message],
    rootTs: suffix,
    threadId: ThreadId.make(`${channelId}:${suffix}`),
    workingDirectory: null,
  };
};

const processOptions = (
  root: string,
  mode: string,
  evidence: ProcessHandlerOptions["evidence"] = { mode: "fixture" }
): ProcessHandlerOptions => ({
  args: [processTreeFixture],
  command: process.execPath,
  cwd: projectRoot,
  environment: environmentForConfiguredHandler(
    { PATH: process.env.PATH, PROCESS_TREE_MODE: mode },
    ["PROCESS_TREE_MODE"]
  ),
  evidence,
  stateRoot: join(root, "work-threads"),
  stateRootAnchor: root,
  timeout: "5 seconds",
});

const waitForAcknowledgementsToClear = Effect.fnUntraced(function* (
  snapshot: Effect.Effect<
    PrototypeState,
    import("../src/prototype/errors.ts").StoreError
  >
) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if ((yield* snapshot).acknowledgements.length === 0) {
      return;
    }
    yield* Effect.sleep("10 millis");
  }
  assert.fail("acknowledgement cleanup did not converge");
});

describe("fourth review durable critical sections", () => {
  it.live(
    "commits memory after an interruption requested immediately after rename",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-transition-mask-"
          );
          const snapshotPath = join(root, "snapshot.json");
          let releaseRename = (): void => undefined;
          const renamedHook: { hook?: () => Promise<void> } = {};
          const renamed = new Promise<void>((resolveRenamed) => {
            const released = new Promise<void>((resolveRelease) => {
              releaseRename = resolveRelease;
            });
            const hook = async (): Promise<void> => {
              resolveRenamed();
              await released;
            };
            Object.assign(renamedHook, { hook });
          });
          // The promise executor above runs synchronously and installs the hook.
          const harness = yield* makePrototypeHarness({
            handler: { invoke: () => Effect.void },
            laborerSlackId: LABORER_SLACK_ID,
            slack,
            storeLayer: makeFileStoreLayer(
              LABORER_SLACK_ID,
              snapshotPath,
              root,
              { afterRename: () => renamedHook.hook?.() ?? Promise.resolve() }
            ),
          });
          const fiber = yield* Effect.forkChild(
            harness.runner.inject(activation("CMASK", "event:mask"))
          );
          yield* Effect.promise(() => renamed);
          const interrupt = yield* Effect.forkChild(Fiber.interrupt(fiber));
          yield* Effect.yieldNow;
          releaseRename();
          yield* Fiber.join(interrupt);

          const memory = yield* harness.store.snapshot;
          const disk = JSON.parse(
            yield* Effect.promise(() => readFile(snapshotPath, "utf8"))
          ) as PrototypeState;
          assert.deepStrictEqual(disk, JSON.parse(JSON.stringify(memory)));
          assert.strictEqual(memory.threads.length, 1);
        })
      )
  );
});

describe("fourth review semantic reachability verifier", () => {
  it.effect(
    "rejects context, event-membership, retry, and attempt corruptions",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makePrototypeHarness({
            handler: { invoke: () => Effect.void },
            laborerSlackId: LABORER_SLACK_ID,
            slack,
          });
          yield* harness.runner.inject(
            activation("CSEMANTIC", "event:semantic")
          );
          const base = yield* harness.store.snapshot;
          const thread = base.threads[0];
          const turn = thread?.turns[0];
          const input = turn?.messages[0];
          assert.ok(thread);
          assert.ok(turn);
          assert.ok(input);
          const context = NormalizedMessage.make({
            authorKind: "human",
            authorSlackId: "UCONTEXT",
            classification: "context",
            id: stableMessageId(thread.channelId, "0.5"),
            isActivation: false,
            slackTs: "0.5",
            text: "context",
          });
          const pendingThread = {
            ...thread,
            context: [],
            contextAttempts: 0,
            contextIsPartial: false,
            contextRetryAtMillis: null,
            contextStatus: "pending" as const,
            turns: [],
            unassigned: [input],
          };
          const secondInput = {
            ...input,
            id: stableMessageId(thread.channelId, "2.0"),
            isActivation: false,
            slackTs: "2.0",
            text: "second",
          };
          const secondTurn = {
            ...turn,
            context: [context],
            id: TurnId.make(`turn:${secondInput.id}`),
            messages: [secondInput],
          };
          const corruptions: readonly {
            readonly label: string;
            readonly state: PrototypeState;
          }[] = [
            {
              label: "ignored event missing from seen set",
              state: {
                ...base,
                ignoredInbound: [
                  IgnoredInbound.make({
                    eventId: EventId.make("event:missing"),
                    reason: "blank",
                  }),
                ],
              },
            },
            {
              label: "pending context retains messages",
              state: {
                ...base,
                threads: [{ ...pendingThread, context: [context] }],
              } as PrototypeState,
            },
            {
              label: "pending context is partial",
              state: {
                ...base,
                threads: [{ ...pendingThread, contextIsPartial: true }],
              } as PrototypeState,
            },
            {
              label: "pending attempt lacks retry",
              state: {
                ...base,
                threads: [{ ...pendingThread, contextAttempts: 1 }],
              } as PrototypeState,
            },
            {
              label: "pending retry is not finite",
              state: {
                ...base,
                threads: [
                  {
                    ...pendingThread,
                    contextAttempts: 1,
                    contextRetryAtMillis: Number.POSITIVE_INFINITY,
                  },
                ],
              } as PrototypeState,
            },
            {
              label: "handler attempt number is not finite",
              state: {
                ...base,
                threads: [
                  {
                    ...thread,
                    turns: [
                      {
                        ...turn,
                        attempts: [{ ...turn.attempts[0], number: Number.NaN }],
                      },
                    ],
                  },
                ],
              } as PrototypeState,
            },
            {
              label: "first turn context differs from thread context",
              state: {
                ...base,
                threads: [{ ...thread, context: [context] }],
              } as PrototypeState,
            },
            {
              label: "later turn retains context",
              state: {
                ...base,
                threads: [{ ...thread, turns: [turn, secondTurn] }],
              } as PrototypeState,
            },
          ];
          for (const corruption of corruptions) {
            const result = yield* Effect.result(
              Layer.build(
                makeControlledStoreLayer({
                  laborerSlackId: LABORER_SLACK_ID,
                  persist: () => Effect.void,
                  state: corruption.state,
                })
              )
            );
            assert.strictEqual(result._tag, "Failure", corruption.label);
          }
        })
      )
  );
});

describe("fourth review generic process limits and evidence", () => {
  it.live(
    "enforces aggregate stream limits and strict public replies",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-process-aggregate-"
          );
          for (const mode of [
            "stdout-record-overflow",
            "stdout-byte-overflow",
            "stderr-throughput-overflow",
            "public-reply-excess",
            "public-reply-blank-id",
          ]) {
            const fixture = yield* makeProcessHandler(
              processOptions(root, mode)
            );
            const result = yield* Effect.result(
              fixture.handler.invoke(makeTurn(mode), () => Effect.void)
            );
            assert.strictEqual(result._tag, "Failure", mode);
            if (result._tag === "Failure") {
              assert.strictEqual(result.failure._tag, "HandlerFailure", mode);
              if (result.failure._tag === "HandlerFailure") {
                assert.strictEqual(result.failure.category, "protocol", mode);
              }
            }
          }
          const extensible = yield* makeProcessHandler(
            processOptions(root, "unknown-excess")
          );
          yield* extensible.handler.invoke(
            makeTurn("unknown"),
            () => Effect.void
          );
        })
      ),
    30_000
  );

  it.live(
    "keeps production evidence metadata-only and bounded",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped("laborer-evidence-mode-");
          const fixture = yield* makeProcessHandler(
            processOptions(root, "normal", {
              maxInvocations: 2,
              mode: "production",
            })
          );
          for (let index = 0; index < 4; index += 1) {
            yield* fixture.handler.invoke(
              makeTurn(`${index + 1}.0`),
              () => Effect.void
            );
          }
          const evidence = yield* fixture.snapshot;
          assert.strictEqual(evidence.invocations.length, 2);
          assert.ok(
            evidence.invocations.every((item) => item.envelope === null)
          );
          assert.ok(
            evidence.invocations.every((item) => item.inputTexts.length === 0)
          );
          assert.deepStrictEqual(evidence.internalStderr, []);
          assert.ok(Record.keys(evidence.maximumThreadConcurrency).length <= 2);
          assert.ok(
            Buffer.byteLength(JSON.stringify(evidence), "utf8") <= 256 * 1024
          );
        })
      ),
    15_000
  );

  it("keeps production evidence bounded for an oversized thread identity", () => {
    const oversizedIdentity = "x".repeat(300 * 1024);
    const bounded = boundEvidence(
      {
        activeGlobal: 1,
        activeThreads: { [oversizedIdentity]: 1 },
        internalStderr: [],
        invocations: [],
        maximumGlobalConcurrency: 1,
        maximumThreadConcurrency: { [oversizedIdentity]: 1 },
      },
      {
        includePayload: false,
        maxAggregateBytes: 256 * 1024,
        maxInvocations: 128,
        maxStderrBytes: 0,
      }
    );
    const {
      activeGlobal: _activeGlobal,
      activeThreads: _activeThreads,
      ...evidence
    } = bounded;
    assert.ok(
      Buffer.byteLength(JSON.stringify(evidence), "utf8") <= 256 * 1024
    );
  });
});

describe("fourth review acknowledgement progress and lock eviction", () => {
  it.live(
    "attempts acknowledgement first, runs work during outage, then converges",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const lifecycle: string[] = [];
          let attempts = 0;
          const harness = yield* makePrototypeHarness({
            activationAcknowledger: {
              acknowledge: () => {
                attempts += 1;
                lifecycle.push(`add:${attempts}`);
                return attempts < 5
                  ? DeliveryError.make({
                      category: "request_error",
                      disposition: "transient",
                      retryAfterMillis: 25,
                    })
                  : Effect.void;
              },
              complete: () => Effect.sync(() => lifecycle.push("remove")),
            },
            handler: {
              invoke: () => Effect.sync(() => lifecycle.push("handler")),
            },
            laborerSlackId: LABORER_SLACK_ID,
            slack,
          });
          const startedAt = Date.now();
          yield* harness.runner.inject(
            activation("CACKOUT", "event:ack-outage")
          );
          assert.ok(Date.now() - startedAt < 500);
          assert.deepStrictEqual(lifecycle.slice(0, 2), ["add:1", "handler"]);
          yield* waitForAcknowledgementsToClear(harness.store.snapshot);
          assert.strictEqual(attempts, 5);
          assert.strictEqual(lifecycle.at(-1), "remove");
          const lockDeadline = Date.now() + 1000;
          while (
            (yield* harness.runner.lockCounts).acknowledgements > 0 &&
            Date.now() < lockDeadline
          ) {
            yield* Effect.sleep("5 millis");
          }
          assert.deepStrictEqual(yield* harness.runner.lockCounts, {
            acknowledgements: 0,
            drivers: 0,
            threads: 0,
          });
        })
      )
  );
});
