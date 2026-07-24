import { spawn } from "node:child_process";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { SessionMessage } from "@opencode-ai/sdk/v2/types";
import type { Scope } from "effect";
import { Effect, Array as EffectArray, Option, pipe, Semaphore } from "effect";
import { HandlerFailure } from "../prototype/errors.ts";
import type {
  AcceptImplementationAgentResponse,
  ConversationAction,
  ConversationAgentRequest,
  ConversationAgentShape,
  ConversationExecutionControl,
  ImplementationAgentRequest,
  ImplementationAgentSession,
  ImplementationAgentShape,
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
}

export interface OpenCodeSessionMessage {
  readonly finish?: string;
  readonly id: string;
  readonly role: "assistant" | "user";
  readonly status?: "completed" | "error" | "in-progress";
  readonly text: string;
}

export interface OpenCodeSessionClient {
  readonly createSession: (
    input: OpenCodeSessionIdentity
  ) => Effect.Effect<void, HandlerFailure>;
  readonly interrupt: (
    input: OpenCodeSessionIdentity
  ) => Effect.Effect<void, HandlerFailure>;
  readonly readMessages: (
    input: OpenCodeSessionIdentity
  ) => Effect.Effect<readonly OpenCodeSessionMessage[], HandlerFailure>;
  readonly sessionExists: (
    input: OpenCodeSessionIdentity
  ) => Effect.Effect<boolean, HandlerFailure>;
  readonly submitPrompt: (
    input: OpenCodePromptInput
  ) => Effect.Effect<void, HandlerFailure>;
  readonly wait: (
    input: Omit<OpenCodePromptInput, "text">
  ) => Effect.Effect<void, HandlerFailure>;
}

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
  readonly interrupt: (input: { readonly sessionId: string }) => Promise<void>;
  readonly messages: (input: {
    readonly limit: number;
    readonly order: "desc";
    readonly sessionId: string;
  }) => Promise<readonly OpenCodeSessionMessage[]>;
  readonly prompt: (input: {
    readonly promptId: string;
    readonly sessionId: string;
    readonly text: string;
  }) => Promise<{ readonly id: string }>;
  readonly wait: (input: { readonly sessionId: string }) => Promise<void>;
}

export interface OpenCodeSessionClientOptions {
  readonly agent?: string;
  readonly model?: OpenCodeModel;
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
const MAX_PROTOCOL_RESPONSE_LENGTH = 16_384;
const MAX_IMPLEMENTATION_RESPONSES = 64;
const MAX_PROMPT_LENGTH = 65_536;
const MAX_SERVER_STARTUP_OUTPUT_LENGTH = 65_536;
const DEFAULT_WAIT_POLL_INTERVAL_MILLIS = 1000;
const DEFAULT_WAIT_POLL_MAX_ATTEMPTS = 3600;
const SERVER_STOP_GRACE_MILLIS = 250;
const SERVER_URL_PATTERN =
  /opencode server listening.*on\s+(https?:\/\/[^\s]+)/;

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
  const waitPollIntervalMs =
    options.waitPollIntervalMs ?? DEFAULT_WAIT_POLL_INTERVAL_MILLIS;
  const waitPollMaxAttempts =
    options.waitPollMaxAttempts ?? DEFAULT_WAIT_POLL_MAX_ATTEMPTS;
  return {
    createSession: (identity) =>
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
      ),
    interrupt: (identity) =>
      apiEffect("session interruption", () =>
        api.interrupt({ sessionId: identity.sessionId })
      ),
    readMessages: (identity) =>
      apiEffect("message read", () =>
        api.messages({
          limit: MAX_SESSION_MESSAGES,
          order: "desc",
          sessionId: identity.sessionId,
        })
      ).pipe(Effect.map(EffectArray.reverse)),
    sessionExists: (identity) =>
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
          onSuccess: (existing) =>
            existing.id === identity.sessionId &&
            existing.workingDirectory === identity.workingDirectory
              ? Effect.succeed(true)
              : protocolFailure("OpenCode session identity conflicts"),
        })
      ),
    submitPrompt: (input) =>
      apiEffect("prompt submission", () =>
        api.prompt({
          promptId: input.promptId,
          sessionId: input.sessionId,
          text: input.text,
        })
      ).pipe(
        Effect.flatMap((admitted) =>
          admitted.id === input.promptId
            ? Effect.void
            : protocolFailure("OpenCode prompt identity conflicts")
        )
      ),
    wait: (input) =>
      Effect.tryPromise({
        try: () => api.wait({ sessionId: input.sessionId }),
        catch: (error) => ({ unavailable: isSessionWaitUnavailable(error) }),
      }).pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            error.unavailable
              ? pollForPromptCompletion(
                  api,
                  input,
                  waitPollIntervalMs,
                  waitPollMaxAttempts
                )
              : Effect.fail(sdkFailure("session wait")),
          onSuccess: () => verifyPromptCompletion(api, input),
        })
      ),
  };
};

const projectedAssistantStatus = (
  message: Extract<SessionMessage, { readonly type: "assistant" }>
): "completed" | "error" | "in-progress" => {
  if (message.error !== undefined) {
    return "error";
  }
  if (message.time.completed !== undefined || message.finish !== undefined) {
    return "completed";
  }
  return "in-progress";
};

const projectedMessages = (
  messages: readonly SessionMessage[]
): readonly OpenCodeSessionMessage[] =>
  pipe(
    messages,
    EffectArray.flatMap((message): readonly OpenCodeSessionMessage[] => {
      if (message.type === "user") {
        return [{ id: message.id, role: "user", text: message.text }];
      }
      if (message.type !== "assistant") {
        return [];
      }
      const text = pipe(
        message.content,
        EffectArray.flatMap((content): readonly string[] =>
          content.type === "text" ? [content.text] : []
        ),
        EffectArray.join("\n")
      );
      return [
        {
          ...(message.finish === undefined ? {} : { finish: message.finish }),
          id: message.id,
          role: "assistant",
          status: projectedAssistantStatus(message),
          text,
        },
      ];
    })
  );

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
    interrupt: async (input) => {
      await session.interrupt<true>(
        { sessionID: input.sessionId },
        { throwOnError: true }
      );
    },
    messages: async (input) => {
      const response = await session.messages<true>(
        {
          limit: input.limit,
          order: input.order,
          sessionID: input.sessionId,
        },
        { throwOnError: true }
      );
      return projectedMessages(response.data.data);
    },
    prompt: async (input) => {
      const response = await session.prompt<true>(
        {
          delivery: "queue",
          id: input.promptId,
          prompt: { text: input.text },
          resume: true,
          sessionID: input.sessionId,
        },
        { throwOnError: true }
      );
      return { id: response.data.data.id };
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

export interface OpenCodeConversationAgentOptions {
  readonly client: OpenCodeSessionClient;
  readonly repositoryDirectory: string;
}

export interface OpenCodeImplementationAgentOptions {
  readonly client: OpenCodeSessionClient;
}

type ConversationProtocolRecord =
  | {
      readonly action: string;
      readonly input: unknown;
      readonly type: "action";
    }
  | {
      readonly control: string;
      readonly input: unknown;
      readonly type: "execution_control";
    }
  | { readonly text: string; readonly type: "reply" };

const protocolFailure = (safeDetail: string): HandlerFailure =>
  HandlerFailure.make({ category: "protocol", safeDetail });

const boundedPrompt = (text: string): Effect.Effect<string, HandlerFailure> =>
  text.length <= MAX_PROMPT_LENGTH
    ? Effect.succeed(text)
    : Effect.fail(protocolFailure("OpenCode prompt exceeded the limit"));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseConversationRecord = (
  text: string
): Effect.Effect<ConversationProtocolRecord, HandlerFailure> => {
  if (text.length > MAX_PROTOCOL_RESPONSE_LENGTH) {
    return Effect.fail(
      protocolFailure("OpenCode Conversation response exceeded the limit")
    );
  }
  return Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: (): HandlerFailure =>
      protocolFailure("OpenCode Conversation response is invalid"),
  }).pipe(
    Effect.flatMap(
      (value): Effect.Effect<ConversationProtocolRecord, HandlerFailure> => {
        if (!isRecord(value) || typeof value.type !== "string") {
          return Effect.fail(
            protocolFailure("OpenCode Conversation response is invalid")
          );
        }
        if (
          value.type === "reply" &&
          typeof value.text === "string" &&
          Object.keys(value).length === 2
        ) {
          return Effect.succeed<ConversationProtocolRecord>({
            text: value.text,
            type: "reply",
          });
        }
        if (
          value.type === "action" &&
          typeof value.action === "string" &&
          "input" in value &&
          Object.keys(value).length === 3
        ) {
          return Effect.succeed<ConversationProtocolRecord>({
            action: value.action,
            input: value.input,
            type: "action",
          });
        }
        if (
          value.type === "execution_control" &&
          typeof value.control === "string" &&
          "input" in value &&
          Object.keys(value).length === 3
        ) {
          return Effect.succeed<ConversationProtocolRecord>({
            control: value.control,
            input: value.input,
            type: "execution_control",
          });
        }
        return Effect.fail(
          protocolFailure("OpenCode Conversation response is invalid")
        );
      }
    )
  );
};

const findAction = (
  actions: readonly ConversationAction[],
  name: string
): ConversationAction | null =>
  pipe(
    actions,
    EffectArray.findFirst((action) => action.name === name),
    Option.getOrNull
  );

const findExecutionControl = (
  controls: readonly ConversationExecutionControl[],
  name: string
): ConversationExecutionControl | null =>
  pipe(
    controls,
    EffectArray.findFirst((control) => control.name === name),
    Option.getOrNull
  );

const renderConversationPrompt = (request: ConversationAgentRequest): string =>
  JSON.stringify({
    instructions: [
      "You are the Conversation agent. Decide autonomously whether to invoke an available Action or reply to Slack.",
      "You are a routing agent, not an implementation agent. Do not call todowrite, task, skill, or other orchestration tools. Decide directly from the supplied conversation. Use repository inspection tools only when required to answer a repository question.",
      "Return exactly one JSON object and no markdown.",
      'Action: {"type":"action","action":"<available name>","input":<JSON>}.',
      'Execution control: {"type":"execution_control","control":"<available name>","input":<JSON>}.',
      'Reply: {"type":"reply","text":"<Slack reply>"}.',
      "Only a reply record is shown to Slack. Coding Actions and generic Execution controls are separate interfaces.",
    ],
    availableActions: EffectArray.map(request.actions, (action) => ({
      description: action.description,
      name: action.name,
    })),
    conversation: {
      context: request.context,
      executions: request.executions,
      input: request.input,
      messages: request.messages,
      source: request.source,
    },
    executionControls: EffectArray.map(
      request.executionControls,
      (control) => ({
        description: control.description,
        name: control.name,
      })
    ),
  });

const ensureSession = (
  client: OpenCodeSessionClient,
  identity: OpenCodeSessionIdentity
): Effect.Effect<void, HandlerFailure> =>
  client
    .sessionExists(identity)
    .pipe(
      Effect.flatMap((exists) =>
        exists ? Effect.void : client.createSession(identity)
      )
    );

const isFirstConversationPrompt = (
  request: ConversationAgentRequest
): boolean => request.conversationSessionIsNew;

const ensureConversationSession = (
  client: OpenCodeSessionClient,
  identity: OpenCodeSessionIdentity,
  request: ConversationAgentRequest
): Effect.Effect<void, HandlerFailure> =>
  client.sessionExists(identity).pipe(
    Effect.flatMap((exists) => {
      if (exists) {
        return Effect.void;
      }
      return isFirstConversationPrompt(request)
        ? client.createSession(identity)
        : protocolFailure("OpenCode Conversation session is unavailable");
    })
  );

const hasPrompt = (
  messages: readonly OpenCodeSessionMessage[],
  promptId: string
): boolean =>
  EffectArray.some(
    messages,
    (message) => message.role === "user" && message.id === promptId
  );

const nextUnprocessedAssistantMessage = (
  messages: readonly OpenCodeSessionMessage[],
  processed: ReadonlySet<string>,
  promptId: string
): OpenCodeSessionMessage | null =>
  pipe(
    (() => {
      const promptIndex = EffectArray.findFirstIndex(
        messages,
        (message) => message.role === "user" && message.id === promptId
      );
      if (Option.isSome(promptIndex)) {
        return pipe(
          messages,
          EffectArray.drop(promptIndex.value + 1),
          EffectArray.takeWhile((message) => message.role !== "user")
        );
      }
      return [];
    })(),
    EffectArray.findFirst(
      (message) =>
        message.role === "assistant" &&
        !processed.has(message.id) &&
        message.text.trim().length > 0 &&
        (message.status === undefined || isTerminalAssistant(message))
    ),
    Option.getOrNull
  );

type ConversationInvocationRecord = Exclude<
  ConversationProtocolRecord,
  { readonly type: "reply" }
>;

const invokeConversationOperation = Effect.fnUntraced(function* (
  request: ConversationAgentRequest,
  record: ConversationInvocationRecord
) {
  const invocationTarget =
    record.type === "action"
      ? findAction(request.actions, record.action)
      : findExecutionControl(request.executionControls, record.control);
  if (invocationTarget === null) {
    return yield* protocolFailure(
      record.type === "action"
        ? "OpenCode Conversation requested an unavailable Action"
        : "OpenCode Conversation requested an unavailable Execution control"
    );
  }
  const invocation = yield* Effect.result(
    invocationTarget.invoke(record.input)
  );
  const result =
    invocation._tag === "Success"
      ? { status: "success" as const, value: invocation.success }
      : {
          error: {
            category: invocation.failure.category,
            safeDetail: invocation.failure.safeDetail,
          },
          status: "failure" as const,
        };
  return record.type === "action"
    ? {
        action: record.action,
        result,
        type: "action_result" as const,
      }
    : {
        control: record.control,
        result,
        type: "execution_control_result" as const,
      };
});

const runConversation = Effect.fn("OpenCodeConversationAgent.run")(function* (
  options: OpenCodeConversationAgentOptions,
  request: ConversationAgentRequest,
  submitInitialPrompt: boolean
) {
  const identity: OpenCodeSessionIdentity = {
    sessionId: request.conversationSessionId,
    workingDirectory: options.repositoryDirectory,
  };
  if (submitInitialPrompt) {
    const promptText = yield* boundedPrompt(renderConversationPrompt(request));
    yield* ensureConversationSession(options.client, identity, request);
    yield* options.client.submitPrompt({
      ...identity,
      promptId: request.promptId,
      text: promptText,
    });
  } else {
    const exists = yield* options.client.sessionExists(identity);
    if (!exists) {
      return yield* protocolFailure(
        "OpenCode Conversation session is unavailable"
      );
    }
    const persistedMessages = yield* options.client.readMessages(identity);
    if (!hasPrompt(persistedMessages, request.promptId)) {
      return yield* protocolFailure(
        "OpenCode Conversation prompt is unavailable"
      );
    }
  }

  const processed = new Set<string>();
  let activePromptId = request.promptId;
  for (let round = 1; round <= 8; round += 1) {
    yield* options.client.wait({ ...identity, promptId: activePromptId });
    const messages = yield* options.client.readMessages(identity);
    const assistantMessage = nextUnprocessedAssistantMessage(
      messages,
      processed,
      activePromptId
    );
    if (assistantMessage === null) {
      return yield* protocolFailure(
        "OpenCode Conversation produced no response"
      );
    }
    processed.add(assistantMessage.id);
    const record = yield* parseConversationRecord(assistantMessage.text);
    if (record.type === "reply") {
      return [{ replyId: assistantMessage.id, text: record.text }];
    }
    const invocationResult = yield* invokeConversationOperation(
      request,
      record
    );
    const actionResultPromptId = `${request.promptId}:action-result:${round}`;
    const resultAlreadySubmitted = EffectArray.some(
      messages,
      (message) =>
        message.role === "user" && message.id === actionResultPromptId
    );
    if (!resultAlreadySubmitted) {
      const actionResultText = yield* boundedPrompt(
        JSON.stringify(invocationResult)
      );
      yield* options.client.submitPrompt({
        ...identity,
        promptId: actionResultPromptId,
        text: actionResultText,
      });
    }
    activePromptId = actionResultPromptId;
  }
  return yield* protocolFailure(
    "OpenCode Conversation exceeded the Action limit"
  );
});

export const makeOpenCodeConversationAgent = (
  options: OpenCodeConversationAgentOptions
): ConversationAgentShape => ({
  handle: (request) => runConversation(options, request, true),
  recover: (request) => runConversation(options, request, false),
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
      (message) => message.text.length > MAX_PROTOCOL_RESPONSE_LENGTH
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
      yield* client.readMessages(identity),
      promptId,
      acceptResponse,
      true
    );
  }
);

const implementationSession = (
  options: OpenCodeImplementationAgentOptions,
  identity: OpenCodeSessionIdentity,
  executionId: string,
  completion: Effect.Effect<void, HandlerFailure>
): ImplementationAgentSession => {
  const serial = Semaphore.makeUnsafe(1);
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
      return options.client.interrupt(identity);
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
      return serial.withPermit(
        runImplementationPrompt(
          options.client,
          identity,
          resumeRequest.promptId,
          resumeRequest.prompt,
          resumeAcceptResponse
        )
      );
    },
    sessionId: identity.sessionId,
  };
};

export const makeOpenCodeImplementationAgent = (
  options: OpenCodeImplementationAgentOptions
): ImplementationAgentShape => ({
  start: Effect.fn("OpenCodeImplementationAgent.start")(
    function* (request, acceptResponse) {
      const identity: OpenCodeSessionIdentity = {
        sessionId: request.implementationSessionId,
        workingDirectory: request.workingDirectory,
      };
      yield* ensureSession(options.client, identity);
      return implementationSession(
        options,
        identity,
        request.executionId,
        runImplementationPrompt(
          options.client,
          identity,
          request.promptId,
          implementationWorkflow(request),
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
      return implementationSession(
        options,
        identity,
        request.executionId,
        Effect.gen(function* () {
          yield* options.client.wait({
            ...identity,
            promptId: request.promptId,
          });
          yield* acceptImplementationMessages(
            yield* options.client.readMessages(identity),
            request.promptId,
            acceptResponse,
            true
          );
        })
      );
    }
  ),
});
