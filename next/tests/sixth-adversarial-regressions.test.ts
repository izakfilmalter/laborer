import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import {
  type ClaimedTurn,
  EventId,
  NormalizedMessage,
  type PrototypeState,
  ReplyId,
  stableMessageId,
  ThreadId,
  TurnId,
} from "../src/prototype/domain.ts";
import type {
  ProcessHandlerEvidence,
  ProcessHandlerOptions,
} from "../src/prototype/process-handler.ts";
import { makeProcessHandler } from "../src/prototype/process-handler.ts";
import { makePrototypeHarness } from "../src/prototype/runtime.ts";
import {
  LABORER_SLACK_ID,
  normalizedEvent,
} from "../src/prototype/scenario.ts";
import { makeFileStoreLayer } from "../src/prototype/store.ts";
import { environmentForConfiguredHandler } from "../src/slack/handler-environment.ts";
import { makeTempDirectoryScoped } from "./support/temp-directory.ts";

const projectRoot = process.cwd();
const processTreeFixture = resolve(
  projectRoot,
  "tests/fixtures/process-tree-handler.ts"
);

const slack = {
  postThreadMessage: () => Effect.succeed({ ts: "delivered" }),
  readActivationContext: () => Effect.succeed([]),
};

const activation = (channelId: string, eventId: string) =>
  normalizedEvent({
    authorSlackId: "UHUMAN",
    channelId,
    eventId,
    messageTs: "1.0",
    text: `<@${LABORER_SLACK_ID}> sixth review`,
  });

const readSnapshot = (path: string): Promise<PrototypeState> =>
  readFile(path, "utf8").then((source) => JSON.parse(source) as PrototypeState);

const makeTurn = (): ClaimedTurn => {
  const channelId = "CSIXTH";
  const message = NormalizedMessage.make({
    authorKind: "human",
    authorSlackId: "UHUMAN",
    classification: "input",
    id: stableMessageId(channelId, "1.0"),
    isActivation: true,
    slackTs: "1.0",
    text: "blocked process evidence",
  });
  return {
    attemptNumber: 1,
    channelId,
    context: [],
    id: TurnId.make(`turn:${message.id}`),
    initializationStatus: "not_applicable",
    messages: [message],
    rootTs: "1.0",
    threadId: ThreadId.make(`${channelId}:1.0`),
    workingDirectory: null,
  };
};

const processOptions = (
  root: string,
  evidence: ProcessHandlerOptions["evidence"],
  pidFile?: string
): ProcessHandlerOptions => ({
  args: [processTreeFixture],
  command: process.execPath,
  cwd: projectRoot,
  environment: environmentForConfiguredHandler(
    {
      PATH: process.env.PATH,
      PROCESS_TREE_MODE: "timeout",
      ...(pidFile === undefined ? {} : { PROCESS_TREE_PID_FILE: pidFile }),
    },
    ["PROCESS_TREE_MODE", "PROCESS_TREE_PID_FILE"]
  ),
  evidence,
  stateRoot: join(root, "work-threads"),
  stateRootAnchor: root,
  timeout: "30 seconds",
});

const evidenceBytes = (evidence: ProcessHandlerEvidence): number =>
  Buffer.byteLength(JSON.stringify(evidence), "utf8");

const waitForPid = Effect.fnUntraced(function* (
  snapshot: Effect.Effect<ProcessHandlerEvidence>
) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const evidence = yield* snapshot;
    const pid = evidence.invocations[0]?.pid;
    if (pid !== null && pid !== undefined) {
      return evidence;
    }
    yield* Effect.sleep("10 millis");
  }
  return yield* Effect.die(new Error("process PID was not recorded"));
});

const waitForFile = Effect.fnUntraced(function* (path: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const exists = yield* Effect.promise(() =>
      stat(path).then(
        () => true,
        () => false
      )
    );
    if (exists) {
      return;
    }
    yield* Effect.sleep("10 millis");
  }
  return yield* Effect.die(new Error("blocked handler did not start"));
});

describe("sixth review publication commit point", () => {
  it.effect(
    "reports a published transition as degraded until a later commit reconciles it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-publication-point-"
          );
          const snapshotPath = join(root, "snapshot.json");
          let shouldFailAfterRename = false;
          const harness = yield* makePrototypeHarness({
            handler: { invoke: () => Effect.void },
            laborerSlackId: LABORER_SLACK_ID,
            slack,
            storeLayer: makeFileStoreLayer(
              LABORER_SLACK_ID,
              snapshotPath,
              root,
              {
                afterRename: () => {
                  if (shouldFailAfterRename) {
                    shouldFailAfterRename = false;
                    return Promise.reject(new Error("injected afterRename"));
                  }
                  return Promise.resolve();
                },
              }
            ),
          });

          shouldFailAfterRename = true;
          const firstResult = yield* Effect.result(
            harness.store.accept(activation("CPUBLISH1", "event:publish:1"))
          );
          assert.strictEqual(firstResult._tag, "Success");
          const degraded = yield* harness.store.persistenceHealth;
          assert.strictEqual(degraded._tag, "Degraded");
          if (degraded._tag === "Degraded") {
            assert.strictEqual(degraded.operation, "accept");
            assert.strictEqual(
              degraded.error.reason,
              "snapshot-published-after-rename-hook-failed"
            );
          }
          const memoryAfterFirst = yield* harness.store.snapshot;
          const diskAfterFirst = yield* Effect.promise(() =>
            readSnapshot(snapshotPath)
          );
          assert.deepStrictEqual(
            JSON.parse(JSON.stringify(memoryAfterFirst)),
            diskAfterFirst
          );
          assert.deepStrictEqual(memoryAfterFirst.seenEventIds, [
            EventId.make("event:publish:1"),
          ]);

          yield* harness.store.accept(
            activation("CPUBLISH2", "event:publish:2")
          );
          assert.deepStrictEqual(yield* harness.store.persistenceHealth, {
            _tag: "Healthy",
          });
          const memoryAfterSecond = yield* harness.store.snapshot;
          const diskAfterSecond = yield* Effect.promise(() =>
            readSnapshot(snapshotPath)
          );
          assert.deepStrictEqual(
            JSON.parse(JSON.stringify(memoryAfterSecond)),
            diskAfterSecond
          );
          assert.deepStrictEqual(memoryAfterSecond.seenEventIds, [
            EventId.make("event:publish:1"),
            EventId.make("event:publish:2"),
          ]);
        })
      )
  );

  it.live(
    "continues runner acknowledgements and thread work after a published accept reports an ancillary failure",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-runner-publication-point-"
          );
          const snapshotPath = join(root, "snapshot.json");
          const lifecycle: string[] = [];
          const delivered: string[] = [];
          let shouldFailAfterRename = false;
          const harness = yield* makePrototypeHarness({
            activationAcknowledger: {
              acknowledge: () =>
                Effect.sync(() => {
                  lifecycle.push("acknowledged");
                }),
              complete: () =>
                Effect.sync(() => {
                  lifecycle.push("completed");
                }),
            },
            handler: {
              invoke: (turn, acceptReply) =>
                Effect.sync(() => {
                  lifecycle.push("handler");
                }).pipe(
                  Effect.andThen(
                    acceptReply({
                      protocolVersion: 1,
                      replyId: ReplyId.make(`reply:${turn.id}:published`),
                      text: "published transition continued",
                      type: "public_reply",
                    })
                  )
                ),
            },
            laborerSlackId: LABORER_SLACK_ID,
            slack: {
              postThreadMessage: ({ text }) =>
                Effect.sync(() => {
                  delivered.push(text);
                  return { ts: "delivered-after-publication-error" };
                }),
              readActivationContext: () => Effect.succeed([]),
            },
            storeLayer: makeFileStoreLayer(
              LABORER_SLACK_ID,
              snapshotPath,
              root,
              {
                afterRename: () => {
                  if (shouldFailAfterRename) {
                    shouldFailAfterRename = false;
                    return Promise.reject(new Error("injected afterRename"));
                  }
                  return Promise.resolve();
                },
              }
            ),
          });

          shouldFailAfterRename = true;
          const decision = yield* harness.runner.inject(
            activation("CPUBLISH-RUNNER", "event:publish:runner")
          );
          assert.strictEqual(decision._tag, "Accepted");

          const deadline = Date.now() + 5000;
          while (Date.now() < deadline) {
            if ((yield* harness.store.acknowledgements).length === 0) {
              break;
            }
            yield* Effect.sleep("10 millis");
          }

          const memory = yield* harness.store.snapshot;
          const disk = yield* Effect.promise(() => readSnapshot(snapshotPath));
          assert.strictEqual(lifecycle.length, 3);
          assert.deepStrictEqual(
            new Set(lifecycle),
            new Set(["acknowledged", "completed", "handler"])
          );
          assert.deepStrictEqual(delivered, ["published transition continued"]);
          assert.strictEqual(memory.acknowledgements.length, 0);
          assert.strictEqual(memory.threads[0]?.turns[0]?.status, "completed");
          assert.strictEqual(memory.threads[0]?.outbox[0]?.status, "delivered");
          assert.deepStrictEqual(yield* harness.runner.persistenceHealth, {
            _tag: "Healthy",
          });
          assert.deepStrictEqual(JSON.parse(JSON.stringify(memory)), disk);
        })
      ),
    30_000
  );
});

describe("sixth review evidence aggregate bound", () => {
  it.live(
    "bounds a blocked handler snapshot after PID assignment",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-pid-evidence-bound-"
          );
          const turn = makeTurn();
          const measuring = yield* makeProcessHandler(
            processOptions(root, { mode: "fixture" })
          );
          const measuringFiber = yield* Effect.forkChild(
            measuring.handler.invoke(turn, () => Effect.void)
          );
          const assignedEvidence = yield* waitForPid(measuring.snapshot);
          const beforeAssignment = {
            ...assignedEvidence,
            invocations: assignedEvidence.invocations.map((invocation) => ({
              ...invocation,
              pid: null,
            })),
          };
          const aggregateLimit = evidenceBytes(beforeAssignment);
          yield* Fiber.interrupt(measuringFiber);

          const pidFile = join(root, "bounded-grandchild.pid");
          const bounded = yield* makeProcessHandler(
            processOptions(
              root,
              {
                maxAggregateBytes: aggregateLimit,
                mode: "fixture",
              },
              pidFile
            )
          );
          const boundedFiber = yield* Effect.forkChild(
            bounded.handler.invoke(turn, () => Effect.void)
          );
          yield* waitForFile(pidFile);
          const snapshot = yield* bounded.snapshot;
          assert.ok(evidenceBytes(snapshot) <= aggregateLimit);
          yield* Fiber.interrupt(boundedFiber);
        })
      ),
    30_000
  );
});
