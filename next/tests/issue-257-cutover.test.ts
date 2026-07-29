import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { inspectAcpRecoveryHealthOffline } from "../src/slack/acp-recovery.ts";
import { loadLaborerConfig } from "../src/slack/laborer-config.ts";
import { prepareSlackRuntimePaths } from "../src/slack/runtime-paths.ts";
import { makeTempDirectoryScoped } from "./support/temp-directory.ts";

const isolatedCanaryDatabasePattern =
  /databasePath:\s*resolve\(dirname\(paths\.applicationState\),\s*"runtime\.sqlite"\)/;

describe("issue #257 ACP production cutover", () => {
  it.effect(
    "rejects removed Conversation configuration with a bounded migration diagnostic",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped("laborer-257-config-");
          const cases = [
            {
              application: {
                agent: "build",
                environment: [],
                type: "reference-coding",
              },
              reason:
                "legacy-conversation-config-removed-use-opencode-agent-model-config",
            },
            {
              application: {
                agent: "build",
                environment: [],
                implementation: { agent: "build" },
                type: "reference-coding",
              },
              reason:
                "legacy-conversation-config-removed-use-opencode-agent-model-config",
            },
            {
              application: {
                conversation: {
                  agent: "legacy",
                  instructions: ["one"],
                  operationResultInstructions: ["two"],
                },
                environment: [],
                type: "reference-coding",
              },
              reason:
                "legacy-conversation-config-removed-use-opencode-agent-model-config",
            },
          ] as const;
          for (const fixture of cases) {
            yield* Effect.promise(() =>
              writeFile(join(root, "laborer.json"), JSON.stringify(fixture))
            );
            const result = yield* Effect.result(
              loadLaborerConfig({ defaultRoot: root })
            );
            assert.strictEqual(result._tag, "Failure");
            if (result._tag === "Failure") {
              assert.strictEqual(
                result.failure.operation,
                "migrate-acp-config"
              );
              assert.strictEqual(result.failure.reason, fixture.reason);
              assert.ok(result.failure.reason.length <= 96);
            }
          }
        })
      )
  );

  it.effect(
    "keeps implementation selection nested and out of ACP environment",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped("laborer-257-nested-");
          yield* Effect.promise(() =>
            writeFile(
              join(root, "laborer.json"),
              JSON.stringify({
                application: {
                  environment: ["OPENAI_API_KEY"],
                  implementation: {
                    agent: "build",
                    model: "provider/model",
                  },
                  type: "reference-coding",
                },
              })
            )
          );
          const loaded = yield* loadLaborerConfig({ defaultRoot: root });
          assert.deepStrictEqual(loaded.config.application?.implementation, {
            agent: "build",
            model: "provider/model",
          });
          const tracked = yield* Effect.promise(() =>
            readFile(new URL("../laborer.json", import.meta.url), "utf8")
          );
          assert.ok(!tracked.includes("LABORER_OPENCODE_MODEL"));
        })
      )
  );

  it.effect(
    "reports only bounded health counts, reason codes, and digests",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped("laborer-257-health-");
          const paths = yield* prepareSlackRuntimePaths(root, "T257SECRET");
          const secret = "SECRET_CONTENT_PATH_ARGUMENT_TOKEN";
          yield* Effect.promise(() =>
            Promise.all([
              writeFile(
                paths.runnerState,
                JSON.stringify({
                  conversationStreams: [
                    { lifecycle: "unresolved", text: secret },
                  ],
                  threads: [
                    {
                      applicationEvents: [{ status: "blocked", text: secret }],
                      applicationInputQueue: [{ text: secret }],
                      turns: [],
                    },
                  ],
                })
              ),
              writeFile(
                paths.applicationState,
                JSON.stringify({
                  conversations: [],
                  executionEventOutbox: [{ status: "staged", content: secret }],
                  executions: [{ status: "unresolved", args: secret }],
                })
              ),
              writeFile(
                paths.acpAuthorityState,
                JSON.stringify({ records: [] })
              ),
              writeFile(
                paths.acpActionAuthorityState,
                JSON.stringify({
                  operations: [{ state: "uncertain", args: secret }],
                })
              ),
              writeFile(
                paths.acpPermissionUiOutbox,
                JSON.stringify({
                  entries: [{ status: "pending", title: secret }],
                })
              ),
              writeFile(
                paths.acpProcessState,
                JSON.stringify({ health: "ready" })
              ),
            ])
          );
          const health = yield* Effect.promise(() =>
            inspectAcpRecoveryHealthOffline({
              paths,
              workspaceId: "T257SECRET",
            })
          );
          assert.strictEqual(health.counts.blockedPrompts, 1);
          assert.strictEqual(health.counts.queuedInputs, 1);
          assert.strictEqual(health.counts.unresolvedStreams, 1);
          assert.strictEqual(health.counts.actionUncertain, 1);
          assert.strictEqual(health.counts.executionUncertain, 1);
          assert.strictEqual(health.counts.executionOutboxBacklog, 1);
          assert.strictEqual(health.counts.permissionOutboxBacklog, 1);
          const serialized = JSON.stringify(health);
          assert.ok(!serialized.includes(secret));
          assert.ok(!serialized.includes(root));
          assert.ok(!serialized.includes("T257SECRET"));
        })
      )
  );

  it("uses the production runtime and interactive manifest for the canary", async () => {
    const [canary, manifest] = await Promise.all([
      readFile(
        new URL("../src/acp-conversation-prototype/live.ts", import.meta.url),
        "utf8"
      ),
      readFile(new URL("../slack-app-manifest.yaml", import.meta.url), "utf8"),
    ]);
    assert.ok(canary.includes("makeNodeRootDurableRuntime"));
    assert.ok(canary.includes("makeAcpSlackWorkspaceRunner"));
    assert.ok(canary.includes("slackConversationStreamDeliveryPolicy"));
    assert.ok(canary.includes("acp-canary:"));
    assert.ok(canary.includes("rootRuntime"));
    assert.match(canary, isolatedCanaryDatabasePattern);
    assert.ok(!canary.includes("databasePath: paths.runtimeDatabase"));
    assert.ok(!canary.includes("makeAcpConversationCanary"));
    assert.ok(manifest.includes("interactivity:\n    is_enabled: true"));
  });
});
