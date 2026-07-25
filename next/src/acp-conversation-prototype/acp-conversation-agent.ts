/** Opt-in ACP stable-v1 conversation-agent proof for issues #234–#241. */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  type ActiveSessionMessage,
  client,
  type McpServerStdio,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type PromptResponse,
  RequestError,
  type SendRequestOptions,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import { Effect, Exit, Schema, Scope, Semaphore } from "effect";
import { HandlerFailure } from "../prototype/errors.ts";
import {
  assertNoSymlinkPathComponents,
  canonicalDirectory,
} from "../prototype/path-safety.ts";
import type {
  ConversationAgentRequest,
  ConversationAgentShape,
  PublishConversationAgentMessage,
} from "../reference-coding-application.ts";
import {
  type AcpAgentContextSnapshot,
  type AcpAgentContextSources,
  loadAcpAgentContextSnapshot,
  loadAcpSlackParticipantContexts,
  renderAcpPrompt,
  renderAcpPromptWithinByteLimit,
} from "./agent-context.ts";
import {
  type ConversationSessionStore,
  makeConversationSessionStore,
  type PersistedConversationSession,
  recordConversationSessionDiagnostic,
} from "./conversation-session-store.ts";
import {
  authorizeLaborerMemoryPermission,
  awaitLaborerMemoryMcpReadiness,
  type LaborerMemoryDiagnosticCode,
  type LaborerMemoryPermissionRegistration,
  laborerMemoryMcpAuthority,
  observeLaborerMemoryToolCall,
  type PreparedLaborerMemoryMcpRegistration,
  prepareLaborerMemoryMcpRegistration,
  recordLaborerMemoryDiagnostic,
  recordLaborerMemoryDiagnosticForSources,
} from "./memory-mcp.ts";
import type { SlackParticipantLookupShape } from "./slack-participant-lookup.ts";

const MAX_PROMPT_BYTES = 256 * 1024;
const MAX_PUBLIC_OUTPUT_BYTES = 1024 * 1024;
const MAX_PUBLIC_MESSAGES = 32;
const MEMORY_REGISTRATION_UNAVAILABLE = Symbol(
  "memory-registration-unavailable"
);
const CHILD_EXIT_GRACE_MILLIS = 2000;
const ACP_SESSION_ESTABLISH_TIMEOUT_MILLIS = 5000;
const ACP_SESSION_CLOSE_TIMEOUT_MILLIS = 2000;
const PINNED_OPENCODE_SESSION_LIST_PAGE_CEILING = 100;
const MAX_SESSION_LIST_ENTRIES = 1_000_000;
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

class AcpSessionUnavailable extends Schema.TaggedErrorClass<AcpSessionUnavailable>()(
  "AcpSessionUnavailable",
  {}
) {}

class AcpResumeNeedsAvailabilityCheck extends Schema.TaggedErrorClass<AcpResumeNeedsAvailabilityCheck>()(
  "AcpResumeNeedsAvailabilityCheck",
  {}
) {}

class AcpDefinitivePromptFailure extends Schema.TaggedErrorClass<AcpDefinitivePromptFailure>()(
  "AcpDefinitivePromptFailure",
  {}
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
  readonly laborerSlackId?: string;
  readonly memoryMcpServer?: McpServerStdio;
  readonly participantLookup?: SlackParticipantLookupShape;
  readonly sessionCloseTimeoutMillis?: number;
  readonly sessionEstablishTimeoutMillis?: number;
  readonly sessionStoreTestHooks?: {
    readonly afterRename?: (() => Promise<void>) | undefined;
    readonly beforeRename?: (() => Promise<void>) | undefined;
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
  readonly initialParticipantIds: Set<string>;
  readonly introducedParticipantIds: Set<string>;
  needsInitialContext: boolean;
  readonly session: ConversationSession;
}

interface ConversationSession {
  readonly dispose: () => void;
  readonly nextUpdate: () => Promise<ActiveSessionMessage>;
  readonly prompt: (
    input: string,
    options?: SendRequestOptions
  ) => Promise<PromptResponse>;
  readonly sessionId: string;
}

class ResumedSessionUpdateQueue {
  private readonly values: Array<
    | { readonly _tag: "Value"; readonly value: ActiveSessionMessage }
    | { readonly _tag: "Error"; readonly error: unknown }
  > = [];
  private readonly waiters: Array<{
    readonly reject: (error: unknown) => void;
    readonly resolve: (value: ActiveSessionMessage) => void;
  }> = [];
  private failure: unknown;
  private failed = false;
  private activePromptToken: symbol | null = null;

  beginPrompt(): symbol {
    const token = Symbol("resumed-prompt");
    this.values.splice(0);
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(new Error("Resumed ACP prompt queue reset"));
    }
    this.activePromptToken = token;
    return token;
  }

  enqueuePromptUpdate(value: ActiveSessionMessage): boolean {
    if (this.failed || this.activePromptToken === null) {
      return false;
    }
    this.enqueue(value);
    return true;
  }

  completePrompt(token: symbol, value: ActiveSessionMessage): void {
    if (this.failed || this.activePromptToken !== token) {
      return;
    }
    this.enqueue(value);
    this.activePromptToken = null;
  }

  rejectPrompt(token: symbol, error: unknown): void {
    if (this.failed || this.activePromptToken !== token) {
      return;
    }
    this.enqueueError(error);
    this.activePromptToken = null;
  }

  private enqueue(value: ActiveSessionMessage): void {
    const waiter = this.waiters.shift();
    if (waiter === undefined) {
      this.values.push({ _tag: "Value", value });
      return;
    }
    waiter.resolve(value);
  }

  private enqueueError(error: unknown): void {
    const waiter = this.waiters.shift();
    if (waiter === undefined) {
      this.values.push({ _tag: "Error", error });
      return;
    }
    waiter.reject(error);
  }

  fail(error: unknown): void {
    if (this.failed) {
      return;
    }
    this.failed = true;
    this.failure = error;
    this.activePromptToken = null;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  next(): Promise<ActiveSessionMessage> {
    const value = this.values.shift();
    if (value?._tag === "Value") {
      return Promise.resolve(value.value);
    }
    if (value?._tag === "Error") {
      return Promise.reject(value.error);
    }
    if (this.failed) {
      return Promise.reject(this.failure);
    }
    return new Promise((resolve, reject) => {
      this.waiters.push({ reject, resolve });
    });
  }
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

const configuredSessionEstablishTimeoutMillis = (
  options: AcpConversationAgentOptions
): number =>
  positiveSafeIntegerOr(
    options.sessionEstablishTimeoutMillis,
    ACP_SESSION_ESTABLISH_TIMEOUT_MILLIS
  );

const configuredSessionCloseTimeoutMillis = (
  options: AcpConversationAgentOptions
): number =>
  positiveSafeIntegerOr(
    options.sessionCloseTimeoutMillis,
    ACP_SESSION_CLOSE_TIMEOUT_MILLIS
  );

const positiveSafeIntegerOr = (
  candidate: number | undefined,
  fallback: number
): number =>
  candidate !== undefined && Number.isSafeInteger(candidate) && candidate > 0
    ? candidate
    : fallback;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Pinned OpenCode maps ACPSessionNotFoundError to invalid-params with exactly
 * `{ sessionId }`. ACP v1 itself does not standardize a session-unavailable
 * error, so no other RequestError is safe to classify as replacement-worthy.
 */
const isDefinitiveOpenCodeSessionUnavailable = (
  cause: unknown,
  expectedSessionId: string
): boolean => {
  if (
    !(cause instanceof RequestError) ||
    cause.code !== -32_602 ||
    !isRecord(cause.data)
  ) {
    return false;
  }
  const keys = Object.keys(cause.data);
  return (
    keys.length === 1 &&
    keys[0] === "sessionId" &&
    cause.data.sessionId === expectedSessionId
  );
};

const listedSessionPage = (
  candidate: unknown,
  expectedSessionId: string
): {
  readonly entries: number;
  readonly found: boolean;
  readonly nextCursor: string | null;
} | null => {
  if (!(isRecord(candidate) && Array.isArray(candidate.sessions))) {
    return null;
  }
  let found = false;
  for (const session of candidate.sessions) {
    if (
      !isRecord(session) ||
      typeof session.sessionId !== "string" ||
      session.sessionId.length === 0 ||
      typeof session.cwd !== "string" ||
      !session.cwd.startsWith("/")
    ) {
      return null;
    }
    found ||= session.sessionId === expectedSessionId;
  }
  const nextCursor = candidate.nextCursor;
  if (
    nextCursor !== undefined &&
    nextCursor !== null &&
    (typeof nextCursor !== "string" || nextCursor.length === 0)
  ) {
    return null;
  }
  return {
    entries: candidate.sessions.length,
    found,
    nextCursor: typeof nextCursor === "string" ? nextCursor : null,
  };
};

const singlePageDefinitivelyOmitsSession = (options: {
  readonly expectedSessionId: string;
  readonly response: unknown;
}): boolean => {
  const page = listedSessionPage(options.response, options.expectedSessionId);
  if (page === null) {
    throw new Error("Malformed ACP session/list response");
  }
  if (page.entries > MAX_SESSION_LIST_ENTRIES) {
    throw new Error("ACP session/list exceeded its entry limit");
  }
  if (page.found) {
    return false;
  }
  if (page.nextCursor !== null) {
    throw new Error("Paginated ACP session/list absence is ambiguous");
  }
  if (page.entries >= PINNED_OPENCODE_SESSION_LIST_PAGE_CEILING) {
    throw new Error(
      "Possibly truncated OpenCode session/list absence is ambiguous"
    );
  }
  return true;
};

const publishPublicChunk = Effect.fn("AcpConversationAgent.publishPublicChunk")(
  function* (
    publishMessage: PublishConversationAgentMessage,
    suppressPrompt: Effect.Effect<void, AcpConversationFailure>,
    message: { readonly messageId: string; readonly text: string }
  ) {
    const published = yield* Effect.result(publishMessage(message));
    if (published._tag === "Failure") {
      yield* suppressPrompt;
      return yield* published.failure;
    }
  }
);

const promptRequestFailure = (
  cause: unknown
): AcpConversationFailure | AcpDefinitivePromptFailure =>
  cause instanceof RequestError
    ? AcpDefinitivePromptFailure.make()
    : failure("prompt");

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
  session: ConversationSession,
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

const newHumanParticipantIds = (
  request: ConversationAgentRequest,
  introducedParticipantIds: ReadonlySet<string>,
  laborerSlackId: string | undefined
): string[] => {
  const pending = new Set<string>();
  for (const message of [...request.context, ...request.messages]) {
    if (
      message.authorKind !== "human" ||
      message.authorSlackId === laborerSlackId ||
      introducedParticipantIds.has(message.authorSlackId)
    ) {
      continue;
    }
    pending.add(message.authorSlackId);
  }
  return [...pending];
};

const runPrompt = Effect.fn("AcpConversationAgent.runPrompt")(function* (
  session: ConversationSession,
  request: ConversationAgentRequest,
  requiredInput: string,
  agentContext: AcpAgentContextSources | undefined,
  needsInitialContext: boolean,
  participantLookup: SlackParticipantLookupShape | undefined,
  participantIds: readonly string[],
  preparedSnapshot: AcpAgentContextSnapshot | undefined,
  markPromptSubmitted: (
    introducedParticipantIds: readonly string[]
  ) => Effect.Effect<void, AcpConversationFailure>,
  markPromptCompleted: Effect.Effect<void, AcpConversationFailure>,
  suppressPrompt: Effect.Effect<void, AcpConversationFailure>,
  publishMessage: PublishConversationAgentMessage,
  invalidate: (prompt: ActivePrompt) => Effect.Effect<void>
) {
  if (textEncoder.encode(requiredInput).byteLength > MAX_PROMPT_BYTES) {
    return yield* failure("prompt");
  }
  let input = requiredInput;
  let submittedParticipantIds = participantIds;
  if (
    agentContext !== undefined &&
    (needsInitialContext || participantIds.length > 0)
  ) {
    const initialSnapshot =
      preparedSnapshot ??
      (needsInitialContext
        ? yield* loadAcpAgentContextSnapshot(agentContext)
        : { participants: [], soul: null, workspaceMemory: null });
    const participants =
      preparedSnapshot?.participants ??
      (yield* loadAcpSlackParticipantContexts(
        agentContext,
        participantLookup,
        participantIds
      ));
    const rendered = yield* renderAcpPromptWithinByteLimit(
      request,
      { ...initialSnapshot, participants },
      MAX_PROMPT_BYTES
    );
    if (rendered === null) {
      return yield* failure("prompt");
    }
    input = rendered.prompt;
    submittedParticipantIds = rendered.introducedParticipantIds;
  }
  return yield* Effect.acquireUseRelease(
    Effect.gen(function* () {
      // This durable intent is deliberately published before crossing the ACP
      // prompt boundary. A crash in the tiny gap may lose a prompt, but restart
      // recovery will never blindly replay a request whose submission is
      // ambiguous.
      yield* markPromptSubmitted(submittedParticipantIds);
      return yield* Effect.sync(() => {
        const cancellation = new AbortController();
        const completion = session.prompt(input, {
          cancellationSignal: cancellation.signal,
        });
        completion.catch(() => undefined);
        return { cancellation, completion };
      });
    }),
    (prompt) =>
      Effect.gen(function* () {
        let outputBytes = 0;
        const messageIds = new Set<string>();
        const fallbackMessageId = `${request.promptId}:message`;
        while (true) {
          const message = yield* Effect.tryPromise({
            try: (signal) => nextSessionUpdate(session, signal),
            catch: promptRequestFailure,
          });
          if (message.kind === "stop") {
            yield* Effect.tryPromise({
              try: () => prompt.completion,
              catch: promptRequestFailure,
            });
            yield* markPromptCompleted;
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
            yield* suppressPrompt;
            return yield* failure("prompt");
          }
          yield* publishPublicChunk(publishMessage, suppressPrompt, {
            messageId,
            text: chunk.text,
          });
        }
      }).pipe(
        Effect.catchTag("AcpDefinitivePromptFailure", () =>
          suppressPrompt.pipe(Effect.andThen(failure("prompt")))
        )
      ),
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
      const memoryMcpServer = options.memoryMcpServer;
      const memoryTrustedRoot = options.agentContext?.root ?? options.cwd;
      const memoryAuthorizedSessionPermissions = new Map<
        string,
        LaborerMemoryPermissionRegistration
      >();
      const resumedSessionRoutes = new Map<string, ResumedSessionUpdateQueue>();
      const connection = client({
        name: "laborer-acp-conversation-proof",
      })
        .onNotification(methods.client.session.update, ({ params }) => {
          observeLaborerMemoryToolCall(
            params,
            memoryAuthorizedSessionPermissions
          );
          resumedSessionRoutes.get(params.sessionId)?.enqueuePromptUpdate({
            kind: "session_update",
            notification: params,
            update: params.update,
          });
        })
        .onRequest(methods.client.session.requestPermission, ({ params }) =>
          authorizeLaborerMemoryPermission(
            params,
            memoryAuthorizedSessionPermissions
          )
        )
        .connect(ndJsonStream(output, input));
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
      const sessionCwd = yield* Effect.tryPromise({
        try: async () => {
          const absolute = resolve(options.cwd);
          await assertNoSymlinkPathComponents(
            absolute,
            "prepare-acp-session-cwd"
          );
          return canonicalDirectory(absolute, "prepare-acp-session-cwd");
        },
        catch: () => failure("session"),
      }).pipe(Effect.mapError(toHandlerFailure));
      const sessionStore: ConversationSessionStore | undefined =
        options.agentContext === undefined
          ? undefined
          : yield* makeConversationSessionStore({
              expectedCwd: sessionCwd,
              sources: options.agentContext,
              ...(options.sessionStoreTestHooks === undefined
                ? {}
                : { testHooks: options.sessionStoreTestHooks }),
            }).pipe(Effect.mapError(toHandlerFailure));
      const sessions = new Map<string, ManagedSession>();

      const hasSessionIdCollision = (sessionId: string): boolean =>
        resumedSessionRoutes.has(sessionId) ||
        [...sessions.values()].some(
          (managed) => managed.session.sessionId === sessionId
        );

      const attachResumedSession = (sessionId: string): ConversationSession => {
        if (hasSessionIdCollision(sessionId)) {
          throw failure("session");
        }
        const updates = new ResumedSessionUpdateQueue();
        resumedSessionRoutes.set(sessionId, updates);
        const onConnectionClose = (): void => {
          updates.fail(
            connection.signal.reason ?? new Error("ACP connection closed")
          );
        };
        connection.signal.addEventListener("abort", onConnectionClose, {
          once: true,
        });
        let disposed = false;
        return {
          sessionId,
          dispose: () => {
            if (disposed) {
              return;
            }
            disposed = true;
            if (resumedSessionRoutes.get(sessionId) === updates) {
              resumedSessionRoutes.delete(sessionId);
            }
            connection.signal.removeEventListener("abort", onConnectionClose);
            updates.fail(new Error("Resumed ACP session disposed"));
          },
          nextUpdate: () => updates.next(),
          prompt: (prompt, requestOptions) => {
            const promptToken = updates.beginPrompt();
            let completion: Promise<PromptResponse>;
            try {
              completion = connection.agent.request(
                methods.agent.session.prompt,
                {
                  prompt: [{ text: prompt, type: "text" }],
                  sessionId,
                },
                requestOptions
              );
            } catch (error) {
              updates.rejectPrompt(promptToken, error);
              return Promise.reject(error);
            }
            completion.then(
              (response) => {
                updates.completePrompt(promptToken, {
                  kind: "stop",
                  response,
                  stopReason: response.stopReason,
                });
              },
              (error: unknown) => {
                updates.rejectPrompt(promptToken, error);
              }
            );
            return completion;
          },
        };
      };

      // ACP session IDs are connection-global routing keys. Hold this permit
      // through peer establishment, collision validation, durable claim, and
      // local route installation for every configuration.
      const sessionClaimGate = yield* Semaphore.make(1);
      const turnGates = new Map<string, Semaphore.Semaphore>();
      const turnGateRegistrySemaphore = yield* Semaphore.make(1);
      const quarantineGate = yield* Semaphore.make(1);
      let quarantined = false;
      const disposeLocalState = (): void => {
        for (const managed of sessions.values()) {
          managed.session.dispose();
        }
        sessions.clear();
        memoryAuthorizedSessionPermissions.clear();
        for (const route of resumedSessionRoutes.values()) {
          route.fail(new Error("ACP connection quarantined"));
        }
        resumedSessionRoutes.clear();
        turnGates.clear();
      };
      yield* Effect.addFinalizer(() => Effect.sync(disposeLocalState));

      const quarantineConnection = Effect.fn(
        "AcpConversationAgent.quarantineConnection"
      )(function* () {
        yield* quarantineGate.withPermit(
          Effect.uninterruptible(
            Effect.gen(function* () {
              if (quarantined) {
                return;
              }
              quarantined = true;
              disposeLocalState();
              yield* Effect.exit(
                Effect.sync(() => {
                  connection.close();
                })
              );
              yield* Effect.exit(releaseChild(acquiredChild, exitGraceMillis));
            })
          )
        );
      });

      const failAfterEstablishmentTimeout = Effect.fn(
        "AcpConversationAgent.failAfterEstablishmentTimeout"
      )(function* () {
        yield* quarantineConnection();
        return yield* failure("session");
      });

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

      const recordMemoryRegistrationDiagnostic = Effect.fn(
        "AcpConversationAgent.recordMemoryRegistrationDiagnostic"
      )(function* (
        code: LaborerMemoryDiagnosticCode,
        authority: { readonly root: string; readonly workspaceId: string }
      ) {
        yield* Effect.logWarning("Memory MCP registration failed", { code });
        if (
          options.agentContext !== undefined &&
          options.agentContext.root === authority.root &&
          options.agentContext.workspaceId === authority.workspaceId
        ) {
          yield* recordLaborerMemoryDiagnosticForSources({
            code,
            sources: options.agentContext,
          });
          return;
        }
        yield* recordLaborerMemoryDiagnostic({ code, ...authority });
      });

      const prepareMemoryRegistration = Effect.fn(
        "AcpConversationAgent.prepareMemoryRegistration"
      )(function* () {
        if (memoryMcpServer === undefined) {
          return null;
        }
        const prepared = yield* Effect.result(
          prepareLaborerMemoryMcpRegistration(
            memoryMcpServer,
            memoryTrustedRoot
          )
        );
        if (prepared._tag === "Success") {
          return prepared.success;
        }
        const authority = laborerMemoryMcpAuthority(memoryMcpServer);
        if (authority !== null) {
          yield* recordMemoryRegistrationDiagnostic(
            "registration-invalid",
            authority
          );
        } else {
          yield* Effect.logWarning("Memory MCP registration failed", {
            code: "registration-invalid",
          });
        }
        return MEMORY_REGISTRATION_UNAVAILABLE;
      });

      const verifyMemoryRegistrationReadiness = Effect.fn(
        "AcpConversationAgent.verifyMemoryRegistrationReadiness"
      )(function* (
        registration: PreparedLaborerMemoryMcpRegistration,
        session: ConversationSession,
        disposeOnFailure: boolean
      ) {
        const readiness = yield* Effect.result(
          awaitLaborerMemoryMcpReadiness(registration)
        );
        if (readiness._tag === "Failure") {
          if (disposeOnFailure) {
            session.dispose();
          }
          yield* recordMemoryRegistrationDiagnostic(
            readiness.failure.reason === "collision"
              ? "registration-collision"
              : "registration-missing",
            registration.authority
          );
          return false;
        }
        memoryAuthorizedSessionPermissions.set(session.sessionId, {
          observedToolCallIds: new Set<string>(),
          permission: registration.permission,
        });
        return true;
      });

      const startSession = Effect.fn("AcpConversationAgent.startSession")(
        function* (registration: PreparedLaborerMemoryMcpRegistration | null) {
          return yield* Effect.tryPromise({
            try: (signal) =>
              connection.agent
                .buildSession({
                  cwd: sessionCwd,
                  mcpServers:
                    registration === null ? [] : [registration.server],
                })
                .start({ cancellationSignal: signal }),
            catch: () => failure("session"),
          }).pipe(
            Effect.timeout(
              `${configuredSessionEstablishTimeoutMillis(options)} millis`
            ),
            Effect.catchTag("TimeoutError", failAfterEstablishmentTimeout),
            Effect.mapError(() => failure("session"))
          );
        }
      );

      const resumeSession = Effect.fn("AcpConversationAgent.resumeSession")(
        function* (
          persisted: PersistedConversationSession,
          registration: PreparedLaborerMemoryMcpRegistration | null
        ) {
          yield* Effect.tryPromise({
            try: (signal) =>
              connection.agent.request(
                methods.agent.session.resume,
                {
                  cwd: persisted.cwd,
                  mcpServers:
                    registration === null ? [] : [registration.server],
                  sessionId: persisted.sessionId,
                },
                { cancellationSignal: signal }
              ),
            catch: (cause) =>
              isDefinitiveOpenCodeSessionUnavailable(cause, persisted.sessionId)
                ? AcpSessionUnavailable.make()
                : AcpResumeNeedsAvailabilityCheck.make(),
          }).pipe(
            Effect.timeout(
              `${configuredSessionEstablishTimeoutMillis(options)} millis`
            ),
            Effect.catchTag("TimeoutError", failAfterEstablishmentTimeout),
            Effect.mapError((error) =>
              error instanceof AcpSessionUnavailable ||
              error instanceof AcpResumeNeedsAvailabilityCheck
                ? error
                : failure("session")
            )
          );
          return yield* Effect.try({
            try: () => attachResumedSession(persisted.sessionId),
            catch: () => failure("session"),
          });
        }
      );

      const listDefinitivelyOmitsSession = Effect.fn(
        "AcpConversationAgent.listDefinitivelyOmitsSession"
      )(function* (persisted: PersistedConversationSession) {
        if (
          initialized.agentCapabilities?.sessionCapabilities?.list === undefined
        ) {
          return yield* failure("session");
        }
        return yield* Effect.tryPromise({
          try: async (signal) =>
            singlePageDefinitivelyOmitsSession({
              expectedSessionId: persisted.sessionId,
              response: await connection.agent.request(
                methods.agent.session.list,
                { cwd: persisted.cwd },
                { cancellationSignal: signal }
              ),
            }),
          catch: () => failure("session"),
        }).pipe(
          Effect.timeout(
            `${configuredSessionEstablishTimeoutMillis(options)} millis`
          ),
          Effect.catchTag("TimeoutError", failAfterEstablishmentTimeout),
          Effect.mapError(() => failure("session"))
        );
      });

      const persistSessionMapping = Effect.fn(
        "AcpConversationAgent.persistSessionMapping"
      )(function* (conversationId: string, session: ConversationSession) {
        if (sessionStore === undefined) {
          return;
        }
        yield* sessionStore
          .replaceSession({
            conversationId,
            cwd: sessionCwd,
            sessionId: session.sessionId,
          })
          .pipe(Effect.mapError(() => failure("session")));
      });

      const closeOwnedSession = Effect.fn(
        "AcpConversationAgent.closeOwnedSession"
      )(function* (session: ConversationSession) {
        const closed = yield* Effect.result(
          Effect.tryPromise({
            try: (signal) =>
              connection.agent.request(
                methods.agent.session.close,
                { sessionId: session.sessionId },
                { cancellationSignal: signal }
              ),
            catch: () => failure("session"),
          }).pipe(
            Effect.timeout(
              `${configuredSessionCloseTimeoutMillis(options)} millis`
            )
          )
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              memoryAuthorizedSessionPermissions.delete(session.sessionId);
              session.dispose();
            })
          )
        );
        if (closed._tag === "Failure") {
          yield* quarantineConnection();
          return yield* failure("session");
        }
      });

      const startSessionWithMemory = Effect.fn(
        "AcpConversationAgent.startSessionWithMemory"
      )(function* () {
        const registration = yield* prepareMemoryRegistration();
        let session = yield* startSession(
          registration === MEMORY_REGISTRATION_UNAVAILABLE ? null : registration
        );
        if (
          registration !== null &&
          registration !== MEMORY_REGISTRATION_UNAVAILABLE
        ) {
          const memoryIsReady = yield* verifyMemoryRegistrationReadiness(
            registration,
            session,
            true
          );
          if (!memoryIsReady) {
            yield* closeOwnedSession(session);
            session = yield* startSession(null);
          }
        }
        return session;
      });

      const createManagedSession = Effect.fn(
        "AcpConversationAgent.createManagedSession"
      )(function* (
        conversationId: string,
        initialParticipantIds: readonly string[] = []
      ) {
        const session = yield* startSessionWithMemory();
        if (hasSessionIdCollision(session.sessionId)) {
          session.dispose();
          yield* quarantineConnection();
          return yield* failure("session");
        }
        const persisted = yield* Effect.result(
          persistSessionMapping(conversationId, session)
        );
        if (persisted._tag === "Failure") {
          yield* closeOwnedSession(session);
          return yield* persisted.failure;
        }
        const created: ManagedSession = {
          introducedParticipantIds: new Set<string>(),
          initialParticipantIds: new Set(initialParticipantIds),
          needsInitialContext: options.agentContext !== undefined,
          session,
        };
        sessions.set(conversationId, created);
        return created;
      });

      const resumeFailureMeansUnavailable = Effect.fn(
        "AcpConversationAgent.resumeFailureMeansUnavailable"
      )(function* (
        persisted: PersistedConversationSession,
        resumeFailure:
          | AcpConversationFailure
          | AcpResumeNeedsAvailabilityCheck
          | AcpSessionUnavailable
      ) {
        if (resumeFailure instanceof AcpSessionUnavailable) {
          return true;
        }
        if (resumeFailure instanceof AcpResumeNeedsAvailabilityCheck) {
          return yield* listDefinitivelyOmitsSession(persisted);
        }
        return yield* resumeFailure;
      });

      const resumeManagedSession = Effect.fn(
        "AcpConversationAgent.resumeManagedSession"
      )(function* (persisted: PersistedConversationSession) {
        if (
          initialized.agentCapabilities?.sessionCapabilities?.resume ===
          undefined
        ) {
          return yield* failure("session");
        }
        const registration = yield* prepareMemoryRegistration();
        const configuredRegistration =
          registration === MEMORY_REGISTRATION_UNAVAILABLE
            ? null
            : registration;
        const resumed = yield* Effect.result(
          resumeSession(persisted, configuredRegistration)
        );
        if (resumed._tag === "Failure") {
          if (
            yield* resumeFailureMeansUnavailable(persisted, resumed.failure)
          ) {
            return { _tag: "Unavailable" } as const;
          }
          return yield* failure("session");
        }
        const hasPreparedRegistration =
          registration !== null &&
          registration !== MEMORY_REGISTRATION_UNAVAILABLE;
        let session: ConversationSession = resumed.success;
        if (hasPreparedRegistration) {
          yield* verifyMemoryRegistrationReadiness(
            registration,
            resumed.success,
            false
          );
          // Stable ACP cannot detach an MCP server from an already resumed
          // session. Readiness failure therefore degrades only authorization;
          // conversation history and the one successful resume stay intact.
          session = resumed.success;
        }
        return {
          _tag: "Resumed",
          managed: {
            introducedParticipantIds: new Set(
              persisted.introducedParticipantIds
            ),
            initialParticipantIds: new Set<string>(),
            needsInitialContext: !persisted.initialContextSubmitted,
            session,
          } satisfies ManagedSession,
        } as const;
      });

      const ensurePromptIsSafeToSubmit = Effect.fn(
        "AcpConversationAgent.ensurePromptIsSafeToSubmit"
      )(function* (
        conversationId: string,
        promptId: string,
        persisted: PersistedConversationSession | null
      ) {
        if (persisted?.suppressedPromptId === promptId) {
          return yield* failure("prompt");
        }
        if (persisted?.inFlightPromptId === null || persisted === null) {
          return;
        }
        if (persisted.inFlightPromptId !== promptId) {
          return yield* failure("session");
        }
        if (sessionStore === undefined) {
          return yield* failure("session");
        }
        yield* sessionStore
          .suppressInFlightPrompt({
            conversationId,
            promptId,
            sessionId: persisted.sessionId,
          })
          .pipe(Effect.mapError(() => failure("session")));
        return yield* failure("prompt");
      });

      const establishManagedSession = Effect.fn(
        "AcpConversationAgent.establishManagedSession"
      )(function* (
        conversationId: string,
        persisted: PersistedConversationSession | null
      ) {
        if (persisted === null) {
          return yield* createManagedSession(conversationId);
        }
        const resumed = yield* resumeManagedSession(persisted);
        if (resumed._tag === "Resumed") {
          sessions.set(conversationId, resumed.managed);
          return resumed.managed;
        }
        if (options.agentContext !== undefined) {
          yield* Effect.logWarning(
            "ACP session resume failed; creating replacement"
          );
          yield* recordConversationSessionDiagnostic(
            options.agentContext,
            "resume-failed"
          );
        }
        return yield* createManagedSession(
          conversationId,
          persisted.introducedParticipantIds
        );
      });

      const sessionFor = Effect.fn("AcpConversationAgent.sessionFor")(
        function* (conversationId: string, promptId: string) {
          const existing = sessions.get(conversationId);
          if (existing !== undefined) {
            return existing;
          }
          const persisted =
            sessionStore === undefined
              ? null
              : yield* sessionStore
                  .get(conversationId)
                  .pipe(Effect.mapError(() => failure("session")));
          yield* ensurePromptIsSafeToSubmit(
            conversationId,
            promptId,
            persisted
          );
          const establishSession = establishManagedSession(
            conversationId,
            persisted
          );
          return yield* sessionClaimGate.withPermit(
            Effect.gen(function* () {
              if (quarantined) {
                return yield* failure("session");
              }
              return yield* establishSession;
            })
          );
        }
      );

      const invalidateSession = (
        conversationId: string,
        session: ConversationSession
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
          memoryAuthorizedSessionPermissions.delete(session.sessionId);
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

      const prepareBrandNewSnapshot = Effect.fn(
        "AcpConversationAgent.prepareBrandNewSnapshot"
      )(function* (request: ConversationAgentRequest) {
        const existingManaged = sessions.get(request.conversationId);
        const persistedBeforeEstablishing =
          existingManaged !== undefined || sessionStore === undefined
            ? null
            : yield* sessionStore
                .get(request.conversationId)
                .pipe(Effect.mapError(() => failure("session")));
        if (
          options.agentContext === undefined ||
          existingManaged !== undefined ||
          persistedBeforeEstablishing !== null
        ) {
          return undefined;
        }
        const participantIds = newHumanParticipantIds(
          request,
          new Set<string>(),
          options.laborerSlackId
        );
        const prepared = yield* Effect.all({
          initial: loadAcpAgentContextSnapshot(options.agentContext),
          participants: loadAcpSlackParticipantContexts(
            options.agentContext,
            options.participantLookup,
            participantIds
          ),
        });
        return {
          ...prepared.initial,
          participants: prepared.participants,
        } satisfies AcpAgentContextSnapshot;
      });

      const establishPromptSession = Effect.fn(
        "AcpConversationAgent.establishPromptSession"
      )(function* (request: ConversationAgentRequest) {
        return yield* Effect.all(
          {
            managed: sessionFor(request.conversationId, request.promptId),
            preparedSnapshot: prepareBrandNewSnapshot(request),
          },
          { concurrency: 2 }
        );
      });

      const markPromptSubmitted = (
        request: ConversationAgentRequest,
        managed: ManagedSession
      ) =>
        Effect.fnUntraced(function* (
          introducedParticipantIds: readonly string[]
        ) {
          if (sessionStore !== undefined) {
            yield* sessionStore
              .markPromptSubmitted({
                conversationId: request.conversationId,
                introducedParticipantIds,
                promptId: request.promptId,
                sessionId: managed.session.sessionId,
              })
              .pipe(Effect.mapError(() => failure("prompt")));
          }
          managed.needsInitialContext = false;
          managed.initialParticipantIds.clear();
          for (const participantId of introducedParticipantIds) {
            managed.introducedParticipantIds.add(participantId);
          }
        });

      const completePersistedPrompt = (
        request: ConversationAgentRequest,
        managed: ManagedSession
      ): Effect.Effect<void, AcpConversationFailure> =>
        sessionStore === undefined
          ? Effect.void
          : sessionStore
              .completePrompt({
                conversationId: request.conversationId,
                promptId: request.promptId,
                sessionId: managed.session.sessionId,
              })
              .pipe(Effect.mapError(() => failure("prompt")));

      const suppressPersistedPrompt = (
        request: ConversationAgentRequest,
        managed: ManagedSession
      ): Effect.Effect<void, AcpConversationFailure> =>
        sessionStore === undefined
          ? Effect.void
          : sessionStore
              .suppressInFlightPrompt({
                conversationId: request.conversationId,
                promptId: request.promptId,
                sessionId: managed.session.sessionId,
              })
              .pipe(Effect.mapError(() => failure("prompt")));

      const executePrompt = Effect.fn("AcpConversationAgent.executePrompt")(
        function* (
          request: ConversationAgentRequest,
          publishMessage: PublishConversationAgentMessage
        ) {
          const requiredInput =
            options.agentContext === undefined
              ? request.input
              : renderAcpPrompt(request);
          if (textEncoder.encode(requiredInput).byteLength > MAX_PROMPT_BYTES) {
            return yield* failure("prompt");
          }
          const { managed, preparedSnapshot } =
            yield* establishPromptSession(request);
          const newlyObservedParticipantIds =
            options.agentContext === undefined
              ? []
              : newHumanParticipantIds(
                  request,
                  managed.introducedParticipantIds,
                  options.laborerSlackId
                );
          const participantIds = [
            ...managed.initialParticipantIds,
            ...newlyObservedParticipantIds.filter(
              (participantId) =>
                !managed.initialParticipantIds.has(participantId)
            ),
          ];
          return yield* runPrompt(
            managed.session,
            request,
            requiredInput,
            options.agentContext,
            managed.needsInitialContext,
            options.participantLookup,
            participantIds,
            preparedSnapshot,
            markPromptSubmitted(request, managed),
            completePersistedPrompt(request, managed),
            suppressPersistedPrompt(request, managed),
            publishMessage,
            invalidateSession(request.conversationId, managed.session)
          );
        }
      );

      const handle: ConversationAgentShape["handle"] = (
        request,
        publishMessage
      ) => {
        if (publishMessage === undefined) {
          return toHandlerFailure();
        }
        return Effect.gen(function* () {
          if (quarantined) {
            return yield* toHandlerFailure();
          }
          const turnGate = yield* turnGateFor(request.conversationId);
          return yield* turnGate.withPermit(
            executePrompt(request, publishMessage)
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
