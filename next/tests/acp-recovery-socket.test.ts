import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  type AcpRecoveryService,
  startAcpRecoverySocket,
} from "../src/slack/acp-recovery.ts";
import { makeTempDirectoryScoped } from "./support/temp-directory.ts";

const unavailableService: AcpRecoveryService = {
  abandon: () => Effect.die("not called"),
  health: Effect.die("not called"),
  inspect: () => Effect.die("not called"),
  list: Effect.die("not called"),
  retry: () => Effect.die("not called"),
};

const leaveStaleSocket = (path: string): Promise<void> =>
  new Promise((resolveReady, rejectReady) => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        'require("node:net").createServer().listen(process.argv[1], () => process.stdout.write("ready\\n"))',
        path,
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let settled = false;
    const timeout = setTimeout(() => {
      settle(new Error("stale recovery socket fixture timed out"));
    }, 5000);
    const settle = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      const complete = (): void =>
        error === undefined ? resolveReady() : rejectReady(error);
      if (child.exitCode !== null || child.signalCode !== null) {
        complete();
        return;
      }
      child.once("exit", complete);
      child.kill("SIGKILL");
    };
    child.once("error", (error) => settle(error));
    child.stderr.once("data", (chunk: Buffer) => {
      settle(new Error(chunk.toString("utf8")));
    });
    child.stdout.once("data", () => {
      settle();
    });
  });

describe("ACP recovery socket lifecycle", () => {
  it.live("replaces an owner-controlled socket left by a crashed daemon", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped("laborer-recovery-socket-");
        const path = join(root, "recovery.sock");
        yield* Effect.promise(() => leaveStaleSocket(path));
        assert.isTrue((yield* Effect.promise(() => lstat(path))).isSocket());

        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* startAcpRecoverySocket({
              path,
              service: unavailableService,
              trustedRoot: root,
            });

            assert.isTrue(
              (yield* Effect.promise(() => lstat(path))).isSocket()
            );
          })
        );
        const removed = yield* Effect.result(
          Effect.tryPromise(() => lstat(path))
        );
        assert.strictEqual(removed._tag, "Failure");
      })
    )
  );
});
