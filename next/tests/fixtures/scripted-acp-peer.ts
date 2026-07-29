#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { access, appendFile, readFile, writeFile } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import {
  agent,
  type McpServer,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { Array as EffectArray, pipe } from "effect";

const MESSAGE_ID = "acp-message-secret-234";
const FIRST_MESSAGE_ID = "acp-first-message-secret-236";
const SECOND_MESSAGE_ID = "acp-second-message-secret-236";
const readyPath = process.env.SCRIPTED_ACP_READY_PATH;
const releasePath = process.env.SCRIPTED_ACP_RELEASE_PATH;
const cancelledPath = process.env.SCRIPTED_ACP_CANCELLED_PATH;
const exitPath = process.env.SCRIPTED_ACP_EXIT_PATH;
const pidPath = process.env.SCRIPTED_ACP_PID_PATH;
const descendantPidPath = process.env.SCRIPTED_ACP_DESCENDANT_PID_PATH;
const promptLogPath = process.env.SCRIPTED_ACP_PROMPT_LOG_PATH;
const promptJsonlPath = process.env.SCRIPTED_ACP_PROMPT_JSONL_PATH;
const promptContentJsonlPath =
  process.env.SCRIPTED_ACP_PROMPT_CONTENT_JSONL_PATH;
const imagePromptCapability =
  process.env.SCRIPTED_ACP_IMAGE_PROMPT_CAPABILITY === "1";
const sessionRequestJsonlPath =
  process.env.SCRIPTED_ACP_SESSION_REQUEST_JSONL_PATH;
const sessionMethodJsonlPath =
  process.env.SCRIPTED_ACP_SESSION_METHOD_JSONL_PATH;
const durableSessionsPath = process.env.SCRIPTED_ACP_DURABLE_SESSIONS_PATH;
const disableResumeCapability =
  process.env.SCRIPTED_ACP_DISABLE_RESUME_CAPABILITY === "1";
const resumeFailure = process.env.SCRIPTED_ACP_RESUME_FAILURE;
const replayOnResume = process.env.SCRIPTED_ACP_REPLAY_ON_RESUME === "1";
const delayedReplayMillis = Number.parseInt(
  process.env.SCRIPTED_ACP_DELAYED_REPLAY_MILLIS ?? "0",
  10
);
const postPromptReplayMillis = Number.parseInt(
  process.env.SCRIPTED_ACP_POST_PROMPT_REPLAY_MILLIS ?? "0",
  10
);
const replayAfterPromptBeforeMarker =
  process.env.SCRIPTED_ACP_REPLAY_AFTER_PROMPT_BEFORE_MARKER === "1";
const disablePromptMarker =
  process.env.SCRIPTED_ACP_DISABLE_PROMPT_MARKER === "1";
const disablePromptEpochCapability =
  process.env.SCRIPTED_ACP_DISABLE_PROMPT_EPOCH_CAPABILITY === "1";
const useOpenCodeMessageIds =
  process.env.SCRIPTED_ACP_USE_OPENCODE_MESSAGE_IDS === "1";
const scriptedAgentName =
  process.env.SCRIPTED_ACP_AGENT_NAME ?? "laborer-scripted-acp-peer";
const scriptedAgentVersion = process.env.SCRIPTED_ACP_AGENT_VERSION ?? "1.0.0";
const publicOutputLabel = process.env.SCRIPTED_ACP_PUBLIC_OUTPUT_LABEL;
const publicOutputChunks = (() => {
  const source = process.env.SCRIPTED_ACP_PUBLIC_OUTPUT_CHUNKS_JSON;
  if (source === undefined) {
    return null;
  }
  const parsed: unknown = JSON.parse(source);
  if (
    !(
      Array.isArray(parsed) &&
      parsed.every((chunk) => typeof chunk === "string")
    )
  ) {
    throw new Error("scripted ACP public output chunks must be strings");
  }
  return parsed;
})();
const pauseAfterPublicOutputChunk = Number.parseInt(
  process.env.SCRIPTED_ACP_PAUSE_AFTER_PUBLIC_OUTPUT_CHUNK ?? "0",
  10
);
const sessionIdPrefix =
  process.env.SCRIPTED_ACP_SESSION_ID_PREFIX ?? "acp-session-secret-234";
const initialPublicOutput = publicOutputLabel ?? "**Streaming** from ACP";
const completedPublicOutput =
  publicOutputLabel === undefined ? "\n\n- complete\n- unchanged" : " complete";
const scriptedStopReasonFor = (
  candidate: string | undefined
):
  | "cancelled"
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "unknown_future_stop"
  | null => {
  if (
    candidate === "cancelled" ||
    candidate === "end_turn" ||
    candidate === "max_tokens" ||
    candidate === "max_turn_requests" ||
    candidate === "refusal" ||
    candidate === "unknown_future_stop"
  ) {
    return candidate;
  }
  return null;
};
const textlessStopReason = scriptedStopReasonFor(
  process.env.SCRIPTED_ACP_TEXTLESS_STOP_REASON
);
const publicOutputStopReason =
  scriptedStopReasonFor(process.env.SCRIPTED_ACP_PUBLIC_OUTPUT_STOP_REASON) ??
  "end_turn";
const cancelAfterPublicChunk =
  process.env.SCRIPTED_ACP_CANCEL_AFTER_PUBLIC_CHUNK === "1";
const exitAfterPromptReceived =
  process.env.SCRIPTED_ACP_EXIT_AFTER_PROMPT_RECEIVED === "1";
const exitAfterPromptReceivedMarkerPath =
  process.env.SCRIPTED_ACP_EXIT_AFTER_PROMPT_RECEIVED_MARKER_PATH;
const exitAfterFirstPublicChunk =
  process.env.SCRIPTED_ACP_EXIT_AFTER_FIRST_PUBLIC_CHUNK === "1";
const exitAfterFirstPublicChunkMarkerPath =
  process.env.SCRIPTED_ACP_EXIT_AFTER_FIRST_PUBLIC_CHUNK_MARKER_PATH;
const ignorePromptCancellation =
  process.env.SCRIPTED_ACP_IGNORE_PROMPT_CANCELLATION === "1";

const claimOneShotCrash = async (
  path: string | undefined
): Promise<boolean> => {
  if (path === undefined) {
    return true;
  }
  try {
    await writeFile(path, String(process.pid), { flag: "wx", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
};

const shouldCrash = async (
  enabled: boolean,
  markerPath: string | undefined
): Promise<boolean> => enabled && (await claimOneShotCrash(markerPath));

const connectPromptCancellation = (
  signal: AbortSignal,
  cancel: () => void
): (() => void) => {
  if (ignorePromptCancellation) {
    return () => undefined;
  }
  signal.addEventListener("abort", cancel, { once: true });
  return () => signal.removeEventListener("abort", cancel);
};
const permissionTitle = process.env.SCRIPTED_ACP_PERMISSION_TITLE;
const permissionToolIdentity =
  process.env.SCRIPTED_ACP_PERMISSION_TOOL_IDENTITY;
const permissionToolName = process.env.SCRIPTED_ACP_PERMISSION_TOOL_NAME;
const permissionToolKind = process.env.SCRIPTED_ACP_PERMISSION_TOOL_KIND;
const permissionRawInputJson =
  process.env.SCRIPTED_ACP_PERMISSION_RAW_INPUT_JSON;
const permissionResultPath = process.env.SCRIPTED_ACP_PERMISSION_RESULT_PATH;
const permissionResultJsonlPath =
  process.env.SCRIPTED_ACP_PERMISSION_RESULT_JSONL_PATH;
const closeSessionStartedPath =
  process.env.SCRIPTED_ACP_CLOSE_SESSION_STARTED_PATH;
const closeSessionReleasePath =
  process.env.SCRIPTED_ACP_CLOSE_SESSION_RELEASE_PATH;
const sessionRemainderPath = process.env.SCRIPTED_ACP_SESSION_REMAINDER_PATH;
const memoryOperationJson = process.env.SCRIPTED_ACP_MEMORY_OPERATION_JSON;
const actionOperationJson = process.env.SCRIPTED_ACP_ACTION_OPERATION_JSON;
const actionResultPath = process.env.SCRIPTED_ACP_ACTION_RESULT_PATH;
const actionOrdinaryMarker = process.env.SCRIPTED_ACP_ACTION_ORDINARY_MARKER;
const executionPromptMarker = process.env.SCRIPTED_ACP_EXECUTION_PROMPT_MARKER;
const executionPromptText = process.env.SCRIPTED_ACP_EXECUTION_PROMPT_TEXT;
const executionCancelMarker = process.env.SCRIPTED_ACP_EXECUTION_CANCEL_MARKER;
const executionPostCancelMarker =
  process.env.SCRIPTED_ACP_EXECUTION_POST_CANCEL_MARKER;
const executionIdPath = process.env.SCRIPTED_ACP_EXECUTION_ID_PATH;
const executionCancelCallStartedPath =
  process.env.SCRIPTED_ACP_EXECUTION_CANCEL_CALL_STARTED_PATH;
const executionCancelAbortTriggerPath =
  process.env.SCRIPTED_ACP_EXECUTION_CANCEL_ABORT_TRIGGER_PATH;
const executionCancelAbortedPath =
  process.env.SCRIPTED_ACP_EXECUTION_CANCEL_ABORTED_PATH;
const sessionCancelJsonlPath =
  process.env.SCRIPTED_ACP_SESSION_CANCEL_JSONL_PATH;
const scriptedActionName = process.env.SCRIPTED_ACP_ACTION_NAME;
if (
  scriptedActionName !== undefined &&
  scriptedActionName !== "create-feature" &&
  scriptedActionName !== "deal-with-bug"
) {
  throw new Error("scripted Action name is unsupported");
}
const actionName = scriptedActionName ?? "create-feature";
const executionIdAttributePattern = /execution-id="([^"]+)"/;
const actionExpectFailure =
  process.env.SCRIPTED_ACP_ACTION_EXPECT_FAILURE === "1";
const memoryOperationEveryPrompt =
  process.env.SCRIPTED_ACP_MEMORY_OPERATION_EVERY_PROMPT === "1";
const memoryFailureOperationJson =
  process.env.SCRIPTED_ACP_MEMORY_FAILURE_OPERATION_JSON;
const memoryDiagnosticPath = process.env.SCRIPTED_ACP_MEMORY_DIAGNOSTIC_PATH;
const memoryActivityJsonlPath =
  process.env.SCRIPTED_ACP_MEMORY_ACTIVITY_JSONL_PATH;
const memoryCallStartedPath = process.env.SCRIPTED_ACP_MEMORY_CALL_STARTED_PATH;
const memoryCallReleasePath = process.env.SCRIPTED_ACP_MEMORY_CALL_RELEASE_PATH;
const memoryOperationRequestsPermission =
  process.env.SCRIPTED_ACP_MEMORY_OPERATION_REQUESTS_PERMISSION === "1";
const abandonMemoryCallLifecycle =
  process.env.SCRIPTED_ACP_ABANDON_MEMORY_CALL_LIFECYCLE === "1";
const mcpRegistrationStatsJsonlPath =
  process.env.SCRIPTED_ACP_MCP_REGISTRATION_STATS_JSONL_PATH;
const mcpRegistrationDelayMillis = Number.parseInt(
  process.env.SCRIPTED_ACP_MCP_REGISTRATION_DELAY_MILLIS ?? "0",
  10
);
const rejectSessionWithMcp =
  process.env.SCRIPTED_ACP_REJECT_SESSION_WITH_MCP === "1";
const hangSessionWithMcp =
  process.env.SCRIPTED_ACP_HANG_SESSION_WITH_MCP === "1";
const ignoreMcpRegistrationErrors =
  process.env.SCRIPTED_ACP_IGNORE_MCP_REGISTRATION_ERRORS === "1";
const collideMcpRegistration =
  process.env.SCRIPTED_ACP_COLLIDE_MCP_REGISTRATION === "1";
const collideMcpRegistrationAt = Number.parseInt(
  process.env.SCRIPTED_ACP_COLLIDE_MCP_REGISTRATION_AT ?? "0",
  10
);
const lifecycleLogPath = process.env.SCRIPTED_ACP_LIFECYCLE_LOG_PATH;
const promptAttemptJsonlPath =
  process.env.SCRIPTED_ACP_PROMPT_ATTEMPT_JSONL_PATH;
const sessionLogPath = process.env.SCRIPTED_ACP_SESSION_LOG_PATH;
const signalLogPath = process.env.SCRIPTED_ACP_SIGNAL_LOG_PATH;
const stopReasonLogPath = process.env.SCRIPTED_ACP_STOP_REASON_LOG_PATH;
const exitAfterInitializePath =
  process.env.SCRIPTED_ACP_EXIT_AFTER_INITIALIZE_PATH;
const idleExitTriggerPath = process.env.SCRIPTED_ACP_IDLE_EXIT_TRIGGER_PATH;
const idleExitMarkerPath = process.env.SCRIPTED_ACP_IDLE_EXIT_MARKER_PATH;
const stayAliveAfterStdioClose =
  process.env.SCRIPTED_ACP_STAY_ALIVE_AFTER_STDIO_CLOSE === "1";
const scenario = process.env.SCRIPTED_ACP_SCENARIO ?? "stream";
const effectiveConfigJson = process.env.SCRIPTED_ACP_EFFECTIVE_CONFIG_JSON;
const sessionCountPath = process.env.SCRIPTED_ACP_SESSION_COUNT_PATH;
type FailingScenario = "failure" | "queued-failure";
const failingScenarioFor = (candidate: string): FailingScenario | null => {
  if (candidate === "failure" || candidate === "queued-failure") {
    return candidate;
  }
  return null;
};
const failingScenario = failingScenarioFor(scenario);

if (readyPath === undefined || releasePath === undefined) {
  throw new Error("scripted ACP control paths are required");
}
if (pidPath !== undefined) {
  await writeFile(pidPath, String(process.pid), { mode: 0o600 });
}
if (descendantPidPath !== undefined) {
  const descendant = spawn(
    process.execPath,
    [
      "-e",
      "process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1000)",
    ],
    { stdio: "ignore" }
  );
  if (descendant.pid === undefined) {
    throw new Error("scripted ACP descendant did not start");
  }
  descendant.unref();
  await writeFile(descendantPidPath, String(descendant.pid), { mode: 0o600 });
}
if (stayAliveAfterStdioClose) {
  process.on("SIGTERM", () => {
    if (signalLogPath !== undefined) {
      appendFileSync(signalLogPath, "SIGTERM\n", { mode: 0o600 });
    }
  });
}
if (idleExitTriggerPath !== undefined && idleExitMarkerPath !== undefined) {
  const idleExitPoll = setInterval(async () => {
    try {
      await access(idleExitTriggerPath);
      await writeFile(idleExitMarkerPath, "exited", {
        flag: "wx",
        mode: 0o600,
      });
      clearInterval(idleExitPoll);
      process.exit(31);
    } catch {
      // The trigger is absent or another generation already claimed it.
    }
  }, 10);
  idleExitPoll.unref();
}

const sessions = new Set<string>();
const sessionMcpServers = new Map<string, readonly McpServer[]>();
const sessionExecutionIds = new Map<string, string>();
const registeredMcpClients = new Map<
  string,
  { readonly client: Client; readonly diagnostics: Buffer[] }
>();
const promptCancellations = new Map<string, AbortController>();
let sessionCount = 0;
let promptCount = 0;
let mcpRegistrationsInFlight = 0;
let maximumMcpRegistrationsInFlight = 0;

interface DurableSessionRecord {
  readonly cwd: string;
}

interface DurableSessionStore {
  readonly counter: number;
  readonly sessions: Readonly<Record<string, DurableSessionRecord>>;
}

const emptyDurableSessionStore: DurableSessionStore = {
  counter: 0,
  sessions: {},
};

const readDurableSessions = async (): Promise<DurableSessionStore> => {
  if (durableSessionsPath === undefined) {
    return emptyDurableSessionStore;
  }
  try {
    return JSON.parse(
      await readFile(durableSessionsPath, "utf8")
    ) as DurableSessionStore;
  } catch {
    return emptyDurableSessionStore;
  }
};

const writeDurableSessions = async (
  store: DurableSessionStore
): Promise<void> => {
  if (durableSessionsPath !== undefined) {
    await writeFile(durableSessionsPath, JSON.stringify(store), {
      mode: 0o600,
    });
  }
};

const recordSessionMethod = async (
  method: "session/new" | "session/resume",
  params: unknown
): Promise<void> => {
  if (sessionMethodJsonlPath !== undefined) {
    await appendFile(
      sessionMethodJsonlPath,
      `${JSON.stringify({ method, params })}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
  }
};

const recordLifecycle = async (entry: string): Promise<void> => {
  if (lifecycleLogPath !== undefined) {
    await appendFile(lifecycleLogPath, `${entry}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
};

const waitForRelease = async (signal: AbortSignal): Promise<boolean> => {
  while (!signal.aborted) {
    try {
      await access(releasePath);
      return !signal.aborted;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
  }
  return false;
};

const promptText = (
  prompt: readonly import("@agentclientprotocol/sdk").ContentBlock[]
): string =>
  pipe(
    prompt,
    EffectArray.map((content) => (content.type === "text" ? content.text : "")),
    EffectArray.join("")
  );

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const openCodeMessageId = (order: bigint): string =>
  `msg_${order.toString(16).padStart(12, "0")}${"A".repeat(14)}`;

const currentOpenCodeMessageId = (): string => {
  const order = (BigInt(Date.now()) * 0x1000n + 1n) % 281_474_976_710_656n;
  return openCodeMessageId(order);
};

type NotifySessionUpdate = (update: SessionUpdate) => Promise<void>;

type FallbackStopReason = "max_tokens" | "max_turn_requests";

const fallbackStopReasonFor = (
  candidate: string
): FallbackStopReason | null => {
  if (candidate === "max-tokens") {
    return "max_tokens";
  }
  if (candidate === "max-turn-requests") {
    return "max_turn_requests";
  }
  return null;
};

const runFallbackStopReason = async (
  stopReason: FallbackStopReason,
  notify: NotifySessionUpdate
): Promise<import("@agentclientprotocol/sdk").PromptResponse> => {
  await notify({
    content: {
      text: `Scripted ${stopReason} coverage`,
      type: "text",
    },
    messageId: `acp-${stopReason}-secret-243`,
    sessionUpdate: "agent_message_chunk",
  });
  if (stopReasonLogPath !== undefined) {
    await appendFile(stopReasonLogPath, `${stopReason}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
  return { stopReason };
};

const establishCurrentPromptEpoch = async (options: {
  readonly meta: unknown;
  readonly notify: NotifySessionUpdate;
  readonly prompt: readonly import("@agentclientprotocol/sdk").ContentBlock[];
  readonly promptNumber: number;
}): Promise<string> => {
  const openCodeBoundary = isRecord(options.meta)
    ? options.meta["laborer.dev/opencode-order-boundary"]
    : undefined;
  const historicalMessageId =
    useOpenCodeMessageIds && typeof openCodeBoundary === "string"
      ? openCodeMessageId(BigInt(`0x${openCodeBoundary}`))
      : "pre-marker-historical-message-241";
  if (replayAfterPromptBeforeMarker) {
    await options.notify({
      content: {
        text: "PRE-MARKER HISTORICAL OUTPUT MUST NOT REPLAY",
        type: "text",
      },
      messageId: historicalMessageId,
      sessionUpdate: "agent_message_chunk",
    });
  }
  const promptEpoch = isRecord(options.meta)
    ? options.meta["laborer.dev/prompt-epoch"]
    : undefined;
  if (typeof promptEpoch === "string" && !disablePromptMarker) {
    await options.notify({
      _meta: { "laborer.dev/prompt-epoch": promptEpoch },
      content: { text: promptText(options.prompt), type: "text" },
      messageId: `current-user-message-${options.promptNumber}`,
      sessionUpdate: "user_message_chunk",
    });
  }
  return useOpenCodeMessageIds ? currentOpenCodeMessageId() : MESSAGE_ID;
};

const recordAcceptedPrompt = async (options: {
  readonly prompt: string;
  readonly sessionId: string;
}): Promise<void> => {
  if (promptLogPath !== undefined) {
    await appendFile(
      promptLogPath,
      `${options.sessionId}\t${options.prompt}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
  }
  if (promptJsonlPath !== undefined) {
    await appendFile(promptJsonlPath, `${JSON.stringify(options)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
};

const recordPromptAttempt = async (options: {
  readonly prompt: string;
  readonly sessionId: string;
}): Promise<void> => {
  if (promptAttemptJsonlPath === undefined) {
    return;
  }
  await appendFile(promptAttemptJsonlPath, `${JSON.stringify(options)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
};

const settleMemoryOperation = async (
  callId: string,
  resultPromise: ReturnType<Client["callTool"]>
) => {
  if (memoryCallStartedPath !== undefined) {
    await writeFile(memoryCallStartedPath, callId, { mode: 0o600 });
  }
  if (abandonMemoryCallLifecycle) {
    resultPromise.catch(() => undefined);
    return undefined;
  }
  if (memoryCallReleasePath !== undefined) {
    while (true) {
      try {
        await access(memoryCallReleasePath);
        break;
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
    }
  }
  return resultPromise;
};

const runMemoryOperation = async (options: {
  readonly callId: string;
  readonly notify: NotifySessionUpdate;
  readonly operationJson: string;
  readonly request: (
    request: RequestPermissionRequest
  ) => Promise<RequestPermissionResponse>;
  readonly sessionId: string;
}): Promise<void> => {
  const attachedServer = sessionMcpServers
    .get(options.sessionId)
    ?.find((server) => !("type" in server));
  const serverName =
    attachedServer === undefined || "type" in attachedServer
      ? registeredMcpClients.keys().next().value
      : attachedServer.name;
  if (serverName === undefined) {
    throw new Error(
      "scripted memory scenario requires a registered MCP server"
    );
  }
  const operation: unknown = JSON.parse(options.operationJson);
  if (!isRecord(operation)) {
    throw new Error("scripted memory operation must be an object");
  }
  const registered = registeredMcpClients.get(serverName);
  if (registered === undefined) {
    throw new Error("scripted memory server was not registered");
  }
  const emitPrivateUpdate = async (update: SessionUpdate): Promise<void> => {
    if (memoryActivityJsonlPath !== undefined) {
      await appendFile(memoryActivityJsonlPath, `${JSON.stringify(update)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    }
    await options.notify(update);
  };
  try {
    const permissionName = `${serverName}_memory`;
    await emitPrivateUpdate({
      kind: "other",
      name: permissionName,
      rawInput: {
        operation,
        secret: "LABORER MEMORY TOOL INPUT SECRET 240",
      },
      sessionUpdate: "tool_call",
      status: "pending",
      title: memoryOperationRequestsPermission
        ? permissionName
        : "LABORER MEMORY TOOL SECRET 240",
      toolCallId: options.callId,
    });
    if (memoryOperationRequestsPermission) {
      const permission = await options.request({
        options: [
          {
            kind: "allow_once",
            name: "Allow once",
            optionId: "memory-operation-allow-once",
          },
        ],
        sessionId: options.sessionId,
        toolCall: {
          kind: "other",
          name: permissionName,
          rawInput: {
            operation,
            secret: "LABORER MEMORY TOOL INPUT SECRET 240",
          },
          status: "pending",
          title: permissionName,
          toolCallId: options.callId,
        },
      });
      if (permission.outcome.outcome !== "selected") {
        await emitPrivateUpdate({
          sessionUpdate: "tool_call_update",
          status: "failed",
          toolCallId: options.callId,
        });
        return;
      }
    }
    const resultPromise = registered.client.callTool({
      arguments: operation,
      name: "memory",
    });
    const result = await settleMemoryOperation(options.callId, resultPromise);
    if (result === undefined) {
      return;
    }
    await emitPrivateUpdate({
      rawOutput: {
        result,
        secret: "LABORER MEMORY TOOL OUTPUT SECRET 240",
      },
      sessionUpdate: "tool_call_update",
      status: result.isError === true ? "failed" : "completed",
      toolCallId: options.callId,
    });
  } finally {
    if (
      memoryDiagnosticPath !== undefined &&
      registered.diagnostics.length > 0
    ) {
      await appendFile(
        memoryDiagnosticPath,
        Buffer.concat(registered.diagnostics),
        {
          mode: 0o600,
        }
      );
      registered.diagnostics.length = 0;
    }
  }
};

const runInitialMemoryOperations = async (
  sessionId: string,
  notify: NotifySessionUpdate,
  request: (
    request: RequestPermissionRequest
  ) => Promise<RequestPermissionResponse>
): Promise<void> => {
  if (!memoryOperationEveryPrompt && promptCount !== 0) {
    return;
  }
  if (memoryOperationJson !== undefined) {
    await runMemoryOperation({
      callId: `laborer-memory-success-240-${promptCount}`,
      notify,
      operationJson: memoryOperationJson,
      request,
      sessionId,
    });
  }
  if (memoryFailureOperationJson !== undefined) {
    await runMemoryOperation({
      callId: `laborer-memory-failure-240-${promptCount}`,
      notify,
      operationJson: memoryFailureOperationJson,
      request,
      sessionId,
    });
  }
};

const configuredActionInput = (input: unknown): unknown => {
  if (input !== undefined) {
    return input;
  }
  return actionOperationJson === undefined
    ? undefined
    : JSON.parse(actionOperationJson);
};

const validateActionDuplicate = (
  result: Awaited<ReturnType<Client["callTool"]>>,
  duplicateResult: Awaited<ReturnType<Client["callTool"]>>
): void => {
  if (actionExpectFailure) {
    if (
      result.isError !== true ||
      duplicateResult.isError !== true ||
      JSON.stringify(result.content) !== JSON.stringify(duplicateResult.content)
    ) {
      throw new Error("scripted Action failure was not stably bounded");
    }
    return;
  }
  if (
    !isRecord(duplicateResult.structuredContent) ||
    duplicateResult.structuredContent.deduplicated !== true ||
    duplicateResult.structuredContent.executionId !==
      (isRecord(result.structuredContent)
        ? result.structuredContent.executionId
        : undefined)
  ) {
    throw new Error("scripted Action duplicate was not deduplicated");
  }
};

const rememberExecutionId = async (
  sessionId: string,
  structuredContent: unknown
): Promise<void> => {
  const executionId = isRecord(structuredContent)
    ? structuredContent.executionId
    : undefined;
  if (typeof executionId !== "string") {
    return;
  }
  sessionExecutionIds.set(sessionId, executionId);
  if (executionIdPath !== undefined) {
    await writeFile(executionIdPath, executionId, { mode: 0o600 });
  }
};

const runActionOperation = async (options: {
  readonly callId?: string;
  readonly input?: unknown;
  readonly mutationName?: string;
  readonly notify: NotifySessionUpdate;
  readonly request: (
    request: RequestPermissionRequest
  ) => Promise<RequestPermissionResponse>;
  readonly sessionId: string;
}): Promise<boolean> => {
  const input = configuredActionInput(options.input);
  if (input === undefined) {
    return true;
  }
  const serverName = [...registeredMcpClients.keys()].find((name) =>
    name.startsWith("laborer-actions-")
  );
  if (serverName === undefined) {
    throw new Error("scripted Action server was not registered");
  }
  const registered = registeredMcpClients.get(serverName);
  if (registered === undefined) {
    throw new Error("scripted Action client is unavailable");
  }
  const callId = options.callId ?? "laborer-action-call-246";
  const mutationName = options.mutationName ?? actionName;
  const permissionName = `${serverName}_${mutationName}`;
  const pending = {
    kind: "other" as const,
    rawInput: input,
    status: "pending" as const,
    title: permissionName,
    toolCallId: callId,
  };
  await options.notify({
    ...pending,
    name: permissionName,
    sessionUpdate: "tool_call",
  });
  const permission = await options.request({
    options: [
      {
        kind: "allow_once",
        name: "Allow once",
        optionId: "action-allow-once-246",
      },
      {
        kind: "reject_once",
        name: "Reject",
        optionId: "action-reject-246",
      },
    ],
    sessionId: options.sessionId,
    toolCall: pending,
  });
  if (permissionResultPath !== undefined) {
    await writeFile(permissionResultPath, JSON.stringify(permission), {
      mode: 0o600,
    });
  }
  if (permission.outcome.outcome !== "selected") {
    throw new Error("scripted Action permission was not selected");
  }
  const result = await registered.client.callTool({
    arguments: isRecord(input) ? input : {},
    name: mutationName,
  });
  const duplicateResult = await registered.client.callTool({
    arguments: isRecord(input) ? input : {},
    name: mutationName,
  });
  validateActionDuplicate(result, duplicateResult);
  if (actionResultPath !== undefined) {
    await writeFile(
      actionResultPath,
      JSON.stringify({
        actionName: mutationName,
        duplicate: duplicateResult.structuredContent,
        first: result.structuredContent,
      }),
      { mode: 0o600 }
    );
  }
  await rememberExecutionId(options.sessionId, result.structuredContent);
  await options.notify({
    rawOutput: {
      duplicateResult,
      result,
      secret: "ACTION RAW TOOL OUTPUT MUST REMAIN PRIVATE 246",
    },
    sessionUpdate: "tool_call_update",
    status: result.isError === true ? "failed" : "completed",
    toolCallId: callId,
  });
  return !actionExpectFailure;
};

const visibleExecutionId = async (sessionId: string): Promise<string> => {
  const current = sessionExecutionIds.get(sessionId);
  if (current !== undefined) {
    return current;
  }
  if (executionIdPath !== undefined) {
    const persisted = (await readFile(executionIdPath, "utf8")).trim();
    if (persisted.length > 0) {
      sessionExecutionIds.set(sessionId, persisted);
      return persisted;
    }
  }
  throw new Error("scripted Execution control requires a visible Execution");
};

const runGeneratedExecutionTool = async (options: {
  readonly abortAfterTrigger?: boolean;
  readonly callId: string;
  readonly input: Record<string, unknown>;
  readonly mutationName:
    | "cancel-execution"
    | "inspect-executions"
    | "prompt-execution";
  readonly notify: NotifySessionUpdate;
  readonly request: (
    request: RequestPermissionRequest
  ) => Promise<RequestPermissionResponse>;
  readonly sessionId: string;
}) => {
  const serverName = [...registeredMcpClients.keys()].find((name) =>
    name.startsWith("laborer-actions-")
  );
  const registered =
    serverName === undefined ? undefined : registeredMcpClients.get(serverName);
  if (serverName === undefined || registered === undefined) {
    throw new Error("scripted Execution control server was not registered");
  }
  const permissionName = `${serverName}_${options.mutationName}`;
  const pending = {
    kind: "other" as const,
    name: permissionName,
    rawInput: options.input,
    status: "pending" as const,
    title: permissionName,
    toolCallId: options.callId,
  };
  await options.notify({ ...pending, sessionUpdate: "tool_call" });
  const permission = await options.request({
    options: [
      {
        kind: "allow_once",
        name: "Allow once",
        optionId: `execution-control-allow-${options.callId}`,
      },
    ],
    sessionId: options.sessionId,
    toolCall: pending,
  });
  if (permission.outcome.outcome !== "selected") {
    throw new Error("scripted Execution control permission was not selected");
  }
  const cancellation = new AbortController();
  const resultPromise = registered.client.callTool(
    { arguments: options.input, name: options.mutationName },
    CallToolResultSchema,
    { signal: cancellation.signal }
  );
  if (
    options.mutationName === "cancel-execution" &&
    executionCancelCallStartedPath !== undefined
  ) {
    await writeFile(executionCancelCallStartedPath, options.callId, {
      mode: 0o600,
    });
  }
  let abortPoll: ReturnType<typeof setInterval> | undefined;
  if (
    options.abortAfterTrigger === true &&
    executionCancelAbortTriggerPath !== undefined
  ) {
    abortPoll = setInterval(async () => {
      try {
        await access(executionCancelAbortTriggerPath);
        cancellation.abort("scripted MCP caller cancelled");
      } catch {
        return;
      }
      if (abortPoll !== undefined) {
        clearInterval(abortPoll);
      }
    }, 5);
    abortPoll.unref();
  }
  try {
    const result = await resultPromise;
    await options.notify({
      rawOutput: result,
      sessionUpdate: "tool_call_update",
      status: result.isError === true ? "failed" : "completed",
      toolCallId: options.callId,
    });
    return result;
  } catch (error) {
    if (cancellation.signal.aborted) {
      if (executionCancelAbortedPath !== undefined) {
        await writeFile(executionCancelAbortedPath, options.callId, {
          mode: 0o600,
        });
      }
      await options.notify({
        sessionUpdate: "tool_call_update",
        status: "failed",
        toolCallId: options.callId,
      });
      return null;
    }
    throw error;
  } finally {
    if (abortPoll !== undefined) {
      clearInterval(abortPoll);
    }
  }
};

const runExecutionCancellationScenario = async (options: {
  readonly messageId: string;
  readonly notify: NotifySessionUpdate;
  readonly request: (
    request: RequestPermissionRequest
  ) => Promise<RequestPermissionResponse>;
  readonly sessionId: string;
  readonly text: string;
}): Promise<boolean> => {
  const isInitialCancel =
    executionCancelMarker !== undefined &&
    options.text.includes(executionCancelMarker);
  const isPostCancel =
    executionPostCancelMarker !== undefined &&
    options.text.includes(executionPostCancelMarker);
  if (!(isInitialCancel || isPostCancel)) {
    return false;
  }
  const executionId = await visibleExecutionId(options.sessionId);
  const inspected = await runGeneratedExecutionTool({
    callId: `laborer-inspect-execution-${promptCount}`,
    input: { executionId },
    mutationName: "inspect-executions",
    notify: options.notify,
    request: options.request,
    sessionId: options.sessionId,
  });
  if (
    inspected === null ||
    !isRecord(inspected.structuredContent) ||
    !Array.isArray(inspected.structuredContent.executions) ||
    inspected.structuredContent.executions.length !== 1
  ) {
    throw new Error("scripted Execution inspection failed");
  }
  const cancellation = await runGeneratedExecutionTool({
    ...(isInitialCancel ? { abortAfterTrigger: true } : {}),
    callId: `laborer-cancel-execution-${promptCount}`,
    input: { executionId },
    mutationName: "cancel-execution",
    notify: options.notify,
    request: options.request,
    sessionId: options.sessionId,
  });
  if (isInitialCancel) {
    return true;
  }
  if (
    cancellation === null ||
    !isRecord(cancellation.structuredContent) ||
    cancellation.structuredContent.deduplicated !== true
  ) {
    throw new Error("scripted duplicate cancellation was not deduplicated");
  }
  const followUp = await runGeneratedExecutionTool({
    callId: `laborer-prompt-cancelled-execution-${promptCount}`,
    input: { executionId, prompt: "This follow-up must be rejected." },
    mutationName: "prompt-execution",
    notify: options.notify,
    request: options.request,
    sessionId: options.sessionId,
  });
  if (followUp?.isError !== true) {
    throw new Error("scripted cancelled Execution follow-up was accepted");
  }
  await options.notify({
    content: {
      text: "The implementation remains cancelled and its worktree is preserved.",
      type: "text",
    },
    messageId: options.messageId,
    sessionUpdate: "agent_message_chunk",
  });
  return true;
};

const runExecutionPromptScenario = async (options: {
  readonly messageId: string;
  readonly notify: NotifySessionUpdate;
  readonly request: (
    request: RequestPermissionRequest
  ) => Promise<RequestPermissionResponse>;
  readonly sessionId: string;
  readonly text: string;
}): Promise<boolean> => {
  if (
    executionPromptMarker === undefined ||
    !options.text.includes(executionPromptMarker)
  ) {
    return false;
  }
  const executionId = await visibleExecutionId(options.sessionId);
  const queued = await runActionOperation({
    callId: "laborer-execution-prompt-call-247",
    input: {
      executionId,
      prompt: executionPromptText ?? "Continue the implementation.",
    },
    mutationName: "prompt-execution",
    notify: options.notify,
    request: options.request,
    sessionId: options.sessionId,
  });
  await options.notify({
    content: {
      text: queued
        ? "I queued the implementation follow-up."
        : "I couldn't queue the implementation follow-up.",
      type: "text",
    },
    messageId: options.messageId,
    sessionUpdate: "agent_message_chunk",
  });
  return true;
};

const runActionScenario = async (options: {
  readonly messageId: string;
  readonly notify: NotifySessionUpdate;
  readonly prompt: readonly import("@agentclientprotocol/sdk").ContentBlock[];
  readonly request: (
    request: RequestPermissionRequest
  ) => Promise<RequestPermissionResponse>;
  readonly sessionId: string;
}): Promise<{ readonly stopReason: "cancelled" | "end_turn" }> => {
  const text = promptText(options.prompt);
  if (text.includes('source="implementation-agent"')) {
    const executionId = executionIdAttributePattern.exec(text)?.[1];
    if (executionId !== undefined) {
      sessionExecutionIds.set(options.sessionId, executionId);
    }
    await options.notify({
      content: {
        text: "The implementation update is ready for review.",
        type: "text",
      },
      messageId: options.messageId,
      sessionUpdate: "agent_message_chunk",
    });
    return { stopReason: "end_turn" };
  }
  if (text.includes('source="action-terminal"')) {
    const executionId = executionIdAttributePattern.exec(text)?.[1];
    if (executionId !== undefined) {
      sessionExecutionIds.set(options.sessionId, executionId);
    }
    await options.notify({
      content: {
        text: "Implementation finished successfully.",
        type: "text",
      },
      messageId: options.messageId,
      sessionUpdate: "agent_message_chunk",
    });
    return { stopReason: "end_turn" };
  }
  if (text.includes('source="execution-control"')) {
    const executionId = executionIdAttributePattern.exec(text)?.[1];
    if (executionId !== undefined) {
      sessionExecutionIds.set(options.sessionId, executionId);
    }
    await options.notify({
      content: {
        text: "The implementation was cancelled and its worktree is preserved.",
        type: "text",
      },
      messageId: options.messageId,
      sessionUpdate: "agent_message_chunk",
    });
    return { stopReason: "end_turn" };
  }
  if (
    await runExecutionCancellationScenario({
      ...options,
      text,
    })
  ) {
    return { stopReason: "end_turn" };
  }
  if (await runExecutionPromptScenario({ ...options, text })) {
    return { stopReason: "end_turn" };
  }
  if (
    actionOrdinaryMarker !== undefined &&
    text.includes(actionOrdinaryMarker)
  ) {
    await options.notify({
      content: {
        text: "Ordinary conversation completed without an Action.",
        type: "text",
      },
      messageId: options.messageId,
      sessionUpdate: "agent_message_chunk",
    });
    return { stopReason: "end_turn" };
  }
  const started = await runActionOperation(options);
  await options.notify({
    content: {
      text: started
        ? `I started the ${actionName === "deal-with-bug" ? "bug fix" : "feature implementation"}.`
        : `I couldn't start the ${actionName === "deal-with-bug" ? "bug fix" : "feature"} because that worktree name is unavailable.`,
      type: "text",
    },
    messageId: options.messageId,
    sessionUpdate: "agent_message_chunk",
  });
  return { stopReason: "end_turn" };
};

const collideWithMcpReadiness = async (
  environment: Readonly<Record<string, string>>
): Promise<void> => {
  if (!collideMcpRegistration && collideMcpRegistrationAt !== sessionCount) {
    return;
  }
  const readinessPath = environment.LABORER_MEMORY_READY_PATH;
  if (readinessPath === undefined) {
    return;
  }
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      await access(readinessPath);
      break;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
  }
  await writeFile(readinessPath, "colliding-registration", {
    mode: 0o600,
  });
};

const registerMcpServers = async (
  mcpServers: readonly McpServer[]
): Promise<void> => {
  if (ignoreMcpRegistrationErrors) {
    return;
  }
  for (const server of mcpServers) {
    if ("type" in server) {
      continue;
    }
    mcpRegistrationsInFlight += 1;
    maximumMcpRegistrationsInFlight = Math.max(
      maximumMcpRegistrationsInFlight,
      mcpRegistrationsInFlight
    );
    const environment = Object.fromEntries(
      server.env.map(({ name, value }) => [name, value])
    );
    const mcpClient = new Client({
      name: "scripted-acp-registration",
      version: "1.0.0",
    });
    const transport = new StdioClientTransport({
      args: [...server.args],
      command: server.command,
      env: environment,
      stderr: "pipe",
    });
    const diagnostics: Buffer[] = [];
    transport.stderr?.on("data", (chunk: Buffer) => {
      diagnostics.push(Buffer.from(chunk));
    });
    try {
      if (
        Number.isSafeInteger(mcpRegistrationDelayMillis) &&
        mcpRegistrationDelayMillis > 0
      ) {
        await new Promise((resolveDelay) =>
          setTimeout(resolveDelay, mcpRegistrationDelayMillis)
        );
      }
      await mcpClient.connect(transport);
      const previous = registeredMcpClients.get(server.name);
      registeredMcpClients.set(server.name, { client: mcpClient, diagnostics });
      await previous?.client.close();
      await collideWithMcpReadiness(environment);
      if (mcpRegistrationStatsJsonlPath !== undefined) {
        await appendFile(
          mcpRegistrationStatsJsonlPath,
          `${JSON.stringify({
            catalogSize: registeredMcpClients.size,
            maximumInFlight: maximumMcpRegistrationsInFlight,
            name: server.name,
          })}\n`,
          { encoding: "utf8", mode: 0o600 }
        );
      }
    } finally {
      mcpRegistrationsInFlight -= 1;
    }
  }
};

const requestScriptedPermission = async (options: {
  readonly notify: NotifySessionUpdate;
  readonly request: (
    request: RequestPermissionRequest
  ) => Promise<RequestPermissionResponse>;
  readonly sessionId: string;
}): Promise<void> => {
  if (permissionResultPath === undefined) {
    return;
  }
  if (permissionTitle === undefined) {
    return;
  }
  const toolCallId = `scripted-permission-${promptCount}`;
  if (permissionToolIdentity !== undefined) {
    const attachedMemoryServer = sessionMcpServers
      .get(options.sessionId)
      ?.find((server) => !("type" in server));
    const registeredMemoryServerName =
      attachedMemoryServer === undefined || "type" in attachedMemoryServer
        ? registeredMcpClients.keys().next().value
        : attachedMemoryServer.name;
    const exactToolIdentity =
      permissionToolIdentity === "attached-memory" &&
      registeredMemoryServerName !== undefined
        ? `${registeredMemoryServerName}_memory`
        : permissionToolIdentity;
    await options.notify({
      kind: "other",
      name: exactToolIdentity,
      sessionUpdate: "tool_call",
      status: "pending",
      title: exactToolIdentity,
      toolCallId,
    });
  }
  const permission = await options.request({
    options: [
      {
        kind: "allow_once",
        name: "Allow once",
        optionId: "scripted-allow-once",
      },
      {
        kind: "allow_always",
        name: "Always allow",
        optionId: "scripted-allow-always",
      },
      {
        kind: "reject_once",
        name: "Reject",
        optionId: "scripted-reject-once",
      },
    ],
    sessionId: options.sessionId,
    toolCall: {
      kind:
        permissionToolKind === "execute" ||
        permissionToolKind === "read" ||
        permissionToolKind === "edit" ||
        permissionToolKind === "delete" ||
        permissionToolKind === "move" ||
        permissionToolKind === "search" ||
        permissionToolKind === "think" ||
        permissionToolKind === "fetch" ||
        permissionToolKind === "switch_mode"
          ? permissionToolKind
          : "other",
      ...(permissionToolName === undefined ? {} : { name: permissionToolName }),
      ...(permissionRawInputJson === undefined
        ? {}
        : { rawInput: JSON.parse(permissionRawInputJson) as unknown }),
      status: "pending",
      title: permissionTitle,
      toolCallId,
    },
  });
  await options.notify({
    sessionUpdate: "tool_call_update",
    status: permission.outcome.outcome === "selected" ? "completed" : "failed",
    toolCallId,
  });
  await writeFile(permissionResultPath, JSON.stringify(permission), {
    mode: 0o600,
  });
  if (permissionResultJsonlPath !== undefined) {
    await appendFile(
      permissionResultJsonlPath,
      `${JSON.stringify(permission)}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
  }
};

const runFailingScenario = async (
  activeScenario: FailingScenario,
  cancellation: AbortController,
  notify: NotifySessionUpdate
): Promise<import("@agentclientprotocol/sdk").PromptResponse> => {
  if (activeScenario === "queued-failure" && promptCount > 1) {
    await notify({
      content: { text: "Queued turn recovered", type: "text" },
      messageId: "acp-queued-recovery-secret-236",
      sessionUpdate: "agent_message_chunk",
    });
    return { stopReason: "end_turn" };
  }
  await notify({
    content: {
      text:
        activeScenario === "failure"
          ? "Partial answer stays."
          : "First turn partial",
      type: "text",
    },
    messageId:
      activeScenario === "failure"
        ? "acp-failure-message-secret-236"
        : "acp-queued-failure-secret-236",
    sessionUpdate: "agent_message_chunk",
  });
  await writeFile(readyPath, "pending", { mode: 0o600 });
  if (!(await waitForRelease(cancellation.signal))) {
    return { stopReason: "cancelled" };
  }
  throw new Error(
    activeScenario === "failure"
      ? "ACP FAILURE DIAGNOSTIC SECRET 236"
      : "QUEUED ACP FAILURE SECRET 236"
  );
};

const app = agent({ name: "laborer-scripted-acp-peer" })
  .onRequest(methods.agent.initialize, async ({ params }) => {
    await recordLifecycle("initialize");
    if (params.protocolVersion !== PROTOCOL_VERSION || PROTOCOL_VERSION !== 1) {
      throw new Error("stable ACP v1 is required");
    }
    if (exitAfterInitializePath !== undefined) {
      setTimeout(() => {
        writeFile(exitAfterInitializePath, "exited", {
          flag: "wx",
          mode: 0o600,
        }).then(
          () => process.exit(23),
          () => undefined
        );
      }, 25);
    }
    return {
      agentCapabilities: {
        ...(!disablePromptEpochCapability &&
        isRecord(params.clientCapabilities?._meta) &&
        params.clientCapabilities._meta["laborer.dev/prompt-epoch/v1"] === true
          ? { _meta: { "laborer.dev/prompt-epoch/v1": true } }
          : {}),
        loadSession: false,
        promptCapabilities: { image: imagePromptCapability },
        sessionCapabilities: {
          close: {},
          ...(scriptedAgentName === "OpenCode" ? { list: {} } : {}),
          ...(durableSessionsPath === undefined || disableResumeCapability
            ? {}
            : { resume: {} }),
        },
      },
      agentInfo: { name: scriptedAgentName, version: scriptedAgentVersion },
      protocolVersion: PROTOCOL_VERSION,
    };
  })
  .onRequest(methods.agent.session.new, async ({ params, signal }) => {
    await recordSessionMethod("session/new", params);
    const store = await readDurableSessions();
    sessionCount =
      durableSessionsPath === undefined ? sessionCount + 1 : store.counter + 1;
    const sessionId = `${sessionIdPrefix}-${sessionCount}`;
    if (durableSessionsPath !== undefined) {
      await writeDurableSessions({
        counter: sessionCount,
        sessions: {
          ...store.sessions,
          [sessionId]: { cwd: params.cwd },
        },
      });
    }
    if (sessionRequestJsonlPath !== undefined) {
      await appendFile(sessionRequestJsonlPath, `${JSON.stringify(params)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    }
    if (rejectSessionWithMcp && params.mcpServers.length > 0) {
      throw new Error("scripted session/new rejected MCP configuration");
    }
    if (hangSessionWithMcp && params.mcpServers.length > 0) {
      await new Promise<void>((_resolve, reject) => {
        if (signal.aborted) {
          reject(new Error("scripted hanging session/new was cancelled"));
          return;
        }
        const onAbort = (): void => {
          signal.removeEventListener("abort", onAbort);
          reject(new Error("scripted hanging session/new was cancelled"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      });
    }
    sessions.add(sessionId);
    sessionMcpServers.set(sessionId, params.mcpServers);
    await recordLifecycle(`session:new:${sessionId}`);
    await registerMcpServers(params.mcpServers);
    if (sessionLogPath !== undefined) {
      await appendFile(sessionLogPath, `${sessionId}\t${params.cwd}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    }
    if (sessionCountPath !== undefined) {
      await writeFile(sessionCountPath, String(sessionCount), { mode: 0o600 });
    }
    const effectiveConfig =
      effectiveConfigJson === undefined
        ? {}
        : (JSON.parse(effectiveConfigJson) as Record<string, unknown>);
    return { ...effectiveConfig, sessionId };
  })
  .onRequest(methods.agent.session.list, async ({ params }) => {
    const store = await readDurableSessions();
    const listedSessions =
      resumeFailure === "opencode-missing-internal"
        ? []
        : Object.entries(store.sessions)
            .filter(([, session]) =>
              params.cwd === undefined ? true : session.cwd === params.cwd
            )
            .map(([sessionId, session]) => ({
              cwd: session.cwd,
              sessionId,
            }));
    return { sessions: listedSessions };
  })
  .onRequest(methods.agent.session.resume, async ({ client: peer, params }) => {
    await recordSessionMethod("session/resume", params);
    if (resumeFailure === "transport") {
      process.exit(41);
    }
    if (resumeFailure === "generic") {
      throw new Error("scripted generic resume failure");
    }
    if (
      resumeFailure === "opencode-missing-internal" ||
      resumeFailure === "opencode-generic-internal"
    ) {
      throw new RequestError(
        -32_603,
        "Internal error: OpenCode service failure",
        { service: "session" }
      );
    }
    const store = await readDurableSessions();
    sessionCount = store.counter;
    const durable = store.sessions[params.sessionId];
    if (
      resumeFailure === "unavailable" ||
      durable === undefined ||
      durable.cwd !== params.cwd
    ) {
      throw RequestError.invalidParams(
        { sessionId: params.sessionId },
        `session not found: ${params.sessionId}`
      );
    }
    if (resumeFailure === "standard-unavailable") {
      throw RequestError.resourceNotFound(params.sessionId);
    }
    if (resumeFailure === "standard-unavailable-no-data") {
      throw new RequestError(-32_002, "Resource not found", undefined);
    }
    if (resumeFailure === "standard-unavailable-wrong-uri") {
      throw new RequestError(
        -32_002,
        `Resource not found: ${params.sessionId}`,
        { uri: "different-session-241" }
      );
    }
    if (resumeFailure === "standard-unavailable-wrong-code") {
      throw new RequestError(
        -32_003,
        `Resource not found: ${params.sessionId}`,
        { uri: params.sessionId }
      );
    }
    if (resumeFailure === "standard-unavailable-wrong-message") {
      throw new RequestError(-32_002, "Different resource failure", {
        uri: params.sessionId,
      });
    }
    if (resumeFailure === "unavailable-wrong-id") {
      throw RequestError.invalidParams(
        { sessionId: "different-session-241" },
        `session not found: ${params.sessionId}`
      );
    }
    sessions.add(params.sessionId);
    sessionMcpServers.set(params.sessionId, params.mcpServers ?? []);
    await registerMcpServers(params.mcpServers ?? []);
    await recordLifecycle(`session:resume:${params.sessionId}`);
    if (replayOnResume) {
      await peer.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          content: { text: "HISTORICAL OUTPUT MUST NOT REPLAY", type: "text" },
          messageId: "historical-message-241",
          sessionUpdate: "agent_message_chunk",
        },
      });
    }
    if (delayedReplayMillis > 0) {
      setTimeout(() => {
        peer
          .notify(methods.client.session.update, {
            sessionId: params.sessionId,
            update: {
              content: {
                text: "DELAYED RESUME HISTORY MUST NOT REPLAY",
                type: "text",
              },
              messageId: "delayed-historical-message-241",
              sessionUpdate: "agent_message_chunk",
            },
          })
          .catch(() => undefined);
      }, delayedReplayMillis);
    }
    return effectiveConfigJson === undefined
      ? {}
      : (JSON.parse(effectiveConfigJson) as Record<string, unknown>);
  })
  .onRequest(methods.agent.session.close, async ({ params }) => {
    promptCancellations.get(params.sessionId)?.abort();
    promptCancellations.delete(params.sessionId);
    sessions.delete(params.sessionId);
    sessionMcpServers.delete(params.sessionId);
    await recordLifecycle(`session:close:${params.sessionId}`);
    if (closeSessionStartedPath !== undefined) {
      await writeFile(closeSessionStartedPath, params.sessionId, {
        mode: 0o600,
      });
    }
    if (closeSessionReleasePath !== undefined) {
      while (true) {
        try {
          await access(closeSessionReleasePath);
          break;
        } catch {
          await new Promise((resolveWait) => setTimeout(resolveWait, 10));
        }
      }
    }
    return {};
  })
  .onRequest(
    methods.agent.session.prompt,
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one scripted protocol dispatcher intentionally covers all fixture scenarios
    async ({ client: peer, params, signal }) => {
      if (promptContentJsonlPath !== undefined) {
        await appendFile(
          promptContentJsonlPath,
          `${JSON.stringify(params.prompt)}\n`,
          { encoding: "utf8", mode: 0o600 }
        );
      }
      await recordPromptAttempt({
        prompt: promptText(params.prompt),
        sessionId: params.sessionId,
      });
      if (
        !sessions.has(params.sessionId) ||
        promptCancellations.has(params.sessionId)
      ) {
        throw new Error("invalid scripted prompt lifecycle");
      }
      const cancellation = new AbortController();
      const cancelFromRequest = (): void => {
        cancellation.abort();
      };
      const disconnectPromptCancellation = connectPromptCancellation(
        signal,
        cancelFromRequest
      );
      promptCancellations.set(params.sessionId, cancellation);
      const notify = (update: SessionUpdate): Promise<void> =>
        peer.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update,
        });
      await runInitialMemoryOperations(params.sessionId, notify, (request) =>
        peer.request(methods.client.session.requestPermission, request)
      );
      await requestScriptedPermission({
        notify,
        request: (request) =>
          peer.request(methods.client.session.requestPermission, request),
        sessionId: params.sessionId,
      });
      promptCount += 1;
      await recordLifecycle(
        `prompt:${params.sessionId}:${promptText(params.prompt)}`
      );
      await recordAcceptedPrompt({
        prompt: promptText(params.prompt),
        sessionId: params.sessionId,
      });
      if (
        await shouldCrash(
          exitAfterPromptReceived,
          exitAfterPromptReceivedMarkerPath
        )
      ) {
        process.exit(42);
      }
      const currentAgentMessageId = await establishCurrentPromptEpoch({
        meta: params._meta,
        notify,
        prompt: params.prompt,
        promptNumber: promptCount,
      });
      try {
        process.stderr.write("ACP STDERR SECRET 234\n");
        if (scenario === "action") {
          return await runActionScenario({
            messageId: currentAgentMessageId,
            notify,
            prompt: params.prompt,
            request: (request) =>
              peer.request(methods.client.session.requestPermission, request),
            sessionId: params.sessionId,
          });
        }
        if (textlessStopReason !== null) {
          return {
            stopReason:
              textlessStopReason as import("@agentclientprotocol/sdk").PromptResponse["stopReason"],
          };
        }
        if (failingScenario !== null) {
          return await runFailingScenario(
            failingScenario,
            cancellation,
            notify
          );
        }
        if (publicOutputChunks !== null) {
          for (const [index, text] of publicOutputChunks.entries()) {
            await notify({
              content: { text, type: "text" },
              messageId: currentAgentMessageId,
              sessionUpdate: "agent_message_chunk",
            });
            if (index + 1 === pauseAfterPublicOutputChunk) {
              await writeFile(readyPath, "pending", { mode: 0o600 });
              if (!(await waitForRelease(cancellation.signal))) {
                return { stopReason: "cancelled" };
              }
            }
          }
          return {
            stopReason:
              publicOutputStopReason as import("@agentclientprotocol/sdk").PromptResponse["stopReason"],
          };
        }
        const fallbackStopReason = fallbackStopReasonFor(scenario);
        if (fallbackStopReason !== null) {
          return await runFallbackStopReason(fallbackStopReason, notify);
        }
        if (scenario === "semantics") {
          if (promptCount > 1) {
            await notify({
              content: { text: "Follow-up complete", type: "text" },
              messageId: "acp-follow-up-message-secret-236",
              sessionUpdate: "agent_message_chunk",
            });
            return { stopReason: "end_turn" };
          }
          await notify({
            content: { text: "", type: "text" },
            messageId: FIRST_MESSAGE_ID,
            sessionUpdate: "agent_message_chunk",
          });
          await notify({
            content: { text: "**First**", type: "text" },
            messageId: FIRST_MESSAGE_ID,
            sessionUpdate: "agent_message_chunk",
          });
          const privateUpdates = [
            {
              content: {
                text: "ACP USER ECHO SECRET 236",
                type: "text",
              },
              messageId: "acp-user-message-secret-236",
              sessionUpdate: "user_message_chunk",
            },
            {
              content: {
                text: "ACP THOUGHT SECRET 236",
                type: "text",
              },
              messageId: "acp-thought-message-secret-236",
              sessionUpdate: "agent_thought_chunk",
            },
            {
              entries: [
                {
                  content: "ACP PLAN SECRET 236",
                  priority: "high",
                  status: "pending",
                },
              ],
              sessionUpdate: "plan",
            },
            {
              rawInput: { secret: "ACP TOOL INPUT SECRET 236" },
              sessionUpdate: "tool_call",
              status: "pending",
              title: "ACP TOOL TITLE SECRET 236",
              toolCallId: "acp-tool-call-secret-236",
            },
            {
              rawOutput: { secret: "ACP TOOL OUTPUT SECRET 236" },
              sessionUpdate: "tool_call_update",
              status: "completed",
              toolCallId: "acp-tool-call-secret-236",
            },
            {
              availableCommands: [
                {
                  description: "ACP COMMAND SECRET 236",
                  name: "acp-command-secret-236",
                },
              ],
              sessionUpdate: "available_commands_update",
            },
            {
              currentModeId: "acp-mode-secret-236",
              sessionUpdate: "current_mode_update",
            },
            {
              configOptions: [],
              sessionUpdate: "config_option_update",
            },
            {
              _meta: { secret: "ACP PROTOCOL METADATA SECRET 236" },
              sessionUpdate: "session_info_update",
              title: "ACP SESSION TITLE SECRET 236",
            },
            {
              cost: { amount: 236, currency: "USD" },
              sessionUpdate: "usage_update",
              size: 236_000,
              used: 236,
            },
          ] as const satisfies readonly SessionUpdate[];
          for (const update of privateUpdates) {
            await notify(update);
          }
          await notify({
            content: { text: " message", type: "text" },
            messageId: FIRST_MESSAGE_ID,
            sessionUpdate: "agent_message_chunk",
          });
          await notify({
            content: { text: "", type: "text" },
            messageId: FIRST_MESSAGE_ID,
            sessionUpdate: "agent_message_chunk",
          });
          await notify({
            content: { text: "Second message", type: "text" },
            messageId: SECOND_MESSAGE_ID,
            sessionUpdate: "agent_message_chunk",
          });
          await notify({
            _meta: { secret: "ACP CHUNK METADATA SECRET 236" },
            content: { text: "Fallback ", type: "text" },
            sessionUpdate: "agent_message_chunk",
          });
          await notify({
            content: { text: "ACP LATE THOUGHT SECRET 236", type: "text" },
            sessionUpdate: "agent_thought_chunk",
          });
          await notify({
            content: { text: "message", type: "text" },
            sessionUpdate: "agent_message_chunk",
          });
          await writeFile(readyPath, "pending", { mode: 0o600 });
          if (!(await waitForRelease(cancellation.signal))) {
            return { stopReason: "cancelled" };
          }
          return { stopReason: "end_turn" };
        }
        await notify({
          content: { text: "", type: "text" },
          messageId: currentAgentMessageId,
          sessionUpdate: "agent_message_chunk",
        });
        await notify({
          content: {
            text: initialPublicOutput,
            type: "text",
          },
          messageId: currentAgentMessageId,
          sessionUpdate: "agent_message_chunk",
        });
        if (cancelAfterPublicChunk) {
          return { stopReason: "cancelled" };
        }
        if (
          await shouldCrash(
            exitAfterFirstPublicChunk,
            exitAfterFirstPublicChunkMarkerPath
          )
        ) {
          process.exit(43);
        }
        await notify({
          content: { text: "INTERNAL THOUGHT SECRET 234", type: "text" },
          messageId: "acp-thought-secret-234",
          sessionUpdate: "agent_thought_chunk",
        });
        await writeFile(readyPath, "pending", { mode: 0o600 });
        if (!(await waitForRelease(cancellation.signal))) {
          if (cancelledPath !== undefined) {
            await writeFile(cancelledPath, "cancelled", { mode: 0o600 });
          }
          return { stopReason: "cancelled" };
        }
        await notify({
          content: {
            text: completedPublicOutput,
            type: "text",
          },
          messageId: currentAgentMessageId,
          sessionUpdate: "agent_message_chunk",
        });
        if (postPromptReplayMillis > 0) {
          setTimeout(() => {
            peer
              .notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                  content: {
                    text: "POST PROMPT HISTORY MUST NOT REPLAY",
                    type: "text",
                  },
                  messageId: "post-prompt-history-241",
                  sessionUpdate: "agent_message_chunk",
                },
              })
              .catch(() => undefined);
          }, postPromptReplayMillis);
        }
        return { stopReason: "end_turn" };
      } finally {
        disconnectPromptCancellation();
        promptCancellations.delete(params.sessionId);
      }
    }
  )
  .onNotification(methods.agent.session.cancel, async ({ params }) => {
    if (sessionCancelJsonlPath !== undefined) {
      await appendFile(
        sessionCancelJsonlPath,
        `${JSON.stringify({ sessionId: params.sessionId })}\n`,
        { mode: 0o600 }
      );
    }
    if (!ignorePromptCancellation) {
      promptCancellations.get(params.sessionId)?.abort();
    }
  });

const output = Writable.toWeb(process.stdout);
const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
const connection = app.connect(ndJsonStream(output, input));
process.stdin.resume();
await connection.closed;
await Promise.all(
  [...registeredMcpClients.values()].map(({ client: mcpClient }) =>
    mcpClient.close().catch(() => undefined)
  )
);
if (sessionRemainderPath !== undefined) {
  await writeFile(sessionRemainderPath, String(sessions.size), { mode: 0o600 });
}
await recordLifecycle("stdio:closed");
if (stayAliveAfterStdioClose) {
  await new Promise<void>(() => {
    setInterval(() => undefined, 1000);
  });
}
if (exitPath !== undefined) {
  await writeFile(exitPath, "exited", { mode: 0o600 });
}
