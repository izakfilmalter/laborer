import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { PrototypeState } from "../src/prototype/domain.ts";
import { prepareSlackRuntimePaths } from "../src/slack/runtime-paths.ts";
import { makeTempDirectoryScoped } from "./support/temp-directory.ts";

const WORKER_PATH = join(
  process.cwd(),
  "tests/fixtures/conversation-stream-crash-worker.ts"
);
const PRODUCTION_WORKER_PATH = join(
  process.cwd(),
  "tests/fixtures/acp-production-stream-crash-worker.ts"
);
const WORKER_TIMEOUT_MILLIS = 10_000;
const LEADING_SLASH = /^\//u;
const ACP_PARTIAL_TEXT = "**Streaming** from ACP";
const PRODUCTION_WORKSPACE_ID = "TSTREAMPRODUCTION";

type FakeSlackBehavior = "normal" | "rate-limit-once" | "timeout-once";

interface FakeSlackCall {
  readonly method: string;
  readonly outcome: "rate-limited" | "success";
  readonly text: string;
  readonly ts: string | null;
}

interface FakeSlackServer {
  readonly calls: FakeSlackCall[];
  readonly close: () => Promise<void>;
  readonly messages: Map<string, { stopped: boolean; text: string }>;
  readonly setBehavior: (behavior: FakeSlackBehavior) => void;
  readonly url: string;
}

const sendJson = (
  response: import("node:http").ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {}
): void => {
  if (response.destroyed || response.writableEnded) {
    return;
  }
  response.writeHead(status, {
    "content-type": "application/json",
    ...headers,
  });
  response.end(JSON.stringify(body));
};

const startFakeSlackServer = (): Promise<FakeSlackServer> =>
  new Promise((resolveStart, rejectStart) => {
    const calls: FakeSlackCall[] = [];
    const messages = new Map<string, { stopped: boolean; text: string }>();
    let behavior: FakeSlackBehavior = "normal";
    let nextMessage = 1;
    const server = createServer((request, response) => {
      response.on("error", () => undefined);
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body = `${body}${chunk}`;
      });
      request.on("end", () => {
        const method = request.url?.replace(LEADING_SLASH, "") ?? "unknown";
        const parameters = new URLSearchParams(body);
        const text =
          parameters.get("markdown_text") ?? parameters.get("text") ?? "";
        const requestedTs = parameters.get("ts");
        if (behavior === "rate-limit-once") {
          behavior = "normal";
          calls.push({
            method,
            outcome: "rate-limited",
            text,
            ts: requestedTs,
          });
          sendJson(
            response,
            429,
            { ok: false, error: "ratelimited" },
            {
              "retry-after": "1",
            }
          );
          return;
        }

        let responseTs = requestedTs;
        let responseBody: unknown = { ok: true, ts: responseTs };
        if (method === "chat.startStream" || method === "chat.postMessage") {
          responseTs = `stream-${nextMessage}`;
          nextMessage += 1;
          messages.set(responseTs, { stopped: false, text });
        } else if (method === "chat.appendStream" && responseTs !== null) {
          const current = messages.get(responseTs);
          if (current !== undefined) {
            messages.set(responseTs, {
              ...current,
              text: `${current.text}${text}`,
            });
          }
        } else if (method === "chat.update" && responseTs !== null) {
          const current = messages.get(responseTs);
          if (current !== undefined) {
            messages.set(responseTs, { ...current, text });
          }
        } else if (method === "chat.stopStream" && responseTs !== null) {
          const current = messages.get(responseTs);
          if (current !== undefined) {
            messages.set(responseTs, { ...current, stopped: true });
          }
        } else if (
          method === "conversations.history" ||
          method === "conversations.replies"
        ) {
          responseBody = {
            messages: [],
            ok: true,
            response_metadata: { next_cursor: "" },
          };
        }
        calls.push({
          method,
          outcome: "success",
          text,
          ts: responseTs,
        });
        if (
          method !== "conversations.history" &&
          method !== "conversations.replies"
        ) {
          responseBody = { ok: true, ts: responseTs };
        }
        const complete = (): void => sendJson(response, 200, responseBody);
        if (behavior === "timeout-once") {
          behavior = "normal";
          setTimeout(complete, 250);
          return;
        }
        complete();
      });
    });
    server.once("error", rejectStart);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        rejectStart(new Error("Fake Slack server address is unavailable"));
        return;
      }
      resolveStart({
        calls,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            server.close((error) => {
              if (error === undefined) {
                resolveClose();
                return;
              }
              rejectClose(error);
            });
          }),
        messages,
        setBehavior: (nextBehavior) => {
          behavior = nextBehavior;
        },
        url: `http://127.0.0.1:${address.port}/`,
      });
    });
  });

interface StreamWorker {
  readonly child: ChildProcessWithoutNullStreams;
  readonly output: () => string;
  readonly standardError: () => string;
}

interface StartWorkerOptions {
  readonly action: string;
  readonly controls?: string;
  readonly crashAt?: string;
  readonly crashKind?: string;
  readonly crashOperationIndex?: number;
  readonly root: string;
  readonly serverUrl: string;
  readonly transport?: "fallback" | "native";
  readonly workerPath?: string;
}

const startWorker = (options: StartWorkerOptions): StreamWorker => {
  const child = spawn(process.execPath, [options.workerPath ?? WORKER_PATH], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      STREAM_ACTION: options.action,
      STREAM_ROOT: options.root,
      STREAM_SLACK_API_URL: options.serverUrl,
      STREAM_STATE_PATH: join(options.root, "runner.json"),
      ...(options.controls === undefined
        ? {}
        : { STREAM_CONTROLS: options.controls }),
      ...(options.crashAt === undefined
        ? {}
        : { STREAM_CRASH_AT: options.crashAt }),
      ...(options.crashKind === undefined
        ? {}
        : { STREAM_CRASH_KIND: options.crashKind }),
      ...(options.crashOperationIndex === undefined
        ? {}
        : {
            STREAM_CRASH_OPERATION_INDEX: String(options.crashOperationIndex),
          }),
      ...(options.transport === undefined
        ? {}
        : { STREAM_TRANSPORT: options.transport }),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let standardError = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output = `${output}${chunk}`;
  });
  child.stderr.on("data", (chunk: string) => {
    standardError = `${standardError}${chunk}`;
  });
  return {
    child,
    output: () => output,
    standardError: () => standardError,
  };
};

const lineWithPrefix = (output: string, prefix: string): string | undefined =>
  output.split("\n").find((line) => line.startsWith(prefix));

const waitForLine = (worker: StreamWorker, prefix: string): Promise<string> =>
  new Promise((resolveLine, rejectLine) => {
    const startedAt = Date.now();
    const inspect = (): void => {
      const line = lineWithPrefix(worker.output(), prefix);
      if (line !== undefined) {
        resolveLine(line);
        return;
      }
      if (worker.child.exitCode !== null || worker.child.signalCode !== null) {
        rejectLine(
          new Error(
            `Stream worker exited before ${prefix}: ${worker.standardError()}`
          )
        );
        return;
      }
      if (Date.now() - startedAt >= WORKER_TIMEOUT_MILLIS) {
        rejectLine(
          new Error(
            `Timed out waiting for ${prefix}: ${worker.standardError()}`
          )
        );
        return;
      }
      setTimeout(inspect, 5);
    };
    inspect();
  });

const waitForExit = (worker: StreamWorker): Promise<void> =>
  new Promise((resolveExit) => {
    if (worker.child.exitCode !== null || worker.child.signalCode !== null) {
      resolveExit();
      return;
    }
    worker.child.once("close", () => resolveExit());
  });

const killWorker = async (worker: StreamWorker): Promise<void> => {
  if (worker.child.exitCode === null && worker.child.signalCode === null) {
    worker.child.kill("SIGKILL");
  }
  await waitForExit(worker);
};

const runWorker = async (
  options: StartWorkerOptions
): Promise<PrototypeState> => {
  const worker = startWorker(options);
  const line = await waitForLine(worker, "RESULT:");
  await waitForExit(worker);
  return Schema.decodeUnknownSync(PrototypeState)(
    JSON.parse(line.slice("RESULT:".length)) as unknown
  );
};

const waitForRetryState = async (statePath: string): Promise<void> => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < WORKER_TIMEOUT_MILLIS) {
    try {
      const state = Schema.decodeUnknownSync(PrototypeState)(
        JSON.parse(await readFile(statePath, "utf8")) as unknown
      );
      if (
        state.conversationStreams.some((stream) =>
          stream.operations.some((operation) => operation.status === "retry")
        )
      ) {
        return;
      }
    } catch {
      // The first atomic snapshot may not have been published yet.
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 5));
  }
  throw new Error("Timed out waiting for a durable stream retry");
};

const onlyStream = (state: PrototypeState) => {
  const stream =
    state.conversationStreams[0] ?? state.conversationStreamTombstones[0];
  assert.ok(stream !== undefined);
  return stream;
};

describe("Conversation stream process-loss recovery", () => {
  it.live(
    "reconciles durable native operations across real SIGKILL crash points",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fakeSlack = yield* Effect.acquireRelease(
            Effect.promise(startFakeSlackServer),
            (server) => Effect.promise(server.close).pipe(Effect.ignore)
          );
          const activeWorkers = new Set<StreamWorker>();
          yield* Effect.addFinalizer(() =>
            Effect.promise(async () => {
              await Promise.all([...activeWorkers].map(killWorker));
            })
          );
          const spawnTracked = (
            options: Parameters<typeof startWorker>[0]
          ): StreamWorker => {
            const worker = startWorker(options);
            activeWorkers.add(worker);
            worker.child.once("close", () => activeWorkers.delete(worker));
            return worker;
          };
          const crash = Effect.fnUntraced(function* (
            worker: StreamWorker,
            marker: string
          ) {
            yield* Effect.promise(() => waitForLine(worker, marker));
            yield* Effect.promise(() => killWorker(worker));
          });

          const beforeStartRoot = yield* makeTempDirectoryScoped(
            "laborer-stream-before-start-"
          );
          const beforeStartCalls = fakeSlack.calls.length;
          const beforeStart = spawnTracked({
            action: "publish",
            crashAt: "prepared",
            crashKind: "native-start",
            root: beforeStartRoot,
            serverUrl: fakeSlack.url,
          });
          yield* crash(beforeStart, "CRASH:prepared:native-start");
          assert.strictEqual(fakeSlack.calls.length, beforeStartCalls);
          const continued = yield* Effect.promise(() =>
            runWorker({
              action: "continue",
              root: beforeStartRoot,
              serverUrl: fakeSlack.url,
            })
          );
          assert.strictEqual(onlyStream(continued).lifecycle, "stopped");
          const continuedCalls = fakeSlack.calls.slice(beforeStartCalls);
          assert.deepStrictEqual(
            continuedCalls.map(({ method }) => method),
            ["chat.startStream", "chat.appendStream", "chat.stopStream"]
          );
          const continuedMessage = fakeSlack.messages.get(
            continuedCalls[0]?.ts ?? ""
          );
          assert.deepStrictEqual(continuedMessage, {
            stopped: true,
            text: "Hello world",
          });

          for (const scenario of [
            {
              action: "append",
              expectedMethod: "chat.appendStream",
              kind: "native-append",
              name: "append",
              restartAction: "continue",
            },
            {
              action: "stop",
              expectedMethod: "chat.stopStream",
              kind: "native-stop",
              name: "stop",
              restartAction: "recover",
            },
          ] as const) {
            const root = yield* makeTempDirectoryScoped(
              `laborer-stream-before-${scenario.name}-`
            );
            const callStart = fakeSlack.calls.length;
            const worker = spawnTracked({
              action: scenario.action,
              crashAt: "prepared",
              crashKind: scenario.kind,
              root,
              serverUrl: fakeSlack.url,
            });
            yield* crash(worker, `CRASH:prepared:${scenario.kind}`);
            const callsBeforeRecovery = fakeSlack.calls.length;
            const recovered = yield* Effect.promise(() =>
              runWorker({
                action: scenario.restartAction,
                root,
                serverUrl: fakeSlack.url,
              })
            );
            assert.strictEqual(onlyStream(recovered).lifecycle, "stopped");
            const calls = fakeSlack.calls.slice(callStart);
            assert.strictEqual(
              fakeSlack.calls
                .slice(callStart, callsBeforeRecovery)
                .filter(({ method }) => method === scenario.expectedMethod)
                .length,
              0
            );
            assert.ok(fakeSlack.calls.length > callsBeforeRecovery);
            assert.strictEqual(
              calls.filter(({ method }) => method === scenario.expectedMethod)
                .length,
              1
            );
            assert.strictEqual(
              calls.filter(({ method }) => method === "chat.startStream")
                .length,
              1
            );
          }

          for (const scenario of [
            {
              action: "publish",
              kind: "native-start",
              name: "start",
            },
            {
              action: "append",
              kind: "native-append",
              name: "append",
            },
            { action: "stop", kind: "native-stop", name: "stop" },
          ] as const) {
            const root = yield* makeTempDirectoryScoped(
              `laborer-stream-after-${scenario.name}-`
            );
            const callStart = fakeSlack.calls.length;
            const worker = spawnTracked({
              action: scenario.action,
              crashAt: "after-request",
              crashKind: scenario.kind,
              root,
              serverUrl: fakeSlack.url,
            });
            yield* crash(worker, `CRASH:after-request:${scenario.kind}`);
            const callsBeforeRecovery = fakeSlack.calls.length;
            const recovered = yield* Effect.promise(() =>
              runWorker({ action: "recover", root, serverUrl: fakeSlack.url })
            );
            assert.strictEqual(
              fakeSlack.calls.length,
              callsBeforeRecovery,
              scenario.name
            );
            assert.strictEqual(
              onlyStream(recovered).lifecycle,
              "unresolved",
              scenario.name
            );
            const operation = onlyStream(recovered).operations.find(
              ({ kind }) => kind === scenario.kind
            );
            assert.strictEqual(operation?.status, "unresolved", scenario.name);
            assert.ok(fakeSlack.calls.length > callStart);
          }

          for (const point of ["in-flight", "after-settled"] as const) {
            for (const scenario of [
              {
                action: "publish",
                expectedMethod: "chat.startStream",
                kind: "native-start",
              },
              {
                action: "append",
                expectedMethod: "chat.appendStream",
                kind: "native-append",
              },
              {
                action: "stop",
                expectedMethod: "chat.stopStream",
                kind: "native-stop",
              },
            ] as const) {
              const root = yield* makeTempDirectoryScoped(
                `laborer-stream-${point}-${scenario.kind}-`
              );
              const callStart = fakeSlack.calls.length;
              const worker = spawnTracked({
                action: scenario.action,
                crashAt: point,
                crashKind: scenario.kind,
                root,
                serverUrl: fakeSlack.url,
              });
              yield* crash(worker, `CRASH:${point}:${scenario.kind}`);
              const callsBeforeRecovery = fakeSlack.calls.length;
              const recovered = yield* Effect.promise(() =>
                runWorker({ action: "recover", root, serverUrl: fakeSlack.url })
              );
              assert.strictEqual(
                fakeSlack.calls.length - callsBeforeRecovery,
                point === "after-settled" && scenario.kind !== "native-stop"
                  ? 1
                  : 0,
                `${point}:${scenario.kind}`
              );
              assert.strictEqual(
                fakeSlack.calls
                  .slice(callStart)
                  .filter(({ method }) => method === scenario.expectedMethod)
                  .length,
                point === "in-flight" ? 0 : 1
              );
              assert.strictEqual(
                onlyStream(recovered).lifecycle,
                point === "in-flight" ? "unresolved" : "stopped"
              );
            }
          }

          for (let appendIndex = 0; appendIndex < 3; appendIndex += 1) {
            const root = yield* makeTempDirectoryScoped(
              `laborer-stream-multi-append-${appendIndex}-`
            );
            const callStart = fakeSlack.calls.length;
            const worker = spawnTracked({
              action: "multi-append",
              crashAt: "after-request",
              crashKind: "native-append",
              crashOperationIndex: appendIndex,
              root,
              serverUrl: fakeSlack.url,
            });
            yield* crash(worker, "CRASH:after-request:native-append");
            const callsBeforeRecovery = fakeSlack.calls.length;
            const recovered = yield* Effect.promise(() =>
              runWorker({ action: "recover", root, serverUrl: fakeSlack.url })
            );
            assert.strictEqual(fakeSlack.calls.length, callsBeforeRecovery);
            assert.strictEqual(onlyStream(recovered).lifecycle, "unresolved");
            assert.strictEqual(
              fakeSlack.calls
                .slice(callStart)
                .filter(({ method }) => method === "chat.appendStream").length,
              appendIndex + 1
            );
          }

          for (const point of [
            "prepared",
            "in-flight",
            "after-request",
            "after-settled",
          ] as const) {
            for (const scenario of [
              {
                action: "publish",
                expectedMethod: "chat.postMessage",
                kind: "fallback-post",
              },
              {
                action: "append",
                expectedMethod: "chat.update",
                kind: "fallback-update",
              },
            ] as const) {
              const root = yield* makeTempDirectoryScoped(
                `laborer-stream-fallback-${point}-${scenario.kind}-`
              );
              const callStart = fakeSlack.calls.length;
              const worker = spawnTracked({
                action: scenario.action,
                crashAt: point,
                crashKind: scenario.kind,
                root,
                serverUrl: fakeSlack.url,
                transport: "fallback",
              });
              yield* crash(worker, `CRASH:${point}:${scenario.kind}`);
              const callsBeforeRecovery = fakeSlack.calls.length;
              const recovered = yield* Effect.promise(() =>
                runWorker({
                  action: "recover",
                  root,
                  serverUrl: fakeSlack.url,
                  transport: "fallback",
                })
              );
              const targetCalls = fakeSlack.calls
                .slice(callStart)
                .filter(
                  ({ method }) => method === scenario.expectedMethod
                ).length;
              const isConvergentUnknownUpdate =
                scenario.kind === "fallback-update" &&
                point === "after-request";
              const requestWasSentBeforeCrash =
                point === "after-request" || point === "after-settled";
              const ordinarilySentOrRecovered =
                requestWasSentBeforeCrash ||
                point === "prepared" ||
                scenario.kind === "fallback-update";
              const expectedTargetCalls = isConvergentUnknownUpdate
                ? 2
                : Number(ordinarilySentOrRecovered);
              assert.strictEqual(
                targetCalls,
                expectedTargetCalls,
                `${point}:${scenario.kind}`
              );
              assert.ok(fakeSlack.calls.length >= callsBeforeRecovery);
              assert.strictEqual(
                onlyStream(recovered).lifecycle,
                scenario.kind === "fallback-post" &&
                  (point === "in-flight" || point === "after-request")
                  ? "unresolved"
                  : "stopped"
              );
            }
          }

          const beforeFinalizeRoot = yield* makeTempDirectoryScoped(
            "laborer-stream-before-finalize-"
          );
          const beforeFinalizeCallStart = fakeSlack.calls.length;
          const beforeFinalize = spawnTracked({
            action: "publish-before-finalize",
            root: beforeFinalizeRoot,
            serverUrl: fakeSlack.url,
          });
          yield* crash(beforeFinalize, "CRASH:before-finalize");
          const finalizedAfterRestart = yield* Effect.promise(() =>
            runWorker({
              action: "finalize",
              root: beforeFinalizeRoot,
              serverUrl: fakeSlack.url,
            })
          );
          assert.strictEqual(
            onlyStream(finalizedAfterRestart).lifecycle,
            "stopped"
          );
          assert.deepStrictEqual(
            fakeSlack.calls
              .slice(beforeFinalizeCallStart)
              .map(({ method }) => method),
            ["chat.startStream", "chat.stopStream"]
          );

          for (const localCompletion of [
            {
              action: "empty-before-finalize",
              marker: "CRASH:before-local-completion",
              restartAction: "finalize",
            },
            {
              action: "empty-finalize",
              marker: "CRASH:after-local-completion",
              restartAction: "recover",
            },
          ] as const) {
            const root = yield* makeTempDirectoryScoped(
              `laborer-stream-${localCompletion.action}-`
            );
            const callStart = fakeSlack.calls.length;
            const worker = spawnTracked({
              action: localCompletion.action,
              root,
              serverUrl: fakeSlack.url,
            });
            yield* crash(worker, localCompletion.marker);
            const recovered = yield* Effect.promise(() =>
              runWorker({
                action: localCompletion.restartAction,
                root,
                serverUrl: fakeSlack.url,
              })
            );
            assert.strictEqual(onlyStream(recovered).lifecycle, "stopped");
            assert.strictEqual(fakeSlack.calls.length, callStart);
          }

          const rateLimitRoot = yield* makeTempDirectoryScoped(
            "laborer-stream-rate-limit-kill-"
          );
          const rateLimitCallStart = fakeSlack.calls.length;
          fakeSlack.setBehavior("rate-limit-once");
          const rateLimited = spawnTracked({
            action: "publish",
            root: rateLimitRoot,
            serverUrl: fakeSlack.url,
          });
          yield* Effect.promise(() =>
            waitForRetryState(join(rateLimitRoot, "runner.json"))
          );
          yield* Effect.promise(() => killWorker(rateLimited));
          const rateLimitRecovered = yield* Effect.promise(() =>
            runWorker({
              action: "continue",
              root: rateLimitRoot,
              serverUrl: fakeSlack.url,
            })
          );
          assert.strictEqual(
            onlyStream(rateLimitRecovered).lifecycle,
            "stopped"
          );
          assert.deepStrictEqual(
            fakeSlack.calls
              .slice(rateLimitCallStart)
              .map(({ method, outcome }) => `${method}:${outcome}`),
            [
              "chat.startStream:rate-limited",
              "chat.startStream:success",
              "chat.appendStream:success",
              "chat.stopStream:success",
            ]
          );

          const timeoutRoot = yield* makeTempDirectoryScoped(
            "laborer-stream-timeout-"
          );
          const timeoutCallStart = fakeSlack.calls.length;
          fakeSlack.setBehavior("timeout-once");
          const timedOut = yield* Effect.promise(() =>
            runWorker({
              action: "publish-result",
              root: timeoutRoot,
              serverUrl: fakeSlack.url,
            })
          );
          assert.strictEqual(onlyStream(timedOut).lifecycle, "unresolved");
          const timeoutCalls = fakeSlack.calls.length;
          const afterTimeoutRestart = yield* Effect.promise(() =>
            runWorker({
              action: "recover",
              root: timeoutRoot,
              serverUrl: fakeSlack.url,
            })
          );
          assert.strictEqual(
            onlyStream(afterTimeoutRestart).lifecycle,
            "unresolved"
          );
          assert.strictEqual(fakeSlack.calls.length, timeoutCalls);
          assert.strictEqual(timeoutCalls - timeoutCallStart, 1);

          for (const transport of ["fallback", "native"] as const) {
            const productionRoot = yield* makeTempDirectoryScoped(
              `laborer-production-stream-crash-${transport}-`
            );
            const productionControls = yield* makeTempDirectoryScoped(
              `laborer-production-stream-crash-controls-${transport}-`
            );
            const productionCallStart = fakeSlack.calls.length;
            const productionWorker = spawnTracked({
              action: "production",
              controls: productionControls,
              root: productionRoot,
              serverUrl: fakeSlack.url,
              transport,
              workerPath: PRODUCTION_WORKER_PATH,
            });
            yield* Effect.promise(() =>
              waitForLine(productionWorker, "PARTIAL_ACKNOWLEDGED")
            );
            yield* Effect.promise(() => killWorker(productionWorker));
            const productionRecovery = spawnTracked({
              action: "production-recover",
              controls: productionControls,
              root: productionRoot,
              serverUrl: fakeSlack.url,
              transport,
              workerPath: PRODUCTION_WORKER_PATH,
            });
            yield* Effect.promise(() =>
              waitForLine(productionRecovery, "RECOVERY_STARTED")
            );
            const callsBeforeDelayedRecovery = fakeSlack.calls.length;
            yield* Effect.sleep("3500 millis");
            const productionPaths = yield* prepareSlackRuntimePaths(
              productionRoot,
              PRODUCTION_WORKSPACE_ID
            );
            const delayedRecoveryState = Schema.decodeUnknownSync(
              PrototypeState
            )(
              JSON.parse(
                yield* Effect.promise(() =>
                  readFile(productionPaths.runnerState, "utf8")
                )
              ) as unknown
            );
            assert.strictEqual(
              delayedRecoveryState.conversationStreams[0]?.lifecycle,
              "open",
              transport
            );
            assert.strictEqual(
              delayedRecoveryState.conversationStreamTombstones.length,
              0,
              transport
            );
            assert.deepStrictEqual(
              fakeSlack.calls
                .slice(callsBeforeDelayedRecovery)
                .filter(({ method }) => method.startsWith("chat.")),
              [],
              transport
            );
            const partialMessages = [...fakeSlack.messages.values()].filter(
              ({ text }) => text === ACP_PARTIAL_TEXT
            );
            assert.deepStrictEqual(
              partialMessages,
              [{ stopped: false, text: ACP_PARTIAL_TEXT }],
              transport
            );
            yield* Effect.promise(() =>
              writeFile(join(productionControls, "release"), "release", {
                mode: 0o600,
              })
            );
            const resultLine = yield* Effect.promise(() =>
              waitForLine(productionRecovery, "RESULT:")
            );
            yield* Effect.promise(() => waitForExit(productionRecovery));
            const productionRecovered = Schema.decodeUnknownSync(
              PrototypeState
            )(JSON.parse(resultLine.slice("RESULT:".length)) as unknown);
            const productionStream = onlyStream(productionRecovered);
            assert.strictEqual(productionStream.acceptedSequence, 1, transport);
            assert.strictEqual(
              productionStream.lifecycle,
              "stopped",
              transport
            );
            const productionCalls = fakeSlack.calls.slice(productionCallStart);
            const messageIds = new Set(
              productionCalls.flatMap(({ method, ts }) =>
                (method === "chat.postMessage" ||
                  method === "chat.startStream") &&
                ts !== null
                  ? [ts]
                  : []
              )
            );
            assert.strictEqual(messageIds.size, 1, transport);
            const [messageId] = messageIds;
            assert.deepStrictEqual(
              fakeSlack.messages.get(messageId ?? ""),
              {
                stopped: transport === "native",
                text: `${ACP_PARTIAL_TEXT}\n\n- complete\n- unchanged`,
              },
              transport
            );
            assert.deepStrictEqual(
              productionCalls
                .filter(({ method }) => method.startsWith("chat."))
                .map(({ method }) => method),
              transport === "native"
                ? ["chat.startStream", "chat.appendStream", "chat.stopStream"]
                : ["chat.postMessage", "chat.update"],
              transport
            );
          }
        })
      ),
    60_000
  );
});
