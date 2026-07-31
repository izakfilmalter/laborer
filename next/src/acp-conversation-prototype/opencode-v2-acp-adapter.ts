#!/usr/bin/env bun

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import {
  agent,
  type ContentBlock,
  type McpServer,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type SessionNotification,
  type ToolCall,
} from "@agentclientprotocol/sdk";
import { make as makeOpenCodeClient } from "../../node_modules/@opencode-ai/client/dist/promise/generated/client.js";
import type {
  AgentInfo,
  EventSubscribeOutput,
  McpServer as OpenCodeMcpServer,
  SessionInfo,
  SessionMessageAssistant,
} from "../../node_modules/@opencode-ai/client/dist/promise/generated/types.js";
import { OPEN_CODE_COMMAND } from "./open-code-acp-process.ts";

const OPEN_CODE_VERSION = "0.0.0-next-16573";
const STARTUP_TIMEOUT_MILLIS = 30_000;
const SHUTDOWN_TIMEOUT_MILLIS = 3000;
const MAX_STARTUP_LINE_BYTES = 64 * 1024;

interface AttachedSession {
  readonly cwd: string;
  readonly id: string;
}

interface TurnControl {
  readonly admission: AbortController;
  cancelled: boolean;
}

interface ToolState {
  input: Record<string, unknown>;
  name: string;
}

interface RunningServer {
  readonly child: ChildProcessWithoutNullStreams;
  readonly client: ReturnType<typeof makeOpenCodeClient>;
  readonly close: () => Promise<void>;
  readonly closed: Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const messageId = (): string =>
  `msg_${Date.now().toString(16).padStart(12, "0").slice(-12)}${randomBytes(10)
    .toString("base64url")
    .slice(0, 14)}`;

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

const stopChild = async (
  child: ChildProcessWithoutNullStreams
): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.stdin.end();
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve())
  );
  const graceful = await Promise.race([
    exited.then(() => true),
    sleep(SHUTDOWN_TIMEOUT_MILLIS).then(() => false),
  ]);
  if (graceful) {
    return;
  }
  child.kill("SIGTERM");
  const terminated = await Promise.race([
    exited.then(() => true),
    sleep(SHUTDOWN_TIMEOUT_MILLIS).then(() => false),
  ]);
  if (!terminated) {
    child.kill("SIGKILL");
    await exited;
  }
};

const readReadinessUrl = async (
  child: ChildProcessWithoutNullStreams
): Promise<string> => {
  let buffered = Buffer.alloc(0);
  for await (const chunk of child.stdout) {
    buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
    if (buffered.byteLength > MAX_STARTUP_LINE_BYTES) {
      throw new Error("OpenCode startup record exceeded the limit");
    }
    const newline = buffered.indexOf(0x0a);
    if (newline < 0) {
      continue;
    }
    const parsed: unknown = JSON.parse(
      buffered.subarray(0, newline).toString("utf8")
    );
    if (!(isRecord(parsed) && typeof parsed.url === "string")) {
      throw new Error("OpenCode returned an invalid startup record");
    }
    return parsed.url;
  }
  throw new Error("OpenCode exited before reporting readiness");
};

const startServer = async (): Promise<RunningServer> => {
  const password = randomBytes(32).toString("base64url");
  const child = spawn(OPEN_CODE_COMMAND, ["serve", "--stdio", "--port", "0"], {
    cwd: process.cwd(),
    env: { ...process.env, OPENCODE_PASSWORD: password },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = new Promise<void>((resolveClosed) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveClosed();
      return;
    }
    child.once("exit", () => resolveClosed());
  });
  child.stderr.resume();
  const url = await Promise.race([
    readReadinessUrl(child),
    sleep(STARTUP_TIMEOUT_MILLIS).then(() => {
      throw new Error("OpenCode server startup timed out");
    }),
  ]).catch(async (cause) => {
    await stopChild(child);
    throw cause;
  });
  child.stdout.resume();
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  return {
    child,
    client: makeOpenCodeClient({ baseUrl: url, headers: { authorization } }),
    close: () => stopChild(child),
    closed,
  };
};

const mcpConfig = (server: McpServer) => {
  if ("type" in server) {
    if (server.type === "acp") {
      throw new Error("MCP-over-ACP is not supported");
    }
    return {
      codemode: false,
      headers: Object.fromEntries(
        server.headers.map((header) => [header.name, header.value])
      ),
      oauth: false as const,
      type: "remote" as const,
      url: server.url,
    };
  }
  return {
    codemode: false,
    command: [server.command, ...server.args],
    environment: Object.fromEntries(
      server.env.map((entry) => [entry.name, entry.value])
    ),
    type: "local" as const,
  };
};

const toolKind = (name: string): NonNullable<ToolCall["kind"]> => {
  switch (name.toLowerCase()) {
    case "bash":
    case "shell":
      return "execute";
    case "read":
      return "read";
    case "edit":
    case "patch":
    case "write":
      return "edit";
    case "glob":
    case "grep":
      return "search";
    case "webfetch":
      return "fetch";
    default:
      return "other";
  }
};

const pendingToolCall = (
  callId: string,
  name: string,
  input: Record<string, unknown>
): ToolCall => ({
  kind: toolKind(name),
  name,
  rawInput: input,
  status: "pending",
  title: name,
  toolCallId: callId,
});

const contentText = (content: readonly unknown[]): string =>
  content
    .flatMap((part) =>
      isRecord(part) && typeof part.text === "string" ? [part.text] : []
    )
    .join("");

const promptParts = (blocks: readonly ContentBlock[]) => {
  const text: string[] = [];
  const files: Array<{ name?: string; uri: string }> = [];
  for (const block of blocks) {
    if (block.type === "text") {
      text.push(block.text);
      continue;
    }
    if (block.type === "image") {
      if (block.data) {
        files.push({ uri: `data:${block.mimeType};base64,${block.data}` });
      } else if (block.uri) {
        files.push({ uri: block.uri });
      }
      continue;
    }
    if (block.type === "resource_link") {
      files.push({
        name: block.name,
        uri: block.uri,
      });
      continue;
    }
    if (block.type === "resource" && "text" in block.resource) {
      text.push(block.resource.text);
    }
  }
  return { files, text: text.join("\n") };
};

const stopReasonFor = (
  terminal: "failed" | "interrupted" | "succeeded",
  cancelled: boolean,
  finish: SessionMessageAssistant["finish"]
) => {
  if (cancelled || terminal === "interrupted") {
    return "cancelled" as const;
  }
  if (finish === "length") {
    return "max_tokens" as const;
  }
  if (finish === "content-filter") {
    return "refusal" as const;
  }
  return "end_turn" as const;
};

const responseFor = (
  terminal: "failed" | "interrupted" | "succeeded",
  cancelled: boolean,
  finish: SessionMessageAssistant["finish"]
) => ({ _meta: {}, stopReason: stopReasonFor(terminal, cancelled, finish) });

const assertMatchingCwd = async (
  requested: string,
  persisted: string,
  sessionId: string
): Promise<void> => {
  const [requestedRoot, persistedRoot] = await Promise.all([
    realpath(requested),
    realpath(persisted),
  ]).catch(() => {
    throw RequestError.resourceNotFound(sessionId);
  });
  if (requestedRoot !== persistedRoot) {
    throw RequestError.resourceNotFound(sessionId);
  }
};

const run = async (): Promise<void> => {
  const server = await startServer();
  const sessions = new Map<string, AttachedSession>();
  const active = new Map<string, TurnControl>();
  const ownedMcpNames = new Set<string>();

  const registerMcpServers = async (
    session: AttachedSession,
    servers: readonly McpServer[]
  ): Promise<void> => {
    const location = { directory: session.cwd };
    const existing = await server.client.mcp.list({ location });
    for (const registration of servers) {
      if (
        existing.data.some(
          (candidate: OpenCodeMcpServer) => candidate.name === registration.name
        ) &&
        !ownedMcpNames.has(registration.name)
      ) {
        throw new Error(
          `MCP registration name is already configured: ${registration.name}`
        );
      }
      await server.client.mcp.add({
        config: mcpConfig(registration),
        location,
        server: registration.name,
      });
      ownedMcpNames.add(registration.name);
    }
  };

  let connection: ReturnType<ReturnType<typeof agent>["connect"]> | undefined;

  const streamTurn = async (
    session: AttachedSession,
    prompt: readonly ContentBlock[],
    meta: Record<string, unknown> | undefined,
    peer: {
      requestPermission: (input: {
        options: Array<{
          kind: "allow_always" | "allow_once" | "reject_once";
          name: string;
          optionId: string;
        }>;
        sessionId: string;
        toolCall: ToolCall;
      }) => Promise<{ outcome: { optionId?: string; outcome: string } }>;
      sessionUpdate: (input: SessionNotification) => Promise<unknown>;
    }
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this coordinates one bounded turn lifecycle around the event dispatcher
  ) => {
    const control: TurnControl = {
      admission: new AbortController(),
      cancelled: false,
    };
    if (active.has(session.id)) {
      throw new Error("Session already has an active prompt");
    }
    active.set(session.id, control);
    const streamController = new AbortController();
    const stream = server.client.event
      .subscribe({ signal: streamController.signal })
      [Symbol.asyncIterator]();
    try {
      const connected = await stream.next();
      if (connected.done) {
        throw new Error(
          "OpenCode event stream disconnected before prompt admission"
        );
      }
    } catch (cause) {
      active.delete(session.id);
      streamController.abort();
      await stream.return?.(undefined).catch(() => undefined);
      throw cause;
    }
    const promptId = messageId();
    const epoch = meta?.["laborer.dev/prompt-epoch"];
    if (typeof epoch === "string") {
      await peer.sessionUpdate({
        sessionId: session.id,
        update: {
          _meta: { "laborer.dev/prompt-epoch": epoch },
          content: { text: "", type: "text" },
          messageId: promptId,
          sessionUpdate: "user_message_chunk",
        },
      });
    }
    let started = false;
    let finish: SessionMessageAssistant["finish"];
    let executionError:
      | { readonly message: string; readonly type: string }
      | undefined;
    const tools = new Map<string, ToolState>();
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one bounded protocol dispatcher keeps OpenCode event ordering explicit
    const consume = async () => {
      while (!streamController.signal.aborted) {
        const next = await stream.next();
        if (next.done) {
          throw new Error(
            "OpenCode event stream disconnected during prompt execution"
          );
        }
        const event: EventSubscribeOutput = next.value;
        if (
          event.type === "permission.asked" &&
          event.data.sessionID === session.id
        ) {
          const tool = event.data.source?.callID
            ? tools.get(event.data.source.callID)
            : undefined;
          const toolName = tool?.name ?? event.data.action;
          const toolInput = { ...event.data.metadata, ...tool?.input };
          const result = await peer
            .requestPermission({
              options: [
                { kind: "allow_once", name: "Allow once", optionId: "once" },
                {
                  kind: "allow_always",
                  name: "Always allow",
                  optionId: "always",
                },
                { kind: "reject_once", name: "Reject", optionId: "reject" },
              ],
              sessionId: session.id,
              toolCall: pendingToolCall(
                event.data.source?.callID ?? event.data.id,
                toolName,
                toolInput
              ),
            })
            .catch(() => undefined);
          const option =
            result?.outcome.outcome === "selected"
              ? result.outcome.optionId
              : undefined;
          await server.client.permission.reply({
            reply: option === "once" || option === "always" ? option : "reject",
            requestID: event.data.id,
            sessionID: session.id,
          });
          continue;
        }
        if (
          event.type === "form.created" &&
          event.data.form.sessionID === session.id
        ) {
          await server.client.form
            .cancel({ formID: event.data.form.id, sessionID: session.id })
            .catch(() =>
              server.client.session
                .interrupt({ sessionID: session.id })
                .catch(() => undefined)
            );
          continue;
        }
        if (
          !("sessionID" in event.data) ||
          event.data.sessionID !== session.id
        ) {
          continue;
        }
        if (
          event.type === "session.input.promoted" &&
          event.data.inputID === promptId
        ) {
          started = true;
          continue;
        }
        if (!started) {
          continue;
        }
        if (event.type === "session.text.delta") {
          await peer.sessionUpdate({
            sessionId: session.id,
            update: {
              content: { text: event.data.delta, type: "text" },
              messageId: event.data.assistantMessageID,
              sessionUpdate: "agent_message_chunk",
            },
          });
        } else if (event.type === "session.reasoning.delta") {
          await peer.sessionUpdate({
            sessionId: session.id,
            update: {
              content: { text: event.data.delta, type: "text" },
              messageId: event.data.assistantMessageID,
              sessionUpdate: "agent_thought_chunk",
            },
          });
        } else if (event.type === "session.tool.input.started") {
          tools.set(event.data.callID, { input: {}, name: event.data.name });
        } else if (event.type === "session.tool.called") {
          const current = tools.get(event.data.callID) ?? {
            input: {},
            name: "tool",
          };
          current.input = event.data.input;
          tools.set(event.data.callID, current);
          await peer.sessionUpdate({
            sessionId: session.id,
            update: {
              ...pendingToolCall(
                event.data.callID,
                current.name,
                current.input
              ),
              sessionUpdate: "tool_call",
            },
          });
        } else if (event.type === "session.tool.success") {
          tools.delete(event.data.callID);
          await peer.sessionUpdate({
            sessionId: session.id,
            update: {
              content: event.data.content.length
                ? [
                    {
                      content: {
                        text: contentText(event.data.content),
                        type: "text",
                      },
                      type: "content",
                    },
                  ]
                : [],
              rawOutput: { metadata: event.data.metadata ?? {} },
              status: "completed",
              toolCallId: event.data.callID,
              sessionUpdate: "tool_call_update",
            },
          });
        } else if (event.type === "session.tool.failed") {
          tools.delete(event.data.callID);
          await peer.sessionUpdate({
            sessionId: session.id,
            update: {
              rawOutput: { error: event.data.error.message },
              status: "failed",
              toolCallId: event.data.callID,
              sessionUpdate: "tool_call_update",
            },
          });
        } else if (event.type === "session.step.ended") {
          finish = event.data.finish;
        } else if (event.type === "session.execution.succeeded") {
          return "succeeded";
        } else if (event.type === "session.execution.interrupted") {
          return "interrupted";
        } else if (event.type === "session.execution.failed") {
          executionError = event.data.error;
          return "failed";
        }
      }
      return "interrupted";
    };
    const completed = consume();
    try {
      const parts = promptParts(prompt);
      await server.client.session
        .prompt(
          {
            delivery: "steer",
            files: parts.files,
            id: promptId,
            sessionID: session.id,
            text: parts.text,
          },
          { signal: control.admission.signal }
        )
        .catch((cause) => {
          if (!control.cancelled) {
            throw cause;
          }
        });
      if (control.cancelled) {
        await server.client.session
          .interrupt({ sessionID: session.id })
          .catch(() => undefined);
        if (!started) {
          streamController.abort();
          await completed.catch(() => undefined);
          return responseFor("interrupted", true, undefined);
        }
      }
      const terminal = await completed;
      if (terminal === "failed") {
        if (executionError?.type === "provider.auth") {
          throw RequestError.authRequired();
        }
        if (executionError?.type === "provider.content-filter") {
          return responseFor(terminal, control.cancelled, "content-filter");
        }
        throw new Error(executionError?.message || "OpenCode prompt failed");
      }
      return responseFor(terminal, control.cancelled, finish);
    } finally {
      active.delete(session.id);
      streamController.abort();
      await stream.return?.(undefined).catch(() => undefined);
    }
  };

  const app = agent({ name: "laborer-opencode-v2-acp-adapter" })
    .onRequest(methods.agent.initialize, ({ params }) => {
      if (params.protocolVersion !== PROTOCOL_VERSION) {
        throw RequestError.invalidParams("stable ACP v1 is required");
      }
      return {
        agentCapabilities: {
          _meta:
            params.clientCapabilities?._meta?.[
              "laborer.dev/prompt-epoch/v1"
            ] === true
              ? { "laborer.dev/prompt-epoch/v1": true }
              : {},
          loadSession: false,
          mcpCapabilities: { http: true, sse: false },
          promptCapabilities: { embeddedContext: true, image: true },
          sessionCapabilities: {
            close: {},
            list: {},
            resume: {},
          },
        },
        agentInfo: { name: "OpenCode", version: OPEN_CODE_VERSION },
        protocolVersion: PROTOCOL_VERSION,
      };
    })
    .onRequest(methods.agent.session.new, async ({ params }) => {
      const location = { directory: params.cwd };
      const [defaultModel, agents] = await Promise.all([
        server.client.model.default({ location }),
        server.client.agent.list({ location }),
      ]);
      const primary = agents.data.find(
        (candidate: AgentInfo) =>
          candidate.mode === "primary" && !candidate.hidden
      );
      const created = await server.client.session.create({
        ...(primary ? { agent: primary.id } : {}),
        ...(defaultModel.data ? { model: defaultModel.data } : {}),
        location,
      });
      const session = { cwd: params.cwd, id: created.id };
      await registerMcpServers(session, params.mcpServers);
      sessions.set(session.id, session);
      return { sessionId: session.id };
    })
    .onRequest(methods.agent.session.resume, async ({ params }) => {
      let restored: SessionInfo;
      try {
        restored = await server.client.session.get({
          sessionID: params.sessionId,
        });
      } catch {
        throw RequestError.resourceNotFound(params.sessionId);
      }
      const session = { cwd: restored.location.directory, id: restored.id };
      await assertMatchingCwd(params.cwd, session.cwd, params.sessionId);
      await registerMcpServers(session, params.mcpServers ?? []);
      sessions.set(session.id, session);
      return {};
    })
    .onRequest(methods.agent.session.list, async ({ params }) => {
      const listed = await server.client.session.list({
        ...(params.cursor ? { cursor: params.cursor } : {}),
        ...(params.cwd ? { directory: params.cwd } : {}),
        limit: 100,
        order: "desc",
      });
      return {
        ...(listed.cursor.next ? { nextCursor: listed.cursor.next } : {}),
        sessions: listed.data.map((session: SessionInfo) => ({
          cwd: session.location.directory,
          sessionId: session.id,
        })),
      };
    })
    .onRequest(methods.agent.session.close, async ({ params }) => {
      sessions.delete(params.sessionId);
      const turn = active.get(params.sessionId);
      if (turn) {
        turn.cancelled = true;
        turn.admission.abort();
      }
      await server.client.session
        .interrupt({ sessionID: params.sessionId })
        .catch(() => undefined);
      return {};
    })
    .onRequest(methods.agent.session.prompt, ({ client: peer, params }) => {
      const session = sessions.get(params.sessionId);
      if (!session) {
        throw RequestError.resourceNotFound(params.sessionId);
      }
      return streamTurn(
        session,
        params.prompt,
        isRecord(params._meta) ? params._meta : undefined,
        {
          requestPermission: (input) =>
            peer.request(methods.client.session.requestPermission, input),
          sessionUpdate: (input) =>
            peer.notify(methods.client.session.update, input),
        }
      );
    })
    .onNotification(methods.agent.session.cancel, async ({ params }) => {
      const turn = active.get(params.sessionId);
      if (turn) {
        turn.cancelled = true;
        turn.admission.abort();
      }
      await server.client.session
        .interrupt({ sessionID: params.sessionId })
        .catch(() => undefined);
    });

  try {
    connection = app.connect(
      ndJsonStream(
        Writable.toWeb(process.stdout),
        Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
      )
    );
    await Promise.race([
      connection.closed,
      server.closed.then(() => {
        throw new Error("OpenCode server exited unexpectedly");
      }),
    ]);
  } finally {
    connection?.close();
    await server.close();
  }
};

run().catch((cause) => {
  const message =
    cause instanceof Error ? cause.message : "unknown adapter failure";
  process.stderr.write(`OpenCode ACP adapter failed: ${message}\n`);
  process.exitCode = 1;
});
