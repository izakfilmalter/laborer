#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { access, appendFile, writeFile } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
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

type NotifySessionUpdate = (update: SessionUpdate) => Promise<void>;

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
    await recordLifecycle(`session:new:${sessionId}`);
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
      const notify = (update: SessionUpdate): Promise<void> =>
        peer.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update,
        });
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
await recordLifecycle("stdio:closed");
if (stayAliveAfterStdioClose) {
  await new Promise<void>(() => {
    setInterval(() => undefined, 1000);
  });
}
if (exitPath !== undefined) {
  await writeFile(exitPath, "exited", { mode: 0o600 });
}
