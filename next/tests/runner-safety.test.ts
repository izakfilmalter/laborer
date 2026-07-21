import { type ChildProcess, spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import {
  fixtureHandlerOptions,
  makeProcessHandler,
} from "../src/prototype/process-handler.ts";
import {
  makePrototypeHarness,
  type SlackGatewayShape,
} from "../src/prototype/runtime.ts";
import { normalizedEvent } from "../src/prototype/scenario.ts";
import { makeFileStoreLayer } from "../src/prototype/store.ts";
import { acquireRunnerLock } from "../src/slack/runner-lock.ts";
import { prepareSlackRuntimePaths } from "../src/slack/runtime-paths.ts";

const LABORER_ID = "ULABORER";

const canonicalTempDirectory = async (prefix: string): Promise<string> =>
  realpath(await mkdtemp(join(tmpdir(), prefix)));

const waitForChildMessage = (
  child: ChildProcess,
  expected: string
): Promise<void> =>
  new Promise((resolveMessage, rejectMessage) => {
    const timer = setTimeout(
      () => rejectMessage(new Error("child message timeout")),
      5000
    );
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectMessage(error);
    });
    child.once("message", (message) => {
      clearTimeout(timer);
      if (message === expected) {
        resolveMessage();
        return;
      }
      rejectMessage(new Error("unexpected child message"));
    });
  });

const waitForChildExit = (child: ChildProcess): Promise<void> =>
  new Promise((resolveExit) => child.once("exit", () => resolveExit()));

const noContextGateway: SlackGatewayShape = {
  postThreadMessage: () => Effect.succeed({ ts: "unused" }),
  readActivationContext: () => Effect.succeed([]),
};

describe("exclusive Runner lock", () => {
  it.live(
    "rejects concurrent ownership and permits acquisition after release",
    () =>
      Effect.gen(function* () {
        const runtimeRoot = yield* Effect.promise(() =>
          canonicalTempDirectory("lr-")
        );
        const lockPath = join(runtimeRoot, "runner.lock");
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* acquireRunnerLock(runtimeRoot, lockPath);
            const duplicate = yield* Effect.result(
              Effect.scoped(acquireRunnerLock(runtimeRoot, lockPath))
            );
            assert.strictEqual(duplicate._tag, "Failure");
            if (duplicate._tag === "Failure") {
              assert.strictEqual(duplicate.failure.reason, "already-held");
            }
          })
        );
        const releasedPathExists = yield* Effect.promise(async () => {
          try {
            await lstat(lockPath);
            return true;
          } catch {
            return false;
          }
        });
        assert.strictEqual(releasedPathExists, false);
        const reacquired = yield* Effect.result(
          Effect.scoped(acquireRunnerLock(runtimeRoot, lockPath))
        );
        assert.strictEqual(reacquired._tag, "Success");
      })
  );

  it.live(
    "recovers an inode-checked stale marker left by a crashed process",
    () =>
      Effect.gen(function* () {
        const runtimeRoot = yield* Effect.promise(() =>
          canonicalTempDirectory("lc-")
        );
        const lockPath = join(runtimeRoot, "runner.lock");
        const holderPath = resolve(
          process.cwd(),
          "tests/fixtures/runner-lock-holder.ts"
        );
        const child = spawn(
          process.execPath,
          [holderPath, runtimeRoot, lockPath],
          {
            cwd: process.cwd(),
            stdio: ["ignore", "ignore", "ignore", "ipc"],
          }
        );
        yield* Effect.promise(() => waitForChildMessage(child, "ready"));
        assert.strictEqual(
          (yield* Effect.promise(() => lstat(lockPath))).isFile(),
          true
        );
        child.kill("SIGKILL");
        yield* Effect.promise(() => waitForChildExit(child));
        assert.strictEqual(
          (yield* Effect.promise(() => lstat(lockPath))).isFile(),
          true
        );
        const recovered = yield* Effect.result(
          Effect.scoped(acquireRunnerLock(runtimeRoot, lockPath))
        );
        assert.strictEqual(recovered._tag, "Success");
      })
  );
});

describe("symlink-safe runtime state", () => {
  it.effect(
    "rejects symlinked runtime and work-thread directories without chmod traversal",
    () =>
      Effect.gen(function* () {
        const projectRoot = yield* Effect.promise(() =>
          canonicalTempDirectory("rp-")
        );
        const outside = yield* Effect.promise(() =>
          canonicalTempDirectory("ro-")
        );
        yield* Effect.promise(() => chmod(outside, 0o777));
        const runtimeRoot = join(projectRoot, ".laborer-runtime");
        yield* Effect.promise(() => symlink(outside, runtimeRoot, "dir"));
        const unsafeRoot = yield* Effect.result(
          prepareSlackRuntimePaths(projectRoot)
        );
        assert.strictEqual(unsafeRoot._tag, "Failure");
        assert.strictEqual(
          (yield* Effect.promise(() => stat(outside))).mode % 512,
          0o777
        );

        yield* Effect.promise(() => rm(runtimeRoot));
        const paths = yield* prepareSlackRuntimePaths(projectRoot);
        yield* Effect.promise(() => rm(paths.workThreads, { recursive: true }));
        yield* Effect.promise(() => symlink(outside, paths.workThreads, "dir"));
        const unsafeThreads = yield* Effect.result(
          prepareSlackRuntimePaths(projectRoot)
        );
        assert.strictEqual(unsafeThreads._tag, "Failure");
        assert.strictEqual(
          (yield* Effect.promise(() => stat(outside))).mode % 512,
          0o777
        );
      })
  );

  it.effect("rejects symlinked lock, snapshot, and snapshot-parent paths", () =>
    Effect.gen(function* () {
      const projectRoot = yield* Effect.promise(() =>
        canonicalTempDirectory("sp-")
      );
      const paths = yield* prepareSlackRuntimePaths(projectRoot);
      const outside = yield* Effect.promise(() =>
        canonicalTempDirectory("so-")
      );
      const outsideFile = join(outside, "outside.json");
      yield* Effect.promise(() => writeFile(outsideFile, "unchanged", "utf8"));

      yield* Effect.promise(() => symlink(outsideFile, paths.lock, "file"));
      const unsafeLock = yield* Effect.result(
        Effect.scoped(acquireRunnerLock(paths.root, paths.lock))
      );
      assert.strictEqual(unsafeLock._tag, "Failure");
      yield* Effect.promise(() => rm(paths.lock));

      yield* Effect.promise(() => symlink(outsideFile, paths.snapshot, "file"));
      const unsafeSnapshot = yield* Effect.result(
        Effect.scoped(
          Layer.build(
            makeFileStoreLayer(LABORER_ID, paths.snapshot, paths.root)
          )
        )
      );
      assert.strictEqual(unsafeSnapshot._tag, "Failure");
      assert.strictEqual(
        yield* Effect.promise(() => readFile(outsideFile, "utf8")),
        "unchanged"
      );
      yield* Effect.promise(() => rm(paths.snapshot));

      const linkedParent = join(paths.root, "linked-parent");
      yield* Effect.promise(() => symlink(outside, linkedParent, "dir"));
      const unsafeParent = yield* Effect.result(
        Effect.scoped(
          Layer.build(
            makeFileStoreLayer(
              LABORER_ID,
              join(linkedParent, "state.json"),
              paths.root
            )
          )
        )
      );
      assert.strictEqual(unsafeParent._tag, "Failure");
    })
  );

  it.live("rejects a symlinked per-thread handler state directory", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const anchor = yield* Effect.promise(() =>
          canonicalTempDirectory("hp-")
        );
        const stateRoot = join(anchor, "work-threads");
        yield* Effect.promise(() => mkdir(stateRoot, { mode: 0o700 }));
        const outside = yield* Effect.promise(() =>
          canonicalTempDirectory("ho-")
        );
        yield* Effect.promise(() => chmod(outside, 0o777));
        const stateDirectory = join(stateRoot, encodeURIComponent("CPATH:1.0"));
        yield* Effect.promise(() => symlink(outside, stateDirectory, "dir"));
        const processHandler = yield* makeProcessHandler({
          ...fixtureHandlerOptions(process.cwd()),
          stateRoot,
          stateRootAnchor: anchor,
        });
        const harness = yield* makePrototypeHarness({
          handler: processHandler.handler,
          laborerSlackId: LABORER_ID,
          slack: noContextGateway,
        });
        yield* harness.runner.inject(
          normalizedEvent({
            authorSlackId: "UHUMAN",
            channelId: "CPATH",
            eventId: "event:path-symlink",
            messageTs: "1.0",
            text: `<@${LABORER_ID}> path safety`,
          })
        );
        const state = yield* harness.store.snapshot;
        assert.strictEqual(
          state.threads[0]?.turns[0]?.outcome?.category,
          "spawn"
        );
        assert.strictEqual(
          (yield* Effect.promise(() => stat(outside))).mode % 512,
          0o777
        );
      })
    )
  );
});
