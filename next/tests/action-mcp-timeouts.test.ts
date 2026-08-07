import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { McpServer } from "@agentclientprotocol/sdk";
import { assert, describe, it } from "@effect/vitest";
import {
  ACTION_MCP_CONTROL_TIMEOUT_MILLIS,
  ACTION_MCP_EXECUTION_TIMEOUT_MILLIS,
  openCodeMcpConfig,
} from "../src/acp-conversation-prototype/action-mcp-timeouts.ts";

const CONTROL_TIMEOUT_WIRING_PATTERN =
  /AbortSignal\.timeout\(\s*ACTION_MCP_CONTROL_TIMEOUT_MILLIS\s*\)/;

describe("Action MCP execution timeout", () => {
  it("keeps long-running execution controls alive across both transport hops", async () => {
    const server: McpServer = {
      args: ["action-mcp-server.ts"],
      command: "node",
      env: [],
      name: "laborer-actions-0123456789abcdef",
    };

    const config = openCodeMcpConfig(server);

    assert.deepStrictEqual(config.timeout, {
      execution: ACTION_MCP_EXECUTION_TIMEOUT_MILLIS,
    });
    assert.notProperty(
      openCodeMcpConfig({ ...server, name: "laborer-memory-test" }),
      "timeout",
      "ordinary MCP tools retain their normal bounded execution timeout"
    );
    assert.isAbove(ACTION_MCP_EXECUTION_TIMEOUT_MILLIS, 60_000);
    assert.isAbove(
      ACTION_MCP_CONTROL_TIMEOUT_MILLIS,
      ACTION_MCP_EXECUTION_TIMEOUT_MILLIS
    );

    const [adapterSource, serverSource] = await Promise.all([
      readFile(
        resolve(
          process.cwd(),
          "src/acp-conversation-prototype/opencode-v2-acp-adapter.ts"
        ),
        "utf8"
      ),
      readFile(
        resolve(
          process.cwd(),
          "src/acp-conversation-prototype/action-mcp-server.ts"
        ),
        "utf8"
      ),
    ]);
    assert.include(
      adapterSource,
      "config: openCodeMcpConfig(registration)",
      "OpenCode registration must retain the explicit execution timeout"
    );
    assert.match(
      serverSource,
      CONTROL_TIMEOUT_WIRING_PATTERN,
      "the HTTP control bridge must outlive its MCP caller"
    );
  });
});
