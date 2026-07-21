/** Behavioral proof for the THROWAWAY per-thread initializer prototype. */

import { execFile } from "node:child_process";
import {
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";
import { startEmulatedSlack } from "../src/prototype/emulated-slack.ts";
import { HandlerFailure } from "../src/prototype/errors.ts";
import {
  makeProcessHandler,
  makeProcessInitializer,
} from "../src/prototype/process-handler.ts";
import {
  makePrototypeHarness,
  ThreadInitializer,
  WorkHandler,
} from "../src/prototype/runtime.ts";
import {
  LABORER_SLACK_ID,
  normalizedEvent,
  postHumanMessage,
  timestampOf,
} from "../src/prototype/scenario.ts";
import { makeFileStoreLayer } from "../src/prototype/store.ts";
import { makeTempDirectoryScoped } from "./support/temp-directory.ts";

const execFilePromise = promisify(execFile);

describe("per-thread initializer", () => {
  it.live("initializes once and reuses the directory for follow-up turns", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const workingDirectory = yield* makeTempDirectoryScoped(
          "laborer-initialized-thread-"
        );
        const canonicalWorkingDirectory = yield* Effect.promise(() =>
          realpath(workingDirectory)
        );
        const initializationCalls = yield* Ref.make<readonly string[]>([]);
        const handlerDirectories = yield* Ref.make<readonly string[]>([]);
        const slack = yield* startEmulatedSlack();
        const harness = yield* makePrototypeHarness({
          handler: WorkHandler.of({
            invoke: (turn) =>
              turn.workingDirectory === null
                ? Effect.die("initialized turn has no working directory")
                : Ref.update(handlerDirectories, (values) => [
                    ...values,
                    turn.workingDirectory as string,
                  ]),
          }),
          initializer: ThreadInitializer.of({
            initialize: (turn) =>
              Ref.update(initializationCalls, (values) => [
                ...values,
                turn.id,
              ]).pipe(Effect.as(canonicalWorkingDirectory)),
          }),
          laborerSlackId: LABORER_SLACK_ID,
          slack: slack.gateway,
        });

        const activation = yield* postHumanMessage(
          slack,
          `<@${LABORER_SLACK_ID}> initialize this thread`
        );
        const rootTs = timestampOf(activation);
        yield* harness.runner.inject(
          normalizedEvent({
            authorSlackId: slack.humanUserId,
            channelId: slack.channelId,
            eventId: "event:initializer:activation",
            messageTs: rootTs,
            text: `<@${LABORER_SLACK_ID}> initialize this thread`,
          })
        );

        const followUp = yield* postHumanMessage(slack, "continue there", {
          threadTs: rootTs,
        });
        yield* harness.runner.inject(
          normalizedEvent({
            authorSlackId: slack.humanUserId,
            channelId: slack.channelId,
            eventId: "event:initializer:follow-up",
            messageTs: timestampOf(followUp),
            text: "continue there",
            threadTs: rootTs,
          })
        );

        assert.strictEqual((yield* Ref.get(initializationCalls)).length, 1);
        assert.deepStrictEqual(yield* Ref.get(handlerDirectories), [
          canonicalWorkingDirectory,
          canonicalWorkingDirectory,
        ]);
      })
    )
  );

  it.live("runs the configured initializer before the handler process", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped(
          "laborer-process-initializer-"
        );
        const workingDirectory = yield* makeTempDirectoryScoped(
          "laborer-process-working-directory-"
        );
        const canonicalWorkingDirectory = yield* Effect.promise(() =>
          realpath(workingDirectory)
        );
        const processFixture = resolve(
          "tests/fixtures/thread-initializer-process.ts"
        );
        const initializer = yield* makeProcessInitializer({
          args: [processFixture],
          command: process.execPath,
          cwd: process.cwd(),
          environment: {
            PATH: process.env.PATH,
            THREAD_PROCESS_MODE: "initialize",
            THREAD_WORKING_DIRECTORY: canonicalWorkingDirectory,
          },
          evidence: { mode: "fixture" },
          stateRoot: join(root, "state"),
          stateRootAnchor: root,
        });
        const handler = yield* makeProcessHandler({
          args: [processFixture],
          command: process.execPath,
          cwd: process.cwd(),
          environment: {
            PATH: process.env.PATH,
            THREAD_PROCESS_MODE: "handler",
          },
          evidence: { mode: "fixture" },
          stateRoot: join(root, "state"),
          stateRootAnchor: root,
        });
        const slack = yield* startEmulatedSlack();
        const harness = yield* makePrototypeHarness({
          handler: handler.handler,
          initializer: initializer.initializer,
          laborerSlackId: LABORER_SLACK_ID,
          slack: slack.gateway,
        });

        const activation = yield* postHumanMessage(
          slack,
          `<@${LABORER_SLACK_ID}> run in a workspace`
        );
        const rootTs = timestampOf(activation);
        yield* harness.runner.inject(
          normalizedEvent({
            authorSlackId: slack.humanUserId,
            channelId: slack.channelId,
            eventId: "event:process-initializer",
            messageTs: rootTs,
            text: `<@${LABORER_SLACK_ID}> run in a workspace`,
          })
        );

        const replies = yield* Effect.promise(() =>
          slack.botClient.conversations.replies({
            channel: slack.channelId,
            ts: rootTs,
          })
        );
        const texts = (replies.messages ?? []).flatMap((message) =>
          typeof message.text === "string" ? [message.text] : []
        );
        const initializerReplyIndex = texts.indexOf(
          "Preparing the thread workspace."
        );
        const handlerReplyIndex = texts.indexOf(
          `Handler cwd: ${canonicalWorkingDirectory}`
        );
        assert.ok(initializerReplyIndex >= 0);
        assert.ok(handlerReplyIndex > initializerReplyIndex);
        const initializerEvidence = yield* initializer.snapshot;
        const handlerEvidence = yield* handler.snapshot;
        assert.deepStrictEqual(
          initializerEvidence.invocations[0]?.envelope,
          handlerEvidence.invocations[0]?.envelope
        );
      })
    )
  );

  it.live(
    "retries an interrupted initialization without starting the handler",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const workingDirectory = yield* makeTempDirectoryScoped(
            "laborer-retried-initializer-"
          );
          const canonicalWorkingDirectory = yield* Effect.promise(() =>
            realpath(workingDirectory)
          );
          const attempts = yield* Ref.make(0);
          const handlerInvocations = yield* Ref.make(0);
          const slack = yield* startEmulatedSlack();
          const harness = yield* makePrototypeHarness({
            handler: WorkHandler.of({
              invoke: () =>
                Ref.update(handlerInvocations, (count) => count + 1),
            }),
            initializer: ThreadInitializer.of({
              initialize: () =>
                Ref.updateAndGet(attempts, (count) => count + 1).pipe(
                  Effect.flatMap((attempt) =>
                    attempt === 1
                      ? HandlerFailure.make({
                          category: "signal",
                          safeDetail: null,
                        })
                      : Effect.succeed(canonicalWorkingDirectory)
                  )
                ),
            }),
            laborerSlackId: LABORER_SLACK_ID,
            slack: slack.gateway,
          });

          const activation = yield* postHumanMessage(
            slack,
            `<@${LABORER_SLACK_ID}> retry setup`
          );
          const rootTs = timestampOf(activation);
          const decision = yield* harness.runner.inject(
            normalizedEvent({
              authorSlackId: slack.humanUserId,
              channelId: slack.channelId,
              eventId: "event:retry-initializer",
              messageTs: rootTs,
              text: `<@${LABORER_SLACK_ID}> retry setup`,
            })
          );
          assert.strictEqual(yield* Ref.get(attempts), 1);
          assert.strictEqual(yield* Ref.get(handlerInvocations), 0);
          assert.strictEqual(decision._tag, "Accepted");
          if (decision._tag !== "Accepted") {
            return;
          }

          yield* harness.runner.retryInterrupted(decision.threadId);

          assert.strictEqual(yield* Ref.get(attempts), 2);
          assert.strictEqual(yield* Ref.get(handlerInvocations), 1);
          const state = yield* harness.store.snapshot;
          assert.strictEqual(
            state.threads[0]?.workingDirectory,
            canonicalWorkingDirectory
          );
        })
      )
  );

  it.live(
    "reports a known initialization failure without running the handler",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const handlerInvocations = yield* Ref.make(0);
          const slack = yield* startEmulatedSlack();
          const harness = yield* makePrototypeHarness({
            handler: WorkHandler.of({
              invoke: () =>
                Ref.update(handlerInvocations, (count) => count + 1),
            }),
            initializer: ThreadInitializer.of({
              initialize: () =>
                HandlerFailure.make({
                  category: "exit",
                  safeDetail: "exit code 1",
                }),
            }),
            laborerSlackId: LABORER_SLACK_ID,
            slack: slack.gateway,
          });
          const activation = yield* postHumanMessage(
            slack,
            `<@${LABORER_SLACK_ID}> fail setup`
          );
          const rootTs = timestampOf(activation);
          yield* harness.runner.inject(
            normalizedEvent({
              authorSlackId: slack.humanUserId,
              channelId: slack.channelId,
              eventId: "event:known-initializer-failure",
              messageTs: rootTs,
              text: `<@${LABORER_SLACK_ID}> fail setup`,
            })
          );

          assert.strictEqual(yield* Ref.get(handlerInvocations), 0);
          const state = yield* harness.store.snapshot;
          assert.strictEqual(state.threads[0]?.initializationStatus, "pending");
          assert.strictEqual(state.threads[0]?.turns[0]?.status, "failed");
          assert.deepStrictEqual(
            state.threads[0]?.outbox.map((item) => item.kind),
            ["operational_notice"]
          );
        })
      )
  );

  it.live("fails closed when a persisted working directory disappears", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped(
          "laborer-persisted-initializer-"
        );
        const workingDirectory = join(root, "working-directory");
        yield* Effect.promise(() => mkdir(workingDirectory));
        const canonicalWorkingDirectory = yield* Effect.promise(() =>
          realpath(workingDirectory)
        );
        const snapshotPath = join(root, "state.json");
        const slack = yield* startEmulatedSlack();
        const harness = yield* makePrototypeHarness({
          handler: WorkHandler.of({ invoke: () => Effect.void }),
          initializer: ThreadInitializer.of({
            initialize: () => Effect.succeed(canonicalWorkingDirectory),
          }),
          laborerSlackId: LABORER_SLACK_ID,
          slack: slack.gateway,
          storeLayer: makeFileStoreLayer(
            LABORER_SLACK_ID,
            snapshotPath,
            root,
            undefined,
            { initializeNewThreads: true }
          ),
        });
        const activation = yield* postHumanMessage(
          slack,
          `<@${LABORER_SLACK_ID}> persist setup`
        );
        const rootTs = timestampOf(activation);
        yield* harness.runner.inject(
          normalizedEvent({
            authorSlackId: slack.humanUserId,
            channelId: slack.channelId,
            eventId: "event:persisted-initializer",
            messageTs: rootTs,
            text: `<@${LABORER_SLACK_ID}> persist setup`,
          })
        );
        yield* Effect.promise(() => rm(workingDirectory, { recursive: true }));

        const reloaded = yield* Effect.result(
          Layer.build(makeFileStoreLayer(LABORER_SLACK_ID, snapshotPath, root))
        );
        assert.strictEqual(reloaded._tag, "Failure");
      })
    )
  );

  it.live(
    "creates and reuses a sibling Git worktree with next/.env.local",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const sandbox = yield* makeTempDirectoryScoped(
            "laborer-worktree-initializer-"
          );
          const repository = join(sandbox, "laborer");
          const nextDirectory = join(repository, "next");
          yield* Effect.promise(() =>
            mkdir(nextDirectory, { recursive: true })
          );
          yield* Effect.promise(() =>
            Promise.all([
              writeFile(join(repository, ".gitignore"), "next/.env.local\n"),
              writeFile(join(repository, "README.md"), "prototype\n"),
              writeFile(join(nextDirectory, ".env.local"), "CANARY=value\n", {
                mode: 0o600,
              }),
            ])
          );
          const git = (args: readonly string[]) =>
            Effect.promise(() =>
              execFilePromise("git", ["-C", repository, ...args], {
                encoding: "utf8",
              })
            );
          yield* git(["init", "-b", "main"]);
          yield* git(["config", "user.email", "prototype@example.com"]);
          yield* git(["config", "user.name", "Prototype"]);
          yield* git(["add", "."]);
          yield* git(["commit", "-m", "initial"]);

          const initializer = yield* makeProcessInitializer({
            args: [resolve("src/handlers/create-thread-worktree.ts")],
            command: process.execPath,
            cwd: nextDirectory,
            environment: { PATH: process.env.PATH },
            evidence: { mode: "fixture" },
            stateRoot: join(sandbox, "state"),
            stateRootAnchor: sandbox,
          });
          const handlerDirectories = yield* Ref.make<readonly string[]>([]);
          const slack = yield* startEmulatedSlack();
          const harness = yield* makePrototypeHarness({
            handler: WorkHandler.of({
              invoke: (turn) =>
                turn.workingDirectory === null
                  ? Effect.die("worktree initializer returned no directory")
                  : Ref.update(handlerDirectories, (values) => [
                      ...values,
                      turn.workingDirectory as string,
                    ]),
            }),
            initializer: initializer.initializer,
            laborerSlackId: LABORER_SLACK_ID,
            slack: slack.gateway,
          });

          const activation = yield* postHumanMessage(
            slack,
            `<@${LABORER_SLACK_ID}> create a feature workspace`
          );
          const rootTs = timestampOf(activation);
          yield* harness.runner.inject(
            normalizedEvent({
              authorSlackId: slack.humanUserId,
              channelId: slack.channelId,
              eventId: "event:real-worktree",
              messageTs: rootTs,
              text: `<@${LABORER_SLACK_ID}> create a feature workspace`,
            })
          );
          const initializedState = yield* harness.store.snapshot;
          const initializedThread = initializedState.threads[0];
          const initializedTurn = initializedThread?.turns[0];
          assert.ok(initializedThread);
          assert.ok(initializedTurn);
          const replayedWorkingDirectory =
            yield* initializer.initializer.initialize(
              {
                attemptNumber: 2,
                channelId: initializedThread.channelId,
                context: initializedTurn.context,
                id: initializedTurn.id,
                initializationStatus: "pending",
                messages: initializedTurn.messages,
                rootTs: initializedThread.rootTs,
                threadId: initializedThread.id,
                workingDirectory: null,
              },
              () => Effect.void
            );
          assert.strictEqual(
            replayedWorkingDirectory,
            initializedThread.workingDirectory
          );
          const followUp = yield* postHumanMessage(slack, "continue", {
            threadTs: rootTs,
          });
          yield* harness.runner.inject(
            normalizedEvent({
              authorSlackId: slack.humanUserId,
              channelId: slack.channelId,
              eventId: "event:real-worktree-follow-up",
              messageTs: timestampOf(followUp),
              text: "continue",
              threadTs: rootTs,
            })
          );

          const directories = yield* Ref.get(handlerDirectories);
          const initializerEvidence = yield* initializer.snapshot;
          assert.strictEqual(
            directories.length,
            2,
            JSON.stringify(initializerEvidence)
          );
          assert.strictEqual(directories[0], directories[1]);
          const worktree = directories[0];
          assert.ok(worktree);
          assert.ok(worktree.startsWith(join(sandbox, "laborer.worktrees")));
          assert.strictEqual(
            yield* Effect.promise(() =>
              readFile(join(worktree, "next", ".env.local"), "utf8")
            ),
            "CANARY=value\n"
          );
          assert.strictEqual(
            yield* Effect.promise(() =>
              readFile(join(repository, "next", ".env.local"), "utf8")
            ),
            "CANARY=value\n"
          );
          assert.strictEqual(
            (yield* Effect.promise(() =>
              stat(join(worktree, "next", ".env.local"))
            )).mode % 512,
            0o600
          );
          assert.strictEqual(
            (yield* git(["status", "--porcelain"])).stdout,
            ""
          );
          assert.strictEqual(initializerEvidence.invocations.length, 2);
        })
      )
  );
});
