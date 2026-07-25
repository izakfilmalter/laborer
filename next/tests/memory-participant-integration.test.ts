import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Array as EffectArray, Logger } from "effect";
import { makeAcpConversationAgent } from "../src/acp-conversation-prototype/acp-conversation-agent.ts";
import {
  prepareAcpAgentContextSources,
  userProfilePath,
} from "../src/acp-conversation-prototype/agent-context.ts";
import { makeLaborerMemoryStore } from "../src/acp-conversation-prototype/memory-mcp.ts";
import {
  makeBoundedSlackParticipantLookup,
  makeSlackParticipantLookup,
  SLACK_PARTICIPANT_LOOKUP_WORKSPACE_CONCURRENCY_LIMIT,
} from "../src/acp-conversation-prototype/slack-participant-lookup.ts";
import { MessageId, NormalizedMessage } from "../src/prototype/domain.ts";
import type { ConversationAgentRequest } from "../src/reference-coding-application.ts";
import { makeTempDirectoryScoped } from "./support/temp-directory.ts";

const projectRoot = process.cwd();
const scriptedPeerPath = resolve(
  projectRoot,
  "tests/fixtures/scripted-acp-peer.ts"
);

const requestWithAuthors = (options: {
  readonly contextAuthors?: readonly string[];
  readonly conversationId: string;
  readonly inputAuthors: readonly string[];
  readonly promptId: string;
}): ConversationAgentRequest => {
  const makeMessage = (
    authorSlackId: string,
    classification: "context" | "input",
    index: number
  ) =>
    NormalizedMessage.make({
      authorKind: authorSlackId.startsWith("B") ? "externalBot" : "human",
      authorSlackId,
      classification,
      id: MessageId.make(`${options.promptId}:${classification}:${index}`),
      isActivation: classification === "input" && index === 0,
      slackTs: `240.${classification === "context" ? "0" : "1"}${index}`,
      text: `${classification} from ${authorSlackId}`,
    });
  const context = (options.contextAuthors ?? []).map((author, index) =>
    makeMessage(author, "context", index)
  );
  const messages = options.inputAuthors.map((author, index) =>
    makeMessage(author, "input", index)
  );
  return {
    actions: [],
    context,
    conversationId: options.conversationId,
    conversationSessionId: `logical:${options.conversationId}`,
    conversationSessionIsNew: options.promptId === "prompt:one",
    executionControls: [],
    executions: [],
    input: [...context, ...messages].map((message) => message.text).join("\n"),
    messages,
    promptId: options.promptId,
    source: "slack",
    turnId: `turn:${options.promptId}`,
  };
};

const readPrompts = async (
  path: string
): Promise<
  readonly { readonly prompt: string; readonly sessionId: string }[]
> =>
  (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map(
      (line) =>
        JSON.parse(line) as {
          readonly prompt: string;
          readonly sessionId: string;
        }
    );

describe("issue #240 integration with participant context", () => {
  it("requests users:read without requesting users:read.email", async () => {
    const manifest = await readFile(
      resolve(projectRoot, "slack-app-manifest.yaml"),
      "utf8"
    );
    assert.ok(manifest.includes("      - users:read\n"));
    assert.ok(!manifest.includes("users:read.email"));
  });

  it.effect(
    "sanitizes XML-invalid visible names and falls back deterministically",
    () =>
      Effect.gen(function* () {
        const lookup = makeSlackParticipantLookup({
          users: {
            info: () =>
              Promise.resolve({
                user: {
                  profile: {
                    display_name: '\u0000Visible " & < 😀\uD800name',
                    real_name: "ignored",
                  },
                },
              }),
          },
        });
        assert.strictEqual(
          yield* lookup.lookupVisibleName("U240XMLSAFE"),
          'Visible " & < 😀name'
        );

        const fallback = makeSlackParticipantLookup({
          users: {
            info: () => Promise.reject(new Error("PRIVATE LOOKUP FAILURE")),
          },
        });
        const warnings: string[] = [];
        const logger = Logger.make<unknown, void>((options) => {
          if (options.logLevel === "Warn") {
            warnings.push(String(options.message));
          }
        });
        assert.strictEqual(
          yield* fallback
            .lookupVisibleName("U240FALLBACK")
            .pipe(Effect.provide(Logger.layer([logger]))),
          "U240FALLBACK"
        );
        assert.ok(!warnings.join("\n").includes("PRIVATE LOOKUP FAILURE"));
      })
  );

  it.live(
    "bounds workspace lookup concurrency and includes semaphore wait in the deadline",
    () =>
      Effect.gen(function* () {
        let inFlight = 0;
        let maximumInFlight = 0;
        let started = 0;
        const lookup = makeBoundedSlackParticipantLookup({
          fetch: (_url, request) =>
            new Promise<never>((_resolve, reject) => {
              started += 1;
              inFlight += 1;
              maximumInFlight = Math.max(maximumInFlight, inFlight);
              const signal = request?.signal;
              if (signal === undefined) {
                reject(new Error("missing signal"));
                return;
              }
              signal.addEventListener(
                "abort",
                () => {
                  inFlight -= 1;
                  reject(new Error("PRIVATE ABORT"));
                },
                { once: true }
              );
            }),
          requestTimeoutMillis: 1000,
          slackApiUrl: "https://slack.invalid/api/",
          token: "test-token",
          usersInfoTimeoutMillis: 150,
        });
        const userIds = Array.from(
          {
            length: SLACK_PARTICIPANT_LOOKUP_WORKSPACE_CONCURRENCY_LIMIT + 3,
          },
          (_, index) => `U240WAIT${index}`
        );
        const results = yield* Effect.all(
          userIds.map((userId) => lookup.lookupVisibleName(userId)),
          { concurrency: "unbounded" }
        );
        assert.deepStrictEqual(results, userIds);
        assert.strictEqual(
          started,
          SLACK_PARTICIPANT_LOOKUP_WORKSPACE_CONCURRENCY_LIMIT
        );
        assert.strictEqual(
          maximumInFlight,
          SLACK_PARTICIPANT_LOOKUP_WORKSPACE_CONCURRENCY_LIMIT
        );
        assert.strictEqual(inFlight, 0);
      })
  );

  it.live(
    "introduces initial and late humans exactly once and observes a profile written before the late introduction",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-participant-memory-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-participant-memory-controls-"
          );
          const promptPath = resolve(controls, "prompts.jsonl");
          const releasePath = resolve(controls, "release");
          yield* Effect.promise(() => writeFile(releasePath, "release"));
          const sources = yield* prepareAcpAgentContextSources({
            root,
            workspaceId: "T240-PARTICIPANTS",
          });
          const lookupCalls: string[] = [];
          const agent = yield* makeAcpConversationAgent({
            agentContext: sources,
            args: [scriptedPeerPath],
            command: process.execPath,
            cwd: root,
            environment: {
              ...process.env,
              SCRIPTED_ACP_PROMPT_JSONL_PATH: promptPath,
              SCRIPTED_ACP_READY_PATH: resolve(controls, "ready"),
              SCRIPTED_ACP_RELEASE_PATH: releasePath,
            },
            laborerSlackId: "U240LABORER",
            participantLookup: {
              lookupVisibleName: (slackUserId) =>
                Effect.sync(() => {
                  lookupCalls.push(slackUserId);
                  return `Name ${slackUserId}`;
                }),
            },
          });

          yield* agent.handle(
            requestWithAuthors({
              contextAuthors: ["U240HISTORY"],
              conversationId: "conversation:participants",
              inputAuthors: ["U240INITIAL", "B240EXTERNAL", "U240LABORER"],
              promptId: "prompt:one",
            }),
            () => Effect.void
          );
          assert.strictEqual(
            yield* Effect.promise(() =>
              stat(userProfilePath(sources, "U240INITIAL")).then(
                () => true,
                () => false
              )
            ),
            false
          );

          const store = yield* makeLaborerMemoryStore({
            root,
            workspaceId: "T240-PARTICIPANTS",
          });
          yield* store.mutate({
            operation: "add",
            target: "user",
            text: "Prefers concise late-thread summaries.",
            userId: "U240LATE00",
          });
          yield* agent.handle(
            requestWithAuthors({
              conversationId: "conversation:participants",
              inputAuthors: ["U240LATE00"],
              promptId: "prompt:two",
            }),
            () => Effect.void
          );
          yield* agent.handle(
            requestWithAuthors({
              conversationId: "conversation:participants",
              inputAuthors: ["U240LATE00"],
              promptId: "prompt:three",
            }),
            () => Effect.void
          );

          const prompts = yield* Effect.promise(() => readPrompts(promptPath));
          assert.strictEqual(prompts.length, 3);
          const firstPrompt = prompts[0]?.prompt ?? "";
          const latePrompt = prompts[1]?.prompt ?? "";
          const repeatPrompt = prompts[2]?.prompt ?? "";
          assert.ok(
            firstPrompt.indexOf('slack-user-id="U240HISTORY"') <
              firstPrompt.indexOf('slack-user-id="U240INITIAL"')
          );
          assert.ok(!firstPrompt.includes('slack-user-id="B240EXTERNAL"'));
          assert.ok(!firstPrompt.includes('slack-user-id="U240LABORER"'));
          assert.ok(
            latePrompt.indexOf('slack-user-id="U240LATE00"') <
              latePrompt.indexOf("input from U240LATE00")
          );
          assert.ok(
            latePrompt.includes("Prefers concise late-thread summaries.")
          );
          assert.ok(!repeatPrompt.includes('slack-user-id="U240LATE00"'));
          assert.ok(!repeatPrompt.includes("Prefers concise late-thread"));
          assert.deepStrictEqual(lookupCalls, [
            "U240HISTORY",
            "U240INITIAL",
            "U240LATE00",
          ]);
        })
      ),
    20_000
  );

  it.live(
    "enriches every human in a prompt while keeping every identity",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-participant-budget-"
          );
          const controls = yield* makeTempDirectoryScoped(
            "laborer-participant-budget-controls-"
          );
          const promptPath = resolve(controls, "prompts.jsonl");
          const releasePath = resolve(controls, "release");
          yield* Effect.promise(() => writeFile(releasePath, "release"));
          const sources = yield* prepareAcpAgentContextSources({
            root,
            workspaceId: "T240-PARTICIPANT-BUDGET",
          });
          const participantIds = Array.from(
            { length: 20 },
            (_, index) => `U240BUDGET${String(index).padStart(2, "0")}`
          );
          const lookedUp: string[] = [];
          const agent = yield* makeAcpConversationAgent({
            agentContext: sources,
            args: [scriptedPeerPath],
            command: process.execPath,
            cwd: root,
            environment: {
              ...process.env,
              SCRIPTED_ACP_PROMPT_JSONL_PATH: promptPath,
              SCRIPTED_ACP_READY_PATH: resolve(controls, "ready"),
              SCRIPTED_ACP_RELEASE_PATH: releasePath,
            },
            participantLookup: {
              lookupVisibleName: (slackUserId) =>
                Effect.sync(() => {
                  lookedUp.push(slackUserId);
                  return `Resolved ${slackUserId}`;
                }),
            },
          });
          yield* agent.handle(
            requestWithAuthors({
              conversationId: "conversation:budget",
              inputAuthors: participantIds,
              promptId: "prompt:one",
            }),
            () => Effect.void
          );
          assert.deepStrictEqual(lookedUp, participantIds);
          const prompt = (yield* Effect.promise(() =>
            readPrompts(promptPath)
          ))[0]?.prompt;
          assert.ok(prompt !== undefined);
          assert.ok(
            EffectArray.every(participantIds, (participantId) =>
              prompt.includes(`slack-user-id="${participantId}"`)
            )
          );
        })
      ),
    20_000
  );
});
