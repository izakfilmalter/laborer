#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { access, appendFile, writeFile } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import {
  agent,
  type McpServer,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Array as EffectArray, pipe } from "effect";

const MESSAGE_ID = "acp-message-secret-234";
const FIRST_MESSAGE_ID = "acp-first-message-secret-236";
const SECOND_MESSAGE_ID = "acp-second-message-secret-236";
const readyPath = process.env.SCRIPTED_ACP_READY_PATH;
const releasePath = process.env.SCRIPTED_ACP_RELEASE_PATH;
const cancelledPath = process.env.SCRIPTED_ACP_CANCELLED_PATH;
const exitPath = process.env.SCRIPTED_ACP_EXIT_PATH;
const pidPath = process.env.SCRIPTED_ACP_PID_PATH;
const promptLogPath = process.env.SCRIPTED_ACP_PROMPT_LOG_PATH;
const promptJsonlPath = process.env.SCRIPTED_ACP_PROMPT_JSONL_PATH;
const sessionRequestJsonlPath =
  process.env.SCRIPTED_ACP_SESSION_REQUEST_JSONL_PATH;
const permissionTitle = process.env.SCRIPTED_ACP_PERMISSION_TITLE;
const permissionToolIdentity =
  process.env.SCRIPTED_ACP_PERMISSION_TOOL_IDENTITY;
const permissionToolName = process.env.SCRIPTED_ACP_PERMISSION_TOOL_NAME;
const permissionResultPath = process.env.SCRIPTED_ACP_PERMISSION_RESULT_PATH;
const memoryOperationJson = process.env.SCRIPTED_ACP_MEMORY_OPERATION_JSON;
const memoryOperationEveryPrompt =
  process.env.SCRIPTED_ACP_MEMORY_OPERATION_EVERY_PROMPT === "1";
const memoryFailureOperationJson =
  process.env.SCRIPTED_ACP_MEMORY_FAILURE_OPERATION_JSON;
const memoryDiagnosticPath = process.env.SCRIPTED_ACP_MEMORY_DIAGNOSTIC_PATH;
const memoryActivityJsonlPath =
  process.env.SCRIPTED_ACP_MEMORY_ACTIVITY_JSONL_PATH;
const rejectSessionWithMcp =
  process.env.SCRIPTED_ACP_REJECT_SESSION_WITH_MCP === "1";
const skipMcpRegistration =
  process.env.SCRIPTED_ACP_SKIP_MCP_REGISTRATION === "1";
const collideMcpRegistration =
  process.env.SCRIPTED_ACP_COLLIDE_MCP_REGISTRATION === "1";
const lifecycleLogPath = process.env.SCRIPTED_ACP_LIFECYCLE_LOG_PATH;
const sessionLogPath = process.env.SCRIPTED_ACP_SESSION_LOG_PATH;
const signalLogPath = process.env.SCRIPTED_ACP_SIGNAL_LOG_PATH;
const exitAfterInitializePath =
  process.env.SCRIPTED_ACP_EXIT_AFTER_INITIALIZE_PATH;
const stayAliveAfterStdioClose =
  process.env.SCRIPTED_ACP_STAY_ALIVE_AFTER_STDIO_CLOSE === "1";
const scenario = process.env.SCRIPTED_ACP_SCENARIO ?? "stream";
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
if (stayAliveAfterStdioClose) {
  process.on("SIGTERM", () => {
    if (signalLogPath !== undefined) {
      appendFileSync(signalLogPath, "SIGTERM\n", { mode: 0o600 });
    }
  });
}

const sessions = new Set<string>();
const sessionMcpServers = new Map<string, readonly McpServer[]>();
const registeredMcpClients = new Map<
  string,
  { readonly client: Client; readonly diagnostics: Buffer[] }
>();
const promptCancellations = new Map<string, AbortController>();
let sessionCount = 0;
let promptCount = 0;

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

type NotifySessionUpdate = (update: SessionUpdate) => Promise<void>;

const runMemoryOperation = async (options: {
  readonly callId: string;
  readonly notify: NotifySessionUpdate;
  readonly operationJson: string;
  readonly sessionId: string;
}): Promise<void> => {
  const stdioServer = sessionMcpServers
    .get(options.sessionId)
    ?.find((server) => !("type" in server));
  if (stdioServer === undefined || "type" in stdioServer) {
    throw new Error("scripted memory scenario requires a stdio MCP server");
  }
  const operation: unknown = JSON.parse(options.operationJson);
  if (!isRecord(operation)) {
    throw new Error("scripted memory operation must be an object");
  }
  const registered = registeredMcpClients.get(stdioServer.name);
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
    await emitPrivateUpdate({
      rawInput: {
        operation,
        secret: "LABORER MEMORY TOOL INPUT SECRET 240",
      },
      sessionUpdate: "tool_call",
      status: "pending",
      title: "LABORER MEMORY TOOL SECRET 240",
      toolCallId: options.callId,
    });
    const result = await registered.client.callTool({
      arguments: operation,
      name: "memory",
    });
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
  notify: NotifySessionUpdate
): Promise<void> => {
  if (!memoryOperationEveryPrompt && promptCount !== 0) {
    return;
  }
  if (memoryOperationJson !== undefined) {
    await runMemoryOperation({
      callId: "laborer-memory-success-240",
      notify,
      operationJson: memoryOperationJson,
      sessionId,
    });
  }
  if (memoryFailureOperationJson !== undefined) {
    await runMemoryOperation({
      callId: "laborer-memory-failure-240",
      notify,
      operationJson: memoryFailureOperationJson,
      sessionId,
    });
  }
};

const collideWithMcpReadiness = async (
  environment: Readonly<Record<string, string>>
): Promise<void> => {
  if (!collideMcpRegistration) {
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
  if (skipMcpRegistration) {
    return;
  }
  for (const server of mcpServers) {
    if ("type" in server) {
      continue;
    }
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
    await mcpClient.connect(transport);
    const previous = registeredMcpClients.get(server.name);
    registeredMcpClients.set(server.name, { client: mcpClient, diagnostics });
    await previous?.client.close();
    await collideWithMcpReadiness(environment);
  }
};

const requestScriptedPermission = async (options: {
  readonly notify: NotifySessionUpdate;
  readonly request: (
    request: RequestPermissionRequest
  ) => Promise<RequestPermissionResponse>;
  readonly sessionId: string;
}): Promise<void> => {
  if (permissionTitle === undefined || permissionResultPath === undefined) {
    return;
  }
  if (permissionToolIdentity !== undefined) {
    const attachedMemoryServer = sessionMcpServers
      .get(options.sessionId)
      ?.find((server) => !("type" in server));
    const exactToolIdentity =
      permissionToolIdentity === "attached-memory" &&
      attachedMemoryServer !== undefined
        ? `${attachedMemoryServer.name}_memory`
        : permissionToolIdentity;
    await options.notify({
      kind: "other",
      sessionUpdate: "tool_call",
      status: "pending",
      title: exactToolIdentity,
      toolCallId: "scripted-permission",
    });
  }
  const permission = await options.request({
    options: [
      {
        kind: "allow_once",
        name: "Allow once",
        optionId: "scripted-allow-once",
      },
    ],
    sessionId: options.sessionId,
    toolCall: {
      kind: "other",
      ...(permissionToolName === undefined ? {} : { name: permissionToolName }),
      status: "pending",
      title: permissionTitle,
      toolCallId: "scripted-permission",
    },
  });
  await writeFile(permissionResultPath, JSON.stringify(permission), {
    mode: 0o600,
  });
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
        writeFile(exitAfterInitializePath, "exited", { mode: 0o600 }).then(
          () => process.exit(23),
          () => process.exit(24)
        );
      }, 25);
    }
    return {
      agentCapabilities: { loadSession: false },
      protocolVersion: PROTOCOL_VERSION,
    };
  })
  .onRequest(methods.agent.session.new, async ({ params }) => {
    sessionCount += 1;
    const sessionId = `acp-session-secret-234-${sessionCount}`;
    sessions.add(sessionId);
    sessionMcpServers.set(sessionId, params.mcpServers);
    await recordLifecycle(`session:new:${sessionId}`);
    if (sessionRequestJsonlPath !== undefined) {
      await appendFile(sessionRequestJsonlPath, `${JSON.stringify(params)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    }
    if (rejectSessionWithMcp && params.mcpServers.length > 0) {
      throw new Error("scripted session/new rejected MCP configuration");
    }
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
    return { sessionId };
  })
  .onRequest(
    methods.agent.session.prompt,
    async ({ client: peer, params, signal }) => {
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
      signal.addEventListener("abort", cancelFromRequest, { once: true });
      promptCancellations.set(params.sessionId, cancellation);
      const notify = (update: SessionUpdate): Promise<void> =>
        peer.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update,
        });
      await runInitialMemoryOperations(params.sessionId, notify);
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
      if (promptLogPath !== undefined) {
        await appendFile(
          promptLogPath,
          `${params.sessionId}\t${promptText(params.prompt)}\n`,
          { encoding: "utf8", mode: 0o600 }
        );
      }
      if (promptJsonlPath !== undefined) {
        await appendFile(
          promptJsonlPath,
          `${JSON.stringify({
            prompt: promptText(params.prompt),
            sessionId: params.sessionId,
          })}\n`,
          { encoding: "utf8", mode: 0o600 }
        );
      }
      try {
        process.stderr.write("ACP STDERR SECRET 234\n");
        if (failingScenario !== null) {
          return await runFailingScenario(
            failingScenario,
            cancellation,
            notify
          );
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
          messageId: MESSAGE_ID,
          sessionUpdate: "agent_message_chunk",
        });
        await notify({
          content: { text: "**Streaming** from ACP", type: "text" },
          messageId: MESSAGE_ID,
          sessionUpdate: "agent_message_chunk",
        });
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
            text: "\n\n- complete\n- unchanged",
            type: "text",
          },
          messageId: MESSAGE_ID,
          sessionUpdate: "agent_message_chunk",
        });
        return { stopReason: "end_turn" };
      } finally {
        signal.removeEventListener("abort", cancelFromRequest);
        promptCancellations.delete(params.sessionId);
      }
    }
  )
  .onNotification(methods.agent.session.cancel, ({ params }) => {
    promptCancellations.get(params.sessionId)?.abort();
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
await recordLifecycle("stdio:closed");
if (stayAliveAfterStdioClose) {
  await new Promise<void>(() => {
    setInterval(() => undefined, 1000);
  });
}
if (exitPath !== undefined) {
  await writeFile(exitPath, "exited", { mode: 0o600 });
}
