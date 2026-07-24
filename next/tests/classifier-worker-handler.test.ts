/** Behavioral proof for the THROWAWAY issue #207 classifier/worker handler. */

import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Array as EffectArray, Fiber, pipe } from "effect";
import type {
  ClaimedTurn,
  PublicReplyProtocolRecord,
} from "../src/prototype/domain.ts";
import {
  NormalizedMessage,
  stableMessageId,
  ThreadId,
  TurnId,
} from "../src/prototype/domain.ts";
import {
  makeSlackActivationAcknowledger,
  startEmulatedSlack,
} from "../src/prototype/emulated-slack.ts";
import { HandlerFailure } from "../src/prototype/errors.ts";
import { makeProcessHandler } from "../src/prototype/process-handler.ts";
import { makePrototypeHarness } from "../src/prototype/runtime.ts";
import {
  LABORER_SLACK_ID,
  normalizedEvent,
  postHumanMessage,
  timestampOf,
} from "../src/prototype/scenario.ts";
import { environmentForConfiguredHandler } from "../src/slack/handler-environment.ts";
import { makeTempDirectoryScoped } from "./support/temp-directory.ts";

const projectRoot = process.cwd();
const handlerPath = resolve(
  projectRoot,
  "src/handlers/classifier-worker-prototype.sh"
);
const fakeOpenCodePath = resolve(
  projectRoot,
  "tests/fixtures/fake-opencode.sh"
);
const stateHelperPath = resolve(
  projectRoot,
  "src/handlers/classifier-worker-state-helper.ts"
);
const STATE_HELPER_FAILURE_PATTERN = /operation failed/;
const overflowModes = [
  "stdout-overflow",
  "event-overflow",
  "stderr-overflow",
  "oversized-reply",
] as const;
type OverflowMode = (typeof overflowModes)[number];

const expectedOverflowDiagnostic = (mode: OverflowMode): string => {
  switch (mode) {
    case "stdout-overflow":
      return "OpenCode output exceeded the bounded stdout-bytes limit";
    case "event-overflow":
      return "OpenCode output exceeded the bounded stdout-events limit";
    case "stderr-overflow":
      return "OpenCode output exceeded the bounded stderr-bytes limit";
    case "oversized-reply":
      return "public reply exceeds 1 MiB protocol record limit";
    default:
      return assert.fail(`Unexpected overflow mode: ${mode satisfies never}`);
  }
};

const environmentProbeHandler = `
let source = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { source += chunk; });
process.stdin.on("end", () => {
  const envelope = JSON.parse(source);
  const tokensAbsent = !Object.hasOwn(process.env, "SLACK_APP_TOKEN") && !Object.hasOwn(process.env, "SLACK_BOT_TOKEN");
  process.stdout.write(JSON.stringify({
    protocolVersion: 1,
    type: "public_reply",
    replyId: "reply:environment-probe:1",
    text: tokensAbsent ? "tokens-absent" : "tokens-present"
  }) + "\\n");
});
`;

const waitForExit = (
  child: ReturnType<typeof spawn>
): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}> =>
  new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });

interface StateHelperResult {
  readonly code: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

const readWithStateHelper = (directory: string): Promise<StateHelperResult> =>
  new Promise((resolveResult, rejectResult) => {
    const child = spawn(
      process.execPath,
      [stateHelperPath, "read", directory],
      {
        cwd: projectRoot,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", rejectResult);
    child.once("exit", (code) => resolveResult({ code, stderr, stdout }));
  });

const validClassifierWorkerState = {
  classification: "feature",
  pendingMutation: null,
  replies: {
    "turn:one": {
      replyId: "reply:turn:one:1",
      text: "A stored reply",
    },
  },
  version: 3,
  workerBrief: "laborer-feature-to-pr",
  workerSessionId: "session:worker",
} as const;

const waitForFile = Effect.fnUntraced(function* (path: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = yield* Effect.result(
      Effect.tryPromise({
        try: () => stat(path),
        catch: () => undefined,
      })
    );
    if (result._tag === "Success") {
      return;
    }
    yield* Effect.sleep("25 millis");
  }
  assert.fail(`fixture readiness timed out after 5 seconds: path=${path}`);
});

const selectedSkillFor = Effect.fnUntraced(function* (
  classification: "bug" | "feature"
) {
  const temporaryRoot = yield* makeTempDirectoryScoped(
    `laborer-${classification}-skill-`
  );
  const fakeLog = join(temporaryRoot, "fake-opencode.ndjson");
  const processHandler = yield* makeProcessHandler({
    args: [
      `FAKE_OPENCODE_CLASSIFICATION=${classification}`,
      `FAKE_OPENCODE_LOG=${fakeLog}`,
      `LABORER_OPENCODE_COMMAND=${fakeOpenCodePath}`,
      handlerPath,
    ],
    command: "/usr/bin/env",
    cwd: projectRoot,
    environment: environmentForConfiguredHandler(process.env),
    evidence: { mode: "fixture" },
    stateRoot: join(temporaryRoot, "work-threads"),
    stateRootAnchor: temporaryRoot,
  });
  const channelId = `C${classification.toUpperCase()}`;
  const message = NormalizedMessage.make({
    authorKind: "human",
    authorSlackId: "UHUMAN",
    classification: "input",
    id: stableMessageId(channelId, "1.0"),
    isActivation: true,
    slackTs: "1.0",
    text: `Implement the ${classification} request`,
  });
  const turn: ClaimedTurn = {
    attemptNumber: 1,
    channelId,
    context: [],
    id: TurnId.make(`turn:${message.id}`),
    initializationStatus: "completed",
    messages: [message],
    rootTs: "1.0",
    threadId: ThreadId.make(`${channelId}:1.0`),
    workingDirectory: projectRoot,
  };
  yield* processHandler.handler.invoke(turn, () => Effect.void);
  const calls = pipe(
    (yield* Effect.promise(() => readFile(fakeLog, "utf8"))).trim().split("\n"),
    EffectArray.map((line) => JSON.parse(line) as Record<string, unknown>)
  );
  return calls[1]?.selectedSkill;
});

describe("issue #207 generic classifier-to-worker conversation", () => {
  it.live(
    "selects the bug Slack-to-PR skill",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          assert.strictEqual(
            yield* selectedSkillFor("bug"),
            "laborer-bug-to-pr"
          );
        })
      ),
    30_000
  );

  it.effect(
    "rejects excess keys at every classifier state object boundary",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const temporaryRoot = yield* makeTempDirectoryScoped(
            "laborer-classifier-state-excess-"
          );
          const statePath = join(temporaryRoot, "classifier-worker-state.json");
          const excessStates = [
            { ...validClassifierWorkerState, unexpected: true },
            {
              ...validClassifierWorkerState,
              pendingMutation: {
                baselineMessageCount: 1,
                kind: "follow_up",
                resultText: null,
                sessionId: "session:worker",
                status: "started",
                turnId: "turn:two",
                unexpected: true,
              },
            },
            {
              ...validClassifierWorkerState,
              replies: {
                "turn:one": {
                  ...validClassifierWorkerState.replies["turn:one"],
                  unexpected: true,
                },
              },
            },
          ];

          yield* Effect.promise(() =>
            writeFile(statePath, JSON.stringify(validClassifierWorkerState))
          );
          assert.strictEqual(
            (yield* Effect.promise(() => readWithStateHelper(temporaryRoot)))
              .code,
            0
          );

          for (const state of excessStates) {
            yield* Effect.promise(() =>
              writeFile(statePath, JSON.stringify(state))
            );
            const result = yield* Effect.promise(() =>
              readWithStateHelper(temporaryRoot)
            );
            assert.strictEqual(result.code, 1);
            assert.strictEqual(result.stdout, "");
            assert.match(result.stderr, STATE_HELPER_FAILURE_PATTERN);
          }
        })
      )
  );

  it.effect(
    "rejects incoherent classifier state combinations and replies",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const temporaryRoot = yield* makeTempDirectoryScoped(
            "laborer-classifier-state-incoherent-"
          );
          const statePath = join(temporaryRoot, "classifier-worker-state.json");
          const incoherentStates = [
            { ...validClassifierWorkerState, workerBrief: null },
            {
              ...validClassifierWorkerState,
              pendingMutation: {
                baselineMessageCount: null,
                kind: "initial_worker",
                resultText: null,
                sessionId: "session:too-early",
                status: "started",
                turnId: "turn:two",
              },
              replies: {},
              workerSessionId: null,
            },
            {
              ...validClassifierWorkerState,
              pendingMutation: {
                baselineMessageCount: 1,
                kind: "follow_up",
                resultText: null,
                sessionId: "session:different",
                status: "started",
                turnId: "turn:two",
              },
            },
            {
              ...validClassifierWorkerState,
              pendingMutation: {
                baselineMessageCount: 1,
                kind: "follow_up",
                resultText: null,
                sessionId: "session:worker",
                status: "started",
                turnId: "turn:one",
              },
            },
            {
              ...validClassifierWorkerState,
              replies: {
                "turn:one": {
                  replyId: "reply:wrong-turn:1",
                  text: "A stored reply",
                },
              },
            },
          ];

          for (const state of incoherentStates) {
            yield* Effect.promise(() =>
              writeFile(statePath, JSON.stringify(state))
            );
            const result = yield* Effect.promise(() =>
              readWithStateHelper(temporaryRoot)
            );
            assert.strictEqual(result.code, 1);
            assert.strictEqual(result.stdout, "");
            assert.match(result.stderr, STATE_HELPER_FAILURE_PATTERN);
          }
        })
      )
  );

  it.live(
    "classifies once, resumes the selected worker, and replays a stable deliberate reply",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* startEmulatedSlack();
          const canonicalTemporaryRoot = yield* makeTempDirectoryScoped(
            "laborer-classifier-worker-"
          );
          const fakeLog = join(canonicalTemporaryRoot, "fake-opencode.ndjson");
          const lifecycle: string[] = [];
          const processHandler = yield* makeProcessHandler({
            args: [
              `FAKE_OPENCODE_LOG=${fakeLog}`,
              `LABORER_OPENCODE_COMMAND=${fakeOpenCodePath}`,
              "LABORER_OPENCODE_MODEL=test-provider/test-model",
              handlerPath,
            ],
            command: "/usr/bin/env",
            cwd: projectRoot,
            environment: environmentForConfiguredHandler({
              ...process.env,
              SLACK_APP_TOKEN: "app-token-must-not-reach-handler",
              SLACK_BOT_TOKEN: "bot-token-must-not-reach-handler",
            }),
            evidence: { mode: "fixture" },
            stateRoot: join(canonicalTemporaryRoot, "work-threads"),
            stateRootAnchor: canonicalTemporaryRoot,
          });
          const harness = yield* makePrototypeHarness({
            activationAcknowledger: {
              acknowledge: ({ messageTs }) =>
                Effect.sync(() => {
                  lifecycle.push(`acknowledged:${messageTs}`);
                }),
              complete: ({ messageTs }) =>
                Effect.sync(() => {
                  lifecycle.push(`completed:${messageTs}`);
                }),
            },
            handler: {
              invoke: (turn, acceptReply) =>
                Effect.sync(() => {
                  lifecycle.push("handler-started");
                }).pipe(
                  Effect.andThen(
                    processHandler.handler.invoke(turn, acceptReply)
                  )
                ),
            },
            laborerSlackId: LABORER_SLACK_ID,
            slack: fixture.gateway,
          });

          const activationText = `<@${LABORER_SLACK_ID}> help me outline a launch essay`;
          const activation = yield* postHumanMessage(fixture, activationText);
          const rootTs = timestampOf(activation);
          yield* harness.runner.inject(
            normalizedEvent({
              authorSlackId: fixture.humanUserId,
              channelId: fixture.channelId,
              eventId: "event:207-activation",
              messageTs: rootTs,
              text: activationText,
            })
          );

          const firstState = yield* harness.store.snapshot;
          const thread = firstState.threads[0];
          const firstTurn = thread?.turns[0];
          const firstOutbound = thread?.outbox[0];
          assert.ok(thread);
          assert.ok(firstTurn);
          assert.ok(firstOutbound);
          assert.deepStrictEqual(lifecycle, [
            `acknowledged:${rootTs}`,
            "handler-started",
            `completed:${rootTs}`,
          ]);
          assert.strictEqual(
            firstOutbound.text,
            "Initial worker answer from the selected feature worker."
          );
          assert.strictEqual(firstOutbound.status, "delivered");

          const replayed: PublicReplyProtocolRecord[] = [];
          const replayTurn: ClaimedTurn = {
            attemptNumber: 2,
            channelId: thread.channelId,
            context: firstTurn.context,
            id: firstTurn.id,
            messages: firstTurn.messages,
            rootTs: thread.rootTs,
            threadId: thread.id,
            initializationStatus: thread.initializationStatus,
            workingDirectory: thread.workingDirectory,
          };
          yield* processHandler.handler.invoke(replayTurn, (record) =>
            Effect.sync(() => {
              replayed.push(record);
            })
          );
          assert.strictEqual(replayed.length, 1);
          assert.strictEqual(replayed[0]?.replyId, firstOutbound.replyId);
          assert.strictEqual(replayed[0]?.text, firstOutbound.text);

          const followUpText = "Make the outline shorter.";
          const followUp = yield* postHumanMessage(fixture, followUpText, {
            threadTs: rootTs,
          });
          yield* harness.runner.inject(
            normalizedEvent({
              authorSlackId: fixture.humanUserId,
              channelId: fixture.channelId,
              eventId: "event:207-follow-up",
              messageTs: timestampOf(followUp),
              text: followUpText,
              threadTs: rootTs,
            })
          );

          const callLog = pipe(
            (yield* Effect.promise(() => readFile(fakeLog, "utf8")))
              .trim()
              .split("\n"),
            EffectArray.map(
              (line) => JSON.parse(line) as Record<string, unknown>
            )
          );
          assert.deepStrictEqual(
            pipe(
              callLog,
              EffectArray.map((call) => call.kind)
            ),
            ["classifier", "worker", "follow-up"]
          );
          assert.strictEqual(callLog[2]?.session, "ses_worker_207");
          assert.deepStrictEqual(
            pipe(
              callLog,
              EffectArray.map((call) => call.agent)
            ),
            ["", "", ""]
          );
          assert.ok(
            EffectArray.every(
              callLog,
              (call) =>
                call.model === "test-provider/test-model" &&
                call.slackTokensPresent === false
            )
          );
          assert.ok(
            EffectArray.every(callLog, (call) => call.toolDenied === false)
          );
          assert.deepStrictEqual(
            pipe(
              callLog,
              EffectArray.map((call) => call.selectedSkill)
            ),
            ["none", "laborer-feature-to-pr", "laborer-feature-to-pr"]
          );
          const finalThread = (yield* harness.store.snapshot).threads[0];
          assert.strictEqual(finalThread?.turns.length, 2);
          assert.ok(
            finalThread !== undefined &&
              EffectArray.every(
                finalThread.turns,
                (turn) => turn.status === "completed"
              )
          );
          assert.deepStrictEqual(lifecycle, [
            `acknowledged:${rootTs}`,
            "handler-started",
            `completed:${rootTs}`,
            "handler-started",
          ]);

          const threadResponse = yield* Effect.promise(() =>
            fixture.humanClient.conversations.replies({
              channel: fixture.channelId,
              limit: 100,
              ts: rootTs,
            })
          );
          const messages = (threadResponse.messages ?? []) as Record<
            string,
            unknown
          >[];
          const botReplies = pipe(
            messages,
            EffectArray.filter((message) => message.user === fixture.botUserId)
          );
          assert.deepStrictEqual(
            pipe(
              botReplies,
              EffectArray.map((message) => message.text)
            ),
            [
              "Initial worker answer from the selected feature worker.",
              "Follow-up answer from the resumed worker session.",
            ]
          );
          assert.ok(
            EffectArray.every(
              botReplies,
              (message) => message.thread_ts === rootTs
            )
          );
          assert.ok(
            EffectArray.every(
              messages,
              (message) =>
                typeof message.text !== "string" ||
                !(
                  message.text.includes("FAKE OPENCODE SECRET DIAGNOSTIC") ||
                  message.text.includes("laborer issue #207 handler")
                )
            )
          );

          const evidence = yield* processHandler.snapshot;
          const stateDirectory =
            evidence.invocations[0]?.envelope?.stateDirectory;
          assert.ok(stateDirectory);
          const diagnosticFiles = pipe(
            yield* Effect.promise(() => readdir(stateDirectory)),
            EffectArray.filter((name) => name.startsWith("opencode-stderr."))
          );
          assert.deepStrictEqual(diagnosticFiles, ["opencode-stderr.log"]);
          assert.ok(
            (yield* Effect.promise(() =>
              stat(join(stateDirectory, "opencode-stderr.log"))
            )).size <=
              64 * 1024
          );
          const capturedDiagnostics = yield* Effect.forEach(
            diagnosticFiles,
            (name) =>
              Effect.promise(() => readFile(join(stateDirectory, name), "utf8"))
          );
          assert.ok(
            EffectArray.some(capturedDiagnostics, (text) =>
              text.includes("FAKE OPENCODE SECRET DIAGNOSTIC")
            )
          );
        })
      ),
    30_000
  );

  it.live(
    "bounds OpenCode bytes, event count, diagnostics, and pre-persistence replies",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          for (const mode of overflowModes) {
            const temporaryRoot = yield* makeTempDirectoryScoped(
              `laborer-classifier-${mode}-`
            );
            const stateRoot = join(temporaryRoot, "work-threads");
            const processHandler = yield* makeProcessHandler({
              args: [
                `FAKE_OPENCODE_LOG=${join(temporaryRoot, "fake-opencode.ndjson")}`,
                `FAKE_OPENCODE_MODE=${mode}`,
                `LABORER_OPENCODE_COMMAND=${fakeOpenCodePath}`,
                handlerPath,
              ],
              command: "/usr/bin/env",
              cwd: projectRoot,
              environment: environmentForConfiguredHandler(process.env),
              evidence: { mode: "fixture" },
              stateRoot,
              stateRootAnchor: temporaryRoot,
              timeout: "5 seconds",
            });
            const harness = yield* makePrototypeHarness({
              handler: processHandler.handler,
              laborerSlackId: LABORER_SLACK_ID,
              slack: {
                postThreadMessage: () => Effect.succeed({ ts: "unused" }),
                readActivationContext: () => Effect.succeed([]),
              },
            });

            yield* harness.runner.inject(
              normalizedEvent({
                authorSlackId: "UHUMAN",
                channelId: `C${mode}`,
                eventId: `event:207-${mode}`,
                messageTs: "1.0",
                text: `<@${LABORER_SLACK_ID}> exercise ${mode}`,
              })
            );

            const snapshot = yield* harness.store.snapshot;
            const evidence = yield* processHandler.snapshot;
            const stateDirectory =
              evidence.invocations[0]?.envelope?.stateDirectory;
            assert.ok(stateDirectory);
            assert.strictEqual(
              snapshot.threads[0]?.turns[0]?.outcome?.kind,
              "failure",
              mode
            );
            const files = yield* Effect.promise(() => readdir(stateDirectory));
            assert.ok(files.includes("classifier-worker-state.json"));
            assert.ok(
              EffectArray.every(files, (name) => !name.startsWith("."))
            );
            const diagnosticFiles = pipe(
              files,
              EffectArray.filter((name) => name.startsWith("opencode-stderr."))
            );
            for (const diagnosticFile of diagnosticFiles) {
              const metadata = yield* Effect.promise(() =>
                stat(join(stateDirectory, diagnosticFile))
              );
              assert.ok(metadata.size <= 64 * 1024);
            }
            const expectedDiagnostic = expectedOverflowDiagnostic(mode);
            assert.ok(
              EffectArray.some(evidence.internalStderr, (text) =>
                text.includes(expectedDiagnostic)
              ),
              `${mode} did not report ${expectedDiagnostic}: ${JSON.stringify(evidence.internalStderr)}`
            );
          }
        })
      ),
    30_000
  );

  it.live(
    "cleans up and exits 143 when interrupted by SIGTERM",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const temporaryRoot = yield* makeTempDirectoryScoped(
            "laborer-classifier-signal-"
          );
          const stateDirectory = join(temporaryRoot, "state");
          const startedFile = join(temporaryRoot, "opencode-started");
          yield* Effect.promise(() => mkdir(stateDirectory, { mode: 0o700 }));
          const child = yield* Effect.acquireRelease(
            Effect.sync(() =>
              spawn(handlerPath, [], {
                cwd: projectRoot,
                env: environmentForConfiguredHandler(
                  {
                    ...process.env,
                    FAKE_OPENCODE_MODE: "wait",
                    FAKE_OPENCODE_STARTED: startedFile,
                    LABORER_OPENCODE_COMMAND: fakeOpenCodePath,
                  },
                  [
                    "FAKE_OPENCODE_MODE",
                    "FAKE_OPENCODE_STARTED",
                    "LABORER_OPENCODE_COMMAND",
                  ]
                ),
                stdio: ["pipe", "pipe", "pipe"],
              })
            ),
            (runningChild) =>
              Effect.sync(() => {
                if (runningChild.exitCode === null) {
                  runningChild.kill("SIGKILL");
                }
              })
          );
          child.stdin.end(
            `${JSON.stringify({
              messages: [],
              protocolVersion: 1,
              stateDirectory,
              turnId: "turn:signal",
              workThreadId: "thread:signal",
            })}\n`
          );
          yield* waitForFile(startedFile);
          const exitPromise = waitForExit(child);
          child.kill("SIGTERM");
          const exit = yield* Effect.promise(() => exitPromise);

          assert.deepStrictEqual(exit, { code: 143, signal: null });
          const remainingFiles = yield* Effect.promise(() =>
            readdir(stateDirectory)
          );
          assert.ok(
            EffectArray.every(remainingFiles, (name) => !name.startsWith("."))
          );
          assert.ok(remainingFiles.includes("classifier-worker-state.json"));
          const interruptedState = JSON.parse(
            yield* Effect.promise(() =>
              readFile(
                join(stateDirectory, "classifier-worker-state.json"),
                "utf8"
              )
            )
          ) as {
            readonly pendingMutation?: { readonly status?: string };
          };
          assert.strictEqual(
            interruptedState.pendingMutation?.status,
            "started"
          );
          assert.strictEqual(child.stdout.readableLength, 0);
        })
      ),
    30_000
  );

  it.effect(
    "removes Slack credentials from the configured handler process",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const temporaryRoot = yield* makeTempDirectoryScoped(
            "laborer-configured-handler-environment-"
          );
          const processHandler = yield* makeProcessHandler({
            args: ["--input-type=module", "--eval", environmentProbeHandler],
            command: process.execPath,
            cwd: projectRoot,
            environment: environmentForConfiguredHandler({
              ...process.env,
              SLACK_APP_TOKEN: "must-not-reach-configured-handler",
              SLACK_BOT_TOKEN: "must-not-reach-configured-handler",
            }),
            evidence: { mode: "fixture" },
            stateRoot: join(temporaryRoot, "work-threads"),
            stateRootAnchor: temporaryRoot,
          });
          const harness = yield* makePrototypeHarness({
            handler: processHandler.handler,
            laborerSlackId: LABORER_SLACK_ID,
            slack: {
              postThreadMessage: () => Effect.succeed({ ts: "delivered" }),
              readActivationContext: () => Effect.succeed([]),
            },
          });

          yield* harness.runner.inject(
            normalizedEvent({
              authorSlackId: "UHUMAN",
              channelId: "CENVIRONMENT",
              eventId: "event:207-handler-environment",
              messageTs: "1.0",
              text: `<@${LABORER_SLACK_ID}> inspect handler environment`,
            })
          );

          const state = yield* harness.store.snapshot;
          assert.strictEqual(
            state.threads[0]?.outbox[0]?.text,
            "tokens-absent"
          );
          assert.strictEqual(state.threads[0]?.turns[0]?.status, "completed");
        })
      )
  );

  it.effect("clears the working acknowledgement after handler failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const lifecycle: string[] = [];
        const harness = yield* makePrototypeHarness({
          activationAcknowledger: {
            acknowledge: () =>
              Effect.sync(() => {
                lifecycle.push("acknowledged");
              }),
            complete: () =>
              Effect.sync(() => {
                lifecycle.push("completed");
              }),
          },
          handler: {
            invoke: () =>
              HandlerFailure.make({ category: "exit", safeDetail: null }),
          },
          laborerSlackId: LABORER_SLACK_ID,
          slack: {
            postThreadMessage: () => Effect.succeed({ ts: "notice" }),
            readActivationContext: () => Effect.succeed([]),
          },
        });

        yield* harness.runner.inject(
          normalizedEvent({
            authorSlackId: "UHUMAN",
            channelId: "CFAILURE",
            eventId: "event:207-failure",
            messageTs: "1.0",
            text: `<@${LABORER_SLACK_ID}> fail safely`,
          })
        );

        assert.deepStrictEqual(lifecycle, ["acknowledged", "completed"]);
      })
    )
  );

  it.live(
    "serializes cleanup after a late acknowledgement while the handler is interrupted",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const lifecycle: string[] = [];
          let markAcknowledgementStarted = (): void => {
            assert.fail("acknowledgement start resolver was not initialized");
          };
          const acknowledgementStarted = new Promise<void>((resolveStarted) => {
            markAcknowledgementStarted = resolveStarted;
          });
          let allowAcknowledgement = (): void => {
            assert.fail("acknowledgement resolver was not initialized");
          };
          const acknowledgement = new Promise<void>(
            (resolveAcknowledgement) => {
              allowAcknowledgement = resolveAcknowledgement;
            }
          );
          let markCleanupCompleted = (): void => {
            assert.fail("cleanup resolver was not initialized");
          };
          const cleanupCompleted = new Promise<void>((resolveCleanup) => {
            markCleanupCompleted = resolveCleanup;
          });
          const activationAcknowledger = makeSlackActivationAcknowledger({
            reactions: {
              add: () => {
                lifecycle.push("acknowledging");
                markAcknowledgementStarted();
                return acknowledgement;
              },
              remove: () => {
                lifecycle.push("completed");
                markCleanupCompleted();
                return Promise.resolve();
              },
            },
          });
          const harness = yield* makePrototypeHarness({
            activationAcknowledger,
            handler: {
              invoke: () =>
                Effect.sync(() => lifecycle.push("handler-started")).pipe(
                  Effect.andThen(Effect.never)
                ),
            },
            laborerSlackId: LABORER_SLACK_ID,
            slack: {
              postThreadMessage: () => Effect.succeed({ ts: "unused" }),
              readActivationContext: () => Effect.succeed([]),
            },
          });
          const fiber = yield* Effect.forkChild(
            harness.runner.inject(
              normalizedEvent({
                authorSlackId: "UHUMAN",
                channelId: "CLATEACK",
                eventId: "event:207-late-ack",
                messageTs: "1.0",
                text: `<@${LABORER_SLACK_ID}> wait for acknowledgement`,
              })
            )
          );
          yield* Effect.promise(() => acknowledgementStarted);
          const interruptFiber = yield* Effect.forkChild(
            Fiber.interrupt(fiber)
          );
          yield* Effect.yieldNow;
          assert.deepStrictEqual(lifecycle, [
            "acknowledging",
            "handler-started",
          ]);

          allowAcknowledgement();
          lifecycle.push("acknowledged");
          yield* Fiber.join(interruptFiber);
          yield* Effect.promise(() => cleanupCompleted);

          assert.deepStrictEqual(lifecycle, [
            "acknowledging",
            "handler-started",
            "acknowledged",
            "completed",
          ]);
        })
      )
  );
});
