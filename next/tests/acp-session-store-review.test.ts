import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { prepareAcpAgentContextSources } from "../src/acp-conversation-prototype/agent-context.ts";
import { makeConversationSessionStore } from "../src/acp-conversation-prototype/conversation-session-store.ts";
import { makeTempDirectoryScoped } from "./support/temp-directory.ts";

interface ConversationRecord {
  readonly conversationId: string;
  readonly cwd: string;
  readonly inFlightPromptId: string | null;
  readonly initialContextSubmitted: boolean;
  readonly introducedParticipantIds: readonly string[];
  readonly sessionId: string;
  readonly suppressedPromptId: string | null;
}

const conversation = (options: {
  readonly conversationId: string;
  readonly cwd: string;
  readonly sessionId: string;
}): ConversationRecord => ({
  ...options,
  inFlightPromptId: null,
  initialContextSubmitted: true,
  introducedParticipantIds: [],
  suppressedPromptId: null,
});

const state = (...conversations: readonly ConversationRecord[]) =>
  JSON.stringify({ conversations, schemaVersion: 1 });

describe("issue #241 reviewed conversation session persistence", () => {
  it.effect("classifies fatal UTF-8 persisted bytes as state corruption", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped(
          "laborer-acp-store-invalid-utf8-"
        );
        const sources = yield* prepareAcpAgentContextSources({
          root,
          workspaceId: "T241STOREUTF8",
        });
        yield* Effect.promise(() =>
          writeFile(sources.acpConversationStatePath, Buffer.from([0xc3, 0x28]))
        );
        const loaded = yield* Effect.result(
          makeConversationSessionStore({
            expectedCwd: root,
            sources,
          })
        );
        assert.strictEqual(loaded._tag, "Failure");
        if (loaded._tag === "Failure") {
          assert.strictEqual(loaded.failure.reason, "state-corrupt");
        }
        const diagnostics = yield* Effect.promise(() =>
          readFile(sources.acpConversationDiagnosticsPath, "utf8")
        );
        assert.ok(diagnostics.endsWith(" state-corrupt\n"));
        assert.ok(!diagnostics.includes("storage-unavailable"));
      })
    )
  );

  it.effect(
    "rejects unreachable prompt and initial-context state combinations",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-acp-store-invariants-"
          );
          const sources = yield* prepareAcpAgentContextSources({
            root,
            workspaceId: "T241STOREINVARIANTS",
          });
          const base = conversation({
            conversationId: "conversation:invariants",
            cwd: root,
            sessionId: "session-invariants-241",
          });
          const invalid = [
            {
              ...base,
              inFlightPromptId: "prompt:in-flight",
              suppressedPromptId: "prompt:suppressed",
            },
            {
              ...base,
              initialContextSubmitted: false,
              introducedParticipantIds: ["U241INTRODUCED"],
            },
            {
              ...base,
              inFlightPromptId: "prompt:in-flight",
              initialContextSubmitted: false,
            },
            {
              ...base,
              initialContextSubmitted: false,
              suppressedPromptId: "prompt:suppressed",
            },
          ];
          for (const candidate of invalid) {
            yield* Effect.promise(() =>
              writeFile(sources.acpConversationStatePath, state(candidate))
            );
            const loaded = yield* Effect.result(
              makeConversationSessionStore({
                expectedCwd: root,
                sources,
              })
            );
            assert.strictEqual(loaded._tag, "Failure");
            if (loaded._tag === "Failure") {
              assert.strictEqual(loaded.failure.reason, "state-corrupt");
            }
          }
        })
      )
  );

  it.effect(
    "rejects duplicate durable session IDs and isolates corruption between workspaces sharing a root",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-acp-store-duplicate-"
          );
          const first = yield* prepareAcpAgentContextSources({
            root,
            workspaceId: "T241STOREA",
          });
          const second = yield* prepareAcpAgentContextSources({
            root,
            workspaceId: "T241STOREB",
          });
          yield* Effect.promise(() =>
            writeFile(
              first.acpConversationStatePath,
              state(
                conversation({
                  conversationId: "conversation:first",
                  cwd: root,
                  sessionId: "duplicate-session-241",
                }),
                conversation({
                  conversationId: "conversation:second",
                  cwd: root,
                  sessionId: "duplicate-session-241",
                })
              )
            )
          );

          const corrupt = yield* Effect.result(
            makeConversationSessionStore({
              expectedCwd: root,
              sources: first,
            })
          );
          assert.strictEqual(corrupt._tag, "Failure");
          if (corrupt._tag === "Failure") {
            assert.strictEqual(corrupt.failure.reason, "state-corrupt");
          }
          const isolated = yield* makeConversationSessionStore({
            expectedCwd: root,
            sources: second,
          });
          const wrongRuntimeCwd = yield* Effect.result(
            isolated.replaceSession({
              conversationId: "conversation:wrong-cwd",
              cwd: `${root}/child/..`,
              sessionId: "wrong-cwd-session-241",
            })
          );
          assert.strictEqual(wrongRuntimeCwd._tag, "Failure");
          yield* isolated.replaceSession({
            conversationId: "conversation:isolated",
            cwd: root,
            sessionId: "isolated-session-241",
          });
          assert.strictEqual(
            (yield* isolated.get("conversation:isolated"))?.sessionId,
            "isolated-session-241"
          );
          assert.notStrictEqual(
            first.acpConversationStatePath,
            second.acpConversationStatePath
          );
        })
      )
  );

  it.effect(
    "rejects unrelated, traversal, and symlink-alias persisted cwd values before resume",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped("laborer-acp-store-cwd-");
          const unrelated = yield* makeTempDirectoryScoped(
            "laborer-acp-store-cwd-other-"
          );
          const alias = join(unrelated, "root-alias");
          yield* Effect.promise(() => symlink(root, alias));
          const sources = yield* prepareAcpAgentContextSources({
            root,
            workspaceId: "T241STORECWD",
          });
          for (const persistedCwd of [unrelated, `${root}/child/..`, alias]) {
            yield* Effect.promise(() =>
              writeFile(
                sources.acpConversationStatePath,
                state(
                  conversation({
                    conversationId: "conversation:cwd",
                    cwd: persistedCwd,
                    sessionId: "session-cwd-241",
                  })
                )
              )
            );
            const loaded = yield* Effect.result(
              makeConversationSessionStore({
                expectedCwd: root,
                sources,
              })
            );
            assert.strictEqual(loaded._tag, "Failure");
            if (loaded._tag === "Failure") {
              assert.strictEqual(loaded.failure.reason, "state-corrupt");
            }
          }
        })
      )
  );

  it.live(
    "commits the in-memory state when interrupted after atomic rename",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-acp-store-interrupt-"
          );
          const sources = yield* prepareAcpAgentContextSources({
            root,
            workspaceId: "T241STOREINTERRUPT",
          });
          let releaseRename: (() => void) | undefined;
          let renamed: (() => void) | undefined;
          const renamedPromise = new Promise<void>((resolveRenamed) => {
            renamed = resolveRenamed;
          });
          const releasePromise = new Promise<void>((resolveRelease) => {
            releaseRename = resolveRelease;
          });
          const store = yield* makeConversationSessionStore({
            expectedCwd: root,
            sources,
            testHooks: {
              afterRename: async () => {
                renamed?.();
                await releasePromise;
              },
            },
          });
          const mutation = yield* Effect.forkChild(
            store.replaceSession({
              conversationId: "conversation:interrupt",
              cwd: root,
              sessionId: "session-interrupt-241",
            })
          );
          yield* Effect.promise(() => renamedPromise);
          const interruption = yield* Effect.forkChild(
            Fiber.interrupt(mutation)
          );
          releaseRename?.();
          yield* Fiber.join(interruption);

          assert.strictEqual(
            (yield* store.get("conversation:interrupt"))?.sessionId,
            "session-interrupt-241"
          );
          const disk = JSON.parse(
            yield* Effect.promise(() =>
              readFile(sources.acpConversationStatePath, "utf8")
            )
          ) as {
            readonly conversations: readonly { readonly sessionId: string }[];
          };
          assert.strictEqual(
            disk.conversations[0]?.sessionId,
            "session-interrupt-241"
          );
        })
      ),
    10_000
  );

  it.effect(
    "records exactly one distinct diagnostic for malformed versus inaccessible state",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-acp-store-diagnostics-"
          );
          const malformed = yield* prepareAcpAgentContextSources({
            root,
            workspaceId: "T241STOREMALFORMED",
          });
          yield* Effect.promise(() =>
            writeFile(malformed.acpConversationStatePath, "not-json")
          );
          yield* Effect.result(
            makeConversationSessionStore({
              expectedCwd: root,
              sources: malformed,
            })
          );
          const malformedDiagnostics = (yield* Effect.promise(() =>
            readFile(malformed.acpConversationDiagnosticsPath, "utf8")
          ))
            .trim()
            .split("\n");
          assert.strictEqual(malformedDiagnostics.length, 1);
          assert.ok(malformedDiagnostics[0]?.endsWith(" state-corrupt"));

          const inaccessible = yield* prepareAcpAgentContextSources({
            root,
            workspaceId: "T241STOREINACCESSIBLE",
          });
          yield* makeConversationSessionStore({
            expectedCwd: root,
            sources: inaccessible,
          });
          yield* Effect.promise(async () => {
            await rm(inaccessible.acpConversationStatePath);
            await mkdir(inaccessible.acpConversationStatePath);
          });
          yield* Effect.result(
            makeConversationSessionStore({
              expectedCwd: root,
              sources: inaccessible,
            })
          );
          const inaccessibleDiagnostics = (yield* Effect.promise(() =>
            readFile(inaccessible.acpConversationDiagnosticsPath, "utf8")
          ))
            .trim()
            .split("\n");
          assert.strictEqual(inaccessibleDiagnostics.length, 1);
          assert.ok(
            inaccessibleDiagnostics[0]?.endsWith(" storage-unavailable")
          );
        })
      )
  );
});
