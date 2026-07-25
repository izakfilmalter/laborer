import {
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assert, describe, it } from "@effect/vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { Effect, Logger } from "effect";
import { makeAcpConversationAgent } from "../src/acp-conversation-prototype/acp-conversation-agent.ts";
import {
  acpAgentContextPaths,
  isSlackTeamId,
  loadAcpAgentContextSnapshot,
  loadAcpSlackParticipantContexts,
  prepareAcpAgentContextSources,
  userProfilePath,
} from "../src/acp-conversation-prototype/agent-context.ts";
import { makeAcpConversationCanary } from "../src/acp-conversation-prototype/canary-composition.ts";
import {
  framedMemoryEntries,
  renderFramedMemoryEntry,
} from "../src/acp-conversation-prototype/memory-framing.ts";
import {
  authorizeLaborerMemoryPermission,
  LABORER_MEMORY_MCP_TOOL_NAME,
  laborerMemoryOpenCodePermission,
  makeLaborerMemoryMcpServerConfiguration,
  makeLaborerMemoryStore,
  prepareLaborerMemoryMcpRegistration,
} from "../src/acp-conversation-prototype/memory-mcp.ts";
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
import { makeTempDirectoryScoped } from "./support/temp-directory.ts";

const projectRoot = process.cwd();
const serverPath = resolve(
  projectRoot,
  "src/acp-conversation-prototype/memory-mcp-server.ts"
);
const OWNER_ONLY_PERMISSION_MODULUS = 0o100;
const scriptedPeerPath = resolve(
  projectRoot,
  "tests/fixtures/scripted-acp-peer.ts"
);
const MEMORY_GUIDANCE_PATTERN =
  /durable information likely to improve future workspace collaboration/;
const MEMORY_PRIVACY_GUIDANCE_PATTERN =
  /Keep routine maintenance acknowledgements, tool results, and diagnostics private; still answer substantively when a user explicitly asks about remembered information/;
const CONCURRENT_FIRST_PATTERN = /concurrent first/;
const CONCURRENT_SECOND_PATTERN = /concurrent second/;
const TRUNCATED_WORKSPACE_ASCII_PATTERN =
  /^\[TRUNCATED: bounded prefix of oversized workspace-memory\]\na+$/;
const TRUNCATED_PROFILE_ASCII_PATTERN =
  /^\[TRUNCATED: bounded prefix of oversized user-profile\]\na+$/;

interface MemoryCall {
  readonly operation: "add" | "remove" | "replace";
  readonly replacement?: string;
  readonly target: "user" | "workspace";
  readonly text: string;
  readonly userId?: string;
}

const withMemoryClient = async <A>(
  options: {
    readonly configRoot?: string;
    readonly environment?: Record<string, string>;
    readonly root: string;
    readonly stateRoot?: string;
    readonly workspaceId: string;
  },
  use: (client: Client) => Promise<A>
): Promise<A> => {
  const sources = await Effect.runPromise(
    prepareAcpAgentContextSources({
      ...(options.configRoot === undefined
        ? {}
        : { configRoot: options.configRoot }),
      root: options.root,
      ...(options.stateRoot === undefined
        ? {}
        : { stateRoot: options.stateRoot }),
      workspaceId: options.workspaceId,
    })
  );
  const client = new Client({ name: "laborer-memory-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    args: [serverPath],
    command: process.execPath,
    env: {
      LABORER_MEMORY_CONFIG_ROOT: sources.configRoot,
      LABORER_MEMORY_ROOT: options.root,
      LABORER_MEMORY_STATE_ROOT: sources.stateRoot,
      LABORER_MEMORY_WORKSPACE_ID: options.workspaceId,
      ...options.environment,
    },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    return await use(client);
  } finally {
    await client.close();
  }
};

const callMemory = (client: Client, input: MemoryCall) =>
  client.callTool({
    arguments: { ...input },
    name: LABORER_MEMORY_MCP_TOOL_NAME,
  });

const callMemoryWithSignal = (
  client: Client,
  input: MemoryCall,
  signal: AbortSignal
) =>
  client.callTool(
    {
      arguments: { ...input },
      name: LABORER_MEMORY_MCP_TOOL_NAME,
    },
    CallToolResultSchema,
    { signal }
  );

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolveWait) => {
    setTimeout(resolveWait, milliseconds);
  });

const pathExists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false
  );

const waitForPath = async (path: string): Promise<void> => {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const exists = await stat(path).then(
      () => true,
      () => false
    );
    if (exists) {
      return;
    }
    await wait(10);
  }
  throw new Error(`Timed out waiting for test path: ${path}`);
};

const waitForSqliteWriteLock = async (path: string): Promise<void> => {
  await waitForPath(path);
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const database = new DatabaseSync(path, { timeout: 0 });
    try {
      database.exec("PRAGMA busy_timeout = 0");
      database.exec("BEGIN IMMEDIATE");
      database.exec("ROLLBACK");
    } catch (error) {
      const code =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string"
          ? error.code
          : "";
      const isBusy =
        code.startsWith("SQLITE_BUSY") ||
        code.startsWith("SQLITE_LOCKED") ||
        (error instanceof Error &&
          error.message.includes("database is locked"));
      if (isBusy) {
        return;
      }
      throw error;
    } finally {
      database.close();
    }
    await wait(10);
  }
  throw new Error(`Timed out waiting for SQLite lock: ${path}`);
};

describe("issue #240 memory MCP", () => {
  it.live(
    "keeps agent maintenance silent in Slack and snapshots its write into a future thread",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* startEmulatedSlack();
          const root = yield* makeTempDirectoryScoped(
            "laborer-memory-slack-acp-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-memory-slack-acp-controls-"
          );
          const promptPath = resolve(controls, "prompts.jsonl");
          const memoryActivityPath = resolve(controls, "memory-activity.jsonl");
          const releasePath = resolve(controls, "release");
          const retainedText = "The release train departs on Thursday.";
          const failedMemoryText = "MEMORY FAILURE INPUT SECRET 240 ".repeat(
            200
          );
          yield* Effect.promise(() => writeFile(releasePath, "release"));
          const harness = yield* makeAcpConversationCanary({
            activationAcknowledger: makeSlackActivationAcknowledger(
              fixture.botClient
            ),
            completionReactor: makeSlackCompletionReactor(fixture.botClient),
            laborerSlackId: LABORER_SLACK_ID,
            process: {
              args: [scriptedPeerPath],
              command: process.execPath,
              cwd: root,
              environment: {
                ...process.env,
                SCRIPTED_ACP_MEMORY_OPERATION_JSON: JSON.stringify({
                  operation: "add",
                  target: "workspace",
                  text: retainedText,
                }),
                SCRIPTED_ACP_MEMORY_ACTIVITY_JSONL_PATH: memoryActivityPath,
                SCRIPTED_ACP_MEMORY_FAILURE_OPERATION_JSON: JSON.stringify({
                  operation: "add",
                  target: "workspace",
                  text: failedMemoryText,
                }),
                SCRIPTED_ACP_PROMPT_JSONL_PATH: promptPath,
                SCRIPTED_ACP_READY_PATH: resolve(controls, "ready"),
                SCRIPTED_ACP_RELEASE_PATH: releasePath,
              },
            },
            slack: fixture.gateway,
            workspaceId: "T240SLACK",
          });

          const firstText = `<@${LABORER_SLACK_ID}> remember the release train`;
          const first = yield* postHumanMessage(fixture, firstText);
          const firstTs = timestampOf(first);
          yield* harness.runner.inject(
            normalizedEvent({
              authorSlackId: fixture.humanUserId,
              channelId: fixture.channelId,
              eventId: "event:240-memory-first",
              messageTs: firstTs,
              text: firstText,
            })
          );

          const secondText = `<@${LABORER_SLACK_ID}> what should we work on?`;
          const second = yield* postHumanMessage(fixture, secondText);
          const secondTs = timestampOf(second);
          yield* harness.runner.inject(
            normalizedEvent({
              authorSlackId: fixture.humanUserId,
              channelId: fixture.channelId,
              eventId: "event:240-memory-second",
              messageTs: secondTs,
              text: secondText,
            })
          );

          const prompts = (yield* Effect.promise(() =>
            readFile(promptPath, "utf8")
          ))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { prompt: string });
          assert.strictEqual(prompts.length, 2);
          assert.ok(!prompts[0]?.prompt.includes(retainedText));
          assert.ok(prompts[1]?.prompt.includes(retainedText));
          assert.ok(
            !prompts.some(({ prompt }) =>
              prompt.includes("laborer-memory-entry")
            )
          );
          const memorySources = yield* prepareAcpAgentContextSources({
            root,
            workspaceId: "T240SLACK",
          });
          const diagnostic = yield* Effect.promise(() =>
            readFile(memorySources.memoryDiagnosticsPath, "utf8")
          );
          assert.ok(diagnostic.length <= 4096);
          assert.ok(diagnostic.includes("mutation-limit-exceeded"));
          assert.ok(!diagnostic.includes(failedMemoryText));
          const diagnosticMetadata = yield* Effect.promise(() =>
            stat(memorySources.memoryDiagnosticsPath)
          );
          assert.strictEqual(
            diagnosticMetadata.mode % OWNER_ONLY_PERMISSION_MODULUS,
            0
          );
          const privateActivity = (yield* Effect.promise(() =>
            readFile(memoryActivityPath, "utf8")
          ))
            .trim()
            .split("\n")
            .map(
              (line) =>
                JSON.parse(line) as {
                  sessionUpdate: string;
                  status?: string;
                }
            );
          assert.deepStrictEqual(
            privateActivity.map(({ sessionUpdate, status }) => ({
              sessionUpdate,
              status,
            })),
            [
              { sessionUpdate: "tool_call", status: "pending" },
              { sessionUpdate: "tool_call_update", status: "completed" },
              { sessionUpdate: "tool_call", status: "pending" },
              { sessionUpdate: "tool_call_update", status: "failed" },
            ]
          );

          for (const threadTs of [firstTs, secondTs]) {
            const replies = yield* Effect.promise(() =>
              fixture.humanClient.conversations.replies({
                channel: fixture.channelId,
                limit: 100,
                ts: threadTs,
              })
            );
            assert.ok(
              !(replies.messages ?? []).some((message) => {
                const text = String(message.text ?? "");
                return (
                  text.includes(retainedText) ||
                  text.includes("Memory updated") ||
                  text.includes("laborer-memory") ||
                  text.includes("LABORER MEMORY TOOL SECRET 240") ||
                  text.includes("LABORER MEMORY TOOL INPUT SECRET 240") ||
                  text.includes("LABORER MEMORY TOOL OUTPUT SECRET 240") ||
                  text.includes("MEMORY FAILURE INPUT SECRET 240") ||
                  text.includes("limit-exceeded") ||
                  text.includes("Memory mutation would exceed")
                );
              })
            );
          }
        })
      ),
    30_000
  );

  it.live(
    "introduces a User profile written over real stdio MCP in a future Slack thread",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* startEmulatedSlack();
          const root = yield* makeTempDirectoryScoped(
            "laborer-memory-profile-slack-acp-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-memory-profile-slack-acp-controls-"
          );
          const promptPath = resolve(controls, "prompts.jsonl");
          const releasePath = resolve(controls, "release");
          const profileText = "Prefers release summaries with explicit owners.";
          yield* Effect.promise(() => writeFile(releasePath, "release"));
          const harness = yield* makeAcpConversationCanary({
            activationAcknowledger: makeSlackActivationAcknowledger(
              fixture.botClient
            ),
            completionReactor: makeSlackCompletionReactor(fixture.botClient),
            laborerSlackId: LABORER_SLACK_ID,
            process: {
              args: [scriptedPeerPath],
              command: process.execPath,
              cwd: root,
              environment: {
                ...process.env,
                SCRIPTED_ACP_MEMORY_OPERATION_JSON: JSON.stringify({
                  operation: "add",
                  target: "user",
                  text: profileText,
                  userId: fixture.humanUserId,
                }),
                SCRIPTED_ACP_PROMPT_JSONL_PATH: promptPath,
                SCRIPTED_ACP_READY_PATH: resolve(controls, "ready"),
                SCRIPTED_ACP_RELEASE_PATH: releasePath,
              },
            },
            slack: fixture.gateway,
            workspaceId: "T240PROFILESLACK",
          });

          const firstText = `<@${LABORER_SLACK_ID}> remember my preference`;
          const first = yield* postHumanMessage(fixture, firstText);
          const firstTs = timestampOf(first);
          yield* harness.runner.inject(
            normalizedEvent({
              authorSlackId: fixture.humanUserId,
              channelId: fixture.channelId,
              eventId: "event:240-profile-memory-first",
              messageTs: firstTs,
              text: firstText,
            })
          );
          const secondText = `<@${LABORER_SLACK_ID}> summarize the release`;
          const second = yield* postHumanMessage(fixture, secondText);
          const secondTs = timestampOf(second);
          yield* harness.runner.inject(
            normalizedEvent({
              authorSlackId: fixture.humanUserId,
              channelId: fixture.channelId,
              eventId: "event:240-profile-memory-second",
              messageTs: secondTs,
              text: secondText,
            })
          );

          const prompts = (yield* Effect.promise(() =>
            readFile(promptPath, "utf8")
          ))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { prompt: string });
          assert.strictEqual(prompts.length, 2);
          assert.ok(!prompts[0]?.prompt.includes(profileText));
          assert.ok(prompts[1]?.prompt.includes(profileText));
          assert.ok(
            prompts[1]?.prompt.includes(
              `slack-user-id="${fixture.humanUserId}"`
            )
          );
          for (const threadTs of [firstTs, secondTs]) {
            const replies = yield* Effect.promise(() =>
              fixture.humanClient.conversations.replies({
                channel: fixture.channelId,
                limit: 100,
                ts: threadTs,
              })
            );
            const publicText = (replies.messages ?? [])
              .map((message) => String(message.text ?? ""))
              .join("\n");
            assert.ok(!publicText.includes(profileText));
            assert.ok(
              !publicText.includes("LABORER MEMORY TOOL INPUT SECRET 240")
            );
            assert.ok(
              !publicText.includes("LABORER MEMORY TOOL OUTPUT SECRET 240")
            );
          }
        })
      ),
    30_000
  );

  it.live(
    "attaches a unique server registration and pre-authorizes only its observed exact tool call",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped("laborer-memory-acp-");
          const controls = yield* makeTempDirectoryScoped(
            "laborer-memory-acp-controls-"
          );
          const permissionResultPath = resolve(controls, "permission.json");
          const sessionRequestPath = resolve(controls, "sessions.jsonl");
          const configuration = makeLaborerMemoryMcpServerConfiguration(
            yield* prepareAcpAgentContextSources({
              root,
              workspaceId: "T240ACP00",
            })
          );
          const memoryPermission = laborerMemoryOpenCodePermission(
            configuration.name
          );
          const conversationAgent = yield* makeAcpConversationAgent({
            args: [scriptedPeerPath],
            command: process.execPath,
            cwd: root,
            environment: {
              ...process.env,
              SCRIPTED_ACP_PERMISSION_RESULT_PATH: permissionResultPath,
              SCRIPTED_ACP_PERMISSION_TITLE: memoryPermission,
              SCRIPTED_ACP_PERMISSION_TOOL_IDENTITY: "attached-memory",
              SCRIPTED_ACP_READY_PATH: resolve(controls, "ready"),
              SCRIPTED_ACP_RELEASE_PATH: resolve(controls, "release"),
              SCRIPTED_ACP_SESSION_REQUEST_JSONL_PATH: sessionRequestPath,
            },
            memoryMcpServer: configuration,
          });
          yield* Effect.promise(() =>
            writeFile(resolve(controls, "release"), "release")
          );

          yield* conversationAgent.handle(
            {
              actions: [],
              context: [],
              conversationId: "conversation:240-acp",
              conversationSessionId: "logical:240-acp",
              conversationSessionIsNew: true,
              executionControls: [],
              executions: [],
              input: "remember this privately",
              messages: [],
              promptId: "prompt:240-acp",
              source: "slack",
              turnId: "turn:240-acp",
            },
            () => Effect.void
          );

          const requests = (yield* Effect.promise(() =>
            readFile(sessionRequestPath, "utf8")
          ))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { mcpServers: unknown[] });
          const [attachedServer] = requests[0]?.mcpServers ?? [];
          assert.ok(
            typeof attachedServer === "object" && attachedServer !== null
          );
          assert.match(
            (attachedServer as { name?: string }).name ?? "",
            new RegExp(`^${configuration.name}-[0-9a-f]{32}$`)
          );
          assert.deepStrictEqual(
            (attachedServer as { args?: unknown }).args,
            configuration.args
          );
          assert.strictEqual(
            (attachedServer as { env?: unknown[] }).env?.length,
            configuration.env.length + 2
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

          assert.deepStrictEqual(
            authorizeLaborerMemoryPermission(
              {
                options: [
                  {
                    kind: "allow_once",
                    name: "Allow once",
                    optionId: "must-not-be-selected",
                  },
                ],
                sessionId: "session:unrelated",
                toolCall: {
                  title: memoryPermission,
                  toolCallId: "tool:unrelated",
                },
              },
              new Map()
            ),
            { outcome: { outcome: "cancelled" } }
          );
          assert.deepStrictEqual(
            authorizeLaborerMemoryPermission(
              {
                options: [
                  {
                    kind: "allow_once",
                    name: "Allow once",
                    optionId: "must-not-be-selected",
                  },
                ],
                sessionId: "session:trusted",
                toolCall: {
                  name: "unrelated_tool",
                  title: memoryPermission,
                  toolCallId: "tool:spoofed-title",
                },
              },
              new Map([
                [
                  "session:trusted",
                  {
                    observedToolCallIds: new Set<string>(),
                    permission: memoryPermission,
                  },
                ],
              ])
            ),
            { outcome: { outcome: "cancelled" } }
          );
        })
      ),
    20_000
  );

  it.live(
    "keeps readiness failures silent through Slack Runner publication",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* startEmulatedSlack();
          const scenarios = [
            {
              code: "registration-missing",
              environment: { SCRIPTED_ACP_SKIP_MCP_REGISTRATION: "1" },
              workspaceId: "T240SLACKREGMISSING",
            },
            {
              code: "registration-collision",
              environment: { SCRIPTED_ACP_COLLIDE_MCP_REGISTRATION: "1" },
              workspaceId: "T240SLACKREGCOLLISION",
            },
          ] as const;

          for (const [index, scenario] of scenarios.entries()) {
            const root = yield* makeTempDirectoryScoped(
              "laborer-memory-slack-registration-failure-"
            );
            const controls = yield* makeTempDirectoryScoped(
              "laborer-memory-slack-registration-controls-"
            );
            yield* Effect.promise(() =>
              writeFile(resolve(controls, "release"), "release")
            );
            const harness = yield* makeAcpConversationCanary({
              activationAcknowledger: makeSlackActivationAcknowledger(
                fixture.botClient
              ),
              completionReactor: makeSlackCompletionReactor(fixture.botClient),
              laborerSlackId: LABORER_SLACK_ID,
              process: {
                args: [scriptedPeerPath],
                command: process.execPath,
                cwd: root,
                environment: {
                  ...process.env,
                  ...scenario.environment,
                  SCRIPTED_ACP_READY_PATH: resolve(controls, "ready"),
                  SCRIPTED_ACP_RELEASE_PATH: resolve(controls, "release"),
                },
              },
              slack: fixture.gateway,
              workspaceId: scenario.workspaceId,
            });
            const privateInput = `PRIVATE REGISTRATION INPUT ${index}`;
            const text = `<@${LABORER_SLACK_ID}> ${privateInput}`;
            const posted = yield* postHumanMessage(fixture, text);
            const rootTs = timestampOf(posted);
            yield* harness.runner.inject(
              normalizedEvent({
                authorSlackId: fixture.humanUserId,
                channelId: fixture.channelId,
                eventId: `event:240-slack-registration-${index}`,
                messageTs: rootTs,
                text,
              })
            );
            const sources = yield* prepareAcpAgentContextSources({
              root,
              workspaceId: scenario.workspaceId,
            });
            const diagnostics = yield* Effect.promise(() =>
              readFile(sources.memoryDiagnosticsPath, "utf8")
            );
            assert.ok(diagnostics.includes(scenario.code));
            assert.ok(diagnostics.length <= 4096);
            assert.ok(!diagnostics.includes(privateInput));
            assert.ok(!diagnostics.includes(root));

            const replies = yield* Effect.promise(() =>
              fixture.humanClient.conversations.replies({
                channel: fixture.channelId,
                limit: 100,
                ts: rootTs,
              })
            );
            const publicText = (replies.messages ?? [])
              .map((message) => String(message.text ?? ""))
              .join("\n");
            assert.ok(
              !publicText.includes(
                "This conversation turn could not be completed"
              )
            );
            assert.ok(!publicText.includes("registration-"));
            assert.ok(!publicText.includes(root));
          }
        })
      ),
    40_000
  );

  it.live(
    "cancels a colliding memory permission from an ACP session without memory configuration",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-memory-untrusted-acp-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-memory-untrusted-acp-controls-"
          );
          const permissionResultPath = resolve(controls, "permission.json");
          const conversationAgent = yield* makeAcpConversationAgent({
            args: [scriptedPeerPath],
            command: process.execPath,
            cwd: root,
            environment: {
              ...process.env,
              SCRIPTED_ACP_PERMISSION_RESULT_PATH: permissionResultPath,
              SCRIPTED_ACP_PERMISSION_TITLE: "laborer-memory-collision_memory",
              SCRIPTED_ACP_READY_PATH: resolve(controls, "ready"),
              SCRIPTED_ACP_RELEASE_PATH: resolve(controls, "release"),
            },
          });
          yield* Effect.promise(() =>
            writeFile(resolve(controls, "release"), "release")
          );
          yield* conversationAgent.handle(
            {
              actions: [],
              context: [],
              conversationId: "conversation:240-untrusted",
              conversationSessionId: "logical:240-untrusted",
              conversationSessionIsNew: true,
              executionControls: [],
              executions: [],
              input: "collision",
              messages: [],
              promptId: "prompt:240-untrusted",
              source: "slack",
              turnId: "turn:240-untrusted",
            },
            () => Effect.void
          );
          assert.deepStrictEqual(
            JSON.parse(
              yield* Effect.promise(() =>
                readFile(permissionResultPath, "utf8")
              )
            ),
            { outcome: { outcome: "cancelled" } }
          );
        })
      ),
    20_000
  );

  it.live(
    "keeps older sessions on distinct registrations in a process-global OpenCode-style registry",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-memory-shared-registry-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-memory-shared-registry-controls-"
          );
          const activityPath = resolve(controls, "memory-activity.jsonl");
          const sessionRequestPath = resolve(controls, "sessions.jsonl");
          const configuration = makeLaborerMemoryMcpServerConfiguration(
            yield* prepareAcpAgentContextSources({
              root,
              workspaceId: "T240SHAREDREGISTRY",
            })
          );
          const agent = yield* makeAcpConversationAgent({
            args: [scriptedPeerPath],
            command: process.execPath,
            cwd: root,
            environment: {
              ...process.env,
              SCRIPTED_ACP_MEMORY_ACTIVITY_JSONL_PATH: activityPath,
              SCRIPTED_ACP_MEMORY_OPERATION_EVERY_PROMPT: "1",
              SCRIPTED_ACP_MEMORY_OPERATION_JSON: JSON.stringify({
                operation: "add",
                target: "workspace",
                text: "shared registry remains available",
              }),
              SCRIPTED_ACP_READY_PATH: resolve(controls, "ready"),
              SCRIPTED_ACP_RELEASE_PATH: resolve(controls, "release"),
              SCRIPTED_ACP_SESSION_REQUEST_JSONL_PATH: sessionRequestPath,
            },
            memoryMcpServer: configuration,
          });
          yield* Effect.promise(() =>
            writeFile(resolve(controls, "release"), "release")
          );
          const request = (conversationId: string, promptId: string) => ({
            actions: [],
            context: [],
            conversationId,
            conversationSessionId: `logical:${conversationId}`,
            conversationSessionIsNew: promptId === "one",
            executionControls: [],
            executions: [],
            input: `prompt ${promptId}`,
            messages: [],
            promptId: `prompt:${conversationId}:${promptId}`,
            source: "slack" as const,
            turnId: `turn:${conversationId}:${promptId}`,
          });
          yield* agent.handle(
            request("conversation:first", "one"),
            () => Effect.void
          );
          yield* agent.handle(
            request("conversation:second", "one"),
            () => Effect.void
          );
          yield* agent.handle(
            request("conversation:first", "two"),
            () => Effect.void
          );

          const registrations = (yield* Effect.promise(() =>
            readFile(sessionRequestPath, "utf8")
          ))
            .trim()
            .split("\n")
            .map(
              (line) =>
                JSON.parse(line) as {
                  mcpServers: readonly { readonly name: string }[];
                }
            );
          const names = registrations.map(
            (entry) => entry.mcpServers[0]?.name ?? ""
          );
          assert.strictEqual(names.length, 2);
          assert.strictEqual(new Set(names).size, 2);
          assert.ok(
            names.every((name) =>
              new RegExp(`^${configuration.name}-[0-9a-f]{32}$`).test(name)
            )
          );
          const activity = (yield* Effect.promise(() =>
            readFile(activityPath, "utf8")
          ))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { readonly status?: string });
          assert.strictEqual(
            activity.filter(({ status }) => status === "completed").length,
            3
          );
          assert.strictEqual(
            activity.filter(({ status }) => status === "failed").length,
            0
          );
        })
      ),
    30_000
  );

  it.live(
    "cancels a spoofed memory title from a trusted ACP session callback",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-memory-spoofed-permission-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-memory-spoofed-permission-controls-"
          );
          const permissionResultPath = resolve(controls, "permission.json");
          const configuration = makeLaborerMemoryMcpServerConfiguration(
            yield* prepareAcpAgentContextSources({
              root,
              workspaceId: "T240SPOOFEDPERMISSION",
            })
          );
          const memoryPermission = laborerMemoryOpenCodePermission(
            configuration.name
          );
          const conversationAgent = yield* makeAcpConversationAgent({
            args: [scriptedPeerPath],
            command: process.execPath,
            cwd: root,
            environment: {
              ...process.env,
              SCRIPTED_ACP_PERMISSION_RESULT_PATH: permissionResultPath,
              SCRIPTED_ACP_PERMISSION_TITLE: memoryPermission,
              SCRIPTED_ACP_PERMISSION_TOOL_IDENTITY: "attached-memory",
              SCRIPTED_ACP_PERMISSION_TOOL_NAME: "unrelated_tool",
              SCRIPTED_ACP_READY_PATH: resolve(controls, "ready"),
              SCRIPTED_ACP_RELEASE_PATH: resolve(controls, "release"),
            },
            memoryMcpServer: configuration,
          });
          yield* Effect.promise(() =>
            writeFile(resolve(controls, "release"), "release")
          );
          yield* conversationAgent.handle(
            {
              actions: [],
              context: [],
              conversationId: "conversation:240-spoofed-permission",
              conversationSessionId: "logical:240-spoofed-permission",
              conversationSessionIsNew: true,
              executionControls: [],
              executions: [],
              input: "spoofed permission",
              messages: [],
              promptId: "prompt:240-spoofed-permission",
              source: "slack",
              turnId: "turn:240-spoofed-permission",
            },
            () => Effect.void
          );
          assert.deepStrictEqual(
            JSON.parse(
              yield* Effect.promise(() =>
                readFile(permissionResultPath, "utf8")
              )
            ),
            { outcome: { outcome: "cancelled" } }
          );
        })
      ),
    20_000
  );

  it.live(
    "does not retry a failed session/new without the memory capability or mislabel the failure",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-memory-session-failure-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-memory-session-failure-controls-"
          );
          const sessionRequestPath = resolve(controls, "sessions.jsonl");
          const configuration = makeLaborerMemoryMcpServerConfiguration(
            yield* prepareAcpAgentContextSources({
              root,
              workspaceId: "T240SESSIONFAILURE",
            })
          );
          const conversationAgent = yield* makeAcpConversationAgent({
            args: [scriptedPeerPath],
            command: process.execPath,
            cwd: root,
            environment: {
              ...process.env,
              SCRIPTED_ACP_READY_PATH: resolve(controls, "ready"),
              SCRIPTED_ACP_REJECT_SESSION_WITH_MCP: "1",
              SCRIPTED_ACP_RELEASE_PATH: resolve(controls, "release"),
              SCRIPTED_ACP_SESSION_REQUEST_JSONL_PATH: sessionRequestPath,
            },
            memoryMcpServer: configuration,
          });
          yield* Effect.promise(() =>
            writeFile(resolve(controls, "release"), "release")
          );
          const warnings: string[] = [];
          const warningLogger = Logger.make<unknown, void>((options) => {
            if (options.logLevel === "Warn") {
              warnings.push(String(options.message));
            }
          });
          const published: string[] = [];
          const result = yield* Effect.result(
            conversationAgent
              .handle(
                {
                  actions: [],
                  context: [],
                  conversationId: "conversation:240-session-failure",
                  conversationSessionId: "logical:240-session-failure",
                  conversationSessionIsNew: true,
                  executionControls: [],
                  executions: [],
                  input: "must fail once",
                  messages: [],
                  promptId: "prompt:240-session-failure",
                  source: "slack",
                  turnId: "turn:240-session-failure",
                },
                ({ text }) => Effect.sync(() => published.push(text))
              )
              .pipe(Effect.provide(Logger.layer([warningLogger])))
          );
          assert.strictEqual(result._tag, "Failure");
          assert.deepStrictEqual(published, []);
          const requests = (yield* Effect.promise(() =>
            readFile(sessionRequestPath, "utf8")
          ))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { mcpServers: unknown[] });
          assert.strictEqual(requests.length, 1);
          const [attachedServer] = requests[0]?.mcpServers ?? [];
          assert.ok(
            typeof attachedServer === "object" && attachedServer !== null
          );
          assert.match(
            (attachedServer as { name?: string }).name ?? "",
            new RegExp(`^${configuration.name}-[0-9a-f]{32}$`)
          );
          assert.strictEqual(
            (attachedServer as { env?: unknown[] }).env?.length,
            configuration.env.length + 2
          );
          assert.ok(
            !warnings.some((warning) =>
              warning.includes("Memory MCP registration failed")
            )
          );
          const sources = yield* prepareAcpAgentContextSources({
            root,
            workspaceId: "T240SESSIONFAILURE",
          });
          assert.strictEqual(
            yield* Effect.promise(() =>
              readFile(sources.memoryDiagnosticsPath, "utf8").then(
                () => true,
                () => false
              )
            ),
            false
          );
        })
      ),
    20_000
  );

  it.live(
    "distinguishes invalid, missing, and colliding registrations with private bounded diagnostics",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-memory-registration-failures-"
          );
          const scenarios = [
            {
              code: "registration-invalid",
              conversationId: "conversation:240-registration-invalid",
              environment: {},
              invalidateConfiguration: true,
              workspaceId: "T240REGINVALID",
            },
            {
              code: "registration-missing",
              conversationId: "conversation:240-registration-missing",
              environment: { SCRIPTED_ACP_SKIP_MCP_REGISTRATION: "1" },
              invalidateConfiguration: false,
              workspaceId: "T240REGMISSING",
            },
            {
              code: "registration-collision",
              conversationId: "conversation:240-registration-collision",
              environment: { SCRIPTED_ACP_COLLIDE_MCP_REGISTRATION: "1" },
              invalidateConfiguration: false,
              workspaceId: "T240REGCOLLISION",
            },
          ] as const;

          for (const scenario of scenarios) {
            const controls = yield* makeTempDirectoryScoped(
              "laborer-memory-registration-controls-"
            );
            const configuration = makeLaborerMemoryMcpServerConfiguration(
              yield* prepareAcpAgentContextSources({
                root,
                workspaceId: scenario.workspaceId,
              })
            );
            const memoryMcpServer = scenario.invalidateConfiguration
              ? { ...configuration, args: [...configuration.args, "invalid"] }
              : configuration;
            const published: string[] = [];
            const sessionRequestPath = resolve(controls, "sessions.jsonl");
            const agent = yield* makeAcpConversationAgent({
              args: [scriptedPeerPath],
              command: process.execPath,
              cwd: root,
              environment: {
                ...process.env,
                ...scenario.environment,
                SCRIPTED_ACP_READY_PATH: resolve(controls, "ready"),
                SCRIPTED_ACP_RELEASE_PATH: resolve(controls, "release"),
                SCRIPTED_ACP_SESSION_REQUEST_JSONL_PATH: sessionRequestPath,
              },
              memoryMcpServer,
            });
            yield* Effect.promise(() =>
              writeFile(resolve(controls, "release"), "release")
            );
            const result = yield* Effect.result(
              agent.handle(
                {
                  actions: [],
                  context: [],
                  conversationId: scenario.conversationId,
                  conversationSessionId: `logical:${scenario.conversationId}`,
                  conversationSessionIsNew: true,
                  executionControls: [],
                  executions: [],
                  input: "registration failure must stay private",
                  messages: [],
                  promptId: `prompt:${scenario.conversationId}`,
                  source: "slack",
                  turnId: `turn:${scenario.conversationId}`,
                },
                ({ text }) => Effect.sync(() => published.push(text))
              )
            );
            assert.strictEqual(result._tag, "Success");
            assert.ok(published.length > 0);
            const sessionRequestSource = yield* Effect.promise(() =>
              readFile(sessionRequestPath, "utf8").then(
                (source) => source,
                () => ""
              )
            );
            const sessionRequests = sessionRequestSource
              .trim()
              .split("\n")
              .filter((line) => line.length > 0)
              .map((line) => JSON.parse(line) as { mcpServers: unknown[] });
            if (scenario.invalidateConfiguration) {
              assert.strictEqual(sessionRequests.length, 1);
            } else {
              assert.strictEqual(sessionRequests.length, 2);
              assert.strictEqual(
                sessionRequests[0]?.mcpServers.length === 1,
                true
              );
            }
            assert.deepStrictEqual(sessionRequests.at(-1)?.mcpServers, []);
            const sources = yield* prepareAcpAgentContextSources({
              root,
              workspaceId: scenario.workspaceId,
            });
            const diagnostics = yield* Effect.promise(() =>
              readFile(sources.memoryDiagnosticsPath, "utf8")
            );
            assert.ok(diagnostics.includes(scenario.code));
            assert.ok(diagnostics.length <= 4096);
            assert.ok(!diagnostics.includes("registration failure must"));
          }
        })
      ),
    30_000
  );

  it("rejects malformed Slack Team IDs before constructing workspace paths", () => {
    const malformedIds = [
      ".",
      "..",
      "%2e%2e",
      "T/../../escape",
      "",
      "-leading",
    ];
    for (const workspaceId of malformedIds) {
      assert.strictEqual(isSlackTeamId(workspaceId), false);
      let rejected = false;
      try {
        acpAgentContextPaths({ root: "/tmp/laborer", workspaceId });
      } catch {
        rejected = true;
      }
      assert.strictEqual(rejected, true, workspaceId);
    }
    const valid = acpAgentContextPaths({
      root: "/tmp/laborer",
      workspaceId: "T12345678",
    });
    assert.strictEqual(
      valid.workspaceDirectory,
      "/tmp/laborer/.laborer-runtime/slack-workspaces/T12345678"
    );
  });

  it.live(
    "records bounded owner-only startup diagnostics through the real stdio server",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-memory-startup-diagnostic-"
          );
          const workspaceId = "T240STARTUPFAIL";
          const sources = yield* prepareAcpAgentContextSources({
            root,
            workspaceId,
          });
          const client = new Client({
            name: "laborer-memory-startup-failure-test",
            version: "1.0.0",
          });
          const transport = new StdioClientTransport({
            args: [serverPath],
            command: process.execPath,
            env: {
              LABORER_MEMORY_CONFIG_ROOT: sources.configRoot,
              LABORER_MEMORY_ROOT: root,
              LABORER_MEMORY_STATE_ROOT: sources.stateRoot,
              LABORER_MEMORY_TEST_FAIL_STARTUP: "1",
              LABORER_MEMORY_WORKSPACE_ID: workspaceId,
            },
            stderr: "pipe",
          });
          yield* Effect.addFinalizer(() =>
            Effect.promise(() => client.close().catch(() => undefined))
          );
          const rejected = yield* Effect.promise(() =>
            client.connect(transport).then(
              () => false,
              () => true
            )
          );
          assert.strictEqual(rejected, true);
          yield* Effect.promise(() => client.close().catch(() => undefined));
          const diagnostic = yield* Effect.promise(() =>
            readFile(sources.memoryDiagnosticsPath, "utf8")
          );
          assert.ok(diagnostic.includes("startup-failed"));
          assert.ok(diagnostic.length <= 4096);
          const metadata = yield* Effect.promise(() =>
            stat(sources.memoryDiagnosticsPath)
          );
          assert.strictEqual(metadata.mode % OWNER_ONLY_PERMISSION_MODULUS, 0);
        })
      ),
    20_000
  );

  it.live(
    "bounds production mutation-diagnostic growth without recording tool input",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-memory-diagnostic-growth-"
          );
          const workspaceId = "T240DIAGNOSTICS";
          const sources = yield* prepareAcpAgentContextSources({
            root,
            workspaceId,
          });
          yield* Effect.promise(() =>
            withMemoryClient({ root, workspaceId }, async (client) => {
              for (let index = 0; index < 90; index += 1) {
                const result = await callMemory(client, {
                  operation: "add",
                  target: "workspace",
                  text: "",
                });
                assert.strictEqual(result.isError, true);
              }
            })
          );
          const diagnostic = yield* Effect.promise(() =>
            readFile(sources.memoryDiagnosticsPath, "utf8")
          );
          assert.ok(diagnostic.length <= 4096);
          assert.ok(diagnostic.includes("mutation-invalid-input"));
          assert.ok(!diagnostic.includes("operation"));
          const metadata = yield* Effect.promise(() =>
            stat(sources.memoryDiagnosticsPath)
          );
          assert.strictEqual(metadata.mode % OWNER_ONLY_PERMISSION_MODULUS, 0);
        })
      ),
    30_000
  );

  it.live(
    "deduplicates exact multi-paragraph entries directly without normalizing whitespace",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-memory-direct-entry-deduplication-"
          );
          const workspaceId = "T240DIRECTDEDUP";
          const sources = yield* prepareAcpAgentContextSources({
            root,
            workspaceId,
          });
          const store = yield* makeLaborerMemoryStore({ root, workspaceId });
          const entry = "## Release process\n\nDeploy only after approval.";
          const whitespaceDifferentEntry =
            "## Release process\n\nDeploy  only after approval.";

          yield* Effect.promise(() =>
            writeFile(sources.workspaceMemoryPath, entry)
          );
          const wholeFileLegacyDuplicate = yield* store.mutate({
            operation: "add",
            target: "workspace",
            text: entry,
          });
          assert.strictEqual(wholeFileLegacyDuplicate.changed, false);

          yield* Effect.promise(() =>
            writeFile(
              sources.workspaceMemoryPath,
              `Operator preface\n\n${entry}\n\nOperator suffix`
            )
          );
          const operatorBlockSequenceDuplicate = yield* store.mutate({
            operation: "add",
            target: "workspace",
            text: entry,
          });
          assert.strictEqual(operatorBlockSequenceDuplicate.changed, false);

          const crlfEntry = "Windows heading\r\n\r\nWindows paragraph";
          yield* Effect.promise(() =>
            writeFile(
              sources.workspaceMemoryPath,
              `Operator preface\r\n\r\n${crlfEntry}\r\n\r\nOperator suffix`
            )
          );
          const exactCrlfDuplicate = yield* store.mutate({
            operation: "add",
            target: "workspace",
            text: crlfEntry,
          });
          const lfDifferent = yield* store.mutate({
            operation: "add",
            target: "workspace",
            text: crlfEntry.replaceAll("\r\n", "\n"),
          });
          assert.strictEqual(exactCrlfDuplicate.changed, false);
          assert.strictEqual(lfDifferent.changed, true);
          yield* Effect.promise(() =>
            writeFile(sources.workspaceMemoryPath, "")
          );

          const first = yield* store.mutate({
            operation: "add",
            target: "workspace",
            text: entry,
          });
          const duplicate = yield* store.mutate({
            operation: "add",
            target: "workspace",
            text: entry,
          });
          const whitespaceDifferent = yield* store.mutate({
            operation: "add",
            target: "workspace",
            text: whitespaceDifferentEntry,
          });

          assert.strictEqual(first.changed, true);
          assert.strictEqual(duplicate.changed, false);
          assert.strictEqual(whitespaceDifferent.changed, true);
          assert.strictEqual(
            yield* Effect.promise(() =>
              readFile(sources.workspaceMemoryPath, "utf8")
            ),
            `${renderFramedMemoryEntry(entry)}\n\n${renderFramedMemoryEntry(whitespaceDifferentEntry)}`
          );
          const revisedEntry =
            "## Release process\n\nDeploy  only after two approvals.";
          yield* store.mutate({
            operation: "replace",
            replacement: revisedEntry,
            target: "workspace",
            text: whitespaceDifferentEntry,
          });
          yield* store.mutate({
            operation: "remove",
            target: "workspace",
            text: entry,
          });
          assert.strictEqual(
            yield* Effect.promise(() =>
              readFile(sources.workspaceMemoryPath, "utf8")
            ),
            renderFramedMemoryEntry(revisedEntry)
          );
        })
      ),
    20_000
  );

  it.live(
    "strips only complete frames and preserves malformed operator markers",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-memory-malformed-framing-"
          );
          const sources = yield* prepareAcpAgentContextSources({
            root,
            workspaceId: "T240MALFORMEDFRAME",
          });
          const malformedOperatorText =
            "Operator marker follows\n\n<!-- laborer-memory-entry:end -->\n\n<!-- laborer-memory-entry:start -->\nunmatched operator text";
          yield* Effect.promise(() =>
            writeFile(
              sources.workspaceMemoryPath,
              `${malformedOperatorText}\n\n${renderFramedMemoryEntry("Visible framed content")}`
            )
          );

          const snapshot = yield* loadAcpAgentContextSnapshot(sources);
          assert.strictEqual(
            snapshot.workspaceMemory,
            "Operator marker follows\n\n&lt;!-- laborer-memory-entry:end --&gt;\n\n&lt;!-- laborer-memory-entry:start --&gt;\nunmatched operator text\n\nVisible framed content"
          );
        })
      ),
    20_000
  );

  it.live(
    "retains valid UTF-8 prefixes when the byte cap splits an emoji",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-memory-utf8-cutoff-"
          );
          const sources = yield* prepareAcpAgentContextSources({
            root,
            workspaceId: "T240UTF8CUTOFF",
          });
          const boundedReadBytes = 512 * 1024;
          const boundarySource = `${"a".repeat(boundedReadBytes - 1)}😀after-cutoff`;
          yield* Effect.promise(() =>
            writeFile(sources.workspaceMemoryPath, boundarySource)
          );
          yield* Effect.promise(() =>
            mkdir(sources.userProfilesDirectory, {
              mode: 0o700,
              recursive: true,
            })
          );
          const profilePath = userProfilePath(sources, "U240UTF80");
          yield* Effect.promise(() => writeFile(profilePath, boundarySource));

          const snapshot = yield* loadAcpAgentContextSnapshot(sources);
          const [participant] = yield* loadAcpSlackParticipantContexts(
            sources,
            undefined,
            ["U240UTF80"]
          );
          assert.match(
            snapshot.workspaceMemory ?? "",
            TRUNCATED_WORKSPACE_ASCII_PATTERN
          );
          assert.match(
            participant?.userProfile ?? "",
            TRUNCATED_PROFILE_ASCII_PATTERN
          );
          assert.ok(!snapshot.workspaceMemory?.includes("😀"));
          assert.ok(!participant?.userProfile?.includes("😀"));
        })
      ),
    20_000
  );

  it.live(
    "rejects invalid UTF-8 inside bounded Workspace memory and User profile prefixes",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-memory-invalid-utf8-prefix-"
          );
          const sources = yield* prepareAcpAgentContextSources({
            root,
            workspaceId: "T240INVALIDUTF8",
          });
          const boundedReadBytes = 512 * 1024;
          const invalidBoundarySource = new Uint8Array(boundedReadBytes + 1);
          invalidBoundarySource.fill(0x61);
          invalidBoundarySource[boundedReadBytes - 2] = 0xc3;
          invalidBoundarySource[boundedReadBytes - 1] = 0x28;
          yield* Effect.promise(() =>
            writeFile(sources.workspaceMemoryPath, invalidBoundarySource)
          );
          yield* Effect.promise(() =>
            mkdir(sources.userProfilesDirectory, {
              mode: 0o700,
              recursive: true,
            })
          );
          const profilePath = userProfilePath(sources, "U240UTF81");
          yield* Effect.promise(() =>
            writeFile(profilePath, invalidBoundarySource)
          );

          const snapshot = yield* loadAcpAgentContextSnapshot(sources);
          const [participant] = yield* loadAcpSlackParticipantContexts(
            sources,
            undefined,
            ["U240UTF81"]
          );
          assert.strictEqual(snapshot.workspaceMemory, null);
          assert.strictEqual(participant?.userProfile, null);
        })
      ),
    20_000
  );

  it.live(
    "exposes one bounded mutation tool over real stdio MCP and supports every operation",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped("laborer-memory-mcp-");
          const sources = yield* prepareAcpAgentContextSources({
            root,
            workspaceId: "T240PROTOCOL",
          });

          yield* Effect.promise(() =>
            withMemoryClient(
              { root, workspaceId: "T240PROTOCOL" },
              async (client) => {
                const tools = await client.listTools();
                assert.deepStrictEqual(
                  tools.tools.map((tool) => tool.name),
                  [LABORER_MEMORY_MCP_TOOL_NAME]
                );
                assert.match(
                  tools.tools[0]?.description ?? "",
                  MEMORY_GUIDANCE_PATTERN
                );
                assert.match(
                  tools.tools[0]?.description ?? "",
                  MEMORY_PRIVACY_GUIDANCE_PATTERN
                );

                const added = await callMemory(client, {
                  operation: "add",
                  target: "workspace",
                  text: "Deploys happen on Tuesdays.",
                });
                assert.notStrictEqual(added.isError, true);
                assert.strictEqual(
                  await readFile(sources.workspaceMemoryPath, "utf8"),
                  renderFramedMemoryEntry("Deploys happen on Tuesdays.")
                );

                const duplicate = await callMemory(client, {
                  operation: "add",
                  target: "workspace",
                  text: "Deploys happen on Tuesdays.",
                });
                assert.notStrictEqual(duplicate.isError, true);
                assert.strictEqual(
                  await readFile(sources.workspaceMemoryPath, "utf8"),
                  renderFramedMemoryEntry("Deploys happen on Tuesdays.")
                );

                const blankReplacement = await callMemory(client, {
                  operation: "replace",
                  replacement: " \n\t",
                  target: "workspace",
                  text: "Deploys happen on Tuesdays.",
                });
                assert.strictEqual(blankReplacement.isError, true);
                assert.strictEqual(
                  await readFile(sources.workspaceMemoryPath, "utf8"),
                  renderFramedMemoryEntry("Deploys happen on Tuesdays.")
                );

                await writeFile(
                  sources.workspaceMemoryPath,
                  "Operator preface\n\nDeploys happen on Tuesdays.\n\nOperator suffix"
                );
                const operatorBlockDuplicate = await callMemory(client, {
                  operation: "add",
                  target: "workspace",
                  text: "Deploys happen on Tuesdays.",
                });
                assert.notStrictEqual(operatorBlockDuplicate.isError, true);
                assert.strictEqual(
                  await readFile(sources.workspaceMemoryPath, "utf8"),
                  "Operator preface\n\nDeploys happen on Tuesdays.\n\nOperator suffix"
                );
                const replaced = await callMemory(client, {
                  operation: "replace",
                  replacement: "Deploys happen on Wednesdays.",
                  target: "workspace",
                  text: "Deploys happen on Tuesdays.",
                });
                assert.notStrictEqual(replaced.isError, true);
                assert.strictEqual(
                  await readFile(sources.workspaceMemoryPath, "utf8"),
                  "Operator preface\n\nDeploys happen on Wednesdays.\n\nOperator suffix"
                );

                const removed = await callMemory(client, {
                  operation: "remove",
                  target: "workspace",
                  text: "Deploys happen on Wednesdays.",
                });
                assert.notStrictEqual(removed.isError, true);
                assert.strictEqual(
                  await readFile(sources.workspaceMemoryPath, "utf8"),
                  "Operator preface\n\n\n\nOperator suffix"
                );

                await writeFile(sources.workspaceMemoryPath, "entry-10");
                const substringAddition = await callMemory(client, {
                  operation: "add",
                  target: "workspace",
                  text: "entry-1",
                });
                assert.notStrictEqual(substringAddition.isError, true);
                assert.strictEqual(
                  await readFile(sources.workspaceMemoryPath, "utf8"),
                  `entry-10\n\n${renderFramedMemoryEntry("entry-1")}`
                );
                const whitespaceDifferent = await callMemory(client, {
                  operation: "add",
                  target: "workspace",
                  text: "  entry-10\r\n",
                });
                assert.notStrictEqual(whitespaceDifferent.isError, true);
                assert.strictEqual(
                  await readFile(sources.workspaceMemoryPath, "utf8"),
                  `entry-10\n\n${renderFramedMemoryEntry("entry-1")}\n\n${renderFramedMemoryEntry("  entry-10\r\n")}`
                );

                await writeFile(sources.workspaceMemoryPath, "");
                const multiParagraphEntry =
                  "## Release process\n\nDeploy only after approval.";
                const multiParagraphAdded = await callMemory(client, {
                  operation: "add",
                  target: "workspace",
                  text: multiParagraphEntry,
                });
                const multiParagraphDuplicate = await callMemory(client, {
                  operation: "add",
                  target: "workspace",
                  text: multiParagraphEntry,
                });
                const multiParagraphWhitespaceDifferent = await callMemory(
                  client,
                  {
                    operation: "add",
                    target: "workspace",
                    text: "## Release process\n\nDeploy  only after approval.",
                  }
                );
                const containedParagraph = await callMemory(client, {
                  operation: "add",
                  target: "workspace",
                  text: "Deploy only after approval.",
                });
                const crlfDifferent = await callMemory(client, {
                  operation: "add",
                  target: "workspace",
                  text: "## Release process\r\n\r\nDeploy only after approval.",
                });
                assert.notStrictEqual(multiParagraphAdded.isError, true);
                assert.notStrictEqual(multiParagraphDuplicate.isError, true);
                assert.notStrictEqual(
                  multiParagraphWhitespaceDifferent.isError,
                  true
                );
                assert.notStrictEqual(containedParagraph.isError, true);
                assert.notStrictEqual(crlfDifferent.isError, true);
                assert.strictEqual(
                  await readFile(sources.workspaceMemoryPath, "utf8"),
                  [
                    multiParagraphEntry,
                    "## Release process\n\nDeploy  only after approval.",
                    "Deploy only after approval.",
                    "## Release process\r\n\r\nDeploy only after approval.",
                  ]
                    .map(renderFramedMemoryEntry)
                    .join("\n\n")
                );

                await writeFile(sources.workspaceMemoryPath, "banana");
                const overlapping = await callMemory(client, {
                  operation: "remove",
                  target: "workspace",
                  text: "ana",
                });
                assert.strictEqual(overlapping.isError, true);
                assert.strictEqual(
                  await readFile(sources.workspaceMemoryPath, "utf8"),
                  "banana"
                );
              }
            )
          );
        })
      ),
    20_000
  );

  it.live(
    "creates profiles lazily, validates user IDs, and never exposes Soul mutation",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-memory-profile-"
          );
          const sources = yield* prepareAcpAgentContextSources({
            root,
            workspaceId: "T240PROFILE",
          });
          const profilePath = userProfilePath(sources, "U240ALICE");
          const originalSoul = yield* Effect.promise(() =>
            readFile(sources.soulPath, "utf8")
          );

          yield* Effect.promise(() =>
            withMemoryClient(
              { root, workspaceId: "T240PROFILE" },
              async (client) => {
                assert.strictEqual(
                  await readFile(profilePath, "utf8").then(
                    () => true,
                    () => false
                  ),
                  false
                );
                const added = await callMemory(client, {
                  operation: "add",
                  target: "user",
                  text: "Prefers concise implementation summaries.",
                  userId: "U240ALICE",
                });
                assert.notStrictEqual(added.isError, true);
                assert.strictEqual(
                  await readFile(profilePath, "utf8"),
                  renderFramedMemoryEntry(
                    "Prefers concise implementation summaries."
                  )
                );
                const invalid = await callMemory(client, {
                  operation: "add",
                  target: "user",
                  text: "Must stay contained",
                  userId: "../../SOUL",
                });
                assert.strictEqual(invalid.isError, true);
                const tooShort = await callMemory(client, {
                  operation: "add",
                  target: "user",
                  text: "Must be an authentic Slack identifier shape",
                  userId: "U12",
                });
                assert.strictEqual(tooShort.isError, true);
                assert.strictEqual(
                  await readFile(sources.soulPath, "utf8"),
                  originalSoul
                );
              }
            )
          );
          const [participant] = yield* loadAcpSlackParticipantContexts(
            sources,
            undefined,
            ["U240ALICE"]
          );
          assert.strictEqual(
            participant?.userProfile,
            "Prefers concise implementation summaries."
          );
          yield* Effect.promise(() =>
            withMemoryClient(
              { root, workspaceId: "T240PROFILE" },
              async (client) => {
                const replaced = await callMemory(client, {
                  operation: "replace",
                  replacement: "Prefers detailed implementation summaries.",
                  target: "user",
                  text: "Prefers concise implementation summaries.",
                  userId: "U240ALICE",
                });
                assert.notStrictEqual(replaced.isError, true);
                const removed = await callMemory(client, {
                  operation: "remove",
                  target: "user",
                  text: "Prefers detailed implementation summaries.",
                  userId: "U240ALICE",
                });
                assert.notStrictEqual(removed.isError, true);
                assert.strictEqual(await readFile(profilePath, "utf8"), "");
              }
            )
          );
        })
      ),
    20_000
  );

  it.live(
    "rejects ambiguous exact matches and final states beyond rendered limits",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped("laborer-memory-limits-");
          const sources = yield* prepareAcpAgentContextSources({
            root,
            workspaceId: "T240LIMITS",
          });

          yield* Effect.promise(() =>
            withMemoryClient(
              { root, workspaceId: "T240LIMITS" },
              async (client) => {
                await writeFile(sources.workspaceMemoryPath, "same / same");
                const ambiguous = await callMemory(client, {
                  operation: "remove",
                  target: "workspace",
                  text: "same",
                });
                assert.strictEqual(ambiguous.isError, true);
                assert.strictEqual(
                  await readFile(sources.workspaceMemoryPath, "utf8"),
                  "same / same"
                );

                await writeFile(sources.workspaceMemoryPath, "&".repeat(800));
                const boundary = await callMemory(client, {
                  operation: "add",
                  target: "workspace",
                  text: "x",
                });
                assert.strictEqual(boundary.isError, true);
                assert.strictEqual(
                  await readFile(sources.workspaceMemoryPath, "utf8"),
                  "&".repeat(800)
                );

                await writeFile(sources.workspaceMemoryPath, "x".repeat(4001));
                const alreadyOversized = await callMemory(client, {
                  operation: "remove",
                  target: "workspace",
                  text: "x",
                });
                assert.strictEqual(alreadyOversized.isError, true);

                const userProfile = userProfilePath(sources, "U240LIMIT");
                const userTooLarge = await callMemory(client, {
                  operation: "add",
                  target: "user",
                  text: "p".repeat(2001),
                  userId: "U240LIMIT",
                });
                assert.strictEqual(userTooLarge.isError, true);
                assert.strictEqual(
                  await readFile(userProfile, "utf8").then(
                    () => true,
                    () => false
                  ),
                  false
                );

                await writeFile(sources.workspaceMemoryPath, "");
                const exactVisibleLimit = await callMemory(client, {
                  operation: "add",
                  target: "workspace",
                  text: "z".repeat(4000),
                });
                assert.notStrictEqual(exactVisibleLimit.isError, true);
                const beyondVisibleLimit = await callMemory(client, {
                  operation: "add",
                  target: "workspace",
                  text: "another entry",
                });
                assert.strictEqual(beyondVisibleLimit.isError, true);
                assert.strictEqual(
                  await readFile(sources.workspaceMemoryPath, "utf8"),
                  renderFramedMemoryEntry("z".repeat(4000))
                );
              }
            )
          );
        })
      ),
    20_000
  );

  it.live(
    "accepts valid multibyte content exactly at both rendered-character boundaries",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-memory-multibyte-boundary-"
          );
          const workspaceId = "T240MULTIBYTE";
          const sources = yield* prepareAcpAgentContextSources({
            root,
            workspaceId,
          });
          const workspaceText = "😀".repeat(4000);
          const profileText = "界".repeat(2000);
          yield* Effect.promise(() =>
            withMemoryClient({ root, workspaceId }, async (client) => {
              const workspaceResult = await callMemory(client, {
                operation: "add",
                target: "workspace",
                text: workspaceText,
              });
              const profileResult = await callMemory(client, {
                operation: "add",
                target: "user",
                text: profileText,
                userId: "U240MULTI",
              });
              assert.notStrictEqual(workspaceResult.isError, true);
              assert.notStrictEqual(profileResult.isError, true);
            })
          );
          const snapshot = yield* loadAcpAgentContextSnapshot(sources);
          const [participant] = yield* loadAcpSlackParticipantContexts(
            sources,
            undefined,
            ["U240MULTI"]
          );
          assert.strictEqual(snapshot.workspaceMemory, workspaceText);
          assert.strictEqual(participant?.userProfile, profileText);
        })
      ),
    20_000
  );

  it.live(
    "does not let replace or remove operations target private framing metadata",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-memory-framing-integrity-"
          );
          const workspaceId = "T240FRAMEINTEGRITY";
          const sources = yield* prepareAcpAgentContextSources({
            root,
            workspaceId,
          });
          const store = yield* makeLaborerMemoryStore({ root, workspaceId });
          yield* store.mutate({
            operation: "add",
            target: "workspace",
            text: "visible entry",
          });
          const before = yield* Effect.promise(() =>
            readFile(sources.workspaceMemoryPath, "utf8")
          );
          const result = yield* Effect.result(
            store.mutate({
              operation: "replace",
              replacement: "compromised",
              target: "workspace",
              text: "start",
            })
          );
          assert.strictEqual(result._tag, "Failure");
          assert.strictEqual(
            yield* Effect.promise(() =>
              readFile(sources.workspaceMemoryPath, "utf8")
            ),
            before
          );
        })
      ),
    20_000
  );

  it.live(
    "serializes high contention across independently launched MCP server processes",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-memory-cross-process-"
          );
          const sources = yield* prepareAcpAgentContextSources({
            root,
            workspaceId: "T240CROSSPROCESS",
          });
          const additions = Array.from(
            { length: 24 },
            (_, index) => `independent process ${index}`
          );
          const processGroups = Array.from({ length: 6 }, (_, groupIndex) =>
            additions.filter((_, index) => index % 6 === groupIndex)
          );
          const groupedResults = yield* Effect.promise(() =>
            Promise.all(
              processGroups.map((group) =>
                withMemoryClient(
                  {
                    environment: {
                      LABORER_MEMORY_TEST_CRITICAL_SECTION_DELAY_MILLIS: "40",
                    },
                    root,
                    workspaceId: "T240CROSSPROCESS",
                  },
                  (client) =>
                    Promise.all(
                      group.map((text) =>
                        callMemory(client, {
                          operation: "add",
                          target: "workspace",
                          text,
                        })
                      )
                    )
                )
              )
            )
          );
          assert.deepStrictEqual(
            groupedResults.flat().filter((result) => result.isError === true),
            []
          );
          const content = yield* Effect.promise(() =>
            readFile(sources.workspaceMemoryPath, "utf8")
          );
          assert.deepStrictEqual(
            framedMemoryEntries(content)
              .map(({ content: entryContent }) => entryContent)
              .sort(),
            additions.sort()
          );
        })
      ),
    60_000
  );

  it.live(
    "never steals from a live owner beyond the former stale-lease window",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-memory-live-owner-"
          );
          const workspaceId = "T240LIVEOWNER";
          const sources = yield* prepareAcpAgentContextSources({
            root,
            workspaceId,
          });
          const holderClient = new Client({
            name: "laborer-memory-live-owner-holder",
            version: "1.0.0",
          });
          const holderTransport = new StdioClientTransport({
            args: [serverPath],
            command: process.execPath,
            env: {
              LABORER_MEMORY_CONFIG_ROOT: sources.configRoot,
              LABORER_MEMORY_ROOT: root,
              LABORER_MEMORY_STATE_ROOT: sources.stateRoot,
              LABORER_MEMORY_TEST_CRITICAL_SECTION_DELAY_MILLIS: "6500",
              LABORER_MEMORY_WORKSPACE_ID: workspaceId,
            },
            stderr: "pipe",
          });
          yield* Effect.promise(() => holderClient.connect(holderTransport));
          const isolatedHolderPid = holderTransport.pid;
          assert.notStrictEqual(isolatedHolderPid, null);
          let holderIsStopped = false;
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              if (isolatedHolderPid !== null && holderIsStopped) {
                yield* Effect.try({
                  try: () => process.kill(isolatedHolderPid, "SIGCONT"),
                  catch: () => undefined,
                }).pipe(Effect.ignore);
              }
              yield* Effect.promise(() =>
                holderClient.close().catch(() => undefined)
              );
            })
          );
          const holderCall = callMemory(holderClient, {
            operation: "add",
            target: "workspace",
            text: "live owner committed first",
          });
          const lockDatabasePath = sources.workspaceMemoryLockPath;
          yield* Effect.promise(() => waitForSqliteWriteLock(lockDatabasePath));
          assert.strictEqual(
            (yield* Effect.promise(() => stat(lockDatabasePath))).mode %
              OWNER_ONLY_PERMISSION_MODULUS,
            0
          );
          // Pause only the isolated MCP child created by this test. SQLite's
          // kernel file lock remains held without user-space heartbeats.
          yield* Effect.sync(() => {
            if (isolatedHolderPid !== null) {
              process.kill(isolatedHolderPid, "SIGSTOP");
              holderIsStopped = true;
            }
          });

          let secondSettled = false;
          const secondCall = withMemoryClient({ root, workspaceId }, (client) =>
            callMemory(client, {
              operation: "add",
              target: "workspace",
              text: "waiting writer committed second",
            })
          ).then((result) => {
            secondSettled = true;
            return result;
          });
          yield* Effect.promise(() => wait(5400));
          assert.strictEqual(secondSettled, false);
          assert.strictEqual(
            yield* Effect.promise(() =>
              readFile(sources.workspaceMemoryPath, "utf8")
            ),
            ""
          );

          yield* Effect.sync(() => {
            if (isolatedHolderPid !== null) {
              process.kill(isolatedHolderPid, "SIGCONT");
              holderIsStopped = false;
            }
          });
          const holderResult = yield* Effect.promise(() => holderCall);
          const secondResult = yield* Effect.promise(() => secondCall);
          assert.notStrictEqual(holderResult.isError, true);
          assert.notStrictEqual(secondResult.isError, true);
          yield* Effect.promise(() => holderClient.close());
          assert.strictEqual(
            yield* Effect.promise(() =>
              readFile(sources.workspaceMemoryPath, "utf8")
            ),
            `${renderFramedMemoryEntry("live owner committed first")}\n\n${renderFramedMemoryEntry("waiting writer committed second")}`
          );
        })
      ),
    20_000
  );

  it.live(
    "serializes equivalent filesystem aliases when the platform exposes one",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-memory-path-alias-"
          );
          const workspaceId = "T240PATHALIAS";
          const sources = yield* prepareAcpAgentContextSources({
            root,
            workspaceId,
          });
          const aliasRoot = root.startsWith("/private/")
            ? root.slice("/private".length)
            : root;
          const aliasesSameDirectory = yield* Effect.promise(async () => {
            try {
              return (await realpath(aliasRoot)) === (await realpath(root));
            } catch {
              return false;
            }
          });
          if (aliasRoot !== root && aliasesSameDirectory) {
            const results = yield* Effect.promise(() =>
              Promise.all([
                withMemoryClient({ root, workspaceId }, (client) =>
                  callMemory(client, {
                    operation: "add",
                    target: "workspace",
                    text: "canonical path entry",
                  })
                ),
                withMemoryClient({ root: aliasRoot, workspaceId }, (client) =>
                  callMemory(client, {
                    operation: "add",
                    target: "workspace",
                    text: "alias path entry",
                  })
                ),
              ])
            );
            assert.ok(results.every((result) => result.isError !== true));
            const content = yield* Effect.promise(() =>
              readFile(sources.workspaceMemoryPath, "utf8")
            );
            assert.ok(content.includes("canonical path entry"));
            assert.ok(content.includes("alias path entry"));
          } else {
            assert.strictEqual(
              yield* Effect.promise(() => realpath(root)),
              sources.root
            );
          }
        })
      ),
    20_000
  );

  it.live(
    "cancels lock waiting under contention without publishing the mutation",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-memory-lock-cancellation-"
          );
          const workspaceId = "T240CANCELLOCK";
          const sources = yield* prepareAcpAgentContextSources({
            root,
            workspaceId,
          });
          const holderClient = new Client({
            name: "laborer-memory-lock-holder",
            version: "1.0.0",
          });
          const holderTransport = new StdioClientTransport({
            args: [serverPath],
            command: process.execPath,
            env: {
              LABORER_MEMORY_CONFIG_ROOT: sources.configRoot,
              LABORER_MEMORY_ROOT: root,
              LABORER_MEMORY_STATE_ROOT: sources.stateRoot,
              LABORER_MEMORY_TEST_CRITICAL_SECTION_DELAY_MILLIS: "1000",
              LABORER_MEMORY_WORKSPACE_ID: workspaceId,
            },
            stderr: "pipe",
          });
          yield* Effect.addFinalizer(() =>
            Effect.promise(() => holderClient.close().catch(() => undefined))
          );
          yield* Effect.promise(() => holderClient.connect(holderTransport));
          const holderCall = callMemory(holderClient, {
            operation: "add",
            target: "workspace",
            text: "lock holder committed",
          });
          yield* Effect.promise(() =>
            waitForSqliteWriteLock(sources.workspaceMemoryLockPath)
          );

          const cancellation = new AbortController();
          const cancelledCall = withMemoryClient(
            { root, workspaceId },
            (client) =>
              callMemoryWithSignal(
                client,
                {
                  operation: "add",
                  target: "workspace",
                  text: "cancelled mutation must not publish",
                },
                cancellation.signal
              )
          ).then(
            (result) => result.isError === true,
            () => true
          );
          yield* Effect.promise(() => wait(100));
          cancellation.abort();
          assert.strictEqual(yield* Effect.promise(() => cancelledCall), true);
          const heldResult = yield* Effect.promise(() => holderCall);
          assert.notStrictEqual(heldResult.isError, true);
          yield* Effect.promise(() => holderClient.close());
          yield* Effect.promise(() => wait(100));
          assert.strictEqual(
            yield* Effect.promise(() =>
              readFile(sources.workspaceMemoryPath, "utf8")
            ),
            renderFramedMemoryEntry("lock holder committed")
          );
          assert.strictEqual(
            yield* Effect.promise(() =>
              readFile(sources.memoryDiagnosticsPath, "utf8").then(
                () => true,
                () => false
              )
            ),
            false
          );
        })
      ),
    20_000
  );

  it.live(
    "fails closed if the lock file or workspace directory is replaced while a writer holds the lock",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-memory-lock-compromise-"
          );
          for (const compromise of ["lock", "workspace"] as const) {
            const workspaceId =
              compromise === "lock" ? "T240LOCKSWAP" : "T240WORKSPACESWAP";
            const sources = yield* prepareAcpAgentContextSources({
              root,
              workspaceId,
            });
            const client = new Client({
              name: `laborer-memory-${compromise}-compromise`,
              version: "1.0.0",
            });
            const transport = new StdioClientTransport({
              args: [serverPath],
              command: process.execPath,
              env: {
                LABORER_MEMORY_CONFIG_ROOT: sources.configRoot,
                LABORER_MEMORY_ROOT: root,
                LABORER_MEMORY_STATE_ROOT: sources.stateRoot,
                LABORER_MEMORY_TEST_CRITICAL_SECTION_DELAY_MILLIS: "500",
                LABORER_MEMORY_WORKSPACE_ID: workspaceId,
              },
              stderr: "pipe",
            });
            yield* Effect.addFinalizer(() =>
              Effect.promise(() => client.close().catch(() => undefined))
            );
            yield* Effect.promise(() => client.connect(transport));
            const call = callMemory(client, {
              operation: "add",
              target: "workspace",
              text: `must not publish after ${compromise} replacement`,
            });
            const lockPath = sources.workspaceMemoryLockPath;
            yield* Effect.promise(() => waitForSqliteWriteLock(lockPath));
            if (compromise === "lock") {
              yield* Effect.promise(() =>
                rename(lockPath, `${lockPath}.compromised`)
              );
              const replacement = new DatabaseSync(lockPath);
              replacement.exec(
                "CREATE TABLE lock_guard (singleton INTEGER PRIMARY KEY CHECK (singleton = 1))"
              );
              replacement.close();
            } else {
              yield* Effect.promise(() =>
                rename(
                  sources.workspaceDirectory,
                  `${sources.workspaceDirectory}.compromised`
                )
              );
              yield* Effect.promise(() =>
                mkdir(sources.workspaceDirectory, { mode: 0o700 })
              );
              yield* Effect.promise(() =>
                writeFile(sources.workspaceMemoryPath, "replacement sentinel")
              );
            }
            const result = yield* Effect.promise(() => call);
            assert.strictEqual(result.isError, true);
            if (compromise === "workspace") {
              assert.strictEqual(
                yield* Effect.promise(() =>
                  readFile(sources.workspaceMemoryPath, "utf8")
                ),
                "replacement sentinel"
              );
            }
            yield* Effect.promise(() => client.close());
          }
        })
      ),
    20_000
  );

  it.live(
    "rejects root and workspace identity replacement before context reads or mutations",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const warnings: string[] = [];
          const warningLogger = Logger.make<unknown, void>((options) => {
            if (options.logLevel === "Warn") {
              warnings.push(String(options.message));
            }
          });

          const workspaceRoot = yield* makeTempDirectoryScoped(
            "laborer-memory-preoperation-workspace-swap-"
          );
          const workspaceSources = yield* prepareAcpAgentContextSources({
            root: workspaceRoot,
            workspaceId: "T240PREWORKSPACESWAP",
          });
          const workspaceStore = yield* makeLaborerMemoryStore({
            root: workspaceRoot,
            workspaceId: "T240PREWORKSPACESWAP",
          });
          const guardedConfiguration =
            makeLaborerMemoryMcpServerConfiguration(workspaceSources);
          const movedWorkspace = `${workspaceSources.workspaceDirectory}.old`;
          yield* Effect.promise(() =>
            rename(workspaceSources.workspaceDirectory, movedWorkspace)
          );
          yield* Effect.promise(() =>
            mkdir(workspaceSources.workspaceDirectory, { mode: 0o700 })
          );
          yield* Effect.promise(() =>
            writeFile(
              workspaceSources.workspaceMemoryPath,
              "replacement workspace sentinel"
            )
          );
          const workspaceSnapshot = yield* loadAcpAgentContextSnapshot(
            workspaceSources
          ).pipe(Effect.provide(Logger.layer([warningLogger])));
          assert.strictEqual(workspaceSnapshot.workspaceMemory, null);
          assert.strictEqual(
            (yield* Effect.result(
              prepareLaborerMemoryMcpRegistration(
                guardedConfiguration,
                workspaceSources.root
              )
            ))._tag,
            "Failure"
          );
          assert.strictEqual(
            (yield* Effect.result(
              workspaceStore.mutate({
                operation: "add",
                target: "workspace",
                text: "must not enter replacement workspace",
              })
            ))._tag,
            "Failure"
          );
          assert.strictEqual(
            yield* Effect.promise(() =>
              readFile(workspaceSources.workspaceMemoryPath, "utf8")
            ),
            "replacement workspace sentinel"
          );

          const root = yield* makeTempDirectoryScoped(
            "laborer-memory-preoperation-root-swap-"
          );
          const rootSources = yield* prepareAcpAgentContextSources({
            root,
            workspaceId: "T240PREROOTSWAP",
          });
          const rootStore = yield* makeLaborerMemoryStore({
            root,
            workspaceId: "T240PREROOTSWAP",
          });
          const movedRoot = `${root}.old`;
          yield* Effect.promise(() => rename(root, movedRoot));
          yield* Effect.addFinalizer(() =>
            Effect.promise(() =>
              rm(movedRoot, { force: true, recursive: true })
            )
          );
          yield* Effect.promise(() => mkdir(root, { mode: 0o700 }));
          const replacementWorkspace = resolve(
            root,
            ".laborer-runtime",
            "slack-workspaces",
            "T240PREROOTSWAP"
          );
          yield* Effect.promise(() =>
            mkdir(replacementWorkspace, { mode: 0o700, recursive: true })
          );
          yield* Effect.promise(() =>
            writeFile(rootSources.soulPath, "replacement soul sentinel")
          );
          yield* Effect.promise(() =>
            writeFile(
              rootSources.workspaceMemoryPath,
              "replacement root workspace sentinel"
            )
          );
          const rootSnapshot = yield* loadAcpAgentContextSnapshot(
            rootSources
          ).pipe(Effect.provide(Logger.layer([warningLogger])));
          assert.strictEqual(rootSnapshot.soul, null);
          assert.strictEqual(rootSnapshot.workspaceMemory, null);
          assert.strictEqual(
            (yield* Effect.result(
              rootStore.mutate({
                operation: "add",
                target: "workspace",
                text: "must not enter replacement root",
              })
            ))._tag,
            "Failure"
          );
          assert.ok(warnings.length >= 2);
          assert.ok(
            warnings.every(
              (warning) =>
                warning.length < 200 &&
                !warning.includes(root) &&
                !warning.includes(workspaceRoot)
            )
          );
        })
      ),
    20_000
  );

  it.live(
    "releases the cross-process critical section when its isolated MCP child exits",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-memory-process-exit-"
          );
          const workspaceId = "T240PROCESSEXIT";
          const sources = yield* prepareAcpAgentContextSources({
            root,
            workspaceId,
          });
          const firstClient = new Client({
            name: "laborer-memory-exiting-test",
            version: "1.0.0",
          });
          const firstTransport = new StdioClientTransport({
            args: [serverPath],
            command: process.execPath,
            env: {
              LABORER_MEMORY_CONFIG_ROOT: sources.configRoot,
              LABORER_MEMORY_ROOT: root,
              LABORER_MEMORY_STATE_ROOT: sources.stateRoot,
              LABORER_MEMORY_TEST_CRITICAL_SECTION_DELAY_MILLIS: "1000",
              LABORER_MEMORY_WORKSPACE_ID: workspaceId,
            },
            stderr: "pipe",
          });
          yield* Effect.addFinalizer(() =>
            Effect.promise(() => firstClient.close().catch(() => undefined))
          );
          yield* Effect.promise(() => firstClient.connect(firstTransport));
          const abandonedCall = callMemory(firstClient, {
            operation: "add",
            target: "workspace",
            text: "abandoned with exiting process",
          }).catch(() => undefined);
          yield* Effect.promise(() =>
            waitForSqliteWriteLock(sources.workspaceMemoryLockPath)
          );

          const recoveryTexts = Array.from(
            { length: 6 },
            (_, index) => `committed after process exit ${index}`
          );
          let recoveredSettled = 0;
          const recoveredCalls = Promise.all(
            recoveryTexts.map((text) =>
              withMemoryClient({ root, workspaceId }, (client) =>
                callMemory(client, {
                  operation: "add",
                  target: "workspace",
                  text,
                })
              ).then((result) => {
                recoveredSettled += 1;
                return result;
              })
            )
          );
          yield* Effect.promise(() => wait(100));
          assert.strictEqual(recoveredSettled, 0);

          const isolatedChildPid = firstTransport.pid;
          assert.notStrictEqual(isolatedChildPid, null);
          // Signal only the isolated test child launched above. The kernel
          // releases its SQLite transaction lock when the process exits.
          yield* Effect.sync(() => {
            if (isolatedChildPid !== null) {
              process.kill(isolatedChildPid, "SIGKILL");
            }
          });
          yield* Effect.promise(() => abandonedCall);
          yield* Effect.promise(() =>
            firstClient.close().catch(() => undefined)
          );
          const recovered = yield* Effect.promise(() => recoveredCalls);
          assert.deepStrictEqual(
            recovered.filter((result) => result.isError === true),
            []
          );
          const content = yield* Effect.promise(() =>
            readFile(sources.workspaceMemoryPath, "utf8")
          );
          assert.deepStrictEqual(
            framedMemoryEntries(content)
              .map(({ content: entryContent }) => entryContent)
              .sort(),
            recoveryTexts.sort()
          );
        })
      ),
    60_000
  );

  it.live(
    "serializes concurrent latest-disk mutations and isolates shared-root workspaces",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped("laborer-memory-races-");
          const first = yield* prepareAcpAgentContextSources({
            root,
            workspaceId: "T240FIRST",
          });
          const second = yield* prepareAcpAgentContextSources({
            root,
            workspaceId: "T240SECOND",
          });

          yield* Effect.promise(() =>
            withMemoryClient(
              { root, workspaceId: "T240FIRST" },
              async (client) => {
                const results = await Promise.all([
                  callMemory(client, {
                    operation: "add",
                    target: "workspace",
                    text: "concurrent first",
                  }),
                  callMemory(client, {
                    operation: "add",
                    target: "workspace",
                    text: "concurrent second",
                  }),
                ]);
                assert.ok(results.every((result) => result.isError !== true));
                const profile = await callMemory(client, {
                  operation: "add",
                  target: "user",
                  text: "First workspace profile",
                  userId: "U240ISOLATED",
                });
                assert.notStrictEqual(profile.isError, true);
              }
            )
          );
          const firstContent = yield* Effect.promise(() =>
            readFile(first.workspaceMemoryPath, "utf8")
          );
          assert.match(firstContent, CONCURRENT_FIRST_PATTERN);
          assert.match(firstContent, CONCURRENT_SECOND_PATTERN);
          assert.strictEqual(
            yield* Effect.promise(() =>
              readFile(second.workspaceMemoryPath, "utf8")
            ),
            ""
          );
          assert.strictEqual(
            yield* Effect.promise(() =>
              readFile(userProfilePath(second, "U240ISOLATED"), "utf8").then(
                () => true,
                () => false
              )
            ),
            false
          );

          const configuration = makeLaborerMemoryMcpServerConfiguration(first);
          assert.strictEqual(configuration.command, process.execPath);
          assert.deepStrictEqual(configuration.args, [serverPath]);
          assert.ok(
            configuration.env.some(
              ({ name, value }) =>
                name === "LABORER_MEMORY_WORKSPACE_ID" && value === "T240FIRST"
            )
          );
        })
      ),
    20_000
  );

  it.live(
    "uses fixed explicit MCP roots instead of ambient HOME and XDG roots",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-memory-explicit-mcp-root-"
          );
          const configRoot = yield* makeTempDirectoryScoped(
            "laborer-memory-explicit-mcp-config-"
          );
          const stateRoot = yield* makeTempDirectoryScoped(
            "laborer-memory-explicit-mcp-state-"
          );
          const ambientHome = yield* makeTempDirectoryScoped(
            "laborer-memory-ambient-home-"
          );
          const ambientConfig = yield* makeTempDirectoryScoped(
            "laborer-memory-ambient-config-"
          );
          const ambientState = yield* makeTempDirectoryScoped(
            "laborer-memory-ambient-state-"
          );
          const sources = yield* prepareAcpAgentContextSources({
            configRoot,
            root,
            stateRoot,
            workspaceId: "T240EXPLICITMCP",
          });
          const configuration =
            makeLaborerMemoryMcpServerConfiguration(sources);
          const fixedEnvironment = Object.fromEntries(
            configuration.env.map(({ name, value }) => [name, value])
          );
          const client = new Client({
            name: "laborer-memory-explicit-roots-test",
            version: "1.0.0",
          });
          const transport = new StdioClientTransport({
            args: configuration.args,
            command: configuration.command,
            env: {
              HOME: ambientHome,
              XDG_CONFIG_HOME: ambientConfig,
              XDG_STATE_HOME: ambientState,
              ...fixedEnvironment,
            },
            stderr: "pipe",
          });
          yield* Effect.addFinalizer(() =>
            Effect.promise(() => client.close().catch(() => undefined))
          );
          yield* Effect.promise(() => client.connect(transport));
          const result = yield* Effect.promise(() =>
            callMemory(client, {
              operation: "add",
              target: "workspace",
              text: "explicit roots only",
            })
          );
          assert.notStrictEqual(result.isError, true);
          assert.ok(
            (yield* Effect.promise(() =>
              readFile(sources.workspaceMemoryPath, "utf8")
            )).includes("explicit roots only")
          );
          assert.isTrue(
            yield* Effect.promise(() =>
              pathExists(sources.workspaceMemoryLockPath)
            )
          );
          assert.deepStrictEqual(
            yield* Effect.promise(() => readdir(ambientConfig)),
            []
          );
          assert.deepStrictEqual(
            yield* Effect.promise(() => readdir(ambientState)),
            []
          );

          const tampered = {
            ...configuration,
            env: configuration.env.map((entry) =>
              entry.name === "LABORER_MEMORY_STATE_ROOT"
                ? { ...entry, value: ambientState }
                : entry
            ),
          };
          assert.strictEqual(
            (yield* Effect.result(
              prepareLaborerMemoryMcpRegistration(tampered, sources.root)
            ))._tag,
            "Failure"
          );
        })
      ),
    20_000
  );

  it.live(
    "serializes real MCP children across different roots for one workspace",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const firstRoot = yield* makeTempDirectoryScoped(
            "laborer-memory-cross-root-first-"
          );
          const secondRoot = yield* makeTempDirectoryScoped(
            "laborer-memory-cross-root-second-"
          );
          const configRoot = yield* makeTempDirectoryScoped(
            "laborer-memory-cross-root-config-"
          );
          const stateRoot = yield* makeTempDirectoryScoped(
            "laborer-memory-cross-root-state-"
          );
          const workspaceId = "T240CROSSROOT";
          const first = yield* prepareAcpAgentContextSources({
            configRoot,
            root: firstRoot,
            stateRoot,
            workspaceId,
          });
          const second = yield* prepareAcpAgentContextSources({
            configRoot,
            root: secondRoot,
            stateRoot,
            workspaceId,
          });
          assert.strictEqual(
            first.workspaceMemoryLockPath,
            second.workspaceMemoryLockPath
          );
          const additions = Array.from(
            { length: 10 },
            (_, index) => `cross-root child ${index}`
          );
          const results = yield* Effect.promise(() =>
            Promise.all(
              additions.map((text, index) =>
                withMemoryClient(
                  {
                    configRoot,
                    environment: {
                      LABORER_MEMORY_TEST_CRITICAL_SECTION_DELAY_MILLIS: "40",
                    },
                    root: index % 2 === 0 ? firstRoot : secondRoot,
                    stateRoot,
                    workspaceId,
                  },
                  (client) =>
                    callMemory(client, {
                      operation: "add",
                      target: "workspace",
                      text,
                    })
                )
              )
            )
          );
          assert.isTrue(results.every((result) => result.isError !== true));
          const content = yield* Effect.promise(() =>
            readFile(first.workspaceMemoryPath, "utf8")
          );
          assert.deepStrictEqual(
            framedMemoryEntries(content)
              .map(({ content: entryContent }) => entryContent)
              .sort(),
            additions.sort()
          );
        })
      ),
    60_000
  );
});
