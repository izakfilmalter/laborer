import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";
import {
  LocalProcessExecutor,
  type LocalProcessRequest,
  validateLocalExecutable,
} from "../src/adapters/local-process-execution.ts";
import { terminateSupervisedProcess } from "../src/adapters/process-supervisor.ts";

const cwd = resolve(import.meta.dirname, "..");
const fixture = resolve(cwd, "tests/fixtures/local-process.ts");

const request = async (
  mode: string,
  overrides: Partial<LocalProcessRequest> = {}
): Promise<LocalProcessRequest> => ({
  executable: await Effect.runPromise(
    validateLocalExecutable(process.execPath)
  ),
  arguments: [fixture, mode],
  workingDirectory: cwd,
  input: Buffer.from("hello"),
  environmentNames: ["PATH"],
  limits: {
    deadlineMillis: 2000,
    inputBytes: 1024,
    stderrBytes: 1024,
    stdoutBytes: 1024,
    terminationGraceMillis: 100,
  },
  ...overrides,
});

const run = (
  value: LocalProcessRequest,
  ambient: NodeJS.ProcessEnv = process.env
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const executor = yield* LocalProcessExecutor;
      return yield* executor.execute(value);
    }).pipe(Effect.provide(LocalProcessExecutor.layer(ambient)))
  );

describe("LocalProcessExecutor", () => {
  it("executes literal arguments with bounded private output", async () => {
    const result = await run(await request("echo"));
    expect(result._tag).toBe("Success");
    expect(Buffer.from(result.stdout).toString()).toBe("hello");
    expect(Buffer.from(result.stderr).toString()).toBe("private diagnostic");
  });

  it("completes a backpressured input write before reporting success", async () => {
    const input = Buffer.alloc(512 * 1024, 0x78);
    const result = await run(
      await request("input-length", {
        input,
        limits: {
          deadlineMillis: 2000,
          inputBytes: input.byteLength,
          stderrBytes: 1024,
          stdoutBytes: 1024,
          terminationGraceMillis: 100,
        },
      })
    );
    expect(result._tag).toBe("Success");
    expect(Buffer.from(result.stdout).toString()).toBe(
      String(input.byteLength)
    );
  });

  it("does not interpret shell metacharacters in arguments", async () => {
    const literal = await request("literal");
    const hostileArgument = "$(printf shell-was-used); exit 9";
    const result = await run({
      ...literal,
      arguments: [fixture, "literal", hostileArgument],
    });
    expect(result._tag).toBe("Success");
    expect(Buffer.from(result.stdout).toString()).toBe(hostileArgument);
  });

  it("distinguishes nonzero exit and spawn failure", async () => {
    const nonzeroRequest = await request("exit");
    const nonzero = await run({
      ...nonzeroRequest,
      arguments: [fixture, "exit", "9"],
    });
    expect(nonzero).toMatchObject({ _tag: "NonZeroExit", exitCode: 9 });

    const missing = await Effect.runPromise(
      validateLocalExecutable(process.execPath)
    );
    const failed = await run({
      ...(await request("echo")),
      executable: `${missing}-missing` as typeof missing,
    });
    expect(failed._tag).toBe("SpawnFailure");
  });

  it("preserves a known nonzero exit when the child closes input early", async () => {
    const value = await request("exit-without-input", {
      input: Buffer.alloc(512 * 1024, 0x78),
      limits: {
        deadlineMillis: 2000,
        inputBytes: 512 * 1024,
        stderrBytes: 1024,
        stdoutBytes: 1024,
        terminationGraceMillis: 100,
      },
    });
    const result = await run({
      ...value,
      arguments: [fixture, "exit-without-input", "11"],
    });
    expect(result).toMatchObject({ _tag: "NonZeroExit", exitCode: 11 });
  });

  it("enforces input and hostile output bounds", async () => {
    const inputRequest = await request("echo", {
      input: Buffer.alloc(1025),
    });
    await expect(run(inputRequest)).resolves.toMatchObject({
      _tag: "LimitExceeded",
      limit: "input",
    });

    const outputRequest = await request("output");
    await expect(
      run({
        ...outputRequest,
        arguments: [fixture, "output", "2048"],
      })
    ).resolves.toMatchObject({ _tag: "LimitExceeded", limit: "stdout" });

    await expect(
      run({
        ...outputRequest,
        arguments: [fixture, "output", "2048", "stderr"],
      })
    ).resolves.toMatchObject({ _tag: "LimitExceeded", limit: "stderr" });
  });

  it("reports an asynchronous spawn failure", async () => {
    const failed = await run(
      await request("echo", { workingDirectory: resolve(cwd, "missing-cwd") })
    );
    expect(failed._tag).toBe("SpawnFailure");
  });

  it("admits only explicitly allowed non-sensitive environment names", async () => {
    const environmentRequest = await request("environment", {
      environmentNames: [
        "SAFE_VALUE",
        "SLACK_BOT_TOKEN",
        "LABORER_ACTION_BRIDGE_SECRET",
        "OPENCODE_CONFIG_CONTENT",
        "UNLISTED",
      ],
    });
    const result = await run(environmentRequest, {
      SAFE_VALUE: "visible",
      SLACK_BOT_TOKEN: "secret",
      LABORER_ACTION_BRIDGE_SECRET: "bridge-secret",
      OPENCODE_CONFIG_CONTENT: "private-config",
      UNLISTED: undefined,
      OTHER_VALUE: "hidden",
    });
    expect(result._tag).toBe("Success");
    const environment = JSON.parse(
      Buffer.from(result.stdout).toString()
    ) as Record<string, string>;
    expect(environment.SAFE_VALUE).toBe("visible");
    expect(environment.SLACK_BOT_TOKEN).toBeUndefined();
    expect(environment.LABORER_ACTION_BRIDGE_SECRET).toBeUndefined();
    expect(environment.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    expect(environment.OTHER_VALUE).toBeUndefined();
  });

  it("times out and reaps a TERM-resistant descendant", async () => {
    const result = await run(
      await request("hang-tree", {
        limits: {
          deadlineMillis: 100,
          inputBytes: 1024,
          stderrBytes: 1024,
          stdoutBytes: 1024,
          terminationGraceMillis: 100,
        },
      })
    );
    expect(result._tag).toBe("Timeout");
    const descendantPid = Number(Buffer.from(result.stdout).toString());
    expect(Number.isSafeInteger(descendantPid)).toBe(true);
    expect(() => process.kill(descendantPid, 0)).toThrow();
  });

  it("returns interruption after scoped descendant cleanup", async () => {
    const controller = new AbortController();
    const pending = run(
      await request("hang-tree", { interruptSignal: controller.signal })
    );
    setTimeout(() => controller.abort(), 50);
    const result = await pending;
    expect(result._tag).toBe("Interrupted");
  });

  it("reports cleanup uncertainty when cleanup cannot be confirmed", async () => {
    const value = await request("echo");
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const executor = yield* LocalProcessExecutor;
        return yield* executor.execute(value);
      }).pipe(
        Effect.provide(
          LocalProcessExecutor.layer(
            process.env,
            async (child, graceMillis) => {
              await terminateSupervisedProcess(child, graceMillis);
              throw new Error("cleanup outcome unknown");
            }
          )
        )
      )
    );
    expect(result).toMatchObject({
      _tag: "CleanupUncertain",
      prior: { _tag: "Success" },
    });
  });

  it("waits for descendant cleanup when the Effect fiber is interrupted", async () => {
    const pidFile = resolve(
      tmpdir(),
      `laborer-local-process-${process.pid}-${Date.now()}.pid`
    );
    const hanging = await request("hang-tree");
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const executor = yield* LocalProcessExecutor;
        return yield* executor.execute({
          ...hanging,
          arguments: [fixture, "hang-tree", pidFile],
        });
      }).pipe(Effect.provide(LocalProcessExecutor.layer()))
    );

    let descendantPid: number | undefined;
    const deadline = Date.now() + 2000;
    while (descendantPid === undefined && Date.now() < deadline) {
      try {
        descendantPid = Number(await readFile(pidFile, "utf8"));
      } catch {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      }
    }
    expect(descendantPid).toBeTypeOf("number");

    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(() => process.kill(descendantPid as number, 0)).toThrow();
    await rm(pidFile, { force: true });
  });
});
