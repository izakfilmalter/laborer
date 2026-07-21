import { spawn } from "node:child_process";
import { access, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  type ClaimedTurn,
  NormalizedMessage,
  stableMessageId,
  ThreadId,
  TurnId,
} from "../src/prototype/domain.ts";
import {
  makeProcessHandler,
  type ProcessHandlerOptions,
} from "../src/prototype/process-handler.ts";
import { environmentForConfiguredHandler } from "../src/slack/handler-environment.ts";
import { makeTempDirectoryScoped } from "./support/temp-directory.ts";

const projectRoot = process.cwd();
const processTreeFixture = resolve(
  projectRoot,
  "tests/fixtures/process-tree-handler.ts"
);
const stateHelper = resolve(
  projectRoot,
  "src/handlers/classifier-worker-state-helper.ts"
);

const makeTurn = (text: string): ClaimedTurn => {
  const threadId = ThreadId.make("CPROCESS:1.0");
  const message = NormalizedMessage.make({
    authorKind: "human",
    authorSlackId: "UHUMAN",
    classification: "input",
    id: stableMessageId("CPROCESS", "1.0"),
    isActivation: true,
    slackTs: "1.0",
    text,
  });
  return {
    attemptNumber: 1,
    channelId: "CPROCESS",
    context: [],
    id: TurnId.make(`turn:${message.id}`),
    messages: [message],
    rootTs: "1.0",
    threadId,
  };
};

const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitForFile = Effect.fnUntraced(function* (path: string, mode: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = yield* Effect.result(
      Effect.tryPromise({
        try: () => access(path),
        catch: () => undefined,
      })
    );
    if (result._tag === "Success") {
      return;
    }
    yield* Effect.sleep("25 millis");
  }
  assert.fail(
    `fixture readiness timed out after 5 seconds: mode=${mode} path=${path}`
  );
});

const processOptions = (
  temporaryRoot: string,
  mode: string,
  pidFile?: string
): ProcessHandlerOptions => ({
  args: [processTreeFixture],
  command: process.execPath,
  cwd: projectRoot,
  environment: environmentForConfiguredHandler(
    {
      ...process.env,
      PROCESS_TREE_MODE: mode,
      ...(pidFile === undefined ? {} : { PROCESS_TREE_PID_FILE: pidFile }),
    },
    ["PROCESS_TREE_MODE", "PROCESS_TREE_PID_FILE"]
  ),
  evidence: { mode: "fixture" },
  stateRoot: join(temporaryRoot, "work-threads"),
  stateRootAnchor: temporaryRoot,
  timeout: mode === "timeout" ? "1500 millis" : "5 seconds",
});

describe("second adversarial process regressions", () => {
  it.live(
    "retains only the final 64 KiB of arbitrarily large handler stderr",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const temporaryRoot = yield* makeTempDirectoryScoped(
            "laborer-stderr-tail-"
          );
          const fixture = yield* makeProcessHandler(
            processOptions(temporaryRoot, "stderr-tail")
          );
          yield* fixture.handler.invoke(makeTurn("stderr"), () => Effect.void);
          const retained = (yield* fixture.snapshot).internalStderr[0];
          assert.ok(retained);
          assert.ok(Buffer.byteLength(retained, "utf8") <= 64 * 1024);
          assert.ok(retained.endsWith("retained-tail-marker"));
          assert.ok(!retained.includes("discard-me:"));
        })
      )
  );

  it.live(
    "terminates pipe-holding grandchildren after normal exit, overflow, and timeout",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          for (const mode of ["normal", "overflow", "timeout"] as const) {
            const temporaryRoot = yield* makeTempDirectoryScoped(
              `laborer-process-tree-${mode}-`
            );
            const pidFile = join(temporaryRoot, "grandchild.pid");
            const fixture = yield* makeProcessHandler(
              processOptions(temporaryRoot, mode, pidFile)
            );
            yield* Effect.result(
              fixture.handler.invoke(makeTurn(mode), () => Effect.void)
            );
            yield* waitForFile(pidFile, mode);
            const pid = Number(
              yield* Effect.promise(() => readFile(pidFile, "utf8"))
            );
            assert.ok(Number.isSafeInteger(pid));
            assert.strictEqual(processExists(pid), false, `${mode} survivor`);
          }
        })
      ),
    20_000
  );

  it.effect("uses a least-privilege environment with validated opt-ins", () =>
    Effect.sync(() => {
      const environment = environmentForConfiguredHandler(
        {
          HOME: "/home/runner",
          PATH: "/usr/bin",
          PROVIDER_API_KEY: "provider-value",
          SLACK_APP_TOKEN: "forbidden-app",
          SLACK_BOT_TOKEN: "forbidden-bot",
          UNRELATED_SECRET: "must-not-cross",
        },
        ["PROVIDER_API_KEY", "SLACK_BOT_TOKEN"]
      );
      assert.deepStrictEqual(environment, {
        HOME: "/home/runner",
        PATH: "/usr/bin",
        PROVIDER_API_KEY: "provider-value",
      });
    })
  );

  it.effect(
    "rejects symlink leaves and parent components for handler state",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const temporaryRoot = yield* makeTempDirectoryScoped(
            "laborer-state-symlink-"
          );
          const realDirectory = join(temporaryRoot, "real");
          const linkedDirectory = join(temporaryRoot, "linked");
          const externalState = join(temporaryRoot, "external.json");
          yield* Effect.promise(() => mkdir(realDirectory));
          yield* Effect.promise(() => writeFile(externalState, "external"));
          yield* Effect.promise(() => symlink(realDirectory, linkedDirectory));
          yield* Effect.promise(() =>
            symlink(
              externalState,
              join(realDirectory, "classifier-worker-state.json")
            )
          );

          const runHelper = (directory: string) =>
            new Promise<number | null>((resolveExit, rejectExit) => {
              const child = spawn(
                process.execPath,
                [stateHelper, "read", directory],
                {
                  cwd: projectRoot,
                  stdio: ["ignore", "ignore", "ignore"],
                }
              );
              child.once("error", rejectExit);
              child.once("exit", resolveExit);
            });
          assert.notStrictEqual(
            yield* Effect.promise(() => runHelper(realDirectory)),
            0
          );
          assert.notStrictEqual(
            yield* Effect.promise(() => runHelper(linkedDirectory)),
            0
          );
          assert.strictEqual(
            yield* Effect.promise(() => readFile(externalState, "utf8")),
            "external"
          );
        })
      )
  );

  it.effect("cleans the raw temp directory when canonicalization fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let rawDirectory = "";
        const result = yield* Effect.result(
          makeTempDirectoryScoped("laborer-realpath-failure-", {
            canonicalize: (directory) => {
              rawDirectory = directory;
              return Promise.reject(
                new Error("injected canonicalization failure")
              );
            },
          })
        );
        assert.strictEqual(result._tag, "Failure");
        assert.ok(rawDirectory.length > 0);
        const existence = yield* Effect.result(
          Effect.tryPromise({
            try: () => access(rawDirectory),
            catch: () => undefined,
          })
        );
        assert.strictEqual(existence._tag, "Failure");
      })
    )
  );
});
