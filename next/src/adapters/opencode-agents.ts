import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { Scope } from "effect";
import { Effect, Array as EffectArray, Option, pipe, Semaphore } from "effect";
import { HandlerFailure } from "../prototype/errors.ts";
import type {
  AcceptImplementationAgentResponse,
  ImplementationAgentInspectionRequest,
  ImplementationAgentRequest,
  ImplementationAgentResumeRequest,
  ImplementationAgentSession,
  ImplementationAgentShape,
  ResourceInspectionOutcome,
} from "../reference-coding-application.ts";

export interface OpenCodeSessionIdentity {
  readonly sessionId: string;
  readonly workingDirectory: string;
}

export interface OpenCodeModel {
  readonly modelID: string;
  readonly providerID: string;
}

export interface OpenCodePromptInput extends OpenCodeSessionIdentity {
  readonly promptId: string;
  readonly text: string;
  readonly tools?: Record<string, boolean>;
}

export type OpenCodePromptIdentity = Omit<
  OpenCodePromptInput,
  "text" | "tools"
>;

export interface OpenCodeSessionMessage {
  readonly finish?: string;
  readonly id: string;
  readonly role: "assistant" | "user";
  readonly status?: "completed" | "error" | "in-progress";
  readonly text: string;
}

export interface OpenCodePermissionRule {
  readonly action: "allow" | "ask" | "deny";
  readonly pattern: string;
  readonly permission: string;
}

export interface OpenCodeSessionClient {
  readonly createSession: (
    input: OpenCodeSessionIdentity
  ) => Effect.Effect<void, HandlerFailure>;
  readonly inspectSession?: (
    input: OpenCodeSessionIdentity
  ) => Effect.Effect<OpenCodeSessionInspection>;
  readonly interrupt: (
    input: OpenCodePromptIdentity
  ) => Effect.Effect<void, HandlerFailure>;
  readonly prepareSessionForReuse?: (
    input: OpenCodeSessionIdentity
  ) => Effect.Effect<void, HandlerFailure>;
  readonly readMessages: (
    input: OpenCodePromptIdentity
  ) => Effect.Effect<readonly OpenCodeSessionMessage[], HandlerFailure>;
  readonly sessionExists: (
    input: OpenCodeSessionIdentity
  ) => Effect.Effect<boolean, HandlerFailure>;
  readonly submitPrompt: (
    input: OpenCodePromptInput
  ) => Effect.Effect<void, HandlerFailure>;
  readonly wait: (
    input: OpenCodePromptIdentity
  ) => Effect.Effect<void, HandlerFailure>;
}

export type OpenCodeSessionInspection =
  | { readonly status: "available" }
  | { readonly status: "conflicting" }
  | { readonly status: "malformed" }
  | { readonly status: "missing" }
  | { readonly status: "ambiguous" };

export interface OpenCodeV2SessionApi {
  readonly create: (input: {
    readonly agent?: string;
    readonly id: string;
    readonly model?: OpenCodeModel;
    readonly workingDirectory: string;
  }) => Promise<{ readonly id: string }>;
  readonly get: (input: { readonly sessionId: string }) => Promise<{
    readonly id: string;
    readonly workingDirectory: string;
  }>;
  readonly getPermission?: (input: {
    readonly sessionId: string;
  }) => Promise<unknown>;
  readonly interrupt: (input: { readonly sessionId: string }) => Promise<void>;
  readonly messages: (input: {
    readonly limit: number;
    readonly order: "desc";
    readonly sessionId: string;
    readonly workingDirectory: string;
  }) => Promise<readonly OpenCodeSessionMessage[]>;
  readonly prompt: (input: {
    readonly agent?: string;
    readonly model?: OpenCodeModel;
    readonly promptId: string;
    readonly sessionId: string;
    readonly text: string;
    readonly tools?: Record<string, boolean>;
    readonly workingDirectory: string;
  }) => Promise<{ readonly id: string }>;
  readonly updatePermission?: (input: {
    readonly permission: readonly OpenCodePermissionRule[];
    readonly sessionId: string;
  }) => Promise<void>;
  readonly wait: (input: { readonly sessionId: string }) => Promise<void>;
}

export interface OpenCodeLegacyMessage {
  readonly info: {
    readonly error?: unknown;
    readonly finish?: string;
    readonly id: string;
    readonly role: "assistant" | "user";
    readonly time: {
      readonly completed?: number;
      readonly created?: number;
    };
  };
  readonly parts: readonly {
    readonly text?: string;
    readonly type: string;
  }[];
}

interface OpenCodeLegacyMessagesRequest {
  readonly directory: string;
  readonly limit: number;
  readonly sessionID: string;
}

interface OpenCodeLegacyPromptRequest {
  readonly agent?: string;
  readonly directory: string;
  readonly messageID: string;
  readonly model?: OpenCodeModel;
  readonly parts: [
    {
      readonly text: string;
      readonly type: "text";
    },
  ];
  readonly sessionID: string;
  readonly tools?: Record<string, boolean>;
}

interface OpenCodeLegacyRequestOptions {
  readonly throwOnError: true;
}

export interface OpenCodeLegacySessionApi {
  readonly messages: (
    input: OpenCodeLegacyMessagesRequest,
    options: OpenCodeLegacyRequestOptions
  ) => Promise<{ readonly data: readonly OpenCodeLegacyMessage[] }>;
  readonly prompt: (
    input: OpenCodeLegacyPromptRequest,
    options: OpenCodeLegacyRequestOptions
  ) => Promise<void>;
}

export interface OpenCodeSessionClientOptions {
  readonly agent?: string;
  readonly model?: OpenCodeModel;
  readonly promptIsolation?: boolean;
  readonly waitPollIntervalMs?: number;
  readonly waitPollMaxAttempts?: number;
}

export interface OpenCodeWorkspaceSessionClientOptions
  extends OpenCodeSessionClientOptions {
  readonly environment: NodeJS.ProcessEnv;
  readonly hostname?: string;
  readonly port?: number;
  readonly serverTimeoutMs?: number;
  readonly workspaceDirectory: string;
}

const MAX_SESSION_MESSAGES = 200;
const MAX_IMPLEMENTATION_RESPONSE_LENGTH = 16_384;
const MAX_IMPLEMENTATION_RESPONSES = 64;
const MAX_PROMPT_LENGTH = 65_536;
const MAX_SERVER_STARTUP_OUTPUT_LENGTH = 65_536;
const DEFAULT_WAIT_POLL_INTERVAL_MILLIS = 1000;
const DEFAULT_WAIT_POLL_MAX_ATTEMPTS = 3600;
const OPEN_CODE_SESSION_DIGEST_LENGTH = 60;
const SERVER_STOP_GRACE_MILLIS = 250;
const OPEN_CODE_MESSAGE_TIME_RADIX = 0x1000n;
const OPEN_CODE_MESSAGE_TIME_MODULUS = 2n ** 48n;
const OPEN_CODE_MESSAGE_CLOCK_WAIT_MAX_ATTEMPTS = 1000;
const OPEN_CODE_NATIVE_MESSAGE_ID_PATTERN =
  /^msg_([0-9a-f]{12})[0-9A-Za-z]{14}$/;
const LABORER_WIRE_MESSAGE_ID_PATTERN =
  /^msg_([0-9a-f]{12})_laborer_([0-9A-Za-z_-]+)$/;
const SERVER_URL_PATTERN =
  /opencode server listening.*on\s+(https?:\/\/[^\s]+)/;
const LEGACY_WILDCARD_PERMISSION = "*";
const LEGACY_WILDCARD_PATTERN = "*";
const PERMISSION_RULE_KEYS = new Set(["action", "pattern", "permission"]);

const protocolFailure = (safeDetail: string): HandlerFailure =>
  HandlerFailure.make({ category: "protocol", safeDetail });

const boundedPrompt = (text: string): Effect.Effect<string, HandlerFailure> =>
  text.length <= MAX_PROMPT_LENGTH
    ? Effect.succeed(text)
    : Effect.fail(protocolFailure("OpenCode prompt exceeded the limit"));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isPermissionRule = (value: unknown): value is OpenCodePermissionRule =>
  isRecord(value) &&
  typeof value.permission === "string" &&
  typeof value.pattern === "string" &&
  (value.action === "allow" ||
    value.action === "ask" ||
    value.action === "deny");

const isLegacyWildcardAllow = (rule: OpenCodePermissionRule): boolean =>
  Object.keys(rule).length === PERMISSION_RULE_KEYS.size &&
  Object.keys(rule).every((key) => PERMISSION_RULE_KEYS.has(key)) &&
  rule.permission === LEGACY_WILDCARD_PERMISSION &&
  rule.pattern === LEGACY_WILDCARD_PATTERN &&
  rule.action === "allow";

const inspectedPermissionRules = (
  permission: unknown
): readonly OpenCodePermissionRule[] | null => {
  if (permission === undefined) {
    return [];
  }
  if (!(Array.isArray(permission) && permission.every(isPermissionRule))) {
    return null;
  }
  return permission;
};

const physicalSessionId = (
  logicalSessionId: string,
  promptId: string
): string =>
  `ses_${createHash("sha256")
    .update(JSON.stringify([logicalSessionId, promptId]))
    .digest("hex")
    .slice(0, OPEN_CODE_SESSION_DIGEST_LENGTH)}`;

const promptSessionIdentity = (
  identity: OpenCodePromptIdentity,
  isolatePrompt: boolean
): OpenCodeSessionIdentity => ({
  sessionId: isolatePrompt
    ? physicalSessionId(identity.sessionId, identity.promptId)
    : identity.sessionId,
  workingDirectory: identity.workingDirectory,
});

const sdkFailure = (operation: string): HandlerFailure =>
  HandlerFailure.make({
    category: "exit",
    safeDetail: `OpenCode ${operation} failed`,
  });

const isNotFound = (error: unknown): boolean => {
  if (isRecord(error) && error._tag === "SessionNotFoundError") {
    return true;
  }
  if (!(error instanceof Error && isRecord(error.cause))) {
    return false;
  }
  return error.cause.status === 404;
};

const isSessionWaitUnavailableBody = (error: unknown): boolean =>
  isRecord(error) &&
  error._tag === "ServiceUnavailableError" &&
  error.service === "session.wait";

const isSessionWaitUnavailable = (error: unknown): boolean => {
  if (isSessionWaitUnavailableBody(error)) {
    return true;
  }
  if (!(error instanceof Error && isRecord(error.cause))) {
    return false;
  }
  return (
    error.cause.status === 503 && isSessionWaitUnavailableBody(error.cause.body)
  );
};

const apiEffect = <A>(
  operation: string,
  evaluate: () => Promise<A>
): Effect.Effect<A, HandlerFailure> =>
  Effect.tryPromise({
    try: evaluate,
    catch: () => sdkFailure(operation),
  });

type PromptWaitState = "completed" | "error" | "missing-prompt" | "pending";

const isTerminalAssistant = (message: OpenCodeSessionMessage): boolean =>
  message.role === "assistant" &&
  message.status === "completed" &&
  typeof message.finish === "string" &&
  message.finish.trim().length > 0 &&
  message.finish !== "tool-calls" &&
  message.finish !== "unknown";

const promptWaitState = (
  messages: readonly OpenCodeSessionMessage[],
  promptId: string
): PromptWaitState => {
  const promptIndex = EffectArray.findFirstIndex(
    messages,
    (message) => message.role === "user" && message.id === promptId
  );
  if (Option.isNone(promptIndex)) {
    return "missing-prompt";
  }
  const assistants = pipe(
    messages,
    EffectArray.drop(promptIndex.value + 1),
    EffectArray.takeWhile((message) => message.role !== "user"),
    EffectArray.filter((message) => message.role === "assistant")
  );
  if (EffectArray.some(assistants, (message) => message.status === "error")) {
    return "error";
  }
  return EffectArray.some(assistants, isTerminalAssistant)
    ? "completed"
    : "pending";
};

const promptWaitFailure = (safeDetail: string): HandlerFailure =>
  HandlerFailure.make({ category: "protocol", safeDetail });

const readPromptWaitState = (
  api: OpenCodeV2SessionApi,
  input: Omit<OpenCodePromptInput, "text">
): Effect.Effect<PromptWaitState, HandlerFailure> =>
  apiEffect("message read", () =>
    api.messages({
      limit: MAX_SESSION_MESSAGES,
      order: "desc",
      sessionId: input.sessionId,
      workingDirectory: input.workingDirectory,
    })
  ).pipe(
    Effect.map(EffectArray.reverse),
    Effect.map((messages) => promptWaitState(messages, input.promptId))
  );

const verifyPromptCompletion = Effect.fnUntraced(function* (
  api: OpenCodeV2SessionApi,
  input: Omit<OpenCodePromptInput, "text">
) {
  const state = yield* readPromptWaitState(api, input);
  if (state === "completed") {
    return;
  }
  if (state === "error") {
    return yield* promptWaitFailure("OpenCode assistant response failed");
  }
  return yield* promptWaitFailure(
    state === "missing-prompt"
      ? "OpenCode prompt is unavailable"
      : "OpenCode prompt response did not complete"
  );
});

const pollForPromptCompletion = Effect.fnUntraced(function* (
  api: OpenCodeV2SessionApi,
  input: Omit<OpenCodePromptInput, "text">,
  pollIntervalMs: number,
  maxAttempts: number
) {
  let observedPrompt = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const state = yield* readPromptWaitState(api, input);
    if (state === "completed") {
      return;
    }
    if (state === "error") {
      return yield* promptWaitFailure("OpenCode assistant response failed");
    }
    observedPrompt ||= state === "pending";
    if (attempt < maxAttempts && pollIntervalMs > 0) {
      yield* Effect.sleep(`${pollIntervalMs} millis`);
    }
  }
  return yield* promptWaitFailure(
    observedPrompt
      ? "OpenCode prompt response timed out"
      : "OpenCode prompt is unavailable"
  );
});

interface RunningOpenCodeServer {
  readonly close: () => Promise<void>;
  readonly url: string;
}

const signalServerProcess = (
  child: ReturnType<typeof spawn>,
  detached: boolean,
  signal: NodeJS.Signals
): void => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (detached && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child on platforms without process groups.
    }
  }
  child.kill(signal);
};

const waitForServerExit = async (
  child: ReturnType<typeof spawn>,
  timeoutMillis: number
): Promise<boolean> => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }
  return await new Promise<boolean>((resolvePromise) => {
    let settled = false;
    const finish = (exited: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      child.removeListener("exit", onExit);
      resolvePromise(exited);
    };
    const onExit = (): void => finish(true);
    const timeout = setTimeout(() => finish(false), timeoutMillis);
    child.once("exit", onExit);
  });
};

const stopServerProcess = async (
  child: ReturnType<typeof spawn>,
  detached: boolean
): Promise<void> => {
  if (await waitForServerExit(child, 0)) {
    return;
  }
  signalServerProcess(child, detached, "SIGTERM");
  if (await waitForServerExit(child, SERVER_STOP_GRACE_MILLIS)) {
    return;
  }
  signalServerProcess(child, detached, "SIGKILL");
  if (!(await waitForServerExit(child, SERVER_STOP_GRACE_MILLIS))) {
    throw new Error("OpenCode server did not exit");
  }
};

const drainServerOutput = (child: ReturnType<typeof spawn>): void => {
  // Keep both pipes in flowing mode after startup detection. OpenCode is a
  // long-lived process and can otherwise eventually block on a full pipe.
  child.stdout?.resume();
  child.stderr?.resume();
};

const readServerUrl = async (
  child: ReturnType<typeof spawn>,
  timeoutMillis: number
): Promise<string> =>
  await new Promise<string>((resolvePromise, rejectPromise) => {
    let output = "";
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.stdout?.removeListener("data", acceptOutput);
      child.stderr?.removeListener("data", acceptOutput);
      child.removeListener("error", finishFailure);
      child.removeListener("exit", finishFailure);
    };
    const finishFailure = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      rejectPromise(new Error("OpenCode server failed to start"));
    };
    const acceptOutput = (chunk: Buffer | string): void => {
      if (settled) {
        return;
      }
      output += chunk.toString();
      if (output.length > MAX_SERVER_STARTUP_OUTPUT_LENGTH) {
        finishFailure();
        return;
      }
      const match = SERVER_URL_PATTERN.exec(output);
      const serverUrl = match?.[1];
      if (serverUrl !== undefined) {
        settled = true;
        cleanup();
        resolvePromise(serverUrl);
      }
    };
    const timeout = setTimeout(finishFailure, timeoutMillis);
    child.stdout?.on("data", acceptOutput);
    child.stderr?.on("data", acceptOutput);
    child.once("error", finishFailure);
    child.once("exit", finishFailure);
  });

export const launchOpenCodeServer = async (options: {
  readonly environment: NodeJS.ProcessEnv;
  readonly hostname: string;
  readonly port: number;
  readonly timeoutMs: number;
}): Promise<RunningOpenCodeServer> => {
  const detached = process.platform !== "win32";
  const child = spawn(
    "opencode",
    ["serve", `--hostname=${options.hostname}`, `--port=${options.port}`],
    {
      detached,
      env: options.environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }
  );
  let url: string;
  try {
    url = await readServerUrl(child, options.timeoutMs);
  } catch (error) {
    await stopServerProcess(child, detached);
    throw error;
  }
  drainServerOutput(child);
  let closePromise: Promise<void> | null = null;
  return {
    close: () => {
      closePromise ??= stopServerProcess(child, detached);
      return closePromise;
    },
    url,
  };
};

export const makeOpenCodeSessionClientFromV2Api = (
  api: OpenCodeV2SessionApi,
  options: OpenCodeSessionClientOptions = {}
): OpenCodeSessionClient => {
  const isolatePrompts = options.promptIsolation ?? false;
  const waitPollIntervalMs =
    options.waitPollIntervalMs ?? DEFAULT_WAIT_POLL_INTERVAL_MILLIS;
  const waitPollMaxAttempts =
    options.waitPollMaxAttempts ?? DEFAULT_WAIT_POLL_MAX_ATTEMPTS;
  const createSession = (
    identity: OpenCodeSessionIdentity
  ): Effect.Effect<void, HandlerFailure> =>
    apiEffect("session creation", () =>
      api.create({
        ...(options.agent === undefined ? {} : { agent: options.agent }),
        id: identity.sessionId,
        ...(options.model === undefined ? {} : { model: options.model }),
        workingDirectory: identity.workingDirectory,
      })
    ).pipe(
      Effect.flatMap((created) =>
        created.id === identity.sessionId
          ? Effect.void
          : protocolFailure("OpenCode session identity conflicts")
      )
    );
  const sessionExists = (
    identity: OpenCodeSessionIdentity
  ): Effect.Effect<boolean, HandlerFailure> =>
    Effect.tryPromise({
      try: () => api.get({ sessionId: identity.sessionId }),
      catch: (error) => ({
        notFound: isNotFound(error),
      }),
    }).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          error.notFound
            ? Effect.succeed(false)
            : Effect.fail(sdkFailure("session lookup")),
        onSuccess: (existing) => {
          if (
            existing.id !== identity.sessionId ||
            existing.workingDirectory !== identity.workingDirectory
          ) {
            return protocolFailure("OpenCode session identity conflicts");
          }
          return Effect.succeed(true);
        },
      })
    );
  const prepareSessionForReuse = Effect.fnUntraced(function* (
    identity: OpenCodeSessionIdentity
  ) {
    const getPermission = api.getPermission;
    const updatePermission = api.updatePermission;
    if (getPermission === undefined || updatePermission === undefined) {
      return yield* protocolFailure(
        "OpenCode legacy permission inspection is unavailable"
      );
    }
    const existing = yield* apiEffect("session lookup", () =>
      api.get({ sessionId: identity.sessionId })
    );
    if (
      existing.id !== identity.sessionId ||
      existing.workingDirectory !== identity.workingDirectory
    ) {
      return yield* protocolFailure("OpenCode session identity conflicts");
    }
    const permission = inspectedPermissionRules(
      yield* apiEffect("legacy permission inspection", () =>
        getPermission({ sessionId: identity.sessionId })
      )
    );
    if (permission === null) {
      return yield* protocolFailure(
        "OpenCode legacy permission inspection is ambiguous"
      );
    }
    const sanitized = permission.filter((rule) => !isLegacyWildcardAllow(rule));
    if (sanitized.length === permission.length) {
      return;
    }
    yield* apiEffect("legacy permission cleanup", () =>
      updatePermission({
        permission: sanitized,
        sessionId: identity.sessionId,
      })
    );
  });
  const inspectSession = (
    identity: OpenCodeSessionIdentity
  ): Effect.Effect<OpenCodeSessionInspection> =>
    Effect.tryPromise({
      try: () => api.get({ sessionId: identity.sessionId }),
      catch: (error) => ({ notFound: isNotFound(error) }),
    }).pipe(
      Effect.match({
        onFailure: (error): OpenCodeSessionInspection =>
          error.notFound ? { status: "missing" } : { status: "ambiguous" },
        onSuccess: (existing): OpenCodeSessionInspection => {
          if (
            typeof existing?.id !== "string" ||
            typeof existing?.workingDirectory !== "string"
          ) {
            return { status: "malformed" };
          }
          return existing.id === identity.sessionId &&
            existing.workingDirectory === identity.workingDirectory
            ? { status: "available" }
            : { status: "conflicting" };
        },
      })
    );
  const readSessionMessages = (
    identity: OpenCodeSessionIdentity
  ): Effect.Effect<readonly OpenCodeSessionMessage[], HandlerFailure> =>
    apiEffect("message read", () =>
      api.messages({
        limit: MAX_SESSION_MESSAGES,
        order: "desc",
        sessionId: identity.sessionId,
        workingDirectory: identity.workingDirectory,
      })
    ).pipe(Effect.map(EffectArray.reverse));
  const preflightPrompt = Effect.fnUntraced(function* (
    input: OpenCodePromptInput,
    sessionIdentity: OpenCodeSessionIdentity
  ) {
    const exists = yield* sessionExists(sessionIdentity);
    if (!exists) {
      if (!isolatePrompts) {
        return yield* protocolFailure("OpenCode session is unavailable");
      }
      yield* createSession(sessionIdentity);
      const createdAtExpectedIdentity = yield* sessionExists(sessionIdentity);
      if (!createdAtExpectedIdentity) {
        return yield* protocolFailure(
          "OpenCode session is unavailable after creation"
        );
      }
    }
    const persistedMessages = yield* readSessionMessages(sessionIdentity);
    const persistedPrompt = EffectArray.findFirst(
      persistedMessages,
      (message) => message.role === "user" && message.id === input.promptId
    );
    if (Option.isNone(persistedPrompt)) {
      return false;
    }
    if (persistedPrompt.value.text !== input.text) {
      return yield* protocolFailure("OpenCode prompt identity conflicts");
    }
    return true;
  });
  return {
    createSession,
    inspectSession,
    interrupt: (identity) => {
      const sessionIdentity = promptSessionIdentity(identity, isolatePrompts);
      return apiEffect("session interruption", () =>
        api.interrupt({ sessionId: sessionIdentity.sessionId })
      );
    },
    prepareSessionForReuse,
    readMessages: (identity) =>
      readSessionMessages(promptSessionIdentity(identity, isolatePrompts)),
    sessionExists,
    submitPrompt: (input) =>
      Effect.gen(function* () {
        const sessionIdentity = promptSessionIdentity(input, isolatePrompts);
        const alreadySubmitted = yield* preflightPrompt(input, sessionIdentity);
        if (alreadySubmitted) {
          return;
        }
        const admission = yield* Effect.result(
          apiEffect("prompt submission", () =>
            api.prompt({
              ...(options.agent === undefined ? {} : { agent: options.agent }),
              ...(options.model === undefined ? {} : { model: options.model }),
              promptId: input.promptId,
              sessionId: sessionIdentity.sessionId,
              text: input.text,
              ...(input.tools === undefined ? {} : { tools: input.tools }),
              workingDirectory: sessionIdentity.workingDirectory,
            })
          )
        );
        if (admission._tag === "Failure") {
          const recovered = yield* preflightPrompt(input, sessionIdentity);
          if (recovered) {
            return;
          }
          return yield* admission.failure;
        }
        const admitted = admission.success;
        if (admitted.id !== input.promptId) {
          return yield* protocolFailure("OpenCode prompt identity conflicts");
        }
      }),
    wait: (input) => {
      const sessionIdentity = promptSessionIdentity(input, isolatePrompts);
      const physicalInput: OpenCodePromptIdentity = {
        ...sessionIdentity,
        promptId: input.promptId,
      };
      return Effect.tryPromise({
        try: () => api.wait({ sessionId: sessionIdentity.sessionId }),
        catch: (error) => ({ unavailable: isSessionWaitUnavailable(error) }),
      }).pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            error.unavailable
              ? pollForPromptCompletion(
                  api,
                  physicalInput,
                  waitPollIntervalMs,
                  waitPollMaxAttempts
                )
              : Effect.fail(sdkFailure("session wait")),
          onSuccess: () => verifyPromptCompletion(api, physicalInput),
        })
      );
    },
  };
};

const projectedAssistantStatus = (
  message: OpenCodeLegacyMessage["info"]
): "completed" | "error" | "in-progress" => {
  if (message.error !== undefined) {
    return "error";
  }
  if (message.time.completed !== undefined || message.finish !== undefined) {
    return "completed";
  }
  return "in-progress";
};

const logicalPromptIdFromWireId = (wireId: string): string | null => {
  const match = LABORER_WIRE_MESSAGE_ID_PATTERN.exec(wireId);
  if (match?.[2] === undefined) {
    return null;
  }
  try {
    return Buffer.from(match[2], "base64url").toString("utf8");
  } catch {
    return null;
  }
};

const chronologicalMessageTime = (messageId: string): bigint | null => {
  const match =
    OPEN_CODE_NATIVE_MESSAGE_ID_PATTERN.exec(messageId) ??
    LABORER_WIRE_MESSAGE_ID_PATTERN.exec(messageId);
  return match?.[1] === undefined ? null : BigInt(`0x${match[1]}`);
};

const currentOpenCodeMessageTime = (): bigint =>
  (BigInt(Date.now()) * OPEN_CODE_MESSAGE_TIME_RADIX) %
  OPEN_CODE_MESSAGE_TIME_MODULUS;

const makeChronologicalWirePromptId = async (
  logicalPromptId: string,
  messages: readonly OpenCodeLegacyMessage[]
): Promise<string> => {
  let latestMessageTime = 0n;
  for (const message of messages) {
    const messageTime = chronologicalMessageTime(message.info.id);
    if (messageTime !== null && messageTime > latestMessageTime) {
      latestMessageTime = messageTime;
    }
  }
  for (
    let attempt = 0;
    attempt <= OPEN_CODE_MESSAGE_CLOCK_WAIT_MAX_ATTEMPTS;
    attempt += 1
  ) {
    const messageTime = currentOpenCodeMessageTime();
    if (messageTime > latestMessageTime) {
      const encodedLogicalPromptId = Buffer.from(
        logicalPromptId,
        "utf8"
      ).toString("base64url");
      return `msg_${messageTime.toString(16).padStart(12, "0")}_laborer_${encodedLogicalPromptId}`;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1);
    });
  }
  throw new Error("OpenCode message clock did not advance");
};

const projectedLegacyMessages = (
  messages: readonly OpenCodeLegacyMessage[]
): readonly OpenCodeSessionMessage[] =>
  pipe(
    messages,
    EffectArray.map((message): OpenCodeSessionMessage => {
      const text = pipe(
        message.parts,
        EffectArray.flatMap((part): readonly string[] =>
          part.type === "text" && typeof part.text === "string"
            ? [part.text]
            : []
        ),
        EffectArray.join("\n")
      );
      if (message.info.role === "user") {
        return {
          id: logicalPromptIdFromWireId(message.info.id) ?? message.info.id,
          role: "user",
          text,
        };
      }
      return {
        ...(message.info.finish === undefined
          ? {}
          : { finish: message.info.finish }),
        id: message.info.id,
        role: "assistant",
        status: projectedAssistantStatus(message.info),
        text,
      };
    })
  );

export const makeOpenCodeLegacySessionTransport = (
  api: OpenCodeLegacySessionApi
): Pick<OpenCodeV2SessionApi, "messages" | "prompt"> => ({
  messages: async (input) => {
    const response = await api.messages(
      {
        directory: input.workingDirectory,
        limit: input.limit,
        sessionID: input.sessionId,
      },
      { throwOnError: true }
    );
    // Legacy messages are oldest-first; the shared transport contract is
    // newest-first so its client can normalize every transport consistently.
    return pipe(projectedLegacyMessages(response.data), EffectArray.reverse);
  },
  prompt: async (input) => {
    const persisted = await api.messages(
      {
        directory: input.workingDirectory,
        limit: MAX_SESSION_MESSAGES,
        sessionID: input.sessionId,
      },
      { throwOnError: true }
    );
    const existingPrompt = projectedLegacyMessages(persisted.data).find(
      (message) => message.role === "user" && message.id === input.promptId
    );
    if (existingPrompt !== undefined) {
      if (existingPrompt.text !== input.text) {
        throw new Error("OpenCode prompt identity conflicts");
      }
      return { id: input.promptId };
    }
    const wirePromptId = await makeChronologicalWirePromptId(
      input.promptId,
      persisted.data
    );
    // Await admission from the selected HTTP endpoint. The production wrapper
    // uses promptAsync so user-policy `ask` requests cannot prevent the
    // Implementation session and its cancellation control from being attached.
    await api.prompt(
      {
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        directory: input.workingDirectory,
        messageID: wirePromptId,
        ...(input.model === undefined ? {} : { model: input.model }),
        parts: [{ text: input.text, type: "text" }],
        sessionID: input.sessionId,
        ...(input.tools === undefined ? {} : { tools: input.tools }),
      },
      { throwOnError: true }
    );
    return { id: input.promptId };
  },
});

export const makeOpenCodeWorkspaceSessionClient = Effect.fn(
  "makeOpenCodeWorkspaceSessionClient"
)(function* (
  options: OpenCodeWorkspaceSessionClientOptions
): Effect.fn.Return<OpenCodeSessionClient, HandlerFailure, Scope.Scope> {
  const server = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        launchOpenCodeServer({
          environment: options.environment,
          hostname: options.hostname ?? "127.0.0.1",
          port: options.port ?? 0,
          timeoutMs: options.serverTimeoutMs ?? 10_000,
        }),
      catch: () => sdkFailure("server launch"),
    }),
    (runningServer) =>
      Effect.tryPromise({
        try: () => runningServer.close(),
        catch: () => sdkFailure("server shutdown"),
      }).pipe(Effect.orDie)
  );
  const client = createOpencodeClient({
    baseUrl: server.url,
    directory: options.workspaceDirectory,
  });
  const session = client.v2.session;
  const legacySession = client.session;
  const legacyTransport = makeOpenCodeLegacySessionTransport({
    messages: async (input, requestOptions) => {
      const response = await legacySession.messages<true>(
        input,
        requestOptions
      );
      return { data: response.data };
    },
    prompt: async (input, requestOptions) => {
      await legacySession.promptAsync<true>(input, requestOptions);
    },
  });
  const api: OpenCodeV2SessionApi = {
    create: async (input) => {
      const response = await session.create<true>(
        {
          ...(input.agent === undefined ? {} : { agent: input.agent }),
          id: input.id,
          location: { directory: input.workingDirectory },
          ...(input.model === undefined
            ? {}
            : {
                model: {
                  id: input.model.modelID,
                  providerID: input.model.providerID,
                },
              }),
        },
        { throwOnError: true }
      );
      return { id: response.data.data.id };
    },
    get: async (input) => {
      const response = await session.get<true>(
        { sessionID: input.sessionId },
        { throwOnError: true }
      );
      return {
        id: response.data.data.id,
        workingDirectory: response.data.data.location.directory,
      };
    },
    getPermission: async (input) => {
      const response = await legacySession.get<true>(
        { sessionID: input.sessionId },
        { throwOnError: true }
      );
      return response.data.permission;
    },
    interrupt: async (input) => {
      await session.interrupt<true>(
        { sessionID: input.sessionId },
        { throwOnError: true }
      );
    },
    messages: legacyTransport.messages,
    prompt: legacyTransport.prompt,
    updatePermission: async (input) => {
      await legacySession.update<true>(
        {
          permission: [...input.permission],
          sessionID: input.sessionId,
        },
        { throwOnError: true }
      );
    },
    wait: async (input) => {
      await session.wait<true>(
        { sessionID: input.sessionId },
        { throwOnError: true }
      );
    },
  };
  return makeOpenCodeSessionClientFromV2Api(api, options);
});

export interface OpenCodeImplementationAgentOptions {
  readonly client: OpenCodeSessionClient;
}

const ensureSession = (
  client: OpenCodeSessionClient,
  identity: OpenCodeSessionIdentity
): Effect.Effect<void, HandlerFailure> =>
  Effect.gen(function* () {
    const exists = yield* client.sessionExists(identity);
    if (!exists) {
      yield* client.createSession(identity);
      return;
    }
    if (client.prepareSessionForReuse === undefined) {
      return yield* protocolFailure(
        "OpenCode legacy permission inspection is unavailable"
      );
    }
    yield* client.prepareSessionForReuse(identity);
  });

const implementationWorkflow = (
  request: ImplementationAgentRequest
): string => {
  const guidance =
    request.actionName === "deal-with-bug"
      ? "Bug workflow: reproduce the reported behavior, add a failing regression test, diagnose the root cause, implement the smallest fix, and run focused validation."
      : "Feature workflow: implement a vertical slice, add focused behavioral tests, preserve repository conventions, and run focused validation.";
  return `${guidance}\n\nUser request:\n${request.prompt}`;
};

const implementationFollowUpWorkflow = (
  request: ImplementationAgentResumeRequest
): string =>
  [
    "Continue an existing coding execution in the current working directory.",
    "Continue from the prior messages, tool activity, and work already completed in this OpenCode session. Inspect the current worktree and git diff when needed to confirm the latest state.",
    "Execute the new user request fully, preserve repository conventions, add or update focused tests when appropriate, and validate the resulting worktree.",
    `Execution: ${request.executionId}`,
    `New user request:\n${request.prompt}`,
  ].join("\n\n");

const messagesAfterPrompt = (
  messages: readonly OpenCodeSessionMessage[],
  promptId: string
): readonly OpenCodeSessionMessage[] | null => {
  const promptIndex = EffectArray.findFirstIndex(
    messages,
    (message) => message.role === "user" && message.id === promptId
  );
  return Option.isSome(promptIndex)
    ? pipe(
        messages,
        EffectArray.drop(promptIndex.value + 1),
        EffectArray.takeWhile((message) => message.role !== "user")
      )
    : null;
};

const acceptImplementationMessages = (
  messages: readonly OpenCodeSessionMessage[],
  promptId: string,
  acceptResponse: AcceptImplementationAgentResponse,
  requirePersistedPrompt: boolean
): Effect.Effect<void, HandlerFailure> => {
  const messagesAfterPersistedPrompt = messagesAfterPrompt(messages, promptId);
  if (messagesAfterPersistedPrompt === null && requirePersistedPrompt) {
    return Effect.fail(
      protocolFailure("OpenCode Implementation prompt is unavailable")
    );
  }
  const responses = EffectArray.filter(
    messagesAfterPersistedPrompt ?? messages,
    (message) => message.role === "assistant" && message.text.trim().length > 0
  );
  const exceedsLimit =
    responses.length > MAX_IMPLEMENTATION_RESPONSES ||
    EffectArray.some(
      responses,
      (message) => message.text.length > MAX_IMPLEMENTATION_RESPONSE_LENGTH
    );
  if (exceedsLimit) {
    return Effect.fail(
      protocolFailure("OpenCode Implementation response exceeded the limit")
    );
  }
  return Effect.forEach(
    responses,
    (message) => acceptResponse({ responseId: message.id, text: message.text }),
    { discard: true }
  );
};

const runImplementationPrompt = Effect.fn("OpenCodeImplementationAgent.run")(
  function* (
    client: OpenCodeSessionClient,
    identity: OpenCodeSessionIdentity,
    promptId: string,
    text: string,
    acceptResponse: AcceptImplementationAgentResponse
  ) {
    yield* client.submitPrompt({
      ...identity,
      promptId,
      text: yield* boundedPrompt(text),
    });
    yield* client.wait({ ...identity, promptId });
    yield* acceptImplementationMessages(
      yield* client.readMessages({ ...identity, promptId }),
      promptId,
      acceptResponse,
      true
    );
  }
);

const completeAdmittedImplementationPrompt = Effect.fn(
  "OpenCodeImplementationAgent.completeAdmittedPrompt"
)(function* (
  client: OpenCodeSessionClient,
  identity: OpenCodeSessionIdentity,
  promptId: string,
  acceptResponse: AcceptImplementationAgentResponse
) {
  yield* client.wait({ ...identity, promptId });
  yield* acceptImplementationMessages(
    yield* client.readMessages({ ...identity, promptId }),
    promptId,
    acceptResponse,
    true
  );
});

const implementationSession = (
  options: OpenCodeImplementationAgentOptions,
  identity: OpenCodeSessionIdentity,
  executionId: string,
  initialPromptId: string,
  completion: Effect.Effect<void, HandlerFailure>
): ImplementationAgentSession => {
  const serial = Semaphore.makeUnsafe(1);
  let activePromptId = initialPromptId;
  return {
    completion: serial.withPermit(completion),
    control: (controlRequest) => {
      if (
        controlRequest.executionId !== executionId ||
        controlRequest.implementationSessionId !== identity.sessionId ||
        controlRequest.workingDirectory !== identity.workingDirectory
      ) {
        return protocolFailure(
          "OpenCode Implementation control identity conflicts"
        );
      }
      return options.client.interrupt({
        ...identity,
        promptId: activePromptId,
      });
    },
    resume: (resumeRequest, resumeAcceptResponse) => {
      if (
        resumeRequest.implementationSessionId !== identity.sessionId ||
        resumeRequest.workingDirectory !== identity.workingDirectory ||
        resumeRequest.promptId === undefined
      ) {
        return protocolFailure(
          "OpenCode Implementation follow-up identity conflicts"
        );
      }
      const promptId = resumeRequest.promptId;
      return serial.withPermit(
        Effect.gen(function* () {
          activePromptId = promptId;
          if (options.client.prepareSessionForReuse === undefined) {
            return yield* protocolFailure(
              "OpenCode legacy permission inspection is unavailable"
            );
          }
          yield* options.client.prepareSessionForReuse(identity);
          yield* runImplementationPrompt(
            options.client,
            identity,
            promptId,
            implementationFollowUpWorkflow(resumeRequest),
            resumeAcceptResponse
          );
        })
      );
    },
    sessionId: identity.sessionId,
  };
};

export const makeOpenCodeImplementationAgent = (
  options: OpenCodeImplementationAgentOptions
): ImplementationAgentShape => ({
  inspect: Effect.fn("OpenCodeImplementationAgent.inspect")(function* (
    request: ImplementationAgentInspectionRequest
  ) {
    const identity: OpenCodeSessionIdentity = {
      sessionId: request.implementationSessionId,
      workingDirectory: request.workingDirectory,
    };
    const inspection: Effect.Effect<OpenCodeSessionInspection> =
      options.client.inspectSession?.(identity) ??
      options.client.sessionExists(identity).pipe(
        Effect.map(
          (exists): OpenCodeSessionInspection => ({
            status: exists ? "available" : "missing",
          })
        ),
        Effect.catch(() => Effect.succeed({ status: "ambiguous" as const }))
      );
    const inspected = yield* inspection;
    switch (inspected.status) {
      case "available":
        return {
          certainty: "definitive",
          evidence: "exact-owned-resource",
          resource: { sessionId: identity.sessionId },
          status: "available",
        } satisfies ResourceInspectionOutcome<{ readonly sessionId: string }>;
      case "missing":
        if (request.creationState === "unknown") {
          return {
            certainty: "unknown",
            evidence: "inspection-unavailable",
            status: "ambiguous",
          } satisfies ResourceInspectionOutcome<{
            readonly sessionId: string;
          }>;
        }
        return {
          certainty: "definitive",
          evidence: "definitively-absent",
          status:
            request.creationState === "staged" ? "recoverable" : "missing",
        } satisfies ResourceInspectionOutcome<{ readonly sessionId: string }>;
      case "conflicting":
        return {
          certainty: "definitive",
          evidence: "identity-conflict",
          status: "conflicting",
        } satisfies ResourceInspectionOutcome<{ readonly sessionId: string }>;
      case "malformed":
        return {
          certainty: "unknown",
          evidence: "malformed-inspection",
          status: "ambiguous",
        } satisfies ResourceInspectionOutcome<{ readonly sessionId: string }>;
      default:
        return {
          certainty: "unknown",
          evidence: "provider-inspection-failed",
          status: "ambiguous",
        } satisfies ResourceInspectionOutcome<{ readonly sessionId: string }>;
    }
  }),
  start: Effect.fn("OpenCodeImplementationAgent.start")(
    function* (request, acceptResponse) {
      const identity: OpenCodeSessionIdentity = {
        sessionId: request.implementationSessionId,
        workingDirectory: request.workingDirectory,
      };
      yield* ensureSession(options.client, identity);
      yield* options.client.submitPrompt({
        ...identity,
        promptId: request.promptId,
        text: yield* boundedPrompt(implementationWorkflow(request)),
      });
      return implementationSession(
        options,
        identity,
        request.executionId,
        request.promptId,
        completeAdmittedImplementationPrompt(
          options.client,
          identity,
          request.promptId,
          acceptResponse
        )
      );
    }
  ),
  recover: Effect.fn("OpenCodeImplementationAgent.recover")(
    function* (request, acceptResponse) {
      const identity: OpenCodeSessionIdentity = {
        sessionId: request.implementationSessionId,
        workingDirectory: request.workingDirectory,
      };
      const exists = yield* options.client.sessionExists(identity);
      if (!exists) {
        return yield* protocolFailure(
          "OpenCode Implementation session is unavailable"
        );
      }
      if (options.client.prepareSessionForReuse === undefined) {
        return yield* protocolFailure(
          "OpenCode legacy permission inspection is unavailable"
        );
      }
      yield* options.client.prepareSessionForReuse(identity);
      yield* options.client.submitPrompt({
        ...identity,
        promptId: request.promptId,
        text: yield* boundedPrompt(
          request.promptKind === "initial"
            ? implementationWorkflow(request)
            : implementationFollowUpWorkflow(request)
        ),
      });
      return implementationSession(
        options,
        identity,
        request.executionId,
        request.promptId,
        completeAdmittedImplementationPrompt(
          options.client,
          identity,
          request.promptId,
          acceptResponse
        )
      );
    }
  ),
});
