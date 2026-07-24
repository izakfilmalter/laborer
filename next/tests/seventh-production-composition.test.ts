import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import {
  launchOpenCodeServer,
  type OpenCodePromptInput,
  type OpenCodeSessionClient,
} from "../src/adapters/opencode-agents.ts";
import { ExternalInputEvent } from "../src/application.ts";
import { ThreadId } from "../src/prototype/domain.ts";
import { makeFileStoreLayer } from "../src/prototype/store.ts";
import { makeInMemoryApplicationRepository } from "../src/reference-coding-application.ts";
import { loadLaborerConfig } from "../src/slack/laborer-config.ts";
import { prepareSlackRuntimePaths } from "../src/slack/runtime-paths.ts";
import { makeReferenceCodingWorkspaceApplication } from "../src/slack/workspace-runner.ts";
import { makeTempDirectoryScoped } from "./support/temp-directory.ts";

describe("Tracer 7 production composition", () => {
  it.effect("loads custom and omitted Conversation configuration", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped(
          "laborer-reference-config-"
        );
        yield* Effect.promise(() =>
          writeFile(
            join(root, "laborer.json"),
            JSON.stringify({
              application: {
                agent: "build",
                conversation: {
                  instructions: ["  Route this conversation.  "],
                  operationResultInstructions: [
                    "  Report this operation result.  ",
                  ],
                },
                environment: ["OPENAI_API_KEY"],
                model: "opencode/big-pickle",
                type: "reference-coding",
              },
              retained: true,
            })
          )
        );

        const loaded = yield* loadLaborerConfig({
          defaultRoot: root,
          environment: { PATH: process.env.PATH },
        });

        assert.deepStrictEqual(loaded.config.application, {
          agent: "build",
          conversation: {
            instructions: ["Route this conversation."],
            operationResultInstructions: ["Report this operation result."],
          },
          environment: ["OPENAI_API_KEY"],
          model: "opencode/big-pickle",
          type: "reference-coding",
        });
        assert.ok(!("workHandler" in loaded.config));
        assert.strictEqual(loaded.config.retained, true);

        yield* Effect.promise(() =>
          writeFile(
            join(root, "laborer.json"),
            JSON.stringify({
              application: { type: "reference-coding" },
            })
          )
        );
        const backwardCompatible = yield* loadLaborerConfig({
          defaultRoot: root,
          environment: { PATH: process.env.PATH },
        });
        assert.deepStrictEqual(backwardCompatible.config.application, {
          environment: [],
          type: "reference-coding",
        });
      })
    )
  );

  it.effect("rejects both, neither, and Slack-secret application opt-ins", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped(
          "laborer-exclusive-config-"
        );
        const invalidConfigs = [
          {},
          {
            application: { type: "reference-coding" },
            workHandler: { command: "node" },
          },
          {
            application: {
              environment: ["SLACK_BOT_TOKEN"],
              type: "reference-coding",
            },
          },
          {
            application: {
              model: "missing-provider-separator",
              type: "reference-coding",
            },
          },
          {
            application: {
              conversation: {
                instructions: [],
                operationResultInstructions: ["Report the result."],
              },
              type: "reference-coding",
            },
          },
          {
            application: {
              conversation: {
                instructions: ["Route the turn."],
              },
              type: "reference-coding",
            },
          },
          {
            application: {
              conversation: {
                instructions: ["  \n  "],
                operationResultInstructions: ["Report the result."],
              },
              type: "reference-coding",
            },
          },
          {
            application: {
              conversation: {
                instructions: ["Route the turn."],
                operationResultInstructions: [],
              },
              type: "reference-coding",
            },
          },
          {
            application: {
              conversation: {
                instructions: ["Route the turn."],
                operationResultInstructions: ["  "],
              },
              type: "reference-coding",
            },
          },
        ];

        for (const config of invalidConfigs) {
          yield* Effect.promise(() =>
            writeFile(join(root, "laborer.json"), JSON.stringify(config))
          );
          const result = yield* Effect.result(
            loadLaborerConfig({
              defaultRoot: root,
              environment: { PATH: process.env.PATH },
            })
          );
          assert.strictEqual(result._tag, "Failure");
        }
      })
    )
  );

  it.effect("namespaces the atomic Application state path by workspace", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped("laborer-runtime-paths-");
        const first = yield* prepareSlackRuntimePaths(root, "T-FIRST");
        const second = yield* prepareSlackRuntimePaths(root, "T-SECOND");

        assert.notStrictEqual(first.applicationState, second.applicationState);
        assert.strictEqual(
          first.applicationState,
          join(
            first.root,
            "slack-workspaces",
            "T-FIRST",
            "application-state.json"
          )
        );
      })
    )
  );

  it.effect(
    "starts the cutover Runner without loading an old handler snapshot",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-runner-cutover-"
          );
          const legacyPaths = yield* prepareSlackRuntimePaths(root);
          const first = yield* prepareSlackRuntimePaths(root, "T-FIRST");
          const second = yield* prepareSlackRuntimePaths(root, "T-SECOND");
          const oldRootSnapshot = join(legacyPaths.root, "state.json");
          const oldWorkspaceSnapshot = join(
            first.root,
            "slack-workspaces",
            "T-FIRST",
            "state.json"
          );
          const oldSnapshotContents =
            "old handler snapshot must stay untouched";
          yield* Effect.promise(() =>
            Promise.all([
              writeFile(oldRootSnapshot, oldSnapshotContents),
              writeFile(oldWorkspaceSnapshot, oldSnapshotContents),
            ])
          );

          assert.strictEqual(
            legacyPaths.runnerState,
            join(legacyPaths.root, "runner-state.json")
          );
          assert.strictEqual(
            first.runnerState,
            join(first.root, "slack-workspaces", "T-FIRST", "runner-state.json")
          );
          assert.notStrictEqual(first.runnerState, second.runnerState);
          assert.strictEqual(legacyPaths.lock, first.lock);
          assert.strictEqual(first.lock, second.lock);
          assert.strictEqual(first.lock, join(first.root, "runner.lock"));

          yield* Layer.build(
            makeFileStoreLayer("U-LABORER", legacyPaths.runnerState, first.root)
          );
          yield* Layer.build(
            makeFileStoreLayer("U-LABORER", first.runnerState, first.root)
          );

          assert.strictEqual(
            yield* Effect.promise(() => readFile(oldRootSnapshot, "utf8")),
            oldSnapshotContents
          );
          assert.strictEqual(
            yield* Effect.promise(() => readFile(oldWorkspaceSnapshot, "utf8")),
            oldSnapshotContents
          );
        })
      )
  );

  it.effect(
    "composes one scoped OpenCode client with file state, Git, and a secret-free environment",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-reference-composition-"
          );
          const paths = yield* prepareSlackRuntimePaths(root, "T-COMPOSE");
          const prompts: OpenCodePromptInput[] = [];
          const client: OpenCodeSessionClient = {
            createSession: () => Effect.void,
            interrupt: () => Effect.void,
            readMessages: () =>
              Effect.succeed([
                {
                  id: prompts[0]?.promptId ?? "missing-prompt",
                  role: "user",
                  text: prompts[0]?.text ?? "",
                },
                {
                  id: "composition-reply",
                  role: "assistant",
                  text: JSON.stringify({
                    text: "Composition configured.",
                    type: "reply",
                  }),
                },
              ]),
            sessionExists: () => Effect.succeed(false),
            submitPrompt: (input) =>
              Effect.sync(() => {
                prompts.push(input);
              }),
            wait: () => Effect.void,
          };
          let clientCalls = 0;
          let repositoryPath = "";
          let repositoryRoot = "";
          let worktreeRoot = "";
          let serverEnvironment: NodeJS.ProcessEnv = {};

          const application = yield* makeReferenceCodingWorkspaceApplication(
            {
              config: {
                agent: "build",
                conversation: {
                  instructions: ["Production routing instruction."],
                  operationResultInstructions: [
                    "Production operation-result instruction.",
                  ],
                },
                environment: ["OPENAI_API_KEY"],
                model: "opencode/big-pickle",
                type: "reference-coding",
              },
              environment: {
                OPENAI_API_KEY: "provider-secret",
                PATH: process.env.PATH,
                SLACK_BOT_TOKEN: "must-not-cross-boundary",
              },
              paths,
              root,
            },
            {
              makeApplicationRepository: (path, trustedRoot) => {
                repositoryPath = path;
                repositoryRoot = trustedRoot;
                return makeInMemoryApplicationRepository();
              },
              makeOpenCodeClient: (options) => {
                clientCalls += 1;
                serverEnvironment = options.environment;
                assert.strictEqual(options.agent, "build");
                assert.deepStrictEqual(options.model, {
                  modelID: "big-pickle",
                  providerID: "opencode",
                });
                assert.strictEqual(options.promptIsolation, false);
                assert.strictEqual(options.workspaceDirectory, root);
                return Effect.succeed(client);
              },
              makeWorktreeManager: (options) => {
                worktreeRoot = options.repository;
                return {
                  create: () =>
                    Effect.die(
                      new Error(
                        "ordinary Conversation must not create worktree"
                      )
                    ),
                };
              },
            }
          );
          yield* application.handle(
            ExternalInputEvent.make({
              conversationId: ThreadId.make("production-composition-thread"),
              eventId: "production-composition-event",
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

          assert.strictEqual(clientCalls, 1);
          assert.strictEqual(repositoryPath, paths.applicationState);
          assert.strictEqual(repositoryRoot, paths.root);
          assert.strictEqual(worktreeRoot, root);
          assert.strictEqual(
            serverEnvironment.OPENAI_API_KEY,
            "provider-secret"
          );
          assert.ok(!("SLACK_BOT_TOKEN" in serverEnvironment));
          const prompt = JSON.parse(prompts[0]?.text ?? "{}") as {
            readonly instructions?: unknown;
          };
          assert.deepStrictEqual(prompt.instructions, [
            "Production routing instruction.",
          ]);
        })
      )
  );

  it.effect("tracks reference-coding instead of the forced handler mode", () =>
    Effect.gen(function* () {
      const source = yield* Effect.promise(() =>
        readFile(join(process.cwd(), "laborer.json"), "utf8")
      );
      const config = JSON.parse(source) as Record<string, unknown>;
      assert.deepStrictEqual(config.application, {
        conversation: {
          instructions: [
            "You are the Conversation agent. Decide autonomously whether to invoke an available Action or reply to Slack.",
            "You are a routing agent, not an implementation agent. Do not call todowrite, task, skill, or other orchestration tools. Decide directly from the supplied conversation. Use repository inspection tools only when required to answer a repository question.",
            "The current OpenCode session is the durable conversation for this Slack thread. Use its prior messages, tool activity, and operation results as continuing context.",
            "Return exactly one JSON object and no markdown.",
            'Action: {"type":"action","action":"<available name>","input":<JSON>}.',
            'Execution control: {"type":"execution_control","control":"<available name>","input":<JSON>}.',
            'Reply: {"type":"reply","text":"<Slack reply>"}.',
            "Only a reply record is shown to Slack. Coding Actions and generic Execution controls are separate interfaces.",
          ],
          operationResultInstructions: [
            "You are the Conversation agent continuing the current Slack thread after an operation result.",
            "Use the supplied conversation and operation result to describe whether the requested operation succeeded or failed.",
            "Return exactly one JSON object and no markdown.",
            'Reply: {"type":"reply","text":"<concise Slack reply describing success or failure>"}.',
            "Do not request another Action or Execution control.",
          ],
        },
        environment: [
          "ANTHROPIC_API_KEY",
          "LABORER_OPENCODE_MODEL",
          "OPENCODE_CONFIG_CONTENT",
          "OPENAI_API_KEY",
        ],
        type: "reference-coding",
      });
      assert.ok(!("prototype" in config));
      assert.ok(!("workHandler" in config));
    })
  );

  it.effect("launches OpenCode with exactly the sanitized environment", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped("laborer-opencode-launch-");
        const capturePath = join(root, "captured-environment");
        yield* Effect.promise(() =>
          writeFile(
            join(root, "opencode"),
            `#!/bin/sh\nprintf '%s' "\${OPENAI_API_KEY-unset}|\${SLACK_BOT_TOKEN-unset}" > "\${CAPTURE_PATH}"\nprintf 'opencode server listening on http://127.0.0.1:43210\\n'\nwhile :; do /bin/sleep 1; done\n`,
            { mode: 0o700 }
          )
        );

        const server = yield* Effect.acquireRelease(
          Effect.promise(() =>
            launchOpenCodeServer({
              environment: {
                CAPTURE_PATH: capturePath,
                OPENAI_API_KEY: "provider-secret",
                PATH: root,
              },
              hostname: "127.0.0.1",
              port: 0,
              timeoutMs: 2000,
            })
          ),
          (running) => Effect.promise(running.close)
        );

        assert.strictEqual(server.url, "http://127.0.0.1:43210");
        assert.strictEqual(
          yield* Effect.promise(() => readFile(capturePath, "utf8")),
          "provider-secret|unset"
        );
      })
    )
  );
});
