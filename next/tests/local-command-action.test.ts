import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Effect } from "effect";
import { makeAcpAuthorityRepository } from "../src/acp-runtime/acp-authority.ts";
import { makeLaborerActionMcpBridge } from "../src/acp-runtime/action-mcp.ts";
import { defineApplication } from "../src/durable-runtime/action.ts";
import { makeRenderLocalTextAction } from "../src/durable-runtime/local-command-action.ts";
import { makeNodeRootDurableRuntime } from "../src/durable-runtime/node-root.ts";
import { makeGeneratedMutationCatalog } from "../src/generated-mutation-catalog.ts";
import { makeTempDirectoryScoped } from "./support/temp-directory.ts";

describe("registered local command Action", () => {
  it.live(
    "projects an arbitrary capability and keeps bounded command evidence durable",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* makeTempDirectoryScoped(
            "laborer-local-command-action-"
          );
          const action = yield* makeRenderLocalTextAction(directory);
          const application = defineApplication({ actions: [action] });

          assert.strictEqual(action.name, "render-local-text");
          assert.strictEqual(action.recoveryPolicy, "fail-closed");
          assert.strictEqual(action.annotations.readOnlyHint, true);
          assert.ok(action.revision.length > 0);
          assert.ok(action.fingerprint.length > 0);
          assert.deepStrictEqual(
            application.actions.tools.map((tool) => tool.name),
            ["render-local-text"]
          );
          const generated = makeGeneratedMutationCatalog(application.actions);
          assert.ok(
            generated.tools.some((tool) => tool.name === "render-local-text")
          );
          const authority = yield* makeAcpAuthorityRepository({
            keyPath: join(directory, "authority.key"),
            statePath: join(directory, "authority.json"),
            trustedRoot: directory,
          });
          const bridge = yield* makeLaborerActionMcpBridge({
            actionCatalog: application.actions,
            authorityRepository: authority,
            bootstrapPath: join(directory, "action-bootstrap"),
            processGeneration: 313,
            root: directory,
            rootAuthority: "local-command-root",
            statePath: join(directory, "action-capabilities.json"),
            trustedRuntimeRoot: directory,
            workspaceId: "TLOCAL",
          });
          const registration = yield* bridge.prepareRegistration;
          const catalogPath = registration.server.env.find(
            ({ name }) => name === "LABORER_ACTION_CATALOG_PATH"
          )?.value;
          assert.ok(catalogPath);
          const acpCatalog = JSON.parse(
            yield* Effect.promise(() => readFile(catalogPath, "utf8"))
          ) as {
            readonly fingerprint: string;
            readonly tools: readonly { readonly name: string }[];
          };
          assert.strictEqual(
            acpCatalog.fingerprint,
            registration.catalogFingerprint
          );
          assert.ok(
            acpCatalog.tools.some((tool) => tool.name === "render-local-text")
          );
          assert.ok(
            !acpCatalog.tools.some(
              (tool) =>
                tool.name === "create-feature" || tool.name === "deal-with-bug"
            )
          );
          const client = new Client({
            name: "local-command-action-tracer",
            version: "1",
          });
          const transport = new StdioClientTransport({
            args: [...registration.server.args],
            command: registration.server.command,
            env: Object.fromEntries(
              registration.server.env.map(({ name, value }) => [name, value])
            ),
            stderr: "pipe",
          });
          yield* Effect.acquireRelease(
            Effect.promise(() => client.connect(transport)),
            () => Effect.promise(() => client.close())
          );
          yield* bridge.awaitReadiness(registration);
          const listed = yield* Effect.promise(() => client.listTools());
          assert.ok(
            listed.tools.some((tool) => tool.name === "render-local-text")
          );

          const runtime = yield* makeNodeRootDurableRuntime({
            application,
            databasePath: join(directory, "runtime.sqlite"),
            rootIdentity: directory,
          });
          const request = {
            actionName: action.name,
            conversationId: "conversation-local-command",
            input: { text: "private command evidence" },
            invocationId: "invocation-local-command",
            rootIdentity: directory,
            workspaceId: "TLOCAL",
          } as const;
          const accepted = yield* runtime.startExecution(request);
          const duplicate = yield* runtime.startExecution(request);
          assert.strictEqual(duplicate.executionId, accepted.executionId);
          assert.strictEqual(accepted.result, null);

          let terminal = accepted;
          for (let attempt = 0; attempt < 500; attempt += 1) {
            terminal = yield* runtime.getExecution(
              accepted.executionId,
              request.conversationId,
              request.workspaceId
            );
            if (terminal.status === "completed") {
              break;
            }
            yield* Effect.sleep("10 millis");
          }
          assert.strictEqual(terminal.status, "completed");
          const result = yield* action.decodeResult(terminal.result);
          assert.deepStrictEqual(result, {
            exitCode: 0,
            outcome: "success",
            stderr: "",
            stdout: "private command evidence",
          });
          const events = yield* runtime.pendingEvents(
            request.conversationId,
            request.workspaceId
          );
          assert.deepStrictEqual(
            events.map((event) => event.kind),
            ["progress", "progress", "completed"]
          );
          assert.deepStrictEqual(events.at(-1)?.payload, terminal.result);
        })
      ),
    15_000
  );
});
