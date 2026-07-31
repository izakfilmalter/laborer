import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { makeAcpAuthorityRepository } from "../src/acp-conversation-prototype/acp-authority.ts";
import { makeAcpConversationAgent } from "../src/acp-conversation-prototype/acp-conversation-agent.ts";
import { makeLaborerActionMcpBridge } from "../src/acp-conversation-prototype/action-mcp.ts";
import type {
  ConversationAction,
  ConversationAgentRequest,
  ConversationAgentSessionBinding,
  ConversationAgentSessionBindingStore,
  TrustedActionInvocation,
} from "../src/reference-coding-application.ts";
import { makeTempDirectoryScoped } from "./support/temp-directory.ts";

const scriptedPeerPath = resolve(
  process.cwd(),
  "tests/fixtures/scripted-acp-peer.ts"
);
const ordinaryMarker = "ORDINARY_NO_ACTION_248";

const readJsonLines = async <A>(path: string): Promise<readonly A[]> =>
  (await readFile(path, "utf8"))
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as A);

const waitForJsonLineCount = (
  path: string,
  count: number
): Effect.Effect<void> =>
  Effect.promise(async () => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        if ((await readJsonLines(path)).length >= count) {
          return;
        }
      } catch {
        // The registration log has not been created yet.
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    throw new Error(`Timed out waiting for ${count} records in ${path}`);
  });

const makeSessionBindingStore = (): ConversationAgentSessionBindingStore => {
  let binding: ConversationAgentSessionBinding | null = null;
  const update = (
    generation: number,
    apply: (
      current: ConversationAgentSessionBinding
    ) => ConversationAgentSessionBinding
  ) =>
    Effect.sync(() => {
      assert.strictEqual(binding?.generation, generation);
      assert.ok(binding);
      binding = apply(binding);
      return binding;
    });

  return {
    beginPrompt: (generation, participantIds, initializesSession, promptId) =>
      update(generation, (current) => ({
        ...current,
        ambiguousPromptId: promptId,
        initializationPhase: initializesSession
          ? "submitting"
          : current.initializationPhase,
        pendingParticipantIds: [
          ...new Set([...current.pendingParticipantIds, ...participantIds]),
        ],
      })),
    completePrompt: (generation) =>
      update(generation, (current) => ({
        ...current,
        ambiguousPromptId: null,
        initializationPhase: "initialized",
        introducedParticipantIds: [
          ...new Set([
            ...current.introducedParticipantIds,
            ...current.pendingParticipantIds,
          ]),
        ],
        pendingParticipantIds: [],
      })),
    load: Effect.sync(() => binding),
    recordEffectiveMetadata: (generation, metadata, fingerprint) =>
      update(generation, (current) => ({
        ...current,
        effectiveMetadata: metadata,
        effectiveMetadataFingerprint: fingerprint,
      })),
    recordProcessAttachment: (generation, processGeneration) =>
      update(generation, (current) => ({
        ...current,
        lastAttachedProcessGeneration: processGeneration,
      })),
    replace: (expectedGeneration, replacement) =>
      Effect.sync(() => {
        assert.strictEqual(binding?.generation ?? null, expectedGeneration);
        binding = {
          ...replacement,
          generation: (binding?.generation ?? 0) + 1,
        };
        return binding;
      }),
  };
};

const request = (options: {
  readonly conversationId: string;
  readonly input: string;
  readonly sessionBindingStore: ConversationAgentSessionBindingStore;
  readonly turn: number;
  readonly actions: readonly ConversationAction[];
}): ConversationAgentRequest => ({
  actions: options.actions,
  context: [],
  conversationId: options.conversationId,
  conversationSessionId: `logical:${options.conversationId}`,
  conversationSessionIsNew: options.turn === 1,
  executionControls: [],
  executions: [],
  input: options.input,
  messages: [],
  promptId: `${options.conversationId}:prompt:${options.turn}`,
  sessionBindingStore: options.sessionBindingStore,
  source: "slack",
  turnAuthority: {
    authorizedSlackUserId: "U248HUMAN",
    channelId: "C248REGISTRATION",
    rootTs: options.conversationId,
  },
  turnId: `${options.conversationId}:turn:${options.turn}`,
});

describe("process-global Action registration promotion", () => {
  it.live(
    "refreshes A after B promotion and serializes a queued A turn behind promotion",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-248-action-registration-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-248-action-registration-controls-"
          );
          const promptsPath = join(controls, "prompts.jsonl");
          const methodsPath = join(controls, "methods.jsonl");
          const capabilitiesPath = join(controls, "action-capabilities.json");
          yield* Effect.promise(() =>
            writeFile(join(controls, "release"), "ready", { mode: 0o600 })
          );
          const authority = yield* makeAcpAuthorityRepository({
            keyPath: join(controls, "authority.key"),
            statePath: join(controls, "authority.json"),
            trustedRoot: controls,
          });
          const bridge = yield* makeLaborerActionMcpBridge({
            authorityRepository: authority,
            bootstrapPath: join(controls, "action-bootstrap"),
            processGeneration: 248,
            root,
            rootAuthority: `${root}:registration-proof`,
            statePath: capabilitiesPath,
            trustedRuntimeRoot: controls,
            workspaceId: "local",
          });
          const observedInvocations: TrustedActionInvocation[] = [];
          const externalEffects: string[] = [];
          const operationIds = new Set<string>();
          const action: ConversationAction = {
            description: "Create one isolated registration proof",
            invoke: (_input, trusted) =>
              Effect.sync(() => {
                assert.ok(trusted);
                observedInvocations.push(trusted);
                const deduplicated = operationIds.has(trusted.operationId);
                if (!deduplicated) {
                  operationIds.add(trusted.operationId);
                  externalEffects.push(trusted.operationId);
                }
                return {
                  actionName: "create-feature" as const,
                  deduplicated,
                  executionId: `execution:${trusted.operationId}`,
                  status: "running" as const,
                };
              }),
            name: "create-feature",
          };
          const actions = [action] as const;
          const agent = yield* makeAcpConversationAgent({
            actionMcpBridge: bridge,
            args: [scriptedPeerPath],
            command: process.execPath,
            cwd: root,
            durableSessionMode: true,
            environment: {
              ...process.env,
              SCRIPTED_ACP_ACTION_OPERATION_JSON: JSON.stringify({
                prompt: "Exercise the promoted Action registration.",
                worktreeName: "registration-proof",
              }),
              SCRIPTED_ACP_ACTION_ORDINARY_MARKER: ordinaryMarker,
              SCRIPTED_ACP_AGENT_NAME: "OpenCode",
              SCRIPTED_ACP_AGENT_VERSION: "0.0.0-next-16573",
              SCRIPTED_ACP_DISABLE_PROMPT_MARKER: "1",
              SCRIPTED_ACP_DURABLE_SESSIONS_PATH: join(
                controls,
                "durable-sessions.json"
              ),
              SCRIPTED_ACP_MCP_REGISTRATION_DELAY_MILLIS: "150",
              SCRIPTED_ACP_PROMPT_JSONL_PATH: promptsPath,
              SCRIPTED_ACP_READY_PATH: join(controls, "ready"),
              SCRIPTED_ACP_RELEASE_PATH: join(controls, "release"),
              SCRIPTED_ACP_SCENARIO: "action",
              SCRIPTED_ACP_SESSION_METHOD_JSONL_PATH: methodsPath,
              SCRIPTED_ACP_USE_OPENCODE_MESSAGE_IDS: "1",
            },
            processGeneration: 248,
            testHooks: { treatCommandAsOpenCode: true },
          });
          const published: string[] = [];
          const bindingStores = new Map<
            string,
            ConversationAgentSessionBindingStore
          >();
          const bindingStoreFor = (
            conversationId: string
          ): ConversationAgentSessionBindingStore => {
            const existing = bindingStores.get(conversationId);
            if (existing !== undefined) {
              return existing;
            }
            const created = makeSessionBindingStore();
            bindingStores.set(conversationId, created);
            return created;
          };
          const run = (conversationId: string, turn: number, input: string) =>
            agent.handle(
              request({
                actions,
                conversationId,
                input,
                sessionBindingStore: bindingStoreFor(conversationId),
                turn,
              }),
              (message) =>
                Effect.sync(() => {
                  published.push(message.text);
                })
            );

          yield* run("conversation-A", 1, "A new action");
          yield* run("conversation-B", 1, "B new action");
          yield* run("conversation-A", 2, ordinaryMarker);
          yield* run("conversation-A", 3, "A action after B promotion");
          yield* run("conversation-B", 2, ordinaryMarker);

          const promptRecords = yield* Effect.promise(() =>
            readJsonLines<{ readonly sessionId: string }>(promptsPath)
          );
          assert.strictEqual(promptRecords.length, 5);
          const sessionA = promptRecords[0]?.sessionId;
          const sessionB = promptRecords[1]?.sessionId;
          assert.ok(sessionA);
          assert.ok(sessionB);
          assert.notStrictEqual(sessionA, sessionB);
          assert.strictEqual(promptRecords[2]?.sessionId, sessionA);
          assert.strictEqual(promptRecords[3]?.sessionId, sessionA);
          assert.strictEqual(promptRecords[4]?.sessionId, sessionB);
          assert.strictEqual(externalEffects.length, 3);
          assert.strictEqual(observedInvocations.length, 6);
          assert.strictEqual(
            published.filter((text) =>
              text.includes("Ordinary conversation completed")
            ).length,
            2
          );
          const capabilityState = JSON.parse(
            yield* Effect.promise(() => readFile(capabilitiesPath, "utf8"))
          ) as {
            readonly records: readonly {
              readonly actionServerGeneration: number;
            }[];
          };
          const actionGenerations = capabilityState.records.map(
            ({ actionServerGeneration }) => actionServerGeneration
          );
          assert.strictEqual(actionGenerations.length, 3);
          assert.ok((actionGenerations[1] ?? 0) > (actionGenerations[0] ?? 0));
          assert.strictEqual(actionGenerations[2], actionGenerations[1]);
          const sessionMethods = yield* Effect.promise(() =>
            readJsonLines<{
              readonly method: string;
              readonly params: {
                readonly mcpServers?: readonly {
                  readonly env: readonly {
                    readonly name: string;
                    readonly value: string;
                  }[];
                  readonly name: string;
                }[];
              };
            }>(methodsPath)
          );
          assert.strictEqual(sessionMethods.length, 2);
          const actionServers = sessionMethods.map(
            (record) => record.params.mcpServers?.[0]
          );
          assert.ok(actionServers[0]);
          assert.ok(actionServers[1]);
          assert.strictEqual(actionServers[0].name, bridge.serverName);
          assert.strictEqual(actionServers[1].name, bridge.serverName);
          const registeredGenerations = actionServers.map(
            (server) =>
              server?.env.find(
                ({ name }) => name === "LABORER_ACTION_SERVER_GENERATION"
              )?.value
          );
          assert.strictEqual(new Set(registeredGenerations).size, 2);

          const conversationC = run(
            "conversation-C",
            1,
            "C promotion action"
          ).pipe(Effect.forkChild);
          const promotionFiber = yield* conversationC;
          yield* waitForJsonLineCount(methodsPath, 3);
          const queuedA = yield* run("conversation-A", 4, ordinaryMarker).pipe(
            Effect.forkChild
          );
          yield* Effect.sleep("25 millis");
          assert.strictEqual(queuedA.pollUnsafe(), undefined);
          yield* Fiber.join(promotionFiber);
          yield* Fiber.join(queuedA);
          const afterConcurrent = yield* Effect.promise(() =>
            readJsonLines<{ readonly sessionId: string }>(promptsPath)
          );
          assert.strictEqual(afterConcurrent[5]?.sessionId !== sessionA, true);
          assert.strictEqual(afterConcurrent[6]?.sessionId, sessionA);
        })
      ),
    30_000
  );
});
