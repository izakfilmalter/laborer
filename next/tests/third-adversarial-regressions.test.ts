import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import {
  AcknowledgementState,
  type ClaimedTurn,
  EventId,
  NormalizedMessage,
  PrototypeState,
  stableAcknowledgementId,
  stableMessageId,
  ThreadId,
  TurnId,
  WorkThreadState,
} from "../src/prototype/domain.ts";
import {
  MAX_HANDLER_INPUT_BYTES,
  makeProcessHandler,
} from "../src/prototype/process-handler.ts";
import { LABORER_SLACK_ID } from "../src/prototype/scenario.ts";
import {
  makeControlledStoreLayer,
  makeFileStoreLayer,
  PrototypeStore,
} from "../src/prototype/store.ts";
import { environmentForConfiguredHandler } from "../src/slack/handler-environment.ts";
import { loadLaborerConfig } from "../src/slack/laborer-config.ts";
import { makeTempDirectoryScoped } from "./support/temp-directory.ts";

const projectRoot = process.cwd();
const processTreeFixture = resolve(
  projectRoot,
  "tests/fixtures/process-tree-handler.ts"
);

const makeTurn = (text: string, suffix = "1.0"): ClaimedTurn => {
  const channelId = "CTHIRD";
  const message = NormalizedMessage.make({
    authorKind: "human",
    authorSlackId: "UHUMAN",
    classification: "input",
    id: stableMessageId(channelId, suffix),
    isActivation: true,
    slackTs: suffix,
    text,
  });
  return {
    attemptNumber: 1,
    channelId,
    context: [],
    id: TurnId.make(`turn:${message.id}`),
    initializationStatus: "not_applicable",
    messages: [message],
    rootTs: suffix,
    threadId: ThreadId.make(`${channelId}:${suffix}`),
    workingDirectory: null,
  };
};

const processHandler = (
  root: string,
  mode: string,
  timeout: import("effect").Duration.Input = "5 seconds"
) =>
  makeProcessHandler({
    args: [processTreeFixture],
    command: process.execPath,
    cwd: projectRoot,
    environment: environmentForConfiguredHandler(
      { ...process.env, PROCESS_TREE_MODE: mode },
      ["PROCESS_TREE_MODE"]
    ),
    evidence: { mode: "fixture" },
    stateRoot: join(root, "work-threads"),
    stateRootAnchor: root,
    timeout,
  });

const baseAcknowledgementState = (): PrototypeState => {
  const channelId = "CSTATE";
  const messageTs = "1.0";
  const eventId = EventId.make("event:state");
  const message = NormalizedMessage.make({
    authorKind: "human",
    authorSlackId: "UHUMAN",
    classification: "input",
    id: stableMessageId(channelId, messageTs),
    isActivation: true,
    slackTs: messageTs,
    text: `<@${LABORER_SLACK_ID}> state`,
  });
  return PrototypeState.make({
    acknowledgements: [
      AcknowledgementState.make({
        attempts: 0,
        channelId,
        cleanupRequested: false,
        eventId,
        id: stableAcknowledgementId(channelId, messageTs),
        lastErrorCategory: null,
        messageTs,
        retryAtMillis: null,
        status: "add_pending",
      }),
    ],
    ignoredInbound: [],
    schemaVersion: 1,
    seenEventIds: [eventId],
    threads: [
      WorkThreadState.make({
        activationEventId: eventId,
        activationTs: messageTs,
        channelId,
        context: [],
        contextAttempts: 0,
        contextIsPartial: false,
        contextRetryAtMillis: null,
        contextStatus: "pending",
        id: ThreadId.make(`${channelId}:${messageTs}`),
        initializationStatus: "not_applicable",
        outbox: [],
        rootTs: messageTs,
        turns: [],
        unassigned: [message],
        workingDirectory: null,
      }),
    ],
  });
};

const validateControlledState = (state: PrototypeState) =>
  Effect.scoped(
    Layer.build(
      makeControlledStoreLayer({
        laborerSlackId: LABORER_SLACK_ID,
        persist: () => Effect.void,
        state,
      })
    )
  );

describe("third adversarial process boundaries", () => {
  it.live("rejects an oversized serialized envelope before process spawn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped("laborer-envelope-limit-");
        const fixture = yield* processHandler(root, "normal");
        const result = yield* Effect.result(
          fixture.handler.invoke(
            makeTurn("x".repeat(MAX_HANDLER_INPUT_BYTES)),
            () => Effect.void
          )
        );
        assert.strictEqual(result._tag, "Failure");
        if (
          result._tag === "Failure" &&
          result.failure._tag === "HandlerFailure"
        ) {
          assert.strictEqual(result.failure.category, "protocol");
          assert.strictEqual(
            result.failure.safeDetail,
            "handler input envelope exceeds 4 MiB"
          );
        }
        assert.deepStrictEqual((yield* fixture.snapshot).invocations, []);
      })
    )
  );

  it.live("maps an early stdin close to a sanitized handler failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped("laborer-stdin-close-");
        const fixture = yield* processHandler(root, "early-close-stdin");
        const result = yield* Effect.result(
          fixture.handler.invoke(
            makeTurn("x".repeat(3 * 1024 * 1024)),
            () => Effect.void
          )
        );
        assert.strictEqual(result._tag, "Failure");
        if (
          result._tag === "Failure" &&
          result.failure._tag === "HandlerFailure"
        ) {
          assert.strictEqual(result.failure.category, "protocol");
          assert.strictEqual(
            result.failure.safeDetail,
            "handler closed input before envelope completed"
          );
        }
      })
    )
  );

  it.live("rejects malformed UTF-8 before protocol JSON parsing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped("laborer-invalid-utf8-");
        const fixture = yield* processHandler(root, "invalid-utf8");
        const result = yield* Effect.result(
          fixture.handler.invoke(makeTurn("utf8"), () => Effect.void)
        );
        assert.strictEqual(result._tag, "Failure");
        if (
          result._tag === "Failure" &&
          result.failure._tag === "HandlerFailure"
        ) {
          assert.strictEqual(result.failure.category, "protocol");
          assert.strictEqual(
            result.failure.safeDetail,
            "invalid UTF-8 at line 1"
          );
        }
      })
    )
  );

  it.live(
    "keeps an unrelated process untouched while descendants exit during cleanup",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped("laborer-pgid-race-");
          const signalMarker = join(root, "unrelated-signaled");
          const unrelated = yield* Effect.acquireRelease(
            Effect.sync(() =>
              spawn(
                process.execPath,
                [
                  "--input-type=module",
                  "--eval",
                  `import { writeFileSync } from "node:fs"; process.on("SIGTERM", () => writeFileSync(${JSON.stringify(signalMarker)}, "term")); process.stdout.write("READY\\n"); setInterval(() => undefined, 1000);`,
                ],
                { stdio: ["ignore", "pipe", "ignore"] }
              )
            ),
            (child) =>
              Effect.sync(() => {
                if (child.exitCode === null) {
                  child.kill("SIGKILL");
                }
              })
          );
          yield* Effect.promise(
            () =>
              new Promise<void>((resolveReady, rejectReady) => {
                const deadline = setTimeout(
                  () => rejectReady(new Error("unrelated readiness timeout")),
                  5000
                );
                unrelated.stdout.once("data", (chunk) => {
                  clearTimeout(deadline);
                  if (!chunk.toString("utf8").includes("READY")) {
                    rejectReady(new Error("invalid unrelated handshake"));
                    return;
                  }
                  resolveReady();
                });
              })
          );

          for (let index = 0; index < 20; index += 1) {
            const fixture = yield* processHandler(root, "descendant-race");
            yield* fixture.handler.invoke(
              makeTurn(`race-${index}`, `${index + 1}.0`),
              () => Effect.void
            );
          }
          assert.strictEqual(unrelated.exitCode, null);
          const markerExists = yield* Effect.promise(async () => {
            try {
              await stat(signalMarker);
              return true;
            } catch {
              return false;
            }
          });
          assert.strictEqual(markerExists, false);
        })
      ),
    30_000
  );
});

describe("third adversarial state and config verification", () => {
  it.effect("rejects every corrupted acknowledgement relation", () =>
    Effect.gen(function* () {
      const base = baseAcknowledgementState();
      const acknowledgement = base.acknowledgements[0];
      const thread = base.threads[0];
      assert.ok(acknowledgement);
      assert.ok(thread);
      const invalidStates: PrototypeState[] = [
        { ...base, acknowledgements: [{ ...acknowledgement, id: "bad" }] },
        {
          ...base,
          acknowledgements: [
            { ...acknowledgement, eventId: EventId.make("event:missing") },
          ],
        },
        {
          ...base,
          acknowledgements: [
            { ...acknowledgement, eventId: EventId.make("event:other-seen") },
          ],
          seenEventIds: [
            ...base.seenEventIds,
            EventId.make("event:other-seen"),
          ],
        },
        {
          ...base,
          acknowledgements: [
            {
              ...acknowledgement,
              id: stableAcknowledgementId(acknowledgement.channelId, "2.0"),
              messageTs: "2.0",
            },
          ],
        },
        {
          ...base,
          acknowledgements: [
            {
              ...acknowledgement,
              attempts: 1,
              lastErrorCategory: "ratelimited",
              retryAtMillis: -1,
            },
          ],
        },
        {
          ...base,
          acknowledgements: [
            {
              ...acknowledgement,
              attempts: 1,
              lastErrorCategory: "ratelimited",
              retryAtMillis: Number.POSITIVE_INFINITY,
            },
          ],
        },
        {
          ...base,
          acknowledgements: [
            {
              ...acknowledgement,
              attempts: 1,
              lastErrorCategory: "request_error",
              retryAtMillis: 10,
              status: "active",
            },
          ],
        },
        {
          ...base,
          acknowledgements: [{ ...acknowledgement, status: "cleanup_pending" }],
        },
        {
          ...base,
          acknowledgements: [
            {
              ...acknowledgement,
              attempts: 1,
              status: "permanent_failure",
            },
          ],
        },
        {
          ...base,
          acknowledgements: [acknowledgement, { ...acknowledgement }],
        },
      ];
      for (const invalidState of invalidStates) {
        const result = yield* Effect.result(
          validateControlledState(invalidState)
        );
        assert.strictEqual(result._tag, "Failure");
      }
    })
  );

  it.effect(
    "rejects excess snapshot properties while migrating missing acknowledgements",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-strict-snapshot-"
          );
          const snapshotPath = join(root, "snapshot.json");
          const base = baseAcknowledgementState();
          const { acknowledgements: _acknowledgements, ...withoutAcks } = base;
          const firstThread = withoutAcks.threads[0];
          assert.ok(firstThread);
          const {
            activationEventId: _activationEventId,
            initializationStatus: _initializationStatus,
            workingDirectory: _workingDirectory,
            ...legacyThread
          } = firstThread;
          const legacy = {
            ...withoutAcks,
            threads: [legacyThread],
          };
          yield* Effect.promise(() =>
            writeFile(snapshotPath, JSON.stringify(legacy), "utf8")
          );
          const context = yield* Layer.build(
            makeFileStoreLayer(LABORER_SLACK_ID, snapshotPath, root)
          );
          const store = yield* PrototypeStore.pipe(Effect.provide(context));
          const migrated = yield* store.snapshot;
          assert.strictEqual(
            migrated.threads[0]?.initializationStatus,
            "not_applicable"
          );
          assert.strictEqual(migrated.threads[0]?.workingDirectory, null);

          for (const invalid of [
            { ...base, unexpectedTopLevel: true },
            {
              ...base,
              threads: [
                {
                  ...base.threads[0],
                  unassigned: [
                    {
                      ...base.threads[0]?.unassigned[0],
                      unexpectedNested: true,
                    },
                  ],
                },
              ],
            },
          ]) {
            yield* Effect.promise(() =>
              writeFile(snapshotPath, JSON.stringify(invalid), "utf8")
            );
            const result = yield* Effect.result(
              Layer.build(
                makeFileStoreLayer(LABORER_SLACK_ID, snapshotPath, root)
              )
            );
            assert.strictEqual(result._tag, "Failure");
          }
        })
      )
  );

  it.effect(
    "rejects typoed workHandler keys but retains top-level fields",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped("laborer-config-typo-");
          const configPath = join(root, "laborer.json");
          yield* Effect.promise(() =>
            writeFile(
              configPath,
              JSON.stringify({
                unrelated: { retained: true },
                workHandler: { comand: "node", command: "node" },
              })
            )
          );
          const typo = yield* Effect.result(
            loadLaborerConfig({
              defaultRoot: root,
              environment: { PATH: process.env.PATH },
            })
          );
          assert.strictEqual(typo._tag, "Failure");

          yield* Effect.promise(() =>
            writeFile(
              configPath,
              JSON.stringify({
                unrelated: { retained: true },
                workHandler: { command: "node" },
              })
            )
          );
          const loaded = yield* loadLaborerConfig({
            defaultRoot: root,
            environment: { PATH: process.env.PATH },
          });
          assert.deepStrictEqual(loaded.config.unrelated, { retained: true });
        })
      )
  );

  it.effect("rejects untrusted writable parent directories", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() =>
        mkdtemp(join(tmpdir(), "laborer-untrusted-parent-"))
      );
      yield* Effect.promise(() =>
        writeFile(
          join(root, "laborer.json"),
          JSON.stringify({ workHandler: { command: "node" } })
        )
      );
      yield* Effect.promise(() => chmod(root, 0o777));
      const configResult = yield* Effect.result(
        loadLaborerConfig({
          defaultRoot: root,
          environment: { PATH: process.env.PATH },
        })
      );
      const snapshotResult = yield* Effect.result(
        Effect.scoped(
          Layer.build(
            makeFileStoreLayer(
              LABORER_SLACK_ID,
              join(root, "snapshot.json"),
              root
            )
          )
        )
      );
      yield* Effect.promise(() => chmod(root, 0o700));
      assert.strictEqual(configResult._tag, "Failure");
      assert.strictEqual(snapshotResult._tag, "Failure");
      yield* Effect.promise(() => rm(root, { force: true, recursive: true }));
    })
  );

  it.effect("rejects invalid UTF-8 in laborer.json", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped("laborer-config-utf8-");
        yield* Effect.promise(() =>
          writeFile(join(root, "laborer.json"), Buffer.from([0xc3, 0x28]))
        );
        const result = yield* Effect.result(
          loadLaborerConfig({
            defaultRoot: root,
            environment: { PATH: process.env.PATH },
          })
        );
        assert.strictEqual(result._tag, "Failure");
      })
    )
  );
});
