import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PROTOCOL_VERSION, type StopReason } from "@agentclientprotocol/sdk";
import { assert, describe, it } from "@effect/vitest";
import { SUPPORTED_ACP_RUNTIME_MATRIX } from "../src/acp-compatibility/runtime-matrix.ts";
import { startFakeOpenAiProvider } from "./support/fake-openai-provider.ts";
import {
  readLocalOpenCodeVersion,
  startOpenCodeAcpHarness,
} from "./support/opencode-acp-harness.ts";

const MCP_FIXTURE_PATH = resolve(
  process.cwd(),
  "tests/fixtures/acp-compatibility-mcp-server.ts"
);
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const recordFrom = (
  value: unknown
): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;

const contentText = (content: unknown): string => {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map(contentText).join("");
  }
  const record = recordFrom(content);
  return record === null
    ? ""
    : [record.text, record.content].map(contentText).join("");
};

const modelMessages = (
  requestBody: unknown
): readonly { readonly role: string; readonly text: string }[] => {
  const messages = recordFrom(requestBody)?.messages;
  if (!Array.isArray(messages)) {
    throw new Error("OpenCode provider request omitted messages");
  }
  return messages.flatMap((message) => {
    const record = recordFrom(message);
    return typeof record?.role === "string"
      ? [{ role: record.role, text: contentText(record.content) }]
      : [];
  });
};

const streamedAgentText = (
  updates: readonly {
    readonly sessionId: string;
    readonly update: {
      readonly content?: unknown;
      readonly sessionUpdate: string;
    };
  }[],
  sessionId: string
): string =>
  updates
    .filter(
      (notification) =>
        notification.sessionId === sessionId &&
        notification.update.sessionUpdate === "agent_message_chunk"
    )
    .map((notification) => contentText(notification.update.content))
    .join("");

describe("issue #243 real OpenCode ACP compatibility", () => {
  it("exercises the pinned local CLI without credentials and resumes durably in a fresh process", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "laborer-real-acp-compatibility-")
    );
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const mcpObservationPath = join(root, "mcp-invocations.jsonl");
    const provider = await startFakeOpenAiProvider({
      selectReply: (request) =>
        JSON.stringify(request).includes('"tool_call_id"')
          ? { kind: "text", text: "MCP complete" }
          : undefined,
    });
    try {
      await Promise.all([
        mkdir(workspace, { mode: 0o700 }),
        mkdir(home, { mode: 0o700 }),
      ]);
      const harnessOptions = {
        cwd: workspace,
        home,
        providerBaseUrl: provider.baseUrl,
      };
      assert.strictEqual(
        await readLocalOpenCodeVersion(harnessOptions),
        SUPPORTED_ACP_RUNTIME_MATRIX.openCodeCli
      );
      const observedStopReasons = new Set<StopReason>();
      let durableSessionId = "";
      const firstProcess = await startOpenCodeAcpHarness(harnessOptions);
      try {
        const initialized = await firstProcess.initialize();
        assert.strictEqual(initialized.protocolVersion, PROTOCOL_VERSION);
        const session = await firstProcess.newSession([
          {
            args: [MCP_FIXTURE_PATH],
            command: process.execPath,
            env: [
              {
                name: "ACP_COMPATIBILITY_MCP_OBSERVATION",
                value: mcpObservationPath,
              },
            ],
            name: "compat",
          },
        ]);
        durableSessionId = session.sessionId;
        provider.enqueue({
          finishReason: "stop",
          kind: "text",
          textChunks: ["ordinary ", "ACP answer"],
        });
        const ordinary = await firstProcess.prompt(
          durableSessionId,
          "ordinary compatibility prompt"
        );
        observedStopReasons.add(ordinary.stopReason);
        assert.strictEqual(ordinary.stopReason, "end_turn");
        assert.strictEqual(
          streamedAgentText(firstProcess.updates, durableSessionId),
          "ordinary ACP answer"
        );

        const imageRequestIndex = provider.requests.length;
        provider.enqueue({
          finishReason: "stop",
          kind: "text",
          textChunks: ["image accepted"],
        });
        assert.strictEqual(
          (
            await firstProcess.prompt(durableSessionId, [
              { text: "inspect this image", type: "text" },
              {
                data: TINY_PNG_BASE64,
                mimeType: "image/png",
                type: "image",
                uri: null,
              },
            ])
          ).stopReason,
          "end_turn"
        );
        assert.include(
          JSON.stringify(provider.requests[imageRequestIndex]?.body),
          TINY_PNG_BASE64,
          "OpenCode must forward ACP image bytes to its model provider"
        );

        provider.enqueue({
          input: { value: "client-provided-mcp-invoked" },
          kind: "tool",
          name: "compat_record",
        });
        const toolPrompt = await firstProcess.prompt(
          durableSessionId,
          "invoke MCP"
        );
        assert.strictEqual(toolPrompt.stopReason, "end_turn");
        assert.strictEqual(firstProcess.permissionRequests.length, 1);
        assert.ok(
          firstProcess.permissionRequests[0]?.options.some(
            (option) => option.kind === "allow_once"
          )
        );
        assert.deepStrictEqual(
          JSON.parse((await readFile(mcpObservationPath, "utf8")).trim()),
          {
            arguments: { value: "client-provided-mcp-invoked" },
            name: "record",
          }
        );

        provider.enqueue({ finishReason: "length", kind: "text" });
        assert.strictEqual(
          (await firstProcess.prompt(durableSessionId, "emit max_tokens"))
            .stopReason,
          "end_turn",
          "OpenCode 0.0.0-next-17055 changed finish_reason:length behavior"
        );

        provider.enqueue({ finishReason: "content_filter", kind: "text" });
        const refused = await firstProcess.prompt(
          durableSessionId,
          "emit refusal"
        );
        observedStopReasons.add(refused.stopReason);
        assert.strictEqual(
          refused.stopReason,
          "end_turn",
          "OpenCode 2 maps provider content filtering to end_turn"
        );

        const expectedRequestCount = provider.requests.length + 1;
        provider.enqueue({ kind: "hang", textChunks: ["cancellable chunk"] });
        const pending = firstProcess.prompt(
          durableSessionId,
          "cancel this prompt"
        );
        await provider.waitForRequestCount(expectedRequestCount);
        await firstProcess.cancelSession(durableSessionId);
        const cancelled = await pending;
        observedStopReasons.add(cancelled.stopReason);
        assert.strictEqual(cancelled.stopReason, "cancelled");
      } finally {
        await firstProcess.close();
      }

      const resumedProcess = await startOpenCodeAcpHarness(harnessOptions);
      try {
        await resumedProcess.initialize();
        await resumedProcess.resumeSession(durableSessionId);
        const requestStart = provider.requests.length;
        provider.enqueue({
          finishReason: "stop",
          kind: "text",
          textChunks: ["fresh-process resume complete"],
        });
        const resumed = await resumedProcess.prompt(
          durableSessionId,
          "continue after a fresh process"
        );
        assert.strictEqual(resumed.stopReason, "end_turn");
        const messages = modelMessages(provider.requests[requestStart]?.body);
        assert.ok(
          messages.some((message) =>
            message.text.includes("ordinary compatibility prompt")
          )
        );
        assert.ok(
          messages.some(
            (message) =>
              message.role === "assistant" &&
              message.text.includes("ordinary ACP answer")
          )
        );
        assert.ok(
          messages.some((message) =>
            message.text.includes("continue after a fresh process")
          )
        );
      } finally {
        await resumedProcess.close();
      }
      assert.deepStrictEqual([...observedStopReasons].sort(), [
        "cancelled",
        "end_turn",
      ]);
      for (const request of provider.requests) {
        assert.strictEqual(
          request.authorization,
          "Bearer laborer-acp-compatibility-dummy-key"
        );
        assert.strictEqual(request.path, "/v1/chat/completions");
      }
    } finally {
      await provider.close();
      await rm(root, { force: true, recursive: true });
    }
  }, 120_000);
});
