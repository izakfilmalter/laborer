import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
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
const handlerPath = resolve(
  projectRoot,
  "src/handlers/classifier-worker-prototype.sh"
);
const stateHelperPath = resolve(
  projectRoot,
  "src/handlers/classifier-worker-state-helper.ts"
);
const sessionResultPath = resolve(
  projectRoot,
  "src/handlers/opencode-session-result.ts"
);
const fakeOpenCodePath = resolve(
  projectRoot,
  "tests/fixtures/fake-opencode.sh"
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

const runChild = (
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv
): Promise<{
  readonly code: number | null;
  readonly stderr: Buffer;
  readonly stdout: Buffer;
}> =>
  new Promise((resolveExit, rejectExit) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", rejectExit);
    child.once("exit", (code) =>
      resolveExit({
        code,
        stderr: Buffer.concat(stderr),
        stdout: Buffer.concat(stdout),
      })
    );
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

describe("fourth review UTF-8 and OpenCode completion boundaries", () => {
  it.effect("fatally rejects invalid UTF-8 handler state", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped("laborer-state-utf8-");
        yield* Effect.promise(() =>
          writeFile(
            join(root, "classifier-worker-state.json"),
            Buffer.from([0xc3, 0x28])
          )
        );
        const result = yield* Effect.promise(() =>
          runChild(process.execPath, [stateHelperPath, "read", root], {
            PATH: process.env.PATH,
          })
        );
        assert.notStrictEqual(result.code, 0);
        assert.strictEqual(result.stdout.length, 0);
      })
    )
  );

  it.effect(
    "accepts only a full terminal assistant export and rejects partial variants",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped("laborer-export-shape-");
          const sessionStore = join(root, "sessions.json");
          const assistant = {
            info: {
              agent: "worker",
              cost: 0,
              finish: "stop",
              id: "msg-assistant",
              mode: "primary",
              modelID: "model",
              parentID: "msg-user",
              path: { cwd: root, root },
              providerID: "provider",
              role: "assistant",
              sessionID: "ses-complete",
              time: { completed: 2, created: 1 },
              tokens: {
                cache: { read: 0, write: 0 },
                input: 1,
                output: 1,
                reasoning: 0,
              },
            },
            parts: [{ text: "x".repeat(128 * 1024), type: "text" }],
          };
          yield* Effect.promise(() =>
            writeFile(
              sessionStore,
              JSON.stringify({
                info: { id: "ses-complete" },
                messages: [assistant],
              })
            )
          );
          for (const [mode, expectedCode] of [
            ["normal", 0],
            ["export-pipe-sensitive", 0],
            ["export-in-progress", 1],
            ["export-aborted", 1],
            ["export-invalid-utf8", 1],
          ] as const) {
            const result = yield* Effect.promise(() =>
              runChild(
                process.execPath,
                [sessionResultPath, fakeOpenCodePath, "ses-complete", "0"],
                {
                  FAKE_OPENCODE_MODE: mode,
                  FAKE_OPENCODE_SESSION_STORE: sessionStore,
                  PATH: process.env.PATH,
                }
              )
            );
            assert.strictEqual(result.code, expectedCode, mode);
          }
        })
      )
  );

  it.effect(
    "rejects an incomplete or aborted latest assistant after a completed one",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-export-latest-assistant-"
          );
          const sessionStore = join(root, "sessions.json");
          const completedAssistant = {
            info: {
              agent: "worker",
              cost: 0,
              finish: "stop",
              id: "msg-assistant-completed",
              mode: "primary",
              modelID: "model",
              parentID: "msg-user-completed",
              path: { cwd: root, root },
              providerID: "provider",
              role: "assistant",
              sessionID: "ses-latest",
              time: { completed: 2, created: 1 },
              tokens: {
                cache: { read: 0, write: 0 },
                input: 1,
                output: 1,
                reasoning: 0,
              },
            },
            parts: [{ text: "must not be published", type: "text" }],
          };
          const latestAssistant = {
            info: {
              ...completedAssistant.info,
              id: "msg-assistant-latest",
              parentID: "msg-user-latest",
              time: { completed: 4, created: 3 },
            },
            parts: [{ text: "latest answer", type: "text" }],
          };
          yield* Effect.promise(() =>
            writeFile(
              sessionStore,
              JSON.stringify({
                info: { id: "ses-latest" },
                messages: [completedAssistant, latestAssistant],
              })
            )
          );

          for (const mode of [
            "export-in-progress",
            "export-aborted",
          ] as const) {
            const result = yield* Effect.promise(() =>
              runChild(
                process.execPath,
                [sessionResultPath, fakeOpenCodePath, "ses-latest", "0"],
                {
                  FAKE_OPENCODE_MODE: mode,
                  FAKE_OPENCODE_SESSION_STORE: sessionStore,
                  PATH: process.env.PATH,
                }
              )
            );
            assert.notStrictEqual(result.code, 0, mode);
            assert.strictEqual(result.stdout.length, 0, mode);
          }
        })
      )
  );

  it.live("rejects invalid UTF-8 OpenCode JSONL before jq", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped("laborer-jsonl-utf8-");
        const processHandler = yield* makeProcessHandler({
          args: [
            "FAKE_OPENCODE_MODE=jsonl-invalid-utf8",
            `FAKE_OPENCODE_LOG=${join(root, "calls.ndjson")}`,
            `LABORER_OPENCODE_COMMAND=${fakeOpenCodePath}`,
            handlerPath,
          ],
          command: "/usr/bin/env",
          cwd: projectRoot,
          environment: environmentForConfiguredHandler(process.env),
          evidence: { mode: "fixture" },
          stateRoot: join(root, "work-threads"),
          stateRootAnchor: root,
        });
        const harness = yield* makePrototypeHarness({
          handler: processHandler.handler,
          laborerSlackId: LABORER_SLACK_ID,
          slack,
        });
        yield* harness.runner.inject(activation("CUTF8", "event:utf8"));
        assert.strictEqual(
          (yield* harness.store.snapshot).threads[0]?.turns[0]?.outcome?.kind,
          "failure"
        );
        assert.ok(
          (yield* processHandler.snapshot).internalStderr.some((entry) =>
            entry.includes("invalid UTF-8 JSONL events")
          )
        );
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

describe("fourth review staged classifier and worker mutations", () => {
  const runClosedOwnerRecovery = (
    crashAssignment: string,
    channelId: string,
    expectedCallsBeforeRecovery: number
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped("laborer-staged-mutation-");
        const callLog = join(root, "calls.ndjson");
        const snapshotPath = join(root, "snapshot.json");
        const stateRoot = join(root, "work-threads");
        const makeConfiguredHandler = (crash?: string) =>
          makeProcessHandler({
            args: [
              `FAKE_OPENCODE_LOG=${callLog}`,
              `LABORER_OPENCODE_COMMAND=${fakeOpenCodePath}`,
              ...(crash === undefined ? [] : [crash]),
              handlerPath,
            ],
            command: "/usr/bin/env",
            cwd: projectRoot,
            environment: environmentForConfiguredHandler(process.env),
            evidence: { mode: "fixture" },
            stateRoot,
            stateRootAnchor: root,
            timeout: "15 seconds",
          });

        const interruptedThread = yield* Effect.scoped(
          Effect.gen(function* () {
            const processHandler =
              yield* makeConfiguredHandler(crashAssignment);
            const harness = yield* makePrototypeHarness({
              handler: processHandler.handler,
              laborerSlackId: LABORER_SLACK_ID,
              slack,
              storeLayer: makeFileStoreLayer(
                LABORER_SLACK_ID,
                snapshotPath,
                root
              ),
            });
            yield* harness.runner.inject(
              activation(channelId, `event:${channelId}`)
            );
            const thread = (yield* harness.store.snapshot).threads[0];
            assert.ok(thread);
            assert.strictEqual(thread.turns[0]?.status, "running");
            return thread;
          })
        );
        assert.strictEqual(
          (yield* Effect.promise(() => readFile(callLog, "utf8")))
            .trim()
            .split("\n").length,
          expectedCallsBeforeRecovery
        );

        yield* Effect.scoped(
          Effect.gen(function* () {
            const processHandler = yield* makeConfiguredHandler();
            const harness = yield* makePrototypeHarness({
              handler: processHandler.handler,
              laborerSlackId: LABORER_SLACK_ID,
              slack,
              storeLayer: makeFileStoreLayer(
                LABORER_SLACK_ID,
                snapshotPath,
                root
              ),
            });
            yield* harness.runner.retryInterrupted(interruptedThread.id);
            const recovered = (yield* harness.store.snapshot).threads[0]
              ?.turns[0];
            assert.strictEqual(recovered?.status, "completed");
            assert.deepStrictEqual(
              recovered?.attempts.map((attempt) => attempt.status),
              ["interrupted", "succeeded"]
            );
          })
        );
        return yield* Effect.promise(() => readFile(callLog, "utf8"));
      })
    );

  it.live(
    "continues from a persisted classifier result without classifying twice",
    () =>
      Effect.gen(function* () {
        const calls = yield* runClosedOwnerRecovery(
          "LABORER_TEST_CRASH_AFTER_CLASSIFIER_RESULT=true",
          "CSTAGECLASSIFIER",
          1
        );
        assert.deepStrictEqual(
          calls
            .trim()
            .split("\n")
            .map(
              (line) => (JSON.parse(line) as { readonly kind: string }).kind
            ),
          ["classifier", "worker"]
        );
      }),
    30_000
  );

  it.live(
    "finalizes a persisted initial-worker result without invoking it twice",
    () =>
      Effect.gen(function* () {
        const calls = yield* runClosedOwnerRecovery(
          "LABORER_TEST_CRASH_AFTER_INITIAL_WORKER_RESULT=true",
          "CSTAGEWORKER",
          2
        );
        assert.deepStrictEqual(
          calls
            .trim()
            .split("\n")
            .map(
              (line) => (JSON.parse(line) as { readonly kind: string }).kind
            ),
          ["classifier", "worker"]
        );
      }),
    30_000
  );

  it.live(
    "fails an unresolved classifier mutation explicitly without rerunning it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-unresolved-stage-"
          );
          const callLog = join(root, "calls.ndjson");
          const snapshotPath = join(root, "snapshot.json");
          const stateRoot = join(root, "work-threads");
          const makeHandler = (crash: boolean) =>
            makeProcessHandler({
              args: [
                `FAKE_OPENCODE_LOG=${callLog}`,
                `LABORER_OPENCODE_COMMAND=${fakeOpenCodePath}`,
                ...(crash
                  ? ["LABORER_TEST_CRASH_AFTER_CLASSIFIER_MUTATION=true"]
                  : []),
                handlerPath,
              ],
              command: "/usr/bin/env",
              cwd: projectRoot,
              environment: environmentForConfiguredHandler(process.env),
              evidence: { mode: "fixture" },
              stateRoot,
              stateRootAnchor: root,
            });
          const threadId = yield* Effect.scoped(
            Effect.gen(function* () {
              const processHandler = yield* makeHandler(true);
              const harness = yield* makePrototypeHarness({
                handler: processHandler.handler,
                laborerSlackId: LABORER_SLACK_ID,
                slack,
                storeLayer: makeFileStoreLayer(
                  LABORER_SLACK_ID,
                  snapshotPath,
                  root
                ),
              });
              yield* harness.runner.inject(
                activation("CUNRESOLVED", "event:unresolved")
              );
              const thread = (yield* harness.store.snapshot).threads[0];
              assert.ok(thread);
              return thread.id;
            })
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              const processHandler = yield* makeHandler(false);
              const harness = yield* makePrototypeHarness({
                handler: processHandler.handler,
                laborerSlackId: LABORER_SLACK_ID,
                slack,
                storeLayer: makeFileStoreLayer(
                  LABORER_SLACK_ID,
                  snapshotPath,
                  root
                ),
              });
              yield* harness.runner.retryInterrupted(threadId);
              const turn = (yield* harness.store.snapshot).threads[0]?.turns[0];
              assert.strictEqual(turn?.status, "failed");
              assert.strictEqual(turn?.outcome?.category, "exit");
            })
          );
          assert.strictEqual(
            (yield* Effect.promise(() => readFile(callLog, "utf8")))
              .trim()
              .split("\n").length,
            1
          );
        })
      ),
    30_000
  );
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
