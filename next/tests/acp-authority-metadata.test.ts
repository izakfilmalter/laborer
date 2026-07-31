import { createHash } from "node:crypto";
import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { NewSessionResponse } from "@agentclientprotocol/sdk";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  ACP_AUTHORITY_MAX_FILE_BYTES,
  ACP_AUTHORITY_MAX_PENDING_PER_CONVERSATION,
  ACP_AUTHORITY_MAX_PENDING_PER_TURN,
  ACP_AUTHORITY_MAX_PENDING_PER_WORKSPACE,
  AcpPermissionAuthorityRecord,
  makeAcpAuthorityRepository,
  pendingPermissionCapacityExceeded,
} from "../src/acp-conversation-prototype/acp-authority.ts";
import { inventoryAcpConfigSources } from "../src/acp-conversation-prototype/acp-config-source-inventory.ts";
import {
  extractAcpEffectiveMetadata,
  signAcpEffectiveMetadata,
} from "../src/acp-conversation-prototype/acp-effective-metadata.ts";
import { makeFileApplicationRepository } from "../src/reference-coding-application.ts";
import { makeTempDirectoryScoped } from "./support/temp-directory.ts";

const response: NewSessionResponse = {
  configOptions: [
    {
      category: "model",
      currentValue: "provider/model",
      description: "catalog secret must not persist",
      id: "model",
      name: "Model",
      options: [
        { name: "Provider credential secret", value: "provider/model" },
      ],
      type: "select",
    },
    {
      category: "thought_level",
      currentValue: "high",
      id: "effort",
      name: "Effort",
      options: [{ name: "High", value: "high" }],
      type: "select",
    },
    {
      category: "mode",
      currentValue: "build",
      id: "mode",
      name: "Mode",
      options: [{ name: "Build", value: "build" }],
      type: "select",
    },
    {
      category: "provider-auth",
      currentValue: "raw-provider-token",
      id: "credentials",
      name: "Credentials",
      options: [{ name: "secret", value: "raw-provider-token" }],
      type: "select",
    },
  ],
  sessionId: "opaque-session",
};

const pendingRecord = (options: {
  readonly conversation: string;
  readonly id: number;
  readonly turn: string;
  readonly workspace: string;
}): AcpPermissionAuthorityRecord =>
  AcpPermissionAuthorityRecord.make({
    argumentDigest: `argument-${options.id}`,
    authorizedUserDigest: "authorized-user",
    bindingGeneration: 1,
    capabilityDigest: `capability-${options.id}`,
    category: "shell",
    channelDigest: "channel",
    conversationDigest: options.conversation,
    createdAt: 1,
    decisionClaimedAt: null,
    decisionIntent: null,
    expiresAt: 10,
    inputDigest: `input-${options.id}`,
    messageDigest: null,
    optionAllowDigest: "allow",
    optionRejectDigest: "reject",
    presentationMarkerDigest: null,
    processGeneration: 1,
    promptDigest: "prompt",
    recordId: `record-${options.id}`,
    requestIdentityDigest: `request-${options.id}`,
    rootDigest: "root",
    sessionDigest: "session",
    state: "pending",
    toolCallDigest: `tool-${options.id}`,
    turnDigest: options.turn,
    updatedAt: 1,
    workspaceDigest: options.workspace,
  });

describe("issue #245 bounded effective ACP metadata", () => {
  it("enforces named pending capacities for turn, conversation, and workspace", () => {
    const turnRecords = Array.from(
      { length: ACP_AUTHORITY_MAX_PENDING_PER_TURN },
      (_, id) =>
        pendingRecord({
          conversation: "conversation",
          id,
          turn: "turn",
          workspace: "workspace",
        })
    );
    assert.strictEqual(
      pendingPermissionCapacityExceeded(
        turnRecords,
        pendingRecord({
          conversation: "conversation",
          id: 100,
          turn: "turn",
          workspace: "workspace",
        })
      ),
      "turn"
    );

    const conversationRecords = Array.from(
      { length: ACP_AUTHORITY_MAX_PENDING_PER_CONVERSATION },
      (_, id) =>
        pendingRecord({
          conversation: "conversation",
          id,
          turn: `turn-${id}`,
          workspace: "workspace",
        })
    );
    assert.strictEqual(
      pendingPermissionCapacityExceeded(
        conversationRecords,
        pendingRecord({
          conversation: "conversation",
          id: 101,
          turn: "new-turn",
          workspace: "workspace",
        })
      ),
      "conversation"
    );

    const workspaceRecords = Array.from(
      { length: ACP_AUTHORITY_MAX_PENDING_PER_WORKSPACE },
      (_, id) =>
        pendingRecord({
          conversation: `conversation-${id}`,
          id,
          turn: `turn-${id}`,
          workspace: "workspace",
        })
    );
    assert.strictEqual(
      pendingPermissionCapacityExceeded(
        workspaceRecords,
        pendingRecord({
          conversation: "new-conversation",
          id: 102,
          turn: "new-turn",
          workspace: "workspace",
        })
      ),
      "workspace"
    );
  });

  it.effect(
    "rejects oversized and semantically over-capacity authority state",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-245-authority-bounds-"
          );
          const statePath = join(root, "authority.json");
          const repository = yield* makeAcpAuthorityRepository({
            keyPath: join(root, "authority.key"),
            statePath,
            trustedRoot: root,
          });
          yield* Effect.promise(() =>
            writeFile(statePath, "x".repeat(ACP_AUTHORITY_MAX_FILE_BYTES + 1), {
              mode: 0o600,
            })
          );
          assert.ok((yield* Effect.exit(repository.load))._tag === "Failure");

          const records = Array.from(
            { length: ACP_AUTHORITY_MAX_PENDING_PER_WORKSPACE + 1 },
            (_, id) =>
              pendingRecord({
                conversation: `conversation-${id}`,
                id,
                turn: `turn-${id}`,
                workspace: "workspace",
              })
          );
          yield* Effect.promise(() =>
            writeFile(
              statePath,
              JSON.stringify({ records, schemaVersion: 1 }),
              { mode: 0o600 }
            )
          );
          assert.ok((yield* Effect.exit(repository.load))._tag === "Failure");
        })
      )
  );

  it.effect(
    "keyedly inventories bounded OpenCode config categories without persisting sources or secrets",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-245-config-inventory-"
          );
          const home = join(root, "isolated-home");
          const skillDirectory = join(root, ".opencode", "skills", "review");
          const irrelevantSkillDirectory = join(root, "skill");
          const pluginDirectory = join(root, ".opencode", "plugins");
          const authDirectory = join(home, ".local", "share", "opencode");
          yield* Effect.promise(() =>
            Promise.all([
              mkdir(authDirectory, { mode: 0o700, recursive: true }),
              mkdir(skillDirectory, { mode: 0o700, recursive: true }),
              mkdir(irrelevantSkillDirectory, { mode: 0o700 }),
              mkdir(pluginDirectory, { mode: 0o700, recursive: true }),
            ])
          );
          yield* Effect.promise(() =>
            Promise.all([
              writeFile(
                join(authDirectory, "auth.json"),
                JSON.stringify({ token: "global-auth-secret-245" }),
                { mode: 0o600 }
              ),
              writeFile(
                join(root, "opencode.json"),
                JSON.stringify({
                  mcp: { private: { token: "inventory-secret-245" } },
                  permission: { bash: "ask" },
                }),
                { mode: 0o600 }
              ),
              writeFile(join(skillDirectory, "SKILL.md"), "first skill", {
                mode: 0o600,
              }),
              writeFile(
                join(irrelevantSkillDirectory, "SKILL.md"),
                "irrelevant root skill",
                { mode: 0o600 }
              ),
              writeFile(
                join(pluginDirectory, "guard.ts"),
                "export default {}",
                {
                  mode: 0o600,
                }
              ),
            ])
          );
          const repository = yield* makeAcpAuthorityRepository({
            keyPath: join(root, "authority.key"),
            statePath: join(root, "authority.json"),
            trustedRoot: root,
          });
          const first = yield* inventoryAcpConfigSources({
            environment: { HOME: home },
            projectRoot: root,
            repository,
          });
          assert.deepStrictEqual(
            first.categories.map(({ category }) => category),
            ["auth", "config", "plugin", "skill"]
          );
          const persisted = JSON.stringify(first);
          assert.ok(!persisted.includes(root));
          assert.ok(!persisted.includes("inventory-secret-245"));
          assert.ok(!persisted.includes("global-auth-secret-245"));
          assert.ok(!persisted.includes("SKILL.md"));

          yield* Effect.promise(() =>
            writeFile(
              join(irrelevantSkillDirectory, "SKILL.md"),
              "changed irrelevant root skill",
              { mode: 0o600 }
            )
          );
          const irrelevantChange = yield* inventoryAcpConfigSources({
            environment: { HOME: home },
            projectRoot: root,
            repository,
          });
          assert.strictEqual(irrelevantChange.digest, first.digest);

          yield* Effect.promise(() =>
            writeFile(join(skillDirectory, "SKILL.md"), "changed skill", {
              mode: 0o600,
            })
          );
          const changed = yield* inventoryAcpConfigSources({
            environment: { HOME: home },
            projectRoot: root,
            repository,
          });
          assert.notStrictEqual(changed.digest, first.digest);
        })
      )
  );

  it.effect(
    "fingerprints effective OpenCode configuration inherited by a nested bound project",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-245-inherited-config-"
          );
          const project = join(root, "packages", "nested-project");
          const inheritedSkill = join(root, ".opencode", "skills", "shared");
          const home = join(project, "isolated-home");
          yield* Effect.promise(() =>
            Promise.all([
              mkdir(home, { mode: 0o700, recursive: true }),
              mkdir(inheritedSkill, { mode: 0o700, recursive: true }),
            ])
          );
          yield* Effect.promise(() =>
            Promise.all([
              writeFile(
                join(root, "opencode.json"),
                JSON.stringify({ agent: "inherited-agent" }),
                { mode: 0o600 }
              ),
              writeFile(join(inheritedSkill, "SKILL.md"), "inherited skill", {
                mode: 0o600,
              }),
            ])
          );
          const repository = yield* makeAcpAuthorityRepository({
            keyPath: join(project, "authority.key"),
            statePath: join(project, "authority.json"),
            trustedRoot: project,
          });
          const first = yield* inventoryAcpConfigSources({
            environment: { HOME: home },
            projectRoot: project,
            repository,
          });
          assert.deepStrictEqual(
            first.categories.map(({ category }) => category),
            ["config", "skill"]
          );

          yield* Effect.promise(() =>
            writeFile(
              join(inheritedSkill, "SKILL.md"),
              "changed inherited skill",
              {
                mode: 0o600,
              }
            )
          );
          const changed = yield* inventoryAcpConfigSources({
            environment: { HOME: home },
            projectRoot: project,
            repository,
          });
          assert.notStrictEqual(changed.digest, first.digest);

          const disabled = yield* inventoryAcpConfigSources({
            environment: {
              HOME: home,
              OPENCODE_CONFIG: "",
              OPENCODE_CONFIG_DIR: "",
              OPENCODE_DISABLE_PROJECT_CONFIG: "1",
              XDG_CONFIG_HOME: "",
              XDG_DATA_HOME: "",
            },
            projectRoot: project,
            repository,
          });
          assert.deepStrictEqual(disabled.categories, []);
        })
      )
  );

  it.effect("rejects oversized and symlinked OpenCode config sources", () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const unsafe of ["oversized", "symlink"] as const) {
          const root = yield* makeTempDirectoryScoped(
            `laborer-245-config-${unsafe}-`
          );
          const home = join(root, "home");
          const skills = join(root, ".opencode", "skills");
          yield* Effect.promise(() =>
            Promise.all([
              mkdir(home, { mode: 0o700 }),
              mkdir(skills, { mode: 0o700, recursive: true }),
            ])
          );
          if (unsafe === "oversized") {
            yield* Effect.promise(() =>
              writeFile(join(skills, "large.md"), "x".repeat(256 * 1024 + 1), {
                mode: 0o600,
              })
            );
          } else {
            const outside = join(root, "outside-secret");
            yield* Effect.promise(async () => {
              await writeFile(outside, "must not be inventoried", {
                mode: 0o600,
              });
              await symlink(outside, join(skills, "linked.md"), "file");
            });
          }
          const repository = yield* makeAcpAuthorityRepository({
            keyPath: join(root, "authority.key"),
            statePath: join(root, "authority.json"),
            trustedRoot: root,
          });
          const inventory = inventoryAcpConfigSources({
            environment: { HOME: home },
            projectRoot: root,
            repository,
          });
          if (unsafe === "symlink") {
            assert.ok((yield* Effect.exit(inventory))._tag === "Failure");
          } else {
            const bounded = yield* inventory;
            assert.strictEqual(bounded.complete, false);
            assert.ok(bounded.incompleteReasons.includes("file-byte-limit"));
          }
        }
      })
    )
  );

  it.effect(
    "retains only recognized current selections and signs them with owner-only key material",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped("laborer-245-metadata-");
          const keyPath = join(root, "authority.key");
          const repository = yield* makeAcpAuthorityRepository({
            keyPath,
            statePath: join(root, "authority.json"),
            trustedRoot: root,
          });
          const metadata = extractAcpEffectiveMetadata({
            agentInfo: { name: "OpenCode", version: "0.0.0-next-16573" },
            configSourceInventory: {
              categories: [{ category: "config", fileCount: 1, totalBytes: 8 }],
              complete: false,
              digest: "keyed-config-inventory",
              fileCount: 1,
              incompleteReasons: ["effective-runtime-manifest-unavailable"],
              totalBytes: 8,
            },
            cwd: root,
            environment: Object.fromEntries([
              ["OPENAI_API_KEY", "private-provider-key"],
              ["PATH", "/bin"],
              ...Array.from({ length: 100 }, (_, index) => [
                `SAFE_${index}`,
                `value-${index}`,
              ]),
            ]),
            mcpServerNames: ["client-memory"],
            protocolVersion: 1,
            repository,
            response,
          });
          const signed = signAcpEffectiveMetadata(repository, metadata);
          const changedEnvironment = extractAcpEffectiveMetadata({
            agentInfo: { name: "OpenCode", version: "0.0.0-next-16573" },
            configSourceInventory: metadata.configSourceInventory,
            cwd: root,
            environment: {
              OPENAI_API_KEY: "private-provider-key",
              PATH: "/bin",
              ...Object.fromEntries(
                Array.from({ length: 100 }, (_, index) => [
                  `SAFE_${index}`,
                  index === 99 ? "different-omitted-value" : `value-${index}`,
                ])
              ),
            },
            mcpServerNames: ["client-memory"],
            protocolVersion: 1,
            repository,
            response,
          });
          const addedEnvironmentName = extractAcpEffectiveMetadata({
            agentInfo: { name: "OpenCode", version: "0.0.0-next-16573" },
            configSourceInventory: metadata.configSourceInventory,
            cwd: root,
            environment: {
              OPENAI_API_KEY: "private-provider-key",
              PATH: "/bin",
              ...Object.fromEntries(
                Array.from({ length: 100 }, (_, index) => [
                  `SAFE_${index}`,
                  `value-${index}`,
                ])
              ),
              ZZZ_OMITTED: "omitted-private-value",
            },
            mcpServerNames: ["client-memory"],
            protocolVersion: 1,
            repository,
            response,
          });
          assert.strictEqual(metadata.model, "provider/model");
          assert.strictEqual(metadata.effort, "high");
          assert.strictEqual(metadata.mode, "build");
          assert.strictEqual(metadata.selectedAgent, "build");
          assert.deepStrictEqual(metadata.implementation, {
            name: "OpenCode",
            version: "0.0.0-next-16573",
          });
          assert.strictEqual(metadata.environmentNames.length, 64);
          assert.strictEqual(metadata.environmentNameCount, 102);
          assert.strictEqual(metadata.environmentNamesIncomplete, true);
          assert.ok(!metadata.environmentNames.includes("SAFE_99"));
          assert.deepStrictEqual(
            changedEnvironment.environmentNames,
            metadata.environmentNames
          );
          assert.notStrictEqual(
            changedEnvironment.environmentAggregate,
            metadata.environmentAggregate
          );
          assert.deepStrictEqual(
            addedEnvironmentName.environmentNames,
            metadata.environmentNames
          );
          assert.notStrictEqual(
            addedEnvironmentName.environmentAggregate,
            metadata.environmentAggregate
          );
          assert.deepStrictEqual(metadata.clientMcpServerNames, [
            "client-memory",
          ]);
          const serialized = JSON.stringify(signed);
          for (const forbidden of [
            "raw-provider-token",
            "catalog secret",
            "Provider credential secret",
            "private-provider-key",
            "different-private-provider-key",
            "different-omitted-value",
            "omitted-private-value",
          ]) {
            assert.ok(!serialized.includes(forbidden));
          }
          const unkeyed = createHash("sha256")
            .update(JSON.stringify(metadata))
            .digest("base64url");
          assert.notStrictEqual(signed.fingerprint, unkeyed);
          assert.strictEqual(
            (yield* Effect.promise(() => stat(keyPath))).mode % 64,
            0
          );
        })
      )
  );

  it.effect(
    "migrates v4 bindings to v6 without changing session continuity or ambiguity",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped("laborer-245-v4-");
          const path = join(root, "application-state.json");
          yield* Effect.promise(() =>
            writeFile(
              path,
              JSON.stringify({
                conversations: [
                  {
                    agentSessionBinding: {
                      ambiguousPromptId: "ambiguous-prompt",
                      cwd: root,
                      generation: 9,
                      initializationPhase: "submitting",
                      introducedParticipantIds: ["U245"],
                      pendingParticipantIds: ["U246"],
                      sessionId: "opaque-session-v4",
                    },
                    conversationId: "conversation-v4",
                    prompts: [],
                    sessionId: "logical-session-v4",
                  },
                ],
                executions: [],
                schemaVersion: 4,
              }),
              { mode: 0o600 }
            )
          );
          const repository = yield* makeFileApplicationRepository(path, root);
          const migrated = yield* repository.load;
          const binding = migrated.conversations[0]?.agentSessionBinding;
          assert.strictEqual(migrated.schemaVersion, 16);
          assert.strictEqual(binding?.sessionId, "opaque-session-v4");
          assert.strictEqual(binding?.initializationPhase, "submitting");
          assert.strictEqual(binding?.ambiguousPromptId, "ambiguous-prompt");
          assert.deepStrictEqual(binding?.introducedParticipantIds, ["U245"]);
          assert.deepStrictEqual(binding?.pendingParticipantIds, ["U246"]);
          assert.strictEqual(binding?.effectiveMetadata, null);
          assert.strictEqual(binding?.effectiveMetadataFingerprint, null);
          const persisted = yield* Effect.promise(() => readFile(path, "utf8"));
          assert.ok(persisted.includes('"schemaVersion":16'));
          assert.ok(persisted.includes('"effectiveMetadata":null'));
        })
      )
  );
});
