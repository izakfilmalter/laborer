import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Schema, Scope } from "effect";
import {
  type AcpConversationAgentOptions,
  makeAcpConversationAgent,
} from "../src/acp-runtime/acp-conversation-agent.ts";
import {
  prepareAcpAgentContextSources,
  userProfilePath,
} from "../src/acp-runtime/agent-context.ts";
import { makeLaborerMemoryMcpServerConfiguration } from "../src/acp-runtime/memory-mcp.ts";
import {
  type ApplicationPublicOutput,
  type ApplicationShape,
  ParticipantInputEvent,
} from "../src/application.ts";
import {
  MessageId,
  NormalizedMessage,
  ThreadId,
  TurnId,
} from "../src/prototype/domain.ts";
import {
  CONVERSATION_ADOPTION_MIGRATION_CONTRACT,
  conversationAdoptionId,
  makeFileApplicationRepository,
  makeReferenceCodingApplication,
  type ReferenceCodingApplicationRepository,
} from "../src/reference-coding-application.ts";
import { makeTempDirectoryScoped } from "./support/temp-directory.ts";

const scriptedPeerPath = resolve(
  process.cwd(),
  "tests/fixtures/scripted-acp-peer.ts"
);
const TEXTLESS_FAST_PATH_MAX_MILLIS = 4000;

const conversationPromptId = (
  conversationId: string,
  ownerId: string
): string =>
  `msg_${createHash("sha256")
    .update(
      JSON.stringify({
        internalId: `conversation:${conversationId}:prompt:${ownerId}`,
        namespace: "laborer:reference-coding:v1",
        purpose: "conversation-prompt",
      })
    )
    .digest("hex")}`;

const SessionMethodRecord = Schema.Struct({
  method: Schema.Literals(["session/new", "session/resume"]),
  params: Schema.Record(Schema.String, Schema.Unknown),
});

const PromptRecord = Schema.Struct({
  prompt: Schema.String,
  sessionId: Schema.String,
});

const McpServerRecord = Schema.Struct({
  args: Schema.Array(Schema.String),
  command: Schema.String,
  env: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      value: Schema.String,
    })
  ),
  name: Schema.String,
  type: Schema.optional(Schema.String),
});

const readJsonLineValues = Effect.fnUntraced(function* (path: string) {
  const source = yield* Effect.promise(() => readFile(path, "utf8"));
  return source
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
});

const readSessionMethods = Effect.fnUntraced(function* (path: string) {
  return yield* Schema.decodeUnknownEffect(Schema.Array(SessionMethodRecord))(
    yield* readJsonLineValues(path)
  );
});

const readPrompts = Effect.fnUntraced(function* (path: string) {
  return yield* Schema.decodeUnknownEffect(Schema.Array(PromptRecord))(
    yield* readJsonLineValues(path)
  );
});

const waitForPath = async (path: string): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await stat(path);
      return;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
};

const participantEvent = (options: {
  readonly conversationId: string;
  readonly participantIds: readonly string[];
  readonly turn: number;
}): ParticipantInputEvent => {
  const messages = options.participantIds.map((participantId, index) =>
    NormalizedMessage.make({
      authorKind: "human",
      authorSlackId: participantId,
      classification: "input",
      id: MessageId.make(`message:241:${options.turn}:${index}`),
      isActivation: options.turn === 1 && index === 0,
      slackTs: `241.${options.turn}${index}`,
      text: `turn ${options.turn} from ${participantId}`,
    })
  );
  return ParticipantInputEvent.make({
    attemptNumber: 1,
    channelId: "C241",
    context: [],
    conversationId: ThreadId.make(options.conversationId),
    initializationStatus: "not_applicable",
    messages,
    rootTs: "241.1",
    source: "slack",
    turnId: TurnId.make(`turn:241:${options.turn}`),
    workingDirectory: null,
  });
};

const acceptEvent = () =>
  Effect.succeed({
    decision: { _tag: "Accepted" as const, eventId: "accepted:241" },
    scheduling: "Scheduled" as const,
  });

const makeStack = Effect.fnUntraced(function* (options: {
  readonly childExitGraceMillis?: number;
  readonly controls: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly promptDeadlineMillis?: number;
  readonly processFailureObserver?: NonNullable<
    AcpConversationAgentOptions["processFailureObserver"]
  >;
  readonly repository: ReferenceCodingApplicationRepository;
  readonly root: string;
  readonly testHooks?: NonNullable<AcpConversationAgentOptions["testHooks"]>;
  readonly visibleNames: Readonly<Record<string, string>>;
  readonly workspaceId: string;
}) {
  const sources = yield* prepareAcpAgentContextSources({
    root: options.root,
    workspaceId: options.workspaceId,
  });
  const agent = yield* makeAcpConversationAgent({
    agentContext: sources,
    args: [scriptedPeerPath],
    command: process.execPath,
    cwd: options.root,
    ...(options.childExitGraceMillis === undefined
      ? {}
      : { childExitGraceMillis: options.childExitGraceMillis }),
    durableSessionMode: true,
    environment: {
      ...process.env,
      ...options.environment,
      SCRIPTED_ACP_DURABLE_SESSIONS_PATH: join(
        options.controls,
        "durable-sessions.json"
      ),
      SCRIPTED_ACP_PROMPT_JSONL_PATH: join(options.controls, "prompts.jsonl"),
      SCRIPTED_ACP_READY_PATH: join(options.controls, "ready"),
      SCRIPTED_ACP_RELEASE_PATH: join(options.controls, "release"),
      SCRIPTED_ACP_REPLAY_ON_RESUME: "1",
      SCRIPTED_ACP_SESSION_METHOD_JSONL_PATH: join(
        options.controls,
        "methods.jsonl"
      ),
    },
    memoryMcpServer: makeLaborerMemoryMcpServerConfiguration(sources),
    participantLookup: {
      lookupVisibleName: (slackUserId) =>
        Effect.succeed(options.visibleNames[slackUserId] ?? slackUserId),
    },
    ...(options.promptDeadlineMillis === undefined
      ? {}
      : { promptDeadlineMillis: options.promptDeadlineMillis }),
    ...(options.processFailureObserver === undefined
      ? {}
      : { processFailureObserver: options.processFailureObserver }),
    ...(options.testHooks === undefined
      ? {}
      : { testHooks: options.testHooks }),
  });
  const application = yield* makeReferenceCodingApplication({
    conversationAgent: agent,
    implementationAgent: {
      start: () => Effect.die(new Error("Executions are outside this test")),
    },
    repository: options.repository,
    worktreeManager: {
      create: () => Effect.die(new Error("Actions are outside this test")),
    },
  });
  return { application, sources };
});

const runTurn = Effect.fnUntraced(function* (options: {
  readonly application: ApplicationShape;
  readonly event: ParticipantInputEvent;
  readonly published: ApplicationPublicOutput[];
}) {
  yield* options.application.handle(
    options.event,
    (output) =>
      Effect.sync(() => {
        options.published.push(output);
      }),
    acceptEvent
  );
});

const rejectingHook = (): Promise<void> =>
  Promise.reject(new Error("simulated process crash boundary"));

type CrashBoundary = "after-binding" | "before-binding" | "before-prompt";

const crashHooksFor = (
  boundary: CrashBoundary
): NonNullable<AcpConversationAgentOptions["testHooks"]> => {
  if (boundary === "before-binding") {
    return { beforeDurableBindingPersist: rejectingHook };
  }
  if (boundary === "after-binding") {
    return { afterDurableBindingPersisted: rejectingHook };
  }
  return { beforePromptSubmission: rejectingHook };
};

const crashPhaseFor = (
  boundary: CrashBoundary
): "pending" | "submitting" | null => {
  if (boundary === "before-binding") {
    return null;
  }
  return boundary === "after-binding" ? "pending" : "submitting";
};

const stableMcpServers = (value: unknown) =>
  Schema.decodeUnknownSync(Schema.Array(McpServerRecord))(value).map(
    (server) => ({
      args: server.args,
      command: server.command,
      env: server.env.filter(
        ({ name }) =>
          name !== "LABORER_MEMORY_REGISTRATION_NONCE" &&
          name !== "LABORER_MEMORY_READY_PATH"
      ),
      name: server.name,
      type: server.type,
    })
  );

// Every test provisions its own temp root, controls directory, and child
// process chain, so tests are isolated and spend most wall-clock time
// waiting on serialized child boots. Running them concurrently overlaps
// those waits. The suite timeout replaces the 5s default, which a ~1s
// stack boot can exceed under concurrent scheduling; explicit per-test
// timeouts still take precedence.
describe.concurrent("issue #241 durable ACP session bindings", () => {
  it.live(
    "blocks adoption when its persisted session is unavailable without creating a replacement",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-255-adoption-unavailable-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-255-adoption-unavailable-controls-"
          );
          const snapshotPath = join(controls, "application.json");
          const conversationId = "C241:adoption-unavailable";
          yield* Effect.promise(() =>
            writeFile(join(controls, "release"), "ok")
          );
          const firstRepository = yield* makeFileApplicationRepository(
            snapshotPath,
            controls
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              const stack = yield* makeStack({
                controls,
                repository: firstRepository,
                root,
                visibleNames: { U241ADOPT: "Adoption Owner" },
                workspaceId: "T255ADOPTION",
              });
              yield* runTurn({
                application: stack.application,
                event: participantEvent({
                  conversationId,
                  participantIds: ["U241ADOPT"],
                  turn: 1,
                }),
                published: [],
              });
            })
          );
          const snapshot = JSON.parse(
            yield* Effect.promise(() => readFile(snapshotPath, "utf8"))
          ) as {
            conversationAdoptions: unknown[];
            conversations: {
              agentSessionBinding: {
                generation: number;
                sessionId: string;
              } | null;
              origin: string;
            }[];
          };
          const conversation = snapshot.conversations[0];
          assert.ok(conversation);
          const binding = conversation.agentSessionBinding;
          assert.ok(binding);
          const ownerId = "turn:241:2";
          const seedPromptId = conversationPromptId(conversationId, ownerId);
          const adoptionId = conversationAdoptionId({
            conversationId,
            workspaceId: "legacy",
          });
          conversation.origin = "legacy";
          snapshot.conversationAdoptions = [
            {
              acpBindingGeneration: binding.generation,
              acpSessionId: binding.sessionId,
              adoptedAt: null,
              adoptionId,
              channelId: "C241",
              conversationId,
              createdAt: 255_000,
              cutoffSlackTs: "241.20",
              executionEventOutboxHighWatermark: 0,
              executionSnapshotBytes: 0,
              executionSnapshotCount: 0,
              executionSnapshotDigest:
                "Czh3Wz2zw3DPclTTC1F0osiSiW7oHbszI8B5m6LQ8vo",
              executionSnapshotRendered: "",
              executionSnapshotTruncated: false,
              historyBytes: null,
              historyDegradation: null,
              historyDiagnosticCodes: [],
              historyDigest: null,
              historyFirstSlackTs: null,
              historyLastSlackTs: null,
              historyMessageCount: null,
              historyRequestCount: null,
              historyTruncation: null,
              linearizedAt: 255_000,
              migrationContract: CONVERSATION_ADOPTION_MIGRATION_CONTRACT,
              rootTs: "241.1",
              seedAttemptId: "seed-attempt-255-unavailable",
              seedAttemptedAt: null,
              seedPromptId,
              seedTerminalAt: null,
              seedTerminalOutcome: null,
              sessionCreationAttemptedAt: 255_001,
              status: "session_created",
              triggeringMessageId: "message:241:2:0",
              triggeringMessageTs: "241.20",
              triggeringOwnerId: ownerId,
              triggeringOwnerKind: "participant-turn",
              unresolvedAt: null,
              unresolvedCorrelationId: null,
              unresolvedDiagnosticCode: null,
              updatedAt: 255_001,
              workspaceId: "legacy",
            },
          ];
          yield* Effect.promise(() =>
            writeFile(snapshotPath, JSON.stringify(snapshot))
          );

          const restartedRepository = yield* makeFileApplicationRepository(
            snapshotPath,
            controls
          );
          const result = yield* Effect.scoped(
            Effect.gen(function* () {
              const stack = yield* makeStack({
                controls,
                environment: {
                  SCRIPTED_ACP_RESUME_FAILURE: "standard-unavailable",
                },
                repository: restartedRepository,
                root,
                visibleNames: { U241ADOPT: "Adoption Owner" },
                workspaceId: "T255ADOPTION",
              });
              return yield* Effect.result(
                runTurn({
                  application: stack.application,
                  event: participantEvent({
                    conversationId,
                    participantIds: ["U241ADOPT"],
                    turn: 2,
                  }),
                  published: [],
                })
              );
            })
          );
          assert.strictEqual(result._tag, "Failure");
          const methods = yield* readSessionMethods(
            join(controls, "methods.jsonl")
          );
          assert.deepStrictEqual(
            methods.map(({ method }) => method),
            ["session/new", "session/resume"]
          );
          const persisted = yield* restartedRepository.load;
          assert.strictEqual(
            persisted.conversationAdoptions[0]?.status,
            "unresolved"
          );
          assert.strictEqual(
            persisted.conversationAdoptions[0]?.unresolvedDiagnosticCode,
            "seed-admission-ambiguous"
          );
          assert.deepStrictEqual(
            persisted.conversations[0]?.agentSessionBinding?.sessionId,
            binding.sessionId
          );
          assert.strictEqual(
            persisted.conversations[0]?.agentSessionBinding?.generation,
            binding.generation
          );
        })
      ),
    30_000
  );

  it.live(
    "persists before prompting, resumes once with exact cwd/MCP, and introduces only new humans",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped("laborer-241-resume-");
          const controls = yield* makeTempDirectoryScoped(
            "laborer-241-resume-controls-"
          );
          const snapshotPath = join(controls, "application.json");
          const repository = yield* makeFileApplicationRepository(
            snapshotPath,
            controls
          );
          yield* Effect.promise(() =>
            writeFile(join(controls, "release"), "ok")
          );
          const firstPublished: ApplicationPublicOutput[] = [];
          yield* Effect.scoped(
            Effect.gen(function* () {
              const stack = yield* makeStack({
                controls,
                repository,
                root,
                visibleNames: { U241FIRST: "First Name" },
                workspaceId: "T241RESUME",
              });
              yield* runTurn({
                application: stack.application,
                event: participantEvent({
                  conversationId: "C241:241.1",
                  participantIds: ["U241FIRST"],
                  turn: 1,
                }),
                published: firstPublished,
              });
            })
          );

          const afterNew = JSON.parse(
            yield* Effect.promise(() => readFile(snapshotPath, "utf8"))
          ) as {
            conversations: readonly {
              readonly agentSessionBinding: {
                readonly cwd: string;
                readonly generation: number;
                readonly introducedParticipantIds: readonly string[];
                readonly sessionId: string;
              };
              readonly sessionId: string;
            }[];
            schemaVersion: number;
          };
          assert.strictEqual(afterNew.schemaVersion, 16);
          assert.strictEqual(
            afterNew.conversations[0]?.agentSessionBinding.cwd,
            root
          );
          assert.strictEqual(
            afterNew.conversations[0]?.agentSessionBinding.generation,
            1
          );
          assert.deepStrictEqual(
            afterNew.conversations[0]?.agentSessionBinding
              .introducedParticipantIds,
            ["U241FIRST"]
          );
          assert.notStrictEqual(
            afterNew.conversations[0]?.sessionId,
            afterNew.conversations[0]?.agentSessionBinding.sessionId
          );

          const secondPublished: ApplicationPublicOutput[] = [];
          const restartedRepository = yield* makeFileApplicationRepository(
            snapshotPath,
            controls
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              const stack = yield* makeStack({
                controls,
                repository: restartedRepository,
                root,
                visibleNames: {
                  U241FIRST: "Changed First Name",
                  U241SECOND: "Current Second Name",
                },
                workspaceId: "T241RESUME",
              });
              yield* runTurn({
                application: stack.application,
                event: participantEvent({
                  conversationId: "C241:241.1",
                  participantIds: ["U241FIRST", "U241SECOND"],
                  turn: 2,
                }),
                published: secondPublished,
              });
            })
          );

          const methods = yield* readSessionMethods(
            join(controls, "methods.jsonl")
          );
          assert.deepStrictEqual(
            methods.map(({ method }) => method),
            ["session/new", "session/resume"]
          );
          const created = methods[0]?.params;
          const resumed = methods[1]?.params;
          assert.strictEqual(resumed?.cwd, root);
          assert.strictEqual(
            resumed?.sessionId,
            afterNew.conversations[0]?.agentSessionBinding.sessionId
          );
          assert.deepStrictEqual(
            stableMcpServers(resumed?.mcpServers),
            stableMcpServers(created?.mcpServers)
          );
          const prompts = yield* readPrompts(join(controls, "prompts.jsonl"));
          assert.strictEqual(prompts.length, 2);
          assert.deepStrictEqual(
            prompts.map(({ sessionId }) => sessionId),
            [
              afterNew.conversations[0]?.agentSessionBinding.sessionId,
              afterNew.conversations[0]?.agentSessionBinding.sessionId,
            ]
          );
          assert.ok(!prompts[1]?.prompt.includes("Changed First Name"));
          assert.ok(prompts[1]?.prompt.includes("Current Second Name"));
          assert.strictEqual(secondPublished.length, firstPublished.length);
          assert.ok(
            secondPublished.every(
              (output) =>
                !(
                  "text" in output &&
                  output.text.includes("HISTORICAL OUTPUT MUST NOT REPLAY")
                )
            )
          );
          const finalState = yield* (yield* makeFileApplicationRepository(
            snapshotPath,
            controls
          )).load;
          assert.deepStrictEqual(
            finalState.conversations[0]?.agentSessionBinding
              ?.introducedParticipantIds,
            ["U241FIRST", "U241SECOND"]
          );
        })
      ),
    30_000
  );

  it.live(
    "CAS-replaces outside-root and moved-root bindings without resume or list inspection",
    () =>
      Effect.gen(function* () {
        for (const scenario of ["outside-root", "moved-root"] as const) {
          const anchor = yield* makeTempDirectoryScoped(
            `laborer-245-${scenario}-`
          );
          const controls = yield* makeTempDirectoryScoped(
            `laborer-245-${scenario}-controls-`
          );
          const persistedRoot = join(anchor, "persisted-project");
          const otherRoot = join(anchor, "current-project");
          yield* Effect.promise(() =>
            Promise.all([
              mkdir(persistedRoot, { mode: 0o700 }),
              mkdir(otherRoot, { mode: 0o700 }),
              writeFile(join(controls, "release"), "release", { mode: 0o600 }),
            ])
          );
          const repositoryPath = join(controls, "application-state.json");
          const conversationId = `C245:${scenario}`;
          yield* Effect.scoped(
            Effect.gen(function* () {
              const repository = yield* makeFileApplicationRepository(
                repositoryPath,
                controls
              );
              const first = yield* makeStack({
                controls,
                repository,
                root: persistedRoot,
                visibleNames: { U245ROOT: "Root Author" },
                workspaceId: `T245${scenario}`,
              });
              yield* runTurn({
                application: first.application,
                event: participantEvent({
                  conversationId,
                  participantIds: ["U245ROOT"],
                  turn: 1,
                }),
                published: [],
              });
            })
          );

          const hiddenRoot = join(anchor, "persisted-project-hidden");
          yield* Effect.promise(async () => {
            await rename(persistedRoot, hiddenRoot);
            if (scenario === "moved-root") {
              await mkdir(persistedRoot, { mode: 0o700 });
            }
          });
          const currentRoot =
            scenario === "moved-root" ? persistedRoot : otherRoot;

          yield* Effect.scoped(
            Effect.gen(function* () {
              const repository = yield* makeFileApplicationRepository(
                repositoryPath,
                controls
              );
              const second = yield* makeStack({
                controls,
                repository,
                root: currentRoot,
                visibleNames: { U245ROOT: "Root Author" },
                workspaceId: `T245${scenario}`,
              });
              yield* runTurn({
                application: second.application,
                event: participantEvent({
                  conversationId,
                  participantIds: ["U245ROOT"],
                  turn: 2,
                }),
                published: [],
              });
              const binding = (yield* repository.load).conversations[0]
                ?.agentSessionBinding;
              assert.strictEqual(binding?.cwd, currentRoot);
              assert.ok(binding?.cwdIdentity != null);
              assert.strictEqual(binding?.generation, 2);
            })
          );

          const methods = yield* readSessionMethods(
            join(controls, "methods.jsonl")
          );
          assert.deepStrictEqual(
            methods.map(({ method }) => method),
            ["session/new", "session/new"]
          );
          assert.strictEqual(methods[1]?.params.cwd, currentRoot);
        }
      }).pipe(Effect.scoped),
    30_000
  );

  it.live(
    "replaces both stable unavailable forms and resumes the latest generation",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped("laborer-241-replace-");
          const controls = yield* makeTempDirectoryScoped(
            "laborer-241-replace-controls-"
          );
          const snapshotPath = join(controls, "application.json");
          const repository = yield* makeFileApplicationRepository(
            snapshotPath,
            controls
          );
          yield* Effect.promise(() =>
            writeFile(join(controls, "release"), "ok")
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              const stack = yield* makeStack({
                controls,
                repository,
                root,
                visibleNames: { U241OLD: "Old Name" },
                workspaceId: "T241REPLACE",
              });
              yield* runTurn({
                application: stack.application,
                event: participantEvent({
                  conversationId: "C241:replace",
                  participantIds: ["U241OLD"],
                  turn: 1,
                }),
                published: [],
              });
            })
          );
          const replacementSources = yield* prepareAcpAgentContextSources({
            root,
            workspaceId: "T241REPLACE",
          });
          yield* Effect.promise(() =>
            writeFile(replacementSources.soulPath, "Replacement Soul")
          );
          yield* Effect.promise(() =>
            writeFile(
              replacementSources.workspaceMemoryPath,
              "Replacement Workspace Memory"
            )
          );
          yield* Effect.promise(() =>
            mkdir(replacementSources.userProfilesDirectory, { recursive: true })
          );
          yield* Effect.promise(() =>
            writeFile(
              userProfilePath(replacementSources, "U241OLD"),
              "Current old profile"
            )
          );

          const replacementRepository = yield* makeFileApplicationRepository(
            snapshotPath,
            controls
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              const stack = yield* makeStack({
                controls,
                environment: {
                  SCRIPTED_ACP_RESUME_FAILURE: "standard-unavailable",
                },
                repository: replacementRepository,
                root,
                visibleNames: {
                  U241NEW: "New Participant",
                  U241OLD: "Current Old Name",
                },
                workspaceId: "T241REPLACE",
              });
              yield* runTurn({
                application: stack.application,
                event: participantEvent({
                  conversationId: "C241:replace",
                  participantIds: ["U241NEW"],
                  turn: 2,
                }),
                published: [],
              });
            })
          );
          const replacedState = yield* (yield* makeFileApplicationRepository(
            snapshotPath,
            controls
          )).load;
          const replacement =
            replacedState.conversations[0]?.agentSessionBinding;
          assert.strictEqual(replacement?.generation, 2);
          assert.deepStrictEqual(replacement?.introducedParticipantIds, [
            "U241OLD",
            "U241NEW",
          ]);
          const replacementPrompt = (yield* readPrompts(
            join(controls, "prompts.jsonl")
          ))[1]?.prompt;
          assert.ok(replacementPrompt?.includes("Replacement Soul"));
          assert.ok(
            replacementPrompt?.includes("Replacement Workspace Memory")
          );
          assert.ok(replacementPrompt?.includes("Current old profile"));
          assert.ok(replacementPrompt?.includes("New Participant"));

          const standardReplacementRepository =
            yield* makeFileApplicationRepository(snapshotPath, controls);
          yield* Effect.scoped(
            Effect.gen(function* () {
              const stack = yield* makeStack({
                controls,
                environment: {
                  SCRIPTED_ACP_RESUME_FAILURE: "standard-unavailable",
                },
                repository: standardReplacementRepository,
                root,
                visibleNames: {},
                workspaceId: "T241REPLACE",
              });
              yield* runTurn({
                application: stack.application,
                event: participantEvent({
                  conversationId: "C241:replace",
                  participantIds: ["U241OLD"],
                  turn: 3,
                }),
                published: [],
              });
            })
          );
          const standardReplacedState =
            yield* (yield* makeFileApplicationRepository(
              snapshotPath,
              controls
            )).load;
          const standardReplacement =
            standardReplacedState.conversations[0]?.agentSessionBinding;
          assert.strictEqual(standardReplacement?.generation, 3);

          const noDataReplacementRepository =
            yield* makeFileApplicationRepository(snapshotPath, controls);
          yield* Effect.scoped(
            Effect.gen(function* () {
              const stack = yield* makeStack({
                controls,
                environment: {
                  SCRIPTED_ACP_RESUME_FAILURE: "standard-unavailable-no-data",
                },
                repository: noDataReplacementRepository,
                root,
                visibleNames: {},
                workspaceId: "T241REPLACE",
              });
              yield* runTurn({
                application: stack.application,
                event: participantEvent({
                  conversationId: "C241:replace",
                  participantIds: ["U241OLD"],
                  turn: 4,
                }),
                published: [],
              });
            })
          );
          const noDataReplacedState =
            yield* (yield* makeFileApplicationRepository(
              snapshotPath,
              controls
            )).load;
          const noDataReplacement =
            noDataReplacedState.conversations[0]?.agentSessionBinding;
          assert.strictEqual(noDataReplacement?.generation, 4);

          const finalRepository = yield* makeFileApplicationRepository(
            snapshotPath,
            controls
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              const stack = yield* makeStack({
                controls,
                repository: finalRepository,
                root,
                visibleNames: {},
                workspaceId: "T241REPLACE",
              });
              yield* runTurn({
                application: stack.application,
                event: participantEvent({
                  conversationId: "C241:replace",
                  participantIds: ["U241OLD"],
                  turn: 5,
                }),
                published: [],
              });
            })
          );
          const methods = yield* readSessionMethods(
            join(controls, "methods.jsonl")
          );
          assert.deepStrictEqual(
            methods.map(({ method }) => method),
            [
              "session/new",
              "session/resume",
              "session/new",
              "session/resume",
              "session/new",
              "session/resume",
              "session/new",
              "session/resume",
            ]
          );
          assert.strictEqual(
            methods[7]?.params.sessionId,
            noDataReplacement?.sessionId
          );
        })
      ),
    30_000
  );

  it.live(
    "carries submitting participants into an unavailable replacement snapshot exactly once",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-241-submitting-replacement-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-241-submitting-replacement-controls-"
          );
          const snapshotPath = join(controls, "application.json");
          yield* Effect.promise(() =>
            writeFile(join(controls, "release"), "ok")
          );
          const firstRepository = yield* makeFileApplicationRepository(
            snapshotPath,
            controls
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              const stack = yield* makeStack({
                controls,
                repository: firstRepository,
                root,
                visibleNames: { U241INTRODUCED: "Introduced Person" },
                workspaceId: "T241SUBMITREPLACE",
              });
              yield* Effect.promise(() =>
                mkdir(stack.sources.userProfilesDirectory, { recursive: true })
              );
              yield* Effect.promise(() =>
                writeFile(
                  userProfilePath(stack.sources, "U241INTRODUCED"),
                  "Introduced current profile"
                )
              );
              yield* Effect.promise(() =>
                writeFile(
                  userProfilePath(stack.sources, "U241PENDING"),
                  "Pending current profile"
                )
              );
              yield* Effect.promise(() =>
                writeFile(
                  userProfilePath(stack.sources, "U241CURRENT"),
                  "Current participant profile"
                )
              );
              yield* runTurn({
                application: stack.application,
                event: participantEvent({
                  conversationId: "C241:submitting-replacement",
                  participantIds: ["U241INTRODUCED"],
                  turn: 1,
                }),
                published: [],
              });
            })
          );
          const submittingSnapshot = JSON.parse(
            yield* Effect.promise(() => readFile(snapshotPath, "utf8"))
          ) as {
            conversations: {
              agentSessionBinding: {
                initializationPhase: string;
                pendingParticipantIds: string[];
              } | null;
            }[];
          };
          const submittingBinding =
            submittingSnapshot.conversations[0]?.agentSessionBinding;
          assert.ok(
            submittingBinding !== null && submittingBinding !== undefined
          );
          submittingBinding.initializationPhase = "submitting";
          submittingBinding.pendingParticipantIds = ["U241PENDING"];
          yield* Effect.promise(() =>
            writeFile(snapshotPath, JSON.stringify(submittingSnapshot))
          );
          const replacementRepository = yield* makeFileApplicationRepository(
            snapshotPath,
            controls
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              const stack = yield* makeStack({
                controls,
                environment: {
                  SCRIPTED_ACP_RESUME_FAILURE: "standard-unavailable",
                },
                repository: replacementRepository,
                root,
                visibleNames: {
                  U241CURRENT: "Current Person",
                  U241INTRODUCED: "Introduced Person",
                  U241PENDING: "Pending Person",
                },
                workspaceId: "T241SUBMITREPLACE",
              });
              yield* runTurn({
                application: stack.application,
                event: participantEvent({
                  conversationId: "C241:submitting-replacement",
                  participantIds: ["U241CURRENT"],
                  turn: 2,
                }),
                published: [],
              });
            })
          );
          const prompts = yield* readPrompts(join(controls, "prompts.jsonl"));
          assert.strictEqual(prompts.length, 2);
          assert.deepStrictEqual(
            (yield* readSessionMethods(join(controls, "methods.jsonl"))).map(
              ({ method }) => method
            ),
            ["session/new", "session/resume", "session/new"]
          );
          const replacementPrompt = prompts[1]?.prompt ?? "";
          assert.ok(replacementPrompt.includes("Introduced current profile"));
          assert.ok(replacementPrompt.includes("Pending current profile"));
          assert.ok(replacementPrompt.includes("Current participant profile"));
          assert.strictEqual(
            replacementPrompt.split("Introduced current profile").length - 1,
            1
          );
          assert.strictEqual(
            replacementPrompt.split("Pending current profile").length - 1,
            1
          );
          assert.strictEqual(
            replacementPrompt.split("Current participant profile").length - 1,
            1
          );
          const finalState = yield* (yield* makeFileApplicationRepository(
            snapshotPath,
            controls
          )).load;
          assert.deepStrictEqual(
            finalState.conversations[0]?.agentSessionBinding
              ?.introducedParticipantIds,
            ["U241INTRODUCED", "U241PENDING", "U241CURRENT"]
          );
          assert.deepStrictEqual(
            finalState.conversations[0]?.agentSessionBinding
              ?.pendingParticipantIds,
            []
          );
          assert.strictEqual(
            finalState.conversations[0]?.agentSessionBinding
              ?.initializationPhase,
            "initialized"
          );
        })
      ),
    30_000
  );

  for (const resumeFailure of [
    "opencode-missing-internal",
    "opencode-generic-internal",
  ] as const) {
    it.live(
      `${resumeFailure === "opencode-missing-internal" ? "replaces" : "does not replace"} the pinned OpenCode internal session failure after session/list corroboration`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const root = yield* makeTempDirectoryScoped(
              `laborer-241-${resumeFailure}-`
            );
            const controls = yield* makeTempDirectoryScoped(
              `laborer-241-${resumeFailure}-controls-`
            );
            const snapshotPath = join(controls, "application.json");
            yield* Effect.promise(() =>
              writeFile(join(controls, "release"), "ok")
            );
            const openCodeEnvironment = {
              SCRIPTED_ACP_AGENT_NAME: "OpenCode",
              SCRIPTED_ACP_AGENT_VERSION: "0.0.0-next-16573",
              SCRIPTED_ACP_DISABLE_PROMPT_MARKER: "1",
              SCRIPTED_ACP_USE_OPENCODE_MESSAGE_IDS: "1",
            } as const;
            const firstRepository = yield* makeFileApplicationRepository(
              snapshotPath,
              controls
            );
            yield* Effect.scoped(
              Effect.gen(function* () {
                const stack = yield* makeStack({
                  controls,
                  environment: openCodeEnvironment,
                  repository: firstRepository,
                  root,
                  testHooks: { treatCommandAsOpenCode: true },
                  visibleNames: {},
                  workspaceId: `T241${resumeFailure}`,
                });
                yield* runTurn({
                  application: stack.application,
                  event: participantEvent({
                    conversationId: `C241:${resumeFailure}`,
                    participantIds: [],
                    turn: 1,
                  }),
                  published: [],
                });
              })
            );
            const before = yield* (yield* makeFileApplicationRepository(
              snapshotPath,
              controls
            )).load;
            const restartedRepository = yield* makeFileApplicationRepository(
              snapshotPath,
              controls
            );
            const result = yield* Effect.scoped(
              Effect.gen(function* () {
                const stack = yield* makeStack({
                  controls,
                  environment: {
                    ...openCodeEnvironment,
                    SCRIPTED_ACP_RESUME_FAILURE: resumeFailure,
                  },
                  repository: restartedRepository,
                  root,
                  testHooks: { treatCommandAsOpenCode: true },
                  visibleNames: {},
                  workspaceId: `T241${resumeFailure}`,
                });
                return yield* Effect.result(
                  runTurn({
                    application: stack.application,
                    event: participantEvent({
                      conversationId: `C241:${resumeFailure}`,
                      participantIds: [],
                      turn: 2,
                    }),
                    published: [],
                  })
                );
              })
            );
            const after = yield* (yield* makeFileApplicationRepository(
              snapshotPath,
              controls
            )).load;
            const isMissing = resumeFailure === "opencode-missing-internal";
            assert.strictEqual(result._tag, isMissing ? "Success" : "Failure");
            assert.strictEqual(
              after.conversations[0]?.agentSessionBinding?.generation,
              isMissing ? 2 : 1
            );
            if (!isMissing) {
              assert.deepStrictEqual(
                after.conversations[0]?.agentSessionBinding,
                before.conversations[0]?.agentSessionBinding
              );
            }
            assert.deepStrictEqual(
              (yield* readSessionMethods(join(controls, "methods.jsonl"))).map(
                ({ method }) => method
              ),
              isMissing
                ? ["session/new", "session/resume", "session/new"]
                : ["session/new", "session/resume"]
            );
          })
        ),
      30_000
    );
  }

  for (const failure of [
    "generic",
    "transport",
    "missing-capability",
    "standard-unavailable-wrong-uri",
    "standard-unavailable-wrong-code",
    "standard-unavailable-wrong-message",
    "unavailable-wrong-id",
  ] as const) {
    it.live(
      `does not replace a ${failure} resume failure`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const root = yield* makeTempDirectoryScoped(
              `laborer-241-${failure}-`
            );
            const controls = yield* makeTempDirectoryScoped(
              `laborer-241-${failure}-controls-`
            );
            const snapshotPath = join(controls, "application.json");
            const repository = yield* makeFileApplicationRepository(
              snapshotPath,
              controls
            );
            yield* Effect.promise(() =>
              writeFile(join(controls, "release"), "ok")
            );
            yield* Effect.scoped(
              Effect.gen(function* () {
                const stack = yield* makeStack({
                  controls,
                  repository,
                  root,
                  visibleNames: {},
                  workspaceId: `T241${failure}`,
                });
                yield* runTurn({
                  application: stack.application,
                  event: participantEvent({
                    conversationId: `C241:${failure}`,
                    participantIds: [],
                    turn: 1,
                  }),
                  published: [],
                });
              })
            );
            const before = yield* (yield* makeFileApplicationRepository(
              snapshotPath,
              controls
            )).load;
            const restartedRepository = yield* makeFileApplicationRepository(
              snapshotPath,
              controls
            );
            const result = yield* Effect.scoped(
              Effect.gen(function* () {
                const stack = yield* makeStack({
                  controls,
                  environment:
                    failure === "missing-capability"
                      ? { SCRIPTED_ACP_DISABLE_RESUME_CAPABILITY: "1" }
                      : { SCRIPTED_ACP_RESUME_FAILURE: failure },
                  repository: restartedRepository,
                  root,
                  visibleNames: {},
                  workspaceId: `T241${failure}`,
                });
                return yield* Effect.result(
                  runTurn({
                    application: stack.application,
                    event: participantEvent({
                      conversationId: `C241:${failure}`,
                      participantIds: [],
                      turn: 2,
                    }),
                    published: [],
                  })
                );
              })
            );
            assert.strictEqual(result._tag, "Failure");
            const after = yield* (yield* makeFileApplicationRepository(
              snapshotPath,
              controls
            )).load;
            assert.deepStrictEqual(
              after.conversations[0]?.agentSessionBinding,
              before.conversations[0]?.agentSessionBinding
            );
            const methods = yield* readSessionMethods(
              join(controls, "methods.jsonl")
            );
            assert.deepStrictEqual(
              methods.map(({ method }) => method),
              failure === "missing-capability"
                ? ["session/new"]
                : ["session/new", "session/resume"]
            );
          })
        ),
      30_000
    );
  }

  it.live(
    "requires resume capability before the first durable session is created",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-241-first-capability-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-241-first-capability-controls-"
          );
          yield* Effect.promise(() =>
            writeFile(join(controls, "release"), "ok")
          );
          const repository = yield* makeFileApplicationRepository(
            join(controls, "application.json"),
            controls
          );
          const result = yield* Effect.scoped(
            Effect.gen(function* () {
              const stack = yield* makeStack({
                controls,
                environment: { SCRIPTED_ACP_DISABLE_RESUME_CAPABILITY: "1" },
                repository,
                root,
                visibleNames: {},
                workspaceId: "T241FIRSTCAPABILITY",
              });
              return yield* Effect.result(
                runTurn({
                  application: stack.application,
                  event: participantEvent({
                    conversationId: "C241:first-capability",
                    participantIds: [],
                    turn: 1,
                  }),
                  published: [],
                })
              );
            })
          );
          assert.strictEqual(result._tag, "Failure");
          const methodLogExists = yield* Effect.promise(async () => {
            try {
              return (await stat(join(controls, "methods.jsonl"))).size > 0;
            } catch {
              return false;
            }
          });
          assert.strictEqual(methodLogExists, false);
        })
      ),
    30_000
  );

  for (const boundary of [
    "before-binding",
    "after-binding",
    "before-prompt",
  ] as const) {
    it.live(
      `recovers safely after a restart ${boundary}`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const root = yield* makeTempDirectoryScoped(
              `laborer-241-crash-${boundary}-`
            );
            const controls = yield* makeTempDirectoryScoped(
              `laborer-241-crash-${boundary}-controls-`
            );
            const snapshotPath = join(controls, "application.json");
            yield* Effect.promise(() =>
              writeFile(join(controls, "release"), "ok")
            );
            const firstRepository = yield* makeFileApplicationRepository(
              snapshotPath,
              controls
            );
            const firstResult = yield* Effect.scoped(
              Effect.gen(function* () {
                const stack = yield* makeStack({
                  controls,
                  environment: {
                    SCRIPTED_ACP_LIFECYCLE_LOG_PATH: join(
                      controls,
                      "lifecycle.log"
                    ),
                  },
                  repository: firstRepository,
                  root,
                  testHooks: crashHooksFor(boundary),
                  visibleNames: { U241CRASH: "Crash Boundary Person" },
                  workspaceId: `T241CRASH${boundary.replace("-", "")}`,
                });
                yield* Effect.promise(() =>
                  writeFile(stack.sources.soulPath, "CRASH BOUNDARY SOUL")
                );
                return yield* Effect.result(
                  runTurn({
                    application: stack.application,
                    event: participantEvent({
                      conversationId: `C241:crash:${boundary}`,
                      participantIds: ["U241CRASH"],
                      turn: 1,
                    }),
                    published: [],
                  })
                );
              })
            );
            assert.strictEqual(firstResult._tag, "Failure");
            assert.strictEqual(
              (yield* Effect.promise(() =>
                readFile(join(controls, "lifecycle.log"), "utf8")
              )).includes("session:close:"),
              boundary !== "before-prompt"
            );

            const stateAfterCrash =
              yield* (yield* makeFileApplicationRepository(
                snapshotPath,
                controls
              )).load;
            const phase =
              stateAfterCrash.conversations[0]?.agentSessionBinding
                ?.initializationPhase ?? null;
            assert.strictEqual(phase, crashPhaseFor(boundary));

            const restartedRepository = yield* makeFileApplicationRepository(
              snapshotPath,
              controls
            );
            yield* Effect.scoped(
              Effect.gen(function* () {
                const stack = yield* makeStack({
                  controls,
                  repository: restartedRepository,
                  root,
                  visibleNames: { U241CRASH: "Crash Boundary Person" },
                  workspaceId: `T241CRASH${boundary.replace("-", "")}`,
                });
                yield* runTurn({
                  application: stack.application,
                  event: participantEvent({
                    conversationId: `C241:crash:${boundary}`,
                    participantIds: ["U241CRASH"],
                    turn: 2,
                  }),
                  published: [],
                });
              })
            );

            const methods = yield* readSessionMethods(
              join(controls, "methods.jsonl")
            );
            assert.deepStrictEqual(
              methods.map(({ method }) => method),
              boundary === "before-binding"
                ? ["session/new", "session/new"]
                : ["session/new", "session/resume"]
            );
            const prompts = yield* readPrompts(join(controls, "prompts.jsonl"));
            assert.strictEqual(prompts.length, 1);
            assert.strictEqual(
              prompts[0]?.prompt.includes("CRASH BOUNDARY SOUL"),
              boundary !== "before-prompt"
            );
            const finalState = yield* (yield* makeFileApplicationRepository(
              snapshotPath,
              controls
            )).load;
            assert.strictEqual(
              finalState.conversations[0]?.agentSessionBinding
                ?.initializationPhase,
              "initialized"
            );
          })
        ),
      30_000
    );
  }

  it.live(
    "recovers conservatively when the process exits after accepting the initial prompt",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-241-crash-after-prompt-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-241-crash-after-prompt-controls-"
          );
          const snapshotPath = join(controls, "application.json");
          yield* Effect.promise(() =>
            writeFile(join(controls, "release"), "ok")
          );
          const firstRepository = yield* makeFileApplicationRepository(
            snapshotPath,
            controls
          );
          const failed = yield* Effect.scoped(
            Effect.gen(function* () {
              const stack = yield* makeStack({
                controls,
                environment: { SCRIPTED_ACP_EXIT_AFTER_PROMPT_RECEIVED: "1" },
                repository: firstRepository,
                root,
                visibleNames: { U241ACCEPTED: "Accepted Person" },
                workspaceId: "T241ACCEPTED",
              });
              yield* Effect.promise(() =>
                writeFile(stack.sources.soulPath, "ACCEPTED PROMPT SOUL")
              );
              return yield* Effect.result(
                runTurn({
                  application: stack.application,
                  event: participantEvent({
                    conversationId: "C241:accepted",
                    participantIds: ["U241ACCEPTED"],
                    turn: 1,
                  }),
                  published: [],
                })
              );
            })
          );
          assert.strictEqual(failed._tag, "Failure");
          const crashedState = yield* (yield* makeFileApplicationRepository(
            snapshotPath,
            controls
          )).load;
          assert.strictEqual(
            crashedState.conversations[0]?.agentSessionBinding
              ?.initializationPhase,
            "submitting"
          );

          const restartedRepository = yield* makeFileApplicationRepository(
            snapshotPath,
            controls
          );
          const blocked = yield* Effect.scoped(
            Effect.gen(function* () {
              const stack = yield* makeStack({
                controls,
                repository: restartedRepository,
                root,
                visibleNames: { U241ACCEPTED: "Accepted Person" },
                workspaceId: "T241ACCEPTED",
              });
              return yield* Effect.result(
                runTurn({
                  application: stack.application,
                  event: participantEvent({
                    conversationId: "C241:accepted",
                    participantIds: ["U241ACCEPTED"],
                    turn: 2,
                  }),
                  published: [],
                })
              );
            })
          );
          assert.strictEqual(blocked._tag, "Failure");
          const prompts = yield* readPrompts(join(controls, "prompts.jsonl"));
          assert.strictEqual(prompts.length, 1);
          assert.ok(prompts[0]?.prompt.includes("ACCEPTED PROMPT SOUL"));
          assert.deepStrictEqual(
            (yield* readSessionMethods(join(controls, "methods.jsonl"))).map(
              ({ method }) => method
            ),
            ["session/new"]
          );
        })
      ),
    30_000
  );

  it.live(
    "recovers the same definitely-unsubmitted running turn exactly once",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-241-recover-unsubmitted-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-241-recover-unsubmitted-controls-"
          );
          const snapshotPath = join(controls, "application.json");
          yield* Effect.promise(() =>
            writeFile(join(controls, "release"), "ok")
          );
          const event = participantEvent({
            conversationId: "C241:recover-unsubmitted",
            participantIds: ["U241RECOVER"],
            turn: 1,
          });
          const firstRepository = yield* makeFileApplicationRepository(
            snapshotPath,
            controls
          );
          const first = yield* Effect.scoped(
            Effect.gen(function* () {
              const stack = yield* makeStack({
                controls,
                repository: firstRepository,
                root,
                testHooks: {
                  afterDurableBindingPersisted: rejectingHook,
                },
                visibleNames: { U241RECOVER: "Recover Person" },
                workspaceId: "T241RECOVERUNSUBMITTED",
              });
              return yield* Effect.result(
                runTurn({
                  application: stack.application,
                  event,
                  published: [],
                })
              );
            })
          );
          assert.strictEqual(first._tag, "Failure");

          const published: ApplicationPublicOutput[] = [];
          const restartedRepository = yield* makeFileApplicationRepository(
            snapshotPath,
            controls
          );
          const recovered = yield* Effect.scoped(
            Effect.gen(function* () {
              const stack = yield* makeStack({
                controls,
                repository: restartedRepository,
                root,
                visibleNames: { U241RECOVER: "Recover Person" },
                workspaceId: "T241RECOVERUNSUBMITTED",
              });
              return yield* Effect.result(
                runTurn({ application: stack.application, event, published })
              );
            })
          );
          assert.strictEqual(recovered._tag, "Success");
          assert.strictEqual(
            (yield* readPrompts(join(controls, "prompts.jsonl"))).length,
            1
          );
          assert.deepStrictEqual(
            (yield* readSessionMethods(join(controls, "methods.jsonl"))).map(
              ({ method }) => method
            ),
            ["session/new", "session/resume"]
          );
          const finalState = yield* (yield* makeFileApplicationRepository(
            snapshotPath,
            controls
          )).load;
          assert.strictEqual(
            finalState.conversations[0]?.prompts[0]?.status,
            "completed"
          );
          assert.strictEqual(
            finalState.conversations[0]?.agentSessionBinding
              ?.initializationPhase,
            "initialized"
          );
        })
      ),
    30_000
  );

  it.live(
    "keeps an ambiguous unavailable replacement pending until a fresh turn initializes it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-241-recover-ambiguous-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-241-recover-ambiguous-controls-"
          );
          const snapshotPath = join(controls, "application.json");
          yield* Effect.promise(() =>
            writeFile(join(controls, "release"), "ok")
          );
          const event = participantEvent({
            conversationId: "C241:recover-ambiguous",
            participantIds: ["U241AMBIGUOUS"],
            turn: 1,
          });
          const published: ApplicationPublicOutput[] = [];
          const firstRepository = yield* makeFileApplicationRepository(
            snapshotPath,
            controls
          );
          const first = yield* Effect.scoped(
            Effect.gen(function* () {
              const stack = yield* makeStack({
                controls,
                environment: {
                  SCRIPTED_ACP_EXIT_AFTER_FIRST_PUBLIC_CHUNK: "1",
                },
                repository: firstRepository,
                root,
                visibleNames: { U241AMBIGUOUS: "Ambiguous Person" },
                workspaceId: "T241RECOVERAMBIGUOUS",
              });
              return yield* Effect.result(
                runTurn({ application: stack.application, event, published })
              );
            })
          );
          assert.strictEqual(first._tag, "Failure");
          assert.strictEqual(
            published.filter(
              (output) =>
                "text" in output && output.text === "**Streaming** from ACP"
            ).length,
            1
          );
          const ambiguousState = yield* (yield* makeFileApplicationRepository(
            snapshotPath,
            controls
          )).load;
          const ambiguousPromptId =
            ambiguousState.conversations[0]?.agentSessionBinding
              ?.ambiguousPromptId;
          assert.ok(
            ambiguousPromptId !== null && ambiguousPromptId !== undefined
          );
          const sources = yield* prepareAcpAgentContextSources({
            root,
            workspaceId: "T241RECOVERAMBIGUOUS",
          });
          yield* Effect.promise(() =>
            writeFile(sources.soulPath, "CURRENT REPLACEMENT SOUL")
          );
          yield* Effect.promise(() =>
            mkdir(sources.userProfilesDirectory, { recursive: true })
          );
          yield* Effect.promise(() =>
            writeFile(
              userProfilePath(sources, "U241AMBIGUOUS"),
              "Ambiguous participant current profile"
            )
          );
          yield* Effect.promise(() =>
            writeFile(
              userProfilePath(sources, "U241FRESH"),
              "Fresh participant current profile"
            )
          );

          const restartedRepository = yield* makeFileApplicationRepository(
            snapshotPath,
            controls
          );
          const recovered = yield* Effect.scoped(
            Effect.gen(function* () {
              const stack = yield* makeStack({
                controls,
                environment: {
                  SCRIPTED_ACP_RESUME_FAILURE: "standard-unavailable",
                },
                repository: restartedRepository,
                root,
                visibleNames: {
                  U241AMBIGUOUS: "Ambiguous Person",
                  U241FRESH: "Fresh Person",
                },
                workspaceId: "T241RECOVERAMBIGUOUS",
              });
              const recovery = yield* Effect.result(
                runTurn({ application: stack.application, event, published })
              );
              const pendingReplacement =
                yield* (yield* makeFileApplicationRepository(
                  snapshotPath,
                  controls
                )).load;
              const pendingBinding =
                pendingReplacement.conversations[0]?.agentSessionBinding;
              assert.strictEqual(
                pendingBinding?.initializationPhase,
                "submitting"
              );
              assert.strictEqual(
                pendingBinding?.ambiguousPromptId,
                ambiguousPromptId
              );
              const later = yield* Effect.result(
                runTurn({
                  application: stack.application,
                  event: participantEvent({
                    conversationId: "C241:recover-ambiguous",
                    participantIds: ["U241FRESH"],
                    turn: 2,
                  }),
                  published,
                })
              );
              assert.strictEqual(later._tag, "Failure");
              return recovery;
            })
          );
          assert.strictEqual(recovered._tag, "Failure");
          const prompts = yield* readPrompts(join(controls, "prompts.jsonl"));
          assert.strictEqual(prompts.length, 1);
          assert.deepStrictEqual(
            (yield* readSessionMethods(join(controls, "methods.jsonl"))).map(
              ({ method }) => method
            ),
            ["session/new"]
          );
          assert.strictEqual(
            published.filter(
              (output) =>
                "text" in output && output.text === "**Streaming** from ACP"
            ).length,
            1
          );
          const finalState = yield* (yield* makeFileApplicationRepository(
            snapshotPath,
            controls
          )).load;
          assert.strictEqual(
            finalState.conversations[0]?.prompts[0]?.status,
            "running"
          );
          assert.strictEqual(
            finalState.conversations[0]?.agentSessionBinding
              ?.initializationPhase,
            "submitting"
          );
          assert.strictEqual(
            finalState.conversations[0]?.agentSessionBinding?.ambiguousPromptId,
            ambiguousPromptId
          );
        })
      ),
    30_000
  );

  it.live(
    "drops delayed resume and post-prompt replay outside an active prompt",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-241-delayed-replay-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-241-delayed-replay-controls-"
          );
          const snapshotPath = join(controls, "application.json");
          yield* Effect.promise(() =>
            writeFile(join(controls, "release"), "ok")
          );
          const firstRepository = yield* makeFileApplicationRepository(
            snapshotPath,
            controls
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              const stack = yield* makeStack({
                controls,
                repository: firstRepository,
                root,
                visibleNames: {},
                workspaceId: "T241REPLAY",
              });
              yield* runTurn({
                application: stack.application,
                event: participantEvent({
                  conversationId: "C241:replay",
                  participantIds: [],
                  turn: 1,
                }),
                published: [],
              });
            })
          );

          const published: ApplicationPublicOutput[] = [];
          const restartedRepository = yield* makeFileApplicationRepository(
            snapshotPath,
            controls
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              const stack = yield* makeStack({
                controls,
                environment: {
                  SCRIPTED_ACP_DELAYED_REPLAY_MILLIS: "10",
                  SCRIPTED_ACP_POST_PROMPT_REPLAY_MILLIS: "10",
                  SCRIPTED_ACP_REPLAY_AFTER_PROMPT_BEFORE_MARKER: "1",
                },
                repository: restartedRepository,
                root,
                testHooks: {
                  beforePromptSubmission: () =>
                    new Promise((resolveWait) => setTimeout(resolveWait, 75)),
                },
                visibleNames: {},
                workspaceId: "T241REPLAY",
              });
              yield* runTurn({
                application: stack.application,
                event: participantEvent({
                  conversationId: "C241:replay",
                  participantIds: [],
                  turn: 2,
                }),
                published,
              });
              yield* Effect.sleep("50 millis");
              yield* runTurn({
                application: stack.application,
                event: participantEvent({
                  conversationId: "C241:replay",
                  participantIds: [],
                  turn: 3,
                }),
                published,
              });
            })
          );
          const publishedText = published
            .filter(
              (output): output is ApplicationPublicOutput & { text: string } =>
                "text" in output
            )
            .map(({ text }) => text)
            .join("\n");
          assert.ok(
            !publishedText.includes("HISTORICAL OUTPUT MUST NOT REPLAY")
          );
          assert.ok(
            !publishedText.includes("DELAYED RESUME HISTORY MUST NOT REPLAY")
          );
          assert.ok(
            !publishedText.includes("POST PROMPT HISTORY MUST NOT REPLAY")
          );
          assert.ok(
            !publishedText.includes(
              "PRE-MARKER HISTORICAL OUTPUT MUST NOT REPLAY"
            )
          );
          assert.ok(publishedText.includes("**Streaming** from ACP"));
        })
      ),
    30_000
  );

  it.live(
    "fails closed and poisons an agent that emits chunks without a current prompt marker",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-241-missing-prompt-marker-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-241-missing-prompt-marker-controls-"
          );
          yield* Effect.promise(() =>
            writeFile(join(controls, "release"), "ok")
          );
          const repository = yield* makeFileApplicationRepository(
            join(controls, "application.json"),
            controls
          );
          const published: ApplicationPublicOutput[] = [];
          const processFailures: Array<
            readonly ["deterministic" | "transient", string]
          > = [];
          const stack = yield* makeStack({
            controls,
            environment: { SCRIPTED_ACP_DISABLE_PROMPT_MARKER: "1" },
            repository,
            root,
            processFailureObserver: (classification, cause) =>
              processFailures.push([classification, cause]),
            visibleNames: {},
            workspaceId: "T241MISSINGMARKER",
          });
          const first = yield* Effect.result(
            runTurn({
              application: stack.application,
              event: participantEvent({
                conversationId: "C241:missing-marker",
                participantIds: [],
                turn: 1,
              }),
              published,
            })
          );
          const second = yield* Effect.result(
            runTurn({
              application: stack.application,
              event: participantEvent({
                conversationId: "C241:missing-marker",
                participantIds: [],
                turn: 2,
              }),
              published,
            })
          );
          assert.strictEqual(first._tag, "Failure");
          assert.strictEqual(second._tag, "Failure");
          assert.strictEqual(
            published.some(
              (output) => "text" in output && output.text.includes("Streaming")
            ),
            false
          );
          assert.strictEqual(
            (yield* readPrompts(join(controls, "prompts.jsonl"))).length,
            1
          );
          assert.deepStrictEqual(processFailures, [
            ["deterministic", "protocol_incompatible"],
          ]);
        })
      ),
    30_000
  );

  it.live(
    "drops the prior-tick maximum OpenCode ID and opens on a strictly newer full order",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-241-opencode-epoch-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-241-opencode-epoch-controls-"
          );
          yield* Effect.promise(() =>
            writeFile(join(controls, "release"), "ok")
          );
          const repository = yield* makeFileApplicationRepository(
            join(controls, "application.json"),
            controls
          );
          const published: ApplicationPublicOutput[] = [];
          const stack = yield* makeStack({
            controls,
            environment: {
              SCRIPTED_ACP_AGENT_NAME: "OpenCode",
              SCRIPTED_ACP_AGENT_VERSION: "0.0.0-next-16573",
              SCRIPTED_ACP_DISABLE_PROMPT_MARKER: "1",
              SCRIPTED_ACP_REPLAY_AFTER_PROMPT_BEFORE_MARKER: "1",
              SCRIPTED_ACP_USE_OPENCODE_MESSAGE_IDS: "1",
            },
            repository,
            root,
            testHooks: { treatCommandAsOpenCode: true },
            visibleNames: {},
            workspaceId: "T241OPENCODEEPOCH",
          });
          yield* runTurn({
            application: stack.application,
            event: participantEvent({
              conversationId: "C241:opencode-epoch",
              participantIds: [],
              turn: 1,
            }),
            published,
          });
          const publishedText = published
            .filter(
              (output): output is ApplicationPublicOutput & { text: string } =>
                "text" in output
            )
            .map(({ text }) => text)
            .join("\n");
          assert.ok(publishedText.includes("**Streaming** from ACP"));
          assert.strictEqual(
            publishedText.split("**Streaming** from ACP").length - 1,
            1
          );
          assert.ok(
            !publishedText.includes(
              "PRE-MARKER HISTORICAL OUTPUT MUST NOT REPLAY"
            )
          );
        })
      ),
    30_000
  );

  // These scenes assert a wall-clock fast-path bound that discriminates
  // against the 5s prompt-epoch marker timeout. Concurrent scheduling would
  // make that measurement reflect worker load instead of the fast path, so
  // they opt back out of suite-level concurrency.
  describe.sequential("pinned OpenCode textless fast path", () => {
    for (const stopReason of ["end_turn", "max_tokens", "refusal"] as const) {
      it.live(
        `records a pinned OpenCode textless ${stopReason} response without opening publication`,
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const root = yield* makeTempDirectoryScoped(
                `laborer-241-opencode-textless-${stopReason}-`
              );
              const controls = yield* makeTempDirectoryScoped(
                `laborer-241-opencode-textless-${stopReason}-controls-`
              );
              yield* Effect.promise(() =>
                writeFile(join(controls, "release"), "ok")
              );
              const repository = yield* makeFileApplicationRepository(
                join(controls, "application.json"),
                controls
              );
              const published: ApplicationPublicOutput[] = [];
              const stack = yield* makeStack({
                controls,
                environment: {
                  SCRIPTED_ACP_AGENT_NAME: "OpenCode",
                  SCRIPTED_ACP_AGENT_VERSION: "0.0.0-next-16573",
                  SCRIPTED_ACP_DISABLE_PROMPT_MARKER: "1",
                  SCRIPTED_ACP_TEXTLESS_STOP_REASON: stopReason,
                },
                repository,
                root,
                testHooks: { treatCommandAsOpenCode: true },
                visibleNames: {},
                workspaceId: `T241TEXTLESS${stopReason}`,
              });
              const startedAt = Date.now();
              const result = yield* Effect.result(
                runTurn({
                  application: stack.application,
                  event: participantEvent({
                    conversationId: `C241:textless:${stopReason}`,
                    participantIds: [],
                    turn: 1,
                  }),
                  published,
                })
              );
              assert.strictEqual(
                result._tag,
                stopReason === "end_turn" ? "Success" : "Failure"
              );
              assert.ok(Date.now() - startedAt < TEXTLESS_FAST_PATH_MAX_MILLIS);
              assert.strictEqual(
                published.some((output) => "text" in output),
                false
              );
              const settled = yield* repository.load;
              assert.strictEqual(
                settled.conversations[0]?.prompts[0]?.status,
                stopReason === "end_turn" ? "completed" : "running"
              );
              assert.strictEqual(
                settled.conversations[0]?.agentSessionBinding
                  ?.initializationPhase,
                "initialized"
              );
              assert.strictEqual(
                settled.conversations[0]?.agentSessionBinding
                  ?.ambiguousPromptId,
                null
              );
              assert.strictEqual(
                settled.conversations[0]?.prompts[0]?.attempts[0]?.outcome,
                stopReason
              );
            })
          ),
        30_000
      );
    }
  });

  it.live(
    "fails closed on textless max_turn_requests because pinned OpenCode does not emit it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-241-opencode-max-turn-requests-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-241-opencode-max-turn-requests-controls-"
          );
          yield* Effect.promise(() =>
            writeFile(join(controls, "release"), "ok")
          );
          const repository = yield* makeFileApplicationRepository(
            join(controls, "application.json"),
            controls
          );
          const published: ApplicationPublicOutput[] = [];
          const stack = yield* makeStack({
            controls,
            environment: {
              SCRIPTED_ACP_AGENT_NAME: "OpenCode",
              SCRIPTED_ACP_AGENT_VERSION: "0.0.0-next-16573",
              SCRIPTED_ACP_DISABLE_PROMPT_MARKER: "1",
              SCRIPTED_ACP_TEXTLESS_STOP_REASON: "max_turn_requests",
            },
            repository,
            root,
            testHooks: { treatCommandAsOpenCode: true },
            visibleNames: {},
            workspaceId: "T241MAXTURNREQUESTS",
          });
          const result = yield* Effect.result(
            runTurn({
              application: stack.application,
              event: participantEvent({
                conversationId: "C241:max-turn-requests",
                participantIds: [],
                turn: 1,
              }),
              published,
            })
          );
          assert.strictEqual(result._tag, "Failure");
          assert.strictEqual(
            published.some((output) => "text" in output),
            false
          );
        })
      ),
    30_000
  );

  for (const stopReason of [
    "max_turn_requests",
    "unknown_future_stop",
  ] as const) {
    it.live(
      `persists a generic ${stopReason} stop conservatively`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const root = yield* makeTempDirectoryScoped(
              `laborer-252-generic-stop-${stopReason}-`
            );
            const controls = yield* makeTempDirectoryScoped(
              `laborer-252-generic-stop-${stopReason}-controls-`
            );
            yield* Effect.promise(() =>
              writeFile(join(controls, "release"), "ok")
            );
            const repository = yield* makeFileApplicationRepository(
              join(controls, "application.json"),
              controls
            );
            const stack = yield* makeStack({
              controls,
              environment: {
                SCRIPTED_ACP_TEXTLESS_STOP_REASON: stopReason,
              },
              repository,
              root,
              visibleNames: {},
              workspaceId: `T252STOP${stopReason}`,
            });
            assert.strictEqual(
              (yield* Effect.result(
                runTurn({
                  application: stack.application,
                  event: participantEvent({
                    conversationId: `C252:stop:${stopReason}`,
                    participantIds: [],
                    turn: 1,
                  }),
                  published: [],
                })
              ))._tag,
              "Failure"
            );
            const attempt = (yield* repository.load).conversations[0]
              ?.prompts[0]?.attempts[0];
            assert.strictEqual(
              attempt?.outcome,
              stopReason === "max_turn_requests"
                ? "max_turn_requests"
                : "unknown_stop"
            );
            assert.strictEqual(
              attempt?.recoveryClass,
              stopReason === "max_turn_requests" ? "terminal" : "unresolved"
            );
          })
        ),
      30_000
    );
  }

  for (const priorChunks of [false, true] as const) {
    it.live(
      `keeps a cancelled prompt running without replay${priorChunks ? " after publishing current chunks" : " when textless"}`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const root = yield* makeTempDirectoryScoped(
              `laborer-241-cancelled-${priorChunks}-`
            );
            const controls = yield* makeTempDirectoryScoped(
              `laborer-241-cancelled-${priorChunks}-controls-`
            );
            const snapshotPath = join(controls, "application.json");
            yield* Effect.promise(() =>
              writeFile(join(controls, "release"), "ok")
            );
            const event = participantEvent({
              conversationId: `C241:cancelled:${priorChunks}`,
              participantIds: ["U241CANCELLED"],
              turn: 1,
            });
            const published: ApplicationPublicOutput[] = [];
            const firstRepository = yield* makeFileApplicationRepository(
              snapshotPath,
              controls
            );
            const cancelled = yield* Effect.scoped(
              Effect.gen(function* () {
                const stack = yield* makeStack({
                  controls,
                  environment: priorChunks
                    ? { SCRIPTED_ACP_CANCEL_AFTER_PUBLIC_CHUNK: "1" }
                    : { SCRIPTED_ACP_TEXTLESS_STOP_REASON: "cancelled" },
                  repository: firstRepository,
                  root,
                  visibleNames: { U241CANCELLED: "Cancelled Person" },
                  workspaceId: `T241CANCELLED${priorChunks}`,
                });
                return yield* Effect.result(
                  runTurn({ application: stack.application, event, published })
                );
              })
            );
            assert.strictEqual(cancelled._tag, "Failure");
            if (cancelled._tag === "Failure") {
              assert.strictEqual(cancelled.failure._tag, "HandlerFailure");
            }
            if (
              cancelled._tag === "Failure" &&
              cancelled.failure._tag === "HandlerFailure"
            ) {
              assert.strictEqual(cancelled.failure.category, "signal");
            }
            assert.strictEqual(
              published.filter(
                (output) =>
                  "text" in output && output.text === "**Streaming** from ACP"
              ).length,
              priorChunks ? 1 : 0
            );
            const settled = yield* (yield* makeFileApplicationRepository(
              snapshotPath,
              controls
            )).load;
            assert.strictEqual(
              settled.conversations[0]?.prompts[0]?.status,
              "running"
            );
            assert.strictEqual(
              settled.conversations[0]?.agentSessionBinding
                ?.initializationPhase,
              "initialized"
            );
            assert.strictEqual(
              settled.conversations[0]?.agentSessionBinding?.ambiguousPromptId,
              null
            );
            assert.strictEqual(
              settled.conversations[0]?.prompts[0]?.attempts[0]?.outcome,
              "cancelled_agent"
            );
            assert.strictEqual(
              settled.conversations[0]?.prompts[0]?.attempts[0]?.recoveryClass,
              "terminal"
            );

            const restartedRepository = yield* makeFileApplicationRepository(
              snapshotPath,
              controls
            );
            const recovered = yield* Effect.scoped(
              Effect.gen(function* () {
                const stack = yield* makeStack({
                  controls,
                  repository: restartedRepository,
                  root,
                  visibleNames: { U241CANCELLED: "Cancelled Person" },
                  workspaceId: `T241CANCELLED${priorChunks}`,
                });
                return yield* Effect.result(
                  runTurn({ application: stack.application, event, published })
                );
              })
            );
            assert.strictEqual(recovered._tag, "Failure");
            assert.strictEqual(
              (yield* readPrompts(join(controls, "prompts.jsonl"))).length,
              1
            );
            assert.deepStrictEqual(
              (yield* readSessionMethods(join(controls, "methods.jsonl"))).map(
                ({ method }) => method
              ),
              ["session/new"]
            );
          })
        ),
      30_000
    );
  }

  it.live(
    "persists an acknowledged local cancellation as cancelled_local",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-252-local-cancellation-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-252-local-cancellation-controls-"
          );
          const repository = yield* makeFileApplicationRepository(
            join(controls, "application.json"),
            controls
          );
          const stack = yield* makeStack({
            controls,
            repository,
            root,
            visibleNames: {},
            workspaceId: "T252LOCALCANCELLATION",
          });
          const running = yield* Effect.forkChild(
            runTurn({
              application: stack.application,
              event: participantEvent({
                conversationId: "C252:local-cancellation",
                participantIds: [],
                turn: 1,
              }),
              published: [],
            })
          );
          yield* Effect.promise(() =>
            waitForPath(join(controls, "prompts.jsonl"))
          );
          yield* Fiber.interrupt(running);

          const state = yield* repository.load;
          const attempt = state.conversations[0]?.prompts[0]?.attempts[0];
          assert.strictEqual(attempt?.cancellationIntent, "local");
          assert.strictEqual(attempt?.recoveryClass, "terminal");
          assert.strictEqual(attempt?.outcome, "cancelled_local");
        })
      ),
    10_000
  );

  for (const ignoresCancellation of [false, true] as const) {
    it.live(
      `persists a deadline cancellation ${ignoresCancellation ? "as unresolved when ignored" : "as cancelled_local when acknowledged"}`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const root = yield* makeTempDirectoryScoped(
              `laborer-252-deadline-${ignoresCancellation}-`
            );
            const controls = yield* makeTempDirectoryScoped(
              `laborer-252-deadline-${ignoresCancellation}-controls-`
            );
            const repository = yield* makeFileApplicationRepository(
              join(controls, "application.json"),
              controls
            );
            const stack = yield* makeStack({
              childExitGraceMillis: 50,
              controls,
              environment: ignoresCancellation
                ? { SCRIPTED_ACP_IGNORE_PROMPT_CANCELLATION: "1" }
                : {},
              promptDeadlineMillis: 50,
              repository,
              root,
              visibleNames: {},
              workspaceId: `T252DEADLINE${ignoresCancellation}`,
            });
            const result = yield* Effect.result(
              runTurn({
                application: stack.application,
                event: participantEvent({
                  conversationId: `C252:deadline:${ignoresCancellation}`,
                  participantIds: [],
                  turn: 1,
                }),
                published: [],
              })
            );
            assert.strictEqual(result._tag, "Failure");
            const state = yield* repository.load;
            const attempt = state.conversations[0]?.prompts[0]?.attempts[0];
            assert.strictEqual(attempt?.cancellationIntent, "deadline");
            assert.strictEqual(
              attempt?.recoveryClass,
              ignoresCancellation ? "unresolved" : "terminal"
            );
            assert.strictEqual(
              attempt?.outcome,
              ignoresCancellation ? null : "cancelled_local"
            );
          })
        ),
      10_000
    );
  }

  it.live(
    "atomically commits terminal attempt and binding before a post-commit crash",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-252-terminal-atomic-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-252-terminal-atomic-controls-"
          );
          const snapshotPath = join(controls, "application.json");
          yield* Effect.promise(() =>
            writeFile(join(controls, "release"), "ok")
          );
          const event = participantEvent({
            conversationId: "C252:terminal-atomic",
            participantIds: ["U252ATOMIC"],
            turn: 1,
          });
          const firstRepository = yield* makeFileApplicationRepository(
            snapshotPath,
            controls
          );
          const first = yield* Effect.scoped(
            Effect.gen(function* () {
              const stack = yield* makeStack({
                controls,
                repository: firstRepository,
                root,
                testHooks: { afterTerminalCommit: rejectingHook },
                visibleNames: { U252ATOMIC: "Atomic Person" },
                workspaceId: "T252TERMINALATOMIC",
              });
              yield* Effect.promise(() =>
                writeFile(stack.sources.soulPath, "ATOMIC TERMINAL SOUL")
              );
              return yield* Effect.result(
                runTurn({
                  application: stack.application,
                  event,
                  published: [],
                })
              );
            })
          );
          assert.strictEqual(first._tag, "Failure");
          const committed = yield* firstRepository.load;
          assert.strictEqual(
            committed.conversations[0]?.prompts[0]?.attempts[0]?.phase,
            "terminal"
          );
          assert.strictEqual(
            committed.conversations[0]?.agentSessionBinding
              ?.initializationPhase,
            "initialized"
          );
          assert.strictEqual(
            committed.conversations[0]?.agentSessionBinding?.ambiguousPromptId,
            null
          );

          const restartedRepository = yield* makeFileApplicationRepository(
            snapshotPath,
            controls
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              const stack = yield* makeStack({
                controls,
                repository: restartedRepository,
                root,
                visibleNames: { U252ATOMIC: "Atomic Person" },
                workspaceId: "T252TERMINALATOMIC",
              });
              yield* runTurn({
                application: stack.application,
                event,
                published: [],
              });
              yield* runTurn({
                application: stack.application,
                event: participantEvent({
                  conversationId: "C252:terminal-atomic",
                  participantIds: ["U252ATOMIC"],
                  turn: 2,
                }),
                published: [],
              });
            })
          );
          const prompts = yield* readPrompts(join(controls, "prompts.jsonl"));
          assert.strictEqual(prompts.length, 2);
          assert.strictEqual(
            prompts.filter(({ prompt }) =>
              prompt.includes("ATOMIC TERMINAL SOUL")
            ).length,
            1
          );
          assert.strictEqual(
            prompts.filter(({ prompt }) => prompt.includes("Atomic Person"))
              .length,
            1
          );
        })
      ),
    30_000
  );

  it.live(
    "bounds unique conversation admission above active-session capacity",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-252-session-capacity-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-252-session-capacity-controls-"
          );
          yield* Effect.promise(() =>
            writeFile(join(controls, "release"), "ok")
          );
          const repository = yield* makeFileApplicationRepository(
            join(controls, "application.json"),
            controls
          );
          const stack = yield* makeStack({
            controls,
            repository,
            root,
            testHooks: { activeSessionLimit: 3 },
            visibleNames: {},
            workspaceId: "T252SESSIONCAPACITY",
          });
          for (let index = 0; index < 3; index += 1) {
            yield* runTurn({
              application: stack.application,
              event: participantEvent({
                conversationId: `C252:capacity:${index}`,
                participantIds: [],
                turn: 1,
              }),
              published: [],
            });
          }
          assert.strictEqual(
            (yield* Effect.result(
              runTurn({
                application: stack.application,
                event: participantEvent({
                  conversationId: "C252:capacity:overflow",
                  participantIds: [],
                  turn: 1,
                }),
                published: [],
              })
            ))._tag,
            "Failure"
          );
        })
      ),
    60_000
  );

  it.live(
    "rejects a generic durable peer that did not negotiate the prompt epoch extension",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-241-missing-epoch-capability-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-241-missing-epoch-capability-controls-"
          );
          const repository = yield* makeFileApplicationRepository(
            join(controls, "application.json"),
            controls
          );
          const stack = yield* makeStack({
            controls,
            environment: {
              SCRIPTED_ACP_DISABLE_PROMPT_EPOCH_CAPABILITY: "1",
            },
            repository,
            root,
            visibleNames: {},
            workspaceId: "T241MISSINGEPOCHCAPABILITY",
          });
          const result = yield* Effect.result(
            runTurn({
              application: stack.application,
              event: participantEvent({
                conversationId: "C241:missing-epoch-capability",
                participantIds: [],
                turn: 1,
              }),
              published: [],
            })
          );
          assert.strictEqual(result._tag, "Failure");
          const methodsExist = yield* Effect.promise(async () => {
            try {
              return (await stat(join(controls, "methods.jsonl"))).size > 0;
            } catch {
              return false;
            }
          });
          assert.strictEqual(methodsExist, false);
        })
      ),
    30_000
  );

  it.live(
    "rejects an unsupported OpenCode ACP identity before session creation",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-241-opencode-version-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-241-opencode-version-controls-"
          );
          const repository = yield* makeFileApplicationRepository(
            join(controls, "application.json"),
            controls
          );
          const result = yield* Effect.result(
            makeStack({
              controls,
              environment: {
                SCRIPTED_ACP_AGENT_NAME: "OpenCode",
                SCRIPTED_ACP_AGENT_VERSION: "1.19.0",
              },
              repository,
              root,
              testHooks: { treatCommandAsOpenCode: true },
              visibleNames: {},
              workspaceId: "T241OPENCODEVERSION",
            })
          );
          assert.strictEqual(result._tag, "Failure");
        })
      ),
    30_000
  );

  it.live(
    "fails closed when supported OpenCode emits an incompatible message ID format",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-241-opencode-id-format-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-241-opencode-id-format-controls-"
          );
          yield* Effect.promise(() =>
            writeFile(join(controls, "release"), "ok")
          );
          const repository = yield* makeFileApplicationRepository(
            join(controls, "application.json"),
            controls
          );
          const published: ApplicationPublicOutput[] = [];
          const formatFailures: Array<
            readonly ["deterministic" | "transient", string]
          > = [];
          const stack = yield* makeStack({
            controls,
            environment: {
              SCRIPTED_ACP_AGENT_NAME: "OpenCode",
              SCRIPTED_ACP_AGENT_VERSION: "0.0.0-next-16573",
              SCRIPTED_ACP_DISABLE_PROMPT_MARKER: "1",
            },
            repository,
            root,
            testHooks: { treatCommandAsOpenCode: true },
            processFailureObserver: (classification, cause) =>
              formatFailures.push([classification, cause]),
            visibleNames: {},
            workspaceId: "T241OPENCODEIDFORMAT",
          });
          const result = yield* Effect.result(
            runTurn({
              application: stack.application,
              event: participantEvent({
                conversationId: "C241:opencode-id-format",
                participantIds: [],
                turn: 1,
              }),
              published,
            })
          );
          assert.strictEqual(result._tag, "Failure");
          assert.strictEqual(
            published.some((output) => "text" in output),
            false
          );
          assert.deepStrictEqual(formatFailures, [
            ["deterministic", "protocol_incompatible"],
          ]);
          assert.strictEqual(
            (yield* repository.load).conversations[0]?.prompts[0]?.attempts[0]
              ?.outcome,
            "protocol_failed"
          );
        })
      ),
    30_000
  );

  it.live(
    "poisons the agent after unexpected transport termination",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-241-transport-poison-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-241-transport-poison-controls-"
          );
          yield* Effect.promise(() =>
            writeFile(join(controls, "release"), "ok")
          );
          const repository = yield* makeFileApplicationRepository(
            join(controls, "application.json"),
            controls
          );
          const stack = yield* makeStack({
            controls,
            environment: { SCRIPTED_ACP_EXIT_AFTER_PROMPT_RECEIVED: "1" },
            repository,
            root,
            visibleNames: {},
            workspaceId: "T241TRANSPORT",
          });
          const first = yield* Effect.result(
            runTurn({
              application: stack.application,
              event: participantEvent({
                conversationId: "C241:transport",
                participantIds: [],
                turn: 1,
              }),
              published: [],
            })
          );
          const second = yield* Effect.result(
            runTurn({
              application: stack.application,
              event: participantEvent({
                conversationId: "C241:transport",
                participantIds: [],
                turn: 2,
              }),
              published: [],
            })
          );
          assert.strictEqual(first._tag, "Failure");
          assert.strictEqual(second._tag, "Failure");
          assert.strictEqual(
            (yield* readPrompts(join(controls, "prompts.jsonl"))).length,
            1
          );
        })
      ),
    30_000
  );

  it.live(
    "reaps the process when an interrupted prompt refuses to settle",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-241-unsettled-poison-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-241-unsettled-poison-controls-"
          );
          const repository = yield* makeFileApplicationRepository(
            join(controls, "application.json"),
            controls
          );
          const stack = yield* makeStack({
            childExitGraceMillis: 50,
            controls,
            environment: { SCRIPTED_ACP_IGNORE_PROMPT_CANCELLATION: "1" },
            repository,
            root,
            visibleNames: {},
            workspaceId: "T241UNSETTLED",
          });
          const running = yield* Effect.forkChild(
            runTurn({
              application: stack.application,
              event: participantEvent({
                conversationId: "C241:unsettled",
                participantIds: [],
                turn: 1,
              }),
              published: [],
            })
          );
          while (true) {
            const ready = yield* Effect.promise(async () => {
              try {
                return (await stat(join(controls, "ready"))).size > 0;
              } catch {
                return false;
              }
            });
            if (ready) {
              break;
            }
            yield* Effect.sleep("10 millis");
          }
          yield* Fiber.interrupt(running);
          const later = yield* Effect.result(
            runTurn({
              application: stack.application,
              event: participantEvent({
                conversationId: "C241:unsettled",
                participantIds: [],
                turn: 2,
              }),
              published: [],
            })
          );
          assert.strictEqual(later._tag, "Failure");
        })
      ),
    30_000
  );

  it.live(
    "finishes one shared poison cleanup after its first waiter is interrupted and scope shuts down",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-241-poison-cleanup-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-241-poison-cleanup-controls-"
          );
          const cleanupReleasePath = join(controls, "cleanup-release");
          const cleanupStartedPath = join(controls, "cleanup-started");
          const exitPath = join(controls, "exited");
          const lifecyclePath = join(controls, "lifecycle.log");
          const repository = yield* makeFileApplicationRepository(
            join(controls, "application.json"),
            controls
          );
          const agentScope = yield* Scope.make();
          yield* Effect.addFinalizer((exit) => Scope.close(agentScope, exit));
          const stack = yield* makeStack({
            childExitGraceMillis: 50,
            controls,
            environment: {
              SCRIPTED_ACP_EXIT_PATH: exitPath,
              SCRIPTED_ACP_IGNORE_PROMPT_CANCELLATION: "1",
              SCRIPTED_ACP_LIFECYCLE_LOG_PATH: lifecyclePath,
            },
            repository,
            root,
            testHooks: {
              afterProcessPoisoned: async () => {
                await writeFile(cleanupStartedPath, "started");
                await waitForPath(cleanupReleasePath);
              },
            },
            visibleNames: {},
            workspaceId: "T241POISONCLEANUP",
          }).pipe(Effect.provideService(Scope.Scope, agentScope));
          const running = yield* Effect.forkChild(
            runTurn({
              application: stack.application,
              event: participantEvent({
                conversationId: "C241:poison-cleanup",
                participantIds: [],
                turn: 1,
              }),
              published: [],
            })
          );
          yield* Effect.promise(() => waitForPath(join(controls, "ready")));
          const firstWaiter = yield* Effect.forkChild(Fiber.interrupt(running));
          yield* Effect.promise(() => waitForPath(cleanupStartedPath));
          yield* Fiber.interrupt(firstWaiter);

          const shutdown = yield* Scope.close(
            agentScope,
            Exit.succeed(undefined)
          ).pipe(Effect.forkChild);
          yield* Effect.sleep("50 millis");
          const exitedBeforeRelease = yield* Effect.promise(async () => {
            try {
              await stat(exitPath);
              return true;
            } catch {
              return false;
            }
          });
          assert.strictEqual(exitedBeforeRelease, false);
          yield* Effect.promise(() =>
            writeFile(cleanupReleasePath, "release", { mode: 0o600 })
          );
          yield* Fiber.join(shutdown);
          yield* Effect.promise(() => waitForPath(exitPath));
          const lifecycle = (yield* Effect.promise(() =>
            readFile(lifecyclePath, "utf8")
          ))
            .trim()
            .split("\n");
          assert.strictEqual(
            lifecycle.filter((entry) => entry === "stdio:closed").length,
            1
          );
        })
      ),
    30_000
  );

  it.live(
    "allows one concurrent binding CAS winner without losing either prompt",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const controls = yield* makeTempDirectoryScoped(
            "laborer-241-concurrent-cas-"
          );
          const snapshotPath = join(controls, "application.json");
          const seedRepository = yield* makeFileApplicationRepository(
            snapshotPath,
            controls
          );
          const seedApplication = yield* makeReferenceCodingApplication({
            conversationAgent: {
              handle: (request) => {
                const store = request.sessionBindingStore;
                if (store === undefined) {
                  return Effect.die(new Error("missing binding store"));
                }
                return store
                  .replace(null, {
                    ambiguousPromptId: null,
                    cwd: controls,
                    effectiveMetadata: null,
                    effectiveMetadataFingerprint: null,
                    initializationPhase: "initialized",
                    introducedParticipantIds: [],
                    pendingParticipantIds: [],
                    sessionId: "acp-seed-241",
                  })
                  .pipe(Effect.as([] as const));
              },
            },
            implementationAgent: {
              start: () =>
                Effect.die(new Error("Executions are outside this test")),
            },
            repository: seedRepository,
            worktreeManager: {
              create: () =>
                Effect.die(new Error("Actions are outside this test")),
            },
          });
          yield* runTurn({
            application: seedApplication,
            event: participantEvent({
              conversationId: "C241:cas",
              participantIds: [],
              turn: 1,
            }),
            published: [],
          });

          let arrivals = 0;
          let releaseCas: (() => void) | undefined;
          const bothReady = new Promise<void>((resolveReady) => {
            releaseCas = resolveReady;
          });
          const makeContender = Effect.fnUntraced(function* (
            sessionId: string
          ) {
            const repository = yield* makeFileApplicationRepository(
              snapshotPath,
              controls
            );
            return yield* makeReferenceCodingApplication({
              conversationAgent: {
                handle: (request) => {
                  const store = request.sessionBindingStore;
                  if (store === undefined) {
                    return Effect.die(new Error("missing binding store"));
                  }
                  return Effect.promise(async () => {
                    arrivals += 1;
                    if (arrivals === 2) {
                      releaseCas?.();
                    }
                    await bothReady;
                  }).pipe(
                    Effect.andThen(
                      store.replace(1, {
                        ambiguousPromptId: null,
                        cwd: controls,
                        effectiveMetadata: null,
                        effectiveMetadataFingerprint: null,
                        initializationPhase: "initialized",
                        introducedParticipantIds: [],
                        pendingParticipantIds: [],
                        sessionId,
                      })
                    ),
                    Effect.as([] as const)
                  );
                },
              },
              implementationAgent: {
                start: () =>
                  Effect.die(new Error("Executions are outside this test")),
              },
              repository,
              worktreeManager: {
                create: () =>
                  Effect.die(new Error("Actions are outside this test")),
              },
            });
          });
          const first = yield* makeContender("acp-cas-first-241");
          const second = yield* makeContender("acp-cas-second-241");
          const results = yield* Effect.all(
            [
              Effect.result(
                runTurn({
                  application: first,
                  event: participantEvent({
                    conversationId: "C241:cas",
                    participantIds: [],
                    turn: 2,
                  }),
                  published: [],
                })
              ),
              Effect.result(
                runTurn({
                  application: second,
                  event: participantEvent({
                    conversationId: "C241:cas",
                    participantIds: [],
                    turn: 3,
                  }),
                  published: [],
                })
              ),
            ],
            { concurrency: "unbounded" }
          );
          assert.deepStrictEqual(results.map(({ _tag }) => _tag).sort(), [
            "Failure",
            "Success",
          ]);
          const finalState = yield* (yield* makeFileApplicationRepository(
            snapshotPath,
            controls
          )).load;
          const finalConversation = finalState.conversations[0];
          assert.strictEqual(finalConversation?.prompts.length, 3);
          assert.strictEqual(
            finalConversation?.agentSessionBinding?.generation,
            2
          );
          assert.ok(
            ["acp-cas-first-241", "acp-cas-second-241"].includes(
              finalConversation?.agentSessionBinding?.sessionId ?? ""
            )
          );
        })
      ),
    30_000
  );

  it.live(
    "migrates schema v1 without treating its deterministic logical ID as an ACP binding",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const controls = yield* makeTempDirectoryScoped(
            "laborer-241-migration-"
          );
          const snapshot = join(controls, "application.json");
          yield* Effect.promise(() =>
            writeFile(
              snapshot,
              JSON.stringify({
                conversations: [
                  {
                    conversationId: "C241:legacy",
                    prompts: [],
                    sessionId: "ses_deterministic_logical_not_opaque",
                  },
                ],
                executions: [],
                schemaVersion: 1,
              })
            )
          );
          const repository = yield* makeFileApplicationRepository(
            snapshot,
            controls
          );
          const migrated = yield* repository.load;
          assert.strictEqual(migrated.schemaVersion, 16);
          assert.strictEqual(
            migrated.conversations[0]?.sessionId,
            "ses_deterministic_logical_not_opaque"
          );
          assert.strictEqual(
            migrated.conversations[0]?.agentSessionBinding,
            null
          );
        })
      )
  );

  it.live("migrates schema v2 bindings as completed initialization", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const controls = yield* makeTempDirectoryScoped(
          "laborer-241-v2-migration-"
        );
        const snapshot = join(controls, "application.json");
        yield* Effect.promise(() =>
          writeFile(
            snapshot,
            JSON.stringify({
              conversations: [
                {
                  agentSessionBinding: {
                    cwd: controls,
                    generation: 4,
                    introducedParticipantIds: ["U241LEGACY"],
                    sessionId: "acp-v2-session-241",
                  },
                  conversationId: "C241:v2",
                  prompts: [],
                  sessionId: "logical-v2-session-241",
                },
              ],
              executions: [],
              schemaVersion: 2,
            })
          )
        );
        const repository = yield* makeFileApplicationRepository(
          snapshot,
          controls
        );
        const migrated = yield* repository.load;
        assert.strictEqual(migrated.schemaVersion, 16);
        const migratedBinding = migrated.conversations[0]?.agentSessionBinding;
        assert.ok(migratedBinding !== null && migratedBinding !== undefined);
        assert.deepStrictEqual(
          { ...migratedBinding },
          {
            ambiguousPromptId: null,
            cwd: controls,
            cwdIdentity: null,
            effectiveMetadata: null,
            effectiveMetadataFingerprint: null,
            generation: 4,
            initializationPhase: "initialized",
            introducedParticipantIds: ["U241LEGACY"],
            lastAttachedProcessGeneration: 0,
            pendingParticipantIds: [],
            sessionId: "acp-v2-session-241",
          }
        );
      })
    )
  );

  it.live("migrates schema v3 bindings without inventing ambiguity", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const controls = yield* makeTempDirectoryScoped(
          "laborer-241-v3-migration-"
        );
        const snapshot = join(controls, "application.json");
        yield* Effect.promise(() =>
          writeFile(
            snapshot,
            JSON.stringify({
              conversations: [
                {
                  agentSessionBinding: {
                    cwd: controls,
                    generation: 5,
                    initializationPhase: "pending",
                    introducedParticipantIds: ["U241V3"],
                    pendingParticipantIds: ["U241V3PENDING"],
                    sessionId: "acp-v3-session-241",
                  },
                  conversationId: "C241:v3",
                  prompts: [],
                  sessionId: "logical-v3-session-241",
                },
              ],
              executions: [],
              schemaVersion: 3,
            })
          )
        );
        const repository = yield* makeFileApplicationRepository(
          snapshot,
          controls
        );
        const migrated = yield* repository.load;
        assert.strictEqual(migrated.schemaVersion, 16);
        assert.strictEqual(
          migrated.conversations[0]?.agentSessionBinding?.ambiguousPromptId,
          null
        );
        assert.strictEqual(
          migrated.conversations[0]?.agentSessionBinding?.initializationPhase,
          "pending"
        );
      })
    )
  );

  it.live(
    "keeps opaque IDs and participant sets isolated for workspaces sharing one root",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped("laborer-241-isolated-");
          const controls = yield* makeTempDirectoryScoped(
            "laborer-241-isolated-controls-"
          );
          const snapshotA = join(controls, "application-a.json");
          const snapshotB = join(controls, "application-b.json");
          const repositoryA = yield* makeFileApplicationRepository(
            snapshotA,
            controls
          );
          const repositoryB = yield* makeFileApplicationRepository(
            snapshotB,
            controls
          );
          yield* Effect.promise(() =>
            writeFile(join(controls, "release"), "ok")
          );
          const conversationId = "C241:same-logical-thread";
          for (const [repository, workspaceId, participantId] of [
            [repositoryA, "T241ISOLATEDA", "U241A"],
            [repositoryB, "T241ISOLATEDB", "U241B"],
          ] as const) {
            yield* Effect.scoped(
              Effect.gen(function* () {
                const stack = yield* makeStack({
                  controls,
                  repository,
                  root,
                  visibleNames: { [participantId]: participantId },
                  workspaceId,
                });
                yield* runTurn({
                  application: stack.application,
                  event: participantEvent({
                    conversationId,
                    participantIds: [participantId],
                    turn: 1,
                  }),
                  published: [],
                });
              })
            );
          }
          const firstA = (yield* repositoryA.load).conversations[0]
            ?.agentSessionBinding;
          const firstB = (yield* repositoryB.load).conversations[0]
            ?.agentSessionBinding;
          assert.ok(firstA !== null && firstA !== undefined);
          assert.ok(firstB !== null && firstB !== undefined);
          assert.notStrictEqual(firstA.sessionId, firstB.sessionId);
          assert.deepStrictEqual(firstA.introducedParticipantIds, ["U241A"]);
          assert.deepStrictEqual(firstB.introducedParticipantIds, ["U241B"]);

          for (const [snapshotPath, workspaceId, participantIds] of [
            [snapshotA, "T241ISOLATEDA", ["U241A", "U241A2"]],
            [snapshotB, "T241ISOLATEDB", ["U241B"]],
          ] as const) {
            const repository = yield* makeFileApplicationRepository(
              snapshotPath,
              controls
            );
            yield* Effect.scoped(
              Effect.gen(function* () {
                const stack = yield* makeStack({
                  controls,
                  repository,
                  root,
                  visibleNames: Object.fromEntries(
                    participantIds.map((participantId) => [
                      participantId,
                      participantId,
                    ])
                  ),
                  workspaceId,
                });
                yield* runTurn({
                  application: stack.application,
                  event: participantEvent({
                    conversationId,
                    participantIds,
                    turn: 2,
                  }),
                  published: [],
                });
              })
            );
          }
          const finalA = (yield* (yield* makeFileApplicationRepository(
            snapshotA,
            controls
          )).load).conversations[0]?.agentSessionBinding;
          const finalB = (yield* (yield* makeFileApplicationRepository(
            snapshotB,
            controls
          )).load).conversations[0]?.agentSessionBinding;
          assert.strictEqual(finalA?.sessionId, firstA.sessionId);
          assert.strictEqual(finalB?.sessionId, firstB.sessionId);
          assert.deepStrictEqual(finalA?.introducedParticipantIds, [
            "U241A",
            "U241A2",
          ]);
          assert.deepStrictEqual(finalB?.introducedParticipantIds, ["U241B"]);
          const methods = yield* readSessionMethods(
            join(controls, "methods.jsonl")
          );
          assert.deepStrictEqual(
            methods.map(({ method }) => method),
            ["session/new", "session/new", "session/resume", "session/resume"]
          );
          assert.strictEqual(methods[2]?.params.sessionId, firstA.sessionId);
          assert.strictEqual(methods[3]?.params.sessionId, firstB.sessionId);
        })
      ),
    40_000
  );

  it.live(
    "never prompts when binding or participant durability fails",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          for (const failurePoint of ["binding", "participants"] as const) {
            const root = yield* makeTempDirectoryScoped(
              `laborer-241-order-${failurePoint}-`
            );
            const controls = yield* makeTempDirectoryScoped(
              `laborer-241-order-${failurePoint}-controls-`
            );
            const snapshotPath = join(controls, "application.json");
            let failed = false;
            let failuresEnabled = false;
            const repository = yield* makeFileApplicationRepository(
              snapshotPath,
              controls,
              {
                afterRename: async () => {
                  if (!failuresEnabled || failed) {
                    return;
                  }
                  const state = JSON.parse(
                    await readFile(snapshotPath, "utf8")
                  ) as {
                    readonly conversations?: readonly {
                      readonly agentSessionBinding?: {
                        readonly initializationPhase?: string;
                        readonly pendingParticipantIds?: readonly string[];
                      } | null;
                    }[];
                  };
                  const binding = state.conversations?.[0]?.agentSessionBinding;
                  const shouldFail =
                    binding !== null &&
                    binding !== undefined &&
                    (failurePoint === "binding"
                      ? binding.initializationPhase === "pending"
                      : binding.initializationPhase === "submitting" &&
                        (binding.pendingParticipantIds?.length ?? 0) > 0);
                  if (shouldFail) {
                    failed = true;
                    throw new Error("injected post-rename durability failure");
                  }
                },
              }
            );
            failuresEnabled = true;
            yield* Effect.promise(() =>
              writeFile(join(controls, "release"), "ok")
            );
            const result = yield* Effect.scoped(
              Effect.gen(function* () {
                const stack = yield* makeStack({
                  controls,
                  repository,
                  root,
                  visibleNames: { U241ORDER: "Order Person" },
                  workspaceId: `T241ORDER${failurePoint}`,
                });
                return yield* Effect.result(
                  runTurn({
                    application: stack.application,
                    event: participantEvent({
                      conversationId: `C241:order:${failurePoint}`,
                      participantIds: ["U241ORDER"],
                      turn: 1,
                    }),
                    published: [],
                  })
                );
              })
            );
            assert.strictEqual(result._tag, "Failure");
            const promptPath = join(controls, "prompts.jsonl");
            const promptExists = yield* Effect.promise(async () => {
              try {
                return (await stat(promptPath)).size > 0;
              } catch {
                return false;
              }
            });
            assert.strictEqual(promptExists, false);
          }
        })
      ),
    30_000
  );

  for (const boundary of ["staged", "running"] as const) {
    it.live(
      `does not call ACP when the ${boundary} prompt boundary has a directory-sync failure`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const root = yield* makeTempDirectoryScoped(
              `laborer-241-${boundary}-sync-`
            );
            const controls = yield* makeTempDirectoryScoped(
              `laborer-241-${boundary}-sync-controls-`
            );
            const snapshotPath = join(controls, "application.json");
            let failuresEnabled = false;
            let injected = false;
            const repository = yield* makeFileApplicationRepository(
              snapshotPath,
              controls,
              {
                beforeDirectorySync: async () => {
                  if (!failuresEnabled || injected) {
                    return;
                  }
                  const snapshot = JSON.parse(
                    await readFile(snapshotPath, "utf8")
                  ) as {
                    readonly conversations?: readonly {
                      readonly prompts?: readonly {
                        readonly status?: string;
                      }[];
                    }[];
                  };
                  const status =
                    snapshot.conversations?.[0]?.prompts?.[0]?.status;
                  if (status === boundary) {
                    injected = true;
                    throw new Error("injected directory-sync boundary failure");
                  }
                },
              }
            );
            failuresEnabled = true;
            yield* Effect.promise(() =>
              writeFile(join(controls, "release"), "ok")
            );
            const event = participantEvent({
              conversationId: `C241:${boundary}-sync`,
              participantIds: [],
              turn: 1,
            });
            const result = yield* Effect.scoped(
              Effect.gen(function* () {
                const stack = yield* makeStack({
                  controls,
                  repository,
                  root,
                  visibleNames: {},
                  workspaceId: `T241${boundary}SYNC`,
                });
                return yield* Effect.result(
                  runTurn({
                    application: stack.application,
                    event,
                    published: [],
                  })
                );
              })
            );
            assert.strictEqual(result._tag, "Failure");
            assert.strictEqual(injected, true);
            const promptExists = yield* Effect.promise(async () => {
              try {
                return (await stat(join(controls, "prompts.jsonl"))).size > 0;
              } catch {
                return false;
              }
            });
            assert.strictEqual(promptExists, false);

            const restartedRepository = yield* makeFileApplicationRepository(
              snapshotPath,
              controls
            );
            yield* Effect.scoped(
              Effect.gen(function* () {
                const stack = yield* makeStack({
                  controls,
                  repository: restartedRepository,
                  root,
                  visibleNames: {},
                  workspaceId: `T241${boundary}SYNC`,
                });
                assert.ok(stack.application.recover);
                yield* stack.application.recover(acceptEvent);
              })
            );
            const promptExistsAfterRestart = yield* Effect.promise(async () => {
              try {
                return (await stat(join(controls, "prompts.jsonl"))).size > 0;
              } catch {
                return false;
              }
            });
            assert.strictEqual(promptExistsAfterRestart, false);
          })
        ),
      30_000
    );
  }
}, 30_000);
