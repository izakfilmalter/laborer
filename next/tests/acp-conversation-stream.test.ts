import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Array as EffectArray, Fiber, pipe, Ref } from "effect";
import { makeAcpConversationAgent } from "../src/acp-conversation-prototype/acp-conversation-agent.ts";
import { terminateSupervisedProcess } from "../src/adapters/process-supervisor.ts";
import {
  type EmulatedSlackFixture,
  startEmulatedSlack,
} from "../src/prototype/emulated-slack.ts";
import { RECOVERY_NOTICE_TEXT } from "../src/prototype/recovery-notice.ts";
import { makePrototypeHarness } from "../src/prototype/runtime.ts";
import {
  LABORER_SLACK_ID,
  normalizedEvent,
  postHumanMessage,
  timestampOf,
} from "../src/prototype/scenario.ts";
import type {
  ConversationAgentRequest,
  PublishConversationAgentMessage,
} from "../src/reference-coding-application.ts";
import { makeReferenceCodingApplication } from "../src/reference-coding-application.ts";
import { isProcessRunning } from "./support/process-state.ts";
import { makeTempDirectoryScoped } from "./support/temp-directory.ts";

const projectRoot = process.cwd();
const scriptedPeerPath = resolve(
  projectRoot,
  "tests/fixtures/scripted-acp-peer.ts"
);
const fakeOpenCodePath = resolve(
  projectRoot,
  "tests/fixtures/fake-opencode-acp.sh"
);
const EXPECTED_PARTIAL = "**Streaming** from ACP";
const EXPECTED_COMPLETE = `${EXPECTED_PARTIAL}\n\n- complete\n- unchanged`;
const EXPECTED_BLOCKED_NOTICE = RECOVERY_NOTICE_TEXT.blocked;
const EXPECTED_SEMANTIC_MESSAGES = [
  "**First** message",
  "Second message",
  "Fallback message",
] as const;
const OBSERVATION_TIMEOUT_MILLIS = 5000;
const forbiddenPublicFragments = [
  '"jsonrpc"',
  "acp-session-secret-234",
  "acp-message-secret-234",
  "acp-thought-secret-234",
  "end_turn",
  "ACP STDERR SECRET 234",
  "INTERNAL THOUGHT SECRET 234",
  "PROMPT SECRET 234",
  "ACP USER ECHO SECRET 236",
  "ACP THOUGHT SECRET 236",
  "ACP LATE THOUGHT SECRET 236",
  "ACP PLAN SECRET 236",
  "ACP TOOL INPUT SECRET 236",
  "ACP TOOL TITLE SECRET 236",
  "ACP TOOL OUTPUT SECRET 236",
  "ACP COMMAND SECRET 236",
  "ACP PROTOCOL METADATA SECRET 236",
  "ACP SESSION TITLE SECRET 236",
  "ACP CHUNK METADATA SECRET 236",
  "ACP FAILURE DIAGNOSTIC SECRET 236",
  "acp-first-message-secret-236",
  "acp-second-message-secret-236",
  "acp-follow-up-message-secret-236",
  "acp-failure-message-secret-236",
  "acp-user-message-secret-236",
  "acp-thought-message-secret-236",
  "acp-tool-call-secret-236",
  "acp-command-secret-236",
  "acp-mode-secret-236",
] as const;

const waitForFile = Effect.fnUntraced(function* (path: string) {
  const deadline = Date.now() + OBSERVATION_TIMEOUT_MILLIS;
  while (Date.now() < deadline) {
    const exists = yield* Effect.promise(async () => {
      try {
        const metadata = await stat(path);
        return metadata.size > 0;
      } catch {
        return false;
      }
    });
    if (exists) {
      return;
    }
    yield* Effect.sleep("10 millis");
  }
  return yield* Effect.die(new Error(`timed out waiting for ${path}`));
});

const waitForProcessExit = Effect.fnUntraced(function* (pidPath: string) {
  const pid = Number(yield* Effect.promise(() => readFile(pidPath, "utf8")));
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  const deadline = Date.now() + OBSERVATION_TIMEOUT_MILLIS;
  while (Date.now() < deadline) {
    const isRunning = yield* Effect.sync(() => isProcessRunning(pid));
    if (!isRunning) {
      return;
    }
    yield* Effect.sleep("10 millis");
  }
  return yield* Effect.die(
    new Error(`scoped scripted ACP peer ${pid} did not exit`)
  );
});

const nonEmptyLines = (content: string): string[] =>
  pipe(
    content.split("\n"),
    EffectArray.filter((line) => line.length > 0)
  );

const nonEmptyFileLines = Effect.fnUntraced(function* (path: string) {
  const content = yield* Effect.promise(() => readFile(path, "utf8"));
  return nonEmptyLines(content);
});

const waitForFileLineCount = Effect.fnUntraced(function* (
  path: string,
  expectedCount: number
) {
  const deadline = Date.now() + OBSERVATION_TIMEOUT_MILLIS;
  while (Date.now() < deadline) {
    const lines = yield* Effect.promise(async () => {
      try {
        const content = await readFile(path, "utf8");
        return nonEmptyLines(content);
      } catch {
        return [];
      }
    });
    if (lines.length === expectedCount) {
      return lines;
    }
    yield* Effect.sleep("10 millis");
  }
  return yield* Effect.die(
    new Error(`timed out waiting for ${expectedCount} lines in ${path}`)
  );
});

const conversationRequest = (promptId: string): ConversationAgentRequest => ({
  actions: [],
  context: [],
  conversationId: "conversation:234-cancellation",
  conversationSessionId: "logical-session:234-cancellation",
  conversationSessionIsNew: promptId === "prompt:one",
  executionControls: [],
  executions: [],
  input: `Prompt ${promptId}`,
  messages: [],
  promptId,
  source: "slack",
  turnId: `turn:${promptId}`,
});

const botReplies = Effect.fnUntraced(function* (
  fixture: EmulatedSlackFixture,
  rootTs: string
) {
  const response = yield* Effect.promise(() =>
    fixture.humanClient.conversations.replies({
      channel: fixture.channelId,
      limit: 100,
      ts: rootTs,
    })
  );
  return pipe(
    (response.messages ?? []) as Record<string, unknown>[],
    EffectArray.filter((message) => message.user === fixture.botUserId)
  );
});

const replyTimestamp = (
  reply: Record<string, unknown> | undefined,
  description: string
): string => {
  const timestamp = reply?.ts;
  if (typeof timestamp !== "string" || timestamp === "") {
    assert.fail(`${description} must have a timestamp`);
  }
  return timestamp;
};

const waitForBotReplyText = Effect.fnUntraced(function* (
  fixture: EmulatedSlackFixture,
  rootTs: string,
  expectedText: string
) {
  const deadline = Date.now() + OBSERVATION_TIMEOUT_MILLIS;
  let observed: readonly Record<string, unknown>[] = [];
  while (Date.now() < deadline) {
    const replies = yield* botReplies(fixture, rootTs);
    observed = replies;
    if (replies.length === 1 && replies[0]?.text === expectedText) {
      return replies;
    }
    yield* Effect.sleep("10 millis");
  }
  return yield* Effect.die(
    new Error(
      `timed out waiting for Emulate Slack text: ${expectedText}; observed: ${observed.map((reply) => String(reply.text ?? "")).join(" | ")}`
    )
  );
});

const waitForBotReplyTexts = Effect.fnUntraced(function* (
  fixture: EmulatedSlackFixture,
  rootTs: string,
  expectedTexts: readonly string[]
) {
  const deadline = Date.now() + OBSERVATION_TIMEOUT_MILLIS;
  let observedTexts: readonly string[] = [];
  while (Date.now() < deadline) {
    const replies = yield* botReplies(fixture, rootTs);
    const texts = pipe(
      replies,
      EffectArray.map((message) => String(message.text ?? ""))
    );
    observedTexts = texts;
    if (
      texts.length === expectedTexts.length &&
      EffectArray.every(texts, (text, index) => text === expectedTexts[index])
    ) {
      return replies;
    }
    yield* Effect.sleep("10 millis");
  }
  return yield* Effect.die(
    new Error(
      `timed out waiting for Emulate Slack texts: ${expectedTexts.join(" | ")}; observed: ${observedTexts.join(" | ")}`
    )
  );
});

const makeAcpHarness = Effect.fnUntraced(function* (
  fixture: EmulatedSlackFixture,
  environment: NodeJS.ProcessEnv
) {
  const conversationAgent = yield* makeAcpConversationAgent({
    args: [scriptedPeerPath],
    command: process.execPath,
    cwd: projectRoot,
    environment,
  });
  const application = yield* makeReferenceCodingApplication({
    conversationAgent,
    implementationAgent: {
      start: () =>
        Effect.die(
          new Error("implementation agent is outside ACP stream proof")
        ),
    },
    worktreeManager: {
      create: () =>
        Effect.die(new Error("Actions are outside ACP stream proof")),
    },
  });
  return yield* makePrototypeHarness({
    application,
    laborerSlackId: LABORER_SLACK_ID,
    slack: fixture.gateway,
  });
});

const assertSafeBotReplies = (
  fixture: EmulatedSlackFixture,
  rootTs: string,
  replies: readonly Record<string, unknown>[]
): void => {
  for (const reply of replies) {
    assert.strictEqual(reply.user, fixture.botUserId);
    assert.strictEqual(reply.thread_ts, rootTs);
  }
  const publicText = pipe(
    replies,
    EffectArray.map((message) => String(message.text ?? "")),
    (parts) => parts.join("\n")
  );
  assert.ok(
    EffectArray.every(
      forbiddenPublicFragments,
      (fragment) => !publicText.includes(fragment)
    )
  );
  assert.ok(!publicText.includes('"jsonrpc"'));
};

describe("issues #234 and #236 ACP Markdown stream", () => {
  it.live(
    "handles fallback terminal stop reasons through the Laborer conversation adapter",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const temporaryRoot = yield* makeTempDirectoryScoped(
            "laborer-acp-stop-reasons-"
          );
          const scenarios = [
            { scenario: "max-tokens", stopReason: "max_tokens" },
            {
              scenario: "max-turn-requests",
              stopReason: "max_turn_requests",
            },
          ] as const;
          for (const scenario of scenarios) {
            yield* Effect.scoped(
              Effect.gen(function* () {
                const stopReasonLogPath = join(
                  temporaryRoot,
                  `${scenario.scenario}-stop-reason.log`
                );
                const conversationAgent = yield* makeAcpConversationAgent({
                  args: [scriptedPeerPath],
                  command: process.execPath,
                  cwd: temporaryRoot,
                  environment: {
                    HOME: temporaryRoot,
                    PATH: process.env.PATH,
                    SCRIPTED_ACP_READY_PATH: join(
                      temporaryRoot,
                      `${scenario.scenario}-ready`
                    ),
                    SCRIPTED_ACP_RELEASE_PATH: join(
                      temporaryRoot,
                      `${scenario.scenario}-release`
                    ),
                    SCRIPTED_ACP_SCENARIO: scenario.scenario,
                    SCRIPTED_ACP_STOP_REASON_LOG_PATH: stopReasonLogPath,
                  },
                });
                const published = yield* Ref.make<readonly string[]>([]);
                const publishMessage: PublishConversationAgentMessage = (
                  message
                ) =>
                  Ref.update(published, (current) =>
                    EffectArray.append(current, message.text)
                  );
                const result = yield* conversationAgent.handle(
                  conversationRequest(`prompt:${scenario.scenario}`),
                  publishMessage
                );
                assert.deepStrictEqual(result, []);
                assert.deepStrictEqual(yield* Ref.get(published), [
                  `Scripted ${scenario.stopReason} coverage`,
                ]);
                assert.deepStrictEqual(
                  yield* nonEmptyFileLines(stopReasonLogPath),
                  [scenario.stopReason]
                );
              })
            );
          }
        })
      ),
    30_000
  );

  it.effect(
    "never signals a numeric process group after its owned leader exits",
    () =>
      Effect.gen(function* () {
        let directSignals = 0;
        let groupSignals = 0;
        const exitedLeader = {
          exitCode: 0,
          kill: () => {
            directSignals += 1;
            return true;
          },
          pid: 424_244,
          signalCode: null,
        } as unknown as ChildProcessWithoutNullStreams;

        yield* Effect.promise(() =>
          terminateSupervisedProcess(exitedLeader, 10, true, {
            signalProcessGroup: () => {
              groupSignals += 1;
              return true;
            },
          })
        );

        assert.strictEqual(groupSignals, 0);
        assert.strictEqual(directSignals, 0);
      })
  );

  it.effect(
    "fails closed when process-group inspection omits the owned leader",
    () =>
      Effect.gen(function* () {
        let directSignals = 0;
        const groupSignals: NodeJS.Signals[] = [];
        const leader = Object.assign(new EventEmitter(), {
          exitCode: null as number | null,
          kill: () => {
            directSignals += 1;
            leader.exitCode = 0;
            leader.emit("exit", 0, null);
            return true;
          },
          pid: 424_245,
          signalCode: null as NodeJS.Signals | null,
        }) as unknown as ChildProcessWithoutNullStreams;

        const outcome = yield* Effect.promise(() =>
          terminateSupervisedProcess(leader, 1, true, {
            processGroupMembers: async () => [],
            signalProcessGroup: (_processGroupId, signal) => {
              groupSignals.push(signal);
              if (signal === "SIGKILL") {
                leader.exitCode = 0;
                leader.emit("exit", 0, signal);
              }
              return true;
            },
          })
        );

        assert.strictEqual(outcome, "kill");
        assert.deepStrictEqual(groupSignals, ["SIGTERM", "SIGKILL"]);
        assert.strictEqual(directSignals, 0);
      })
  );

  it.live(
    "posts partial Markdown while the ACP prompt is pending and updates it after release",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* startEmulatedSlack();
          const temporaryRoot = yield* makeTempDirectoryScoped(
            "laborer-acp-stream-"
          );
          const readyPath = join(temporaryRoot, "prompt-pending");
          const releasePath = join(temporaryRoot, "release-prompt");
          const exitPath = join(temporaryRoot, "peer-exited");
          const pidPath = join(temporaryRoot, "peer-pid");
          yield* Effect.scoped(
            Effect.gen(function* () {
              const conversationAgent = yield* makeAcpConversationAgent({
                args: [scriptedPeerPath],
                command: process.execPath,
                cwd: projectRoot,
                environment: {
                  ...process.env,
                  SCRIPTED_ACP_EXIT_PATH: exitPath,
                  SCRIPTED_ACP_PID_PATH: pidPath,
                  SCRIPTED_ACP_READY_PATH: readyPath,
                  SCRIPTED_ACP_RELEASE_PATH: releasePath,
                },
              });
              const application = yield* makeReferenceCodingApplication({
                conversationAgent,
                implementationAgent: {
                  start: () =>
                    Effect.die(
                      new Error("implementation agent is outside issue #234")
                    ),
                },
                worktreeManager: {
                  create: () =>
                    Effect.die(new Error("Actions are outside issue #234")),
                },
              });
              const harness = yield* makePrototypeHarness({
                application,
                laborerSlackId: LABORER_SLACK_ID,
                slack: fixture.gateway,
              });
              const promptText = `<@${LABORER_SLACK_ID}> PROMPT SECRET 234`;
              const root = yield* postHumanMessage(fixture, promptText);
              const rootTs = timestampOf(root);
              const turnFiber = yield* Effect.forkChild(
                harness.runner.inject(
                  normalizedEvent({
                    authorSlackId: fixture.humanUserId,
                    channelId: fixture.channelId,
                    eventId: "event:234-acp-stream",
                    messageTs: rootTs,
                    text: promptText,
                  })
                )
              );

              yield* waitForFile(readyPath);
              assert.strictEqual(turnFiber.pollUnsafe(), undefined);
              const partialReplies = yield* waitForBotReplyText(
                fixture,
                rootTs,
                EXPECTED_PARTIAL
              );
              assert.strictEqual(partialReplies[0]?.thread_ts, rootTs);
              const partialReplyTs = replyTimestamp(
                partialReplies[0],
                "partial Slack reply"
              );

              yield* Effect.promise(() =>
                writeFile(releasePath, "release", { mode: 0o600 })
              );
              yield* Fiber.join(turnFiber);

              const completedReplies = yield* waitForBotReplyText(
                fixture,
                rootTs,
                EXPECTED_COMPLETE
              );
              assert.strictEqual(completedReplies[0]?.thread_ts, rootTs);
              assert.strictEqual(
                completedReplies[0]?.ts,
                partialReplyTs,
                "later ACP chunks must update the original Slack reply"
              );
              const allPublicText = pipe(
                completedReplies,
                EffectArray.map((message) => String(message.text ?? "")),
                (parts) => parts.join("\n")
              );
              assert.ok(
                EffectArray.every(
                  forbiddenPublicFragments,
                  (fragment) => !allPublicText.includes(fragment)
                )
              );
              assert.ok(!allPublicText.includes('{"type":"reply"'));
            })
          );
          yield* waitForFile(exitPath);
          yield* waitForProcessExit(pidPath);
        })
      ),
    30_000
  );

  it.live(
    "cancels an interrupted prompt and replaces its disposed ACP session",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const temporaryRoot = yield* makeTempDirectoryScoped(
            "laborer-acp-cancellation-"
          );
          const cancelledPath = join(temporaryRoot, "prompt-cancelled");
          const exitPath = join(temporaryRoot, "peer-exited");
          const readyPath = join(temporaryRoot, "prompt-pending");
          const releasePath = join(temporaryRoot, "release-prompt");
          const sessionCountPath = join(temporaryRoot, "session-count");
          const pidPath = join(temporaryRoot, "peer-pid");
          yield* Effect.scoped(
            Effect.gen(function* () {
              const conversationAgent = yield* makeAcpConversationAgent({
                args: [scriptedPeerPath],
                command: process.execPath,
                cwd: projectRoot,
                environment: {
                  ...process.env,
                  SCRIPTED_ACP_CANCELLED_PATH: cancelledPath,
                  SCRIPTED_ACP_EXIT_PATH: exitPath,
                  SCRIPTED_ACP_PID_PATH: pidPath,
                  SCRIPTED_ACP_READY_PATH: readyPath,
                  SCRIPTED_ACP_RELEASE_PATH: releasePath,
                  SCRIPTED_ACP_SESSION_COUNT_PATH: sessionCountPath,
                },
              });
              const promptFiber = yield* Effect.forkChild(
                conversationAgent.handle(
                  conversationRequest("prompt:one"),
                  () => Effect.void
                )
              );
              yield* waitForFile(readyPath);
              yield* Fiber.interrupt(promptFiber);
              yield* waitForFile(cancelledPath);

              yield* Effect.promise(() =>
                writeFile(releasePath, "release", { mode: 0o600 })
              );
              yield* conversationAgent.handle(
                conversationRequest("prompt:two"),
                () => Effect.void
              );
              assert.strictEqual(
                yield* Effect.promise(() => readFile(sessionCountPath, "utf8")),
                "2"
              );
            })
          );
          yield* waitForFile(exitPath);
          yield* waitForProcessExit(pidPath);
        })
      ),
    30_000
  );

  it.live(
    "re-resolves the ACP session after a queued direct turn waits for a failing turn",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const temporaryRoot = yield* makeTempDirectoryScoped(
            "laborer-acp-queued-session-"
          );
          const exitPath = join(temporaryRoot, "peer-exited");
          const pidPath = join(temporaryRoot, "peer-pid");
          const promptLogPath = join(temporaryRoot, "prompt-log");
          const readyPath = join(temporaryRoot, "prompt-pending");
          const releasePath = join(temporaryRoot, "release-prompt");
          const sessionCountPath = join(temporaryRoot, "session-count");
          yield* Effect.scoped(
            Effect.gen(function* () {
              const conversationAgent = yield* makeAcpConversationAgent({
                args: [scriptedPeerPath],
                command: process.execPath,
                cwd: projectRoot,
                environment: {
                  ...process.env,
                  SCRIPTED_ACP_EXIT_PATH: exitPath,
                  SCRIPTED_ACP_PID_PATH: pidPath,
                  SCRIPTED_ACP_PROMPT_LOG_PATH: promptLogPath,
                  SCRIPTED_ACP_READY_PATH: readyPath,
                  SCRIPTED_ACP_RELEASE_PATH: releasePath,
                  SCRIPTED_ACP_SCENARIO: "queued-failure",
                  SCRIPTED_ACP_SESSION_COUNT_PATH: sessionCountPath,
                },
              });
              const published = yield* Ref.make<readonly string[]>([]);
              const publishMessage: PublishConversationAgentMessage = (
                message
              ) =>
                Ref.update(published, (current) =>
                  EffectArray.append(current, message.text)
                );
              const firstFiber = yield* Effect.forkChild(
                Effect.result(
                  conversationAgent.handle(
                    conversationRequest("prompt:one"),
                    publishMessage
                  )
                )
              );
              yield* waitForFile(readyPath);

              const secondFiber = yield* Effect.forkChild(
                Effect.result(
                  conversationAgent.handle(
                    conversationRequest("prompt:two"),
                    publishMessage
                  )
                )
              );
              yield* Effect.sleep("25 millis");
              assert.deepStrictEqual(yield* nonEmptyFileLines(promptLogPath), [
                "acp-session-secret-234-1\tPrompt prompt:one",
              ]);

              yield* Effect.promise(() =>
                writeFile(releasePath, "release", { mode: 0o600 })
              );
              const firstResult = yield* Fiber.join(firstFiber);
              const secondResult = yield* Fiber.join(secondFiber);
              assert.strictEqual(firstResult._tag, "Failure");
              assert.strictEqual(secondResult._tag, "Success");
              assert.deepStrictEqual(yield* Ref.get(published), [
                "First turn partial",
                "Queued turn recovered",
              ]);
              assert.deepStrictEqual(
                yield* waitForFileLineCount(promptLogPath, 2),
                [
                  "acp-session-secret-234-1\tPrompt prompt:one",
                  "acp-session-secret-234-2\tPrompt prompt:two",
                ]
              );
              assert.strictEqual(
                yield* Effect.promise(() => readFile(sessionCountPath, "utf8")),
                "2"
              );
            })
          );
          yield* waitForFile(exitPath);
          yield* waitForProcessExit(pidPath);
        })
      ),
    30_000
  );

  it.live("turns asynchronous spawn errors into sanitized failures", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const result = yield* Effect.result(
          makeAcpConversationAgent({
            command: "/definitely/missing/laborer-acp-peer-234",
            cwd: projectRoot,
          })
        );
        assert.strictEqual(result._tag, "Failure");
        if (result._tag === "Failure") {
          const safeDetail = result.failure.safeDetail;
          assert.strictEqual(result.failure.category, "protocol");
          assert.strictEqual(safeDetail, "ACP Conversation agent failed");
          assert.ok(!safeDetail?.includes("/definitely/missing"));
        }
      })
    )
  );

  it.live(
    "preserves public message boundaries, filters private updates, reuses the session, and queues the follow-up prompt",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* startEmulatedSlack();
          const temporaryRoot = yield* makeTempDirectoryScoped(
            "laborer-acp-semantics-"
          );
          const exitPath = join(temporaryRoot, "peer-exited");
          const pidPath = join(temporaryRoot, "peer-pid");
          const promptLogPath = join(temporaryRoot, "prompt-log");
          const readyPath = join(temporaryRoot, "prompt-pending");
          const releasePath = join(temporaryRoot, "release-prompt");
          yield* Effect.scoped(
            Effect.gen(function* () {
              const harness = yield* makeAcpHarness(fixture, {
                ...process.env,
                SCRIPTED_ACP_EXIT_PATH: exitPath,
                SCRIPTED_ACP_PID_PATH: pidPath,
                SCRIPTED_ACP_PROMPT_LOG_PATH: promptLogPath,
                SCRIPTED_ACP_READY_PATH: readyPath,
                SCRIPTED_ACP_RELEASE_PATH: releasePath,
                SCRIPTED_ACP_SCENARIO: "semantics",
              });
              const firstInput = `<@${LABORER_SLACK_ID}> preserve message boundaries`;
              const root = yield* postHumanMessage(fixture, firstInput);
              const rootTs = timestampOf(root);
              yield* harness.runner.accept(
                normalizedEvent({
                  authorSlackId: fixture.humanUserId,
                  channelId: fixture.channelId,
                  eventId: "event:236-semantics-first",
                  messageTs: rootTs,
                  text: firstInput,
                })
              );

              yield* waitForFile(readyPath);
              const initialReplies = yield* waitForBotReplyTexts(
                fixture,
                rootTs,
                EXPECTED_SEMANTIC_MESSAGES
              );
              assertSafeBotReplies(fixture, rootTs, initialReplies);
              const initialReplyTimestamps = initialReplies.map(
                (reply, index) =>
                  replyTimestamp(reply, `ACP message ${index + 1} Slack reply`)
              );
              assert.strictEqual(
                new Set(initialReplyTimestamps).size,
                EXPECTED_SEMANTIC_MESSAGES.length,
                "each ACP message boundary must create one distinct Slack reply"
              );

              const followUpInput = "queued participant follow-up";
              const followUp = yield* postHumanMessage(fixture, followUpInput, {
                threadTs: rootTs,
              });
              yield* harness.runner.accept(
                normalizedEvent({
                  authorSlackId: fixture.humanUserId,
                  channelId: fixture.channelId,
                  eventId: "event:236-semantics-follow-up",
                  messageTs: timestampOf(followUp),
                  text: followUpInput,
                  threadTs: rootTs,
                })
              );
              assert.deepStrictEqual(yield* nonEmptyFileLines(promptLogPath), [
                `acp-session-secret-234-1\t${firstInput}`,
              ]);

              yield* Effect.promise(() =>
                writeFile(releasePath, "release", { mode: 0o600 })
              );
              const completedReplies = yield* waitForBotReplyTexts(
                fixture,
                rootTs,
                [...EXPECTED_SEMANTIC_MESSAGES, "Follow-up complete"]
              );
              assertSafeBotReplies(fixture, rootTs, completedReplies);
              assert.deepStrictEqual(
                completedReplies
                  .slice(0, EXPECTED_SEMANTIC_MESSAGES.length)
                  .map((reply, index) =>
                    replyTimestamp(
                      reply,
                      `completed ACP message ${index + 1} Slack reply`
                    )
                  ),
                initialReplyTimestamps,
                "prompt completion and the queued turn must not duplicate prior replies"
              );
              const followUpReplyTs = replyTimestamp(
                completedReplies.at(-1),
                "follow-up Slack reply"
              );
              assert.ok(!initialReplyTimestamps.includes(followUpReplyTs));
              const promptLines = yield* waitForFileLineCount(promptLogPath, 2);
              assert.deepStrictEqual(promptLines, [
                `acp-session-secret-234-1\t${firstInput}`,
                `acp-session-secret-234-1\t${followUpInput}`,
              ]);
            })
          );
          yield* waitForFile(exitPath);
          yield* waitForProcessExit(pidPath);
        })
      ),
    30_000
  );

  it.live(
    "keeps partial Markdown and follows it with a separate sanitized notice when the ACP prompt fails",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* startEmulatedSlack();
          const temporaryRoot = yield* makeTempDirectoryScoped(
            "laborer-acp-failure-"
          );
          const exitPath = join(temporaryRoot, "peer-exited");
          const pidPath = join(temporaryRoot, "peer-pid");
          const readyPath = join(temporaryRoot, "prompt-pending");
          const releasePath = join(temporaryRoot, "release-prompt");
          yield* Effect.scoped(
            Effect.gen(function* () {
              const harness = yield* makeAcpHarness(fixture, {
                ...process.env,
                SCRIPTED_ACP_EXIT_PATH: exitPath,
                SCRIPTED_ACP_PID_PATH: pidPath,
                SCRIPTED_ACP_READY_PATH: readyPath,
                SCRIPTED_ACP_RELEASE_PATH: releasePath,
                SCRIPTED_ACP_SCENARIO: "failure",
              });
              const input = `<@${LABORER_SLACK_ID}> fail after public text`;
              const root = yield* postHumanMessage(fixture, input);
              const rootTs = timestampOf(root);
              yield* harness.runner.accept(
                normalizedEvent({
                  authorSlackId: fixture.humanUserId,
                  channelId: fixture.channelId,
                  eventId: "event:236-partial-failure",
                  messageTs: rootTs,
                  text: input,
                })
              );

              yield* waitForFile(readyPath);
              const partialReplies = yield* waitForBotReplyTexts(
                fixture,
                rootTs,
                ["Partial answer stays."]
              );
              assertSafeBotReplies(fixture, rootTs, partialReplies);
              const partialReplyTs = replyTimestamp(
                partialReplies[0],
                "partial Slack reply"
              );
              yield* Effect.promise(() =>
                writeFile(releasePath, "release", { mode: 0o600 })
              );

              const failedReplies = yield* waitForBotReplyTexts(
                fixture,
                rootTs,
                ["Partial answer stays.", EXPECTED_BLOCKED_NOTICE]
              );
              assertSafeBotReplies(fixture, rootTs, failedReplies);
              assert.strictEqual(
                failedReplies[0]?.ts,
                partialReplyTs,
                "a failed ACP prompt must not retract or replace partial output"
              );
              const noticeTs = replyTimestamp(
                failedReplies[1],
                "sanitized failure notice"
              );
              assert.notStrictEqual(
                noticeTs,
                partialReplyTs,
                "the sanitized failure notice must be a separate Slack reply"
              );
            })
          );
          yield* waitForFile(exitPath);
          yield* waitForProcessExit(pidPath);
        })
      ),
    30_000
  );

  it.live("rejects the configured process-lifetime ACP byte bound", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const temporaryRoot = yield* makeTempDirectoryScoped(
          "laborer-acp-process-byte-bound-"
        );
        const pidPath = join(temporaryRoot, "peer-pid");
        const readyPath = join(temporaryRoot, "prompt-pending");
        const releasePath = join(temporaryRoot, "release-prompt");
        const result = yield* Effect.scoped(
          Effect.result(
            makeAcpConversationAgent({
              args: [scriptedPeerPath],
              childExitGraceMillis: 100,
              command: process.execPath,
              cwd: projectRoot,
              environment: {
                ...process.env,
                SCRIPTED_ACP_PID_PATH: pidPath,
                SCRIPTED_ACP_READY_PATH: readyPath,
                SCRIPTED_ACP_RELEASE_PATH: releasePath,
              },
              inboundLimits: { maxProcessBytes: 32 },
            })
          )
        );
        assert.strictEqual(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.strictEqual(
            result.failure.safeDetail,
            "ACP Conversation agent failed"
          );
        }
        yield* waitForProcessExit(pidPath);
      })
    )
  );

  it.live("rejects the configured process-lifetime ACP record bound", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const temporaryRoot = yield* makeTempDirectoryScoped(
          "laborer-acp-process-record-bound-"
        );
        const pidPath = join(temporaryRoot, "peer-pid");
        const readyPath = join(temporaryRoot, "prompt-pending");
        const releasePath = join(temporaryRoot, "release-prompt");
        yield* Effect.scoped(
          Effect.gen(function* () {
            const conversationAgent = yield* makeAcpConversationAgent({
              args: [scriptedPeerPath],
              childExitGraceMillis: 100,
              command: process.execPath,
              cwd: projectRoot,
              environment: {
                ...process.env,
                SCRIPTED_ACP_PID_PATH: pidPath,
                SCRIPTED_ACP_READY_PATH: readyPath,
                SCRIPTED_ACP_RELEASE_PATH: releasePath,
              },
              inboundLimits: { maxProcessRecords: 1 },
            });
            const result = yield* Effect.result(
              conversationAgent.handle(
                conversationRequest("prompt:record-bound"),
                () => Effect.void
              )
            );
            assert.strictEqual(result._tag, "Failure");
            if (result._tag === "Failure") {
              assert.strictEqual(
                result.failure.safeDetail,
                "ACP Conversation agent failed"
              );
            }
          })
        );
        yield* waitForProcessExit(pidPath);
      })
    )
  );

  it.live("rejects an oversized ACP NDJSON line and reaps the child", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const temporaryRoot = yield* makeTempDirectoryScoped(
          "laborer-acp-line-bound-"
        );
        const launchLogPath = join(temporaryRoot, "launch.json");
        const pidPath = join(temporaryRoot, "peer-pid");
        const pathEnvironment = process.env.PATH;
        assert.ok(pathEnvironment !== undefined);
        const result = yield* Effect.scoped(
          Effect.result(
            makeAcpConversationAgent({
              args: ["acp"],
              childExitGraceMillis: 100,
              command: fakeOpenCodePath,
              cwd: projectRoot,
              environment: {
                FAKE_ACP_LAUNCH_LOG: launchLogPath,
                FAKE_ACP_LINE_BYTES: String(3 * 1024 * 1024),
                FAKE_ACP_MODE: "oversized-line",
                FAKE_ACP_RUNTIME: process.execPath,
                PATH: pathEnvironment,
                SCRIPTED_ACP_PID_PATH: pidPath,
              },
            })
          )
        );
        assert.strictEqual(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.strictEqual(
            result.failure.safeDetail,
            "ACP Conversation agent failed"
          );
        }
        yield* waitForFile(pidPath);
        yield* waitForProcessExit(pidPath);
      })
    )
  );

  it.live("surfaces a post-start child exit as a sanitized failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const temporaryRoot = yield* makeTempDirectoryScoped(
          "laborer-acp-post-start-exit-"
        );
        const exitAfterInitializePath = join(
          temporaryRoot,
          "exit-after-initialize"
        );
        const pidPath = join(temporaryRoot, "peer-pid");
        const readyPath = join(temporaryRoot, "prompt-pending");
        const releasePath = join(temporaryRoot, "release-prompt");
        yield* Effect.scoped(
          Effect.gen(function* () {
            const conversationAgent = yield* makeAcpConversationAgent({
              args: [scriptedPeerPath],
              childExitGraceMillis: 100,
              command: process.execPath,
              cwd: projectRoot,
              environment: {
                ...process.env,
                SCRIPTED_ACP_EXIT_AFTER_INITIALIZE_PATH:
                  exitAfterInitializePath,
                SCRIPTED_ACP_PID_PATH: pidPath,
                SCRIPTED_ACP_READY_PATH: readyPath,
                SCRIPTED_ACP_RELEASE_PATH: releasePath,
              },
            });
            yield* waitForFile(exitAfterInitializePath);
            const result = yield* Effect.result(
              conversationAgent.handle(
                conversationRequest("prompt:post-start-exit"),
                () => Effect.void
              )
            );
            assert.strictEqual(result._tag, "Failure");
            if (result._tag === "Failure") {
              assert.strictEqual(
                result.failure.safeDetail,
                "ACP Conversation agent failed"
              );
            }
          })
        );
        yield* waitForProcessExit(pidPath);
      })
    )
  );

  it.live("reaps a child when startup is interrupted after spawn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const temporaryRoot = yield* makeTempDirectoryScoped(
          "laborer-acp-interrupted-startup-"
        );
        const launchLogPath = join(temporaryRoot, "launch.json");
        const pidPath = join(temporaryRoot, "peer-pid");
        const pathEnvironment = process.env.PATH;
        assert.ok(pathEnvironment !== undefined);
        const startup = yield* Effect.forkChild(
          makeAcpConversationAgent({
            args: ["acp"],
            childExitGraceMillis: 100,
            command: fakeOpenCodePath,
            cwd: projectRoot,
            environment: {
              FAKE_ACP_LAUNCH_LOG: launchLogPath,
              FAKE_ACP_MODE: "hang-startup",
              FAKE_ACP_RUNTIME: process.execPath,
              PATH: pathEnvironment,
              SCRIPTED_ACP_PID_PATH: pidPath,
            },
          })
        );
        yield* waitForFile(pidPath);
        yield* Fiber.interrupt(startup);
        yield* waitForProcessExit(pidPath);
      })
    )
  );

  it.live(
    "escalates from TERM to KILL for a non-cooperative scoped child",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const temporaryRoot = yield* makeTempDirectoryScoped(
            "laborer-acp-kill-escalation-"
          );
          const lifecycleLogPath = join(temporaryRoot, "lifecycle.log");
          const pidPath = join(temporaryRoot, "peer-pid");
          const readyPath = join(temporaryRoot, "prompt-pending");
          const releasePath = join(temporaryRoot, "release-prompt");
          const signalLogPath = join(temporaryRoot, "signals.log");
          yield* Effect.scoped(
            makeAcpConversationAgent({
              args: [scriptedPeerPath],
              childExitGraceMillis: 100,
              command: process.execPath,
              cwd: projectRoot,
              environment: {
                ...process.env,
                SCRIPTED_ACP_LIFECYCLE_LOG_PATH: lifecycleLogPath,
                SCRIPTED_ACP_PID_PATH: pidPath,
                SCRIPTED_ACP_READY_PATH: readyPath,
                SCRIPTED_ACP_RELEASE_PATH: releasePath,
                SCRIPTED_ACP_SIGNAL_LOG_PATH: signalLogPath,
                SCRIPTED_ACP_STAY_ALIVE_AFTER_STDIO_CLOSE: "1",
              },
            }).pipe(Effect.asVoid)
          );
          yield* waitForFile(signalLogPath);
          assert.deepStrictEqual(yield* nonEmptyFileLines(signalLogPath), [
            "SIGTERM",
          ]);
          assert.deepStrictEqual(yield* nonEmptyFileLines(lifecycleLogPath), [
            "initialize",
            "stdio:closed",
          ]);
          yield* waitForProcessExit(pidPath);
        })
      )
  );

  it.live(
    "reaps a TERM-resistant descendant after the direct ACP child exits",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const temporaryRoot = yield* makeTempDirectoryScoped(
            "laborer-acp-descendant-reaping-"
          );
          const descendantPidPath = join(temporaryRoot, "descendant-pid");
          const pidPath = join(temporaryRoot, "peer-pid");
          const readyPath = join(temporaryRoot, "prompt-pending");
          const releasePath = join(temporaryRoot, "release-prompt");
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* makeAcpConversationAgent({
                args: [scriptedPeerPath],
                childExitGraceMillis: 100,
                command: process.execPath,
                cwd: projectRoot,
                environment: {
                  ...process.env,
                  SCRIPTED_ACP_DESCENDANT_PID_PATH: descendantPidPath,
                  SCRIPTED_ACP_PID_PATH: pidPath,
                  SCRIPTED_ACP_READY_PATH: readyPath,
                  SCRIPTED_ACP_RELEASE_PATH: releasePath,
                },
              });
              yield* waitForFile(descendantPidPath);
            })
          );
          yield* waitForProcessExit(pidPath);
          yield* waitForProcessExit(descendantPidPath);
        })
      ),
    10_000
  );
});
