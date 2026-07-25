import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Array as EffectArray, pipe, Schema } from "effect";
import { makeAcpConversationAgent } from "../src/acp-conversation-prototype/acp-conversation-agent.ts";
import {
  prepareAcpAgentContextSources,
  userProfilePath,
} from "../src/acp-conversation-prototype/agent-context.ts";
import {
  makeAcpConversationCanary,
  makeWorkspaceBoundAcpConversationCanary,
} from "../src/acp-conversation-prototype/canary-composition.ts";
import {
  type EmulatedSlackFixture,
  makeSlackActivationAcknowledger,
  makeSlackCompletionReactor,
  startEmulatedSlack,
} from "../src/prototype/emulated-slack.ts";
import type { Runner } from "../src/prototype/runtime.ts";
import {
  LABORER_SLACK_ID,
  normalizedEvent,
  postHumanMessage,
  timestampOf,
} from "../src/prototype/scenario.ts";
import { makeFileStoreLayer } from "../src/prototype/store.ts";
import type { ConversationAgentRequest } from "../src/reference-coding-application.ts";
import { prepareSlackRuntimePaths } from "../src/slack/runtime-paths.ts";
import { makeTempDirectoryScoped } from "./support/temp-directory.ts";

const projectRoot = process.cwd();
const scriptedPeerPath = resolve(
  projectRoot,
  "tests/fixtures/scripted-acp-peer.ts"
);
const OBSERVATION_TIMEOUT_MILLIS = 5000;

const PromptRecord = Schema.Struct({
  prompt: Schema.String,
  sessionId: Schema.String,
});
const SessionRequestRecord = Schema.Struct({
  cwd: Schema.String,
  mcpServers: Schema.Array(Schema.Unknown),
  sessionId: Schema.optional(Schema.String),
});

const readJsonLineValues = Effect.fnUntraced(function* (path: string) {
  const source = yield* Effect.promise(() => readFile(path, "utf8"));
  return pipe(
    source.split("\n"),
    EffectArray.filter((line) => line.length > 0),
    EffectArray.map((line) => JSON.parse(line) as unknown)
  );
});

const readPromptRecords = Effect.fnUntraced(function* (path: string) {
  return yield* Schema.decodeUnknownEffect(Schema.Array(PromptRecord))(
    yield* readJsonLineValues(path)
  );
});

const readSessionRequestRecords = Effect.fnUntraced(function* (path: string) {
  return yield* Schema.decodeUnknownEffect(Schema.Array(SessionRequestRecord))(
    yield* readJsonLineValues(path)
  );
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

const waitForBotTexts = Effect.fnUntraced(function* (
  fixture: EmulatedSlackFixture,
  rootTs: string,
  expected: readonly string[]
) {
  const deadline = Date.now() + OBSERVATION_TIMEOUT_MILLIS;
  while (Date.now() < deadline) {
    const response = yield* Effect.promise(() =>
      fixture.humanClient.conversations.replies({
        channel: fixture.channelId,
        limit: 100,
        ts: rootTs,
      })
    );
    const texts = pipe(
      (response.messages ?? []) as Record<string, unknown>[],
      EffectArray.filter((message) => message.user === fixture.botUserId),
      EffectArray.map((message) => String(message.text ?? ""))
    );
    if (
      texts.length === expected.length &&
      EffectArray.every(texts, (text, index) => text === expected[index])
    ) {
      return texts;
    }
    yield* Effect.sleep("10 millis");
  }
  return yield* Effect.die(
    new Error(`timed out waiting for bot replies: ${expected.join(" | ")}`)
  );
});

const postAndInject = Effect.fnUntraced(function* (options: {
  readonly authorSlackId: string;
  readonly eventId: string;
  readonly fixture: EmulatedSlackFixture;
  readonly rootTs?: string;
  readonly runner: Runner;
  readonly text: string;
}) {
  const message = yield* postHumanMessage(options.fixture, options.text, {
    ...(options.rootTs === undefined ? {} : { threadTs: options.rootTs }),
  });
  yield* options.runner.inject(
    normalizedEvent({
      authorSlackId: options.authorSlackId,
      channelId: options.fixture.channelId,
      eventId: options.eventId,
      messageTs: timestampOf(message),
      text: options.text,
      ...(options.rootTs === undefined ? {} : { threadTs: options.rootTs }),
    })
  );
  return timestampOf(message);
});

const directRequest = (
  conversationId: string,
  promptId: string
): ConversationAgentRequest => ({
  actions: [],
  context: [],
  conversationId,
  conversationSessionId: `logical:${conversationId}`,
  conversationSessionIsNew: promptId === "prompt:one",
  executionControls: [],
  executions: [],
  input: promptId,
  messages: [],
  promptId,
  source: "slack",
  turnId: `turn:${promptId}`,
});

describe("issue #241 durable ACP session resumption", () => {
  it.live(
    "live workspace composition restores accepted threads and isolates shared-root workspace stores",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* startEmulatedSlack();
          const laborerRoot = yield* makeTempDirectoryScoped(
            "laborer-acp-live-workspace-restart-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-acp-live-workspace-restart-controls-"
          );
          const firstWorkspaceId = "T241LIVEWORKSPACEA";
          const secondWorkspaceId = "T241LIVEWORKSPACEB";
          const firstSessionRequests = join(controls, "first-sessions.jsonl");
          const secondSessionRequests = join(controls, "second-sessions.jsonl");
          const environmentFor = (
            name: string,
            sessionRequestPath: string
          ): NodeJS.ProcessEnv => ({
            ...process.env,
            SCRIPTED_ACP_DURABLE_STATE_PATH: join(
              controls,
              `${name}-peer.json`
            ),
            SCRIPTED_ACP_READY_PATH: join(controls, `${name}-ready`),
            SCRIPTED_ACP_RELEASE_PATH: join(controls, `${name}-release`),
            SCRIPTED_ACP_SCENARIO: "resume",
            SCRIPTED_ACP_SESSION_REQUEST_JSONL_PATH: sessionRequestPath,
          });
          const makeHarness = (
            workspaceId: string,
            environment: NodeJS.ProcessEnv
          ) =>
            makeWorkspaceBoundAcpConversationCanary({
              activationAcknowledger: makeSlackActivationAcknowledger(
                fixture.botClient
              ),
              completionReactor: makeSlackCompletionReactor(fixture.botClient),
              laborerSlackId: LABORER_SLACK_ID,
              process: {
                args: [scriptedPeerPath],
                command: process.execPath,
                cwd: laborerRoot,
                environment,
              },
              slack: fixture.gateway,
              workspaceId,
            });
          let firstRootTs = "";
          let secondRootTs = "";

          yield* Effect.scoped(
            Effect.gen(function* () {
              const first = yield* makeHarness(
                firstWorkspaceId,
                environmentFor("first", firstSessionRequests)
              );
              firstRootTs = yield* postAndInject({
                authorSlackId: fixture.humanUserId,
                eventId: "event:241-live-workspace-first",
                fixture,
                runner: first.runner,
                text: `<@${LABORER_SLACK_ID}> activate first workspace`,
              });
              yield* waitForBotTexts(fixture, firstRootTs, ["Durable reply 1"]);
            })
          );

          yield* Effect.scoped(
            Effect.gen(function* () {
              const second = yield* makeHarness(
                secondWorkspaceId,
                environmentFor("second", secondSessionRequests)
              );
              secondRootTs = yield* postAndInject({
                authorSlackId: fixture.humanUserId,
                eventId: "event:241-live-workspace-second",
                fixture,
                runner: second.runner,
                text: `<@${LABORER_SLACK_ID}> activate second workspace`,
              });
              yield* waitForBotTexts(fixture, secondRootTs, [
                "Durable reply 1",
              ]);
            })
          );

          const firstPaths = yield* prepareSlackRuntimePaths(
            laborerRoot,
            firstWorkspaceId
          );
          const secondPaths = yield* prepareSlackRuntimePaths(
            laborerRoot,
            secondWorkspaceId
          );
          const firstAcpSources = yield* prepareAcpAgentContextSources({
            root: laborerRoot,
            workspaceId: firstWorkspaceId,
          });
          const secondAcpSources = yield* prepareAcpAgentContextSources({
            root: laborerRoot,
            workspaceId: secondWorkspaceId,
          });
          assert.notStrictEqual(
            firstPaths.acpRunnerState,
            secondPaths.acpRunnerState
          );
          assert.notStrictEqual(
            firstPaths.acpRunnerState,
            firstPaths.runnerState
          );
          assert.notStrictEqual(
            secondPaths.acpRunnerState,
            secondPaths.runnerState
          );
          assert.notStrictEqual(
            firstPaths.acpRunnerState,
            firstAcpSources.acpConversationStatePath
          );
          assert.notStrictEqual(
            secondPaths.acpRunnerState,
            secondAcpSources.acpConversationStatePath
          );
          yield* Effect.promise(() => stat(firstPaths.acpRunnerState));
          yield* Effect.promise(() => stat(secondPaths.acpRunnerState));
          assert.strictEqual(
            yield* Effect.promise(() =>
              stat(firstPaths.runnerState).then(
                () => true,
                () => false
              )
            ),
            false
          );
          assert.strictEqual(
            yield* Effect.promise(() =>
              stat(secondPaths.runnerState).then(
                () => true,
                () => false
              )
            ),
            false
          );

          yield* Effect.scoped(
            Effect.gen(function* () {
              const restarted = yield* makeHarness(
                firstWorkspaceId,
                environmentFor("first", firstSessionRequests)
              );
              yield* postAndInject({
                authorSlackId: fixture.humanUserId,
                eventId: "event:241-live-workspace-followup",
                fixture,
                rootTs: firstRootTs,
                runner: restarted.runner,
                text: "ordinary follow-up without a mention",
              });
              yield* waitForBotTexts(fixture, firstRootTs, [
                "Durable reply 1",
                "Durable reply 2",
              ]);
            })
          );

          const firstRequests =
            yield* readSessionRequestRecords(firstSessionRequests);
          const secondRequests = yield* readSessionRequestRecords(
            secondSessionRequests
          );
          assert.strictEqual(firstRequests.length, 2);
          assert.strictEqual(firstRequests[0]?.sessionId, undefined);
          assert.strictEqual(typeof firstRequests[1]?.sessionId, "string");
          assert.strictEqual(secondRequests.length, 1);
          assert.strictEqual(secondRequests[0]?.sessionId, undefined);
        })
      ),
    30_000
  );

  it.live(
    "resumes without replay, restores introduced IDs, and reattaches authorized memory",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* startEmulatedSlack();
          const laborerRoot = yield* makeTempDirectoryScoped(
            "laborer-acp-resume-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-acp-resume-controls-"
          );
          const workspaceId = "T241RESUME";
          const runnerStatePath = join(laborerRoot, "runner-state.json");
          const durablePeerStatePath = join(controls, "peer-state.json");
          const lifecyclePath = join(controls, "lifecycle.log");
          const promptPath = join(controls, "prompts.jsonl");
          const sessionRequestPath = join(controls, "sessions.jsonl");
          const permissionResultPath = join(controls, "permission.json");
          const lateUserId = fixture.secondaryHumanUserId;
          const lookupCalls: string[] = [];
          const sources = yield* prepareAcpAgentContextSources({
            root: laborerRoot,
            workspaceId,
          });
          yield* Effect.promise(() => mkdir(sources.userProfilesDirectory));
          yield* Effect.promise(() =>
            writeFile(sources.soulPath, "Original Soul 241")
          );
          yield* Effect.promise(() =>
            writeFile(sources.workspaceMemoryPath, "Original memory 241")
          );
          yield* Effect.promise(() =>
            writeFile(
              userProfilePath(sources, fixture.humanUserId),
              "Original participant profile 241"
            )
          );
          const participantLookup = {
            lookupVisibleName: (slackUserId: string) =>
              Effect.sync(() => {
                lookupCalls.push(slackUserId);
                return `Visible ${slackUserId}`;
              }),
          };
          const processEnvironment = {
            ...process.env,
            SCRIPTED_ACP_DURABLE_STATE_PATH: durablePeerStatePath,
            SCRIPTED_ACP_LIFECYCLE_LOG_PATH: lifecyclePath,
            SCRIPTED_ACP_PROMPT_JSONL_PATH: promptPath,
            SCRIPTED_ACP_READY_PATH: join(controls, "ready"),
            SCRIPTED_ACP_RELEASE_PATH: join(controls, "release"),
            SCRIPTED_ACP_SCENARIO: "resume",
            SCRIPTED_ACP_SESSION_REQUEST_JSONL_PATH: sessionRequestPath,
          };
          let rootTs = "";

          yield* Effect.scoped(
            Effect.gen(function* () {
              const harness = yield* makeAcpConversationCanary({
                activationAcknowledger: makeSlackActivationAcknowledger(
                  fixture.botClient
                ),
                completionReactor: makeSlackCompletionReactor(
                  fixture.botClient
                ),
                laborerSlackId: LABORER_SLACK_ID,
                participantLookup,
                process: {
                  args: [scriptedPeerPath],
                  command: process.execPath,
                  cwd: laborerRoot,
                  environment: processEnvironment,
                },
                slack: fixture.gateway,
                storeLayer: makeFileStoreLayer(
                  LABORER_SLACK_ID,
                  runnerStatePath,
                  laborerRoot
                ),
                workspaceId,
              });
              const activation = `<@${LABORER_SLACK_ID}> durable first turn`;
              rootTs = yield* postAndInject({
                authorSlackId: fixture.humanUserId,
                eventId: "event:241-resume-first",
                fixture,
                runner: harness.runner,
                text: activation,
              });
              yield* waitForBotTexts(fixture, rootTs, ["Durable reply 1"]);
            })
          );

          yield* Effect.promise(() =>
            writeFile(sources.soulPath, "Changed Soul must not be reinjected")
          );
          yield* Effect.promise(() =>
            writeFile(
              sources.workspaceMemoryPath,
              "Changed memory must not be reinjected"
            )
          );
          yield* Effect.promise(() =>
            writeFile(
              userProfilePath(sources, fixture.humanUserId),
              "Changed original profile must not be reinjected"
            )
          );
          yield* Effect.promise(() =>
            writeFile(
              userProfilePath(sources, lateUserId),
              "Current late profile 241"
            )
          );

          yield* Effect.scoped(
            Effect.gen(function* () {
              const harness = yield* makeAcpConversationCanary({
                activationAcknowledger: makeSlackActivationAcknowledger(
                  fixture.botClient
                ),
                completionReactor: makeSlackCompletionReactor(
                  fixture.botClient
                ),
                laborerSlackId: LABORER_SLACK_ID,
                participantLookup,
                process: {
                  args: [scriptedPeerPath],
                  command: process.execPath,
                  cwd: laborerRoot,
                  environment: {
                    ...processEnvironment,
                    SCRIPTED_ACP_MEMORY_OPERATION_EVERY_PROMPT: "1",
                    SCRIPTED_ACP_MEMORY_OPERATION_JSON: JSON.stringify({
                      operation: "add",
                      target: "workspace",
                      text: "remembered after resume 241",
                    }),
                    SCRIPTED_ACP_PERMISSION_RESULT_PATH: permissionResultPath,
                    SCRIPTED_ACP_PERMISSION_TITLE: "memory permission",
                    SCRIPTED_ACP_PERMISSION_TOOL_IDENTITY: "attached-memory",
                  },
                },
                slack: fixture.gateway,
                storeLayer: makeFileStoreLayer(
                  LABORER_SLACK_ID,
                  runnerStatePath,
                  laborerRoot
                ),
                workspaceId,
              });
              yield* postAndInject({
                authorSlackId: lateUserId,
                eventId: "event:241-resume-late",
                fixture,
                rootTs,
                runner: harness.runner,
                text: "late participant after restart",
              });
              yield* postAndInject({
                authorSlackId: lateUserId,
                eventId: "event:241-resume-late-repeat",
                fixture,
                rootTs,
                runner: harness.runner,
                text: "late participant again",
              });
              yield* waitForBotTexts(fixture, rootTs, [
                "Durable reply 1",
                "Durable reply 2",
                "Durable reply 3",
              ]);
            })
          );

          const prompts = yield* readPromptRecords(promptPath);
          assert.strictEqual(prompts.length, 3);
          assert.strictEqual(prompts[0]?.sessionId, prompts[1]?.sessionId);
          assert.strictEqual(prompts[1]?.sessionId, prompts[2]?.sessionId);
          assert.ok(prompts[0]?.prompt.includes("Original Soul 241"));
          assert.ok(prompts[0]?.prompt.includes("Original memory 241"));
          assert.ok(
            prompts[0]?.prompt.includes("Original participant profile 241")
          );
          assert.ok(!prompts[1]?.prompt.includes("Changed Soul"));
          assert.ok(!prompts[1]?.prompt.includes("Changed memory"));
          assert.ok(!prompts[1]?.prompt.includes("Changed original profile"));
          assert.ok(
            prompts[1]?.prompt.includes(`slack-user-id="${lateUserId}"`)
          );
          assert.ok(prompts[1]?.prompt.includes("Current late profile 241"));
          assert.ok(
            !prompts[2]?.prompt.includes(`slack-user-id="${lateUserId}"`)
          );
          assert.deepStrictEqual(lookupCalls, [
            fixture.humanUserId,
            lateUserId,
          ]);

          const sessionRequests =
            yield* readSessionRequestRecords(sessionRequestPath);
          assert.strictEqual(sessionRequests.length, 2);
          assert.strictEqual(sessionRequests[0]?.sessionId, undefined);
          assert.strictEqual(
            sessionRequests[1]?.sessionId,
            prompts[0]?.sessionId
          );
          assert.strictEqual(sessionRequests[1]?.cwd, laborerRoot);
          assert.ok(resolve(sessionRequests[1]?.cwd ?? "") === laborerRoot);
          assert.strictEqual(sessionRequests[0]?.mcpServers.length, 1);
          assert.strictEqual(sessionRequests[1]?.mcpServers.length, 1);
          const lifecycle = yield* Effect.promise(() =>
            readFile(lifecyclePath, "utf8")
          );
          assert.ok(lifecycle.includes("initialize\nsession:new:"));
          assert.ok(lifecycle.includes("initialize\nsession:resume:"));
          assert.ok(!lifecycle.includes("session:load"));
          assert.ok(
            (yield* Effect.promise(() =>
              readFile(sources.workspaceMemoryPath, "utf8")
            )).includes("remembered after resume 241")
          );
          assert.deepStrictEqual(
            JSON.parse(
              yield* Effect.promise(() =>
                readFile(permissionResultPath, "utf8")
              )
            ),
            {
              outcome: {
                optionId: "scripted-allow-once",
                outcome: "selected",
              },
            }
          );
        })
      ),
    30_000
  );

  it.live(
    "replaces an unavailable session with current context and persists the replacement",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* startEmulatedSlack();
          const laborerRoot = yield* makeTempDirectoryScoped(
            "laborer-acp-replacement-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-acp-replacement-controls-"
          );
          const workspaceId = "T241REPLACE";
          const runnerStatePath = join(laborerRoot, "runner-state.json");
          const durablePeerStatePath = join(controls, "peer-state.json");
          const lifecyclePath = join(controls, "lifecycle.log");
          const promptPath = join(controls, "prompts.jsonl");
          const sessionRequestPath = join(controls, "sessions.jsonl");
          const sources = yield* prepareAcpAgentContextSources({
            root: laborerRoot,
            workspaceId,
          });
          yield* Effect.promise(() => mkdir(sources.userProfilesDirectory));
          const lookupCalls: string[] = [];
          const participantLookup = {
            lookupVisibleName: (slackUserId: string) =>
              Effect.sync(() => {
                lookupCalls.push(slackUserId);
                return `Replacement visible ${slackUserId}`;
              }),
          };
          const baseEnvironment = {
            ...process.env,
            SCRIPTED_ACP_DURABLE_STATE_PATH: durablePeerStatePath,
            SCRIPTED_ACP_LIFECYCLE_LOG_PATH: lifecyclePath,
            SCRIPTED_ACP_PROMPT_JSONL_PATH: promptPath,
            SCRIPTED_ACP_READY_PATH: join(controls, "ready"),
            SCRIPTED_ACP_RELEASE_PATH: join(controls, "release"),
            SCRIPTED_ACP_SCENARIO: "resume",
            SCRIPTED_ACP_SESSION_REQUEST_JSONL_PATH: sessionRequestPath,
          };
          const makeHarness = (environment: NodeJS.ProcessEnv) =>
            makeAcpConversationCanary({
              activationAcknowledger: makeSlackActivationAcknowledger(
                fixture.botClient
              ),
              completionReactor: makeSlackCompletionReactor(fixture.botClient),
              laborerSlackId: LABORER_SLACK_ID,
              participantLookup,
              process: {
                args: [scriptedPeerPath],
                command: process.execPath,
                cwd: laborerRoot,
                environment,
              },
              slack: fixture.gateway,
              storeLayer: makeFileStoreLayer(
                LABORER_SLACK_ID,
                runnerStatePath,
                laborerRoot
              ),
              workspaceId,
            });
          let rootTs = "";

          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* Effect.promise(() =>
                writeFile(sources.soulPath, "Old replacement Soul")
              );
              yield* Effect.promise(() =>
                writeFile(sources.workspaceMemoryPath, "Old replacement memory")
              );
              yield* Effect.promise(() =>
                writeFile(
                  userProfilePath(sources, fixture.humanUserId),
                  "Old replacement profile"
                )
              );
              const harness = yield* makeHarness(baseEnvironment);
              rootTs = yield* postAndInject({
                authorSlackId: fixture.humanUserId,
                eventId: "event:241-replacement-first",
                fixture,
                runner: harness.runner,
                text: `<@${LABORER_SLACK_ID}> replacement first`,
              });
            })
          );

          yield* Effect.promise(async () => {
            const peerState = JSON.parse(
              await readFile(durablePeerStatePath, "utf8")
            ) as Record<string, unknown>;
            await writeFile(
              durablePeerStatePath,
              JSON.stringify({ ...peerState, sessions: [] })
            );
          });
          yield* Effect.promise(() =>
            writeFile(sources.soulPath, "Current replacement Soul")
          );
          yield* Effect.promise(() =>
            writeFile(sources.workspaceMemoryPath, "Current replacement memory")
          );
          yield* Effect.promise(() =>
            writeFile(
              userProfilePath(sources, fixture.humanUserId),
              "Current replacement profile"
            )
          );

          yield* Effect.scoped(
            Effect.gen(function* () {
              const harness = yield* makeHarness(baseEnvironment);
              yield* postAndInject({
                authorSlackId: fixture.humanUserId,
                eventId: "event:241-replacement-second",
                fixture,
                rootTs,
                runner: harness.runner,
                text: "continue through replacement",
              });
              yield* postAndInject({
                authorSlackId: fixture.humanUserId,
                eventId: "event:241-replacement-third",
                fixture,
                rootTs,
                runner: harness.runner,
                text: "continue in replacement",
              });
            })
          );

          yield* Effect.scoped(
            Effect.gen(function* () {
              const harness = yield* makeHarness(baseEnvironment);
              yield* postAndInject({
                authorSlackId: fixture.humanUserId,
                eventId: "event:241-replacement-fourth",
                fixture,
                rootTs,
                runner: harness.runner,
                text: "resume the replacement",
              });
            })
          );

          const prompts = yield* readPromptRecords(promptPath);
          assert.strictEqual(prompts.length, 4);
          const originalSessionId = prompts[0]?.sessionId;
          const replacementSessionId = prompts[1]?.sessionId;
          assert.notStrictEqual(originalSessionId, replacementSessionId);
          assert.strictEqual(prompts[2]?.sessionId, replacementSessionId);
          assert.strictEqual(prompts[3]?.sessionId, replacementSessionId);
          assert.ok(prompts[1]?.prompt.includes("Current replacement Soul"));
          assert.ok(prompts[1]?.prompt.includes("Current replacement memory"));
          assert.ok(prompts[1]?.prompt.includes("Current replacement profile"));
          assert.ok(!prompts[2]?.prompt.includes("Current replacement Soul"));
          assert.ok(
            !prompts[3]?.prompt.includes("Current replacement profile")
          );
          assert.deepStrictEqual(lookupCalls, [
            fixture.humanUserId,
            fixture.humanUserId,
          ]);

          const sessionRequests =
            yield* readSessionRequestRecords(sessionRequestPath);
          assert.strictEqual(sessionRequests.length, 4);
          assert.strictEqual(sessionRequests[1]?.sessionId, originalSessionId);
          assert.strictEqual(sessionRequests[2]?.sessionId, undefined);
          assert.strictEqual(
            sessionRequests[3]?.sessionId,
            replacementSessionId
          );
          assert.strictEqual(sessionRequests[1]?.mcpServers.length, 1);
          assert.strictEqual(sessionRequests[2]?.mcpServers.length, 1);
          assert.strictEqual(sessionRequests[3]?.mcpServers.length, 1);
          yield* waitForBotTexts(fixture, rootTs, [
            "Durable reply 1",
            "Durable reply 2",
            "Durable reply 3",
            "Durable reply 4",
          ]);
          const lifecycle = yield* Effect.promise(() =>
            readFile(lifecyclePath, "utf8")
          );
          assert.ok(lifecycle.includes(`session:resume:${originalSessionId}`));
          assert.ok(
            lifecycle.includes(`session:resume:${replacementSessionId}`)
          );
          assert.ok(!lifecycle.includes("session:load"));
        })
      ),
    30_000
  );

  it.live(
    "does not replay an ambiguously in-flight prompt after restart",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* startEmulatedSlack();
          const laborerRoot = yield* makeTempDirectoryScoped(
            "laborer-acp-unsafe-replay-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-acp-unsafe-replay-controls-"
          );
          const workspaceId = "T241INFLIGHT";
          const runnerStatePath = join(laborerRoot, "runner-state.json");
          const durablePeerStatePath = join(controls, "peer-state.json");
          const promptPath = join(controls, "prompts.jsonl");
          const readyPath = join(controls, "ready");
          const releasePath = join(controls, "release");
          const sessionRequestPath = join(controls, "sessions.jsonl");
          const environment = {
            ...process.env,
            SCRIPTED_ACP_DURABLE_STATE_PATH: durablePeerStatePath,
            SCRIPTED_ACP_PROMPT_JSONL_PATH: promptPath,
            SCRIPTED_ACP_READY_PATH: readyPath,
            SCRIPTED_ACP_RELEASE_PATH: releasePath,
            SCRIPTED_ACP_SESSION_REQUEST_JSONL_PATH: sessionRequestPath,
          };
          const makeHarness = () =>
            makeAcpConversationCanary({
              activationAcknowledger: makeSlackActivationAcknowledger(
                fixture.botClient
              ),
              completionReactor: makeSlackCompletionReactor(fixture.botClient),
              laborerSlackId: LABORER_SLACK_ID,
              process: {
                args: [scriptedPeerPath],
                childExitGraceMillis: 200,
                command: process.execPath,
                cwd: laborerRoot,
                environment,
              },
              slack: fixture.gateway,
              storeLayer: makeFileStoreLayer(
                LABORER_SLACK_ID,
                runnerStatePath,
                laborerRoot
              ),
              workspaceId,
            });
          let rootTs = "";

          yield* Effect.scoped(
            Effect.gen(function* () {
              const harness = yield* makeHarness();
              const text = `<@${LABORER_SLACK_ID}> uncertain prompt`;
              const root = yield* postHumanMessage(fixture, text);
              rootTs = timestampOf(root);
              yield* harness.runner.accept(
                normalizedEvent({
                  authorSlackId: fixture.humanUserId,
                  channelId: fixture.channelId,
                  eventId: "event:241-inflight",
                  messageTs: rootTs,
                  text,
                })
              );
              yield* waitForFile(readyPath);
              yield* waitForBotTexts(fixture, rootTs, [
                "**Streaming** from ACP",
              ]);
            })
          );

          yield* Effect.scoped(
            Effect.gen(function* () {
              const harness = yield* makeHarness();
              yield* waitForBotTexts(fixture, rootTs, [
                "**Streaming** from ACP",
                "This conversation turn could not be completed. Please try again.",
              ]);
              yield* Effect.promise(() => writeFile(releasePath, "release"));
              yield* postAndInject({
                authorSlackId: fixture.humanUserId,
                eventId: "event:241-after-inflight",
                fixture,
                rootTs,
                runner: harness.runner,
                text: "safe turn after ambiguous recovery",
              });
              yield* waitForBotTexts(fixture, rootTs, [
                "**Streaming** from ACP",
                "This conversation turn could not be completed. Please try again.",
                "**Streaming** from ACP\n\n- complete\n- unchanged",
              ]);
            })
          );
          const prompts = yield* readPromptRecords(promptPath);
          assert.strictEqual(prompts.length, 2);
          assert.ok(prompts[1]?.prompt.includes("safe turn after ambiguous"));
          const sessionRequests =
            yield* readSessionRequestRecords(sessionRequestPath);
          assert.strictEqual(sessionRequests.length, 2);
          assert.strictEqual(
            sessionRequests[1]?.sessionId,
            prompts[0]?.sessionId
          );
        })
      ),
    30_000
  );

  it.live(
    "fails closed on corrupt workspace session state with bounded local diagnostics",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const laborerRoot = yield* makeTempDirectoryScoped(
            "laborer-acp-corrupt-state-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-acp-corrupt-state-controls-"
          );
          const sources = yield* prepareAcpAgentContextSources({
            root: laborerRoot,
            workspaceId: "T241CORRUPT",
          });
          const durablePeerStatePath = join(controls, "peer-state.json");
          const sessionRequestPath = join(controls, "sessions.jsonl");
          const environment = {
            ...process.env,
            SCRIPTED_ACP_DURABLE_STATE_PATH: durablePeerStatePath,
            SCRIPTED_ACP_READY_PATH: join(controls, "ready"),
            SCRIPTED_ACP_RELEASE_PATH: join(controls, "release"),
            SCRIPTED_ACP_SCENARIO: "resume",
            SCRIPTED_ACP_SESSION_REQUEST_JSONL_PATH: sessionRequestPath,
          };
          const makeAgent = () =>
            makeAcpConversationAgent({
              agentContext: sources,
              args: [scriptedPeerPath],
              command: process.execPath,
              cwd: laborerRoot,
              environment,
            });

          yield* Effect.scoped(
            Effect.gen(function* () {
              const agent = yield* makeAgent();
              yield* agent.handle(
                directRequest("conversation:241-corrupt", "prompt:one"),
                () => Effect.void
              );
            })
          );
          yield* Effect.promise(() =>
            writeFile(
              sources.acpConversationDiagnosticsPath,
              "PRIVATE CORRUPTION SECRET ".repeat(1000)
            )
          );
          yield* Effect.promise(() =>
            writeFile(
              sources.acpConversationStatePath,
              '{"schemaVersion":1,"PRIVATE STATE SECRET":true}'
            )
          );

          const restart = yield* Effect.scoped(Effect.result(makeAgent()));
          assert.strictEqual(restart._tag, "Failure");
          const diagnostics = yield* Effect.promise(() =>
            readFile(sources.acpConversationDiagnosticsPath)
          );
          assert.ok(diagnostics.byteLength <= 4096);
          const diagnosticText = diagnostics.toString("utf8");
          assert.ok(diagnosticText.includes("state-corrupt"));
          assert.ok(!diagnosticText.includes("PRIVATE"));
          assert.strictEqual(
            (yield* readSessionRequestRecords(sessionRequestPath)).length,
            1
          );
        })
      ),
    30_000
  );
});
