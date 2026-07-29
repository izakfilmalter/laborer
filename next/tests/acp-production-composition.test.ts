import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assert, describe, it } from "@effect/vitest";
import { WebClient } from "@slack/web-api";
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Redacted,
  Schema,
  Scope,
} from "effect";
import type { AcpPermissionBroker } from "../src/acp-conversation-prototype/acp-permission-broker.ts";
import { laborerActionMcpServerName } from "../src/acp-conversation-prototype/action-mcp.ts";
import {
  prepareAcpAgentContextSources,
  userProfilePath,
} from "../src/acp-conversation-prototype/agent-context.ts";
import { DealWithBugActionResult } from "../src/action-catalog.ts";
import type { OpenCodeSessionClient } from "../src/adapters/opencode-agents.ts";
import { makeNodeRootDurableRuntime } from "../src/durable-runtime/node-root.ts";
import type { RootDurableRuntimeShape } from "../src/durable-runtime/root-runtime.ts";
import { NormalizedMessage, stableMessageId } from "../src/prototype/domain.ts";
import { HandlerFailure } from "../src/prototype/errors.ts";
import { RECOVERY_NOTICE_TEXT } from "../src/prototype/recovery-notice.ts";
import type { SlackGatewayShape } from "../src/prototype/runtime.ts";
import { normalizedEvent } from "../src/prototype/scenario.ts";
import { PrototypeStore } from "../src/prototype/store.ts";
import type { ImplementationAgentShape } from "../src/reference-coding-application.ts";
import {
  type AcpWorkspaceHealth,
  AcpWorkspaceStartupError,
  makeAcpSlackWorkspaceRunner,
  makeProductionAcpSlackWorkspaceRuntime,
  makeProductionAcpWorkspaceApplication,
} from "../src/slack/acp-workspace-runner.ts";
import type {
  SlackDaemonConfig,
  SlackRuntimeIdentity,
} from "../src/slack/config.ts";
import { acquireRunnerLock } from "../src/slack/runner-lock.ts";
import {
  prepareSlackRuntimePaths,
  type SlackRuntimePaths,
} from "../src/slack/runtime-paths.ts";
import {
  type SlackEventEnvelope,
  type SlackEventListener,
  type SocketModeClientBoundary,
  startSocketModeAdapter,
} from "../src/slack/socket-mode.ts";
import { makeLazyOpenCodeImplementationAgent } from "../src/slack/workspace-runner.ts";
import {
  prepareSlackWorkspaceRoot,
  type SlackWorkspaceStartupAdapter,
  startSlackWorkspaceDirectory,
} from "../src/slack/workspace-startup.ts";
import { isProcessRunning } from "./support/process-state.ts";
import { makeTempDirectoryScoped } from "./support/temp-directory.ts";

const fakeOpenCodePath = resolve(
  process.cwd(),
  "tests/fixtures/fake-opencode-acp.sh"
);
const scriptedPeerPath = resolve(
  process.cwd(),
  "tests/fixtures/scripted-acp-peer.ts"
);
const EXPECTED_MARKDOWN = "**Streaming** from ACP\n\n- complete\n- unchanged";
const EXPECTED_BLOCKED_NOTICE = RECOVERY_NOTICE_TEXT.blocked;
// Process-backed integration tests share the host with concurrent Sandcastle gates.
// Observation polls bound how long a scene waits for durable side effects
// to appear. Scenes now run concurrently within the file, so a single
// scene's observations can stretch while sibling scenes hold the worker;
// the bound stays well under the 60s suite timeout.
const OBSERVATION_TIMEOUT_MILLIS = 30_000;

const SessionMethod = Schema.Struct({
  method: Schema.Literals(["session/new", "session/resume"]),
  params: Schema.Record(Schema.String, Schema.Unknown),
});

const BugActionInvocationResults = Schema.Struct({
  actionName: Schema.Literal("deal-with-bug"),
  duplicate: DealWithBugActionResult,
  first: DealWithBugActionResult,
});

const FakeLaunch = Schema.Struct({
  args: Schema.Array(Schema.String),
  cwd: Schema.String,
  environmentNames: Schema.Array(Schema.String),
});

const readJsonLines = Effect.fnUntraced(function* (path: string) {
  const source = yield* Effect.promise(() => readFile(path, "utf8"));
  return source
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
});

const stableMcpServers = (value: unknown) =>
  (
    value as readonly {
      readonly args: readonly string[];
      readonly command: string;
      readonly env: readonly {
        readonly name: string;
        readonly value: string;
      }[];
      readonly name: string;
    }[]
  ).map((server) => ({
    ...server,
    env: server.env.filter(
      ({ name }) =>
        name !== "LABORER_MEMORY_REGISTRATION_NONCE" &&
        name !== "LABORER_MEMORY_READY_PATH" &&
        name !== "LABORER_ACTION_CONTROL_URL" &&
        name !== "LABORER_ACTION_SERVER_GENERATION"
    ),
  }));

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

const waitForProcessExit = Effect.fnUntraced(function* (pidPath: string) {
  const pid = Number(yield* Effect.promise(() => readFile(pidPath, "utf8")));
  const deadline = Date.now() + OBSERVATION_TIMEOUT_MILLIS;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) {
      return;
    }
    yield* Effect.sleep("10 millis");
  }
  return yield* Effect.die(new Error(`ACP child ${pid} did not exit`));
});

const processIsRunning = Effect.fnUntraced(function* (pidPath: string) {
  const pid = Number(yield* Effect.promise(() => readFile(pidPath, "utf8")));
  return isProcessRunning(pid);
});

const waitForMessageCount = Effect.fnUntraced(function* (
  messages: readonly CapturedSlackMessage[],
  expectedCount: number
) {
  const deadline = Date.now() + OBSERVATION_TIMEOUT_MILLIS;
  while (Date.now() < deadline) {
    if (messages.length >= expectedCount) {
      return;
    }
    yield* Effect.sleep("10 millis");
  }
  return yield* Effect.die(
    new Error(`timed out waiting for ${expectedCount} Slack messages`)
  );
});

const waitForConversationSettlement = Effect.fnUntraced(function* (
  applicationStatePath: string,
  expectedPromptCount: number
) {
  const deadline = Date.now() + OBSERVATION_TIMEOUT_MILLIS;
  while (Date.now() < deadline) {
    const settled = yield* Effect.promise(async () => {
      try {
        const state = JSON.parse(
          await readFile(applicationStatePath, "utf8")
        ) as {
          readonly conversations?: readonly {
            readonly prompts?: readonly { readonly status?: string }[];
          }[];
        };
        const prompts = state.conversations?.flatMap(
          (conversation) => conversation.prompts ?? []
        );
        return (
          prompts !== undefined &&
          prompts.length >= expectedPromptCount &&
          prompts.every(({ status }) => status !== "running")
        );
      } catch {
        return false;
      }
    });
    if (settled) {
      return;
    }
    yield* Effect.sleep("10 millis");
  }
  return yield* Effect.die(
    new Error("timed out waiting for Conversation settlement")
  );
});

const waitForReactionMethod = Effect.fnUntraced(function* (
  reactions: readonly CapturedSlackApiCall[],
  method: string
) {
  const deadline = Date.now() + OBSERVATION_TIMEOUT_MILLIS;
  while (Date.now() < deadline) {
    if (reactions.some((reaction) => reaction.method === method)) {
      return;
    }
    yield* Effect.sleep("10 millis");
  }
  return yield* Effect.die(
    new Error(`timed out waiting for Slack API method ${method}`)
  );
});

interface CapturedSlackMessage {
  readonly channelId: string;
  readonly rootTs: string;
  readonly text: string;
  readonly ts: string;
}

interface CapturedSlackApiCall {
  readonly body: string;
  readonly method: string;
}

const makeCapturingSlack = (
  messages: CapturedSlackMessage[],
  context: readonly NormalizedMessage[] = []
): SlackGatewayShape => ({
  postThreadMessage: (request) =>
    Effect.sync(() => {
      const posted = { ...request, ts: `slack-${messages.length + 1}` };
      messages.push(posted);
      return { ts: posted.ts };
    }),
  readActivationContext: () => Effect.succeed(context),
  updateThreadMessage: ({ channelId, messageTs, text }) =>
    Effect.sync(() => {
      const index = messages.findIndex(
        (message) => message.channelId === channelId && message.ts === messageTs
      );
      const previous = messages[index];
      if (index < 0 || previous === undefined) {
        throw new Error("streamed Slack message is unavailable");
      }
      messages[index] = { ...previous, text };
    }),
});

const makeUnusedImplementationClient = (counters: {
  implementationPrompts: number;
}): OpenCodeSessionClient => ({
  createSession: () => Effect.void,
  interrupt: () => Effect.void,
  prepareSessionForReuse: () => Effect.void,
  readMessages: () => Effect.succeed([]),
  sessionExists: () => Effect.succeed(false),
  submitPrompt: () =>
    Effect.sync(() => {
      counters.implementationPrompts += 1;
    }),
  wait: () => Effect.void,
});

const admittedImplementationPrompts = new WeakMap<
  object,
  Map<string, string>
>();

interface ScriptedProcessPaths {
  readonly durableSessions: string;
  readonly launch: string;
  readonly lifecycle: string;
  readonly methods: string;
  readonly pid: string;
  readonly prompts: string;
  readonly ready: string;
  readonly release: string;
  readonly sessionRemainder: string;
}

const scriptedProcessPaths = (
  directory: string,
  name: string
): ScriptedProcessPaths => ({
  durableSessions: join(directory, `${name}-durable-sessions.json`),
  launch: join(directory, `${name}-launch.json`),
  lifecycle: join(directory, `${name}-lifecycle.log`),
  methods: join(directory, `${name}-methods.jsonl`),
  pid: join(directory, `${name}-pid`),
  prompts: join(directory, `${name}-prompts.jsonl`),
  ready: join(directory, `${name}-ready`),
  release: join(directory, `${name}-release`),
  sessionRemainder: join(directory, `${name}-session-remainder`),
});

const scriptedEnvironment = (
  paths: ScriptedProcessPaths,
  additions: NodeJS.ProcessEnv = {}
): NodeJS.ProcessEnv => ({
  ...process.env,
  FAKE_ACP_LAUNCH_LOG: paths.launch,
  FAKE_ACP_PEER: scriptedPeerPath,
  FAKE_ACP_RUNTIME: process.execPath,
  HOME: join(dirname(paths.ready), "home"),
  OPENAI_API_KEY: "provider-secret-244",
  SCRIPTED_ACP_AGENT_NAME: "OpenCode",
  SCRIPTED_ACP_AGENT_VERSION: "1.18.4",
  SCRIPTED_ACP_DISABLE_PROMPT_MARKER: "1",
  SCRIPTED_ACP_DURABLE_SESSIONS_PATH: paths.durableSessions,
  SCRIPTED_ACP_LIFECYCLE_LOG_PATH: paths.lifecycle,
  SCRIPTED_ACP_PID_PATH: paths.pid,
  SCRIPTED_ACP_PROMPT_JSONL_PATH: paths.prompts,
  SCRIPTED_ACP_READY_PATH: paths.ready,
  SCRIPTED_ACP_RELEASE_PATH: paths.release,
  SCRIPTED_ACP_REPLAY_ON_RESUME: "1",
  SCRIPTED_ACP_SESSION_METHOD_JSONL_PATH: paths.methods,
  SCRIPTED_ACP_SESSION_REMAINDER_PATH: paths.sessionRemainder,
  SCRIPTED_ACP_USE_OPENCODE_MESSAGE_IDS: "1",
  XDG_CONFIG_HOME: join(dirname(paths.ready), "xdg-config"),
  ...additions,
});

const PROCESS_ENVIRONMENT_NAMES = [
  "FAKE_ACP_LAUNCH_LOG",
  "FAKE_ACP_PEER",
  "FAKE_ACP_RUNTIME",
  "OPENAI_API_KEY",
  "SCRIPTED_ACP_AGENT_NAME",
  "SCRIPTED_ACP_AGENT_VERSION",
  "SCRIPTED_ACP_ACTION_NAME",
  "SCRIPTED_ACP_ACTION_OPERATION_JSON",
  "SCRIPTED_ACP_ACTION_RESULT_PATH",
  "SCRIPTED_ACP_ACTION_EXPECT_FAILURE",
  "SCRIPTED_ACP_DURABLE_SESSIONS_PATH",
  "SCRIPTED_ACP_EFFECTIVE_CONFIG_JSON",
  "SCRIPTED_ACP_DISABLE_PROMPT_MARKER",
  "SCRIPTED_ACP_DISABLE_RESUME_CAPABILITY",
  "SCRIPTED_ACP_EXIT_AFTER_FIRST_PUBLIC_CHUNK",
  "SCRIPTED_ACP_EXIT_AFTER_FIRST_PUBLIC_CHUNK_MARKER_PATH",
  "SCRIPTED_ACP_EXECUTION_PROMPT_MARKER",
  "SCRIPTED_ACP_EXECUTION_PROMPT_TEXT",
  "SCRIPTED_ACP_EXECUTION_CANCEL_ABORTED_PATH",
  "SCRIPTED_ACP_EXECUTION_CANCEL_ABORT_TRIGGER_PATH",
  "SCRIPTED_ACP_EXECUTION_CANCEL_CALL_STARTED_PATH",
  "SCRIPTED_ACP_EXECUTION_CANCEL_MARKER",
  "SCRIPTED_ACP_EXECUTION_ID_PATH",
  "SCRIPTED_ACP_EXECUTION_POST_CANCEL_MARKER",
  "SCRIPTED_ACP_EXIT_AFTER_PROMPT_RECEIVED",
  "SCRIPTED_ACP_EXIT_AFTER_PROMPT_RECEIVED_MARKER_PATH",
  "SCRIPTED_ACP_LIFECYCLE_LOG_PATH",
  "SCRIPTED_ACP_PID_PATH",
  "SCRIPTED_ACP_PROMPT_JSONL_PATH",
  "SCRIPTED_ACP_PUBLIC_OUTPUT_LABEL",
  "SCRIPTED_ACP_PERMISSION_RAW_INPUT_JSON",
  "SCRIPTED_ACP_PERMISSION_RESULT_PATH",
  "SCRIPTED_ACP_PERMISSION_TITLE",
  "SCRIPTED_ACP_PERMISSION_TOOL_KIND",
  "SCRIPTED_ACP_READY_PATH",
  "SCRIPTED_ACP_RELEASE_PATH",
  "SCRIPTED_ACP_REPLAY_ON_RESUME",
  "SCRIPTED_ACP_SCENARIO",
  "SCRIPTED_ACP_SESSION_ID_PREFIX",
  "SCRIPTED_ACP_SESSION_METHOD_JSONL_PATH",
  "SCRIPTED_ACP_SESSION_CANCEL_JSONL_PATH",
  "SCRIPTED_ACP_SESSION_REMAINDER_PATH",
  "SCRIPTED_ACP_USE_OPENCODE_MESSAGE_IDS",
] as const;

const PRIVATE_ENVIRONMENT_NAMES = [
  "LABORER_ACTION_BRIDGE_TOKEN",
  "LABORER_ACP_PRIVATE_TOKEN",
  "LABORER_MEMORY_AUTHORITY_GUARD",
  "LABORER_OPENCODE_MODEL",
  "LABORER_SLACK_WORKSPACES",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_DISABLE_PROJECT_CONFIG",
  "OPENCODE_PERMISSION",
  "SLACK_APP_TOKEN",
  "SLACK_BOT_TOKEN_WORKSPACE_244",
] as const;

const ROUTE_FORBIDDEN_ENVIRONMENT_NAMES = [
  "SLACK_SIGNING_SECRET",
  "Slack_Client_Secret",
  "SLACK_USER_TOKEN",
  "slack_api_token",
  "LABORER_SLACK_WORKSPACES",
  "LABORER_CANARY_SOCKET",
  "Laborer_Canary_Source_Event_Id",
  "laborer_canary_thread_id",
  "LABORER_ACTION_BRIDGE_AUTHORITY",
  "Laborer_Memory_Authority_Guard",
] as const;
const SAFE_SLACK_METADATA_NAME = "SLACK_TEAM_ID";

const applicationConfig = {
  agent: "implementation-only-agent",
  environment: [
    ...PROCESS_ENVIRONMENT_NAMES,
    ...PRIVATE_ENVIRONMENT_NAMES,
    "SCRIPTED_ACP_IDLE_EXIT_MARKER_PATH",
    "SCRIPTED_ACP_IDLE_EXIT_TRIGGER_PATH",
  ],
  model: "implementation-provider/implementation-model",
  type: "reference-coding" as const,
};

const effectiveConfigJson = (options: {
  readonly effort: string;
  readonly mode: string;
  readonly model: string;
}): string =>
  JSON.stringify({
    configOptions: [
      {
        category: "model",
        currentValue: options.model,
        id: "model",
        name: "Model",
        options: [{ name: "Selected", value: options.model }],
        type: "select",
      },
      {
        category: "thought_level",
        currentValue: options.effort,
        id: "effort",
        name: "Effort",
        options: [{ name: "Selected", value: options.effort }],
        type: "select",
      },
      {
        category: "mode",
        currentValue: options.mode,
        id: "mode",
        name: "Mode",
        options: [{ name: "Selected", value: options.mode }],
        type: "select",
      },
      {
        category: "provider-auth-secret",
        currentValue: "must-not-persist",
        id: "credentials",
        name: "Secret catalog",
        options: [{ name: "secret", value: "provider-secret-value" }],
        type: "select",
      },
    ],
  });

const makeFixtureSlackClient = (
  calls: CapturedSlackApiCall[] = [],
  beforePermissionPost?: () => Promise<void>
): WebClient =>
  new WebClient(["x", "oxb", "-244-fixture"].join(""), {
    fetch: async (input, init) => {
      const url = String(input);
      const method = url.slice(url.lastIndexOf("/") + 1);
      calls.push({
        body: String(init?.body ?? ""),
        method,
      });
      if (method === "chat.postMessage") {
        await beforePermissionPost?.();
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            ok: true,
            ...(method === "chat.postMessage"
              ? { ts: "permission-message-245" }
              : {}),
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          }
        )
      );
    },
    rejectRateLimitedCalls: true,
  });

class PermissionSocketClient implements SocketModeClientBoundary {
  listener: SlackEventListener | null = null;

  disconnect = (): Promise<void> => Promise.resolve();

  emit(envelope: SlackEventEnvelope): void {
    this.listener?.(envelope);
  }

  off(_event: "slack_event", listener: SlackEventListener): void {
    if (this.listener === listener) {
      this.listener = null;
    }
  }

  on(_event: "slack_event", listener: SlackEventListener): void {
    this.listener = listener;
  }

  start = (): Promise<void> => Promise.resolve();
}

const socketActivationEnvelope = (options: {
  readonly ack: SlackEventEnvelope["ack"];
  readonly channelId: string;
  readonly eventId: string;
  readonly messageTs: string;
  readonly teamId: string;
  readonly text: string;
  readonly threadTs?: string;
  readonly userId: string;
}): SlackEventEnvelope => ({
  ack: options.ack,
  body: {
    event: {
      channel: options.channelId,
      channel_type: "channel",
      event_ts: options.messageTs,
      text: options.text,
      ...(options.threadTs === undefined
        ? {}
        : { thread_ts: options.threadTs }),
      ts: options.messageTs,
      type: "app_mention",
      user: options.userId,
    },
    event_id: options.eventId,
    team_id: options.teamId,
    type: "event_callback",
  },
  envelope_id: `envelope:${options.eventId}`,
  type: "events_api",
});

const socketPermissionEnvelope = (options: {
  readonly ack: SlackEventEnvelope["ack"];
  readonly actionId: string;
  readonly capability: string;
  readonly channelId?: string | undefined;
  readonly envelopeId: string;
  readonly messageTs?: string | undefined;
  readonly rootTs?: string | undefined;
  readonly teamId: string;
  readonly userId?: string | undefined;
}): SlackEventEnvelope => {
  const channelId = options.channelId ?? "C245PERMISSION";
  const messageTs = options.messageTs ?? "permission-message-245";
  const rootTs = options.rootTs ?? "245.700";
  return {
    ack: options.ack,
    body: {
      actions: [
        {
          action_id: options.actionId,
          value: options.capability,
        },
      ],
      channel: { id: channelId },
      container: {
        channel_id: channelId,
        message_ts: messageTs,
        thread_ts: rootTs,
      },
      message: {
        thread_ts: rootTs,
        ts: messageTs,
      },
      team: { id: options.teamId },
      type: "block_actions",
      user: { id: options.userId ?? "U245AUTHORIZED" },
    },
    envelope_id: options.envelopeId,
    type: "interactive",
  };
};

interface StartedWorkspaceSpec {
  readonly artifactCalls?: { branches: number; worktrees: number };
  readonly beforePermissionPost?: () => Promise<void>;
  readonly constructionFailure?: "layer" | "repository";
  readonly context?: readonly NormalizedMessage[];
  readonly environment: NodeJS.ProcessEnv;
  readonly health: AcpWorkspaceHealth[];
  readonly identity: SlackRuntimeIdentity;
  readonly implementation?: {
    acquisitions: number;
    agent: ImplementationAgentShape | null;
    finalizations: number;
    interrupt?: Effect.Effect<void>;
    interrupts?: number;
    prompts: number;
    responses?: boolean;
    wait?: Effect.Effect<void>;
  };
  readonly messages: CapturedSlackMessage[];
  readonly observePermissionBroker?: (broker: AcpPermissionBroker) => void;
  readonly permissionBrokerTestHooks?: {
    readonly afterTerminalPublishBeforeLiveCompletion?: () => Effect.Effect<void>;
  };
  readonly permissionTimeoutMillis?: number;
  readonly reactions: CapturedSlackApiCall[];
  readonly token: string;
  readonly treatCommandAsOpenCode?: boolean;
  readonly worktreeCollision?: boolean;
}

const makeStartedDirectoryAdapter = (
  specs: readonly StartedWorkspaceSpec[],
  implementationAcquisitions: { count: number },
  options: { readonly clusterBacked?: boolean } = {}
): SlackWorkspaceStartupAdapter<WebClient, SlackGatewayShape> => {
  const byToken = new Map(specs.map((spec) => [spec.token, spec]));
  const byClient = new Map<WebClient, StartedWorkspaceSpec>();
  return {
    authenticate: (client) => {
      const spec = byClient.get(client);
      return spec === undefined
        ? Effect.die(new Error("unknown production fixture client"))
        : Effect.succeed(spec.identity);
    },
    makeClient: (token) => {
      const spec = byToken.get(token);
      if (spec === undefined) {
        throw new Error("unknown production fixture token");
      }
      const client = makeFixtureSlackClient(
        spec.reactions,
        spec.beforePermissionPost
      );
      byClient.set(client, spec);
      return client;
    },
    makeGateway: ({ client }) => {
      const spec = byClient.get(client);
      if (spec === undefined) {
        throw new Error("production fixture gateway has no workspace");
      }
      return makeCapturingSlack(spec.messages, spec.context);
    },
    ...(options.clusterBacked === true
      ? {
          makeRootRuntime: ({ laborer, legacyWorkspaceId, paths }) =>
            makeNodeRootDurableRuntime({
              databasePath: paths.runtimeDatabase,
              ...(legacyWorkspaceId === undefined ? {} : { legacyWorkspaceId }),
              rootIdentity: laborer.root,
            }),
        }
      : {}),
    makeRunner: (runtime) => {
      const spec = byClient.get(runtime.client);
      if (spec === undefined) {
        return Effect.die(
          new Error("production fixture Runner has no workspace")
        );
      }
      const artifactCalls = spec.artifactCalls;
      const implementation = spec.implementation;
      return makeAcpSlackWorkspaceRunner(runtime, {
        environment: spec.environment,
        ...(spec.constructionFailure === "repository"
          ? {
              makeApplicationRepository: () =>
                HandlerFailure.make({
                  category: "protocol",
                  safeDetail: "injected repository construction failure",
                }),
            }
          : {}),
        makeOpenCodeClient: () => {
          const acquireClient = Effect.sync(() => {
            implementationAcquisitions.count += 1;
            if (implementation === undefined) {
              return makeUnusedImplementationClient({
                implementationPrompts: 0,
              });
            }
            implementation.acquisitions += 1;
            let admittedPrompts =
              admittedImplementationPrompts.get(implementation);
            if (admittedPrompts === undefined) {
              admittedPrompts = new Map();
              admittedImplementationPrompts.set(
                implementation,
                admittedPrompts
              );
            }
            const client: OpenCodeSessionClient = {
              createSession: () => Effect.void,
              interrupt: () =>
                Effect.gen(function* () {
                  implementation.interrupts =
                    (implementation.interrupts ?? 0) + 1;
                  yield* implementation.interrupt ?? Effect.void;
                }),
              prepareSessionForReuse: () => Effect.void,
              readMessages: (input) => {
                const promptText = admittedPrompts.get(input.promptId);
                if (promptText === undefined) {
                  return Effect.succeed([]);
                }
                return Effect.succeed(
                  implementation.responses === false
                    ? [
                        {
                          id: input.promptId,
                          role: "user" as const,
                          text: promptText,
                        },
                      ]
                    : [
                        {
                          id: input.promptId,
                          role: "user" as const,
                          text: promptText,
                        },
                        {
                          finish: "stop",
                          id: `response:${input.promptId}`,
                          role: "assistant" as const,
                          status: "completed" as const,
                          text: "explicit implementation completed",
                        },
                      ]
                );
              },
              sessionExists: () => Effect.succeed(true),
              submitPrompt: (input) =>
                Effect.gen(function* () {
                  const existing = admittedPrompts.get(input.promptId);
                  if (existing !== undefined) {
                    if (existing !== input.text) {
                      return yield* HandlerFailure.make({
                        category: "protocol",
                        safeDetail: "implementation prompt identity conflicts",
                      });
                    }
                    return;
                  }
                  admittedPrompts.set(input.promptId, input.text);
                  implementation.prompts += 1;
                }),
              wait: () => implementation.wait ?? Effect.void,
            };
            return client;
          });
          return implementation === undefined
            ? acquireClient
            : Effect.acquireRelease(acquireClient, () =>
                Effect.sync(() => {
                  implementation.finalizations += 1;
                })
              );
        },
        ...(artifactCalls === undefined
          ? {}
          : {
              makeWorktreeManager: () => ({
                create: () =>
                  spec.worktreeCollision === true
                    ? HandlerFailure.make({
                        category: "protocol",
                        safeDetail: "worktree name already exists",
                      })
                    : Effect.sync(() => {
                        artifactCalls.branches += 1;
                        artifactCalls.worktrees += 1;
                        return { workingDirectory: runtime.laborer.root };
                      }),
              }),
            }),
        observeHealth: (health) => spec.health.push(health),
        ...(spec.observePermissionBroker === undefined
          ? {}
          : { observePermissionBroker: spec.observePermissionBroker }),
        ...(spec.permissionTimeoutMillis === undefined
          ? {}
          : { permissionTimeoutMillis: spec.permissionTimeoutMillis }),
        ...(spec.permissionBrokerTestHooks === undefined
          ? {}
          : { permissionBrokerTestHooks: spec.permissionBrokerTestHooks }),
        participantLookup: {
          lookupVisibleName: (slackUserId) =>
            Effect.succeed(`${spec.identity.teamId}:${slackUserId}:visible`),
        },
        ...(implementation === undefined
          ? {}
          : {
              observeImplementationAgent: (agent: ImplementationAgentShape) => {
                implementation.agent = agent;
              },
            }),
        process: {
          command: fakeOpenCodePath,
          testHooks: {
            treatCommandAsOpenCode: spec.treatCommandAsOpenCode ?? true,
          },
        },
        ...(spec.constructionFailure === "layer"
          ? {
              storeLayer: Layer.effect(
                PrototypeStore,
                Effect.die(new Error("injected Layer.build failure"))
              ),
            }
          : {}),
      });
    },
    makeSetupIncompleteResponder: () => () => Effect.void,
  };
};

const installationFor = (
  spec: StartedWorkspaceSpec,
  bindingIndex: number,
  root: string,
  namespaceWorkspace = true
): SlackDaemonConfig["installations"][number] => ({
  bindingIndex,
  botToken: Redacted.make(spec.token),
  botTokenEnvironment: `SLACK_BOT_TOKEN_${spec.identity.teamId}`,
  expectedTeamId: spec.identity.teamId,
  namespaceWorkspace,
  root,
  tokenIsValid: true,
  validation: { _tag: "Valid" },
});

const historicalContext = (
  channelId: string,
  slackUserId: string,
  text: string
): NormalizedMessage =>
  NormalizedMessage.make({
    authorKind: "human",
    authorSlackId: slackUserId,
    classification: "context",
    id: stableMessageId(channelId, "100.0"),
    isActivation: false,
    slackTs: "100.0",
    text,
  });

const writeAcpLaborerConfig = (root: string): Effect.Effect<void> =>
  Effect.promise(() =>
    writeFile(
      join(root, "laborer.json"),
      JSON.stringify({
        application: {
          environment: PROCESS_ENVIRONMENT_NAMES,
          type: "reference-coding",
        },
      }),
      { mode: 0o600 }
    )
  );

const permissionCapabilityFrom = (call: CapturedSlackApiCall): string => {
  const encodedBlocks = new URLSearchParams(call.body).get("blocks");
  if (encodedBlocks === null) {
    throw new Error("permission blocks are absent");
  }
  const blocks = JSON.parse(encodedBlocks) as readonly {
    readonly elements?: readonly { readonly value?: string }[];
  }[];
  const capability = blocks.flatMap((block) => block.elements ?? [])[0]?.value;
  if (capability === undefined) {
    throw new Error("permission capability is absent from Block Kit payload");
  }
  return capability;
};

const waitForAuthoritySettlement = Effect.fnUntraced(function* (path: string) {
  const deadline = Date.now() + OBSERVATION_TIMEOUT_MILLIS;
  while (Date.now() < deadline) {
    const settled = yield* Effect.promise(async () => {
      try {
        const state = JSON.parse(await readFile(path, "utf8")) as {
          readonly records?: readonly { readonly state?: string }[];
        };
        return (
          (state.records?.length ?? 0) > 0 &&
          state.records?.every((record) => record.state !== "pending") === true
        );
      } catch {
        return false;
      }
    });
    if (settled) {
      return;
    }
    yield* Effect.sleep("10 millis");
  }
  return yield* Effect.die(new Error("ACP authority did not settle"));
});

const makeProductionHarness = Effect.fnUntraced(function* (options: {
  readonly environment: NodeJS.ProcessEnv;
  readonly health: AcpWorkspaceHealth[];
  readonly messages: CapturedSlackMessage[];
  readonly paths: SlackRuntimePaths;
  readonly root: string;
  readonly rootRuntime?: RootDurableRuntimeShape;
  readonly workspaceId: string;
  readonly worktreeCalls: { count: number };
  readonly implementationCounters: {
    implementationAcquisitions: number;
    implementationPrompts: number;
  };
}) {
  const workspace = yield* makeProductionAcpSlackWorkspaceRuntime(
    {
      client: makeFixtureSlackClient(),
      gateway: makeCapturingSlack(options.messages),
      identity: {
        botId: "B244LABORER",
        botUserId: "U244LABORER",
        teamId: options.workspaceId,
      },
      laborer: {
        config: { application: applicationConfig },
        root: options.root,
      },
      paths: options.paths,
      ...(options.rootRuntime === undefined
        ? {}
        : { rootRuntime: options.rootRuntime }),
    },
    {
      environment: options.environment,
      makeOpenCodeClient: () =>
        Effect.sync(() => {
          options.implementationCounters.implementationAcquisitions += 1;
          return makeUnusedImplementationClient(options.implementationCounters);
        }),
      makeWorktreeManager: () => ({
        create: () =>
          Effect.sync(() => {
            options.worktreeCalls.count += 1;
            return { workingDirectory: options.root };
          }),
      }),
      observeHealth: (health) => options.health.push(health),
      participantLookup: {
        lookupVisibleName: (slackUserId) => Effect.succeed(slackUserId),
      },
      process: {
        command: fakeOpenCodePath,
        testHooks: { treatCommandAsOpenCode: true },
      },
    }
  );
  return { harness: workspace.harness, workspace };
});

// Every scene provisions its own temp directories, Slack spec, and child
// process chain, so scenes are isolated and spend most wall-clock time
// waiting on serialized child boots. Running them concurrently overlaps
// those waits. The suite timeout replaces the 5s default, which these
// multi-child scenes exceed under concurrent scheduling; explicit
// per-scene timeouts still take precedence.
describe.concurrent("issues #244-#257 production ACP acceptance", () => {
  it.effect(
    "fails a non-reference-coding binding with a typed composition error",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-244-incompatible-composition-"
          );
          const paths = yield* prepareSlackRuntimePaths(
            root,
            "T244INCOMPATIBLE"
          );
          const failure = yield* Effect.flip(
            makeProductionAcpSlackWorkspaceRuntime({
              client: makeFixtureSlackClient(),
              gateway: makeCapturingSlack([]),
              identity: {
                botId: "B244INCOMPATIBLE",
                botUserId: "U244LABORER",
                teamId: "T244INCOMPATIBLE",
              },
              laborer: {
                config: {
                  workHandler: {
                    args: [],
                    command: "unused",
                    environment: [],
                  },
                },
                root,
              },
              paths,
            })
          );

          assert.ok(failure instanceof AcpWorkspaceStartupError);
          assert.strictEqual(failure.reason, "acp-composition-incompatible");
          assert.strictEqual(failure.workspaceId, "T244INCOMPATIBLE");
        })
      )
  );

  it.live(
    "runs the credential-free Socket Mode to generated Action MCP to terminal ACP scene once",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-246-production-action-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-246-production-action-controls-"
          );
          yield* writeAcpLaborerConfig(root);
          const processPaths = scriptedProcessPaths(controls, "action-scene");
          const artifactCalls = { branches: 0, worktrees: 0 };
          const implementation = {
            acquisitions: 0,
            agent: null,
            finalizations: 0,
            prompts: 0,
            responses: true,
          } satisfies NonNullable<StartedWorkspaceSpec["implementation"]>;
          const implementationAcquisitions = { count: 0 };
          const actionInput = {
            prompt: "PRIVATE FEATURE PROMPT MUST NOT REACH SLACK 246",
            worktreeName: "full-action-246",
          };
          const spec: StartedWorkspaceSpec = {
            artifactCalls,
            environment: scriptedEnvironment(processPaths, {
              SCRIPTED_ACP_ACTION_OPERATION_JSON: JSON.stringify(actionInput),
              SCRIPTED_ACP_EXECUTION_PROMPT_MARKER:
                "continue through generated control",
              SCRIPTED_ACP_EXECUTION_PROMPT_TEXT:
                "Run the generated production follow-up.",
              SCRIPTED_ACP_SCENARIO: "action",
            }),
            health: [],
            identity: {
              botId: "B246ACTION",
              botUserId: "U246LABORER",
              teamId: "T246ACTION",
            },
            implementation,
            messages: [],
            reactions: [],
            token: ["x", "oxb", "-246-action"].join(""),
          };
          const routes = yield* startSlackWorkspaceDirectory({
            adapter: makeStartedDirectoryAdapter(
              [spec],
              implementationAcquisitions,
              { clusterBacked: true }
            ),
            config: {
              appToken: Redacted.make(["x", "app", "-246-action"].join("")),
              installations: [installationFor(spec, 0, root)],
              startupMode: "multi-workspace",
            },
            environment: {},
          });
          const installation = yield* routes.awaitReady(spec.identity.teamId);
          assert.ok(installation.runner !== undefined);
          const socket = new PermissionSocketClient();
          yield* startSocketModeAdapter({
            client: socket,
            routeDirectory: routes,
          });
          let acknowledged = false;
          socket.emit(
            socketActivationEnvelope({
              ack: () => {
                acknowledged = true;
                return Promise.resolve();
              },
              channelId: "C246ACTION",
              eventId: "event:246:action",
              messageTs: "246.100",
              teamId: spec.identity.teamId,
              text: "<@U246LABORER> please implement this feature",
              userId: "U246HUMAN",
            })
          );
          yield* waitForMessageCount(spec.messages, 3);

          let followUpAcknowledged = false;
          socket.emit(
            socketActivationEnvelope({
              ack: () => {
                followUpAcknowledged = true;
                return Promise.resolve();
              },
              channelId: "C246ACTION",
              eventId: "event:247:generated-control",
              messageTs: "247.101",
              teamId: spec.identity.teamId,
              text: "<@U246LABORER> continue through generated control",
              threadTs: "246.100",
              userId: "U246HUMAN",
            })
          );
          yield* waitForMessageCount(spec.messages, 6);

          assert.ok(acknowledged);
          assert.ok(followUpAcknowledged);
          assert.deepStrictEqual(
            spec.messages.map((message) => message.text),
            [
              "I started the feature implementation.",
              "The implementation update is ready for review.",
              "Implementation finished successfully.",
              "I queued the implementation follow-up.",
              "The implementation update is ready for review.",
              "Implementation finished successfully.",
            ]
          );
          assert.deepStrictEqual(artifactCalls, {
            branches: 1,
            worktrees: 1,
          });
          assert.strictEqual(implementation.acquisitions, 1);
          assert.strictEqual(implementation.prompts, 2);
          const paths = yield* prepareSlackRuntimePaths(
            root,
            spec.identity.teamId
          );
          const state = JSON.parse(
            yield* Effect.promise(() =>
              readFile(paths.applicationState, "utf8")
            )
          ) as {
            readonly actionOperations: readonly unknown[];
            readonly executionPromptOperations: readonly unknown[];
            readonly executions: readonly {
              readonly events: readonly {
                readonly eventId: string;
                readonly source: string;
                readonly status: string;
              }[];
            }[];
          };
          assert.strictEqual(state.actionOperations.length, 1);
          assert.strictEqual(state.executionPromptOperations.length, 1);
          assert.strictEqual(state.executions.length, 1);
          const runtimeDatabase = new DatabaseSync(paths.runtimeDatabase, {
            readOnly: true,
          });
          try {
            const durableConversationEvents = runtimeDatabase
              .prepare(
                `SELECT status
                 FROM laborer_conversation_events
                 ORDER BY sequence`
              )
              .all() as unknown as readonly { readonly status: string }[];
            assert.ok(durableConversationEvents.length >= 2);
            assert.ok(
              durableConversationEvents.every(
                ({ status }) => status === "completed"
              )
            );
          } finally {
            runtimeDatabase.close();
          }
          const terminalEvents =
            state.executions[0]?.events.filter(
              ({ source }) => source === "action-terminal"
            ) ?? [];
          assert.strictEqual(terminalEvents.length, 2);
          assert.ok(
            terminalEvents.every(({ status }) => status === "accepted")
          );
          assert.ok(
            terminalEvents.some(({ eventId }) => eventId.endsWith(":terminal"))
          );
          const prompts = (yield* Effect.promise(() =>
            readFile(processPaths.prompts, "utf8")
          ))
            .trim()
            .split("\n")
            .map(
              (line) =>
                JSON.parse(line) as {
                  readonly prompt: string;
                  readonly sessionId: string;
                }
            );
          assert.strictEqual(
            new Set(prompts.map(({ sessionId }) => sessionId)).size,
            1
          );
          assert.ok(
            prompts.some(({ prompt }) =>
              prompt.includes('source="action-terminal"')
            )
          );
          const publicText = JSON.stringify(spec.messages);
          for (const secret of [
            actionInput.prompt,
            root,
            "ACTION RAW TOOL OUTPUT MUST REMAIN PRIVATE 246",
            "execution:",
            "response:",
          ]) {
            assert.ok(!publicText.includes(secret));
          }
        })
      ),
    20_000
  );

  it.live(
    "cancels a running Execution through authenticated generated MCP, survives caller cancellation, and remains terminal after restart",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-249-production-cancellation-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-249-production-cancellation-controls-"
          );
          yield* writeAcpLaborerConfig(root);
          const firstProcess = scriptedProcessPaths(controls, "cancel-first");
          const secondProcess = {
            ...scriptedProcessPaths(controls, "cancel-second"),
            durableSessions: firstProcess.durableSessions,
            methods: firstProcess.methods,
            prompts: firstProcess.prompts,
          };
          const executionIdPath = join(controls, "execution-id");
          const cancelCallStartedPath = join(controls, "cancel-call-started");
          const cancelAbortTriggerPath = join(controls, "cancel-abort-trigger");
          const cancelAbortedPath = join(controls, "cancel-aborted");
          const sessionCancelPath = join(controls, "session-cancels.jsonl");
          const worktreeMarker = join(root, "uncommitted-worktree-marker.txt");
          yield* Effect.promise(() =>
            writeFile(worktreeMarker, "preserve this work", { mode: 0o600 })
          );
          const interruptStarted = yield* Deferred.make<void>();
          const interruptRelease = yield* Deferred.make<void>();
          const implementation = {
            acquisitions: 0,
            agent: null,
            finalizations: 0,
            interrupt: Deferred.succeed(interruptStarted, undefined).pipe(
              Effect.andThen(Deferred.await(interruptRelease))
            ),
            interrupts: 0,
            prompts: 0,
            responses: false,
            wait: Effect.never,
          } satisfies NonNullable<StartedWorkspaceSpec["implementation"]>;
          const implementationAcquisitions = { count: 0 };
          const artifactCalls = { branches: 0, worktrees: 0 };
          const messages: CapturedSlackMessage[] = [];
          const reactions: CapturedSlackApiCall[] = [];
          const identity: SlackRuntimeIdentity = {
            botId: "B249CANCEL",
            botUserId: "U249LABORER",
            teamId: "T249CANCEL",
          };
          const token = ["x", "oxb", "-249-cancel"].join("");
          const actionInput = {
            prompt: "PRIVATE RUNNING EXECUTION PROMPT 249",
            worktreeName: "production-cancel-249",
          };
          const commonEnvironment = {
            SCRIPTED_ACP_ACTION_OPERATION_JSON: JSON.stringify(actionInput),
            SCRIPTED_ACP_EXECUTION_CANCEL_ABORTED_PATH: cancelAbortedPath,
            SCRIPTED_ACP_EXECUTION_CANCEL_ABORT_TRIGGER_PATH:
              cancelAbortTriggerPath,
            SCRIPTED_ACP_EXECUTION_CANCEL_CALL_STARTED_PATH:
              cancelCallStartedPath,
            SCRIPTED_ACP_EXECUTION_CANCEL_MARKER: "cancel running execution",
            SCRIPTED_ACP_EXECUTION_ID_PATH: executionIdPath,
            SCRIPTED_ACP_EXECUTION_POST_CANCEL_MARKER:
              "inspect terminal execution",
            SCRIPTED_ACP_SCENARIO: "action",
            SCRIPTED_ACP_SESSION_CANCEL_JSONL_PATH: sessionCancelPath,
          } satisfies NodeJS.ProcessEnv;
          const firstSpec: StartedWorkspaceSpec = {
            artifactCalls,
            environment: scriptedEnvironment(firstProcess, commonEnvironment),
            health: [],
            identity,
            implementation,
            messages,
            reactions,
            token,
          };
          const configFor = (
            spec: StartedWorkspaceSpec
          ): SlackDaemonConfig => ({
            appToken: Redacted.make(["x", "app", "-249-cancel"].join("")),
            installations: [installationFor(spec, 0, root)],
            startupMode: "multi-workspace",
          });
          const paths = yield* prepareSlackRuntimePaths(root, identity.teamId);

          yield* Effect.scoped(
            Effect.gen(function* () {
              const routes = yield* startSlackWorkspaceDirectory({
                adapter: makeStartedDirectoryAdapter(
                  [firstSpec],
                  implementationAcquisitions
                ),
                config: configFor(firstSpec),
                environment: {},
              });
              yield* routes.awaitReady(identity.teamId);
              const socket = new PermissionSocketClient();
              yield* startSocketModeAdapter({
                client: socket,
                routeDirectory: routes,
              });
              socket.emit(
                socketActivationEnvelope({
                  ack: () => Promise.resolve(),
                  channelId: "C249CANCEL",
                  eventId: "event:249:start",
                  messageTs: "249.100",
                  teamId: identity.teamId,
                  text: "<@U249LABORER> implement a long-running feature",
                  userId: "U249HUMAN",
                })
              );
              yield* waitForMessageCount(messages, 1);
              yield* waitForFile(executionIdPath);
              assert.strictEqual(implementation.prompts, 1);
              assert.deepStrictEqual(artifactCalls, {
                branches: 1,
                worktrees: 1,
              });

              socket.emit(
                socketActivationEnvelope({
                  ack: () => Promise.resolve(),
                  channelId: "C249CANCEL",
                  eventId: "event:249:cancel",
                  messageTs: "249.101",
                  teamId: identity.teamId,
                  text: "<@U249LABORER> cancel running execution",
                  threadTs: "249.100",
                  userId: "U249HUMAN",
                })
              );
              yield* waitForFile(cancelCallStartedPath);
              yield* Deferred.await(interruptStarted);
              assert.strictEqual(implementation.interrupts, 1);
              assert.strictEqual(messages.length, 1);
              yield* Effect.promise(() =>
                writeFile(cancelAbortTriggerPath, "abort", { mode: 0o600 })
              );
              yield* waitForFile(cancelAbortedPath);
              assert.strictEqual(messages.length, 1);
              const sessionCancelObserved = yield* Effect.promise(async () => {
                try {
                  await stat(sessionCancelPath);
                  return true;
                } catch {
                  return false;
                }
              });
              assert.strictEqual(sessionCancelObserved, false);
              yield* Deferred.succeed(interruptRelease, undefined);
              yield* waitForMessageCount(messages, 2);
              assert.deepStrictEqual(
                messages.map(({ text }) => text),
                [
                  "I started the feature implementation.",
                  "The implementation was cancelled and its worktree is preserved.",
                ]
              );
              assert.strictEqual(
                yield* Effect.promise(() => readFile(worktreeMarker, "utf8")),
                "preserve this work"
              );
              yield* waitForConversationSettlement(paths.applicationState, 3);
            })
          );
          yield* waitForProcessExit(firstProcess.pid);

          const cancelledState = JSON.parse(
            yield* Effect.promise(() =>
              readFile(paths.applicationState, "utf8")
            )
          ) as {
            readonly executions: readonly {
              readonly cancellation: {
                readonly terminalEventId: string;
              } | null;
              readonly events: readonly {
                readonly eventId: string;
                readonly source: string;
                readonly status: string;
              }[];
              readonly status: string;
            }[];
          };
          const cancelledExecution = cancelledState.executions[0];
          assert.strictEqual(cancelledExecution?.status, "cancelled");
          const cancellationEvents =
            cancelledExecution?.events.filter(
              ({ source }) => source === "execution-control"
            ) ?? [];
          assert.strictEqual(cancellationEvents.length, 1);
          assert.strictEqual(
            cancellationEvents[0]?.eventId,
            cancelledExecution?.cancellation?.terminalEventId
          );
          assert.strictEqual(cancellationEvents[0]?.status, "accepted");

          const secondSpec: StartedWorkspaceSpec = {
            artifactCalls,
            environment: scriptedEnvironment(secondProcess, commonEnvironment),
            health: [],
            identity,
            implementation,
            messages,
            reactions,
            token,
          };
          yield* Effect.scoped(
            Effect.gen(function* () {
              const routes = yield* startSlackWorkspaceDirectory({
                adapter: makeStartedDirectoryAdapter(
                  [secondSpec],
                  implementationAcquisitions
                ),
                config: configFor(secondSpec),
                environment: {},
              });
              yield* routes.awaitReady(identity.teamId);
              const socket = new PermissionSocketClient();
              yield* startSocketModeAdapter({
                client: socket,
                routeDirectory: routes,
              });
              socket.emit(
                socketActivationEnvelope({
                  ack: () => Promise.resolve(),
                  channelId: "C249CANCEL",
                  eventId: "event:249:post-cancel",
                  messageTs: "249.102",
                  teamId: identity.teamId,
                  text: "<@U249LABORER> inspect terminal execution",
                  threadTs: "249.100",
                  userId: "U249HUMAN",
                })
              );
              yield* waitForMessageCount(messages, 3);
              assert.strictEqual(
                messages[2]?.text,
                "The implementation remains cancelled and its worktree is preserved."
              );
            })
          );
          yield* waitForProcessExit(secondProcess.pid);

          const afterRestart = JSON.parse(
            yield* Effect.promise(() =>
              readFile(paths.applicationState, "utf8")
            )
          ) as typeof cancelledState;
          assert.strictEqual(afterRestart.executions[0]?.status, "cancelled");
          assert.strictEqual(
            afterRestart.executions[0]?.events.filter(
              ({ source }) => source === "execution-control"
            ).length,
            1
          );
          assert.strictEqual(implementation.interrupts, 1);
          assert.deepStrictEqual(artifactCalls, {
            branches: 1,
            worktrees: 1,
          });
          assert.strictEqual(
            yield* Effect.promise(() => readFile(worktreeMarker, "utf8")),
            "preserve this work"
          );
          const prompts = yield* readJsonLines(firstProcess.prompts);
          assert.strictEqual(
            prompts.filter(
              (entry) =>
                typeof entry === "object" &&
                entry !== null &&
                "prompt" in entry &&
                typeof entry.prompt === "string" &&
                entry.prompt.includes('source="execution-control"')
            ).length,
            1
          );
          const methods = yield* Schema.decodeUnknownEffect(
            Schema.Array(SessionMethod)
          )(yield* readJsonLines(firstProcess.methods));
          assert.deepStrictEqual(
            methods.map(({ method }) => method),
            ["session/new", "session/resume"]
          );
          const publicText = JSON.stringify(messages);
          for (const secret of [
            actionInput.prompt,
            root,
            yield* Effect.promise(() => readFile(executionIdPath, "utf8")),
          ]) {
            assert.ok(!publicText.includes(secret));
          }
        })
      ),
    30_000
  );

  it.live(
    "runs Socket Mode through the generated bug Action and mediates its terminal result privately",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-248-production-bug-action-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-248-production-bug-controls-"
          );
          yield* writeAcpLaborerConfig(root);
          const processPaths = scriptedProcessPaths(
            controls,
            "bug-action-scene"
          );
          const artifactCalls = { branches: 0, worktrees: 0 };
          const implementation = {
            acquisitions: 0,
            agent: null,
            finalizations: 0,
            prompts: 0,
            responses: false,
          } satisfies NonNullable<StartedWorkspaceSpec["implementation"]>;
          const implementationAcquisitions = { count: 0 };
          const actionInput = {
            prompt: "PRIVATE BUG PROMPT MUST NOT REACH SLACK 248",
            worktreeName: "full-bug-action-248",
          };
          const actionResultPath = join(controls, "bug-action-results.json");
          const spec: StartedWorkspaceSpec = {
            artifactCalls,
            environment: scriptedEnvironment(processPaths, {
              SCRIPTED_ACP_ACTION_NAME: "deal-with-bug",
              SCRIPTED_ACP_ACTION_OPERATION_JSON: JSON.stringify(actionInput),
              SCRIPTED_ACP_ACTION_RESULT_PATH: actionResultPath,
              SCRIPTED_ACP_SCENARIO: "action",
            }),
            health: [],
            identity: {
              botId: "B248BUGACTION",
              botUserId: "U248LABORER",
              teamId: "T248BUGACTION",
            },
            implementation,
            messages: [],
            reactions: [],
            token: ["x", "oxb", "-248-bug-action"].join(""),
          };
          const routes = yield* startSlackWorkspaceDirectory({
            adapter: makeStartedDirectoryAdapter(
              [spec],
              implementationAcquisitions
            ),
            config: {
              appToken: Redacted.make(["x", "app", "-248-bug-action"].join("")),
              installations: [installationFor(spec, 0, root)],
              startupMode: "multi-workspace",
            },
            environment: {},
          });
          yield* routes.awaitReady(spec.identity.teamId);
          const socket = new PermissionSocketClient();
          yield* startSocketModeAdapter({
            client: socket,
            routeDirectory: routes,
          });
          socket.emit(
            socketActivationEnvelope({
              ack: () => Promise.resolve(),
              channelId: "C248BUGACTION",
              eventId: "event:248:bug-action",
              messageTs: "248.100",
              teamId: spec.identity.teamId,
              text: "<@U248LABORER> diagnose this regression",
              userId: "U248HUMAN",
            })
          );
          yield* waitForMessageCount(spec.messages, 2);

          assert.deepStrictEqual(
            spec.messages.map(({ text }) => text),
            ["I started the bug fix.", "Implementation finished successfully."]
          );
          assert.deepStrictEqual(artifactCalls, { branches: 1, worktrees: 1 });
          assert.strictEqual(implementation.acquisitions, 1);
          assert.strictEqual(implementation.prompts, 1);
          const paths = yield* prepareSlackRuntimePaths(
            root,
            spec.identity.teamId
          );
          const state = JSON.parse(
            yield* Effect.promise(() =>
              readFile(paths.applicationState, "utf8")
            )
          ) as {
            readonly actionOperations: readonly {
              readonly actionName: string;
            }[];
            readonly executions: readonly {
              readonly actionName: string;
              readonly events: readonly {
                readonly source: string;
                readonly status: string;
              }[];
            }[];
          };
          assert.strictEqual(state.actionOperations.length, 1);
          assert.strictEqual(
            state.actionOperations[0]?.actionName,
            "deal-with-bug"
          );
          assert.strictEqual(state.executions.length, 1);
          assert.strictEqual(state.executions[0]?.actionName, "deal-with-bug");
          const actionResults = yield* Schema.decodeUnknownEffect(
            BugActionInvocationResults,
            { onExcessProperty: "error" }
          )(
            JSON.parse(
              yield* Effect.promise(() => readFile(actionResultPath, "utf8"))
            )
          );
          assert.strictEqual(actionResults.actionName, "deal-with-bug");
          assert.strictEqual(actionResults.first.actionName, "deal-with-bug");
          assert.strictEqual(actionResults.first.deduplicated, false);
          assert.strictEqual(actionResults.first.status, "running");
          assert.strictEqual(
            actionResults.duplicate.actionName,
            "deal-with-bug"
          );
          assert.strictEqual(actionResults.duplicate.deduplicated, true);
          assert.ok(
            actionResults.duplicate.status === "running" ||
              actionResults.duplicate.status === "completed"
          );
          assert.strictEqual(
            actionResults.duplicate.executionId,
            actionResults.first.executionId
          );
          assert.strictEqual(
            state.executions[0]?.events.filter(
              ({ source, status }) =>
                source === "action-terminal" && status === "accepted"
            ).length,
            1
          );
          const prompts = (yield* Effect.promise(() =>
            readFile(processPaths.prompts, "utf8")
          ))
            .trim()
            .split("\n")
            .map(
              (line) =>
                JSON.parse(line) as {
                  readonly prompt: string;
                  readonly sessionId: string;
                }
            );
          assert.strictEqual(
            new Set(prompts.map(({ sessionId }) => sessionId)).size,
            1
          );
          assert.ok(
            prompts.some(({ prompt }) =>
              prompt.includes('source="action-terminal"')
            )
          );
          const publicText = JSON.stringify(spec.messages);
          for (const privateValue of [
            actionInput.prompt,
            root,
            "ACTION RAW TOOL OUTPUT MUST REMAIN PRIVATE 246",
            "execution:",
          ]) {
            assert.ok(!publicText.includes(privateValue));
          }
        })
      ),
    20_000
  );

  it.live(
    "recovers an Action after implementation start and delivers one terminal wake to the same ACP session",
    () =>
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped(
          "laborer-246-production-action-restart-"
        );
        const controls = yield* makeTempDirectoryScoped(
          "laborer-246-production-action-restart-controls-"
        );
        yield* writeAcpLaborerConfig(root);
        const firstProcess = scriptedProcessPaths(
          controls,
          "action-restart-first"
        );
        const secondProcess = firstProcess;
        const identity: SlackRuntimeIdentity = {
          botId: "B246ACTIONRESTART",
          botUserId: "U246LABORER",
          teamId: "T246ACTIONRESTART",
        };
        const token = ["x", "oxb", "-246-action-restart"].join("");
        const messages: CapturedSlackMessage[] = [];
        const reactions: CapturedSlackApiCall[] = [];
        const artifactCalls = { branches: 0, worktrees: 0 };
        const implementation: NonNullable<
          StartedWorkspaceSpec["implementation"]
        > = {
          acquisitions: 0,
          agent: null,
          finalizations: 0,
          prompts: 0,
          responses: false,
          wait: Effect.never,
        };
        const implementationAcquisitions = { count: 0 };
        const actionInput = {
          prompt: "PRIVATE RESTART FEATURE PROMPT 246",
          worktreeName: "restart-action-246",
        };
        const makeSpec = (
          processPaths: ScriptedProcessPaths
        ): StartedWorkspaceSpec => ({
          artifactCalls,
          environment: scriptedEnvironment(processPaths, {
            SCRIPTED_ACP_ACTION_OPERATION_JSON: JSON.stringify(actionInput),
            SCRIPTED_ACP_SCENARIO: "action",
          }),
          health: [],
          identity,
          implementation,
          messages,
          reactions,
          token,
        });
        const configFor = (spec: StartedWorkspaceSpec): SlackDaemonConfig => ({
          appToken: Redacted.make(["x", "app", "-246-action-restart"].join("")),
          installations: [installationFor(spec, 0, root)],
          startupMode: "multi-workspace",
        });

        const firstSpec = makeSpec(firstProcess);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const routes = yield* startSlackWorkspaceDirectory({
              adapter: makeStartedDirectoryAdapter(
                [firstSpec],
                implementationAcquisitions
              ),
              config: configFor(firstSpec),
              environment: {},
            });
            yield* routes.awaitReady(identity.teamId);
            const socket = new PermissionSocketClient();
            yield* startSocketModeAdapter({
              client: socket,
              routeDirectory: routes,
            });
            socket.emit(
              socketActivationEnvelope({
                ack: () => Promise.resolve(),
                channelId: "C246ACTIONRESTART",
                eventId: "event:246:action-restart",
                messageTs: "246.150",
                teamId: identity.teamId,
                text: "<@U246LABORER> implement restart-safe feature",
                userId: "U246HUMAN",
              })
            );
            yield* waitForMessageCount(messages, 1);
            for (
              let attempt = 0;
              attempt < 200 && implementation.prompts === 0;
              attempt += 1
            ) {
              yield* Effect.sleep("5 millis");
            }
            assert.strictEqual(implementation.prompts, 1);
            const runtimePaths = yield* prepareSlackRuntimePaths(
              root,
              identity.teamId
            );
            let promptCommitted = false;
            for (let attempt = 0; attempt < 200; attempt += 1) {
              const state = JSON.parse(
                yield* Effect.promise(() =>
                  readFile(runtimePaths.applicationState, "utf8")
                )
              ) as {
                readonly conversations: readonly {
                  readonly agentSessionBinding: {
                    readonly initializationPhase: string;
                  } | null;
                  readonly prompts: readonly { readonly status: string }[];
                }[];
              };
              promptCommitted =
                state.conversations[0]?.agentSessionBinding
                  ?.initializationPhase === "initialized" &&
                state.conversations[0]?.prompts[0]?.status === "completed";
              if (promptCommitted) {
                break;
              }
              yield* Effect.sleep("5 millis");
            }
            assert.strictEqual(promptCommitted, true);
          })
        );
        yield* waitForProcessExit(firstProcess.pid);

        implementation.wait = Effect.void;
        implementation.responses = true;
        const secondSpec = makeSpec(secondProcess);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const routes = yield* startSlackWorkspaceDirectory({
              adapter: makeStartedDirectoryAdapter(
                [secondSpec],
                implementationAcquisitions
              ),
              config: configFor(secondSpec),
              environment: {},
            });
            yield* routes.awaitReady(identity.teamId);
            yield* waitForMessageCount(messages, 3);
          })
        );

        assert.deepStrictEqual(
          messages.map(({ text }) => text),
          [
            "I started the feature implementation.",
            "The implementation update is ready for review.",
            "Implementation finished successfully.",
          ]
        );
        assert.deepStrictEqual(artifactCalls, { branches: 1, worktrees: 1 });
        assert.strictEqual(implementation.prompts, 1);
        const paths = yield* prepareSlackRuntimePaths(root, identity.teamId);
        const state = JSON.parse(
          yield* Effect.promise(() => readFile(paths.applicationState, "utf8"))
        ) as {
          readonly actionOperations: readonly unknown[];
          readonly executions: readonly {
            readonly events: readonly {
              readonly eventId: string;
              readonly source: string;
            }[];
          }[];
        };
        assert.strictEqual(state.actionOperations.length, 1);
        assert.strictEqual(
          state.executions[0]?.events.filter(
            ({ source }) => source === "action-terminal"
          ).length,
          1
        );
        const prompts = (yield* Effect.promise(() =>
          readFile(firstProcess.prompts, "utf8")
        ))
          .trim()
          .split("\n")
          .map(
            (line) =>
              JSON.parse(line) as {
                readonly prompt: string;
                readonly sessionId: string;
              }
          );
        assert.strictEqual(
          new Set(prompts.map(({ sessionId }) => sessionId)).size,
          1
        );
        assert.strictEqual(
          prompts.filter(({ prompt }) =>
            prompt.includes('source="action-terminal"')
          ).length,
          1
        );
      }).pipe(Effect.scoped),
    30_000
  );

  it.live(
    "returns a stable sanitized ACP response for a real Action MCP worktree collision",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-246-production-action-collision-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-246-production-action-collision-controls-"
          );
          yield* writeAcpLaborerConfig(root);
          const processPaths = scriptedProcessPaths(
            controls,
            "action-collision"
          );
          const artifactCalls = { branches: 0, worktrees: 0 };
          const implementation = {
            acquisitions: 0,
            agent: null,
            finalizations: 0,
            prompts: 0,
          } satisfies NonNullable<StartedWorkspaceSpec["implementation"]>;
          const implementationAcquisitions = { count: 0 };
          const actionInput = {
            prompt: "PRIVATE COLLISION FEATURE PROMPT 246",
            worktreeName: "already-owned-246",
          };
          const spec: StartedWorkspaceSpec = {
            artifactCalls,
            environment: scriptedEnvironment(processPaths, {
              SCRIPTED_ACP_ACTION_EXPECT_FAILURE: "1",
              SCRIPTED_ACP_ACTION_OPERATION_JSON: JSON.stringify(actionInput),
              SCRIPTED_ACP_SCENARIO: "action",
            }),
            health: [],
            identity: {
              botId: "B246ACTIONCOLLISION",
              botUserId: "U246LABORER",
              teamId: "T246ACTIONCOLLISION",
            },
            implementation,
            messages: [],
            reactions: [],
            token: ["x", "oxb", "-246-action-collision"].join(""),
            worktreeCollision: true,
          };
          const routes = yield* startSlackWorkspaceDirectory({
            adapter: makeStartedDirectoryAdapter(
              [spec],
              implementationAcquisitions
            ),
            config: {
              appToken: Redacted.make(
                ["x", "app", "-246-action-collision"].join("")
              ),
              installations: [installationFor(spec, 0, root)],
              startupMode: "multi-workspace",
            },
            environment: {},
          });
          yield* routes.awaitReady(spec.identity.teamId);
          const socket = new PermissionSocketClient();
          yield* startSocketModeAdapter({
            client: socket,
            routeDirectory: routes,
          });
          socket.emit(
            socketActivationEnvelope({
              ack: () => Promise.resolve(),
              channelId: "C246ACTIONCOLLISION",
              eventId: "event:246:action-collision",
              messageTs: "246.175",
              teamId: spec.identity.teamId,
              text: "<@U246LABORER> use the occupied worktree",
              userId: "U246HUMAN",
            })
          );
          yield* waitForMessageCount(spec.messages, 1);

          assert.deepStrictEqual(
            spec.messages.map(({ text }) => text),
            [
              "I couldn't start the feature because that worktree name is unavailable.",
            ]
          );
          assert.deepStrictEqual(artifactCalls, { branches: 0, worktrees: 0 });
          assert.strictEqual(implementation.acquisitions, 0);
          assert.strictEqual(implementation.prompts, 0);
          const paths = yield* prepareSlackRuntimePaths(
            root,
            spec.identity.teamId
          );
          const state = JSON.parse(
            yield* Effect.promise(() =>
              readFile(paths.applicationState, "utf8")
            )
          ) as {
            readonly actionOperationTombstones: readonly {
              readonly failureCode: string;
              readonly ownerScopeDigest: string;
              readonly state: string;
            }[];
            readonly actionOperations: readonly unknown[];
            readonly executions: readonly unknown[];
          };
          assert.strictEqual(state.executions.length, 0);
          assert.strictEqual(state.actionOperations.length, 0);
          assert.strictEqual(state.actionOperationTombstones.length, 1);
          assert.ok(state.actionOperationTombstones[0]?.ownerScopeDigest);
          assert.strictEqual(
            state.actionOperationTombstones[0]?.failureCode,
            "worktree-name-collision"
          );
          assert.strictEqual(
            state.actionOperationTombstones[0]?.state,
            "failed"
          );
          const capabilityState = JSON.parse(
            yield* Effect.promise(() =>
              readFile(paths.acpActionAuthorityState, "utf8")
            )
          ) as {
            readonly records: readonly {
              readonly failureCode: string | null;
              readonly result: unknown;
            }[];
          };
          assert.strictEqual(
            capabilityState.records[0]?.failureCode,
            "action-invocation-failed"
          );
          assert.strictEqual(capabilityState.records[0]?.result, null);
          const publicTranscript = JSON.stringify(spec.messages);
          assert.ok(!publicTranscript.includes(actionInput.prompt));
          assert.ok(!publicTranscript.includes(root));
          assert.ok(!publicTranscript.includes("worktree name already exists"));
          assert.ok(!publicTranscript.includes("ACTION RAW TOOL OUTPUT"));
        })
      ),
    20_000
  );

  it.live(
    "cancels the durable permission request when the ACP child is lost",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-245-process-loss-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-245-process-loss-controls-"
          );
          yield* writeAcpLaborerConfig(root);
          const processPaths = scriptedProcessPaths(controls, "process-loss");
          const implementationAcquisitions = { count: 0 };
          const spec: StartedWorkspaceSpec = {
            environment: scriptedEnvironment(processPaths, {
              SCRIPTED_ACP_PERMISSION_RAW_INPUT_JSON: JSON.stringify({
                command: "process-loss-secret-245",
              }),
              SCRIPTED_ACP_PERMISSION_RESULT_PATH: join(
                controls,
                "unreachable-permission-result.json"
              ),
              SCRIPTED_ACP_PERMISSION_TITLE: "process loss private title",
              SCRIPTED_ACP_PERMISSION_TOOL_KIND: "execute",
            }),
            health: [],
            identity: {
              botId: "B245PROCESSLOSS",
              botUserId: "U245LABORER",
              teamId: "T245PROCESSLOSS",
            },
            messages: [],
            reactions: [],
            token: ["x", "oxb", "-245-process-loss"].join(""),
          };
          const routes = yield* startSlackWorkspaceDirectory({
            adapter: makeStartedDirectoryAdapter(
              [spec],
              implementationAcquisitions
            ),
            config: {
              appToken: Redacted.make(
                ["x", "app", "-245-process-loss"].join("")
              ),
              installations: [installationFor(spec, 0, root)],
              startupMode: "multi-workspace",
            },
            environment: {},
          });
          const installation = yield* routes.awaitReady(spec.identity.teamId);
          assert.ok(installation.runner !== undefined);
          const socket = new PermissionSocketClient();
          yield* startSocketModeAdapter({
            client: socket,
            routeDirectory: routes,
          });
          let activationAcknowledged = false;
          socket.emit(
            socketActivationEnvelope({
              ack: () => {
                activationAcknowledged = true;
                return Promise.resolve();
              },
              channelId: "C245PROCESSLOSS",
              eventId: "event:245:process-loss",
              messageTs: "245.650",
              teamId: spec.identity.teamId,
              text: "<@U245LABORER> guarded process loss",
              userId: "U245AUTHORIZED",
            })
          );
          yield* waitForReactionMethod(spec.reactions, "chat.postMessage");
          assert.ok(activationAcknowledged);
          const pid = Number(
            yield* Effect.promise(() => readFile(processPaths.pid, "utf8"))
          );
          yield* Effect.sync(() => process.kill(pid, "SIGKILL"));
          const runtimePaths = yield* prepareSlackRuntimePaths(
            root,
            spec.identity.teamId
          );
          yield* waitForAuthoritySettlement(runtimePaths.acpAuthorityState);
          const publicTranscript = JSON.stringify(spec.messages);
          assert.ok(!publicTranscript.includes("process-loss-secret-245"));
          assert.ok(!publicTranscript.includes("process loss private title"));
          assert.strictEqual(implementationAcquisitions.count, 0);
        })
      ),
    20_000
  );

  // These Socket Mode permission scenes are load-sensitive: the expiry
  // scene's short permission window sits behind a full workspace boot whose
  // supervisor retries amplify contention delay, and the shutdown scene
  // asserts a 2s wall-clock bound that discriminates against waiting on a
  // hung child. Both opt back out of suite-level concurrency so they
  // measure the runtime instead of worker load.
  describe.sequential("Socket Mode permission scenes", () => {
    it.live(
      "expires an unanswered production permission initiated through Socket Mode",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const root = yield* makeTempDirectoryScoped(
              "laborer-245-permission-timeout-"
            );
            const controls = yield* makeTempDirectoryScoped(
              "laborer-245-permission-timeout-controls-"
            );
            yield* writeAcpLaborerConfig(root);
            const processPaths = scriptedProcessPaths(
              controls,
              "permission-timeout"
            );
            const permissionResultPath = join(
              controls,
              "permission-timeout-result.json"
            );
            const implementationAcquisitions = { count: 0 };
            const spec: StartedWorkspaceSpec = {
              environment: scriptedEnvironment(processPaths, {
                SCRIPTED_ACP_PERMISSION_RAW_INPUT_JSON: JSON.stringify({
                  command: "timeout-private-command-245",
                }),
                SCRIPTED_ACP_PERMISSION_RESULT_PATH: permissionResultPath,
                SCRIPTED_ACP_PERMISSION_TITLE: "timeout private title 245",
                SCRIPTED_ACP_PERMISSION_TOOL_KIND: "execute",
              }),
              health: [],
              identity: {
                botId: "B245TIMEOUT",
                botUserId: "U245LABORER",
                teamId: "T245TIMEOUT",
              },
              messages: [],
              permissionTimeoutMillis: 100,
              reactions: [],
              token: ["x", "oxb", "-245-timeout"].join(""),
            };
            const routes = yield* startSlackWorkspaceDirectory({
              adapter: makeStartedDirectoryAdapter(
                [spec],
                implementationAcquisitions
              ),
              config: {
                appToken: Redacted.make(["x", "app", "-245-timeout"].join("")),
                installations: [installationFor(spec, 0, root)],
                startupMode: "multi-workspace",
              },
              environment: {},
            });
            yield* routes.awaitReady(spec.identity.teamId);
            const socket = new PermissionSocketClient();
            yield* startSocketModeAdapter({
              client: socket,
              routeDirectory: routes,
            });
            let activationAcknowledged = false;
            socket.emit(
              socketActivationEnvelope({
                ack: () => {
                  activationAcknowledged = true;
                  return Promise.resolve();
                },
                channelId: "C245TIMEOUT",
                eventId: "event:245:permission-timeout",
                messageTs: "245.675",
                teamId: spec.identity.teamId,
                text: "<@U245LABORER> guarded timeout operation",
                userId: "U245AUTHORIZED",
              })
            );
            yield* waitForFile(permissionResultPath);
            yield* waitForReactionMethod(spec.reactions, "chat.update");
            assert.ok(activationAcknowledged);
            assert.deepStrictEqual(
              JSON.parse(
                yield* Effect.promise(() =>
                  readFile(permissionResultPath, "utf8")
                )
              ),
              { outcome: { outcome: "cancelled" } }
            );
            const publicTranscript = JSON.stringify(spec.reactions);
            assert.ok(publicTranscript.includes("expired"));
            assert.ok(
              !publicTranscript.includes("timeout-private-command-245")
            );
            assert.ok(!publicTranscript.includes("timeout private title 245"));
            assert.strictEqual(implementationAcquisitions.count, 0);
          })
        ),
      20_000
    );

    it.live(
      "cancels an actual Socket Mode permission promptly while its Slack post remains unresolved",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const root = yield* makeTempDirectoryScoped(
              "laborer-245-permission-cancel-"
            );
            const controls = yield* makeTempDirectoryScoped(
              "laborer-245-permission-cancel-controls-"
            );
            yield* writeAcpLaborerConfig(root);
            const processPaths = scriptedProcessPaths(controls, "cancel-post");
            const permissionResultPath = join(
              controls,
              "cancel-post-result.json"
            );
            let releasePost: (() => void) | undefined;
            const postGate = new Promise<void>((resolvePost) => {
              releasePost = resolvePost;
            });
            let permissionBroker: AcpPermissionBroker | undefined;
            const implementationAcquisitions = { count: 0 };
            const spec: StartedWorkspaceSpec = {
              beforePermissionPost: () => postGate,
              environment: scriptedEnvironment(processPaths, {
                SCRIPTED_ACP_PERMISSION_RAW_INPUT_JSON: JSON.stringify({
                  command: "cancel-private-command-245",
                }),
                SCRIPTED_ACP_PERMISSION_RESULT_PATH: permissionResultPath,
                SCRIPTED_ACP_PERMISSION_TITLE: "cancel private title 245",
                SCRIPTED_ACP_PERMISSION_TOOL_KIND: "execute",
              }),
              health: [],
              identity: {
                botId: "B245CANCELPOST",
                botUserId: "U245LABORER",
                teamId: "T245CANCELPOST",
              },
              messages: [],
              observePermissionBroker: (broker) => {
                permissionBroker = broker;
              },
              reactions: [],
              token: ["x", "oxb", "-245-cancel-post"].join(""),
            };
            const routes = yield* startSlackWorkspaceDirectory({
              adapter: makeStartedDirectoryAdapter(
                [spec],
                implementationAcquisitions
              ),
              config: {
                appToken: Redacted.make(
                  ["x", "app", "-245-cancel-post"].join("")
                ),
                installations: [installationFor(spec, 0, root)],
                startupMode: "multi-workspace",
              },
              environment: {},
            });
            yield* routes.awaitReady(spec.identity.teamId);
            const socket = new PermissionSocketClient();
            yield* startSocketModeAdapter({
              client: socket,
              routeDirectory: routes,
            });
            socket.emit(
              socketActivationEnvelope({
                ack: () => Promise.resolve(),
                channelId: "C245CANCELPOST",
                eventId: "event:245:cancel-post",
                messageTs: "245.680",
                teamId: spec.identity.teamId,
                text: "<@U245LABORER> guarded cancellation operation",
                userId: "U245AUTHORIZED",
              })
            );
            yield* waitForReactionMethod(spec.reactions, "chat.postMessage");
            assert.ok(permissionBroker !== undefined);
            yield* permissionBroker.cancelAll;
            yield* waitForFile(permissionResultPath);
            assert.deepStrictEqual(
              JSON.parse(
                yield* Effect.promise(() =>
                  readFile(permissionResultPath, "utf8")
                )
              ),
              { outcome: { outcome: "cancelled" } }
            );
            const runtimePaths = yield* prepareSlackRuntimePaths(
              root,
              spec.identity.teamId
            );
            yield* waitForAuthoritySettlement(runtimePaths.acpAuthorityState);
            releasePost?.();
            yield* waitForReactionMethod(spec.reactions, "chat.update");
            const transcript = JSON.stringify(spec.reactions);
            assert.ok(transcript.includes("cancelled"));
            assert.ok(!transcript.includes("cancel-private-command-245"));
            assert.ok(!transcript.includes("cancel private title 245"));
            assert.strictEqual(implementationAcquisitions.count, 0);
          })
        ),
      20_000
    );

    it.live(
      "settles an unresolved Socket Mode permission when the production workspace scope closes",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const root = yield* makeTempDirectoryScoped(
              "laborer-245-permission-shutdown-"
            );
            const controls = yield* makeTempDirectoryScoped(
              "laborer-245-permission-shutdown-controls-"
            );
            yield* writeAcpLaborerConfig(root);
            const processPaths = scriptedProcessPaths(
              controls,
              "shutdown-post"
            );
            const permissionResultPath = join(
              controls,
              "shutdown-post-result.json"
            );
            let releasePost: (() => void) | undefined;
            const postGate = new Promise<void>((resolvePost) => {
              releasePost = resolvePost;
            });
            const implementationAcquisitions = { count: 0 };
            const spec: StartedWorkspaceSpec = {
              beforePermissionPost: () => postGate,
              environment: scriptedEnvironment(processPaths, {
                SCRIPTED_ACP_PERMISSION_RESULT_PATH: permissionResultPath,
                SCRIPTED_ACP_PERMISSION_TITLE: "shutdown private title 245",
                SCRIPTED_ACP_PERMISSION_TOOL_KIND: "execute",
              }),
              health: [],
              identity: {
                botId: "B245SHUTDOWNPOST",
                botUserId: "U245LABORER",
                teamId: "T245SHUTDOWNPOST",
              },
              messages: [],
              reactions: [],
              token: ["x", "oxb", "-245-shutdown-post"].join(""),
            };
            const workspaceScope = yield* Scope.make();
            const routes = yield* startSlackWorkspaceDirectory({
              adapter: makeStartedDirectoryAdapter(
                [spec],
                implementationAcquisitions
              ),
              config: {
                appToken: Redacted.make(
                  ["x", "app", "-245-shutdown-post"].join("")
                ),
                installations: [installationFor(spec, 0, root)],
                startupMode: "multi-workspace",
              },
              environment: {},
            }).pipe(Effect.provideService(Scope.Scope, workspaceScope));
            yield* routes.awaitReady(spec.identity.teamId);
            const socket = new PermissionSocketClient();
            yield* startSocketModeAdapter({
              client: socket,
              routeDirectory: routes,
            }).pipe(Effect.provideService(Scope.Scope, workspaceScope));
            socket.emit(
              socketActivationEnvelope({
                ack: () => Promise.resolve(),
                channelId: "C245SHUTDOWNPOST",
                eventId: "event:245:shutdown-post",
                messageTs: "245.685",
                teamId: spec.identity.teamId,
                text: "<@U245LABORER> guarded shutdown operation",
                userId: "U245AUTHORIZED",
              })
            );
            yield* waitForReactionMethod(spec.reactions, "chat.postMessage");
            const shutdownStartedAt = Date.now();
            yield* Scope.close(workspaceScope, Exit.void);
            assert.ok(Date.now() - shutdownStartedAt < 2000);
            yield* waitForFile(permissionResultPath);
            assert.deepStrictEqual(
              JSON.parse(
                yield* Effect.promise(() =>
                  readFile(permissionResultPath, "utf8")
                )
              ),
              { outcome: { outcome: "cancelled" } }
            );
            releasePost?.();
            yield* waitForReactionMethod(spec.reactions, "chat.update");
            assert.ok(JSON.stringify(spec.reactions).includes("cancelled"));
            const runtimePaths = yield* prepareSlackRuntimePaths(
              root,
              spec.identity.teamId
            );
            yield* waitForAuthoritySettlement(runtimePaths.acpAuthorityState);
          })
        ),
      20_000
    );
  });

  it.live(
    "routes a real interactive envelope to the active ACP request and completes allow and reject turns",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          for (const decision of [
            {
              actionId: "laborer_permission_allow_once",
              expectedOptionId: "scripted-allow-once",
              name: "allow",
            },
            {
              actionId: "laborer_permission_reject_once",
              expectedOptionId: "scripted-reject-once",
              name: "reject",
            },
          ]) {
            const root = yield* makeTempDirectoryScoped(
              `laborer-245-${decision.name}-`
            );
            const controls = yield* makeTempDirectoryScoped(
              `laborer-245-${decision.name}-controls-`
            );
            yield* writeAcpLaborerConfig(root);
            const paths = scriptedProcessPaths(controls, decision.name);
            const permissionResultPath = join(
              controls,
              `${decision.name}-permission.json`
            );
            yield* Effect.promise(() =>
              writeFile(paths.release, "release", { mode: 0o600 })
            );
            const rawSecret =
              "https://user:password@example.test/private?token=secret-245";
            const implementationAcquisitions = { count: 0 };
            const terminalPublished = yield* Deferred.make<void>();
            const releaseLiveCompletion = yield* Deferred.make<void>();
            yield* Effect.addFinalizer(() =>
              Deferred.succeed(releaseLiveCompletion, undefined).pipe(
                Effect.asVoid
              )
            );
            const spec: StartedWorkspaceSpec = {
              environment: scriptedEnvironment(paths, {
                SCRIPTED_ACP_PERMISSION_RAW_INPUT_JSON: JSON.stringify({
                  command: rawSecret,
                }),
                SCRIPTED_ACP_PERMISSION_RESULT_PATH: permissionResultPath,
                SCRIPTED_ACP_PERMISSION_TITLE: "private permission title 245",
                SCRIPTED_ACP_PERMISSION_TOOL_KIND: "execute",
              }),
              health: [],
              identity: {
                botId: `B245${decision.name.toUpperCase()}`,
                botUserId: "U245LABORER",
                teamId: `T245${decision.name.toUpperCase()}`,
              },
              messages: [],
              permissionBrokerTestHooks: {
                afterTerminalPublishBeforeLiveCompletion: () =>
                  Effect.gen(function* () {
                    yield* Deferred.succeed(terminalPublished, undefined);
                    yield* Deferred.await(releaseLiveCompletion);
                  }),
              },
              reactions: [],
              token: ["x", "oxb", `-245-${decision.name}`].join(""),
            };
            const routes = yield* startSlackWorkspaceDirectory({
              adapter: makeStartedDirectoryAdapter(
                [spec],
                implementationAcquisitions
              ),
              config: {
                appToken: Redacted.make(
                  ["x", "app", `-245-${decision.name}`].join("")
                ),
                installations: [installationFor(spec, 0, root)],
                startupMode: "multi-workspace",
              },
              environment: {},
            });
            const installation = yield* routes.awaitReady(spec.identity.teamId);
            assert.ok(installation.runner !== undefined);
            const socket = new PermissionSocketClient();
            yield* startSocketModeAdapter({
              client: socket,
              routeDirectory: routes,
            });
            let activationAcknowledged = false;
            socket.emit(
              socketActivationEnvelope({
                ack: () => {
                  activationAcknowledged = true;
                  return Promise.resolve();
                },
                channelId: "C245PERMISSION",
                eventId: `event:245:${decision.name}`,
                messageTs: "245.700",
                teamId: spec.identity.teamId,
                text: "<@U245LABORER> guarded operation",
                userId: "U245AUTHORIZED",
              })
            );
            yield* waitForReactionMethod(spec.reactions, "chat.postMessage");
            assert.ok(activationAcknowledged);
            const post = spec.reactions.find(
              ({ method }) => method === "chat.postMessage"
            );
            assert.ok(post !== undefined);
            const capability = permissionCapabilityFrom(post);
            if (decision.name === "allow") {
              let invalidAcknowledgements = 0;
              const acknowledgeInvalid = (): Promise<void> => {
                invalidAcknowledgements += 1;
                return Promise.resolve();
              };
              const invalidInteractions: readonly {
                readonly capability?: string;
                readonly channelId?: string;
                readonly messageTs?: string;
                readonly rootTs?: string;
                readonly teamId?: string;
                readonly userId?: string;
              }[] = [
                { userId: "U245OTHER" },
                { channelId: "C245OTHER" },
                { rootTs: "245.999" },
                { messageTs: "permission-message-245-other" },
                { teamId: "T245OTHER" },
                { capability: "stale-session-capability" },
              ];
              for (const [index, invalid] of invalidInteractions.entries()) {
                socket.emit(
                  socketPermissionEnvelope({
                    ack: acknowledgeInvalid,
                    actionId: decision.actionId,
                    capability: invalid.capability ?? capability,
                    channelId: invalid.channelId,
                    envelopeId: `envelope-245-invalid-${index}`,
                    messageTs: invalid.messageTs,
                    rootTs: invalid.rootTs,
                    teamId: invalid.teamId ?? spec.identity.teamId,
                    userId: invalid.userId,
                  })
                );
              }
              for (let attempt = 0; attempt < 200; attempt += 1) {
                if (invalidAcknowledgements === 6) {
                  break;
                }
                yield* Effect.promise(
                  () => new Promise<void>((resolve) => setTimeout(resolve, 5))
                );
              }
              assert.strictEqual(invalidAcknowledgements, 6);
              assert.strictEqual(
                yield* Effect.promise(() =>
                  stat(permissionResultPath).then(
                    () => true,
                    () => false
                  )
                ),
                false
              );
            }
            let acknowledged = false;
            socket.emit(
              socketPermissionEnvelope({
                ack: () => {
                  acknowledged = true;
                  return Promise.resolve();
                },
                actionId: decision.actionId,
                capability,
                envelopeId: `envelope-245-${decision.name}`,
                teamId: spec.identity.teamId,
              })
            );
            const didPublishTerminal = yield* Effect.raceFirst(
              Deferred.await(terminalPublished).pipe(Effect.as(true)),
              Effect.sleep("3 seconds").pipe(Effect.as(false))
            );
            if (!didPublishTerminal) {
              const runtimePaths = yield* prepareSlackRuntimePaths(
                root,
                spec.identity.teamId
              );
              const authority = yield* Effect.promise(() =>
                readFile(runtimePaths.acpAuthorityState, "utf8")
              );
              return yield* Effect.die(
                new Error(`terminal publication hook was absent: ${authority}`)
              );
            }
            for (let attempt = 0; attempt < 100; attempt += 1) {
              if (acknowledged) {
                break;
              }
              yield* Effect.promise(
                () => new Promise<void>((resolve) => setTimeout(resolve, 5))
              );
            }
            assert.ok(acknowledged);
            assert.strictEqual(
              yield* Effect.promise(() =>
                stat(permissionResultPath).then(
                  () => true,
                  () => false
                )
              ),
              false
            );
            let inFlightRetryAcknowledged = false;
            socket.emit(
              socketPermissionEnvelope({
                ack: () => {
                  inFlightRetryAcknowledged = true;
                  return Promise.resolve();
                },
                actionId: decision.actionId,
                capability,
                envelopeId: `envelope-245-${decision.name}-in-flight-retry`,
                teamId: spec.identity.teamId,
              })
            );
            for (let attempt = 0; attempt < 100; attempt += 1) {
              if (inFlightRetryAcknowledged) {
                break;
              }
              yield* Effect.promise(
                () => new Promise<void>((resolve) => setTimeout(resolve, 5))
              );
            }
            assert.ok(inFlightRetryAcknowledged);
            yield* Deferred.succeed(releaseLiveCompletion, undefined);
            yield* waitForFile(permissionResultPath);
            yield* waitForReactionMethod(spec.reactions, "chat.update");
            assert.deepStrictEqual(
              JSON.parse(
                yield* Effect.promise(() =>
                  readFile(permissionResultPath, "utf8")
                )
              ),
              {
                outcome: {
                  optionId: decision.expectedOptionId,
                  outcome: "selected",
                },
              }
            );
            let replayAcknowledged = false;
            socket.emit(
              socketPermissionEnvelope({
                ack: () => {
                  replayAcknowledged = true;
                  return Promise.resolve();
                },
                actionId: decision.actionId,
                capability,
                envelopeId: `envelope-245-${decision.name}-replay`,
                teamId: spec.identity.teamId,
              })
            );
            for (let attempt = 0; attempt < 200; attempt += 1) {
              if (replayAcknowledged) {
                break;
              }
              yield* Effect.promise(
                () => new Promise<void>((resolve) => setTimeout(resolve, 5))
              );
            }
            assert.ok(replayAcknowledged);
            assert.strictEqual(
              spec.reactions.filter(({ method }) => method === "chat.update")
                .length,
              1
            );
            const publicPayload = [
              ...new URLSearchParams(post.body).values(),
            ].join("\n");
            assert.ok(publicPayload.includes("Allow once"));
            assert.ok(publicPayload.includes("Reject"));
            assert.ok(!publicPayload.includes("Always allow"));
            assert.ok(!publicPayload.includes(rawSecret));
            assert.ok(!publicPayload.includes("private permission title"));
            const runtimePaths = yield* prepareSlackRuntimePaths(
              root,
              spec.identity.teamId
            );
            const authorityState = yield* Effect.promise(() =>
              readFile(runtimePaths.acpAuthorityState, "utf8")
            );
            assert.ok(!authorityState.includes(rawSecret));
            assert.ok(!authorityState.includes(capability));
            assert.strictEqual(implementationAcquisitions.count, 0);
          }
        })
      ),
    30_000
  );

  it.live(
    "drives context, FIFO turns, reactions, streaming, and isolated sessions through a started route",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-244-started-route-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-244-started-route-controls-"
          );
          yield* writeAcpLaborerConfig(root);
          yield* Effect.promise(() =>
            writeFile(join(root, "SOUL.md"), "Started route Soul", {
              mode: 0o600,
            })
          );
          const processPaths = scriptedProcessPaths(controls, "started-route");
          const messages: CapturedSlackMessage[] = [];
          const reactions: CapturedSlackApiCall[] = [];
          const implementationAcquisitions = { count: 0 };
          const artifactCalls = { branches: 0, worktrees: 0 };
          const spec: StartedWorkspaceSpec = {
            artifactCalls,
            context: [
              historicalContext(
                "C244ROUTE",
                "U244HISTORY",
                "nonempty historical context"
              ),
            ],
            environment: scriptedEnvironment(processPaths, {
              ...Object.fromEntries(
                ROUTE_FORBIDDEN_ENVIRONMENT_NAMES.map((name) => [
                  name,
                  `forbidden-${name}`,
                ])
              ),
              [SAFE_SLACK_METADATA_NAME]: "T244ROUTE",
            }),
            health: [],
            identity: {
              botId: "B244ROUTE",
              botUserId: "U244LABORER",
              teamId: "T244ROUTE",
            },
            messages,
            reactions,
            token: ["x", "oxb", "-244-route"].join(""),
          };
          const routes = yield* startSlackWorkspaceDirectory({
            adapter: makeStartedDirectoryAdapter(
              [spec],
              implementationAcquisitions
            ),
            config: {
              appToken: Redacted.make(["x", "app", "-244-route"].join("")),
              installations: [installationFor(spec, 0, root)],
              startupMode: "multi-workspace",
            },
            environment: {},
            prepareRoot: (binding, environment) =>
              prepareSlackWorkspaceRoot(binding, environment).pipe(
                Effect.map((prepared) => {
                  const configuredApplication =
                    prepared.laborer.config.application;
                  if (configuredApplication === undefined) {
                    throw new Error("started route application is missing");
                  }
                  return {
                    ...prepared,
                    laborer: {
                      ...prepared.laborer,
                      config: {
                        ...prepared.laborer.config,
                        application: {
                          ...configuredApplication,
                          environment: [
                            ...PROCESS_ENVIRONMENT_NAMES,
                            ...ROUTE_FORBIDDEN_ENVIRONMENT_NAMES,
                            SAFE_SLACK_METADATA_NAME,
                          ],
                        },
                      },
                    },
                  };
                })
              ),
          });
          const installation = yield* routes.awaitReady(spec.identity.teamId);
          const runner = installation.runner;
          assert.ok(runner !== undefined);
          const first = yield* runner
            .inject(
              normalizedEvent({
                authorSlackId: "U244HUMAN",
                channelId: "C244ROUTE",
                eventId: "event:244:route:first",
                messageTs: "244.100",
                text: "<@U244LABORER> first blocked route turn",
              })
            )
            .pipe(Effect.forkChild);
          yield* waitForFile(processPaths.ready);
          yield* waitForMessageCount(messages, 1);
          assert.strictEqual(messages[0]?.text, "**Streaming** from ACP");
          const second = yield* runner
            .inject(
              normalizedEvent({
                authorSlackId: "U244HUMAN",
                channelId: "C244ROUTE",
                eventId: "event:244:route:second",
                messageTs: "244.101",
                text: "second queued route turn",
                threadTs: "244.100",
              })
            )
            .pipe(Effect.forkChild);
          yield* Effect.sleep("50 millis");
          assert.strictEqual(
            (yield* readJsonLines(processPaths.prompts)).length,
            1
          );
          yield* Effect.promise(() =>
            writeFile(processPaths.release, "release", { mode: 0o600 })
          );
          yield* Fiber.join(first);
          yield* Fiber.join(second);
          yield* runner.inject(
            normalizedEvent({
              authorSlackId: "U244OTHER",
              channelId: "C244ROUTE",
              eventId: "event:244:route:other-thread",
              messageTs: "244.200",
              text: "<@U244LABORER> independent thread",
            })
          );

          const prompts = (yield* readJsonLines(processPaths.prompts)) as {
            readonly prompt: string;
            readonly sessionId: string;
          }[];
          assert.strictEqual(prompts.length, 3);
          assert.strictEqual(prompts[0]?.sessionId, prompts[1]?.sessionId);
          assert.notStrictEqual(prompts[0]?.sessionId, prompts[2]?.sessionId);
          assert.ok(prompts[0]?.prompt.includes("nonempty historical context"));
          assert.ok(prompts[0]?.prompt.includes("first blocked route turn"));
          assert.ok(prompts[0]?.prompt.includes("Started route Soul"));
          assert.ok(
            prompts[0]?.prompt.includes("T244ROUTE:U244HISTORY:visible")
          );
          assert.deepStrictEqual(
            messages.map(({ text }) => text),
            [EXPECTED_MARKDOWN, EXPECTED_MARKDOWN, EXPECTED_MARKDOWN]
          );
          assert.strictEqual(implementationAcquisitions.count, 0);
          assert.deepStrictEqual(artifactCalls, { branches: 0, worktrees: 0 });
          assert.strictEqual(
            (yield* readJsonLines(processPaths.methods)).length,
            2
          );
          assert.strictEqual(
            (yield* readJsonLines(processPaths.launch)).length,
            1
          );
          const launch = yield* Schema.decodeUnknownEffect(FakeLaunch)(
            JSON.parse(
              yield* Effect.promise(() => readFile(processPaths.launch, "utf8"))
            ) as unknown
          );
          assert.ok(launch.environmentNames.includes(SAFE_SLACK_METADATA_NAME));
          assert.deepStrictEqual(
            launch.environmentNames.filter((name) =>
              ROUTE_FORBIDDEN_ENVIRONMENT_NAMES.some(
                (forbidden) => forbidden.toLowerCase() === name.toLowerCase()
              )
            ),
            []
          );
          const reactionTranscript = reactions.map(
            ({ body, method }) => `${method}:${body}`
          );
          assert.ok(
            reactionTranscript.some((entry) =>
              entry.includes("hourglass_flowing_sand")
            )
          );
          assert.ok(
            reactionTranscript.some((entry) =>
              entry.includes("white_check_mark")
            )
          );
          assert.ok(
            reactions.some(({ method }) => method === "reactions.remove")
          );
          assert.ok(
            reactions.every(({ method }) => method !== "chat.postMessage")
          );

          const paths = yield* prepareSlackRuntimePaths(
            root,
            spec.identity.teamId
          );
          for (const directory of [
            paths.root,
            dirname(paths.runnerState),
            paths.workThreads,
          ]) {
            assert.strictEqual(
              (yield* Effect.promise(() => stat(directory))).mode % 512,
              0o700
            );
          }
          for (const file of [paths.applicationState, paths.runnerState]) {
            assert.strictEqual(
              (yield* Effect.promise(() => stat(file))).mode % 512,
              0o600
            );
          }
          const applicationState = JSON.parse(
            yield* Effect.promise(() =>
              readFile(paths.applicationState, "utf8")
            )
          ) as { readonly executions: readonly unknown[] };
          assert.deepStrictEqual(applicationState.executions, []);
          assert.deepStrictEqual(
            yield* Effect.promise(() => readdir(paths.workThreads)),
            []
          );
        })
      ),
    30_000
  );

  it.live(
    "sanitizes ACP failures through a started route without legacy fallback",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-244-started-failure-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-244-started-failure-controls-"
          );
          yield* writeAcpLaborerConfig(root);
          const processPaths = scriptedProcessPaths(controls, "failure-route");
          yield* Effect.promise(() =>
            writeFile(processPaths.release, "release", { mode: 0o600 })
          );
          const implementationAcquisitions = { count: 0 };
          const spec: StartedWorkspaceSpec = {
            environment: scriptedEnvironment(processPaths, {
              SCRIPTED_ACP_SCENARIO: "failure",
            }),
            health: [],
            identity: {
              botId: "B244FAILURE",
              botUserId: "U244LABORER",
              teamId: "T244FAILURE",
            },
            messages: [],
            reactions: [],
            token: ["x", "oxb", "-244-failure"].join(""),
          };
          const routes = yield* startSlackWorkspaceDirectory({
            adapter: makeStartedDirectoryAdapter(
              [spec],
              implementationAcquisitions
            ),
            config: {
              appToken: Redacted.make(["x", "app", "-244-failure"].join("")),
              installations: [installationFor(spec, 0, root)],
              startupMode: "multi-workspace",
            },
            environment: {},
          });
          const installation = yield* routes.awaitReady(spec.identity.teamId);
          assert.ok(installation.runner !== undefined);
          yield* installation.runner.inject(
            normalizedEvent({
              authorSlackId: "U244HUMAN",
              channelId: "C244FAILURE",
              eventId: "event:244:failure",
              messageTs: "244.300",
              text: "<@U244LABORER> fail safely",
            })
          );

          assert.deepStrictEqual(
            spec.messages.map(({ text }) => text),
            [EXPECTED_BLOCKED_NOTICE]
          );
          const publicTranscript = JSON.stringify(spec.messages);
          assert.ok(
            !publicTranscript.includes("ACP FAILURE DIAGNOSTIC SECRET")
          );
          assert.ok(!publicTranscript.includes("ACP STDERR SECRET"));
          assert.strictEqual(implementationAcquisitions.count, 0);
          yield* waitForReactionMethod(spec.reactions, "reactions.remove");
          const reactionTranscript = spec.reactions.map(
            ({ body, method }) => `${method}:${body}`
          );
          assert.ok(
            reactionTranscript.some((entry) =>
              entry.includes("hourglass_flowing_sand")
            )
          );
          assert.ok(
            spec.reactions.some(({ method }) => method === "reactions.remove")
          );
          assert.ok(
            reactionTranscript.every(
              (entry) => !entry.includes("white_check_mark")
            )
          );
        })
      ),
    // This scene spawns several real children; under a busy parallel gate the
    // whole file can take more than a minute, so give the single scene the
    // same slack as the heaviest scenes instead of racing host load.
    60_000
  );

  it.live(
    "keeps the lazy implementation agent available after actual route construction",
    () =>
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped(
          "laborer-244-route-implementation-"
        );
        const controls = yield* makeTempDirectoryScoped(
          "laborer-244-route-implementation-controls-"
        );
        yield* writeAcpLaborerConfig(root);
        const processPaths = scriptedProcessPaths(
          controls,
          "route-implementation"
        );
        yield* Effect.promise(() =>
          writeFile(processPaths.release, "release", { mode: 0o600 })
        );
        const implementation = {
          acquisitions: 0,
          agent: null as ImplementationAgentShape | null,
          finalizations: 0,
          prompts: 0,
        };
        const implementationAcquisitions = { count: 0 };
        const responses: string[] = [];
        const spec: StartedWorkspaceSpec = {
          environment: scriptedEnvironment(processPaths),
          health: [],
          identity: {
            botId: "B244IMPLEMENTATION",
            botUserId: "U244LABORER",
            teamId: "T244IMPLEMENTATION",
          },
          implementation,
          messages: [],
          reactions: [],
          token: ["x", "oxb", "-244-implementation"].join(""),
        };

        yield* Effect.scoped(
          Effect.gen(function* () {
            const routes = yield* startSlackWorkspaceDirectory({
              adapter: makeStartedDirectoryAdapter(
                [spec],
                implementationAcquisitions
              ),
              config: {
                appToken: Redacted.make(
                  ["x", "app", "-244-implementation"].join("")
                ),
                installations: [installationFor(spec, 0, root)],
                startupMode: "multi-workspace",
              },
              environment: {},
            });
            const installation = yield* routes.awaitReady(spec.identity.teamId);
            assert.ok(installation.runner !== undefined);
            yield* installation.runner.inject(
              normalizedEvent({
                authorSlackId: "U244HUMAN",
                channelId: "C244IMPLEMENTATION",
                eventId: "event:244:implementation:ordinary",
                messageTs: "244.350",
                text: "<@U244LABORER> ordinary conversation only",
              })
            );
            assert.strictEqual(implementation.acquisitions, 0);
            assert.strictEqual(implementationAcquisitions.count, 0);
            const implementationAgent = implementation.agent;
            assert.ok(implementationAgent !== null);
            const session = yield* implementationAgent.start(
              {
                actionName: "create-feature",
                conversationId: "conversation:244:explicit-implementation",
                executionId: "execution:244:explicit-implementation",
                implementationSessionId: "session:244:explicit-implementation",
                prompt: "Run one explicit implementation",
                promptId: "prompt:244:explicit-implementation",
                workingDirectory: root,
              },
              ({ text }) =>
                Effect.sync(() => {
                  responses.push(text);
                })
            );
            yield* session.completion;
            assert.strictEqual(implementation.acquisitions, 1);
            assert.strictEqual(implementationAcquisitions.count, 1);
            assert.strictEqual(implementation.prompts, 1);
            assert.deepStrictEqual(responses, [
              "explicit implementation completed",
            ]);
            assert.strictEqual(implementation.finalizations, 0);
          })
        );
        assert.strictEqual(implementation.finalizations, 1);
        yield* waitForProcessExit(processPaths.pid);
      }).pipe(Effect.scoped),
    20_000
  );

  it.live(
    "reconstructs a complete started directory and resumes the opaque session without replay",
    () =>
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped(
          "laborer-244-directory-restart-"
        );
        const controls = yield* makeTempDirectoryScoped(
          "laborer-244-directory-restart-controls-"
        );
        yield* writeAcpLaborerConfig(root);
        const firstProcess = scriptedProcessPaths(controls, "restart-first");
        const secondProcess = {
          ...scriptedProcessPaths(controls, "restart-second"),
          durableSessions: firstProcess.durableSessions,
          methods: firstProcess.methods,
          prompts: firstProcess.prompts,
          release: firstProcess.release,
        };
        yield* Effect.promise(() =>
          writeFile(firstProcess.release, "release", { mode: 0o600 })
        );
        const messages: CapturedSlackMessage[] = [];
        const implementationAcquisitions = { count: 0 };
        const identity: SlackRuntimeIdentity = {
          botId: "B244RESTART",
          botUserId: "U244LABORER",
          teamId: "T244RESTART",
        };
        const token = ["x", "oxb", "-244-restart"].join("");
        const firstSpec: StartedWorkspaceSpec = {
          environment: scriptedEnvironment(firstProcess, {
            SCRIPTED_ACP_EFFECTIVE_CONFIG_JSON: effectiveConfigJson({
              effort: "high",
              mode: "build",
              model: "configured/model-a",
            }),
          }),
          health: [],
          identity,
          messages,
          reactions: [],
          token,
        };
        const configFor = (spec: StartedWorkspaceSpec): SlackDaemonConfig => ({
          appToken: Redacted.make(["x", "app", "-244-restart"].join("")),
          installations: [installationFor(spec, 0, root)],
          startupMode: "multi-workspace",
        });

        yield* Effect.scoped(
          Effect.gen(function* () {
            const routes = yield* startSlackWorkspaceDirectory({
              adapter: makeStartedDirectoryAdapter(
                [firstSpec],
                implementationAcquisitions
              ),
              config: configFor(firstSpec),
              environment: {},
            });
            const installation = yield* routes.awaitReady(identity.teamId);
            assert.ok(installation.runner !== undefined);
            yield* installation.runner.inject(
              normalizedEvent({
                authorSlackId: "U244HUMAN",
                channelId: "C244RESTART",
                eventId: "event:244:restart:first",
                messageTs: "244.400",
                text: "<@U244LABORER> fallback boundary before restart",
              })
            );
          })
        );
        yield* waitForProcessExit(firstProcess.pid);
        const paths = yield* prepareSlackRuntimePaths(root, identity.teamId);
        const afterNew = JSON.parse(
          yield* Effect.promise(() => readFile(paths.applicationState, "utf8"))
        ) as {
          readonly conversations: readonly {
            readonly agentSessionBinding: {
              readonly effectiveMetadata: {
                readonly effort: string | null;
                readonly mode: string | null;
                readonly model: string | null;
              } | null;
              readonly effectiveMetadataFingerprint: string | null;
            } | null;
          }[];
        };
        const newBinding = afterNew.conversations[0]?.agentSessionBinding;
        assert.strictEqual(
          newBinding?.effectiveMetadata?.model,
          "configured/model-a"
        );
        assert.strictEqual(newBinding?.effectiveMetadata?.effort, "high");
        assert.strictEqual(newBinding?.effectiveMetadata?.mode, "build");
        const firstFingerprint = newBinding?.effectiveMetadataFingerprint;
        assert.ok(firstFingerprint !== null && firstFingerprint !== undefined);

        const secondSpec: StartedWorkspaceSpec = {
          environment: scriptedEnvironment(secondProcess, {
            SCRIPTED_ACP_EFFECTIVE_CONFIG_JSON: effectiveConfigJson({
              effort: "low",
              mode: "plan",
              model: "configured/model-b",
            }),
          }),
          health: [],
          identity,
          messages,
          reactions: [],
          token,
        };
        yield* Effect.scoped(
          Effect.gen(function* () {
            const routes = yield* startSlackWorkspaceDirectory({
              adapter: makeStartedDirectoryAdapter(
                [secondSpec],
                implementationAcquisitions
              ),
              config: configFor(secondSpec),
              environment: {},
            });
            const installation = yield* routes.awaitReady(identity.teamId);
            assert.ok(installation.runner !== undefined);
            yield* installation.runner.inject(
              normalizedEvent({
                authorSlackId: "U244HUMAN",
                channelId: "C244RESTART",
                eventId: "event:244:restart:follow-up",
                messageTs: "244.401",
                text: "native boundary after restart",
                threadTs: "244.400",
              })
            );
            yield* waitForMessageCount(messages, 2);
          })
        );
        yield* waitForProcessExit(secondProcess.pid);
        const afterResume = JSON.parse(
          yield* Effect.promise(() => readFile(paths.applicationState, "utf8"))
        ) as typeof afterNew;
        const resumedBinding =
          afterResume.conversations[0]?.agentSessionBinding;
        assert.strictEqual(
          resumedBinding?.effectiveMetadata?.model,
          "configured/model-b"
        );
        assert.strictEqual(resumedBinding?.effectiveMetadata?.effort, "low");
        assert.strictEqual(resumedBinding?.effectiveMetadata?.mode, "plan");
        assert.notStrictEqual(
          resumedBinding?.effectiveMetadataFingerprint,
          firstFingerprint
        );
        assert.ok(
          !JSON.stringify(afterResume).includes("provider-secret-value")
        );

        const methods = yield* Schema.decodeUnknownEffect(
          Schema.Array(SessionMethod)
        )(yield* readJsonLines(firstProcess.methods));
        assert.deepStrictEqual(
          methods.map(({ method }) => method),
          ["session/new", "session/resume"]
        );
        const prompts = (yield* readJsonLines(firstProcess.prompts)) as {
          readonly prompt: string;
          readonly sessionId: string;
        }[];
        assert.strictEqual(prompts[0]?.sessionId, prompts[1]?.sessionId);
        assert.strictEqual(methods[1]?.params.sessionId, prompts[0]?.sessionId);
        assert.deepStrictEqual(
          messages.map(({ text }) => text),
          [EXPECTED_MARKDOWN, EXPECTED_MARKDOWN]
        );
        assert.ok(
          messages.every(
            ({ text }) => !text.includes("HISTORICAL OUTPUT MUST NOT REPLAY")
          )
        );
        assert.strictEqual(implementationAcquisitions.count, 0);
      }).pipe(Effect.scoped),
    30_000
  );

  it.live(
    "isolates two authenticated workspaces through one actual started directory",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-244-directory-multi-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-244-directory-multi-controls-"
          );
          yield* writeAcpLaborerConfig(root);
          yield* Effect.promise(() =>
            writeFile(join(root, "SOUL.md"), "Shared production Soul", {
              mode: 0o600,
            })
          );
          const firstProcess = scriptedProcessPaths(controls, "multi-first");
          const secondProcess = scriptedProcessPaths(controls, "multi-second");
          yield* Effect.promise(() =>
            Promise.all([
              writeFile(firstProcess.release, "release", { mode: 0o600 }),
              writeFile(secondProcess.release, "release", { mode: 0o600 }),
            ])
          );
          const first: StartedWorkspaceSpec = {
            context: [
              historicalContext(
                "C244SAME",
                "U244HUMAN",
                "first workspace history"
              ),
            ],
            environment: scriptedEnvironment(firstProcess, {
              SCRIPTED_ACP_PUBLIC_OUTPUT_LABEL: "first workspace output",
              SCRIPTED_ACP_SESSION_ID_PREFIX: "first-workspace-session",
            }),
            health: [],
            identity: {
              botId: "B244FIRST",
              botUserId: "U244LABORER",
              teamId: "T244FIRST",
            },
            messages: [],
            reactions: [],
            token: ["x", "oxb", "-244-first"].join(""),
          };
          const second: StartedWorkspaceSpec = {
            context: [
              historicalContext(
                "C244SAME",
                "U244HUMAN",
                "second workspace history"
              ),
            ],
            environment: scriptedEnvironment(secondProcess, {
              SCRIPTED_ACP_DISABLE_PROMPT_MARKER: undefined,
              SCRIPTED_ACP_PUBLIC_OUTPUT_LABEL: "second workspace output",
              SCRIPTED_ACP_SESSION_ID_PREFIX: "second-workspace-session",
              SCRIPTED_ACP_AGENT_NAME: "StableNativeAgent",
            }),
            health: [],
            identity: {
              botId: "B244SECOND",
              botUserId: "U244LABORER",
              teamId: "T244SECOND",
            },
            messages: [],
            reactions: [],
            token: ["x", "oxb", "-244-second"].join(""),
            treatCommandAsOpenCode: false,
          };
          const implementationAcquisitions = { count: 0 };
          const routes = yield* startSlackWorkspaceDirectory({
            adapter: makeStartedDirectoryAdapter(
              [first, second],
              implementationAcquisitions
            ),
            config: {
              appToken: Redacted.make(["x", "app", "-244-multi"].join("")),
              installations: [
                installationFor(first, 0, root),
                installationFor(second, 1, root),
              ],
              startupMode: "multi-workspace",
            },
            environment: {},
          });
          const firstInstallation = yield* routes.awaitReady(
            first.identity.teamId
          );
          const secondInstallation = yield* routes.awaitReady(
            second.identity.teamId
          );
          assert.ok(firstInstallation.runner !== undefined);
          assert.ok(secondInstallation.runner !== undefined);
          const firstPaths = yield* prepareSlackRuntimePaths(
            root,
            first.identity.teamId
          );
          const secondPaths = yield* prepareSlackRuntimePaths(
            root,
            second.identity.teamId
          );
          const firstContext = yield* prepareAcpAgentContextSources({
            root,
            workspaceId: first.identity.teamId,
          });
          const secondContext = yield* prepareAcpAgentContextSources({
            root,
            workspaceId: second.identity.teamId,
          });
          yield* Effect.promise(() =>
            Promise.all([
              mkdir(firstContext.userProfilesDirectory, { mode: 0o700 }),
              mkdir(secondContext.userProfilesDirectory, { mode: 0o700 }),
            ])
          );
          yield* Effect.promise(() =>
            Promise.all([
              writeFile(
                firstContext.workspaceMemoryPath,
                "first workspace memory",
                { mode: 0o600 }
              ),
              writeFile(
                secondContext.workspaceMemoryPath,
                "second workspace memory",
                { mode: 0o600 }
              ),
              writeFile(
                userProfilePath(firstContext, "U244HUMAN"),
                "first user profile",
                { mode: 0o600 }
              ),
              writeFile(
                userProfilePath(secondContext, "U244HUMAN"),
                "second user profile",
                { mode: 0o600 }
              ),
            ])
          );
          const sameEvent = {
            authorSlackId: "U244HUMAN",
            channelId: "C244SAME",
            messageTs: "244.500",
            text: "<@U244LABORER> identical workspace request",
          } as const;
          yield* Effect.all([
            firstInstallation.runner.inject(
              normalizedEvent({
                ...sameEvent,
                eventId: "event:244:multi:first",
              })
            ),
            secondInstallation.runner.inject(
              normalizedEvent({
                ...sameEvent,
                eventId: "event:244:multi:second",
              })
            ),
          ]);

          const firstPrompt = (yield* readJsonLines(
            firstProcess.prompts
          ))[0] as {
            readonly prompt: string;
            readonly sessionId: string;
          };
          const secondPrompt = (yield* readJsonLines(
            secondProcess.prompts
          ))[0] as {
            readonly prompt: string;
            readonly sessionId: string;
          };
          assert.notStrictEqual(firstPrompt.sessionId, secondPrompt.sessionId);
          for (const expected of [
            "Shared production Soul",
            "first workspace history",
            "first workspace memory",
            "first user profile",
            "T244FIRST:U244HUMAN:visible",
          ]) {
            assert.ok(firstPrompt.prompt.includes(expected), expected);
          }
          for (const expected of [
            "Shared production Soul",
            "second workspace history",
            "second workspace memory",
            "second user profile",
            "T244SECOND:U244HUMAN:visible",
          ]) {
            assert.ok(secondPrompt.prompt.includes(expected), expected);
          }
          assert.deepStrictEqual(
            first.messages.map(({ text }) => text),
            ["first workspace output complete"]
          );
          assert.deepStrictEqual(
            second.messages.map(({ text }) => text),
            ["second workspace output complete"]
          );
          assert.notStrictEqual(
            firstPaths.runnerState,
            secondPaths.runnerState
          );
          assert.notStrictEqual(
            firstPaths.applicationState,
            secondPaths.applicationState
          );
          const firstState = JSON.parse(
            yield* Effect.promise(() =>
              readFile(firstPaths.applicationState, "utf8")
            )
          ) as {
            readonly conversations: readonly {
              readonly agentSessionBinding: {
                readonly sessionId: string;
              } | null;
            }[];
          };
          const secondState = JSON.parse(
            yield* Effect.promise(() =>
              readFile(secondPaths.applicationState, "utf8")
            )
          ) as {
            readonly conversations: readonly {
              readonly agentSessionBinding: {
                readonly sessionId: string;
              } | null;
            }[];
          };
          assert.strictEqual(
            firstState.conversations[0]?.agentSessionBinding?.sessionId,
            firstPrompt.sessionId
          );
          assert.strictEqual(
            secondState.conversations[0]?.agentSessionBinding?.sessionId,
            secondPrompt.sessionId
          );
          assert.notStrictEqual(
            yield* Effect.promise(() => readFile(firstProcess.pid, "utf8")),
            yield* Effect.promise(() => readFile(secondProcess.pid, "utf8"))
          );
          assert.strictEqual(implementationAcquisitions.count, 0);
        })
      ),
    30_000
  );

  it.effect(
    "surfaces actual root lock denial in legacy and multi-workspace modes",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-244-lock-denial-"
          );
          yield* writeAcpLaborerConfig(root);
          const implementationAcquisitions = { count: 0 };
          const spec: StartedWorkspaceSpec = {
            environment: {},
            health: [],
            identity: {
              botId: "B244LOCKED",
              botUserId: "U244LABORER",
              teamId: "T244LOCKED",
            },
            messages: [],
            reactions: [],
            token: ["x", "oxb", "-244-locked"].join(""),
          };
          const adapter = makeStartedDirectoryAdapter(
            [spec],
            implementationAcquisitions
          );
          const heldPaths = yield* prepareSlackRuntimePaths(root);
          yield* acquireRunnerLock(heldPaths.root, heldPaths.lock);
          const legacy = yield* Effect.result(
            startSlackWorkspaceDirectory({
              adapter,
              config: {
                appToken: Redacted.make(["x", "app", "-244-lock"].join("")),
                installations: [installationFor(spec, 0, root, false)],
                startupMode: "legacy",
              },
              environment: {},
            })
          );
          assert.strictEqual(legacy._tag, "Failure");

          const multi = yield* startSlackWorkspaceDirectory({
            adapter,
            config: {
              appToken: Redacted.make(["x", "app", "-244-lock"].join("")),
              installations: [installationFor(spec, 0, root)],
              startupMode: "multi-workspace",
            },
            environment: {},
          });
          yield* multi.awaitAvailable(spec.identity.teamId);
          assert.strictEqual(
            (yield* multi.resolve(spec.identity.teamId))._tag,
            "Unavailable"
          );
          assert.strictEqual(implementationAcquisitions.count, 0);
        })
      )
  );

  it.live(
    "runs and resumes an ordinary durable Slack Conversation without execution artifacts",
    () =>
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped("laborer-244-production-");
        const controls = yield* makeTempDirectoryScoped(
          "laborer-244-production-controls-"
        );
        const paths = yield* prepareSlackRuntimePaths(root, "T244PRODUCTION");
        const rootRuntime = yield* makeNodeRootDurableRuntime({
          databasePath: paths.runtimeDatabase,
          rootIdentity: root,
        });
        const firstProcess = scriptedProcessPaths(controls, "first");
        const secondProcess = {
          ...scriptedProcessPaths(controls, "second"),
          durableSessions: firstProcess.durableSessions,
          methods: firstProcess.methods,
          prompts: firstProcess.prompts,
          release: firstProcess.release,
        };
        yield* Effect.promise(() =>
          writeFile(firstProcess.release, "release", { mode: 0o600 })
        );
        const messages: CapturedSlackMessage[] = [];
        const health: AcpWorkspaceHealth[] = [];
        const worktreeCalls = { count: 0 };
        const implementationCounters = {
          implementationAcquisitions: 0,
          implementationPrompts: 0,
        };
        const privateValues = Object.fromEntries(
          PRIVATE_ENVIRONMENT_NAMES.map((name) => [name, `secret-${name}`])
        );
        privateValues.OPENCODE_CONFIG_CONTENT = JSON.stringify({
          permission: { bash: "ask" },
        });
        const firstEnvironment = scriptedEnvironment(
          firstProcess,
          privateValues
        );

        yield* Effect.scoped(
          Effect.gen(function* () {
            const production = yield* makeProductionHarness({
              environment: firstEnvironment,
              health,
              implementationCounters,
              messages,
              paths,
              root,
              rootRuntime,
              workspaceId: "T244PRODUCTION",
              worktreeCalls,
            });
            yield* production.harness.runner.inject(
              normalizedEvent({
                authorSlackId: "U244HUMAN",
                channelId: "C244",
                eventId: "event:244:first",
                messageTs: "244.1",
                text: "<@U244LABORER> answer an ordinary question",
              })
            );
            yield* production.harness.runner.inject(
              normalizedEvent({
                authorSlackId: "U244HUMAN",
                channelId: "C244",
                eventId: "event:244:follow-up",
                messageTs: "244.2",
                text: "continue the same conversation",
                threadTs: "244.1",
              })
            );
            assert.strictEqual(
              (yield* production.workspace.health).status,
              "ready"
            );
          })
        );
        yield* waitForProcessExit(firstProcess.pid);
        yield* waitForFile(firstProcess.sessionRemainder);

        yield* Effect.scoped(
          Effect.gen(function* () {
            const production = yield* makeProductionHarness({
              environment: scriptedEnvironment(secondProcess, privateValues),
              health,
              implementationCounters,
              messages,
              paths,
              root,
              rootRuntime,
              workspaceId: "T244PRODUCTION",
              worktreeCalls,
            });
            yield* production.harness.runner.inject(
              normalizedEvent({
                authorSlackId: "U244HUMAN",
                channelId: "C244",
                eventId: "event:244:after-restart",
                messageTs: "244.3",
                text: "continue after restart",
                threadTs: "244.1",
              })
            );
          })
        );
        yield* waitForProcessExit(secondProcess.pid);

        assert.deepStrictEqual(
          messages.map(({ text }) => text),
          [EXPECTED_MARKDOWN, EXPECTED_MARKDOWN, EXPECTED_MARKDOWN]
        );
        assert.ok(
          messages.every(
            ({ text }) => !text.includes("HISTORICAL OUTPUT MUST NOT REPLAY")
          )
        );
        const methods = yield* Schema.decodeUnknownEffect(
          Schema.Array(SessionMethod)
        )(yield* readJsonLines(firstProcess.methods));
        assert.deepStrictEqual(
          methods.map(({ method }) => method),
          ["session/new", "session/resume"]
        );
        assert.strictEqual(methods[0]?.params.sessionId, undefined);
        assert.strictEqual(methods[0]?.params.cwd, root);
        assert.strictEqual(methods[1]?.params.cwd, root);
        assert.ok(typeof methods[1]?.params.sessionId === "string");
        assert.deepStrictEqual(
          stableMcpServers(methods[1]?.params.mcpServers),
          stableMcpServers(methods[0]?.params.mcpServers)
        );
        const memoryEnvironment = stableMcpServers(
          methods[0]?.params.mcpServers
        )[0]?.env;
        assert.ok(
          memoryEnvironment?.some(
            ({ name, value }) =>
              name === "LABORER_MEMORY_ROOT" && value === root
          )
        );
        assert.ok(
          memoryEnvironment?.some(
            ({ name, value }) =>
              name === "LABORER_MEMORY_WORKSPACE_ID" &&
              value === "T244PRODUCTION"
          )
        );
        assert.strictEqual(
          (yield* readJsonLines(firstProcess.prompts)).length,
          3
        );

        const applicationState = JSON.parse(
          yield* Effect.promise(() => readFile(paths.applicationState, "utf8"))
        ) as {
          readonly conversations: readonly {
            readonly agentSessionBinding: { readonly sessionId: string } | null;
          }[];
          readonly executions: readonly unknown[];
        };
        assert.strictEqual(applicationState.conversations.length, 1);
        assert.strictEqual(applicationState.executions.length, 0);
        const runtimeDatabase = new DatabaseSync(paths.runtimeDatabase, {
          readOnly: true,
        });
        try {
          const durableConversations = runtimeDatabase
            .prepare(
              `SELECT conversation_id AS conversationId, workspace_id AS workspaceId
               FROM laborer_conversations`
            )
            .all() as unknown as readonly {
            readonly conversationId: string;
            readonly workspaceId: string;
          }[];
          const durableEvents = runtimeDatabase
            .prepare(
              `SELECT sequence, status
               FROM laborer_conversation_events
               ORDER BY sequence`
            )
            .all() as unknown as readonly {
            readonly sequence: number;
            readonly status: string;
          }[];
          assert.strictEqual(durableConversations.length, 1);
          assert.strictEqual(
            durableConversations[0]?.workspaceId,
            "T244PRODUCTION"
          );
          assert.deepStrictEqual(durableEvents, [
            { sequence: 1, status: "completed" },
            { sequence: 2, status: "completed" },
            { sequence: 3, status: "completed" },
          ]);
        } finally {
          runtimeDatabase.close();
        }
        assert.strictEqual(worktreeCalls.count, 0);
        assert.strictEqual(
          implementationCounters.implementationAcquisitions,
          0
        );
        assert.strictEqual(implementationCounters.implementationPrompts, 0);
        assert.deepStrictEqual(
          health.map(({ status }) => status),
          ["starting", "ready", "closed", "starting", "ready", "closed"]
        );

        const launch = yield* Schema.decodeUnknownEffect(FakeLaunch)(
          JSON.parse(
            yield* Effect.promise(() => readFile(firstProcess.launch, "utf8"))
          ) as unknown
        );
        assert.deepStrictEqual(launch.args, ["acp"]);
        assert.strictEqual(launch.cwd, root);
        assert.ok(launch.environmentNames.includes("OPENAI_API_KEY"));
        assert.deepStrictEqual(
          launch.environmentNames.filter((name) =>
            PRIVATE_ENVIRONMENT_NAMES.some(
              (privateName) => privateName === name
            )
          ),
          []
        );

        const lifecycle = (yield* Effect.promise(() =>
          readFile(firstProcess.lifecycle, "utf8")
        ))
          .split("\n")
          .filter((line) => line.length > 0);
        assert.strictEqual(
          lifecycle.filter((entry) => entry === "stdio:closed").length,
          1
        );
      }).pipe(Effect.scoped),
    30_000
  );

  it.live(
    "restarts an idle ACP child and resumes the same session with the complete MCP catalog",
    () =>
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped(
          "laborer-252-idle-restart-"
        );
        const controls = yield* makeTempDirectoryScoped(
          "laborer-252-idle-restart-controls-"
        );
        const workspaceId = "T252IDLERESTART";
        const paths = yield* prepareSlackRuntimePaths(root, workspaceId);
        const processPaths = scriptedProcessPaths(controls, "idle-restart");
        const triggerPath = join(controls, "idle-exit-trigger");
        const markerPath = join(controls, "idle-exit-marker");
        yield* Effect.promise(() =>
          writeFile(processPaths.release, "release", { mode: 0o600 })
        );
        const messages: CapturedSlackMessage[] = [];
        const health: AcpWorkspaceHealth[] = [];
        const implementationCounters = {
          implementationAcquisitions: 0,
          implementationPrompts: 0,
        };
        yield* Effect.scoped(
          Effect.gen(function* () {
            const production = yield* makeProductionHarness({
              environment: scriptedEnvironment(processPaths, {
                SCRIPTED_ACP_IDLE_EXIT_MARKER_PATH: markerPath,
                SCRIPTED_ACP_IDLE_EXIT_TRIGGER_PATH: triggerPath,
              }),
              health,
              implementationCounters,
              messages,
              paths,
              root,
              workspaceId,
              worktreeCalls: { count: 0 },
            });
            yield* production.harness.runner.inject(
              normalizedEvent({
                authorSlackId: "U252HUMAN",
                channelId: "C252",
                eventId: "event:252:before-exit",
                messageTs: "252.1",
                text: "<@U244LABORER> establish a durable session",
              })
            );
            const firstHealth = yield* production.workspace.health;
            assert.strictEqual(firstHealth.generation, 1);
            yield* Effect.promise(() =>
              writeFile(triggerPath, "exit", { mode: 0o600 })
            );
            yield* waitForFile(markerPath);
            for (let attempt = 0; attempt < 500; attempt += 1) {
              const snapshot = yield* production.workspace.health;
              if (snapshot.health === "ready" && snapshot.generation === 2) {
                break;
              }
              yield* Effect.sleep("10 millis");
            }
            const replacementHealth = yield* production.workspace.health;
            assert.strictEqual(replacementHealth.health, "ready");
            assert.strictEqual(replacementHealth.generation, 2);
            assert.strictEqual(
              replacementHealth.lastStop?.cause,
              "transport_lost"
            );
            assert.strictEqual(replacementHealth.lastStop?.code, 31);
            yield* production.harness.runner.inject(
              normalizedEvent({
                authorSlackId: "U252HUMAN",
                channelId: "C252",
                eventId: "event:252:after-exit",
                messageTs: "252.2",
                text: "continue after the child restart",
                threadTs: "252.1",
              })
            );
          })
        );
        const methods = yield* Schema.decodeUnknownEffect(
          Schema.Array(SessionMethod)
        )(yield* readJsonLines(processPaths.methods));
        assert.deepStrictEqual(
          methods.map(({ method }) => method),
          ["session/new", "session/resume"]
        );
        assert.deepStrictEqual(
          stableMcpServers(methods[1]?.params.mcpServers),
          stableMcpServers(methods[0]?.params.mcpServers)
        );
        assert.deepStrictEqual(
          messages.map(({ text }) => text),
          [EXPECTED_MARKDOWN, EXPECTED_MARKDOWN]
        );
      }).pipe(Effect.scoped),
    30_000
  );

  for (const crashPoint of ["before-output", "after-output"] as const) {
    it.live(
      `keeps a started workspace directory route through an in-prompt ${crashPoint} child exit`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const root = yield* makeTempDirectoryScoped(
              `laborer-252-directory-crash-${crashPoint}-`
            );
            const controls = yield* makeTempDirectoryScoped(
              `laborer-252-directory-crash-${crashPoint}-controls-`
            );
            yield* writeAcpLaborerConfig(root);
            const processPaths = scriptedProcessPaths(
              controls,
              `directory-${crashPoint}`
            );
            const crashMarker = join(controls, `${crashPoint}-claimed`);
            yield* Effect.promise(() =>
              writeFile(processPaths.release, "release", { mode: 0o600 })
            );
            const spec: StartedWorkspaceSpec = {
              environment: scriptedEnvironment(processPaths, {
                ...(crashPoint === "before-output"
                  ? {
                      SCRIPTED_ACP_EXIT_AFTER_PROMPT_RECEIVED: "1",
                      SCRIPTED_ACP_EXIT_AFTER_PROMPT_RECEIVED_MARKER_PATH:
                        crashMarker,
                    }
                  : {
                      SCRIPTED_ACP_EXIT_AFTER_FIRST_PUBLIC_CHUNK: "1",
                      SCRIPTED_ACP_EXIT_AFTER_FIRST_PUBLIC_CHUNK_MARKER_PATH:
                        crashMarker,
                    }),
              }),
              health: [],
              identity: {
                botId: `B252${crashPoint}`,
                botUserId: "U252LABORER",
                teamId: `T252${crashPoint.replace("-", "")}`,
              },
              messages: [],
              reactions: [],
              token: ["x", "oxb", `-252-${crashPoint}`].join(""),
            };
            const routes = yield* startSlackWorkspaceDirectory({
              adapter: makeStartedDirectoryAdapter([spec], { count: 0 }),
              config: {
                appToken: Redacted.make(
                  ["x", "app", `-252-${crashPoint}`].join("")
                ),
                installations: [installationFor(spec, 0, root)],
                startupMode: "multi-workspace",
              },
              environment: {},
            });
            const installation = yield* routes.awaitReady(spec.identity.teamId);
            assert.ok(installation.runner !== undefined);
            const first = yield* Effect.forkChild(
              installation.runner.inject(
                normalizedEvent({
                  authorSlackId: "U252HUMAN",
                  channelId: "C252CRASH",
                  eventId: `event:252:${crashPoint}:first`,
                  messageTs: "252.900",
                  text: "<@U252LABORER> first turn",
                })
              )
            );
            yield* waitForFile(crashMarker);
            const queued = yield* Effect.forkChild(
              installation.runner.inject(
                normalizedEvent({
                  authorSlackId: "U252HUMAN",
                  channelId: "C252CRASH",
                  eventId: `event:252:${crashPoint}:queued`,
                  messageTs: "252.901",
                  text: "<@U252LABORER> queued after process loss",
                })
              )
            );
            yield* Fiber.join(first);
            yield* Fiber.join(queued);
            for (let attempt = 0; attempt < 500; attempt += 1) {
              if (
                spec.health.some(
                  ({ generation, status }) =>
                    generation === 2 && status === "ready"
                )
              ) {
                break;
              }
              yield* Effect.sleep("10 millis");
            }
            assert.ok(
              spec.health.some(
                ({ generation, status }) =>
                  generation === 2 && status === "ready"
              )
            );
            assert.strictEqual(
              (yield* routes.resolve(spec.identity.teamId))._tag,
              "Ready"
            );
            const methods = yield* Schema.decodeUnknownEffect(
              Schema.Array(SessionMethod)
            )(yield* readJsonLines(processPaths.methods));
            assert.deepStrictEqual(
              methods.map(({ method }) => method),
              ["session/new", "session/new"]
            );
            assert.strictEqual(
              (yield* readJsonLines(processPaths.prompts)).length,
              2
            );
            assert.strictEqual(spec.messages.at(-1)?.text, EXPECTED_MARKDOWN);
            assert.ok(
              spec.messages.filter(({ text }) => text === EXPECTED_MARKDOWN)
                .length <= 1
            );
            if (crashPoint === "after-output") {
              assert.ok(
                spec.messages.some(({ text }) => text.includes("Streaming"))
              );
            }
          })
        ),
      30_000
    );
  }

  it.live(
    "isolates same-named threads and all workspace-owned paths under one root",
    () =>
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped("laborer-244-shared-root-");
        const controls = yield* makeTempDirectoryScoped(
          "laborer-244-shared-controls-"
        );
        const firstPaths = yield* prepareSlackRuntimePaths(root, "T244FIRST");
        const secondPaths = yield* prepareSlackRuntimePaths(root, "T244SECOND");
        const firstProcess = scriptedProcessPaths(controls, "workspace-first");
        const secondProcess = scriptedProcessPaths(
          controls,
          "workspace-second"
        );
        yield* Effect.promise(() =>
          Promise.all([
            writeFile(firstProcess.release, "release", { mode: 0o600 }),
            writeFile(secondProcess.release, "release", { mode: 0o600 }),
          ])
        );
        const firstMessages: CapturedSlackMessage[] = [];
        const secondMessages: CapturedSlackMessage[] = [];
        const implementationCounters = {
          implementationAcquisitions: 0,
          implementationPrompts: 0,
        };
        const worktreeCalls = { count: 0 };

        yield* Effect.scoped(
          Effect.gen(function* () {
            const rootRuntime = yield* makeNodeRootDurableRuntime({
              databasePath: firstPaths.runtimeDatabase,
              rootIdentity: root,
            });
            const first = yield* makeProductionHarness({
              environment: scriptedEnvironment(firstProcess),
              health: [],
              implementationCounters,
              messages: firstMessages,
              paths: firstPaths,
              root,
              rootRuntime,
              workspaceId: "T244FIRST",
              worktreeCalls,
            });
            const second = yield* makeProductionHarness({
              environment: scriptedEnvironment(secondProcess),
              health: [],
              implementationCounters,
              messages: secondMessages,
              paths: secondPaths,
              root,
              rootRuntime,
              workspaceId: "T244SECOND",
              worktreeCalls,
            });
            const sameChannelAndRoot = {
              authorSlackId: "U244HUMAN",
              channelId: "C244SAME",
              messageTs: "244.10",
              text: "<@U244LABORER> isolated question",
            } as const;
            yield* Effect.all([
              first.harness.runner.inject(
                normalizedEvent({
                  ...sameChannelAndRoot,
                  eventId: "event:244:first-workspace",
                })
              ),
              second.harness.runner.inject(
                normalizedEvent({
                  ...sameChannelAndRoot,
                  eventId: "event:244:second-workspace",
                })
              ),
            ]);
          })
        );

        assert.deepStrictEqual(
          firstMessages.map(({ text }) => text),
          [EXPECTED_MARKDOWN]
        );
        assert.deepStrictEqual(
          secondMessages.map(({ text }) => text),
          [EXPECTED_MARKDOWN]
        );
        assert.notStrictEqual(firstPaths.runnerState, secondPaths.runnerState);
        assert.notStrictEqual(
          firstPaths.applicationState,
          secondPaths.applicationState
        );
        assert.strictEqual(firstPaths.lock, secondPaths.lock);
        assert.ok(
          firstPaths.applicationState.includes("slack-workspaces/T244FIRST")
        );
        assert.ok(
          secondPaths.applicationState.includes("slack-workspaces/T244SECOND")
        );
        const firstState = JSON.parse(
          yield* Effect.promise(() =>
            readFile(firstPaths.applicationState, "utf8")
          )
        ) as { readonly conversations: readonly unknown[] };
        const secondState = JSON.parse(
          yield* Effect.promise(() =>
            readFile(secondPaths.applicationState, "utf8")
          )
        ) as { readonly conversations: readonly unknown[] };
        assert.strictEqual(firstState.conversations.length, 1);
        assert.strictEqual(secondState.conversations.length, 1);
        assert.strictEqual(
          (yield* readJsonLines(firstProcess.methods)).length,
          1
        );
        assert.strictEqual(
          (yield* readJsonLines(secondProcess.methods)).length,
          1
        );
        assert.notStrictEqual(
          yield* Effect.promise(() => readFile(firstProcess.pid, "utf8")),
          yield* Effect.promise(() => readFile(secondProcess.pid, "utf8"))
        );
        for (const workspaceId of ["T244FIRST", "T244SECOND"]) {
          assert.ok(
            (workspaceId === "T244FIRST"
              ? firstPaths.applicationState
              : secondPaths.applicationState
            ).includes(workspaceId)
          );
          assert.ok(
            join(
              root,
              ".laborer-runtime",
              "slack-workspaces",
              workspaceId,
              "workspace-memory.md"
            ).startsWith(root)
          );
        }
      }).pipe(Effect.scoped),
    30_000
  );

  it.effect(
    "acquires one implementation transport and admits each requested stable prompt",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-244-lazy-implementation-"
          );
          const paths = yield* prepareSlackRuntimePaths(root, "T244LAZY");
          const counters = {
            implementationAcquisitions: 0,
            implementationPrompts: 0,
          };
          const implementationAgent =
            yield* makeLazyOpenCodeImplementationAgent(
              {
                config: applicationConfig,
                environment: {},
                paths,
                root,
              },
              {
                makeOpenCodeClient: () =>
                  Effect.sync(() => {
                    counters.implementationAcquisitions += 1;
                    return makeUnusedImplementationClient(counters);
                  }),
              }
            );
          assert.strictEqual(counters.implementationAcquisitions, 0);

          const start = (suffix: string) =>
            implementationAgent.start(
              {
                actionName: "create-feature",
                conversationId: "conversation:244:lazy",
                executionId: `execution:${suffix}`,
                implementationSessionId: `session:${suffix}`,
                prompt: "Implement the approved change",
                promptId: `prompt:${suffix}`,
                workingDirectory: root,
              },
              () => Effect.void
            );
          yield* start("first");
          yield* start("second");

          assert.strictEqual(counters.implementationAcquisitions, 1);
          assert.strictEqual(counters.implementationPrompts, 2);
        })
      )
  );

  it.effect(
    "shares one interruption-safe implementation acquisition across every handoff boundary",
    () =>
      Effect.forEach(
        ["during-acquisition", "after-acquire", "after-finalizer"] as const,
        (boundary) =>
          Effect.gen(function* () {
            const root = yield* makeTempDirectoryScoped(
              `laborer-244-atomic-${boundary}-`
            );
            const paths = yield* prepareSlackRuntimePaths(root, "T244ATOMIC");
            const reached = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            const ownerScope = yield* Scope.make();
            yield* Effect.addFinalizer((exit) => Scope.close(ownerScope, exit));
            let acquisitions = 0;
            let finalizations = 0;
            const blockAtBoundary = Deferred.succeed(reached, undefined).pipe(
              Effect.andThen(Deferred.await(release))
            );
            const clientResource = Effect.acquireRelease(
              Effect.sync(() => {
                acquisitions += 1;
                return makeUnusedImplementationClient({
                  implementationPrompts: 0,
                });
              }),
              () =>
                Effect.sync(() => {
                  finalizations += 1;
                })
            );
            const implementationAgent =
              yield* makeLazyOpenCodeImplementationAgent(
                {
                  config: applicationConfig,
                  environment: {},
                  paths,
                  root,
                },
                {
                  ...(boundary === "after-acquire"
                    ? {
                        afterImplementationClientAcquired: () =>
                          blockAtBoundary,
                      }
                    : {}),
                  ...(boundary === "after-finalizer"
                    ? {
                        afterImplementationFinalizerRegistered: () =>
                          blockAtBoundary,
                      }
                    : {}),
                  makeOpenCodeClient: () =>
                    boundary === "during-acquisition"
                      ? blockAtBoundary.pipe(Effect.andThen(clientResource))
                      : clientResource,
                }
              ).pipe(Effect.provideService(Scope.Scope, ownerScope));
            const start = (suffix: string) =>
              implementationAgent.start(
                {
                  actionName: "create-feature",
                  conversationId: "conversation:244:atomic",
                  executionId: `execution:${boundary}:${suffix}`,
                  implementationSessionId: `session:${boundary}:${suffix}`,
                  prompt: "Implement atomically",
                  promptId: `prompt:${boundary}:${suffix}`,
                  workingDirectory: root,
                },
                () => Effect.void
              );
            const callers = yield* Effect.forEach(
              ["interrupted", "second", "third"],
              (suffix) => start(suffix).pipe(Effect.forkChild)
            );
            yield* Deferred.await(reached);
            const interruptedCaller = callers[0];
            assert.ok(interruptedCaller !== undefined);
            yield* Fiber.interrupt(interruptedCaller);
            yield* Deferred.succeed(release, undefined);
            yield* Effect.forEach(callers.slice(1), Fiber.join, {
              discard: true,
            });
            yield* start("retry");

            assert.strictEqual(acquisitions, 1, boundary);
            assert.strictEqual(finalizations, 0, boundary);
            yield* Scope.close(ownerScope, Exit.succeed(undefined));
            yield* Scope.close(ownerScope, Exit.succeed(undefined));
            assert.strictEqual(finalizations, 1, boundary);
          }),
        { discard: true }
      ).pipe(Effect.scoped)
  );

  it.effect(
    "interrupts an in-flight implementation acquisition with scoped cleanup",
    () =>
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped(
          "laborer-244-interrupted-acquisition-"
        );
        const paths = yield* prepareSlackRuntimePaths(root, "T244INTERRUPTED");
        const resourceAcquired = yield* Deferred.make<void>();
        const neverComplete = yield* Deferred.make<void>();
        const ownerScope = yield* Scope.make();
        yield* Effect.addFinalizer((exit) => Scope.close(ownerScope, exit));
        let acquisitions = 0;
        let finalizations = 0;
        const implementationAgent = yield* makeLazyOpenCodeImplementationAgent(
          {
            config: applicationConfig,
            environment: {},
            paths,
            root,
          },
          {
            makeOpenCodeClient: () =>
              Effect.acquireRelease(
                Effect.sync(() => {
                  acquisitions += 1;
                  return makeUnusedImplementationClient({
                    implementationPrompts: 0,
                  });
                }),
                () =>
                  Effect.sync(() => {
                    finalizations += 1;
                  })
              ).pipe(
                Effect.tap(() => Deferred.succeed(resourceAcquired, undefined)),
                Effect.tap(() => Deferred.await(neverComplete))
              ),
          }
        ).pipe(Effect.provideService(Scope.Scope, ownerScope));
        const caller = yield* implementationAgent
          .start(
            {
              actionName: "create-feature",
              conversationId: "conversation:244:interrupted-acquisition",
              executionId: "execution:244:interrupted-acquisition",
              implementationSessionId: "session:244:interrupted-acquisition",
              prompt: "Never completes acquisition",
              promptId: "prompt:244:interrupted-acquisition",
              workingDirectory: root,
            },
            () => Effect.void
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(resourceAcquired);
        yield* Scope.close(ownerScope, Exit.succeed(undefined));
        const callerExit = yield* Fiber.await(caller);

        assert.ok(Exit.isFailure(callerExit));
        assert.strictEqual(acquisitions, 1);
        assert.strictEqual(finalizations, 1);
      }).pipe(Effect.scoped)
  );

  it.live(
    "acquires the shared root lock before child startup and quarantines only an incompatible binding",
    () =>
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped("laborer-244-startup-");
        const controls = yield* makeTempDirectoryScoped(
          "laborer-244-startup-controls-"
        );
        yield* Effect.promise(() =>
          writeFile(
            join(root, "laborer.json"),
            JSON.stringify({
              application: {
                environment: [...PROCESS_ENVIRONMENT_NAMES],
                type: "reference-coding",
              },
            })
          )
        );
        const healthyProcess = scriptedProcessPaths(controls, "healthy");
        const incompatibleProcess = scriptedProcessPaths(
          controls,
          "incompatible"
        );
        yield* Effect.promise(() =>
          Promise.all([
            writeFile(healthyProcess.release, "release", { mode: 0o600 }),
            writeFile(incompatibleProcess.release, "release", { mode: 0o600 }),
          ])
        );
        const healthyIdentity: SlackRuntimeIdentity = {
          botId: "B244HEALTHY",
          botUserId: "U244HEALTHY",
          teamId: "T244HEALTHY",
        };
        const incompatibleIdentity: SlackRuntimeIdentity = {
          botId: "B244BAD",
          botUserId: "U244BAD",
          teamId: "T244BAD",
        };
        const healthyToken = ["x", "oxb", "-244-healthy"].join("");
        const incompatibleToken = ["x", "oxb", "-244-incompatible"].join("");
        const config: SlackDaemonConfig = {
          appToken: Redacted.make(["x", "app", "-244"].join("")),
          installations: [
            {
              bindingIndex: 0,
              botToken: Redacted.make(healthyToken),
              botTokenEnvironment: "SLACK_BOT_TOKEN_HEALTHY",
              expectedTeamId: healthyIdentity.teamId,
              namespaceWorkspace: true,
              root,
              tokenIsValid: true,
              validation: { _tag: "Valid" },
            },
            {
              bindingIndex: 1,
              botToken: Redacted.make(incompatibleToken),
              botTokenEnvironment: "SLACK_BOT_TOKEN_INCOMPATIBLE",
              expectedTeamId: incompatibleIdentity.teamId,
              namespaceWorkspace: true,
              root,
              tokenIsValid: true,
              validation: { _tag: "Valid" },
            },
          ],
          startupMode: "multi-workspace",
        };
        const identities = new Map([
          [healthyToken, healthyIdentity],
          [incompatibleToken, incompatibleIdentity],
        ]);
        const order: string[] = [];
        const routeMessages: CapturedSlackMessage[] = [];
        let legacyFallbackAcquisitions = 0;
        const clientIdentities = new Map<WebClient, SlackRuntimeIdentity>();
        const adapter: SlackWorkspaceStartupAdapter<
          WebClient,
          SlackGatewayShape
        > = {
          authenticate: (client) => {
            const identity = clientIdentities.get(client);
            return identity === undefined
              ? Effect.die(new Error("unknown fixture client"))
              : Effect.succeed(identity);
          },
          makeClient: (token) => {
            const identity = identities.get(token);
            if (identity === undefined) {
              throw new Error("unknown fixture token");
            }
            const client = makeFixtureSlackClient();
            clientIdentities.set(client, identity);
            return client;
          },
          makeGateway: () => makeCapturingSlack(routeMessages),
          makeRunner: (runtime) => {
            const isHealthy =
              runtime.identity.teamId === healthyIdentity.teamId;
            const processPaths = isHealthy
              ? healthyProcess
              : incompatibleProcess;
            const childEnvironment = scriptedEnvironment(processPaths, {
              ...(isHealthy
                ? {}
                : { SCRIPTED_ACP_DISABLE_RESUME_CAPABILITY: "1" }),
            });
            return makeAcpSlackWorkspaceRunner(runtime, {
              environment: childEnvironment,
              makeOpenCodeClient: () =>
                Effect.sync(() => {
                  legacyFallbackAcquisitions += 1;
                  return makeUnusedImplementationClient({
                    implementationPrompts: 0,
                  });
                }),
              observeHealth: ({ status, workspaceId }) =>
                order.push(`${workspaceId}:${status}`),
              participantLookup: {
                lookupVisibleName: (slackUserId) => Effect.succeed(slackUserId),
              },
              process: {
                command: fakeOpenCodePath,
                testHooks: { treatCommandAsOpenCode: true },
              },
            });
          },
          makeSetupIncompleteResponder: () => () => Effect.void,
        };
        const routes = yield* startSlackWorkspaceDirectory({
          acquireRootLock: () =>
            Effect.sync(() => {
              order.push("lock");
              return true;
            }),
          adapter,
          config,
          environment: {},
          prepareRoot: (binding, environment) =>
            prepareSlackWorkspaceRoot(binding, environment),
        });
        yield* routes.awaitAvailable(healthyIdentity.teamId);
        yield* routes.awaitAvailable(incompatibleIdentity.teamId);

        assert.strictEqual(
          (yield* routes.resolve(healthyIdentity.teamId))._tag,
          "Ready"
        );
        assert.strictEqual(
          (yield* routes.resolve(incompatibleIdentity.teamId))._tag,
          "Unavailable"
        );
        const healthyInstallation = yield* routes.awaitReady(
          healthyIdentity.teamId
        );
        assert.ok(healthyInstallation.runner !== undefined);
        yield* healthyInstallation.runner.inject(
          normalizedEvent({
            authorSlackId: "U244HUMAN",
            channelId: "C244QUARANTINE",
            eventId: "event:244:quarantine:healthy",
            messageTs: "244.600",
            text: "<@U244HEALTHY> healthy binding still runs",
          })
        );
        assert.deepStrictEqual(
          routeMessages.map(({ text }) => text),
          [EXPECTED_MARKDOWN]
        );
        assert.strictEqual(legacyFallbackAcquisitions, 0);
        assert.strictEqual(order[0], "lock");
        assert.ok(order.includes("T244HEALTHY:ready"));
        assert.ok(order.includes("T244BAD:quarantined"));
        assert.strictEqual(
          (yield* Schema.decodeUnknownEffect(FakeLaunch)(
            JSON.parse(
              yield* Effect.promise(() =>
                readFile(healthyProcess.launch, "utf8")
              )
            ) as unknown
          )).cwd,
          root
        );
      }).pipe(Effect.scoped),
    30_000
  );

  it.live(
    "closes failed binding-local construction scopes while another binding stays ready",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-244-binding-scope-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-244-binding-scope-controls-"
          );
          yield* writeAcpLaborerConfig(root);
          const healthyProcess = scriptedProcessPaths(
            controls,
            "scope-healthy"
          );
          const repositoryProcess = scriptedProcessPaths(
            controls,
            "scope-repository-failure"
          );
          const layerProcess = scriptedProcessPaths(
            controls,
            "scope-layer-failure"
          );
          yield* Effect.promise(() =>
            writeFile(healthyProcess.release, "release", { mode: 0o600 })
          );
          const makeSpec = (
            teamId: string,
            processPaths: ScriptedProcessPaths,
            constructionFailure?: StartedWorkspaceSpec["constructionFailure"]
          ): StartedWorkspaceSpec => ({
            ...(constructionFailure === undefined
              ? {}
              : { constructionFailure }),
            environment: scriptedEnvironment(processPaths),
            health: [],
            identity: {
              botId: `B${teamId.slice(1)}`,
              botUserId: "U244LABORER",
              teamId,
            },
            messages: [],
            reactions: [],
            token: ["x", "oxb", `-${teamId.toLowerCase()}`].join(""),
          });
          const healthy = makeSpec("T244SCOPEOK", healthyProcess);
          const repositoryFailure = makeSpec(
            "T244SCOPEREPO",
            repositoryProcess,
            "repository"
          );
          const layerFailure = makeSpec(
            "T244SCOPELAYER",
            layerProcess,
            "layer"
          );
          const implementationAcquisitions = { count: 0 };
          const specs = [healthy, repositoryFailure, layerFailure] as const;
          const routes = yield* startSlackWorkspaceDirectory({
            adapter: makeStartedDirectoryAdapter(
              specs,
              implementationAcquisitions
            ),
            config: {
              appToken: Redacted.make(["x", "app", "-244-scope"].join("")),
              installations: specs.map((spec, index) =>
                installationFor(spec, index, root)
              ),
              startupMode: "multi-workspace",
            },
            environment: {},
          });
          yield* Effect.forEach(
            specs,
            (spec) => routes.awaitAvailable(spec.identity.teamId),
            { discard: true }
          );
          assert.strictEqual(
            (yield* routes.resolve(healthy.identity.teamId))._tag,
            "Ready"
          );
          assert.strictEqual(
            (yield* routes.resolve(repositoryFailure.identity.teamId))._tag,
            "Unavailable"
          );
          assert.strictEqual(
            (yield* routes.resolve(layerFailure.identity.teamId))._tag,
            "Unavailable"
          );
          assert.strictEqual(
            yield* processIsRunning(repositoryProcess.pid),
            false
          );
          assert.strictEqual(yield* processIsRunning(layerProcess.pid), false);
          assert.ok(
            (yield* Effect.promise(() =>
              stat(repositoryProcess.sessionRemainder)
            )).size > 0
          );
          assert.ok(
            (yield* Effect.promise(() => stat(layerProcess.sessionRemainder)))
              .size > 0
          );

          const healthyInstallation = yield* routes.awaitReady(
            healthy.identity.teamId
          );
          assert.ok(healthyInstallation.runner !== undefined);
          yield* healthyInstallation.runner.inject(
            normalizedEvent({
              authorSlackId: "U244HUMAN",
              channelId: "C244SCOPE",
              eventId: "event:244:scope:healthy",
              messageTs: "244.700",
              text: "<@U244LABORER> healthy binding survives",
            })
          );
          assert.deepStrictEqual(
            healthy.messages.map(({ text }) => text),
            [EXPECTED_MARKDOWN]
          );
          assert.strictEqual(implementationAcquisitions.count, 0);
        })
      ),
    30_000
  );

  it.live(
    "retains a newly circuit-open workspace route and reaps each failed child",
    () =>
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped(
          "laborer-244-bounded-startup-"
        );
        const controls = yield* makeTempDirectoryScoped(
          "laborer-244-bounded-startup-controls-"
        );
        const paths = yield* prepareSlackRuntimePaths(root, "T244BOUNDED");
        const launchPath = join(controls, "launch.json");
        const pidPath = join(controls, "pid");
        const observedHealth: AcpWorkspaceHealth[] = [];
        const result = yield* Effect.result(
          makeProductionAcpWorkspaceApplication(
            {
              applicationConfig: {
                environment: [
                  "FAKE_ACP_LAUNCH_LOG",
                  "FAKE_ACP_MODE",
                  "FAKE_ACP_RUNTIME",
                  "SCRIPTED_ACP_PID_PATH",
                ],
                type: "reference-coding",
              },
              client: new WebClient(),
              environment: {
                FAKE_ACP_LAUNCH_LOG: launchPath,
                FAKE_ACP_MODE: "hang-startup",
                FAKE_ACP_RUNTIME: process.execPath,
                PATH: process.env.PATH,
                SCRIPTED_ACP_PID_PATH: pidPath,
              },
              laborerSlackId: "U244LABORER",
              paths,
              root,
              workspaceId: "T244BOUNDED",
            },
            {
              makeOpenCodeClient: () =>
                Effect.succeed(
                  makeUnusedImplementationClient({
                    implementationPrompts: 0,
                  })
                ),
              observeHealth: (health) => observedHealth.push(health),
              process: {
                childExitGraceMillis: 50,
                command: fakeOpenCodePath,
                initializeTimeoutMillis: 500,
                testHooks: { treatCommandAsOpenCode: true },
              },
            }
          )
        );
        assert.strictEqual(result._tag, "Success");
        if (result._tag === "Success") {
          assert.strictEqual(
            (yield* result.success.health).health,
            "circuit_open"
          );
        }
        assert.strictEqual(
          observedHealth.filter(({ status }) => status === "starting").length,
          5
        );
        assert.strictEqual(
          observedHealth.filter(({ status }) => status === "quarantined")
            .length,
          5
        );
        yield* waitForProcessExit(pidPath);
      }).pipe(Effect.scoped),
    10_000
  );

  it.effect(
    "quarantines an effective-config collision before spawning ACP",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-246-effective-config-collision-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-246-effective-config-collision-controls-"
          );
          const workspaceId = "T246CONFIGCOLLISION";
          const paths = yield* prepareSlackRuntimePaths(root, workspaceId);
          const processPaths = scriptedProcessPaths(controls, "collision");
          const probeObservation = join(controls, "probe-observation.json");
          const observedHealth: AcpWorkspaceHealth[] = [];
          const reservedName = `${laborerActionMcpServerName(
            root,
            workspaceId
          )}_create-feature`;
          const resolvedConfigSecret =
            "resolved-config-secret-must-not-persist";
          const result = yield* Effect.result(
            makeProductionAcpWorkspaceApplication(
              {
                applicationConfig: {
                  environment: [
                    ...PROCESS_ENVIRONMENT_NAMES,
                    "FAKE_OPENCODE_CONFIG_PROBE_OBSERVATION_PATH",
                  ],
                  type: "reference-coding",
                },
                client: new WebClient(),
                environment: scriptedEnvironment(processPaths, {
                  FAKE_OPENCODE_CONFIG_PROBE_OBSERVATION_PATH: probeObservation,
                  SCRIPTED_ACP_EFFECTIVE_CONFIG_JSON: JSON.stringify({
                    mcp: {
                      [reservedName]: {
                        enabled: true,
                        privateToken: resolvedConfigSecret,
                      },
                    },
                  }),
                  SLACK_BOT_TOKEN: "must-not-reach-config-probe",
                }),
                laborerSlackId: "U246LABORER",
                paths,
                root,
                workspaceId,
              },
              {
                makeOpenCodeClient: () =>
                  Effect.succeed(
                    makeUnusedImplementationClient({ implementationPrompts: 0 })
                  ),
                observeHealth: (health) => observedHealth.push(health),
                process: {
                  command: fakeOpenCodePath,
                  testHooks: { treatCommandAsOpenCode: true },
                },
              }
            )
          );
          assert.strictEqual(result._tag, "Failure");
          if (result._tag === "Failure") {
            assert.ok(result.failure instanceof AcpWorkspaceStartupError);
            assert.ok(
              !JSON.stringify(result.failure).includes(
                "must-not-reach-config-probe"
              )
            );
            assert.ok(
              !JSON.stringify(result.failure).includes(resolvedConfigSecret)
            );
          }
          const acpWasSpawned = yield* Effect.promise(async () => {
            try {
              await stat(processPaths.launch);
              return true;
            } catch {
              return false;
            }
          });
          assert.strictEqual(acpWasSpawned, false);
          assert.deepStrictEqual(
            observedHealth.map(({ status }) => status),
            ["starting", "quarantined"]
          );
          const observedProbe = JSON.parse(
            yield* Effect.promise(() => readFile(probeObservation, "utf8"))
          ) as {
            readonly args: readonly string[];
            readonly cwd: string;
            readonly environmentNames: readonly string[];
          };
          assert.deepStrictEqual(observedProbe.args, ["debug", "config"]);
          assert.strictEqual(observedProbe.cwd, root);
          assert.ok(observedProbe.environmentNames.includes("OPENAI_API_KEY"));
          assert.ok(
            !observedProbe.environmentNames.includes("SLACK_BOT_TOKEN")
          );
          assert.ok(
            !observedProbe.environmentNames.some((name) =>
              name.startsWith("LABORER_ACTION")
            )
          );
          assert.ok(
            !JSON.stringify(observedProbe).includes(resolvedConfigSecret)
          );
          for (const statePath of [
            paths.acpActionAuthorityState,
            paths.acpAuthorityState,
            paths.applicationState,
          ]) {
            const stateExists = yield* Effect.promise(async () => {
              try {
                await stat(statePath);
                return true;
              } catch {
                return false;
              }
            });
            assert.strictEqual(stateExists, false);
          }
        })
      )
  );

  it.effect("cuts the single normal receiver over to production ACP", () =>
    Effect.gen(function* () {
      const [packageSource, liveSource] = yield* Effect.promise(() =>
        Promise.all([
          readFile(join(process.cwd(), "package.json"), "utf8"),
          readFile(join(process.cwd(), "src/slack/live.ts"), "utf8"),
        ])
      );
      const packageJson = JSON.parse(packageSource) as {
        readonly scripts: Readonly<Record<string, string>>;
      };
      assert.strictEqual(
        packageJson.scripts["start:slack"],
        "node --env-file-if-exists=.env.local src/slack/live.ts"
      );
      assert.ok(!("start:slack:acp" in packageJson.scripts));
      assert.ok(liveSource.includes("makeAcpSlackWorkspaceRunner"));
      assert.ok(liveSource.includes("makeSlackNativeStreamCapability"));
      assert.ok(liveSource.includes("slackConversationStreamDeliveryPolicy"));
      assert.ok(!liveSource.includes("makeSlackWorkspaceRunner"));
      assert.ok(
        !liveSource.includes("makeReferenceCodingWorkspaceApplication")
      );
    })
  );
}, 60_000);
