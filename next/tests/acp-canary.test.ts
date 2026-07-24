import { readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import {
  Effect,
  Array as EffectArray,
  Fiber,
  pipe,
  Redacted,
  Schema,
} from "effect";
import {
  makeAcpConversationCanary,
  OPEN_CODE_ACP_ARGS,
  OPEN_CODE_ACP_COMMAND,
  openCodeAcpProcessOptions,
} from "../src/acp-conversation-prototype/canary-composition.ts";
import {
  type EmulatedSlackFixture,
  makeSlackActivationAcknowledger,
  makeSlackCompletionReactor,
  startEmulatedSlack,
} from "../src/prototype/emulated-slack.ts";
import {
  LABORER_SLACK_ID,
  normalizedEvent,
  postHumanMessage,
  timestampOf,
} from "../src/prototype/scenario.ts";
import {
  ACP_CANARY_SLACK_APP_TOKEN_VARIABLE,
  ACP_CANARY_SLACK_BOT_TOKEN_VARIABLE,
  loadAcpCanarySlackConfig,
} from "../src/slack/config.ts";
import { environmentForConfiguredHandler } from "../src/slack/handler-environment.ts";
import { makeTempDirectoryScoped } from "./support/temp-directory.ts";

const projectRoot = process.cwd();
const fakeOpenCodePath = resolve(
  projectRoot,
  "tests/fixtures/fake-opencode-acp.sh"
);
const scriptedPeerPath = resolve(
  projectRoot,
  "tests/fixtures/scripted-acp-peer.ts"
);
const OBSERVATION_TIMEOUT_MILLIS = 5000;
const EXPECTED_MARKDOWN = "**Streaming** from ACP\n\n- complete\n- unchanged";
const PIPE_DESCRIPTOR_KIND_PATTERN = /^(fifo|socket)$/;

const FakeStdio = Schema.Struct({
  isTTY: Schema.Boolean,
  kind: Schema.String,
});

const FakeLaunch = Schema.Struct({
  args: Schema.Array(Schema.String),
  cwd: Schema.String,
  stdio: Schema.Struct({
    stderr: Schema.Struct({ ...FakeStdio.fields, writable: Schema.Boolean }),
    stdin: Schema.Struct({ ...FakeStdio.fields, readable: Schema.Boolean }),
    stdout: Schema.Struct({ ...FakeStdio.fields, writable: Schema.Boolean }),
  }),
});

const waitForFile = Effect.fnUntraced(function* (path: string) {
  const deadline = Date.now() + OBSERVATION_TIMEOUT_MILLIS;
  while (Date.now() < deadline) {
    const exists = yield* Effect.promise(async () => {
      try {
        return (await stat(path)).size > 0;
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

const nonEmptyFileLines = Effect.fnUntraced(function* (path: string) {
  const content = yield* Effect.promise(() => readFile(path, "utf8"));
  return pipe(
    content.split("\n"),
    EffectArray.filter((line) => line.length > 0)
  );
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
        return pipe(
          content.split("\n"),
          EffectArray.filter((line) => line.length > 0)
        );
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

const waitForBotTexts = Effect.fnUntraced(function* (
  fixture: EmulatedSlackFixture,
  rootTs: string,
  expectedTexts: readonly string[]
) {
  const deadline = Date.now() + OBSERVATION_TIMEOUT_MILLIS;
  while (Date.now() < deadline) {
    const replies = yield* botReplies(fixture, rootTs);
    const texts = pipe(
      replies,
      EffectArray.map((message) => String(message.text ?? ""))
    );
    if (
      texts.length === expectedTexts.length &&
      EffectArray.every(texts, (text, index) => text === expectedTexts[index])
    ) {
      return replies;
    }
    yield* Effect.sleep("10 millis");
  }
  return yield* Effect.die(
    new Error(`timed out waiting for bot texts: ${expectedTexts.join(" | ")}`)
  );
});

const waitForProcessExit = Effect.fnUntraced(function* (pidPath: string) {
  const pid = Number(yield* Effect.promise(() => readFile(pidPath, "utf8")));
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  const deadline = Date.now() + OBSERVATION_TIMEOUT_MILLIS;
  while (Date.now() < deadline) {
    const exited = yield* Effect.sync(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
    if (exited) {
      return;
    }
    yield* Effect.sleep("10 millis");
  }
  return yield* Effect.die(
    new Error(`fake OpenCode ACP process ${pid} did not exit`)
  );
});

describe("issue #235 opt-in OpenCode ACP canary", () => {
  it.effect(
    "requires dedicated canary Slack credentials and strips every Slack token from the child",
    () =>
      Effect.gen(function* () {
        const appToken = ["x", "app", "-canary-fixture"].join("");
        const botToken = ["x", "oxb", "-canary-fixture"].join("");
        const productionOnly = yield* Effect.result(
          loadAcpCanarySlackConfig({
            SLACK_APP_TOKEN: ["x", "app", "-production-fixture"].join(""),
            SLACK_BOT_TOKEN: ["x", "oxb", "-production-fixture"].join(""),
          })
        );
        assert.strictEqual(productionOnly._tag, "Failure");
        if (productionOnly._tag === "Failure") {
          assert.strictEqual(
            productionOnly.failure.variable,
            ACP_CANARY_SLACK_APP_TOKEN_VARIABLE
          );
        }

        const reusedProduction = yield* Effect.result(
          loadAcpCanarySlackConfig({
            [ACP_CANARY_SLACK_APP_TOKEN_VARIABLE]: appToken,
            [ACP_CANARY_SLACK_BOT_TOKEN_VARIABLE]: botToken,
            SLACK_APP_TOKEN: appToken,
            SLACK_BOT_TOKEN: botToken,
          })
        );
        assert.strictEqual(reusedProduction._tag, "Failure");
        if (reusedProduction._tag === "Failure") {
          assert.strictEqual(
            reusedProduction.failure.reason,
            "matches-production-token"
          );
        }

        const registryTokenVariable = "SLACK_BOT_TOKEN_REGISTRY_FIXTURE";
        const reusedRegistryBinding = yield* Effect.result(
          loadAcpCanarySlackConfig({
            [ACP_CANARY_SLACK_APP_TOKEN_VARIABLE]: appToken,
            [ACP_CANARY_SLACK_BOT_TOKEN_VARIABLE]: botToken,
            LABORER_SLACK_WORKSPACES: JSON.stringify([
              {
                botTokenEnvironment: registryTokenVariable,
                root: projectRoot,
                teamId: "TFIXTURE",
              },
            ]),
            [registryTokenVariable]: botToken,
          })
        );
        assert.strictEqual(reusedRegistryBinding._tag, "Failure");
        if (reusedRegistryBinding._tag === "Failure") {
          assert.strictEqual(
            reusedRegistryBinding.failure.variable,
            ACP_CANARY_SLACK_BOT_TOKEN_VARIABLE
          );
          assert.strictEqual(
            reusedRegistryBinding.failure.reason,
            "matches-production-token"
          );
        }

        const config = yield* loadAcpCanarySlackConfig({
          [ACP_CANARY_SLACK_APP_TOKEN_VARIABLE]: appToken,
          [ACP_CANARY_SLACK_BOT_TOKEN_VARIABLE]: botToken,
        });
        assert.strictEqual(Redacted.value(config.appToken), appToken);
        assert.strictEqual(Redacted.value(config.botToken), botToken);

        const childEnvironment = environmentForConfiguredHandler(
          {
            [ACP_CANARY_SLACK_APP_TOKEN_VARIABLE]: appToken,
            [ACP_CANARY_SLACK_BOT_TOKEN_VARIABLE]: botToken,
            OPENAI_API_KEY: "provider-fixture",
            SLACK_APP_TOKEN: "production-app-fixture",
            SLACK_BOT_TOKEN: "production-bot-fixture",
          },
          [
            ACP_CANARY_SLACK_APP_TOKEN_VARIABLE,
            ACP_CANARY_SLACK_BOT_TOKEN_VARIABLE,
            "OPENAI_API_KEY",
            "SLACK_APP_TOKEN",
            "SLACK_BOT_TOKEN",
          ]
        );
        assert.deepStrictEqual(childEnvironment, {
          OPENAI_API_KEY: "provider-fixture",
        });
      })
  );

  it.live(
    "launches the fake acp target, streams through WebClient into Emulate, reuses its session, and closes stdio",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const defaultTarget = openCodeAcpProcessOptions({ cwd: projectRoot });
          assert.strictEqual(defaultTarget.command, OPEN_CODE_ACP_COMMAND);
          assert.deepStrictEqual(defaultTarget.args, OPEN_CODE_ACP_ARGS);
          assert.strictEqual(defaultTarget.cwd, projectRoot);

          const fixture = yield* startEmulatedSlack();
          assert.strictEqual(fixture.gateway.nativeStreaming, undefined);
          const laborerRoot = yield* makeTempDirectoryScoped(
            "laborer-acp-canary-root-"
          );
          const observationRoot = yield* makeTempDirectoryScoped(
            "laborer-acp-canary-observation-"
          );
          const exitPath = join(observationRoot, "peer-exited");
          const launchLogPath = join(observationRoot, "launch.json");
          const lifecycleLogPath = join(observationRoot, "lifecycle.log");
          const pidPath = join(observationRoot, "peer.pid");
          const promptLogPath = join(observationRoot, "prompts.log");
          const readyPath = join(observationRoot, "prompt-pending");
          const releasePath = join(observationRoot, "release-prompt");
          const sessionLogPath = join(observationRoot, "sessions.log");
          const pathEnvironment = process.env.PATH;
          assert.ok(pathEnvironment !== undefined);

          yield* Effect.scoped(
            Effect.gen(function* () {
              const processOptions = openCodeAcpProcessOptions({
                command: fakeOpenCodePath,
                cwd: laborerRoot,
                environment: {
                  FAKE_ACP_LAUNCH_LOG: launchLogPath,
                  FAKE_ACP_PEER: scriptedPeerPath,
                  FAKE_ACP_RUNTIME: process.execPath,
                  PATH: pathEnvironment,
                  SCRIPTED_ACP_EXIT_PATH: exitPath,
                  SCRIPTED_ACP_LIFECYCLE_LOG_PATH: lifecycleLogPath,
                  SCRIPTED_ACP_PID_PATH: pidPath,
                  SCRIPTED_ACP_PROMPT_LOG_PATH: promptLogPath,
                  SCRIPTED_ACP_READY_PATH: readyPath,
                  SCRIPTED_ACP_RELEASE_PATH: releasePath,
                  SCRIPTED_ACP_SESSION_LOG_PATH: sessionLogPath,
                },
              });
              const harness = yield* makeAcpConversationCanary({
                activationAcknowledger: makeSlackActivationAcknowledger(
                  fixture.botClient
                ),
                completionReactor: makeSlackCompletionReactor(
                  fixture.botClient
                ),
                laborerSlackId: LABORER_SLACK_ID,
                process: processOptions,
                slack: fixture.gateway,
              });
              const firstInput = `<@${LABORER_SLACK_ID}> stream via fake OpenCode ACP`;
              const root = yield* postHumanMessage(fixture, firstInput);
              const rootTs = timestampOf(root);
              const firstTurn = yield* Effect.forkChild(
                harness.runner.inject(
                  normalizedEvent({
                    authorSlackId: fixture.humanUserId,
                    channelId: fixture.channelId,
                    eventId: "event:235-canary-first",
                    messageTs: rootTs,
                    text: firstInput,
                  })
                )
              );

              yield* waitForFile(readyPath);
              const launchSource = yield* Effect.promise(() =>
                readFile(launchLogPath, "utf8")
              );
              const launch = yield* Schema.decodeUnknownEffect(FakeLaunch)(
                JSON.parse(launchSource) as unknown
              );
              assert.deepStrictEqual(launch.args, ["acp"]);
              assert.strictEqual(launch.cwd, laborerRoot);
              assert.deepStrictEqual(launch.stdio, {
                stderr: {
                  isTTY: false,
                  kind: launch.stdio.stderr.kind,
                  writable: true,
                },
                stdin: {
                  isTTY: false,
                  kind: launch.stdio.stdin.kind,
                  readable: true,
                },
                stdout: {
                  isTTY: false,
                  kind: launch.stdio.stdout.kind,
                  writable: true,
                },
              });
              for (const descriptor of [
                launch.stdio.stdin,
                launch.stdio.stdout,
                launch.stdio.stderr,
              ]) {
                assert.match(descriptor.kind, PIPE_DESCRIPTOR_KIND_PATTERN);
              }
              assert.deepStrictEqual(
                yield* nonEmptyFileLines(lifecycleLogPath),
                [
                  "initialize",
                  "session:new:acp-session-secret-234-1",
                  `prompt:acp-session-secret-234-1:${firstInput}`,
                ]
              );

              const partialReplies = yield* waitForBotTexts(fixture, rootTs, [
                "**Streaming** from ACP",
              ]);
              const streamedMessageTs = String(partialReplies[0]?.ts);
              yield* Effect.promise(() =>
                writeFile(releasePath, "release", { mode: 0o600 })
              );
              yield* Fiber.join(firstTurn);
              const completedFirstReplies = yield* waitForBotTexts(
                fixture,
                rootTs,
                [EXPECTED_MARKDOWN]
              );
              assert.strictEqual(
                completedFirstReplies[0]?.ts,
                streamedMessageTs
              );
              assert.ok(
                !String(completedFirstReplies[0]?.text).includes(
                  '{"type":"reply"'
                )
              );
              const completedReaction = yield* Effect.promise(() =>
                fixture.humanClient.reactions.get({
                  channel: fixture.channelId,
                  timestamp: rootTs,
                })
              );
              assert.ok(
                completedReaction.message?.reactions?.some(
                  (reaction) => reaction.name === "white_check_mark"
                )
              );

              const followUpInput = "reuse the ACP session";
              const followUp = yield* postHumanMessage(fixture, followUpInput, {
                threadTs: rootTs,
              });
              yield* harness.runner.inject(
                normalizedEvent({
                  authorSlackId: fixture.humanUserId,
                  channelId: fixture.channelId,
                  eventId: "event:235-canary-follow-up",
                  messageTs: timestampOf(followUp),
                  text: followUpInput,
                  threadTs: rootTs,
                })
              );
              yield* waitForBotTexts(fixture, rootTs, [
                EXPECTED_MARKDOWN,
                EXPECTED_MARKDOWN,
              ]);

              const secondThreadInput = `<@${LABORER_SLACK_ID}> use a separate ACP session`;
              const secondRoot = yield* postHumanMessage(
                fixture,
                secondThreadInput
              );
              const secondRootTs = timestampOf(secondRoot);
              yield* harness.runner.inject(
                normalizedEvent({
                  authorSlackId: fixture.humanUserId,
                  channelId: fixture.channelId,
                  eventId: "event:235-canary-second-thread",
                  messageTs: secondRootTs,
                  text: secondThreadInput,
                })
              );
              yield* waitForBotTexts(fixture, secondRootTs, [
                EXPECTED_MARKDOWN,
              ]);
              assert.deepStrictEqual(yield* nonEmptyFileLines(promptLogPath), [
                `acp-session-secret-234-1\t${firstInput}`,
                `acp-session-secret-234-1\t${followUpInput}`,
                `acp-session-secret-234-2\t${secondThreadInput}`,
              ]);
              assert.deepStrictEqual(yield* nonEmptyFileLines(sessionLogPath), [
                `acp-session-secret-234-1\t${laborerRoot}`,
                `acp-session-secret-234-2\t${laborerRoot}`,
              ]);
              assert.deepStrictEqual(
                yield* waitForFileLineCount(lifecycleLogPath, 6),
                [
                  "initialize",
                  "session:new:acp-session-secret-234-1",
                  `prompt:acp-session-secret-234-1:${firstInput}`,
                  `prompt:acp-session-secret-234-1:${followUpInput}`,
                  "session:new:acp-session-secret-234-2",
                  `prompt:acp-session-secret-234-2:${secondThreadInput}`,
                ]
              );
            })
          );

          yield* waitForFile(exitPath);
          assert.deepStrictEqual(
            yield* waitForFileLineCount(lifecycleLogPath, 7),
            [
              "initialize",
              "session:new:acp-session-secret-234-1",
              `prompt:acp-session-secret-234-1:<@${LABORER_SLACK_ID}> stream via fake OpenCode ACP`,
              "prompt:acp-session-secret-234-1:reuse the ACP session",
              "session:new:acp-session-secret-234-2",
              `prompt:acp-session-secret-234-2:<@${LABORER_SLACK_ID}> use a separate ACP session`,
              "stdio:closed",
            ]
          );
          yield* waitForProcessExit(pidPath);
        })
      ),
    30_000
  );
});
