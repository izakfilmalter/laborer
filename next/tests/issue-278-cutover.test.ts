import { access, readFile } from "node:fs/promises";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { makeActionCatalog } from "../src/durable-runtime/action.ts";
import { conversationCapabilitiesForRootRuntime } from "../src/durable-runtime/reference-coding-application.ts";
import {
  ExecutionControlReceipt,
  ExecutionControlSnapshot,
  type RootDurableRuntimeShape,
} from "../src/durable-runtime/root-runtime.ts";

const exists = (url: URL): Promise<boolean> =>
  access(url).then(
    () => true,
    () => false
  );

describe("issue #278 primary Cluster cutover", () => {
  it("keeps only the primary runtime commands and implementation", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8")
    ) as { readonly scripts: Readonly<Record<string, string>> };

    assert.notProperty(packageJson.scripts, "prototype:actions");
    assert.notProperty(packageJson.scripts, "prototype:conversation-execution");
    assert.isFalse(
      await exists(new URL("../src/action-toolkit-prototype", import.meta.url))
    );
    assert.isFalse(
      await exists(new URL("../src/cluster-runtime", import.meta.url))
    );
    assert.isFalse(
      await exists(
        new URL(
          "../src/conversation-execution-tracer-prototype",
          import.meta.url
        )
      )
    );
  });

  it("registers the user application in the normal Slack root runtime", async () => {
    const [live, runner] = await Promise.all([
      readFile(new URL("../src/slack/live.ts", import.meta.url), "utf8"),
      readFile(
        new URL("../src/slack/acp-workspace-runner.ts", import.meta.url),
        "utf8"
      ),
    ]);

    assert.include(live, "makeReferenceCodingRootApplication");
    assert.include(live, "application,");
    assert.notInclude(runner, "CONVERSATION_ONLY_ACTION_CATALOG_FINGERPRINT");
    assert.include(runner, "options.rootRuntime.actions.fingerprint");
  });

  it("fails closed when fixed reference controls receive another registered Action", async () => {
    const unused = () => Effect.die("unused runtime method");
    const receipt = ExecutionControlReceipt.make({
      controlId: "control-1",
      deduplicated: false,
      execution: ExecutionControlSnapshot.make({
        actionName: "user-defined-action",
        actionRevision: "v1",
        canCancel: true,
        canFollowUp: true,
        conversationId: "conversation-1",
        executionId: "execution-1",
        status: "running",
        workspaceId: "workspace-1",
      }),
    });
    const runtime: RootDurableRuntimeShape = {
      acknowledgeEvent: unused,
      actions: makeActionCatalog([]),
      attachConversationClient: unused,
      cancelExecution: () => Effect.succeed(receipt),
      checkConversationClientCompatibility: unused,
      followUpExecution: unused,
      getExecution: unused,
      inspectExecution: () => Effect.succeed(receipt),
      pendingEvents: unused,
      runConversation: unused,
      startExecution: unused,
    };
    const controls = conversationCapabilitiesForRootRuntime({
      rootIdentity: "/root",
      runtime,
      workspaceId: "workspace-1",
    }).controlsFor("conversation-1");
    const trusted = {
      capabilityExpiresAt: 1,
      inputHash: "input-hash",
      operationId: "control-1",
      schemaFingerprint: "schema-fingerprint",
    };

    for (const name of ["inspect-executions", "cancel-execution"] as const) {
      const control = controls.find((candidate) => candidate.name === name);
      assert.isDefined(control);
      const failure = await Effect.runPromise(
        Effect.flip(control.invoke({ executionId: "execution-1" }, trusted))
      );
      assert.equal(failure.category, "protocol");
    }
  });
});
