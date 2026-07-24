import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  makeOpenCodeConversationAgent,
  type OpenCodePromptInput,
  type OpenCodeSessionClient,
  type OpenCodeWorkspaceSessionClientOptions,
} from "../src/adapters/opencode-agents.ts";
import { ExternalInputEvent } from "../src/application.ts";
import { ThreadId } from "../src/prototype/domain.ts";
import {
  type ConversationAgentRequest,
  makeInMemoryApplicationRepository,
} from "../src/reference-coding-application.ts";
import { makeHotReloadingConversationPromptConfig } from "../src/slack/conversation-prompt-config.ts";
import {
  loadLaborerConfig,
  type ReferenceCodingApplicationConfig,
} from "../src/slack/laborer-config.ts";
import { prepareSlackRuntimePaths } from "../src/slack/runtime-paths.ts";
import { makeReferenceCodingWorkspaceApplication } from "../src/slack/workspace-runner.ts";
import { makeTempDirectoryScoped } from "./support/temp-directory.ts";

const applicationConfig = (options: {
  readonly agent?: string;
  readonly environment?: readonly string[];
  readonly instructions: readonly string[];
  readonly model?: string;
  readonly operationResultInstructions: readonly string[];
}): ReferenceCodingApplicationConfig => ({
  ...(options.agent === undefined ? {} : { agent: options.agent }),
  conversation: {
    instructions: options.instructions,
    operationResultInstructions: options.operationResultInstructions,
  },
  environment: options.environment ?? [],
  ...(options.model === undefined ? {} : { model: options.model }),
  type: "reference-coding",
});

const writeLaborerConfig = (
  root: string,
  application: ReferenceCodingApplicationConfig
): Promise<void> =>
  writeFile(join(root, "laborer.json"), JSON.stringify({ application }));

const request = (index: number): ConversationAgentRequest => ({
  actions: [],
  context: [],
  conversationId: `conversation-${index}`,
  conversationSessionId: `conversation-session-${index}`,
  conversationSessionIsNew: true,
  executions: [],
  executionControls: [],
  input: `Input ${index}`,
  messages: [],
  promptId: `conversation-prompt-${index}`,
  source: "test",
  turnId: `turn-${index}`,
});

const makeReplyingClient = (
  prompted: OpenCodePromptInput[]
): OpenCodeSessionClient => ({
  createSession: () => Effect.void,
  interrupt: () => Effect.void,
  readMessages: (input) => {
    const prompt = prompted.find(
      (candidate) => candidate.promptId === input.promptId
    );
    return Effect.succeed([
      {
        id: input.promptId,
        role: "user" as const,
        text: prompt?.text ?? "",
      },
      {
        id: `${input.promptId}:assistant`,
        role: "assistant" as const,
        text: JSON.stringify({ text: "Done.", type: "reply" }),
      },
    ]);
  },
  sessionExists: () => Effect.succeed(false),
  submitPrompt: (input) =>
    Effect.sync(() => {
      prompted.push(input);
    }),
  wait: () => Effect.void,
});

const promptInstructions = (prompt: OpenCodePromptInput | undefined): unknown =>
  (
    JSON.parse(prompt?.text ?? "{}") as {
      readonly instructions?: unknown;
    }
  ).instructions;

describe("Conversation prompt configuration hot reload", () => {
  it.effect(
    "observes prompt edits on a subsequent workspace invocation while runtime settings stay startup-bound",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-conversation-hot-reload-"
          );
          const startupConfig = applicationConfig({
            agent: "startup-agent",
            environment: ["STARTUP_PROVIDER_KEY"],
            instructions: ["Startup conversation instruction."],
            model: "startup/model",
            operationResultInstructions: ["Startup result instruction."],
          });
          yield* Effect.promise(() => writeLaborerConfig(root, startupConfig));
          const environment = {
            PATH: process.env.PATH,
            STARTUP_PROVIDER_KEY: "startup-secret",
          };
          const loaded = yield* loadLaborerConfig({
            defaultRoot: root,
            environment,
          });
          const paths = yield* prepareSlackRuntimePaths(root, "T-HOT-RELOAD");
          const prompted: OpenCodePromptInput[] = [];
          let clientCreations = 0;
          let sessionCreated = false;
          let startupClientOptions:
            | OpenCodeWorkspaceSessionClientOptions
            | undefined;
          const client: OpenCodeSessionClient = {
            ...makeReplyingClient(prompted),
            createSession: () =>
              Effect.sync(() => {
                sessionCreated = true;
              }),
            sessionExists: () => Effect.sync(() => sessionCreated),
          };
          const application = yield* makeReferenceCodingWorkspaceApplication(
            {
              config: loaded.config.application ?? startupConfig,
              environment,
              paths,
              root,
            },
            {
              makeApplicationRepository: () =>
                makeInMemoryApplicationRepository(),
              makeOpenCodeClient: (options) =>
                Effect.sync(() => {
                  clientCreations += 1;
                  startupClientOptions = options;
                  return client;
                }),
              makeWorktreeManager: () => ({
                create: () =>
                  Effect.die(
                    new Error("ordinary Conversation must not create worktree")
                  ),
              }),
            }
          );
          const conversationId = ThreadId.make("CHOTRELOAD:1.0");
          const invoke = (eventId: string) =>
            application.handle(
              ExternalInputEvent.make({
                conversationId,
                eventId,
                payload: {},
                source: "test",
              }),
              () => Effect.void,
              (event) =>
                Effect.succeed({
                  decision: {
                    _tag: "Accepted" as const,
                    eventId: event.eventId,
                  },
                  scheduling: "Scheduled" as const,
                })
            );

          yield* invoke("event-1");
          yield* Effect.promise(() =>
            writeLaborerConfig(
              root,
              applicationConfig({
                agent: "edited-agent",
                environment: ["EDITED_PROVIDER_KEY"],
                instructions: ["Reloaded conversation instruction."],
                model: "edited/model",
                operationResultInstructions: ["Reloaded result instruction."],
              })
            )
          );
          yield* invoke("event-2");

          assert.deepStrictEqual(promptInstructions(prompted[0]), [
            "Startup conversation instruction.",
          ]);
          assert.deepStrictEqual(promptInstructions(prompted[1]), [
            "Reloaded conversation instruction.",
          ]);
          assert.strictEqual(clientCreations, 1);
          assert.strictEqual(startupClientOptions?.agent, "startup-agent");
          assert.deepStrictEqual(startupClientOptions?.model, {
            modelID: "model",
            providerID: "startup",
          });
          assert.strictEqual(
            startupClientOptions?.environment.STARTUP_PROVIDER_KEY,
            "startup-secret"
          );
          assert.ok(
            !(
              "EDITED_PROVIDER_KEY" in (startupClientOptions?.environment ?? {})
            )
          );
        })
      )
  );

  it.effect(
    "retains the last known-good prompt after an invalid edit and recovers after a valid edit",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-conversation-recovery-"
          );
          const startupConfig = applicationConfig({
            instructions: ["Startup instruction."],
            operationResultInstructions: ["Startup result instruction."],
          });
          yield* Effect.promise(() => writeLaborerConfig(root, startupConfig));
          const loadPromptConfig =
            yield* makeHotReloadingConversationPromptConfig({
              environment: { PATH: process.env.PATH },
              initialConfig: startupConfig,
              root,
            });
          const prompted: OpenCodePromptInput[] = [];
          const agent = makeOpenCodeConversationAgent({
            client: makeReplyingClient(prompted),
            loadPromptConfig,
            repositoryDirectory: root,
          });

          yield* agent.handle(request(1));
          yield* Effect.promise(() =>
            writeLaborerConfig(
              root,
              applicationConfig({
                instructions: ["First valid edit."],
                operationResultInstructions: ["First valid result edit."],
              })
            )
          );
          yield* agent.handle(request(2));
          yield* Effect.promise(() =>
            writeFile(join(root, "laborer.json"), "{ invalid json")
          );
          yield* agent.handle(request(3));
          yield* Effect.promise(() =>
            writeLaborerConfig(
              root,
              applicationConfig({
                instructions: ["Recovered valid edit."],
                operationResultInstructions: ["Recovered result edit."],
              })
            )
          );
          yield* agent.handle(request(4));

          assert.deepStrictEqual(prompted.map(promptInstructions), [
            ["Startup instruction."],
            ["First valid edit."],
            ["First valid edit."],
            ["Recovered valid edit."],
          ]);
        })
      )
  );

  it.effect(
    "reloads operation-result instructions before the result prompt",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-operation-result-hot-reload-"
          );
          const startupConfig = applicationConfig({
            instructions: ["Invoke the Action."],
            operationResultInstructions: ["Old result instruction."],
          });
          yield* Effect.promise(() => writeLaborerConfig(root, startupConfig));
          const loadPromptConfig =
            yield* makeHotReloadingConversationPromptConfig({
              environment: { PATH: process.env.PATH },
              initialConfig: startupConfig,
              root,
            });
          const prompted: OpenCodePromptInput[] = [];
          const client: OpenCodeSessionClient = {
            createSession: () => Effect.void,
            interrupt: () => Effect.void,
            readMessages: (input) => {
              const prompt = prompted.find(
                (candidate) => candidate.promptId === input.promptId
              );
              const isResult = input.promptId.endsWith(":action-result:1");
              return Effect.succeed([
                {
                  id: input.promptId,
                  role: "user" as const,
                  text: prompt?.text ?? "",
                },
                {
                  id: `${input.promptId}:assistant`,
                  role: "assistant" as const,
                  text: JSON.stringify(
                    isResult
                      ? { text: "Action completed.", type: "reply" }
                      : {
                          action: "create-feature",
                          input: {
                            prompt: "Build it",
                            worktreeName: "build-it",
                          },
                          type: "action",
                        }
                  ),
                },
              ]);
            },
            sessionExists: () => Effect.succeed(false),
            submitPrompt: (input) =>
              Effect.sync(() => {
                prompted.push(input);
              }),
            wait: () => Effect.void,
          };
          const agent = makeOpenCodeConversationAgent({
            client,
            loadPromptConfig,
            repositoryDirectory: root,
          });

          yield* agent.handle({
            ...request(1),
            actions: [
              {
                description: "Implement a feature.",
                invoke: () =>
                  Effect.promise(() =>
                    writeLaborerConfig(
                      root,
                      applicationConfig({
                        instructions: ["Updated ordinary instruction."],
                        operationResultInstructions: [
                          "Current result instruction.",
                        ],
                      })
                    )
                  ).pipe(
                    Effect.as({ executionId: "execution-1", status: "running" })
                  ),
                name: "create-feature",
              },
            ],
          });

          assert.deepStrictEqual(promptInstructions(prompted[0]), [
            "Invoke the Action.",
          ]);
          assert.deepStrictEqual(promptInstructions(prompted[1]), [
            "Current result instruction.",
          ]);
        })
      )
  );
});
