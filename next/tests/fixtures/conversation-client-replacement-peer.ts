import { spawn } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { layer as makeSqliteLayer } from "@effect/sql-sqlite-node/SqliteClient";
import { Effect, Schema } from "effect";
import {
  ApplicationConversationMessageChunk,
  type ApplicationEvent,
  ParticipantInputEvent,
} from "../../src/application.ts";
import {
  defineAction,
  defineApplication,
} from "../../src/durable-runtime/action.ts";
import {
  ExecutionEvent,
  makeRootDurableRuntimeLayer,
  RootDurableRuntime,
  type RootDurableRuntimeShape,
} from "../../src/durable-runtime/root-runtime.ts";
import {
  attachConversationClientLocally,
  ROOT_RUNTIME_PROTOCOL_VERSION,
} from "../../src/durable-runtime/rpc.ts";
import {
  MessageId,
  NormalizedMessage,
  ThreadId,
  TurnId,
} from "../../src/prototype/domain.ts";

const root = process.argv[2];
if (root === undefined) {
  throw new Error("missing fixture root");
}

const workspaceId = "T-REPLACEMENT";
const rootIdentity = "root-client-replacement-fixture";
const conversationId = ThreadId.make("workspace:T-REPLACEMENT:thread:C1:1.0");
const actionPeer = resolve(
  process.cwd(),
  "tests/fixtures/conversation-client-replacement-action.ts"
);
const fileExists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false
  );

const waitUntil = Effect.fn("clientReplacementWaitUntil")(function* (
  predicate: () => boolean | Promise<boolean>,
  label: string
) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (yield* Effect.promise(() => Promise.resolve(predicate()))) {
      return;
    }
    yield* Effect.sleep("10 millis");
  }
  return yield* Effect.die(new Error(`timed out waiting for ${label}`));
});

const waitForTerminal = Effect.fn("clientReplacementWaitForTerminal")(
  function* (runtime: RootDurableRuntimeShape, executionId: string) {
    let status = "missing";
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const execution = yield* runtime.getExecution(
        executionId,
        conversationId,
        workspaceId
      );
      status = execution.status;
      if (status === "completed" || status === "failed") {
        return execution;
      }
      yield* Effect.sleep("10 millis");
    }
    return yield* Effect.die(
      new Error(`Execution did not settle from ${status}`)
    );
  }
);

const waitForPendingEvents = Effect.fn("clientReplacementWaitForPendingEvents")(
  function* (runtime: RootDurableRuntimeShape) {
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const pending = yield* runtime.pendingEvents(conversationId, workspaceId);
      if (pending.length > 0) {
        return pending;
      }
      yield* Effect.sleep("10 millis");
    }
    return yield* Effect.die(
      new Error("Execution became terminal without a durable pending event")
    );
  }
);

const runProcess = Effect.fn("runClientReplacementProcess")(function* (
  label: string,
  context: {
    readonly reportProgress: (
      id: string,
      value: unknown
    ) => Effect.Effect<void, unknown>;
  }
) {
  const pidPath = join(root, `${label}.pid`);
  const releasePath = join(root, `${label}.release`);
  const signalPath = join(root, `${label}.signals`);
  return yield* Effect.acquireUseRelease(
    Effect.sync(() =>
      spawn(
        process.execPath,
        [actionPeer, pidPath, releasePath, signalPath, label],
        { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] }
      )
    ),
    (child) =>
      Effect.gen(function* () {
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          stdout = `${stdout}${chunk}`.slice(-8192);
        });
        child.stderr.on("data", (chunk: string) => {
          stderr = `${stderr}${chunk}`.slice(-8192);
        });
        yield* waitUntil(() => fileExists(pidPath), `${label} PID`);
        yield* context.reportProgress("started", { phase: "started" });
        const exitCode = yield* Effect.callback<number>((resume) => {
          child.once("error", () => resume(Effect.succeed(-1)));
          child.once("close", (code) => resume(Effect.succeed(code ?? -1)));
        });
        if (exitCode !== 0) {
          return yield* Effect.die(
            new Error(`fixture process failed: ${stderr}`)
          );
        }
        return JSON.parse(stdout.trim()) as { readonly artifact: string };
      }),
    (child) =>
      Effect.sync(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      })
  );
});

const oldAction = defineAction({
  annotations: { idempotentHint: true },
  description: "Run the older blocked process fixture",
  input: Schema.Struct({ label: Schema.String }),
  name: "fixture/process-v1",
  recoveryPolicy: "idempotent-retry",
  result: Schema.Struct({ artifact: Schema.String }),
  revision: "process-v1",
  run: ({ label }, context) => runProcess(label, context),
});
const currentAction = defineAction({
  annotations: { idempotentHint: true },
  description: "Run the current blocked process fixture",
  input: Schema.Struct({ label: Schema.String }),
  name: "fixture/process-v2",
  recoveryPolicy: "idempotent-retry",
  result: Schema.Struct({ artifact: Schema.String }),
  revision: "process-v2",
  run: ({ label }, context) => runProcess(label, context),
});
const application = defineApplication({ actions: [oldAction, currentAction] });
const compatibility = {
  actionCatalogFingerprint: application.actions.fingerprint,
};

const turn = (id: string, text: string) =>
  ParticipantInputEvent.make({
    attemptNumber: 1,
    channelId: "C1",
    context: [],
    conversationId,
    initializationStatus: "not_applicable",
    messages: [
      NormalizedMessage.make({
        authorKind: "human",
        authorSlackId: "U1",
        classification: "input",
        id: MessageId.make(`message:${id}`),
        isActivation: id === "first",
        slackTs: id === "first" ? "1.0" : "2.0",
        text,
      }),
    ],
    rootTs: "1.0",
    source: "slack",
    turnId: TurnId.make(`turn:${id}`),
    workingDirectory: null,
  });

const clientHandler = (
  client: string,
  observed: {
    client: string;
    eventId: string;
    kind: string;
    sequence: number;
  }[]
) => ({
  handle: (event: ApplicationEvent) =>
    event._tag === "ParticipantInput"
      ? Effect.succeed([
          ApplicationConversationMessageChunk.make({
            messageId: `${client}:${event.turnId}`,
            text: `${client} handled input`,
          }),
        ])
      : Schema.decodeUnknownEffect(ExecutionEvent)(event.payload).pipe(
          Effect.tap((executionEvent) =>
            Effect.sync(() => {
              observed.push({
                client,
                eventId: executionEvent.eventId,
                kind: executionEvent.kind,
                sequence: executionEvent.sequence,
              });
            })
          ),
          Effect.as([])
        ),
});

const program = Effect.scoped(
  Effect.gen(function* () {
    const runtime = yield* RootDurableRuntime;
    const hostPid = process.pid;
    const firstObserved: {
      client: string;
      eventId: string;
      kind: string;
      sequence: number;
    }[] = [];
    const replacementObserved: typeof firstObserved = [];
    const first = yield* Effect.scoped(
      Effect.gen(function* () {
        yield* attachConversationClientLocally(
          runtime,
          {
            compatibility,
            protocolVersion: ROOT_RUNTIME_PROTOCOL_VERSION,
            workspaceId,
          },
          clientHandler("first", firstObserved)
        );
        const receipt = yield* runtime.runConversation({
          event: turn("first", "start old work"),
          rootIdentity,
          workspaceId,
        });
        const executions = yield* Effect.forEach(["old-a", "old-b"], (label) =>
          runtime.startExecution({
            actionName: oldAction.name,
            conversationId,
            input: { label },
            invocationId: `invocation:${label}`,
            rootIdentity,
            workspaceId,
          })
        );
        yield* waitUntil(
          async () =>
            (await fileExists(join(root, "old-a.pid"))) &&
            (await fileExists(join(root, "old-b.pid"))),
          "old Action processes"
        );
        yield* waitUntil(
          () => firstObserved.length === 2,
          "first-client progress"
        );
        return { executions, receipt };
      })
    );
    const actionPidsBefore = yield* Effect.forEach(
      ["old-a", "old-b"],
      (label) =>
        Effect.promise(() => readFile(join(root, `${label}.pid`), "utf8"))
    );

    const incompatibleProtocol = yield* Effect.flip(
      Effect.scoped(
        attachConversationClientLocally(
          runtime,
          {
            compatibility,
            protocolVersion: ROOT_RUNTIME_PROTOCOL_VERSION + 1,
            workspaceId,
          },
          clientHandler("bad-protocol", replacementObserved)
        )
      )
    );
    const incompatibleCatalog = yield* Effect.flip(
      Effect.scoped(
        attachConversationClientLocally(
          runtime,
          {
            compatibility: { actionCatalogFingerprint: "x".repeat(43) },
            protocolVersion: ROOT_RUNTIME_PROTOCOL_VERSION,
            workspaceId,
          },
          clientHandler("bad-catalog", replacementObserved)
        )
      )
    );

    yield* Effect.promise(() =>
      writeFile(join(root, "old-a.release"), "release", { mode: 0o600 })
    );
    const detachedCompletion = yield* waitForTerminal(
      runtime,
      first.executions[0]?.executionId ?? "missing"
    );
    // The terminal snapshot and its outbox event settle in consecutive
    // workflow steps. Wait for the durable event rather than racing that
    // internal handoff after observing the terminal snapshot.
    const pendingWithoutClient = yield* waitForPendingEvents(runtime);
    const secondPid = Number(actionPidsBefore[1]);
    process.kill(secondPid, 0);

    const replacement = yield* Effect.scoped(
      Effect.gen(function* () {
        yield* attachConversationClientLocally(
          runtime,
          {
            compatibility,
            protocolVersion: ROOT_RUNTIME_PROTOCOL_VERSION,
            workspaceId,
          },
          clientHandler("replacement", replacementObserved)
        );
        yield* waitUntil(
          () =>
            replacementObserved.some(
              ({ eventId }) =>
                eventId ===
                `execution:${first.executions[0]?.executionId}:terminal`
            ),
          "detached completion delivery"
        );
        const receipt = yield* runtime.runConversation({
          event: turn("replacement", "start current work"),
          rootIdentity,
          workspaceId,
        });
        const execution = yield* runtime.startExecution({
          actionName: currentAction.name,
          conversationId,
          input: { label: "new-c" },
          invocationId: "invocation:new-c",
          rootIdentity,
          workspaceId,
        });
        yield* waitUntil(
          () => fileExists(join(root, "new-c.pid")),
          "new Action process"
        );
        const oldBWhileNewRuns = yield* runtime.getExecution(
          first.executions[1]?.executionId ?? "missing",
          conversationId,
          workspaceId
        );
        yield* Effect.forEach(["old-b", "new-c"], (label) =>
          Effect.promise(() =>
            writeFile(join(root, `${label}.release`), "release", {
              mode: 0o600,
            })
          )
        );
        const settled = yield* Effect.forEach(
          [
            first.executions[1]?.executionId ?? "missing",
            execution.executionId,
          ],
          (executionId) => waitForTerminal(runtime, executionId),
          { concurrency: "unbounded" }
        );
        yield* waitUntil(
          () => replacementObserved.length === 4,
          "replacement event delivery"
        );
        return { execution, oldBWhileNewRuns, receipt, settled };
      })
    );
    const actionPidsAfter = yield* Effect.forEach(["old-a", "old-b"], (label) =>
      Effect.promise(() => readFile(join(root, `${label}.pid`), "utf8"))
    );
    const signals = yield* Effect.forEach(
      ["old-a", "old-b", "new-c"],
      (label) =>
        Effect.promise(async () =>
          (await fileExists(join(root, `${label}.signals`)))
            ? readFile(join(root, `${label}.signals`), "utf8")
            : ""
        )
    );
    const pendingAfterReplacement = yield* runtime.pendingEvents(
      conversationId,
      workspaceId
    );

    process.stdout.write(
      `CLIENT_REPLACEMENT_EVIDENCE:${JSON.stringify({
        actionPidsAfter,
        actionPidsBefore,
        detachedCompletion,
        firstObserved,
        hostPidAfter: process.pid,
        hostPidBefore: hostPid,
        incompatibleCatalog: incompatibleCatalog.reason,
        incompatibleProtocol: incompatibleProtocol.reason,
        pendingAfterReplacement: pendingAfterReplacement.length,
        pendingWithoutClient: pendingWithoutClient.map(
          ({ eventId }) => eventId
        ),
        replacementExecution: replacement.execution,
        replacementObserved,
        replacementSessionId: replacement.receipt.sessionId,
        firstSessionId: first.receipt.sessionId,
        oldBWhileNewRuns: replacement.oldBWhileNewRuns.status,
        signals,
      })}\n`
    );
  }).pipe(
    Effect.provide(
      makeRootDurableRuntimeLayer(
        makeSqliteLayer({ filename: join(root, "runtime.sqlite") }),
        application.actions,
        rootIdentity
      )
    )
  )
);

await Effect.runPromise(program);
