/** Opt-in ACP stable-v1 conversation-agent proof for issues #234 and #236. */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  type ActiveSession,
  type ActiveSessionMessage,
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import { Effect, Exit, Schema, Scope, Semaphore } from "effect";
import { HandlerFailure } from "../prototype/errors.ts";
import type {
  ConversationAgentRequest,
  ConversationAgentShape,
  PublishConversationAgentMessage,
} from "../reference-coding-application.ts";
import {
  type AcpAgentContextSources,
  loadAcpAgentContextSnapshot,
  renderAcpPrompt,
  renderAcpPromptWithinByteLimit,
} from "./agent-context.ts";

const MAX_PROMPT_BYTES = 256 * 1024;
const MAX_PUBLIC_OUTPUT_BYTES = 1024 * 1024;
const MAX_PUBLIC_MESSAGES = 32;
const CHILD_EXIT_GRACE_MILLIS = 2000;
const MAX_ACP_NDJSON_LINE_BYTES = 2 * 1024 * 1024;
const MAX_ACP_INBOUND_PROCESS_BYTES = 256 * 1024 * 1024;
const MAX_ACP_INBOUND_PROCESS_RECORDS = 250_000;
const NEWLINE_BYTE = 0x0a;
const textEncoder = new TextEncoder();

class AcpConversationFailure extends Schema.TaggedErrorClass<AcpConversationFailure>()(
  "AcpConversationFailure",
  {
    operation: Schema.Literals(["initialize", "prompt", "session", "spawn"]),
  }
) {}

export interface AcpConversationAgentOptions {
  readonly agentContext?: AcpAgentContextSources;
  readonly args?: readonly string[];
  readonly childExitGraceMillis?: number;
  readonly command: string;
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly inboundLimits?: {
    readonly maxLineBytes?: number;
    readonly maxProcessBytes?: number;
    readonly maxProcessRecords?: number;
  };
}

interface AcpInboundLimits {
  readonly maxLineBytes: number;
  readonly maxProcessBytes: number;
  readonly maxProcessRecords: number;
}

interface AcquiredChild {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exitListener: (
    code: number | null,
    signal: NodeJS.Signals | null
  ) => void;
  readonly releaseState: { requested: boolean };
  readonly runtimeErrorListener: (cause: Error) => void;
}

interface ActivePrompt {
  readonly cancellation: AbortController;
  readonly completion: Promise<
    import("@agentclientprotocol/sdk").PromptResponse
  >;
}

interface ManagedSession {
  needsInitialContext: boolean;
  readonly session: ActiveSession;
}

const failure = (
  operation: AcpConversationFailure["operation"]
): AcpConversationFailure => AcpConversationFailure.make({ operation });

const toHandlerFailure = (): HandlerFailure =>
  HandlerFailure.make({
    category: "protocol",
    noticeStyle: "generic",
    safeDetail: "ACP Conversation agent failed",
  });

const awaitChildExit = (
  child: ChildProcessWithoutNullStreams,
  timeoutMillis: number
): Promise<boolean> =>
  new Promise((resolveExit) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveExit(true);
      return;
    }
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      resolveExit(false);
    }, timeoutMillis);
    const onExit = (): void => {
      clearTimeout(timeout);
      resolveExit(true);
    };
    child.once("exit", onExit);
  });

const awaitPromptSettlement = (
  completion: ActivePrompt["completion"],
  timeoutMillis: number
): Promise<boolean> =>
  new Promise((resolveSettlement) => {
    const timeout = setTimeout(() => {
      resolveSettlement(false);
    }, timeoutMillis);
    completion.then(
      () => {
        clearTimeout(timeout);
        resolveSettlement(true);
      },
      () => {
        clearTimeout(timeout);
        resolveSettlement(true);
      }
    );
  });

const configuredChildExitGraceMillis = (
  options: AcpConversationAgentOptions
): number => {
  const configured = options.childExitGraceMillis;
  return configured !== undefined &&
    Number.isSafeInteger(configured) &&
    configured > 0
    ? configured
    : CHILD_EXIT_GRACE_MILLIS;
};

const positiveSafeIntegerOr = (
  candidate: number | undefined,
  fallback: number
): number =>
  candidate !== undefined && Number.isSafeInteger(candidate) && candidate > 0
    ? candidate
    : fallback;

const configuredInboundLimits = (
  options: AcpConversationAgentOptions
): AcpInboundLimits => ({
  maxLineBytes: positiveSafeIntegerOr(
    options.inboundLimits?.maxLineBytes,
    MAX_ACP_NDJSON_LINE_BYTES
  ),
  maxProcessBytes: positiveSafeIntegerOr(
    options.inboundLimits?.maxProcessBytes,
    MAX_ACP_INBOUND_PROCESS_BYTES
  ),
  maxProcessRecords: positiveSafeIntegerOr(
    options.inboundLimits?.maxProcessRecords,
    MAX_ACP_INBOUND_PROCESS_RECORDS
  ),
});

const terminateChild = async (
  child: ChildProcessWithoutNullStreams,
  graceMillis: number
): Promise<void> => {
  if (!child.stdin.destroyed) {
    child.stdin.end();
  }
  if (await awaitChildExit(child, graceMillis)) {
    return;
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
  }
  if (await awaitChildExit(child, graceMillis)) {
    return;
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
  if (!(await awaitChildExit(child, graceMillis))) {
    throw new Error("ACP child did not settle after SIGKILL");
  }
};

const releaseChild = (
  acquired: AcquiredChild,
  graceMillis: number
): Effect.Effect<void> =>
  Effect.promise(async () => {
    acquired.releaseState.requested = true;
    try {
      await terminateChild(acquired.child, graceMillis);
    } finally {
      acquired.child.off("exit", acquired.exitListener);
      acquired.child.off("error", acquired.runtimeErrorListener);
    }
  });

const acquireChild = (
  options: AcpConversationAgentOptions
): Effect.Effect<AcquiredChild, AcpConversationFailure> =>
  Effect.callback<AcquiredChild, AcpConversationFailure>((resume) => {
    let child: ChildProcessWithoutNullStreams;
    const graceMillis = configuredChildExitGraceMillis(options);
    try {
      child = spawn(options.command, [...(options.args ?? [])], {
        cwd: options.cwd,
        env: options.environment ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      resume(failure("spawn"));
      return;
    }

    let acquired: AcquiredChild | undefined;
    const onStartupError = (): void => {
      child.off("spawn", onSpawn);
      resume(
        Effect.promise(() => terminateChild(child, graceMillis)).pipe(
          Effect.andThen(failure("spawn"))
        )
      );
    };
    const onSpawn = (): void => {
      child.off("error", onStartupError);
      const releaseState = { requested: false };
      const failTransport = (cause: Error): void => {
        if (releaseState.requested) {
          return;
        }
        child.stdout.destroy(cause);
        child.stdin.destroy();
      };
      const runtimeErrorListener = (cause: Error): void => {
        failTransport(
          new Error("ACP child process failed after startup", { cause })
        );
      };
      const exitListener = (
        code: number | null,
        signal: NodeJS.Signals | null
      ): void => {
        if (releaseState.requested) {
          return;
        }
        failTransport(
          new Error(
            `ACP child exited unexpectedly (${signal ?? String(code ?? "unknown")})`
          )
        );
      };
      acquired = {
        child,
        exitListener,
        releaseState,
        runtimeErrorListener,
      };
      child.on("error", runtimeErrorListener);
      child.on("exit", exitListener);
      child.stderr.resume();
      resume(Effect.succeed(acquired));
    };
    child.once("error", onStartupError);
    child.once("spawn", onSpawn);
    return Effect.promise(async () => {
      const cleanupErrorListener = (): void => {
        // Interruption owns cleanup; consume a concurrent spawn error while reaping.
      };
      child.off("spawn", onSpawn);
      child.off("error", onStartupError);
      child.on("error", cleanupErrorListener);
      if (acquired !== undefined) {
        acquired.releaseState.requested = true;
        child.off("exit", acquired.exitListener);
        child.off("error", acquired.runtimeErrorListener);
      }
      try {
        await terminateChild(child, graceMillis);
      } finally {
        child.off("error", cleanupErrorListener);
      }
    });
  });

const boundedNdJsonInput = (
  input: ReadableStream<Uint8Array>,
  limits: AcpInboundLimits
): ReadableStream<Uint8Array> => {
  let lineBytes = 0;
  let processBytes = 0;
  let processRecords = 0;
  return input.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        processBytes += chunk.byteLength;
        if (processBytes > limits.maxProcessBytes) {
          throw new Error("ACP input exceeded its process-lifetime byte limit");
        }
        for (const byte of chunk) {
          if (byte === NEWLINE_BYTE) {
            if (lineBytes > 0) {
              processRecords += 1;
              if (processRecords > limits.maxProcessRecords) {
                throw new Error(
                  "ACP input exceeded its process-lifetime record limit"
                );
              }
            }
            lineBytes = 0;
            continue;
          }
          lineBytes += 1;
          if (lineBytes > limits.maxLineBytes) {
            throw new Error("ACP NDJSON line exceeded its byte limit");
          }
        }
        controller.enqueue(chunk);
      },
    })
  );
};

const nextSessionUpdate = (
  session: ActiveSession,
  signal: AbortSignal
): Promise<ActiveSessionMessage> =>
  new Promise((resolveUpdate, rejectUpdate) => {
    if (signal.aborted) {
      rejectUpdate(signal.reason);
      return;
    }
    const onAbort = (): void => {
      rejectUpdate(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    session.nextUpdate().then(
      (update) => {
        signal.removeEventListener("abort", onAbort);
        resolveUpdate(update);
      },
      (cause: unknown) => {
        signal.removeEventListener("abort", onAbort);
        rejectUpdate(cause);
      }
    );
  });

const publicTextChunk = (
  update: SessionUpdate
): {
  readonly messageId: string | null | undefined;
  readonly text: string;
} | null => {
  if (
    update.sessionUpdate !== "agent_message_chunk" ||
    update.content.type !== "text" ||
    update.content.text.length === 0
  ) {
    return null;
  }
  return { messageId: update.messageId, text: update.content.text };
};

const runPrompt = Effect.fn("AcpConversationAgent.runPrompt")(function* (
  session: ActiveSession,
  request: ConversationAgentRequest,
  requiredInput: string,
  agentContext: AcpAgentContextSources | undefined,
  needsInitialContext: boolean,
  markInitialContextSent: () => void,
  publishMessage: PublishConversationAgentMessage,
  invalidate: (prompt: ActivePrompt) => Effect.Effect<void>
) {
  if (textEncoder.encode(requiredInput).byteLength > MAX_PROMPT_BYTES) {
    return yield* failure("prompt");
  }
  const input =
    agentContext === undefined || !needsInitialContext
      ? requiredInput
      : yield* renderAcpPromptWithinByteLimit(
          request,
          yield* loadAcpAgentContextSnapshot(agentContext),
          MAX_PROMPT_BYTES
        );
  return yield* Effect.acquireUseRelease(
    Effect.sync(() => {
      const cancellation = new AbortController();
      const completion = session.prompt(input, {
        cancellationSignal: cancellation.signal,
      });
      markInitialContextSent();
      completion.catch(() => undefined);
      return { cancellation, completion };
    }),
    (prompt) =>
      Effect.gen(function* () {
        let outputBytes = 0;
        const messageIds = new Set<string>();
        const fallbackMessageId = `${request.promptId}:message`;
        while (true) {
          const message = yield* Effect.tryPromise({
            try: (signal) => nextSessionUpdate(session, signal),
            catch: () => failure("prompt"),
          });
          if (message.kind === "stop") {
            yield* Effect.tryPromise({
              try: () => prompt.completion,
              catch: () => failure("prompt"),
            });
            return [];
          }
          const chunk = publicTextChunk(message.update);
          if (chunk === null) {
            continue;
          }
          const messageId = chunk.messageId ?? fallbackMessageId;
          messageIds.add(messageId);
          outputBytes += textEncoder.encode(chunk.text).byteLength;
          if (
            messageIds.size > MAX_PUBLIC_MESSAGES ||
            outputBytes > MAX_PUBLIC_OUTPUT_BYTES
          ) {
            return yield* failure("prompt");
          }
          yield* publishMessage({
            messageId,
            text: chunk.text,
          });
        }
      }),
    (prompt, exit) => (Exit.isSuccess(exit) ? Effect.void : invalidate(prompt))
  );
});

export const makeAcpConversationAgent = Effect.fn("makeAcpConversationAgent")(
  function* (
    options: AcpConversationAgentOptions
  ): Effect.fn.Return<ConversationAgentShape, HandlerFailure, Scope.Scope> {
    const constructionScope = yield* Scope.make();
    const setup = Effect.gen(function* () {
      const exitGraceMillis = configuredChildExitGraceMillis(options);
      const acquiredChild = yield* Effect.acquireRelease(
        acquireChild(options),
        (acquired) => releaseChild(acquired, exitGraceMillis)
      ).pipe(Effect.mapError(toHandlerFailure));
      const { child } = acquiredChild;
      const output = Writable.toWeb(child.stdin);
      const childOutput = Readable.toWeb(
        child.stdout
      ) as ReadableStream<Uint8Array>;
      const input = boundedNdJsonInput(
        childOutput,
        configuredInboundLimits(options)
      );
      const connection = client({
        name: "laborer-acp-conversation-proof",
      }).connect(ndJsonStream(output, input));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          connection.close();
        })
      );
      const initialized = yield* Effect.tryPromise({
        try: () =>
          connection.agent.request(methods.agent.initialize, {
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: {},
          }),
        catch: () => failure("initialize"),
      }).pipe(Effect.mapError(toHandlerFailure));
      if (
        PROTOCOL_VERSION !== 1 ||
        initialized.protocolVersion !== PROTOCOL_VERSION
      ) {
        return yield* toHandlerFailure();
      }

      const sessions = new Map<string, ManagedSession>();
      const turnGates = new Map<string, Semaphore.Semaphore>();
      const turnGateRegistrySemaphore = yield* Semaphore.make(1);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const managed of sessions.values()) {
            managed.session.dispose();
          }
          sessions.clear();
          turnGates.clear();
        })
      );

      const turnGateFor = (conversationId: string) =>
        turnGateRegistrySemaphore.withPermit(
          Effect.sync(() => {
            const existing = turnGates.get(conversationId);
            if (existing !== undefined) {
              return existing;
            }
            const created = Semaphore.makeUnsafe(1);
            turnGates.set(conversationId, created);
            return created;
          })
        );

      const sessionFor = Effect.fn("AcpConversationAgent.sessionFor")(
        function* (conversationId: string) {
          const existing = sessions.get(conversationId);
          if (existing !== undefined) {
            return existing;
          }
          return yield* Effect.uninterruptible(
            Effect.tryPromise({
              try: () => connection.agent.buildSession(options.cwd).start(),
              catch: () => failure("session"),
            }).pipe(
              Effect.map((session) => {
                const created: ManagedSession = {
                  needsInitialContext: options.agentContext !== undefined,
                  session,
                };
                sessions.set(conversationId, created);
                return created;
              })
            )
          );
        }
      );

      const invalidateSession = (
        conversationId: string,
        session: ActiveSession
      ) =>
        Effect.fnUntraced(function* (prompt: ActivePrompt) {
          prompt.cancellation.abort();
          yield* Effect.tryPromise({
            try: () =>
              connection.agent.notify(methods.agent.session.cancel, {
                sessionId: session.sessionId,
              }),
            catch: () => undefined,
          }).pipe(Effect.ignore);
          session.dispose();
          if (sessions.get(conversationId)?.session === session) {
            sessions.delete(conversationId);
          }
          const settled = yield* Effect.promise(() =>
            awaitPromptSettlement(prompt.completion, CHILD_EXIT_GRACE_MILLIS)
          );
          if (!settled) {
            connection.close();
            yield* releaseChild(acquiredChild, exitGraceMillis);
          }
        });

      const handle: ConversationAgentShape["handle"] = (
        request,
        publishMessage
      ) => {
        if (publishMessage === undefined) {
          return toHandlerFailure();
        }
        return Effect.gen(function* () {
          const turnGate = yield* turnGateFor(request.conversationId);
          return yield* turnGate.withPermit(
            Effect.gen(function* () {
              const requiredInput =
                options.agentContext === undefined
                  ? request.input
                  : renderAcpPrompt(request);
              if (
                textEncoder.encode(requiredInput).byteLength > MAX_PROMPT_BYTES
              ) {
                return yield* failure("prompt");
              }
              const managed = yield* sessionFor(request.conversationId);
              return yield* runPrompt(
                managed.session,
                request,
                requiredInput,
                options.agentContext,
                managed.needsInitialContext,
                () => {
                  managed.needsInitialContext = false;
                },
                publishMessage,
                invalidateSession(request.conversationId, managed.session)
              );
            })
          );
        }).pipe(
          Effect.catchTag("AcpConversationFailure", () => toHandlerFailure())
        );
      };

      return {
        handle,
        recover: handle,
      };
    }).pipe(Effect.provideService(Scope.Scope, constructionScope));
    return yield* setup.pipe(
      Effect.tap(() =>
        Effect.addFinalizer((exit) => Scope.close(constructionScope, exit))
      ),
      Effect.onExit((exit) =>
        Exit.isFailure(exit)
          ? Scope.close(constructionScope, exit)
          : Effect.void
      )
    );
  }
);
