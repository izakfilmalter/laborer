import { access, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { makeAcpConversationAgent } from "../src/acp-conversation-prototype/acp-conversation-agent.ts";
import { prepareAcpAgentContextSources } from "../src/acp-conversation-prototype/agent-context.ts";
import { makeLaborerMemoryMcpServerConfiguration } from "../src/acp-conversation-prototype/memory-mcp.ts";
import { MessageId, NormalizedMessage } from "../src/prototype/domain.ts";
import { HandlerFailure } from "../src/prototype/errors.ts";
import type { ConversationAgentRequest } from "../src/reference-coding-application.ts";
import { makeTempDirectoryScoped } from "./support/temp-directory.ts";

const scriptedPeerPath = resolve(
  process.cwd(),
  "tests/fixtures/scripted-acp-peer.ts"
);
const NON_DIGIT_PATTERN = /\D/g;
const SESSION_NEW_LINE_PATTERN = /session:new:[^\n]+/;
const SESSION_CLOSE_LINE_PATTERN = /session:close:[^\n]+/;
const MEMORY_SERVER_NAME_PATTERN = /^laborer-memory-[a-f0-9]{16}-[a-f0-9]{32}$/;
const AUTHORITY_GUARD_PATTERN = /^[a-f0-9]{64}$/;
const REGISTRATION_NONCE_PATTERN = /^[a-f0-9-]{36}$/;
const MEMORY_READY_PATH_PATTERN = /memory-mcp-readiness-[a-f0-9]{32}$/;

const request = (
  conversationId: string,
  promptId: string
): ConversationAgentRequest => ({
  actions: [],
  context: [],
  conversationId,
  conversationSessionId: `logical:${conversationId}`,
  conversationSessionIsNew: promptId === "prompt:one",
  executionControls: [],
  executions: [],
  input: promptId,
  messages: [],
  promptId,
  source: "slack",
  turnId: `turn:${promptId}`,
});

const participantRequest = (options: {
  readonly authorSlackId: string;
  readonly conversationId: string;
  readonly promptId: string;
}): ConversationAgentRequest => {
  const message = NormalizedMessage.make({
    authorKind: "human",
    authorSlackId: options.authorSlackId,
    classification: "input",
    id: MessageId.make(`${options.promptId}:message`),
    isActivation: true,
    slackTs: `241.${options.promptId.replaceAll(NON_DIGIT_PATTERN, "") || "1"}`,
    text: `message from ${options.authorSlackId}`,
  });
  return {
    ...request(options.conversationId, options.promptId),
    input: message.text,
    messages: [message],
  };
};

const jsonLines = async (path: string): Promise<readonly unknown[]> =>
  (await readFile(path, "utf8"))
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const doesNotExist = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return false;
  } catch {
    return true;
  }
};

const waitForOwnedProcessExit = Effect.fnUntraced(function* (pidPath: string) {
  let pid: number | undefined;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (pid === undefined) {
      pid = yield* Effect.promise(() =>
        readFile(pidPath, "utf8").then(
          (source) => Number(source),
          () => undefined
        )
      );
    }
    if (pid !== undefined) {
      const processId = pid;
      const alive = yield* Effect.sync(() => {
        try {
          process.kill(processId, 0);
          return true;
        } catch {
          return false;
        }
      });
      if (!alive) {
        return;
      }
    }
    yield* Effect.sleep("10 millis");
  }
  return yield* Effect.die(
    new Error(`owned test process did not exit: ${pidPath}`)
  );
});

const waitForPath = Effect.fnUntraced(function* (path: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!(yield* Effect.promise(() => doesNotExist(path)))) {
      return;
    }
    yield* Effect.sleep("10 millis");
  }
  return yield* Effect.die(new Error(`timed out waiting for ${path}`));
});

describe("issue #241 reviewed ACP restart edges", () => {
  it.live(
    "discards stale resumed chunks outside active prompt boundaries",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-acp-stale-resume-chunks-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-acp-stale-resume-chunks-controls-"
          );
          const sources = yield* prepareAcpAgentContextSources({
            root,
            workspaceId: "T241STALECHUNKS",
          });
          const staleMarkerPath = join(controls, "stale-delivered");
          const environment = {
            ...process.env,
            SCRIPTED_ACP_DURABLE_STATE_PATH: join(controls, "peer.json"),
            SCRIPTED_ACP_READY_PATH: join(controls, "ready"),
            SCRIPTED_ACP_RELEASE_PATH: join(controls, "release"),
            SCRIPTED_ACP_SCENARIO: "resume",
          };
          yield* Effect.scoped(
            Effect.gen(function* () {
              const agent = yield* makeAcpConversationAgent({
                agentContext: sources,
                args: [scriptedPeerPath],
                command: process.execPath,
                cwd: root,
                environment,
              });
              yield* agent.handle(
                request("conversation:stale-chunks", "prompt:one"),
                () => Effect.void
              );
            })
          );

          const published: string[] = [];
          yield* Effect.scoped(
            Effect.gen(function* () {
              const agent = yield* makeAcpConversationAgent({
                agentContext: sources,
                args: [scriptedPeerPath],
                command: process.execPath,
                cwd: root,
                environment: {
                  ...environment,
                  SCRIPTED_ACP_DELAYED_STALE_CHUNK_PATH: staleMarkerPath,
                },
              });
              const publish = (message: { readonly text: string }) =>
                Effect.sync(() => {
                  published.push(message.text);
                });
              yield* agent.handle(
                request("conversation:stale-chunks", "prompt:two"),
                publish
              );
              yield* waitForPath(staleMarkerPath);
              yield* agent.handle(
                request("conversation:stale-chunks", "prompt:three"),
                publish
              );
            })
          );
          assert.deepStrictEqual(published, [
            "Durable reply 2",
            "Durable reply 3",
          ]);
        })
      ),
    15_000
  );

  it.live(
    "durably suppresses terminal peer, output-limit, and publication failures before allowing a distinct turn",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const controls = yield* makeTempDirectoryScoped(
            "laborer-acp-terminal-suppression-"
          );
          const cases = ["queued-failure", "output-limit", "publish"] as const;
          for (const [index, testCase] of cases.entries()) {
            const root = yield* makeTempDirectoryScoped(
              `laborer-acp-terminal-${testCase}-`
            );
            const sources = yield* prepareAcpAgentContextSources({
              root,
              workspaceId: `T241TERMINAL${index}`,
            });
            const releasePath = join(controls, `${testCase}-release`);
            if (testCase === "queued-failure") {
              yield* Effect.promise(() => writeFile(releasePath, "release"));
            }
            const lifecyclePath = join(controls, `${testCase}-lifecycle.log`);
            const agent = yield* makeAcpConversationAgent({
              agentContext: sources,
              args: [scriptedPeerPath],
              command: process.execPath,
              cwd: root,
              environment: {
                ...process.env,
                SCRIPTED_ACP_DURABLE_STATE_PATH: join(
                  controls,
                  `${testCase}-peer.json`
                ),
                SCRIPTED_ACP_LIFECYCLE_LOG_PATH: lifecyclePath,
                SCRIPTED_ACP_READY_PATH: join(controls, `${testCase}-ready`),
                SCRIPTED_ACP_RELEASE_PATH: releasePath,
                SCRIPTED_ACP_SCENARIO:
                  testCase === "publish" ? "resume" : testCase,
              },
            });
            let rejectPublication = testCase === "publish";
            const first = yield* Effect.result(
              agent.handle(
                request(`conversation:terminal-${index}`, "prompt:one"),
                () => {
                  if (rejectPublication) {
                    rejectPublication = false;
                    return HandlerFailure.make({
                      category: "protocol",
                      safeDetail: null,
                    });
                  }
                  return Effect.void;
                }
              )
            );
            assert.strictEqual(first._tag, "Failure", testCase);
            const stateAfterFailure = JSON.parse(
              yield* Effect.promise(() =>
                readFile(sources.acpConversationStatePath, "utf8")
              )
            ) as {
              readonly conversations: readonly {
                readonly inFlightPromptId: string | null;
                readonly suppressedPromptId: string | null;
              }[];
            };
            assert.strictEqual(
              stateAfterFailure.conversations[0]?.inFlightPromptId,
              null,
              testCase
            );
            assert.strictEqual(
              stateAfterFailure.conversations[0]?.suppressedPromptId,
              "prompt:one",
              testCase
            );

            const duplicate = yield* Effect.result(
              agent.handle(
                request(`conversation:terminal-${index}`, "prompt:one"),
                () => Effect.void
              )
            );
            assert.strictEqual(duplicate._tag, "Failure", testCase);
            yield* agent.handle(
              request(`conversation:terminal-${index}`, "prompt:two"),
              () => Effect.void
            );
            const lifecycle = yield* Effect.promise(() =>
              readFile(lifecyclePath, "utf8")
            );
            assert.strictEqual(
              lifecycle.split("\n").filter((line) => line.startsWith("prompt:"))
                .length,
              2,
              testCase
            );
          }
        })
      ),
    20_000
  );

  it.live(
    "replaces a generic OpenCode resume failure only after one complete unpaginated list omits the session",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const controls = yield* makeTempDirectoryScoped(
            "laborer-acp-opencode-list-"
          );
          const cases = [
            { listMode: "absent", listPages: 1, replaces: true },
            { listMode: "absent-99", listPages: 1, replaces: true },
            { listMode: "absent-100", listPages: 1, replaces: false },
            { listMode: "multipage-absent", listPages: 1, replaces: false },
            { listMode: "present", listPages: 1, replaces: false },
            { listMode: "multipage-present", listPages: 1, replaces: false },
            { listMode: "tied-timestamp", listPages: 1, replaces: false },
            { listMode: "error", listPages: 1, replaces: false },
            { listMode: "malformed", listPages: 1, replaces: false },
            { listMode: "hang", listPages: 1, replaces: false },
            { listMode: "unsupported", listPages: 0, replaces: false },
          ] as const;
          for (const [index, testCase] of cases.entries()) {
            const root = yield* makeTempDirectoryScoped(
              `laborer-acp-opencode-list-${testCase.listMode}-`
            );
            const sources = yield* prepareAcpAgentContextSources({
              root,
              workspaceId: `T241LIST${index}`,
            });
            const requestsPath = join(
              controls,
              `${testCase.listMode}-requests.jsonl`
            );
            const lifecyclePath = join(
              controls,
              `${testCase.listMode}-lifecycle.log`
            );
            const environment = {
              ...process.env,
              SCRIPTED_ACP_DURABLE_STATE_PATH: join(
                controls,
                `${testCase.listMode}-peer.json`
              ),
              SCRIPTED_ACP_LIFECYCLE_LOG_PATH: lifecyclePath,
              SCRIPTED_ACP_READY_PATH: join(
                controls,
                `${testCase.listMode}-ready`
              ),
              SCRIPTED_ACP_RELEASE_PATH: join(
                controls,
                `${testCase.listMode}-release`
              ),
              SCRIPTED_ACP_SCENARIO: "resume",
              SCRIPTED_ACP_SESSION_REQUEST_JSONL_PATH: requestsPath,
            };
            const makeAgent = (restart: boolean) =>
              makeAcpConversationAgent({
                agentContext: sources,
                args: [scriptedPeerPath],
                command: process.execPath,
                cwd: root,
                environment: restart
                  ? {
                      ...environment,
                      ...(testCase.listMode === "unsupported"
                        ? { SCRIPTED_ACP_ADVERTISE_LIST: "0" }
                        : {}),
                      SCRIPTED_ACP_LIST_MODE: testCase.listMode,
                      SCRIPTED_ACP_RESUME_ERROR_KIND: "opencode-missing",
                    }
                  : environment,
                sessionEstablishTimeoutMillis:
                  restart && testCase.listMode === "hang" ? 100 : 1000,
              });
            yield* Effect.scoped(
              Effect.gen(function* () {
                const agent = yield* makeAgent(false);
                yield* agent.handle(
                  request(`conversation:list-${index}`, "prompt:one"),
                  () => Effect.void
                );
              })
            );
            const restart = yield* Effect.scoped(
              Effect.gen(function* () {
                const agent = yield* makeAgent(true);
                return yield* Effect.result(
                  agent.handle(
                    request(`conversation:list-${index}`, "prompt:two"),
                    () => Effect.void
                  )
                );
              })
            );
            assert.strictEqual(
              restart._tag,
              testCase.replaces ? "Success" : "Failure",
              testCase.listMode
            );
            const sessionRequests = yield* Effect.promise(() =>
              jsonLines(requestsPath)
            );
            assert.strictEqual(
              sessionRequests.length,
              testCase.replaces ? 3 : 2,
              testCase.listMode
            );
            const resumeRequest = sessionRequests[1];
            assert.ok(isRecord(resumeRequest));
            const persistedState = JSON.parse(
              yield* Effect.promise(() =>
                readFile(sources.acpConversationStatePath, "utf8")
              )
            ) as {
              readonly conversations: readonly {
                readonly sessionId: string;
              }[];
            };
            if (isRecord(resumeRequest)) {
              assert.strictEqual(
                persistedState.conversations[0]?.sessionId ===
                  resumeRequest.sessionId,
                !testCase.replaces,
                testCase.listMode
              );
            }
            const lifecycle = yield* Effect.promise(() =>
              readFile(lifecyclePath, "utf8")
            );
            assert.strictEqual(
              lifecycle.split("session:list:").length - 1,
              testCase.listPages,
              testCase.listMode
            );
            assert.strictEqual(
              lifecycle.split("session:new:").length - 1,
              testCase.replaces ? 2 : 1,
              testCase.listMode
            );
          }
        })
      ),
    30_000
  );

  it.live(
    "never replaces sessions for unsupported, timeout, or non-definitive resume failures",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const controls = yield* makeTempDirectoryScoped(
            "laborer-acp-resume-errors-"
          );
          const cases = [
            { advertise: "0", error: undefined, name: "unsupported" },
            { advertise: "1", error: "internal", name: "internal" },
            { advertise: "1", error: "auth", name: "auth" },
            { advertise: "1", error: "cwd", name: "cwd" },
            {
              advertise: "1",
              error: "malformed-unavailable",
              name: "malformed",
            },
            { advertise: "1", error: "hang", name: "timeout" },
          ] as const;
          for (const [index, testCase] of cases.entries()) {
            const root = yield* makeTempDirectoryScoped(
              `laborer-acp-resume-${testCase.name}-`
            );
            const sources = yield* prepareAcpAgentContextSources({
              root,
              workspaceId: `T241ERR${index}`,
            });
            const durablePath = join(controls, `${testCase.name}-peer.json`);
            const requestsPath = join(
              controls,
              `${testCase.name}-requests.jsonl`
            );
            const lifecyclePath = join(
              controls,
              `${testCase.name}-lifecycle.log`
            );
            const baseEnvironment = {
              ...process.env,
              SCRIPTED_ACP_DURABLE_STATE_PATH: durablePath,
              SCRIPTED_ACP_LIFECYCLE_LOG_PATH: lifecyclePath,
              SCRIPTED_ACP_READY_PATH: join(controls, `${testCase.name}-ready`),
              SCRIPTED_ACP_RELEASE_PATH: join(
                controls,
                `${testCase.name}-release`
              ),
              SCRIPTED_ACP_SCENARIO: "resume",
              SCRIPTED_ACP_SESSION_REQUEST_JSONL_PATH: requestsPath,
            };
            const makeAgent = (environment: NodeJS.ProcessEnv) =>
              makeAcpConversationAgent({
                agentContext: sources,
                args: [scriptedPeerPath],
                command: process.execPath,
                cwd: root,
                environment,
                sessionEstablishTimeoutMillis: 100,
              });
            yield* Effect.scoped(
              Effect.gen(function* () {
                const agent = yield* makeAgent(baseEnvironment);
                yield* agent.handle(
                  request(`conversation:${testCase.name}`, "prompt:one"),
                  () => Effect.void
                );
              })
            );
            const startedAt = Date.now();
            const restart = yield* Effect.scoped(
              Effect.gen(function* () {
                const agent = yield* makeAgent({
                  ...baseEnvironment,
                  SCRIPTED_ACP_ADVERTISE_RESUME: testCase.advertise,
                  ...(testCase.error === undefined
                    ? {}
                    : { SCRIPTED_ACP_RESUME_ERROR_KIND: testCase.error }),
                });
                return yield* Effect.result(
                  agent.handle(
                    request(`conversation:${testCase.name}`, "prompt:two"),
                    () => Effect.void
                  )
                );
              })
            );
            assert.strictEqual(restart._tag, "Failure", testCase.name);
            if (testCase.name === "timeout") {
              assert.ok(Date.now() - startedAt < 3000);
            }
            const sessionRequests = yield* Effect.promise(() =>
              jsonLines(requestsPath)
            );
            assert.strictEqual(
              sessionRequests.length,
              testCase.name === "unsupported" ? 1 : 2,
              testCase.name
            );
            const lifecycle = yield* Effect.promise(() =>
              readFile(lifecyclePath, "utf8")
            );
            assert.strictEqual(
              lifecycle.match(/session:new:/g)?.length,
              1,
              testCase.name
            );
          }
        })
      ),
    30_000
  );

  it.live(
    "settles a definitive prompt error so a later turn can continue",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-acp-definitive-prompt-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-acp-definitive-prompt-controls-"
          );
          const sources = yield* prepareAcpAgentContextSources({
            root,
            workspaceId: "T241DEFINITIVE",
          });
          const releasePath = join(controls, "release");
          yield* Effect.promise(() => writeFile(releasePath, "release"));
          const agent = yield* makeAcpConversationAgent({
            agentContext: sources,
            args: [scriptedPeerPath],
            command: process.execPath,
            cwd: root,
            environment: {
              ...process.env,
              SCRIPTED_ACP_DURABLE_STATE_PATH: join(controls, "peer.json"),
              SCRIPTED_ACP_READY_PATH: join(controls, "ready"),
              SCRIPTED_ACP_RELEASE_PATH: releasePath,
              SCRIPTED_ACP_SCENARIO: "queued-failure",
              SCRIPTED_ACP_SESSION_REQUEST_JSONL_PATH: join(
                controls,
                "requests.jsonl"
              ),
            },
          });
          const first = yield* Effect.result(
            agent.handle(
              request("conversation:definitive", "prompt:one"),
              () => Effect.void
            )
          );
          assert.strictEqual(first._tag, "Failure");
          const published: string[] = [];
          yield* agent.handle(
            request("conversation:definitive", "prompt:two"),
            (message) =>
              Effect.sync(() => {
                published.push(message.text);
              })
          );
          assert.deepStrictEqual(published, ["Queued turn recovered"]);
        })
      ),
    15_000
  );

  it.live(
    "quarantines the owned connection after a duplicate live session ID",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-acp-live-collision-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-acp-live-collision-controls-"
          );
          const sources = yield* prepareAcpAgentContextSources({
            root,
            workspaceId: "T241LIVECOLLISION",
          });
          const pidPath = join(controls, "peer.pid");
          const agent = yield* makeAcpConversationAgent({
            agentContext: sources,
            args: [scriptedPeerPath],
            command: process.execPath,
            cwd: root,
            environment: {
              ...process.env,
              SCRIPTED_ACP_DUPLICATE_SESSION_ID: "duplicate-live-session-241",
              SCRIPTED_ACP_DURABLE_STATE_PATH: join(controls, "peer.json"),
              SCRIPTED_ACP_PID_PATH: pidPath,
              SCRIPTED_ACP_READY_PATH: join(controls, "ready"),
              SCRIPTED_ACP_RELEASE_PATH: join(controls, "release"),
              SCRIPTED_ACP_SCENARIO: "resume",
            },
          });
          yield* agent.handle(
            request("conversation:first", "prompt:one"),
            () => Effect.void
          );
          const collision = yield* Effect.result(
            agent.handle(
              request("conversation:second", "prompt:one"),
              () => Effect.void
            )
          );
          assert.strictEqual(collision._tag, "Failure");
          yield* waitForOwnedProcessExit(pidPath);
          const firstOwnerAfterCorruption = yield* Effect.result(
            agent.handle(
              request("conversation:first", "prompt:two"),
              () => Effect.void
            )
          );
          assert.strictEqual(firstOwnerAfterCorruption._tag, "Failure");
        })
      ),
    15_000
  );

  it.live(
    "serializes concurrent session claims and quarantines a duplicate ID without memory MCP",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-acp-concurrent-live-collision-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-acp-concurrent-live-collision-controls-"
          );
          const sources = yield* prepareAcpAgentContextSources({
            root,
            workspaceId: "T241CONCURRENTCOLLISION",
          });
          const pidPath = join(controls, "peer.pid");
          const agent = yield* makeAcpConversationAgent({
            agentContext: sources,
            args: [scriptedPeerPath],
            command: process.execPath,
            cwd: root,
            environment: {
              ...process.env,
              SCRIPTED_ACP_DUPLICATE_SESSION_ID:
                "duplicate-concurrent-session-241",
              SCRIPTED_ACP_DURABLE_STATE_PATH: join(controls, "peer.json"),
              SCRIPTED_ACP_PID_PATH: pidPath,
              SCRIPTED_ACP_READY_PATH: join(controls, "ready"),
              SCRIPTED_ACP_RELEASE_PATH: join(controls, "release"),
              SCRIPTED_ACP_SCENARIO: "resume",
            },
          });
          const results = yield* Effect.all(
            ["first", "second"].map((name) =>
              Effect.result(
                agent.handle(
                  request(`conversation:concurrent-${name}`, "prompt:one"),
                  () => Effect.void
                )
              )
            ),
            { concurrency: "unbounded" }
          );
          assert.ok(
            results.filter((result) => result._tag === "Success").length <= 1
          );
          assert.ok(results.some((result) => result._tag === "Failure"));
          yield* waitForOwnedProcessExit(pidPath);
          const state = JSON.parse(
            yield* Effect.promise(() =>
              readFile(sources.acpConversationStatePath, "utf8")
            )
          ) as { readonly conversations: readonly unknown[] };
          assert.strictEqual(state.conversations.length, 1);
        })
      ),
    15_000
  );

  it.live(
    "quarantines and reaps uncooperative establishment and close requests while scope remains open",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const controls = yield* makeTempDirectoryScoped(
            "laborer-acp-quarantine-timeouts-"
          );
          for (const [index, kind] of [
            "establish",
            "close-timeout",
            "close-error",
          ].entries()) {
            const root = yield* makeTempDirectoryScoped(
              `laborer-acp-quarantine-${kind}-`
            );
            const sources = yield* prepareAcpAgentContextSources({
              root,
              workspaceId: `T241QUARANTINE${index}`,
            });
            const pidPath = join(controls, `${kind}.pid`);
            const lateResponsePath = join(controls, `${kind}-late-response`);
            const generationLifecyclePath = join(
              controls,
              `${kind}-generation.log`
            );
            const agent = yield* makeAcpConversationAgent({
              agentContext: sources,
              args: [scriptedPeerPath],
              childExitGraceMillis: 100,
              command: process.execPath,
              cwd: root,
              environment: {
                ...process.env,
                SCRIPTED_ACP_CLOSE_ERROR: kind === "close-error" ? "1" : "0",
                SCRIPTED_ACP_CLOSE_HANG: kind === "close-timeout" ? "1" : "0",
                SCRIPTED_ACP_DURABLE_STATE_PATH: join(
                  controls,
                  `${kind}-peer.json`
                ),
                SCRIPTED_ACP_GENERATION: kind,
                SCRIPTED_ACP_GENERATION_LIFECYCLE_PATH: generationLifecyclePath,
                SCRIPTED_ACP_IGNORE_CANCELLATION: "1",
                SCRIPTED_ACP_LATE_NEW_RESPONSE_PATH: lateResponsePath,
                SCRIPTED_ACP_NEW_DELAY_MILLIS:
                  kind === "establish" ? "2000" : "0",
                SCRIPTED_ACP_NEW_HANG: kind === "establish" ? "1" : "0",
                SCRIPTED_ACP_PID_PATH: pidPath,
                SCRIPTED_ACP_READY_PATH: join(controls, `${kind}-ready`),
                SCRIPTED_ACP_RELEASE_PATH: join(controls, `${kind}-release`),
                SCRIPTED_ACP_SCENARIO: "resume",
              },
              memoryMcpServer: makeLaborerMemoryMcpServerConfiguration(sources),
              sessionCloseTimeoutMillis: 100,
              sessionEstablishTimeoutMillis: 1000,
              ...(kind.startsWith("close-")
                ? {
                    sessionStoreTestHooks: {
                      beforeRename: () =>
                        Promise.reject(new Error("forced mapping failure")),
                    },
                  }
                : {}),
            });
            const result = yield* Effect.result(
              agent.handle(
                request(`conversation:quarantine-${kind}`, "prompt:one"),
                () => Effect.void
              )
            );
            assert.strictEqual(result._tag, "Failure", kind);
            yield* waitForOwnedProcessExit(pidPath);
            const afterQuarantine = yield* Effect.result(
              agent.handle(
                request(`conversation:quarantine-${kind}`, "prompt:two"),
                () => Effect.void
              )
            );
            assert.strictEqual(afterQuarantine._tag, "Failure", kind);
            assert.ok(
              yield* Effect.promise(() => doesNotExist(lateResponsePath)),
              kind
            );
            const lifecycle = yield* Effect.promise(() =>
              readFile(generationLifecyclePath, "utf8")
            );
            assert.strictEqual(
              lifecycle.split(`${kind}:mcp:opened:`).length - 1,
              1,
              kind
            );
            assert.strictEqual(
              lifecycle.split(`${kind}:mcp:closed:`).length - 1,
              1,
              kind
            );
            assert.strictEqual(
              lifecycle.split(`${kind}:acp:stdio-closed`).length - 1,
              1,
              kind
            );
          }
        })
      ),
    15_000
  );

  it.live(
    "closes an ACP session when durable mapping publication fails",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-acp-mapping-failure-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-acp-mapping-failure-controls-"
          );
          const lifecyclePath = join(controls, "lifecycle.log");
          const generationLifecyclePath = join(
            controls,
            "generation-lifecycle.log"
          );
          const sources = yield* prepareAcpAgentContextSources({
            root,
            workspaceId: "T241MAPPINGFAIL",
          });
          const result = yield* Effect.scoped(
            Effect.gen(function* () {
              const agent = yield* makeAcpConversationAgent({
                agentContext: sources,
                args: [scriptedPeerPath],
                command: process.execPath,
                cwd: root,
                environment: {
                  ...process.env,
                  SCRIPTED_ACP_DURABLE_STATE_PATH: join(controls, "peer.json"),
                  SCRIPTED_ACP_CLOSE_HANG: "1",
                  SCRIPTED_ACP_GENERATION: "mapping-failure",
                  SCRIPTED_ACP_GENERATION_LIFECYCLE_PATH:
                    generationLifecyclePath,
                  SCRIPTED_ACP_LIFECYCLE_LOG_PATH: lifecyclePath,
                  SCRIPTED_ACP_READY_PATH: join(controls, "ready"),
                  SCRIPTED_ACP_RELEASE_PATH: join(controls, "release"),
                  SCRIPTED_ACP_SCENARIO: "resume",
                },
                memoryMcpServer:
                  makeLaborerMemoryMcpServerConfiguration(sources),
                sessionCloseTimeoutMillis: 100,
                sessionStoreTestHooks: {
                  beforeRename: () => Promise.reject(new Error("test failure")),
                },
              });
              return yield* Effect.result(
                agent.handle(
                  request("conversation:mapping", "prompt:one"),
                  () => Effect.void
                )
              );
            })
          );
          assert.strictEqual(result._tag, "Failure");
          const lifecycle = yield* Effect.promise(() =>
            readFile(lifecyclePath, "utf8")
          );
          assert.match(lifecycle, SESSION_NEW_LINE_PATTERN);
          assert.match(lifecycle, SESSION_CLOSE_LINE_PATTERN);
          const generationLifecycle = yield* Effect.promise(() =>
            readFile(generationLifecyclePath, "utf8")
          );
          assert.strictEqual(
            generationLifecycle.match(/mapping-failure:mcp:opened:/g)?.length,
            1
          );
          assert.strictEqual(
            generationLifecycle.match(/mapping-failure:mcp:closed:/g)?.length,
            1
          );
          assert.strictEqual(
            generationLifecycle.match(/mapping-failure:acp:stdio-closed/g)
              ?.length,
            1
          );
        })
      ),
    15_000
  );

  it.live(
    "uses resume rather than load and preserves one resumed history when memory readiness degrades",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-acp-readiness-resume-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-acp-readiness-resume-controls-"
          );
          const sources = yield* prepareAcpAgentContextSources({
            root,
            workspaceId: "T241READINESS",
          });
          const requestsPath = join(controls, "requests.jsonl");
          const loadTrapPath = join(controls, "load-trap.log");
          const permissionResultPath = join(controls, "permission.json");
          const lifecyclePath = join(controls, "generation-lifecycle.log");
          const baseEnvironment = {
            ...process.env,
            SCRIPTED_ACP_DURABLE_STATE_PATH: join(controls, "peer.json"),
            SCRIPTED_ACP_GENERATION_LIFECYCLE_PATH: lifecyclePath,
            SCRIPTED_ACP_LOAD_TRAP_PATH: loadTrapPath,
            SCRIPTED_ACP_READY_PATH: join(controls, "ready"),
            SCRIPTED_ACP_RELEASE_PATH: join(controls, "release"),
            SCRIPTED_ACP_SCENARIO: "resume",
            SCRIPTED_ACP_SESSION_REQUEST_JSONL_PATH: requestsPath,
          };
          const run = (promptId: string, environment: NodeJS.ProcessEnv) =>
            Effect.scoped(
              Effect.gen(function* () {
                const agent = yield* makeAcpConversationAgent({
                  agentContext: sources,
                  args: [scriptedPeerPath],
                  command: process.execPath,
                  cwd: root,
                  environment,
                  memoryMcpServer:
                    makeLaborerMemoryMcpServerConfiguration(sources),
                });
                return yield* agent.handle(
                  request("conversation:readiness", promptId),
                  () => Effect.void
                );
              })
            );
          yield* run("prompt:one", {
            ...baseEnvironment,
            SCRIPTED_ACP_GENERATION: "g1",
          });
          yield* run("prompt:two", {
            ...baseEnvironment,
            SCRIPTED_ACP_COLLIDE_MCP_REGISTRATION: "1",
            SCRIPTED_ACP_GENERATION: "g2",
            SCRIPTED_ACP_PERMISSION_RESULT_PATH: permissionResultPath,
            SCRIPTED_ACP_PERMISSION_TITLE: "memory permission",
            SCRIPTED_ACP_PERMISSION_TOOL_IDENTITY: "attached-memory",
          });

          const records = yield* Effect.promise(() => jsonLines(requestsPath));
          assert.strictEqual(records.length, 2);
          assert.ok(isRecord(records[0]));
          assert.ok(isRecord(records[1]));
          if (!(isRecord(records[0]) && isRecord(records[1]))) {
            return;
          }
          assert.strictEqual(records[0].sessionId, undefined);
          assert.strictEqual(typeof records[1].sessionId, "string");
          assert.strictEqual(records[0].cwd, root);
          assert.strictEqual(records[1].cwd, root);
          assert.ok(Array.isArray(records[0].mcpServers));
          assert.ok(Array.isArray(records[1].mcpServers));
          const firstServer = (records[0].mcpServers as readonly unknown[])[0];
          const secondServer = (records[1].mcpServers as readonly unknown[])[0];
          assert.ok(isRecord(firstServer));
          assert.ok(isRecord(secondServer));
          if (isRecord(firstServer) && isRecord(secondServer)) {
            assert.strictEqual(firstServer.command, process.execPath);
            assert.strictEqual(secondServer.command, process.execPath);
            assert.deepStrictEqual(firstServer.args, secondServer.args);
            assert.match(String(firstServer.name), MEMORY_SERVER_NAME_PATTERN);
            assert.match(String(secondServer.name), MEMORY_SERVER_NAME_PATTERN);
            const expectedEnvironmentNames = [
              "LABORER_MEMORY_AUTHORITY_GUARD",
              "LABORER_MEMORY_CONFIG_ROOT",
              "LABORER_MEMORY_READY_PATH",
              "LABORER_MEMORY_REGISTRATION_NONCE",
              "LABORER_MEMORY_ROOT",
              "LABORER_MEMORY_SERVER_NAME",
              "LABORER_MEMORY_STATE_ROOT",
              "LABORER_MEMORY_WORKSPACE_ID",
            ];
            for (const server of [firstServer, secondServer]) {
              assert.ok(Array.isArray(server.env));
              const environment = (server.env as readonly unknown[]).filter(
                isRecord
              );
              assert.deepStrictEqual(
                environment.map((entry) => String(entry.name)).sort(),
                expectedEnvironmentNames
              );
              const values = Object.fromEntries(
                environment.map((entry) => [entry.name, entry.value])
              );
              assert.strictEqual(values.LABORER_MEMORY_ROOT, root);
              assert.strictEqual(
                values.LABORER_MEMORY_CONFIG_ROOT,
                sources.configRoot
              );
              assert.strictEqual(
                values.LABORER_MEMORY_STATE_ROOT,
                sources.stateRoot
              );
              assert.strictEqual(
                values.LABORER_MEMORY_WORKSPACE_ID,
                sources.workspaceId
              );
              assert.strictEqual(
                values.LABORER_MEMORY_SERVER_NAME,
                server.name
              );
              assert.match(
                String(values.LABORER_MEMORY_AUTHORITY_GUARD),
                AUTHORITY_GUARD_PATTERN
              );
              assert.match(
                String(values.LABORER_MEMORY_REGISTRATION_NONCE),
                REGISTRATION_NONCE_PATTERN
              );
              assert.match(
                String(values.LABORER_MEMORY_READY_PATH),
                MEMORY_READY_PATH_PATTERN
              );
            }
          }
          assert.ok(yield* Effect.promise(() => doesNotExist(loadTrapPath)));
          assert.deepStrictEqual(
            JSON.parse(
              yield* Effect.promise(() =>
                readFile(permissionResultPath, "utf8")
              )
            ),
            { outcome: { outcome: "cancelled" } }
          );
          const lifecycle = yield* Effect.promise(() =>
            readFile(lifecyclePath, "utf8")
          );
          assert.strictEqual(lifecycle.match(/g2:acp:initialize/g)?.length, 1);
          assert.strictEqual(lifecycle.match(/g1:mcp:opened:/g)?.length, 1);
          assert.strictEqual(lifecycle.match(/g1:mcp:closed:/g)?.length, 1);
          assert.strictEqual(
            lifecycle.match(/g1:acp:stdio-closed/g)?.length,
            1
          );
          assert.strictEqual(lifecycle.match(/g2:mcp:opened:/g)?.length, 1);
          assert.strictEqual(lifecycle.match(/g2:mcp:closed:/g)?.length, 1);
          assert.strictEqual(
            lifecycle.match(/g2:acp:stdio-closed/g)?.length,
            1
          );
        })
      ),
    20_000
  );

  it.live(
    "keeps one session and introduces each late participant once across a third restart",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-acp-third-restart-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-acp-third-restart-controls-"
          );
          const sources = yield* prepareAcpAgentContextSources({
            root,
            workspaceId: "T241THIRDRESTART",
          });
          const requestsPath = join(controls, "requests.jsonl");
          const promptsPath = join(controls, "prompts.jsonl");
          const lookupCalls: string[] = [];
          const environment = {
            ...process.env,
            SCRIPTED_ACP_DURABLE_STATE_PATH: join(controls, "peer.json"),
            SCRIPTED_ACP_PROMPT_JSONL_PATH: promptsPath,
            SCRIPTED_ACP_READY_PATH: join(controls, "ready"),
            SCRIPTED_ACP_RELEASE_PATH: join(controls, "release"),
            SCRIPTED_ACP_SCENARIO: "resume",
            SCRIPTED_ACP_SESSION_REQUEST_JSONL_PATH: requestsPath,
          };
          const participantIds = ["U241FIRST", "U241SECOND", "U241THIRD"];
          for (const [index, authorSlackId] of participantIds.entries()) {
            yield* Effect.scoped(
              Effect.gen(function* () {
                const agent = yield* makeAcpConversationAgent({
                  agentContext: sources,
                  args: [scriptedPeerPath],
                  command: process.execPath,
                  cwd: root,
                  environment,
                  laborerSlackId: "U241LABORER",
                  participantLookup: {
                    lookupVisibleName: (slackUserId) =>
                      Effect.sync(() => {
                        lookupCalls.push(slackUserId);
                        return `Visible ${slackUserId}`;
                      }),
                  },
                });
                yield* agent.handle(
                  participantRequest({
                    authorSlackId,
                    conversationId: "conversation:third-restart",
                    promptId: `prompt:${index + 1}`,
                  }),
                  () => Effect.void
                );
              })
            );
          }

          const prompts = yield* Effect.promise(() => jsonLines(promptsPath));
          assert.strictEqual(prompts.length, 3);
          assert.ok(prompts.every(isRecord));
          if (!prompts.every(isRecord)) {
            return;
          }
          assert.strictEqual(prompts[0]?.sessionId, prompts[1]?.sessionId);
          assert.strictEqual(prompts[1]?.sessionId, prompts[2]?.sessionId);
          for (const [index, participantId] of participantIds.entries()) {
            assert.ok(String(prompts[index]?.prompt).includes(participantId));
            for (let later = index + 1; later < prompts.length; later += 1) {
              assert.ok(
                !String(prompts[later]?.prompt).includes(participantId)
              );
            }
          }
          assert.deepStrictEqual(lookupCalls, participantIds);
          const sessionRequests = yield* Effect.promise(() =>
            jsonLines(requestsPath)
          );
          assert.strictEqual(sessionRequests.length, 3);
          assert.ok(isRecord(sessionRequests[0]));
          assert.ok(isRecord(sessionRequests[1]));
          assert.ok(isRecord(sessionRequests[2]));
          if (
            isRecord(sessionRequests[0]) &&
            isRecord(sessionRequests[1]) &&
            isRecord(sessionRequests[2])
          ) {
            assert.strictEqual(sessionRequests[0].sessionId, undefined);
            assert.strictEqual(
              sessionRequests[1].sessionId,
              prompts[0]?.sessionId
            );
            assert.strictEqual(
              sessionRequests[2].sessionId,
              prompts[0]?.sessionId
            );
          }
        })
      ),
    20_000
  );
});
