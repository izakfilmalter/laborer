import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import {
  Effect,
  Array as EffectArray,
  Fiber,
  Logger,
  pipe,
  Schema,
} from "effect";
import { makeAcpConversationAgent } from "../src/acp-conversation-prototype/acp-conversation-agent.ts";
import {
  prepareAcpAgentContextSources,
  renderAcpPrompt,
} from "../src/acp-conversation-prototype/agent-context.ts";
import { makeAcpConversationCanary } from "../src/acp-conversation-prototype/canary-composition.ts";
import {
  makeBoundedSlackParticipantLookup,
  makeSlackParticipantLookup,
  SLACK_PARTICIPANT_LOOKUP_WORKSPACE_CONCURRENCY_LIMIT,
  SLACK_VISIBLE_NAME_CHARACTER_LIMIT,
} from "../src/acp-conversation-prototype/slack-participant-lookup.ts";
import { MessageId, NormalizedMessage } from "../src/prototype/domain.ts";
import {
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
import type { ConversationAgentRequest } from "../src/reference-coding-application.ts";
import { makeTempDirectoryScoped } from "./support/temp-directory.ts";

const projectRoot = process.cwd();
const scriptedPeerPath = resolve(
  projectRoot,
  "tests/fixtures/scripted-acp-peer.ts"
);
const OBSERVATION_TIMEOUT_MILLIS = 5000;
const USER_PROFILE_CONTENT_PATTERN = /<user-profile>([\s\S]*)<\/user-profile>/;

const containsInvalidXmlCharacter = (value: string): boolean => {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      !(
        codePoint === 0x09 ||
        codePoint === 0x0a ||
        codePoint === 0x0d ||
        (codePoint >= 0x20 && codePoint <= 0xd7_ff) ||
        (codePoint >= 0xe0_00 && codePoint <= 0xff_fd) ||
        (codePoint >= 0x1_00_00 && codePoint <= 0x10_ff_ff)
      )
    ) {
      return true;
    }
  }
  return false;
};

const PromptRecord = Schema.Struct({
  prompt: Schema.String,
  sessionId: Schema.String,
});

const readPromptRecords = Effect.fnUntraced(function* (path: string) {
  const source = yield* Effect.promise(() => readFile(path, "utf8"));
  return yield* Schema.decodeUnknownEffect(Schema.Array(PromptRecord))(
    pipe(
      source.split("\n"),
      EffectArray.filter((line) => line.length > 0),
      EffectArray.map((line) => JSON.parse(line) as unknown)
    )
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

const waitForPromptCount = Effect.fnUntraced(function* (
  path: string,
  expectedCount: number
) {
  const deadline = Date.now() + OBSERVATION_TIMEOUT_MILLIS;
  while (Date.now() < deadline) {
    const promptCount = yield* Effect.promise(async () => {
      try {
        return pipe(
          (await readFile(path, "utf8")).split("\n"),
          EffectArray.filter((line) => line.length > 0)
        ).length;
      } catch {
        return 0;
      }
    });
    if (promptCount === expectedCount) {
      return yield* readPromptRecords(path);
    }
    yield* Effect.sleep("10 millis");
  }
  return yield* Effect.die(
    new Error(`timed out waiting for ${expectedCount} prompts in ${path}`)
  );
});

const participantConversationRequest = (options: {
  readonly conversationId: string;
  readonly participantIds: readonly string[];
  readonly promptId: string;
}): ConversationAgentRequest => {
  const messages = options.participantIds.map((participantId, index) =>
    NormalizedMessage.make({
      authorKind: "human",
      authorSlackId: participantId,
      classification: "input",
      id: MessageId.make(`${options.promptId}:message:${index}`),
      isActivation: index === 0,
      slackTs: `239.${String(index).padStart(6, "0")}`,
      text: `message from ${participantId}`,
    })
  );
  return {
    actions: [],
    context: [],
    conversationId: options.conversationId,
    conversationSessionId: `logical:${options.conversationId}`,
    conversationSessionIsNew: options.promptId === "prompt:one",
    executionControls: [],
    executions: [],
    input: messages.map((message) => message.text).join("\n"),
    messages,
    promptId: options.promptId,
    source: "slack",
    turnId: `turn:${options.promptId}`,
  };
};

describe("issue #239 ACP Slack participant context", () => {
  it("requests users:read without requesting users:read.email", async () => {
    const manifest = await readFile(
      resolve(projectRoot, "slack-app-manifest.yaml"),
      "utf8"
    );
    assert.ok(manifest.includes("      - users:read\n"));
    assert.ok(!manifest.includes("users:read.email"));
  });

  it.live(
    "wires bounded Emulate users.info enrichment through canary composition into the ACP prompt",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* startEmulatedSlack();
          const laborerRoot = yield* makeTempDirectoryScoped(
            "laborer-acp-participant-emulate-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-acp-participant-emulate-controls-"
          );
          const promptJsonlPath = join(controls, "prompts.jsonl");
          const releasePath = join(controls, "release");
          assert.ok(fixture.botClient.token !== undefined);
          const participantLookup = makeBoundedSlackParticipantLookup({
            requestTimeoutMillis: 1000,
            slackApiUrl: fixture.botClient.slackApiUrl,
            token: fixture.botClient.token,
            usersInfoTimeoutMillis: 2000,
          });
          yield* Effect.promise(() => writeFile(releasePath, "release"));
          const harness = yield* makeAcpConversationCanary({
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
              environment: {
                ...process.env,
                SCRIPTED_ACP_PROMPT_JSONL_PATH: promptJsonlPath,
                SCRIPTED_ACP_READY_PATH: join(controls, "ready"),
                SCRIPTED_ACP_RELEASE_PATH: releasePath,
              },
            },
            slack: fixture.gateway,
            workspaceId: "T239EMULATE",
          });
          const activationText = `<@${LABORER_SLACK_ID}> identify me`;
          const activation = yield* postHumanMessage(fixture, activationText);
          yield* harness.runner.inject(
            normalizedEvent({
              authorSlackId: fixture.humanUserId,
              channelId: fixture.channelId,
              eventId: "event:239-emulate-users-info",
              messageTs: timestampOf(activation),
              text: activationText,
            })
          );

          const prompt = (yield* readPromptRecords(promptJsonlPath))[0]?.prompt;
          assert.ok(prompt !== undefined);
          assert.ok(
            prompt.includes(
              `slack-user-id="${fixture.humanUserId}" visible-name="prototype-human"`
            )
          );
        })
      ),
    30_000
  );

  it.live(
    "aborts timed-out users.info transport without leaving work queued or in flight",
    () =>
      Effect.gen(function* () {
        const warnings: string[] = [];
        let abortedRequests = 0;
        let inFlightRequests = 0;
        let startedRequests = 0;
        const warningLogger = Logger.make<unknown, void>((options) => {
          if (options.logLevel === "Warn") {
            warnings.push(String(options.message));
          }
        });
        const lookup = makeBoundedSlackParticipantLookup({
          fetch: (_url, request) =>
            new Promise<never>((_resolve, reject) => {
              startedRequests += 1;
              inFlightRequests += 1;
              const signal = request?.signal;
              if (signal === undefined) {
                reject(new Error("bounded Slack request omitted its signal"));
                return;
              }
              const abort = (): void => {
                signal.removeEventListener("abort", abort);
                abortedRequests += 1;
                inFlightRequests -= 1;
                reject(new Error("bounded Slack request aborted"));
              };
              signal.addEventListener("abort", abort, { once: true });
            }),
          requestTimeoutMillis: 20,
          slackApiUrl: "https://slack.invalid/api/",
          token: "test-token",
          usersInfoTimeoutMillis: 200,
        });
        const results = yield* Effect.all(
          [
            lookup.lookupVisibleName("U239TIMEOUT1"),
            lookup.lookupVisibleName("U239TIMEOUT2"),
          ],
          { concurrency: 2 }
        ).pipe(Effect.provide(Logger.layer([warningLogger])));

        assert.deepStrictEqual(results, ["U239TIMEOUT1", "U239TIMEOUT2"]);
        assert.strictEqual(startedRequests, 2);
        assert.strictEqual(abortedRequests, 2);
        assert.strictEqual(inFlightRequests, 0);
        assert.strictEqual(warnings.length, 2);
        assert.ok(
          EffectArray.every(warnings, (warning) =>
            warning.startsWith("Slack participant lookup failed")
          )
        );
      })
  );

  it.live(
    "bounds users.info calls across concurrent conversations with one workspace semaphore",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const laborerRoot = yield* makeTempDirectoryScoped(
            "laborer-acp-participant-concurrency-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-acp-participant-concurrency-controls-"
          );
          const promptJsonlPath = join(controls, "prompts.jsonl");
          const releasePath = join(controls, "release");
          const sources = yield* prepareAcpAgentContextSources({
            root: laborerRoot,
            workspaceId: "T239-PARTICIPANT-CONCURRENCY",
          });
          yield* Effect.promise(() =>
            writeFile(
              sources.workspaceMemoryPath,
              "concurrent workspace context"
            )
          );
          yield* Effect.promise(() => writeFile(releasePath, "release"));
          let inFlightRequests = 0;
          let maximumInFlightRequests = 0;
          let startedRequests = 0;
          const participantLookup = makeBoundedSlackParticipantLookup({
            fetch: async () => {
              startedRequests += 1;
              inFlightRequests += 1;
              maximumInFlightRequests = Math.max(
                maximumInFlightRequests,
                inFlightRequests
              );
              await new Promise((resolveRequest) => {
                setTimeout(resolveRequest, 25);
              });
              inFlightRequests -= 1;
              return Response.json({
                ok: true,
                user: { profile: { display_name: "Concurrent participant" } },
              });
            },
            requestTimeoutMillis: 500,
            slackApiUrl: "https://slack.invalid/api/",
            token: "test-token",
            usersInfoTimeoutMillis: 1000,
          });
          const conversationAgent = yield* makeAcpConversationAgent({
            agentContext: sources,
            args: [scriptedPeerPath],
            command: process.execPath,
            cwd: laborerRoot,
            environment: {
              ...process.env,
              SCRIPTED_ACP_PROMPT_JSONL_PATH: promptJsonlPath,
              SCRIPTED_ACP_READY_PATH: join(controls, "ready"),
              SCRIPTED_ACP_RELEASE_PATH: releasePath,
            },
            participantLookup,
          });
          const conversationCount =
            SLACK_PARTICIPANT_LOOKUP_WORKSPACE_CONCURRENCY_LIMIT * 3;
          yield* Effect.all(
            Array.from({ length: conversationCount }, (_, index) =>
              conversationAgent.handle(
                participantConversationRequest({
                  conversationId: `conversation:239-concurrent:${index}`,
                  participantIds: [`U239CONVERSATION${index}`],
                  promptId: "prompt:one",
                }),
                () => Effect.void
              )
            ),
            { concurrency: "unbounded" }
          );

          assert.strictEqual(startedRequests, conversationCount);
          assert.strictEqual(inFlightRequests, 0);
          assert.strictEqual(
            maximumInFlightRequests,
            SLACK_PARTICIPANT_LOOKUP_WORKSPACE_CONCURRENCY_LIMIT
          );
          assert.strictEqual(
            (yield* readPromptRecords(promptJsonlPath)).length,
            conversationCount
          );
        })
      ),
    30_000
  );

  it.live(
    "includes workspace-capacity waiting in the users.info deadline",
    () =>
      Effect.gen(function* () {
        let abortedRequests = 0;
        let inFlightRequests = 0;
        let startedRequests = 0;
        const warnings: string[] = [];
        const warningLogger = Logger.make<unknown, void>((options) => {
          if (options.logLevel === "Warn") {
            warnings.push(String(options.message));
          }
        });
        const lookup = makeBoundedSlackParticipantLookup({
          fetch: (_url, request) =>
            new Promise<never>((_resolve, reject) => {
              startedRequests += 1;
              inFlightRequests += 1;
              const signal = request?.signal;
              if (signal === undefined) {
                reject(new Error("bounded Slack request omitted its signal"));
                return;
              }
              const abort = (): void => {
                signal.removeEventListener("abort", abort);
                abortedRequests += 1;
                inFlightRequests -= 1;
                reject(new Error("PRIVATE CAPACITY WAIT ERROR 239"));
              };
              signal.addEventListener("abort", abort, { once: true });
            }),
          requestTimeoutMillis: 1000,
          slackApiUrl: "https://slack.invalid/api/",
          token: "test-token",
          usersInfoTimeoutMillis: 400,
        });
        const requestCount =
          SLACK_PARTICIPANT_LOOKUP_WORKSPACE_CONCURRENCY_LIMIT + 3;
        const userIds = Array.from(
          { length: requestCount },
          (_, index) => `U239WAIT${index}`
        );
        const results = yield* Effect.all(
          userIds.map((userId) => lookup.lookupVisibleName(userId)),
          { concurrency: "unbounded" }
        ).pipe(Effect.provide(Logger.layer([warningLogger])));

        assert.strictEqual(
          startedRequests,
          SLACK_PARTICIPANT_LOOKUP_WORKSPACE_CONCURRENCY_LIMIT
        );
        assert.strictEqual(
          abortedRequests,
          SLACK_PARTICIPANT_LOOKUP_WORKSPACE_CONCURRENCY_LIMIT
        );
        assert.strictEqual(inFlightRequests, 0);
        assert.deepStrictEqual(results, userIds);
        assert.strictEqual(warnings.length, requestCount);
        assert.ok(
          EffectArray.every(
            warnings,
            (warning) =>
              warning.length < 200 &&
              !warning.includes("PRIVATE CAPACITY WAIT ERROR 239")
          )
        );
      })
  );

  it.live(
    "enriches every newly introduced human without a permanent prompt cap",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const laborerRoot = yield* makeTempDirectoryScoped(
            "laborer-acp-participant-budget-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-acp-participant-budget-controls-"
          );
          const promptJsonlPath = join(controls, "prompts.jsonl");
          const releasePath = join(controls, "release");
          const sources = yield* prepareAcpAgentContextSources({
            root: laborerRoot,
            workspaceId: "T239-PARTICIPANT-BUDGET",
          });
          yield* Effect.promise(() =>
            writeFile(sources.workspaceMemoryPath, "bounded workspace context")
          );
          yield* Effect.promise(() => writeFile(releasePath, "release"));
          const participantIds = Array.from(
            { length: 21 },
            (_, index) => `U239BUDGET${String(index).padStart(2, "0")}`
          );
          const lookedUpIds: string[] = [];
          const warnings: string[] = [];
          const publicOutput: string[] = [];
          const warningLogger = Logger.make<unknown, void>((options) => {
            if (options.logLevel === "Warn") {
              warnings.push(String(options.message));
            }
          });
          const conversationAgent = yield* makeAcpConversationAgent({
            agentContext: sources,
            args: [scriptedPeerPath],
            command: process.execPath,
            cwd: laborerRoot,
            environment: {
              ...process.env,
              SCRIPTED_ACP_PROMPT_JSONL_PATH: promptJsonlPath,
              SCRIPTED_ACP_READY_PATH: join(controls, "ready"),
              SCRIPTED_ACP_RELEASE_PATH: releasePath,
            },
            participantLookup: {
              lookupVisibleName: (slackUserId) =>
                Effect.sync(() => {
                  lookedUpIds.push(slackUserId);
                  return `Resolved ${slackUserId}`;
                }),
            },
          });

          yield* conversationAgent
            .handle(
              participantConversationRequest({
                conversationId: "conversation:239-participant-budget",
                participantIds,
                promptId: "prompt:one",
              }),
              (message) =>
                Effect.sync(() => {
                  publicOutput.push(message.text);
                })
            )
            .pipe(Effect.provide(Logger.layer([warningLogger])));

          assert.deepStrictEqual(lookedUpIds, participantIds);
          const prompt = (yield* readPromptRecords(promptJsonlPath))[0]?.prompt;
          assert.ok(prompt !== undefined);
          for (const participantId of participantIds) {
            assert.ok(prompt.includes(`slack-user-id="${participantId}"`));
            assert.ok(
              prompt.includes(
                `slack-user-id="${participantId}" visible-name="Resolved ${participantId}"`
              )
            );
          }
          let previousParticipantIndex = -1;
          for (const participantId of participantIds) {
            const participantIndex = prompt.indexOf(
              `slack-user-id="${participantId}"`
            );
            assert.ok(participantIndex > previousParticipantIndex);
            previousParticipantIndex = participantIndex;
          }
          assert.deepStrictEqual(warnings, []);
          const published = publicOutput.join("\n");
          assert.ok(!published.includes("lookup budget"));
          assert.ok(!published.includes(participantIds.at(-1) ?? "unexpected"));
        })
      ),
    30_000
  );

  it.effect(
    "removes XML-invalid name characters while preserving and escaping valid Unicode",
    () =>
      Effect.gen(function* () {
        const slackUserId = "U239XMLSAFE";
        const lookup = makeSlackParticipantLookup({
          users: {
            info: () =>
              Promise.resolve({
                user: {
                  profile: {
                    display_name:
                      '\u0000\u0008Visible " & < 😀\uD800name\uDC00',
                    real_name: "Ignored real name",
                  },
                },
              }),
          },
        });
        const visibleName = yield* lookup.lookupVisibleName(slackUserId);
        assert.strictEqual(visibleName, 'Visible " & < 😀name');

        const prompt = renderAcpPrompt(
          participantConversationRequest({
            conversationId: "conversation:239-xml-safe",
            participantIds: [slackUserId],
            promptId: "prompt:one",
          }),
          {
            participants: [{ slackUserId, userProfile: null, visibleName }],
            soul: null,
            workspaceMemory: null,
          }
        );
        assert.ok(
          prompt.includes('visible-name="Visible &quot; &amp; &lt; 😀name"')
        );
        assert.ok(!containsInvalidXmlCharacter(prompt));

        const realNameFallback = yield* makeSlackParticipantLookup({
          users: {
            info: () =>
              Promise.resolve({
                user: {
                  profile: {
                    display_name: "\uD800\u0000\uDC00",
                    real_name: "Real\u0001 Name",
                  },
                },
              }),
          },
        }).lookupVisibleName("U239XMLREAL");
        assert.strictEqual(realNameFallback, "Real Name");

        const slackIdFallback = yield* makeSlackParticipantLookup({
          users: {
            info: () =>
              Promise.resolve({
                user: {
                  profile: {
                    display_name: "\u0000\uD800",
                    real_name: "\u0001\uDC00",
                  },
                },
              }),
          },
        }).lookupVisibleName("U239XMLID");
        assert.strictEqual(slackIdFallback, "U239XMLID");
      })
  );

  it.live("bounds an oversized display name before participant rendering", () =>
    Effect.gen(function* () {
      const lookup = makeSlackParticipantLookup({
        users: {
          info: () =>
            Promise.resolve({
              user: {
                profile: {
                  display_name: "😀".repeat(
                    SLACK_VISIBLE_NAME_CHARACTER_LIMIT + 10
                  ),
                  real_name: "Real name must remain the fallback only",
                },
              },
            }),
        },
      });

      const visibleName = yield* lookup.lookupVisibleName("U239OVERSIZED");
      assert.strictEqual(
        EffectArray.fromIterable(visibleName).length,
        SLACK_VISIBLE_NAME_CHARACTER_LIMIT
      );
      assert.ok(!visibleName.includes("Real name"));
    })
  );

  it.live(
    "introduces Historical-context and activating humans in message order through users.info",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* startEmulatedSlack();
          const laborerRoot = yield* makeTempDirectoryScoped(
            "laborer-acp-participants-initial-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-acp-participants-initial-controls-"
          );
          const promptJsonlPath = join(controls, "prompts.jsonl");
          const releasePath = join(controls, "release");
          const workspaceId = "T239-INITIAL";
          const activatingUserId = "U239CURRENT";
          const usersInfoCalls: string[] = [];
          const participantLookup = makeSlackParticipantLookup({
            users: {
              info: ({ user }) => {
                usersInfoCalls.push(user);
                if (user === fixture.humanUserId) {
                  return Promise.resolve({
                    user: {
                      profile: {
                        display_name: "History & Display",
                        real_name: "Ignored History Name",
                      },
                    },
                  });
                }
                return Promise.resolve({
                  user: {
                    profile: { display_name: "", real_name: "Current Real" },
                  },
                });
              },
            },
          });
          yield* Effect.promise(() => writeFile(releasePath, "release"));
          const harness = yield* makeAcpConversationCanary({
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
              environment: {
                ...process.env,
                SCRIPTED_ACP_PROMPT_JSONL_PATH: promptJsonlPath,
                SCRIPTED_ACP_READY_PATH: join(controls, "ready"),
                SCRIPTED_ACP_RELEASE_PATH: releasePath,
              },
            },
            slack: fixture.gateway,
            workspaceId,
          });
          const profilesDirectory = join(
            laborerRoot,
            ".laborer-runtime",
            "slack-workspaces",
            encodeURIComponent(workspaceId),
            "user-profiles"
          );
          yield* Effect.promise(() => mkdir(profilesDirectory));
          yield* Effect.promise(() =>
            writeFile(
              join(
                profilesDirectory,
                `${encodeURIComponent(fixture.humanUserId)}.md`
              ),
              "History profile <private>"
            )
          );
          yield* Effect.promise(() =>
            writeFile(
              join(
                profilesDirectory,
                `${encodeURIComponent(activatingUserId)}.md`
              ),
              "Current profile & private"
            )
          );
          const otherWorkspaceProfiles = join(
            laborerRoot,
            ".laborer-runtime",
            "slack-workspaces",
            encodeURIComponent("T239-OTHER"),
            "user-profiles"
          );
          yield* Effect.promise(() =>
            mkdir(otherWorkspaceProfiles, { recursive: true })
          );
          yield* Effect.promise(() =>
            writeFile(
              join(
                otherWorkspaceProfiles,
                `${encodeURIComponent(activatingUserId)}.md`
              ),
              "OTHER WORKSPACE PROFILE MUST STAY PRIVATE"
            )
          );

          yield* postHumanMessage(fixture, "historical participant");
          const activationText = `<@${LABORER_SLACK_ID}> current participant`;
          const activation = yield* postHumanMessage(fixture, activationText);
          yield* harness.runner.inject(
            normalizedEvent({
              authorSlackId: activatingUserId,
              channelId: fixture.channelId,
              eventId: "event:239-initial",
              messageTs: timestampOf(activation),
              text: activationText,
            })
          );

          const records = yield* readPromptRecords(promptJsonlPath);
          const prompt = records[0]?.prompt ?? "";
          const historyIndex = prompt.indexOf(
            `slack-user-id="${fixture.humanUserId}"`
          );
          const currentIndex = prompt.indexOf(
            `slack-user-id="${activatingUserId}"`
          );
          assert.ok(historyIndex >= 0);
          assert.ok(currentIndex > historyIndex);
          assert.ok(prompt.includes('visible-name="History &amp; Display"'));
          assert.ok(prompt.includes('visible-name="Current Real"'));
          assert.ok(prompt.includes("History profile &lt;private&gt;"));
          assert.ok(prompt.includes("Current profile &amp; private"));
          assert.ok(!prompt.includes("OTHER WORKSPACE PROFILE"));
          assert.deepStrictEqual(usersInfoCalls, [
            fixture.humanUserId,
            activatingUserId,
          ]);
        })
      ),
    30_000
  );

  it.live(
    "introduces late and batched humans once while keeping profiles lazy and session-snapshotted",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* startEmulatedSlack();
          const laborerRoot = yield* makeTempDirectoryScoped(
            "laborer-acp-participants-late-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-acp-participants-late-controls-"
          );
          const promptJsonlPath = join(controls, "prompts.jsonl");
          const readyPath = join(controls, "ready");
          const releasePath = join(controls, "release");
          const workspaceId = "T239-LATE";
          const lateUserId = "U239LATE";
          const firstBatchedUserId = "U239BATCH1";
          const secondBatchedUserId = "U239BATCH2";
          const externalBotId = "B239EXTERNAL";
          const usersInfoCalls: string[] = [];
          const participantLookup = makeSlackParticipantLookup({
            users: {
              info: ({ user }) => {
                usersInfoCalls.push(user);
                return Promise.resolve({
                  user: {
                    profile: { display_name: `Name ${user}`, real_name: "" },
                  },
                });
              },
            },
          });
          yield* Effect.promise(() => writeFile(releasePath, "release"));
          const harness = yield* makeAcpConversationCanary({
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
              environment: {
                ...process.env,
                SCRIPTED_ACP_PROMPT_JSONL_PATH: promptJsonlPath,
                SCRIPTED_ACP_READY_PATH: readyPath,
                SCRIPTED_ACP_RELEASE_PATH: releasePath,
              },
            },
            slack: fixture.gateway,
            workspaceId,
          });
          const profilesDirectory = join(
            laborerRoot,
            ".laborer-runtime",
            "slack-workspaces",
            encodeURIComponent(workspaceId),
            "user-profiles"
          );

          const activationText = `<@${LABORER_SLACK_ID}> start profiles`;
          const activation = yield* postHumanMessage(fixture, activationText);
          const rootTs = timestampOf(activation);
          yield* harness.runner.inject(
            normalizedEvent({
              authorSlackId: fixture.humanUserId,
              channelId: fixture.channelId,
              eventId: "event:239-late-activation",
              messageTs: rootTs,
              text: activationText,
            })
          );
          const missingProfilePath = join(
            profilesDirectory,
            `${encodeURIComponent(fixture.humanUserId)}.md`
          );
          assert.strictEqual(
            yield* Effect.promise(async () => {
              try {
                await stat(missingProfilePath);
                return true;
              } catch {
                return false;
              }
            }),
            false
          );

          yield* Effect.promise(() => mkdir(profilesDirectory));
          yield* Effect.promise(() =>
            writeFile(
              join(profilesDirectory, `${encodeURIComponent(lateUserId)}.md`),
              "<".repeat(3000)
            )
          );
          yield* Effect.promise(() => rm(readyPath, { force: true }));
          yield* Effect.promise(() => rm(releasePath));
          const lateText = "late participant first message";
          const lateMessage = yield* postHumanMessage(fixture, lateText, {
            threadTs: rootTs,
          });
          const lateTurn = yield* Effect.forkChild(
            harness.runner.inject(
              normalizedEvent({
                authorSlackId: lateUserId,
                channelId: fixture.channelId,
                eventId: "event:239-late-first",
                messageTs: timestampOf(lateMessage),
                text: lateText,
                threadTs: rootTs,
              })
            )
          );
          yield* waitForFile(readyPath);

          const queuedTurns = yield* Effect.forEach(
            [
              ["human", firstBatchedUserId, "batch-one", "batched one"],
              ["human", secondBatchedUserId, "batch-two", "batched two"],
              ["externalBot", externalBotId, "batch-bot", "batched bot"],
              ["human", LABORER_SLACK_ID, "batch-laborer", "batched laborer"],
            ] as const,
            ([authorKind, authorSlackId, eventId, text]) =>
              Effect.gen(function* () {
                const message = yield* postHumanMessage(fixture, text, {
                  threadTs: rootTs,
                });
                return yield* Effect.forkChild(
                  harness.runner.inject(
                    normalizedEvent({
                      authorKind,
                      authorSlackId,
                      channelId: fixture.channelId,
                      eventId: `event:239-${eventId}`,
                      messageTs: timestampOf(message),
                      text,
                      threadTs: rootTs,
                    })
                  )
                );
              })
          );
          const queueDeadline = Date.now() + OBSERVATION_TIMEOUT_MILLIS;
          const expectedQueuedInputCount = 3;
          let queuedInputCount = 0;
          while (Date.now() < queueDeadline) {
            const snapshot = yield* harness.store.snapshot;
            queuedInputCount =
              snapshot.threads.find((thread) => thread.rootTs === rootTs)
                ?.unassigned.length ?? 0;
            if (queuedInputCount === expectedQueuedInputCount) {
              break;
            }
            yield* Effect.sleep("10 millis");
          }
          assert.strictEqual(queuedInputCount, expectedQueuedInputCount);
          yield* Effect.promise(() => writeFile(releasePath, "release"));
          yield* Fiber.join(lateTurn);
          yield* Effect.forEach(queuedTurns, Fiber.join, { discard: true });
          const firstThree = yield* waitForPromptCount(promptJsonlPath, 3);
          const latePrompt = firstThree[1]?.prompt ?? "";
          const batchedPrompt = firstThree[2]?.prompt ?? "";
          assert.ok(
            latePrompt.indexOf(`slack-user-id="${lateUserId}"`) <
              latePrompt.indexOf(lateText)
          );
          const lateProfile =
            USER_PROFILE_CONTENT_PATTERN.exec(latePrompt)?.[1] ?? "";
          assert.ok(EffectArray.fromIterable(lateProfile).length <= 2000);
          assert.ok(
            lateProfile.startsWith(
              "[TRUNCATED: bounded prefix of oversized user-profile]"
            )
          );
          assert.ok(
            batchedPrompt.indexOf(`slack-user-id="${firstBatchedUserId}"`) <
              batchedPrompt.indexOf(`slack-user-id="${secondBatchedUserId}"`)
          );
          assert.ok(
            !batchedPrompt.includes(`slack-user-id="${externalBotId}"`)
          );
          assert.ok(
            !batchedPrompt.includes(`slack-user-id="${LABORER_SLACK_ID}"`)
          );

          yield* Effect.promise(() =>
            writeFile(
              join(profilesDirectory, `${encodeURIComponent(lateUserId)}.md`),
              "edited profile must not replace the snapshot"
            )
          );
          const repeatText = "late participant again";
          const repeat = yield* postHumanMessage(fixture, repeatText, {
            threadTs: rootTs,
          });
          yield* harness.runner.inject(
            normalizedEvent({
              authorSlackId: lateUserId,
              channelId: fixture.channelId,
              eventId: "event:239-late-repeat",
              messageTs: timestampOf(repeat),
              text: repeatText,
              threadTs: rootTs,
            })
          );
          const firstFour = yield* waitForPromptCount(promptJsonlPath, 4);
          assert.ok(
            !firstFour[3]?.prompt.includes(`slack-user-id="${lateUserId}"`)
          );
          assert.ok(!firstFour[3]?.prompt.includes("edited profile"));
          assert.deepStrictEqual(usersInfoCalls, [
            fixture.humanUserId,
            lateUserId,
            firstBatchedUserId,
            secondBatchedUserId,
          ]);

          yield* Effect.promise(() =>
            writeFile(missingProfilePath, "operator edit for future sessions")
          );
          const existingSessionText = "original participant returns";
          const existingSessionMessage = yield* postHumanMessage(
            fixture,
            existingSessionText,
            { threadTs: rootTs }
          );
          yield* harness.runner.inject(
            normalizedEvent({
              authorSlackId: fixture.humanUserId,
              channelId: fixture.channelId,
              eventId: "event:239-original-repeat",
              messageTs: timestampOf(existingSessionMessage),
              text: existingSessionText,
              threadTs: rootTs,
            })
          );
          const newThreadText = `<@${LABORER_SLACK_ID}> use current profile`;
          const newThread = yield* postHumanMessage(fixture, newThreadText);
          yield* harness.runner.inject(
            normalizedEvent({
              authorSlackId: fixture.humanUserId,
              channelId: fixture.channelId,
              eventId: "event:239-new-session",
              messageTs: timestampOf(newThread),
              text: newThreadText,
            })
          );
          const allPrompts = yield* waitForPromptCount(promptJsonlPath, 6);
          assert.ok(!allPrompts[4]?.prompt.includes("operator edit"));
          assert.ok(
            allPrompts[5]?.prompt.includes("operator edit for future sessions")
          );
          assert.deepStrictEqual(usersInfoCalls, [
            fixture.humanUserId,
            lateUserId,
            firstBatchedUserId,
            secondBatchedUserId,
            fixture.humanUserId,
          ]);
        })
      ),
    30_000
  );

  it.live(
    "falls back from real name to Slack ID and keeps users.info failures private",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* startEmulatedSlack();
          const laborerRoot = yield* makeTempDirectoryScoped(
            "laborer-acp-participants-fallback-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-acp-participants-fallback-controls-"
          );
          const promptJsonlPath = join(controls, "prompts.jsonl");
          const releasePath = join(controls, "release");
          const workspaceId = "T239-FALLBACK";
          const realNameUserId = "U239REAL";
          const idFallbackUserId = "U239ID";
          const failedUserId = "U239FAIL";
          const warnings: string[] = [];
          const warningLogger = Logger.make<unknown, void>((options) => {
            if (options.logLevel === "Warn") {
              warnings.push(String(options.message));
            }
          });
          const participantLookup = makeSlackParticipantLookup({
            users: {
              info: ({ user }) => {
                if (user === failedUserId) {
                  return Promise.reject(
                    new Error("PRIVATE SLACK API FAILURE 239")
                  );
                }
                if (user === realNameUserId) {
                  return Promise.resolve({
                    user: {
                      profile: {
                        display_name: " ",
                        real_name: "Real Name Fallback",
                      },
                    },
                  });
                }
                if (user === idFallbackUserId) {
                  return Promise.resolve({
                    user: { profile: { display_name: "", real_name: "" } },
                  });
                }
                return Promise.resolve({
                  user: {
                    profile: {
                      display_name: "Initial Display",
                      real_name: "Initial Real",
                    },
                  },
                });
              },
            },
          });
          yield* Effect.promise(() => writeFile(releasePath, "release"));
          const harness = yield* makeAcpConversationCanary({
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
              environment: {
                ...process.env,
                SCRIPTED_ACP_PROMPT_JSONL_PATH: promptJsonlPath,
                SCRIPTED_ACP_READY_PATH: join(controls, "ready"),
                SCRIPTED_ACP_RELEASE_PATH: releasePath,
              },
            },
            slack: fixture.gateway,
            workspaceId,
          });
          const profilesDirectory = join(
            laborerRoot,
            ".laborer-runtime",
            "slack-workspaces",
            encodeURIComponent(workspaceId),
            "user-profiles"
          );
          yield* Effect.promise(() => mkdir(profilesDirectory));
          yield* Effect.promise(() =>
            writeFile(
              join(profilesDirectory, `${encodeURIComponent(failedUserId)}.md`),
              "PRIVATE FAILURE PROFILE 239"
            )
          );

          const activationText = `<@${LABORER_SLACK_ID}> fallback test`;
          const activation = yield* postHumanMessage(fixture, activationText);
          const rootTs = timestampOf(activation);
          yield* harness.runner.inject(
            normalizedEvent({
              authorSlackId: fixture.humanUserId,
              channelId: fixture.channelId,
              eventId: "event:239-fallback-activation",
              messageTs: rootTs,
              text: activationText,
            })
          );

          for (const [authorSlackId, eventId] of [
            [realNameUserId, "real"],
            [idFallbackUserId, "id"],
            [failedUserId, "failure"],
          ] as const) {
            const text = `message from ${eventId}`;
            const message = yield* postHumanMessage(fixture, text, {
              threadTs: rootTs,
            });
            const injection = harness.runner.inject(
              normalizedEvent({
                authorSlackId,
                channelId: fixture.channelId,
                eventId: `event:239-fallback-${eventId}`,
                messageTs: timestampOf(message),
                text,
                threadTs: rootTs,
              })
            );
            yield* authorSlackId === failedUserId
              ? injection.pipe(Effect.provide(Logger.layer([warningLogger])))
              : injection;
          }

          const prompts = yield* waitForPromptCount(promptJsonlPath, 4);
          assert.ok(
            prompts[1]?.prompt.includes('visible-name="Real Name Fallback"')
          );
          assert.ok(
            prompts[2]?.prompt.includes(
              `slack-user-id="${idFallbackUserId}" visible-name="${idFallbackUserId}"`
            )
          );
          assert.ok(
            prompts[3]?.prompt.includes(
              `slack-user-id="${failedUserId}" visible-name="${failedUserId}"`
            )
          );
          assert.ok(prompts[3]?.prompt.includes("PRIVATE FAILURE PROFILE 239"));
          assert.ok(
            EffectArray.some(warnings, (warning) =>
              warning.includes("Slack participant lookup failed")
            )
          );
          assert.ok(
            !EffectArray.some(warnings, (warning) =>
              warning.includes("PRIVATE SLACK API FAILURE 239")
            )
          );

          const replies = yield* Effect.promise(() =>
            fixture.humanClient.conversations.replies({
              channel: fixture.channelId,
              limit: 100,
              ts: rootTs,
            })
          );
          const publicText = pipe(
            replies.messages ?? [],
            EffectArray.map((message) => String(message.text ?? "")),
            (parts) => parts.join("\n")
          );
          assert.ok(!publicText.includes("PRIVATE FAILURE PROFILE 239"));
          assert.ok(!publicText.includes("PRIVATE SLACK API FAILURE 239"));
          assert.ok(!publicText.includes(failedUserId));
        })
      ),
    30_000
  );
});
