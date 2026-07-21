import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Array as EffectArray, pipe } from "effect";
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
const handlerPath = resolve(
  projectRoot,
  "src/handlers/classifier-worker-prototype.sh"
);
const fakeOpenCodePath = resolve(
  projectRoot,
  "tests/fixtures/fake-opencode.sh"
);
const slack = {
  postThreadMessage: () => Effect.succeed({ ts: "delivered" }),
  readActivationContext: () => Effect.succeed([]),
};

describe("classifier worker durable invocation", () => {
  it.live(
    "streams prompts beyond argv limits and rejects prompt overflow before invocation",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const temporaryRoot = yield* makeTempDirectoryScoped(
            "laborer-prompt-stdin-"
          );
          const fakeLog = join(temporaryRoot, "fake-opencode.ndjson");
          const processHandler = yield* makeProcessHandler({
            args: [
              `FAKE_OPENCODE_LOG=${fakeLog}`,
              `LABORER_OPENCODE_COMMAND=${fakeOpenCodePath}`,
              handlerPath,
            ],
            command: "/usr/bin/env",
            cwd: projectRoot,
            environment: environmentForConfiguredHandler(process.env),
            evidence: { mode: "fixture" },
            stateRoot: join(temporaryRoot, "work-threads"),
            stateRootAnchor: temporaryRoot,
            timeout: "15 seconds",
          });
          const harness = yield* makePrototypeHarness({
            handler: processHandler.handler,
            laborerSlackId: LABORER_SLACK_ID,
            slack,
          });
          yield* harness.runner.inject(
            normalizedEvent({
              authorSlackId: "UHUMAN",
              channelId: "CLARGEPROMPT",
              eventId: "event:large-prompt",
              messageTs: "1.0",
              text: `<@${LABORER_SLACK_ID}> ${"p".repeat(1150 * 1024)}`,
            })
          );
          const calls = pipe(
            (yield* Effect.promise(() => readFile(fakeLog, "utf8")))
              .trim()
              .split("\n"),
            EffectArray.map(
              (line) => JSON.parse(line) as Record<string, unknown>
            )
          );
          assert.strictEqual(calls.length, 2);
          assert.ok(
            EffectArray.every(
              calls,
              (call) =>
                typeof call.promptBytes === "number" &&
                call.promptBytes > 1024 * 1024 &&
                call.promptInArgv === false
            )
          );

          const overflowHandler = yield* makeProcessHandler({
            args: [
              `FAKE_OPENCODE_LOG=${join(temporaryRoot, "overflow.ndjson")}`,
              `LABORER_OPENCODE_COMMAND=${fakeOpenCodePath}`,
              handlerPath,
            ],
            command: "/usr/bin/env",
            cwd: projectRoot,
            environment: environmentForConfiguredHandler(process.env),
            evidence: { mode: "fixture" },
            stateRoot: join(temporaryRoot, "overflow-work-threads"),
            stateRootAnchor: temporaryRoot,
            timeout: "15 seconds",
          });
          const overflowHarness = yield* makePrototypeHarness({
            handler: overflowHandler.handler,
            laborerSlackId: LABORER_SLACK_ID,
            slack,
          });
          yield* overflowHarness.runner.inject(
            normalizedEvent({
              authorSlackId: "UHUMAN",
              channelId: "CPROMPTOVERFLOW",
              eventId: "event:prompt-overflow",
              messageTs: "2.0",
              text: `<@${LABORER_SLACK_ID}> ${"q".repeat(2 * 1024 * 1024)}`,
            })
          );
          assert.strictEqual(
            (yield* overflowHarness.store.snapshot).threads[0]?.turns[0]
              ?.outcome?.kind,
            "failure"
          );
          assert.ok(
            EffectArray.some(
              (yield* overflowHandler.snapshot).internalStderr,
              (text) =>
                text.includes(
                  "OpenCode prompt exceeds the bounded prompt-bytes limit"
                )
            )
          );
        })
      ),
    40_000
  );

  it.live(
    "recovers an OpenCode-completed follow-up without duplicate submission",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const temporaryRoot = yield* makeTempDirectoryScoped(
            "laborer-follow-up-recovery-"
          );
          const fakeLog = join(temporaryRoot, "fake-opencode.ndjson");
          const stateRoot = join(temporaryRoot, "work-threads");
          const snapshotPath = join(temporaryRoot, "snapshot.json");
          const failedThread = yield* Effect.scoped(
            Effect.gen(function* () {
              const crashingHandler = yield* makeProcessHandler({
                args: [
                  `FAKE_OPENCODE_LOG=${fakeLog}`,
                  "LABORER_TEST_CRASH_AFTER_OPENCODE=true",
                  `LABORER_OPENCODE_COMMAND=${fakeOpenCodePath}`,
                  handlerPath,
                ],
                command: "/usr/bin/env",
                cwd: projectRoot,
                environment: environmentForConfiguredHandler(process.env),
                evidence: { mode: "fixture" },
                stateRoot,
                stateRootAnchor: temporaryRoot,
                timeout: "15 seconds",
              });
              const harness = yield* makePrototypeHarness({
                handler: crashingHandler.handler,
                laborerSlackId: LABORER_SLACK_ID,
                slack,
                storeLayer: makeFileStoreLayer(
                  LABORER_SLACK_ID,
                  snapshotPath,
                  temporaryRoot
                ),
              });
              yield* harness.runner.inject(
                normalizedEvent({
                  authorSlackId: "UHUMAN",
                  channelId: "CRECOVERY",
                  eventId: "event:recovery-initial",
                  messageTs: "1.0",
                  text: `<@${LABORER_SLACK_ID}> initial request`,
                })
              );
              yield* harness.runner.inject(
                normalizedEvent({
                  authorSlackId: "UHUMAN",
                  channelId: "CRECOVERY",
                  eventId: "event:recovery-follow-up",
                  messageTs: "2.0",
                  text: "follow up once",
                  threadTs: "1.0",
                })
              );
              return (yield* harness.store.snapshot).threads[0];
            })
          );
          const failedTurn = failedThread?.turns[1];
          assert.ok(failedThread);
          assert.ok(failedTurn);
          assert.strictEqual(failedTurn.status, "running");
          assert.strictEqual(failedTurn.outcome, null);

          yield* Effect.scoped(
            Effect.gen(function* () {
              const recoveryHandler = yield* makeProcessHandler({
                args: [
                  `FAKE_OPENCODE_LOG=${fakeLog}`,
                  `LABORER_OPENCODE_COMMAND=${fakeOpenCodePath}`,
                  handlerPath,
                ],
                command: "/usr/bin/env",
                cwd: projectRoot,
                environment: environmentForConfiguredHandler(process.env),
                evidence: { mode: "fixture" },
                stateRoot,
                stateRootAnchor: temporaryRoot,
                timeout: "15 seconds",
              });
              const harness = yield* makePrototypeHarness({
                handler: recoveryHandler.handler,
                laborerSlackId: LABORER_SLACK_ID,
                slack,
                storeLayer: makeFileStoreLayer(
                  LABORER_SLACK_ID,
                  snapshotPath,
                  temporaryRoot
                ),
              });
              yield* harness.runner.retryInterrupted(failedThread.id);
              const recovered = (yield* harness.store.snapshot).threads[0]
                ?.turns[1];
              assert.strictEqual(recovered?.status, "completed");
              assert.deepStrictEqual(
                recovered?.attempts.map((attempt) => attempt.status),
                ["interrupted", "succeeded"]
              );
            })
          );
          const callKinds = pipe(
            (yield* Effect.promise(() => readFile(fakeLog, "utf8")))
              .trim()
              .split("\n"),
            EffectArray.map(
              (line) => (JSON.parse(line) as { readonly kind: string }).kind
            )
          );
          assert.deepStrictEqual(callKinds, [
            "classifier",
            "worker",
            "follow-up",
          ]);

          assert.strictEqual(callKinds.length, 3);
        })
      ),
    40_000
  );
});
