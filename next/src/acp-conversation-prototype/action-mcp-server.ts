import { readFile } from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Effect } from "effect";
import { actionDefinition } from "../action-catalog.ts";
import { executionControlDefinition } from "../execution-control-catalog.ts";
import { productionGeneratedMutationCatalog } from "../generated-mutation-catalog.ts";
import { ACTION_MCP_CONTROL_TIMEOUT_MILLIS } from "./action-mcp-timeouts.ts";

const controlUrl = process.env.LABORER_ACTION_CONTROL_URL;
const bootstrapPath = process.env.LABORER_ACTION_BOOTSTRAP_PATH;
const serverName = process.env.LABORER_ACTION_SERVER_NAME;
const serverGeneration = process.env.LABORER_ACTION_SERVER_GENERATION;

if (
  controlUrl === undefined ||
  bootstrapPath === undefined ||
  serverName === undefined ||
  serverGeneration === undefined
) {
  process.stderr.write("[laborer-actions] bootstrap configuration missing\n");
  process.exitCode = 1;
} else {
  const bootstrap = (await readFile(bootstrapPath, "utf8")).trim();
  const callControl = async (
    path: string,
    body: unknown,
    requestSignal?: AbortSignal
  ): Promise<unknown> => {
    const timeoutSignal = AbortSignal.timeout(
      ACTION_MCP_CONTROL_TIMEOUT_MILLIS
    );
    const signal =
      requestSignal === undefined
        ? timeoutSignal
        : AbortSignal.any([requestSignal, timeoutSignal]);
    const response = await fetch(`${controlUrl}${path}`, {
      body: JSON.stringify(body),
      headers: {
        authorization: `Bearer ${bootstrap}`,
        "content-type": "application/json",
      },
      method: "POST",
      signal,
    });
    const source = await response.text();
    if (!response.ok || Buffer.byteLength(source, "utf8") > 64 * 1024) {
      throw new Error("Action control request failed");
    }
    return JSON.parse(source) as unknown;
  };

  const server = new Server(
    { name: serverName, version: "1.0.0" },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, () =>
    Promise.resolve({ tools: productionGeneratedMutationCatalog.tools })
  );
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const action = actionDefinition(request.params.name);
    const control = executionControlDefinition(request.params.name);
    const definition = action ?? control;
    if (definition === undefined) {
      return {
        content: [{ text: "Unsupported Action.", type: "text" as const }],
        isError: true,
      };
    }
    try {
      const result = await callControl(
        "/invoke",
        {
          catalogFingerprint: productionGeneratedMutationCatalog.fingerprint,
          input: request.params.arguments ?? {},
          serverGeneration,
          serverName,
          toolName: definition.name,
        },
        extra.signal
      );
      let encoded: unknown;
      if (action !== undefined) {
        encoded = await Effect.runPromise(action.encodeResult(result));
      } else if (control !== undefined) {
        encoded = await Effect.runPromise(control.encodeResult(result));
      } else {
        throw new Error("Unsupported generated tool");
      }
      return {
        content: [{ text: JSON.stringify(encoded), type: "text" as const }],
        structuredContent: encoded as Record<string, unknown>,
      };
    } catch {
      return {
        content: [
          {
            text: "Action invocation was rejected or unavailable.",
            type: "text" as const,
          },
        ],
        isError: true,
      };
    }
  });
  server.oninitialized = async () => {
    try {
      await callControl("/ready", {
        catalogFingerprint: productionGeneratedMutationCatalog.fingerprint,
        environmentNames: Object.keys(process.env).sort(),
        serverGeneration,
        serverName,
        tools: productionGeneratedMutationCatalog.tools,
      });
    } catch {
      process.stderr.write("[laborer-actions] readiness failed\n");
      process.exitCode = 1;
    }
  };
  await server.connect(new StdioServerTransport());
}
