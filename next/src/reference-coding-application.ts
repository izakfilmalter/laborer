import { createHash, randomUUID } from "node:crypto";
import { type FileHandle, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import {
  Cause,
  Context,
  Effect,
  Array as EffectArray,
  Exit,
  FiberSet,
  Layer,
  Option,
  pipe,
  Ref,
  Schema,
  Scope,
  Semaphore,
} from "effect";
import {
  type AcceptApplicationEvent,
  Application,
  ApplicationConversationMessageChunk,
  type ApplicationEvent,
  ApplicationPublicReply,
  type ApplicationShape,
  ExternalInputEvent,
} from "./application.ts";
import { type NormalizedMessage, ThreadId } from "./prototype/domain.ts";
import { HandlerFailure } from "./prototype/errors.ts";
import {
  assertSafeFilePath,
  openRegularFileNoFollow,
  retainTrustedDirectory,
  verifyRetainedDirectory,
} from "./prototype/path-safety.ts";

export const ReferenceCodingActionName = Schema.Literals([
  "create-feature",
  "deal-with-bug",
]);
export type ReferenceCodingActionName = typeof ReferenceCodingActionName.Type;

const OPEN_CODE_ID_NAMESPACE = "laborer:reference-coding:v1";
const OPEN_CODE_SESSION_DIGEST_LENGTH = 60;

const stableOpenCodeId = (
  prefix: "msg" | "ses",
  purpose: string,
  internalId: string
): string => {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        internalId,
        namespace: OPEN_CODE_ID_NAMESPACE,
        purpose,
      })
    )
    .digest("hex");
  return `${prefix}_${
    prefix === "ses" ? digest.slice(0, OPEN_CODE_SESSION_DIGEST_LENGTH) : digest
  }`;
};

const conversationSessionId = (conversationId: string): string =>
  stableOpenCodeId("ses", "conversation-session", conversationId);

const implementationSessionId = (executionId: string): string =>
  stableOpenCodeId("ses", "implementation-session", executionId);

const implementationPromptId = (
  executionId: string,
  promptNumber: number
): string =>
  stableOpenCodeId(
    "msg",
    "implementation-prompt",
    `${executionId}:prompt:${promptNumber}`
  );

const CodingActionInput = Schema.Struct({
  prompt: Schema.NonEmptyString,
  worktreeName: Schema.NonEmptyString,
});

const ExecutionPromptInput = Schema.Struct({
  executionId: Schema.NonEmptyString,
  prompt: Schema.NonEmptyString,
});

const ExecutionControlInput = Schema.Struct({
  control: Schema.Literal("cancel"),
  executionId: Schema.NonEmptyString,
});

export const ExecutionControlName = Schema.Literals(["cancel", "prompt"]);
export type ExecutionControlName = typeof ExecutionControlName.Type;

export interface ConversationExecution {
  readonly actionName: ReferenceCodingActionName;
  readonly activePromptId: string | null;
  readonly conversationId: ThreadId;
  readonly executionId: string;
  readonly implementationSessionId: string | null;
  readonly status:
    | "starting"
    | "running"
    | "completed"
    | "failed"
    | "cancelled";
  readonly workingDirectory: string | null;
  readonly worktreeName: string;
}

export interface ActionInvocationAccepted {
  readonly executionId: string;
  readonly status: ConversationExecution["status"];
}

export interface ConversationAction {
  readonly description: string;
  readonly invoke: (
    input: unknown
  ) => Effect.Effect<ActionInvocationAccepted, HandlerFailure>;
  readonly name: ReferenceCodingActionName;
}

export interface ConversationExecutionControl {
  readonly description: string;
  readonly invoke: (
    input: unknown
  ) => Effect.Effect<ActionInvocationAccepted, HandlerFailure>;
  readonly name: ExecutionControlName;
}

export interface ConversationAgentReply {
  readonly replyId: string;
  readonly text: string;
}

export interface ConversationAgentMessageChunk {
  readonly messageId: string;
  readonly text: string;
}

export type PublishConversationAgentMessage = (
  message: ConversationAgentMessageChunk
) => Effect.Effect<void, HandlerFailure>;

export interface ConversationAgentRequest {
  readonly actions: readonly ConversationAction[];
  readonly context: readonly NormalizedMessage[];
  readonly conversationId: string;
  readonly conversationSessionId: string;
  readonly conversationSessionIsNew: boolean;
  readonly executionControls: readonly ConversationExecutionControl[];
  readonly executions: readonly ConversationExecution[];
  readonly input: string;
  readonly messages: readonly NormalizedMessage[];
  readonly promptId: string;
  readonly source: ApplicationEvent["source"];
  readonly turnId: string;
}

export interface ConversationAgentShape {
  readonly handle: (
    request: ConversationAgentRequest,
    publishMessage?: PublishConversationAgentMessage
  ) => Effect.Effect<readonly ConversationAgentReply[], HandlerFailure>;
  readonly recover?: (
    request: ConversationAgentRequest,
    publishMessage?: PublishConversationAgentMessage
  ) => Effect.Effect<readonly ConversationAgentReply[], HandlerFailure>;
}

export class ConversationAgent extends Context.Service<
  ConversationAgent,
  ConversationAgentShape
>()("@laborer/reference-coding/ConversationAgent") {
  static layer = (
    agent: ConversationAgentShape
  ): Layer.Layer<ConversationAgent> => Layer.succeed(ConversationAgent, agent);
}

export interface WorktreeRequest {
  readonly conversationId: string;
  readonly executionId: string;
  readonly worktreeName: string;
}

export interface Worktree {
  readonly workingDirectory: string;
}

export class WorktreeProvisioningUncertain extends Schema.TaggedErrorClass<WorktreeProvisioningUncertain>()(
  "WorktreeProvisioningUncertain",
  { failure: HandlerFailure }
) {}

type WorktreeProvisioningFailure =
  | HandlerFailure
  | WorktreeProvisioningUncertain;

export interface WorktreeValidationRequest extends WorktreeRequest {
  readonly workingDirectory: string;
}

export interface WorktreeManagerShape {
  readonly create: (
    request: WorktreeRequest
  ) => Effect.Effect<Worktree, WorktreeProvisioningFailure>;
  readonly recover?: (
    request: WorktreeRequest
  ) => Effect.Effect<Worktree, WorktreeProvisioningFailure>;
  readonly validate?: (
    request: WorktreeValidationRequest
  ) => Effect.Effect<void, HandlerFailure>;
}

export class WorktreeManager extends Context.Service<
  WorktreeManager,
  WorktreeManagerShape
>()("@laborer/reference-coding/WorktreeManager") {
  static layer = (
    manager: WorktreeManagerShape
  ): Layer.Layer<WorktreeManager> => Layer.succeed(WorktreeManager, manager);
}

export interface ImplementationAgentRequest {
  readonly actionName: ReferenceCodingActionName;
  readonly conversationId: string;
  readonly executionId: string;
  readonly implementationSessionId: string;
  readonly prompt: string;
  readonly promptId: string;
  readonly workingDirectory: string;
}

export interface ImplementationAgentSession {
  readonly completion: Effect.Effect<void, HandlerFailure>;
  readonly control?: (
    request: ImplementationAgentControlRequest
  ) => Effect.Effect<void, HandlerFailure>;
  readonly resume: (
    request: ImplementationAgentResumeRequest,
    acceptResponse: AcceptImplementationAgentResponse
  ) => Effect.Effect<void, HandlerFailure>;
  readonly sessionId: string;
}

export interface ImplementationAgentControlRequest {
  readonly control: "cancel";
  readonly conversationId: ThreadId;
  readonly executionId: string;
  readonly implementationSessionId: string;
  readonly workingDirectory: string;
}

export interface ImplementationAgentResumeRequest {
  readonly conversationId: ThreadId;
  readonly executionId: string;
  readonly implementationSessionId?: string;
  readonly prompt: string;
  readonly promptId?: string;
  readonly workingDirectory: string;
}

export interface ImplementationAgentResponse {
  readonly responseId: string;
  readonly text: string;
}

export type AcceptImplementationAgentResponse = (
  response: ImplementationAgentResponse
) => Effect.Effect<void, HandlerFailure>;

export interface ImplementationAgentShape {
  readonly recover?: (
    request: ImplementationAgentRecoveryRequest,
    acceptResponse: AcceptImplementationAgentResponse
  ) => Effect.Effect<ImplementationAgentSession, HandlerFailure>;
  readonly start: (
    request: ImplementationAgentRequest,
    acceptResponse: AcceptImplementationAgentResponse
  ) => Effect.Effect<ImplementationAgentSession, HandlerFailure>;
}

export interface ImplementationAgentRecoveryRequest
  extends ImplementationAgentRequest {
  readonly promptKind: "initial" | "resume";
}

export class ImplementationAgent extends Context.Service<
  ImplementationAgent,
  ImplementationAgentShape
>()("@laborer/reference-coding/ImplementationAgent") {
  static layer = (
    agent: ImplementationAgentShape
  ): Layer.Layer<ImplementationAgent> =>
    Layer.succeed(ImplementationAgent, agent);
}

interface ReferenceCodingApplicationOptions {
  readonly conversationAgent: ConversationAgentShape;
  readonly implementationAgent: ImplementationAgentShape;
  readonly repository?: ReferenceCodingApplicationRepository;
  readonly worktreeManager: WorktreeManagerShape;
}

class PersistedConversationReply extends Schema.Class<PersistedConversationReply>(
  "PersistedConversationReply"
)({
  replyId: Schema.NonEmptyString,
  text: Schema.NonEmptyString,
}) {}

class PersistedConversationPrompt extends Schema.Class<PersistedConversationPrompt>(
  "PersistedConversationPrompt"
)({
  fingerprint: Schema.String,
  promptId: Schema.NonEmptyString,
  replies: Schema.Array(PersistedConversationReply),
  status: Schema.Literals(["staged", "running", "completed"]),
}) {}

class PersistedConversation extends Schema.Class<PersistedConversation>(
  "PersistedConversation"
)({
  conversationId: Schema.NonEmptyString,
  prompts: Schema.Array(PersistedConversationPrompt),
  sessionId: Schema.NonEmptyString,
}) {}

class PersistedImplementationPrompt extends Schema.Class<PersistedImplementationPrompt>(
  "PersistedImplementationPrompt"
)({
  kind: Schema.Literals(["initial", "resume"]),
  promptId: Schema.NonEmptyString,
  status: Schema.Literals(["staged", "running", "completed", "failed"]),
  text: Schema.NonEmptyString,
}) {}

class PersistedImplementationResponse extends Schema.Class<PersistedImplementationResponse>(
  "PersistedImplementationResponse"
)({
  eventId: Schema.NonEmptyString,
  responseId: Schema.NonEmptyString,
  status: Schema.Literals(["staged", "accepted"]),
  text: Schema.String,
}) {}

class PersistedExecutionEvent extends Schema.Class<PersistedExecutionEvent>(
  "PersistedExecutionEvent"
)({
  eventId: Schema.NonEmptyString,
  payload: Schema.Unknown,
  source: Schema.NonEmptyString,
  status: Schema.Literals(["staged", "accepted"]),
}) {}

class PersistedExecution extends Schema.Class<PersistedExecution>(
  "PersistedExecution"
)({
  actionInvocationId: Schema.NonEmptyString,
  actionName: ReferenceCodingActionName,
  conversationId: Schema.NonEmptyString,
  events: Schema.Array(PersistedExecutionEvent).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([]))
  ),
  executionId: Schema.NonEmptyString,
  implementationSessionId: Schema.NonEmptyString,
  prompts: Schema.Array(PersistedImplementationPrompt),
  responses: Schema.Array(PersistedImplementationResponse),
  status: Schema.Literals([
    "worktree_staged",
    "implementation_ready",
    "implementation_start_staged",
    "running",
    "completed",
    "failed",
    "cancelled",
  ]),
  workingDirectory: Schema.NullOr(Schema.String),
  worktreeName: Schema.NonEmptyString,
}) {}

class ReferenceCodingApplicationState extends Schema.Class<ReferenceCodingApplicationState>(
  "ReferenceCodingApplicationState"
)({
  conversations: Schema.Array(PersistedConversation),
  executions: Schema.Array(PersistedExecution),
  schemaVersion: Schema.Literal(1),
}) {}

const initialReferenceCodingApplicationState =
  ReferenceCodingApplicationState.make({
    conversations: [],
    executions: [],
    schemaVersion: 1,
  });

export interface ReferenceCodingApplicationRepository {
  readonly load: Effect.Effect<ReferenceCodingApplicationState, HandlerFailure>;
  readonly save: (
    state: ReferenceCodingApplicationState
  ) => Effect.Effect<ApplicationRepositoryPersistenceResult, HandlerFailure>;
}

export type ApplicationRepositoryPersistenceResult =
  | { readonly _tag: "Published" }
  | {
      readonly _tag: "PublishedWithError";
      readonly failureStage: ApplicationPersistenceStage;
    };

export type ApplicationPersistenceStage =
  | "after-rename-hook"
  | "assert-target"
  | "before-rename-hook"
  | "close-directory"
  | "close-temporary-file"
  | "create-temporary-file"
  | "rename"
  | "remove-temporary-file"
  | "sync-directory"
  | "sync-temporary-file"
  | "verify-directory-after-rename"
  | "verify-directory-before-rename"
  | "write-temporary-file";

export interface FileApplicationRepositoryHooks {
  readonly afterRename?: () => Promise<void>;
  readonly beforeRename?: () => Promise<void>;
}

const applicationStatePublished: ApplicationRepositoryPersistenceResult = {
  _tag: "Published",
};

const repositoryFailure = (): HandlerFailure =>
  HandlerFailure.make({
    category: "protocol",
    safeDetail: "Application repository is unavailable",
  });

export const makeInMemoryApplicationRepository = Effect.fn(
  "makeInMemoryApplicationRepository"
)(function* (): Effect.fn.Return<ReferenceCodingApplicationRepository> {
  const state = yield* Ref.make(initialReferenceCodingApplicationState);
  return {
    load: Ref.get(state),
    save: (next) =>
      Ref.set(state, next).pipe(Effect.as(applicationStatePublished)),
  };
});

const closeFile = async (file: FileHandle): Promise<void> => {
  await file.close();
};

const persistApplicationStatePromise = async (
  path: string,
  state: ReferenceCodingApplicationState,
  signal: AbortSignal,
  trustedRoot?: string,
  hooks?: FileApplicationRepositoryHooks
): Promise<ApplicationRepositoryPersistenceResult> => {
  const directory = await retainTrustedDirectory(
    dirname(path),
    "persist-application-state"
  );
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  let stage: ApplicationPersistenceStage = "assert-target";
  let failure:
    | { readonly cause: unknown; readonly stage: ApplicationPersistenceStage }
    | undefined;
  let wasPublished = false;
  try {
    signal.throwIfAborted();
    await assertSafeFilePath({
      ...(trustedRoot === undefined ? {} : { anchor: trustedRoot }),
      operation: "persist-application-state",
      path,
    });
    stage = "create-temporary-file";
    const file = await open(temporaryPath, "wx", 0o600);
    try {
      stage = "write-temporary-file";
      await file.writeFile(JSON.stringify(state), { encoding: "utf8", signal });
      stage = "sync-temporary-file";
      await file.sync();
    } finally {
      stage = "close-temporary-file";
      await closeFile(file);
    }
    stage = "before-rename-hook";
    await hooks?.beforeRename?.();
    signal.throwIfAborted();
    stage = "verify-directory-before-rename";
    await verifyRetainedDirectory(directory, "persist-application-state");
    stage = "assert-target";
    await assertSafeFilePath({
      ...(trustedRoot === undefined ? {} : { anchor: trustedRoot }),
      operation: "persist-application-state",
      path,
    });
    stage = "rename";
    await rename(temporaryPath, path);
    wasPublished = true;
    stage = "after-rename-hook";
    await hooks?.afterRename?.();
    stage = "verify-directory-after-rename";
    await verifyRetainedDirectory(directory, "persist-application-state");
    stage = "sync-directory";
    await directory.handle.sync();
  } catch (cause) {
    failure = { cause, stage };
  }
  if (!wasPublished) {
    try {
      stage = "remove-temporary-file";
      await rm(temporaryPath, { force: true });
    } catch (cause) {
      failure ??= { cause, stage };
    }
  }
  try {
    stage = "close-directory";
    await closeFile(directory.handle);
  } catch (cause) {
    failure ??= { cause, stage };
  }
  if (failure === undefined) {
    return applicationStatePublished;
  }
  if (wasPublished) {
    return { _tag: "PublishedWithError", failureStage: failure.stage };
  }
  throw failure.cause;
};

const persistApplicationState = (
  path: string,
  state: ReferenceCodingApplicationState,
  trustedRoot?: string,
  hooks?: FileApplicationRepositoryHooks
): Effect.Effect<ApplicationRepositoryPersistenceResult, HandlerFailure> =>
  Effect.tryPromise({
    try: (signal) =>
      persistApplicationStatePromise(path, state, signal, trustedRoot, hooks),
    catch: repositoryFailure,
  });

const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

const readApplicationStatePromise = async (
  path: string,
  trustedRoot?: string
): Promise<unknown> => {
  const directory = await retainTrustedDirectory(
    dirname(path),
    "load-application-state"
  );
  try {
    await assertSafeFilePath({
      ...(trustedRoot === undefined ? {} : { anchor: trustedRoot }),
      operation: "load-application-state",
      path,
    });
    const file = await openRegularFileNoFollow(path, "load-application-state");
    try {
      const source = fatalUtf8Decoder.decode(await file.readFile());
      await verifyRetainedDirectory(directory, "load-application-state");
      return JSON.parse(source) as unknown;
    } finally {
      await closeFile(file);
    }
  } finally {
    await closeFile(directory.handle);
  }
};

const isMissingFile = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ENOENT";

class ApplicationSnapshotMissing extends Schema.TaggedErrorClass<ApplicationSnapshotMissing>()(
  "ApplicationSnapshotMissing",
  {}
) {}

const loadApplicationState = (
  path: string,
  trustedRoot?: string
): Effect.Effect<
  ReferenceCodingApplicationState,
  ApplicationSnapshotMissing | HandlerFailure
> =>
  Effect.tryPromise({
    try: () => readApplicationStatePromise(path, trustedRoot),
    catch: (cause) =>
      isMissingFile(cause)
        ? ApplicationSnapshotMissing.make()
        : repositoryFailure(),
  }).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(ReferenceCodingApplicationState)(value).pipe(
        Effect.mapError(repositoryFailure)
      )
    )
  );

export const makeFileApplicationRepository = Effect.fn(
  "makeFileApplicationRepository"
)(function* (
  path: string,
  trustedRoot?: string,
  hooks?: FileApplicationRepositoryHooks
): Effect.fn.Return<ReferenceCodingApplicationRepository, HandlerFailure> {
  const initial = yield* loadApplicationState(path, trustedRoot).pipe(
    Effect.catchTag("ApplicationSnapshotMissing", () =>
      persistApplicationState(
        path,
        initialReferenceCodingApplicationState,
        trustedRoot,
        hooks
      ).pipe(Effect.as(initialReferenceCodingApplicationState))
    )
  );
  const state = yield* Ref.make(initial);
  const semaphore = yield* Semaphore.make(1);
  return {
    load: Ref.get(state),
    save: (next) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const acquired = yield* restore(semaphore.take(1));
          return yield* persistApplicationState(
            path,
            next,
            trustedRoot,
            hooks
          ).pipe(
            Effect.tap(() => Ref.set(state, next)),
            Effect.ensuring(semaphore.release(acquired))
          );
        })
      ),
  };
});

interface ExecutionRuntime {
  readonly acceptEvent: AcceptApplicationEvent;
  readonly acceptResponse: AcceptImplementationAgentResponse;
  readonly executionId: string;
  readonly pendingRuns: number;
  readonly runs: FiberSet.FiberSet<void, never>;
  readonly semaphore: Semaphore.Semaphore;
  readonly session: ImplementationAgentSession;
  readonly workingDirectory: string;
}

const publicExecution = (
  execution: PersistedExecution
): ConversationExecution => {
  const activePrompt = [...execution.prompts]
    .reverse()
    .find((prompt) => prompt.status !== "completed");
  let status: ConversationExecution["status"] = "starting";
  if (execution.status === "completed") {
    status = "completed";
  } else if (execution.status === "failed") {
    status = "failed";
  } else if (execution.status === "cancelled") {
    status = "cancelled";
  } else if (execution.status === "running") {
    status = "running";
  }
  return {
    actionName: execution.actionName,
    activePromptId:
      activePrompt?.promptId ?? execution.prompts.at(-1)?.promptId ?? null,
    conversationId: ThreadId.make(execution.conversationId),
    executionId: execution.executionId,
    implementationSessionId: execution.implementationSessionId,
    status,
    workingDirectory: execution.workingDirectory,
    worktreeName: execution.worktreeName,
  };
};

const decodeActionInput = (
  input: unknown
): Effect.Effect<typeof CodingActionInput.Type, HandlerFailure> =>
  Schema.decodeUnknownEffect(CodingActionInput)(input).pipe(
    Effect.mapError(() =>
      HandlerFailure.make({
        category: "protocol",
        safeDetail: "coding Action input is invalid",
      })
    )
  );

export const makeReferenceCodingApplication = Effect.fn(
  "makeReferenceCodingApplication"
)(function* (
  options: ReferenceCodingApplicationOptions
): Effect.fn.Return<ApplicationShape, HandlerFailure, Scope.Scope> {
  const applicationScope = yield* Effect.scope;
  const repository =
    options.repository ?? (yield* makeInMemoryApplicationRepository());
  const applicationState = yield* Ref.make(yield* repository.load);
  const applicationStateSemaphore = yield* Semaphore.make(1);
  const executions = yield* Ref.make<readonly ConversationExecution[]>(
    EffectArray.map(
      (yield* Ref.get(applicationState)).executions,
      publicExecution
    )
  );
  const executionRuntimes = yield* Ref.make<readonly ExecutionRuntime[]>([]);

  const modifyApplicationState = <A>(
    update: (
      state: ReferenceCodingApplicationState
    ) => readonly [A, ReferenceCodingApplicationState]
  ): Effect.Effect<A, HandlerFailure> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const acquired = yield* restore(applicationStateSemaphore.take(1));
        return yield* Effect.gen(function* () {
          const current = yield* Ref.get(applicationState);
          const [value, next] = update(current);
          const persistence = yield* repository.save(next);
          yield* Ref.set(applicationState, next);
          if (persistence._tag === "PublishedWithError") {
            yield* Effect.logError(
              "Application state was published with an ancillary durability failure",
              { failureStage: persistence.failureStage }
            );
          }
          return value;
        }).pipe(Effect.ensuring(applicationStateSemaphore.release(acquired)));
      })
    );

  const conversationPromptId = (event: ApplicationEvent): string =>
    stableOpenCodeId(
      "msg",
      "conversation-prompt",
      `conversation:${event.conversationId}:prompt:${
        event._tag === "ParticipantInput" ? event.turnId : event.eventId
      }`
    );

  const conversationFingerprint = (
    event: ApplicationEvent,
    input: string
  ): string =>
    JSON.stringify({
      context: event._tag === "ParticipantInput" ? event.context : [],
      input,
      messages: event._tag === "ParticipantInput" ? event.messages : [],
      source: event.source,
    });

  const stageConversationPrompt = Effect.fn(
    "ReferenceCodingApplication.stageConversationPrompt"
  )(function* (event: ApplicationEvent, input: string) {
    const promptId = conversationPromptId(event);
    const fingerprint = conversationFingerprint(event, input);
    return yield* modifyApplicationState<{
      readonly conversation: PersistedConversation;
      readonly isNew: boolean;
      readonly prompt: PersistedConversationPrompt;
      readonly sessionIsNew: boolean;
    }>((state) => {
      const conversation = state.conversations.find(
        (candidate) => candidate.conversationId === event.conversationId
      );
      const existing = conversation?.prompts.find(
        (prompt) => prompt.promptId === promptId
      );
      if (existing !== undefined) {
        return [
          {
            conversation: conversation as PersistedConversation,
            isNew: false,
            prompt: existing,
            sessionIsNew: false,
          },
          state,
        ] as const;
      }
      const prompt = PersistedConversationPrompt.make({
        fingerprint,
        promptId,
        replies: [],
        status: "staged",
      });
      const nextConversation =
        conversation === undefined
          ? PersistedConversation.make({
              conversationId: event.conversationId,
              prompts: [prompt],
              sessionId: conversationSessionId(event.conversationId),
            })
          : PersistedConversation.make({
              ...conversation,
              prompts: EffectArray.append(conversation.prompts, prompt),
            });
      const conversations =
        conversation === undefined
          ? EffectArray.append(state.conversations, nextConversation)
          : EffectArray.map(state.conversations, (candidate) =>
              candidate.conversationId === event.conversationId
                ? nextConversation
                : candidate
            );
      return [
        {
          conversation: nextConversation,
          isNew: true,
          prompt,
          sessionIsNew: conversation === undefined,
        },
        ReferenceCodingApplicationState.make({ ...state, conversations }),
      ] as const;
    }).pipe(
      Effect.flatMap((staged) =>
        staged.prompt.fingerprint === fingerprint
          ? Effect.succeed(staged)
          : HandlerFailure.make({
              category: "protocol",
              safeDetail: "Conversation prompt identity conflicts",
            })
      )
    );
  });

  const markConversationPromptRunning = (promptId: string) =>
    modifyApplicationState((state) => [
      undefined,
      ReferenceCodingApplicationState.make({
        ...state,
        conversations: EffectArray.map(state.conversations, (conversation) =>
          PersistedConversation.make({
            ...conversation,
            prompts: EffectArray.map(conversation.prompts, (prompt) =>
              prompt.promptId === promptId
                ? PersistedConversationPrompt.make({
                    ...prompt,
                    status: "running",
                  })
                : prompt
            ),
          })
        ),
      }),
    ]);

  const completeConversationPrompt = (
    promptId: string,
    replies: readonly ConversationAgentReply[]
  ) =>
    modifyApplicationState((state) => [
      undefined,
      ReferenceCodingApplicationState.make({
        ...state,
        conversations: EffectArray.map(state.conversations, (conversation) =>
          PersistedConversation.make({
            ...conversation,
            prompts: EffectArray.map(conversation.prompts, (prompt) =>
              prompt.promptId === promptId
                ? PersistedConversationPrompt.make({
                    ...prompt,
                    replies: EffectArray.map(replies, (reply) =>
                      PersistedConversationReply.make(reply)
                    ),
                    status: "completed",
                  })
                : prompt
            ),
          })
        ),
      }),
    ]);

  const allocateExecution = Effect.fn(
    "ReferenceCodingApplication.allocateExecution"
  )(function* (
    conversationId: ThreadId,
    actionInvocationId: string,
    actionName: ReferenceCodingActionName,
    prompt: string,
    worktreeName: string
  ) {
    const allocated = yield* modifyApplicationState<{
      readonly execution: PersistedExecution;
      readonly status: "allocated" | "conflict" | "duplicate";
    }>((state) => {
      const duplicate = pipe(
        state.executions,
        EffectArray.findFirst(
          (candidate) => candidate.actionInvocationId === actionInvocationId
        ),
        Option.getOrNull
      );
      if (duplicate !== null) {
        const initialPrompt = duplicate.prompts[0];
        const isExactDuplicate =
          duplicate.conversationId === conversationId &&
          duplicate.actionName === actionName &&
          initialPrompt?.text === prompt &&
          duplicate.worktreeName === worktreeName;
        return [
          {
            execution: duplicate,
            status: isExactDuplicate ? "duplicate" : "conflict",
          },
          state,
        ] as const;
      }
      const executionNumber =
        EffectArray.filter(
          state.executions,
          (candidate) => candidate.conversationId === conversationId
        ).length + 1;
      const executionId = `${conversationId}:execution:${executionNumber}`;
      const execution = PersistedExecution.make({
        actionInvocationId,
        actionName,
        conversationId,
        events: [],
        executionId,
        implementationSessionId: implementationSessionId(executionId),
        prompts: [
          PersistedImplementationPrompt.make({
            kind: "initial",
            promptId: implementationPromptId(executionId, 1),
            status: "staged",
            text: prompt,
          }),
        ],
        responses: [],
        status: "worktree_staged",
        workingDirectory: null,
        worktreeName,
      });
      return [
        { execution, status: "allocated" as const },
        ReferenceCodingApplicationState.make({
          ...state,
          executions: EffectArray.append(state.executions, execution),
        }),
      ] as const;
    });
    if (allocated.status === "conflict") {
      return yield* HandlerFailure.make({
        category: "protocol",
        safeDetail: "Action invocation identity conflicts",
      });
    }
    const execution = publicExecution(allocated.execution);
    yield* Ref.update(executions, (current) => {
      const hasExecution = EffectArray.some(
        current,
        (candidate) => candidate.executionId === execution.executionId
      );
      return hasExecution ? current : EffectArray.append(current, execution);
    });
    return { execution, status: allocated.status };
  });

  const updatePersistedExecution = (
    executionId: string,
    update: (execution: PersistedExecution) => PersistedExecution
  ) =>
    modifyApplicationState((state) => {
      const nextExecutions = EffectArray.map(state.executions, (execution) =>
        execution.executionId === executionId ? update(execution) : execution
      );
      return [
        nextExecutions.find(
          (execution) => execution.executionId === executionId
        ) ?? null,
        ReferenceCodingApplicationState.make({
          ...state,
          executions: nextExecutions,
        }),
      ] as const;
    }).pipe(
      Effect.tap((persisted) =>
        persisted === null
          ? Effect.void
          : Ref.update(executions, (current) =>
              EffectArray.map(current, (execution) =>
                execution.executionId === executionId
                  ? publicExecution(persisted)
                  : execution
              )
            )
      )
    );

  const appendExecutionEvent = (
    execution: PersistedExecution,
    event: PersistedExecutionEvent
  ): PersistedExecution => {
    const existing = pipe(
      execution.events,
      EffectArray.findFirst((candidate) => candidate.eventId === event.eventId),
      Option.getOrNull
    );
    if (existing !== null) {
      return execution;
    }
    return PersistedExecution.make({
      ...execution,
      events: EffectArray.append(execution.events, event),
    });
  };

  const acceptExecutionEvent = Effect.fn(
    "ReferenceCodingApplication.acceptExecutionEvent"
  )(function* (
    executionId: string,
    eventId: string,
    acceptEvent: AcceptApplicationEvent
  ) {
    const state = yield* Ref.get(applicationState);
    const execution = pipe(
      state.executions,
      EffectArray.findFirst(
        (candidate) => candidate.executionId === executionId
      ),
      Option.getOrNull
    );
    const event = pipe(
      execution?.events ?? [],
      EffectArray.findFirst((candidate) => candidate.eventId === eventId),
      Option.getOrNull
    );
    if (execution === null || event === null || event.status === "accepted") {
      return;
    }
    yield* acceptEvent(
      ExternalInputEvent.make({
        conversationId: ThreadId.make(execution.conversationId),
        eventId: event.eventId,
        payload: event.payload,
        source: event.source,
      })
    ).pipe(
      Effect.mapError(() =>
        HandlerFailure.make({
          category: "protocol",
          safeDetail: "Execution event was not accepted",
        })
      )
    );
    yield* updatePersistedExecution(executionId, (current) =>
      PersistedExecution.make({
        ...current,
        events: EffectArray.map(current.events, (candidate) =>
          candidate.eventId === eventId
            ? PersistedExecutionEvent.make({
                ...candidate,
                status: "accepted",
              })
            : candidate
        ),
      })
    );
  });

  const flushExecutionEvents = Effect.fn(
    "ReferenceCodingApplication.flushExecutionEvents"
  )(function* (
    execution: PersistedExecution,
    acceptEvent: AcceptApplicationEvent
  ) {
    yield* Effect.forEach(
      execution.events,
      (event) =>
        event.status === "staged"
          ? acceptExecutionEvent(
              execution.executionId,
              event.eventId,
              acceptEvent
            )
          : Effect.void,
      { discard: true }
    );
  });

  const discardStartingExecution = Effect.fn(
    "ReferenceCodingApplication.discardStartingExecution"
  )(function* (executionId: string) {
    yield* modifyApplicationState((state) => [
      undefined,
      ReferenceCodingApplicationState.make({
        ...state,
        executions: EffectArray.filter(
          state.executions,
          (execution) => execution.executionId !== executionId
        ),
      }),
    ]);
    yield* Ref.update(executions, (current) =>
      EffectArray.filter(
        current,
        (execution) =>
          execution.executionId !== executionId ||
          execution.status !== "starting"
      )
    );
  });

  const markRunning = Effect.fn("ReferenceCodingApplication.markRunning")(
    function* (executionId: string, implementationSessionId: string) {
      yield* updatePersistedExecution(executionId, (execution) =>
        PersistedExecution.make({
          ...execution,
          implementationSessionId,
          prompts: EffectArray.map(execution.prompts, (prompt) =>
            prompt.status === "staged"
              ? PersistedImplementationPrompt.make({
                  ...prompt,
                  status: "running",
                })
              : prompt
          ),
          status: "running",
        })
      );
      yield* Ref.update(executions, (current) =>
        EffectArray.map(current, (execution) =>
          execution.executionId === executionId
            ? {
                ...execution,
                implementationSessionId,
                status: "running" as const,
              }
            : execution
        )
      );
    }
  );

  const markCompleted = Effect.fn("ReferenceCodingApplication.markCompleted")(
    function* (executionId: string) {
      yield* updatePersistedExecution(executionId, (execution) =>
        PersistedExecution.make({
          ...execution,
          prompts: EffectArray.map(execution.prompts, (prompt) =>
            prompt.status === "running"
              ? PersistedImplementationPrompt.make({
                  ...prompt,
                  status: "completed",
                })
              : prompt
          ),
          status: "completed",
        })
      );
      yield* Ref.update(executions, (current) =>
        EffectArray.map(current, (execution) =>
          execution.executionId === executionId
            ? { ...execution, status: "completed" as const }
            : execution
        )
      );
    }
  );

  const completeExecutionRun = Effect.fn(
    "ReferenceCodingApplication.completeExecutionRun"
  )(function* (executionId: string) {
    const isCompleted = yield* Ref.modify(executionRuntimes, (current) => {
      let completed = false;
      const next = EffectArray.map(current, (runtime) => {
        if (runtime.executionId !== executionId) {
          return runtime;
        }
        const pendingRuns = Math.max(0, runtime.pendingRuns - 1);
        completed = pendingRuns === 0;
        return { ...runtime, pendingRuns };
      });
      return [completed, next] as const;
    });
    if (isCompleted) {
      const state = yield* Ref.get(applicationState);
      const execution = pipe(
        state.executions,
        EffectArray.findFirst(
          (candidate) => candidate.executionId === executionId
        ),
        Option.getOrNull
      );
      if (
        execution !== null &&
        execution.status !== "failed" &&
        execution.status !== "cancelled"
      ) {
        yield* markCompleted(executionId);
      }
    }
  });

  const failImplementationPrompt = Effect.fn(
    "ReferenceCodingApplication.failImplementationPrompt"
  )(function* (
    executionId: string,
    promptId: string,
    failure: HandlerFailure,
    acceptEvent: AcceptApplicationEvent
  ) {
    const eventId = `${executionId}:failure:${promptId}`;
    yield* updatePersistedExecution(executionId, (execution) =>
      appendExecutionEvent(
        PersistedExecution.make({
          ...execution,
          prompts: EffectArray.map(execution.prompts, (prompt) =>
            prompt.promptId === promptId
              ? PersistedImplementationPrompt.make({
                  ...prompt,
                  status: "failed",
                })
              : prompt
          ),
          status: "failed",
        }),
        PersistedExecutionEvent.make({
          eventId,
          payload: {
            category: failure.category,
            executionId,
            kind: "implementation-failure",
            promptId,
          },
          source: "implementation-failure",
          status: "staged",
        })
      )
    );
    yield* acceptExecutionEvent(executionId, eventId, acceptEvent);
  });

  const startRun = (
    runtime: ExecutionRuntime,
    promptId: string,
    run: Effect.Effect<void, HandlerFailure>
  ) =>
    runtime.semaphore
      .withPermit(
        Effect.gen(function* () {
          const state = yield* Ref.get(applicationState);
          const persisted = pipe(
            state.executions,
            EffectArray.findFirst(
              (execution) => execution.executionId === runtime.executionId
            ),
            Option.getOrNull
          );
          if (
            persisted === null ||
            persisted.status === "failed" ||
            persisted.status === "cancelled"
          ) {
            return;
          }
          const exit = yield* Effect.exit(run);
          if (Exit.isSuccess(exit)) {
            return yield* completeExecutionRun(runtime.executionId);
          }
          if (Cause.hasInterruptsOnly(exit.cause)) {
            return;
          }
          const failureReason = pipe(
            exit.cause.reasons,
            EffectArray.findFirst(Cause.isFailReason),
            Option.getOrNull
          );
          const failure =
            failureReason?.error instanceof HandlerFailure
              ? failureReason.error
              : HandlerFailure.make({
                  category: "protocol",
                  safeDetail: "implementation failed unexpectedly",
                });
          yield* Ref.update(executionRuntimes, (current) =>
            EffectArray.map(current, (candidate) =>
              candidate.executionId === runtime.executionId
                ? { ...candidate, pendingRuns: 0 }
                : candidate
            )
          );
          yield* failImplementationPrompt(
            runtime.executionId,
            promptId,
            failure,
            runtime.acceptEvent
          );
        })
      )
      .pipe(
        Effect.asVoid,
        Effect.exit,
        Effect.asVoid,
        FiberSet.run(runtime.runs, { startImmediately: true }),
        Effect.asVoid
      );

  const acceptImplementationResponse = (
    execution: ConversationExecution,
    acceptEvent: AcceptApplicationEvent
  ): AcceptImplementationAgentResponse =>
    Effect.fn("ReferenceCodingApplication.acceptImplementationResponse")(
      function* (response) {
        const eventId = `${execution.executionId}:response:${response.responseId}`;
        const staged = yield* updatePersistedExecution(
          execution.executionId,
          (persisted) => {
            const existing = persisted.responses.find(
              (candidate) => candidate.responseId === response.responseId
            );
            if (existing !== undefined) {
              return persisted;
            }
            return PersistedExecution.make({
              ...persisted,
              responses: EffectArray.append(
                persisted.responses,
                PersistedImplementationResponse.make({
                  eventId,
                  responseId: response.responseId,
                  status: "staged",
                  text: response.text,
                })
              ),
            });
          }
        );
        const persistedResponse = staged?.responses.find(
          (candidate) => candidate.responseId === response.responseId
        );
        if (
          persistedResponse === undefined ||
          persistedResponse.eventId !== eventId ||
          persistedResponse.text !== response.text
        ) {
          return yield* HandlerFailure.make({
            category: "protocol",
            safeDetail: "implementation response identity conflicts",
          });
        }
        if (persistedResponse.status === "accepted") {
          return;
        }
        yield* acceptEvent(
          ExternalInputEvent.make({
            conversationId: execution.conversationId,
            eventId,
            payload: {
              actionName: execution.actionName,
              executionId: execution.executionId,
              responseId: response.responseId,
              text: response.text,
            },
            source: "implementation-agent",
          })
        ).pipe(
          Effect.mapError(() =>
            HandlerFailure.make({
              category: "protocol",
              safeDetail: "implementation response was not accepted",
            })
          )
        );
        yield* updatePersistedExecution(execution.executionId, (persisted) =>
          PersistedExecution.make({
            ...persisted,
            responses: EffectArray.map(persisted.responses, (candidate) =>
              candidate.responseId === response.responseId
                ? PersistedImplementationResponse.make({
                    ...candidate,
                    status: "accepted",
                  })
                : candidate
            ),
          })
        );
      }
    );

  const recoverWorktree = Effect.fn(
    "ReferenceCodingApplication.recoverWorktree"
  )(function* (execution: PersistedExecution) {
    if (execution.status !== "worktree_staged") {
      return execution;
    }
    if (options.worktreeManager.recover === undefined) {
      return yield* HandlerFailure.make({
        category: "protocol",
        safeDetail: "worktree recovery is unavailable",
      });
    }
    const worktree = yield* options.worktreeManager.recover({
      conversationId: execution.conversationId,
      executionId: execution.executionId,
      worktreeName: execution.worktreeName,
    });
    const recovered = yield* updatePersistedExecution(
      execution.executionId,
      (current) =>
        PersistedExecution.make({
          ...current,
          status: "implementation_ready",
          workingDirectory: worktree.workingDirectory,
        })
    );
    return yield* recovered === null
      ? HandlerFailure.make({
          category: "protocol",
          safeDetail: "recovered Execution is unavailable",
        })
      : Effect.succeed(recovered);
  });

  const recoverUncertainWorktree = Effect.fn(
    "ReferenceCodingApplication.recoverUncertainWorktree"
  )(function* (
    execution: ConversationExecution,
    failure: WorktreeProvisioningUncertain
  ) {
    if (options.worktreeManager.recover === undefined) {
      return yield* failure.failure;
    }
    const recovery = yield* Effect.result(
      options.worktreeManager.recover({
        conversationId: execution.conversationId,
        executionId: execution.executionId,
        worktreeName: execution.worktreeName,
      })
    );
    if (recovery._tag === "Success") {
      return recovery.success;
    }
    return yield* recovery.failure._tag === "WorktreeProvisioningUncertain"
      ? recovery.failure.failure
      : recovery.failure;
  });

  const implementationSessionForRecovery = Effect.fn(
    "ReferenceCodingApplication.implementationSessionForRecovery"
  )(function* (
    execution: PersistedExecution,
    request: ImplementationAgentRecoveryRequest,
    acceptResponse: AcceptImplementationAgentResponse
  ) {
    if (execution.status === "implementation_ready") {
      const staged = yield* updatePersistedExecution(
        execution.executionId,
        (current) =>
          PersistedExecution.make({
            ...current,
            status: "implementation_start_staged",
          })
      );
      if (staged === null) {
        return yield* HandlerFailure.make({
          category: "protocol",
          safeDetail: "implementation start staging failed",
        });
      }
      return yield* options.implementationAgent.start(request, acceptResponse);
    }
    if (options.implementationAgent.recover === undefined) {
      return yield* HandlerFailure.make({
        category: "protocol",
        safeDetail: "implementation recovery is unavailable",
      });
    }
    return yield* options.implementationAgent.recover(request, acceptResponse);
  });

  const failExecutionRecovery = Effect.fn(
    "ReferenceCodingApplication.failExecutionRecovery"
  )(function* (
    execution: PersistedExecution,
    resource: "worktree" | "implementation-session",
    acceptEvent: AcceptApplicationEvent
  ) {
    const eventId = `${execution.executionId}:recovery-failure:${resource}`;
    yield* updatePersistedExecution(execution.executionId, (current) =>
      appendExecutionEvent(
        PersistedExecution.make({ ...current, status: "failed" }),
        PersistedExecutionEvent.make({
          eventId,
          payload: {
            executionId: execution.executionId,
            kind: "recovery-failure",
            resource,
          },
          source: "execution-recovery",
          status: "staged",
        })
      )
    );
    yield* acceptExecutionEvent(execution.executionId, eventId, acceptEvent);
  });

  const validateRecoveryWorktree = Effect.fn(
    "ReferenceCodingApplication.validateRecoveryWorktree"
  )(function* (execution: PersistedExecution) {
    if (execution.workingDirectory === null) {
      return yield* HandlerFailure.make({
        category: "protocol",
        safeDetail: "persisted worktree is unavailable",
      });
    }
    if (options.worktreeManager.validate === undefined) {
      return execution.workingDirectory;
    }
    yield* options.worktreeManager.validate({
      conversationId: execution.conversationId,
      executionId: execution.executionId,
      workingDirectory: execution.workingDirectory,
      worktreeName: execution.worktreeName,
    });
    return execution.workingDirectory;
  });

  const handleWorktreeRecoveryFailure = Effect.fn(
    "ReferenceCodingApplication.handleWorktreeRecoveryFailure"
  )(function* (
    execution: PersistedExecution,
    failure: WorktreeProvisioningFailure,
    acceptEvent: AcceptApplicationEvent
  ) {
    if (failure._tag === "WorktreeProvisioningUncertain") {
      yield* Effect.logWarning(
        "Worktree provisioning remains uncertain; retaining Execution for recovery",
        { executionId: execution.executionId }
      );
      return;
    }
    yield* failExecutionRecovery(execution, "worktree", acceptEvent);
  });

  const recoverExecution = Effect.fn(
    "ReferenceCodingApplication.recoverExecution"
  )(function* (
    initial: PersistedExecution,
    acceptEvent: AcceptApplicationEvent
  ) {
    const worktreeRecovery = yield* Effect.result(recoverWorktree(initial));
    if (worktreeRecovery._tag === "Failure") {
      return yield* handleWorktreeRecoveryFailure(
        initial,
        worktreeRecovery.failure,
        acceptEvent
      );
    }
    const persisted = worktreeRecovery.success;
    if (
      persisted.status === "completed" ||
      persisted.status === "failed" ||
      persisted.status === "cancelled"
    ) {
      return;
    }
    const validation = yield* Effect.result(
      validateRecoveryWorktree(persisted)
    );
    if (validation._tag === "Failure") {
      return yield* failExecutionRecovery(persisted, "worktree", acceptEvent);
    }
    const workingDirectory = validation.success;
    const activePrompt = [...persisted.prompts]
      .reverse()
      .find((prompt) => prompt.status !== "completed");
    if (activePrompt === undefined) {
      return yield* HandlerFailure.make({
        category: "protocol",
        safeDetail: "active implementation prompt is unavailable",
      });
    }
    const execution = publicExecution(persisted);
    const acceptResponse = acceptImplementationResponse(execution, acceptEvent);
    for (const response of persisted.responses) {
      if (response.status === "staged") {
        yield* acceptResponse({
          responseId: response.responseId,
          text: response.text,
        });
      }
    }
    const recoveryRequest: ImplementationAgentRecoveryRequest = {
      actionName: persisted.actionName,
      conversationId: persisted.conversationId,
      executionId: persisted.executionId,
      implementationSessionId: persisted.implementationSessionId,
      prompt: activePrompt.text,
      promptId: activePrompt.promptId,
      promptKind: activePrompt.kind,
      workingDirectory,
    };
    const sessionRecovery = yield* Effect.result(
      implementationSessionForRecovery(
        persisted,
        recoveryRequest,
        acceptResponse
      )
    );
    if (sessionRecovery._tag === "Failure") {
      return yield* failExecutionRecovery(
        persisted,
        "implementation-session",
        acceptEvent
      );
    }
    const session = sessionRecovery.success;
    if (session.sessionId !== persisted.implementationSessionId) {
      return yield* failExecutionRecovery(
        persisted,
        "implementation-session",
        acceptEvent
      );
    }
    yield* markRunning(persisted.executionId, session.sessionId);
    const runtime: ExecutionRuntime = {
      acceptEvent,
      acceptResponse,
      executionId: persisted.executionId,
      pendingRuns: 1,
      runs: yield* FiberSet.make<void, never>().pipe(
        Effect.provideService(Scope.Scope, applicationScope)
      ),
      semaphore: Semaphore.makeUnsafe(1),
      session,
      workingDirectory,
    };
    yield* Ref.update(executionRuntimes, (current) =>
      current.some(
        (candidate) => candidate.executionId === persisted.executionId
      )
        ? current
        : EffectArray.append(current, runtime)
    );
    yield* startRun(runtime, activePrompt.promptId, session.completion);
  });

  const rehydrateCompletedExecution = Effect.fn(
    "ReferenceCodingApplication.rehydrateCompletedExecution"
  )(function* (
    persisted: PersistedExecution,
    acceptEvent: AcceptApplicationEvent
  ) {
    const validation = yield* Effect.result(
      validateRecoveryWorktree(persisted)
    );
    if (validation._tag === "Failure") {
      return yield* failExecutionRecovery(persisted, "worktree", acceptEvent);
    }
    const lastPrompt = pipe(
      persisted.prompts,
      EffectArray.last,
      Option.getOrNull
    );
    if (
      lastPrompt === null ||
      options.implementationAgent.recover === undefined
    ) {
      return yield* failExecutionRecovery(
        persisted,
        "implementation-session",
        acceptEvent
      );
    }
    const execution = publicExecution(persisted);
    const acceptResponse = acceptImplementationResponse(execution, acceptEvent);
    const sessionResult = yield* Effect.result(
      options.implementationAgent.recover(
        {
          actionName: persisted.actionName,
          conversationId: persisted.conversationId,
          executionId: persisted.executionId,
          implementationSessionId: persisted.implementationSessionId,
          prompt: lastPrompt.text,
          promptId: lastPrompt.promptId,
          promptKind: lastPrompt.kind,
          workingDirectory: validation.success,
        },
        acceptResponse
      )
    );
    if (
      sessionResult._tag === "Failure" ||
      sessionResult.success.sessionId !== persisted.implementationSessionId
    ) {
      return yield* failExecutionRecovery(
        persisted,
        "implementation-session",
        acceptEvent
      );
    }
    const runtime: ExecutionRuntime = {
      acceptEvent,
      acceptResponse,
      executionId: persisted.executionId,
      pendingRuns: 0,
      runs: yield* FiberSet.make<void, never>().pipe(
        Effect.provideService(Scope.Scope, applicationScope)
      ),
      semaphore: Semaphore.makeUnsafe(1),
      session: sessionResult.success,
      workingDirectory: validation.success,
    };
    yield* Ref.update(executionRuntimes, (current) =>
      pipe(
        current,
        EffectArray.some(
          (candidate) => candidate.executionId === persisted.executionId
        )
      )
        ? current
        : EffectArray.append(current, runtime)
    );
  });

  const recoverApplication = Effect.fn("ReferenceCodingApplication.recover")(
    function* (acceptEvent: AcceptApplicationEvent) {
      const initialState = yield* Ref.get(applicationState);
      yield* Effect.forEach(
        initialState.executions,
        (execution) => flushExecutionEvents(execution, acceptEvent),
        { discard: true }
      );
      const state = yield* Ref.get(applicationState);
      yield* Effect.forEach(
        state.executions,
        (execution) => {
          if (execution.status === "completed") {
            return rehydrateCompletedExecution(execution, acceptEvent);
          }
          if (
            execution.status === "failed" ||
            execution.status === "cancelled"
          ) {
            return Effect.void;
          }
          return recoverExecution(execution, acceptEvent).pipe(
            Effect.forkIn(applicationScope, { startImmediately: true }),
            Effect.asVoid
          );
        },
        { discard: true }
      );
    }
  );

  const invokeCodingAction = Effect.fn(
    "ReferenceCodingApplication.invokeCodingAction"
  )(function* (
    conversationId: ThreadId,
    actionInvocationId: string,
    actionName: ReferenceCodingActionName,
    input: unknown,
    acceptEvent: AcceptApplicationEvent
  ) {
    const decoded = yield* decodeActionInput(input);
    const allocated = yield* allocateExecution(
      conversationId,
      actionInvocationId,
      actionName,
      decoded.prompt,
      decoded.worktreeName
    );
    const execution = allocated.execution;
    if (allocated.status === "duplicate") {
      return {
        executionId: execution.executionId,
        status: execution.status,
      };
    }
    const worktreeCreation = yield* Effect.result(
      options.worktreeManager.create({
        conversationId,
        executionId: execution.executionId,
        worktreeName: decoded.worktreeName,
      })
    );
    let worktree: Worktree;
    if (worktreeCreation._tag === "Failure") {
      if (worktreeCreation.failure._tag !== "WorktreeProvisioningUncertain") {
        yield* discardStartingExecution(execution.executionId);
        return yield* worktreeCreation.failure;
      }
      worktree = yield* recoverUncertainWorktree(
        execution,
        worktreeCreation.failure
      );
    } else {
      worktree = worktreeCreation.success;
    }
    const implementationReady = yield* updatePersistedExecution(
      execution.executionId,
      (persisted) =>
        PersistedExecution.make({
          ...persisted,
          status: "implementation_ready",
          workingDirectory: worktree.workingDirectory,
        })
    );
    if (implementationReady === null) {
      return yield* HandlerFailure.make({
        category: "protocol",
        safeDetail: "Execution disappeared before implementation start",
      });
    }
    const implementationStaged = yield* updatePersistedExecution(
      execution.executionId,
      (persisted) =>
        PersistedExecution.make({
          ...persisted,
          status: "implementation_start_staged",
        })
    );
    if (implementationStaged === null) {
      return yield* HandlerFailure.make({
        category: "protocol",
        safeDetail: "Execution disappeared while staging implementation",
      });
    }
    const initialPrompt = implementationStaged.prompts[0];
    if (initialPrompt === undefined) {
      return yield* HandlerFailure.make({
        category: "protocol",
        safeDetail: "Execution prompt is unavailable",
      });
    }
    const durableExecution = publicExecution(implementationStaged);
    const acceptResponse = acceptImplementationResponse(
      durableExecution,
      acceptEvent
    );
    const implementationStart = yield* Effect.result(
      options.implementationAgent.start(
        {
          actionName,
          conversationId,
          executionId: execution.executionId,
          implementationSessionId: implementationStaged.implementationSessionId,
          prompt: decoded.prompt,
          promptId: initialPrompt.promptId,
          workingDirectory: worktree.workingDirectory,
        },
        acceptResponse
      )
    );
    if (implementationStart._tag === "Failure") {
      yield* failImplementationPrompt(
        execution.executionId,
        initialPrompt.promptId,
        implementationStart.failure,
        acceptEvent
      );
      return yield* implementationStart.failure;
    }
    const implementationSession = implementationStart.success;
    if (
      implementationSession.sessionId !==
      implementationStaged.implementationSessionId
    ) {
      const conflict = HandlerFailure.make({
        category: "protocol",
        safeDetail: "implementation session identity conflicts",
      });
      yield* failImplementationPrompt(
        execution.executionId,
        initialPrompt.promptId,
        conflict,
        acceptEvent
      );
      return yield* conflict;
    }
    yield* markRunning(execution.executionId, implementationSession.sessionId);
    const runtime: ExecutionRuntime = {
      acceptEvent,
      acceptResponse,
      executionId: execution.executionId,
      pendingRuns: 1,
      runs: yield* FiberSet.make<void, never>().pipe(
        Effect.provideService(Scope.Scope, applicationScope)
      ),
      semaphore: Semaphore.makeUnsafe(1),
      session: implementationSession,
      workingDirectory: worktree.workingDirectory,
    };
    yield* Ref.update(executionRuntimes, (current) =>
      EffectArray.append(current, runtime)
    );
    yield* startRun(
      runtime,
      initialPrompt.promptId,
      implementationSession.completion
    );
    return {
      executionId: execution.executionId,
      status: "running" as const,
    };
  });

  const invokeExecutionPrompt = Effect.fn(
    "ReferenceCodingApplication.invokeExecutionPrompt"
  )(function* (conversationId: ThreadId, input: unknown) {
    const decoded = yield* Schema.decodeUnknownEffect(ExecutionPromptInput)(
      input
    ).pipe(
      Effect.mapError(() =>
        HandlerFailure.make({
          category: "protocol",
          safeDetail: "Execution prompt input is invalid",
        })
      )
    );
    const ownedExecution = pipe(
      yield* Ref.get(executions),
      EffectArray.findFirst(
        (execution) =>
          execution.conversationId === conversationId &&
          execution.executionId === decoded.executionId
      ),
      Option.getOrNull
    );
    if (
      ownedExecution !== null &&
      (ownedExecution.status === "cancelled" ||
        ownedExecution.status === "failed")
    ) {
      return yield* HandlerFailure.make({
        category: "protocol",
        safeDetail: "Execution is terminal and cannot accept prompts",
      });
    }
    const runtime = pipe(
      yield* Ref.get(executionRuntimes),
      EffectArray.findFirst(
        (candidate) => candidate.executionId === decoded.executionId
      ),
      Option.getOrNull
    );
    if (ownedExecution === null || runtime === null) {
      return yield* HandlerFailure.make({
        category: "protocol",
        safeDetail: "Execution is not owned by this Conversation",
      });
    }
    const stagedPrompt = yield* updatePersistedExecution(
      runtime.executionId,
      (execution) => {
        const promptNumber = execution.prompts.length + 1;
        return PersistedExecution.make({
          ...execution,
          prompts: EffectArray.append(
            execution.prompts,
            PersistedImplementationPrompt.make({
              kind: "resume",
              promptId: implementationPromptId(
                execution.executionId,
                promptNumber
              ),
              status: "staged",
              text: decoded.prompt,
            })
          ),
          status: "implementation_start_staged",
        });
      }
    );
    const activePrompt = stagedPrompt?.prompts.at(-1);
    if (stagedPrompt === null || activePrompt === undefined) {
      return yield* HandlerFailure.make({
        category: "protocol",
        safeDetail: "Execution follow-up prompt could not be staged",
      });
    }
    yield* Ref.update(executionRuntimes, (current) =>
      EffectArray.map(current, (candidate) =>
        candidate.executionId === decoded.executionId
          ? { ...candidate, pendingRuns: candidate.pendingRuns + 1 }
          : candidate
      )
    );
    yield* markRunning(runtime.executionId, runtime.session.sessionId);
    yield* startRun(
      runtime,
      activePrompt.promptId,
      runtime.session.resume(
        {
          conversationId,
          executionId: runtime.executionId,
          implementationSessionId: runtime.session.sessionId,
          prompt: decoded.prompt,
          promptId: activePrompt.promptId,
          workingDirectory: runtime.workingDirectory,
        },
        runtime.acceptResponse
      )
    );
    return { executionId: runtime.executionId, status: "running" as const };
  });

  const invokeExecutionControl = Effect.fn(
    "ReferenceCodingApplication.invokeExecutionControl"
  )(function* (
    conversationId: ThreadId,
    input: unknown,
    acceptEvent: AcceptApplicationEvent
  ) {
    const decoded = yield* Schema.decodeUnknownEffect(ExecutionControlInput)(
      input
    ).pipe(
      Effect.mapError(() =>
        HandlerFailure.make({
          category: "protocol",
          safeDetail: "Execution control input is invalid",
        })
      )
    );
    const ownedExecution = pipe(
      yield* Ref.get(executions),
      EffectArray.findFirst(
        (execution) =>
          execution.conversationId === conversationId &&
          execution.executionId === decoded.executionId
      ),
      Option.getOrNull
    );
    const runtime = pipe(
      yield* Ref.get(executionRuntimes),
      EffectArray.findFirst(
        (candidate) => candidate.executionId === decoded.executionId
      ),
      Option.getOrNull
    );
    if (ownedExecution === null || runtime === null) {
      return yield* HandlerFailure.make({
        category: "protocol",
        safeDetail: "Execution is not owned by this Conversation",
      });
    }
    if (ownedExecution.status === "cancelled") {
      return { executionId: decoded.executionId, status: "cancelled" as const };
    }
    if (
      ownedExecution.status === "completed" ||
      ownedExecution.status === "failed"
    ) {
      return yield* HandlerFailure.make({
        category: "protocol",
        safeDetail: "Execution is terminal and cannot be controlled",
      });
    }
    if (runtime.session.control === undefined) {
      return yield* HandlerFailure.make({
        category: "protocol",
        safeDetail: "Execution control is unavailable",
      });
    }
    yield* runtime.session.control({
      control: decoded.control,
      conversationId,
      executionId: decoded.executionId,
      implementationSessionId: runtime.session.sessionId,
      workingDirectory: runtime.workingDirectory,
    });
    yield* FiberSet.clear(runtime.runs);
    const eventId = `${decoded.executionId}:control:${decoded.control}`;
    yield* updatePersistedExecution(decoded.executionId, (execution) =>
      appendExecutionEvent(
        PersistedExecution.make({ ...execution, status: "cancelled" }),
        PersistedExecutionEvent.make({
          eventId,
          payload: {
            control: decoded.control,
            executionId: decoded.executionId,
            status: "cancelled",
          },
          source: "execution-control",
          status: "staged",
        })
      )
    );
    yield* acceptExecutionEvent(decoded.executionId, eventId, acceptEvent);
    return { executionId: decoded.executionId, status: "cancelled" as const };
  });

  const codingActionsFor = (
    conversationId: ThreadId,
    conversationPromptId: string,
    acceptEvent: AcceptApplicationEvent
  ): readonly ConversationAction[] => {
    let invocationNumber = 0;
    const invocationId = (actionName: ReferenceCodingActionName): string => {
      invocationNumber += 1;
      return `${conversationPromptId}:action:${actionName}:${invocationNumber}`;
    };
    return [
      {
        description:
          'Implement a feature in an isolated named worktree. Input must be {"prompt":"<implementation request>","worktreeName":"<requested name>"}.',
        invoke: (input) =>
          invokeCodingAction(
            conversationId,
            invocationId("create-feature"),
            "create-feature",
            input,
            acceptEvent
          ),
        name: "create-feature",
      },
      {
        description:
          'Diagnose and fix a bug in an isolated named worktree. Input must be {"prompt":"<bug report>","worktreeName":"<requested name>"}.',
        invoke: (input) =>
          invokeCodingAction(
            conversationId,
            invocationId("deal-with-bug"),
            "deal-with-bug",
            input,
            acceptEvent
          ),
        name: "deal-with-bug",
      },
    ];
  };

  const executionControlsFor = (
    conversationId: ThreadId,
    acceptEvent: AcceptApplicationEvent
  ): readonly ConversationExecutionControl[] => [
    {
      description:
        'Cancel an owned active Execution. Input must be {"control":"cancel","executionId":"<owned id>"}.',
      invoke: (input) =>
        invokeExecutionControl(conversationId, input, acceptEvent),
      name: "cancel",
    },
    {
      description:
        'Send a follow-up prompt to an owned Execution. Input must be {"executionId":"<owned id>","prompt":"<follow-up request>"}.',
      invoke: (input) => invokeExecutionPrompt(conversationId, input),
      name: "prompt",
    },
  ];

  const xmlEscape = (value: string): string =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");

  const implementationResponsePayload = Schema.Struct({
    actionName: ReferenceCodingActionName,
    executionId: Schema.NonEmptyString,
    responseId: Schema.NonEmptyString,
    text: Schema.String,
  });

  const executionControlPayload = Schema.Struct({
    control: Schema.Literal("cancel"),
    executionId: Schema.NonEmptyString,
    status: Schema.Literal("cancelled"),
  });

  const executionRecoveryFailurePayload = Schema.Struct({
    executionId: Schema.NonEmptyString,
    kind: Schema.Literal("recovery-failure"),
    resource: Schema.Literals(["worktree", "implementation-session"]),
  });

  const implementationFailurePayload = Schema.Struct({
    category: Schema.String,
    executionId: Schema.NonEmptyString,
    kind: Schema.Literal("implementation-failure"),
    promptId: Schema.NonEmptyString,
  });

  const renderInput = Effect.fn("ReferenceCodingApplication.renderInput")(
    function* (event: ApplicationEvent) {
      if (event._tag === "ParticipantInput") {
        return pipe(
          event.messages,
          EffectArray.map((message) => message.text),
          EffectArray.join("\n")
        );
      }
      if (event.source === "execution-control") {
        const payload = yield* Schema.decodeUnknownEffect(
          executionControlPayload
        )(event.payload).pipe(
          Effect.mapError(() =>
            HandlerFailure.make({
              category: "protocol",
              safeDetail: "Execution control payload is invalid",
            })
          )
        );
        return `<application-event source="execution-control" execution-id="${xmlEscape(payload.executionId)}" control="${xmlEscape(payload.control)}" status="${xmlEscape(payload.status)}" />`;
      }
      if (event.source === "execution-recovery") {
        const payload = yield* Schema.decodeUnknownEffect(
          executionRecoveryFailurePayload
        )(event.payload).pipe(
          Effect.mapError(() =>
            HandlerFailure.make({
              category: "protocol",
              safeDetail: "Execution recovery failure payload is invalid",
            })
          )
        );
        return `<application-event source="execution-recovery" execution-id="${xmlEscape(payload.executionId)}" kind="${xmlEscape(payload.kind)}" resource="${xmlEscape(payload.resource)}" />`;
      }
      if (event.source === "implementation-failure") {
        const payload = yield* Schema.decodeUnknownEffect(
          implementationFailurePayload
        )(event.payload).pipe(
          Effect.mapError(() =>
            HandlerFailure.make({
              category: "protocol",
              safeDetail: "implementation failure payload is invalid",
            })
          )
        );
        return `<application-event source="implementation-failure" execution-id="${xmlEscape(payload.executionId)}" kind="${xmlEscape(payload.kind)}" prompt-id="${xmlEscape(payload.promptId)}" category="${xmlEscape(payload.category)}" />`;
      }
      if (event.source !== "implementation-agent") {
        return `<application-event source="${xmlEscape(event.source)}" event-id="${xmlEscape(event.eventId)}" />`;
      }
      const payload = yield* Schema.decodeUnknownEffect(
        implementationResponsePayload
      )(event.payload).pipe(
        Effect.mapError(() =>
          HandlerFailure.make({
            category: "protocol",
            safeDetail: "implementation response payload is invalid",
          })
        )
      );
      return `<application-event source="implementation-agent" action-name="${xmlEscape(payload.actionName)}" execution-id="${xmlEscape(payload.executionId)}" response-id="${xmlEscape(payload.responseId)}">${xmlEscape(payload.text)}</application-event>`;
    }
  );

  return Application.of({
    recover: recoverApplication,
    handle: Effect.fn("ReferenceCodingApplication.handle")(
      function* (event, publish, acceptEvent) {
        const ownedExecutions = EffectArray.filter(
          yield* Ref.get(executions),
          (execution) => execution.conversationId === event.conversationId
        );
        const input = yield* renderInput(event);
        const staged = yield* stageConversationPrompt(event, input);
        const request: ConversationAgentRequest = {
          actions: codingActionsFor(
            event.conversationId,
            staged.prompt.promptId,
            acceptEvent
          ),
          context: event._tag === "ParticipantInput" ? event.context : [],
          conversationId: event.conversationId,
          conversationSessionId: staged.conversation.sessionId,
          conversationSessionIsNew: staged.sessionIsNew,
          executions: ownedExecutions,
          executionControls: executionControlsFor(
            event.conversationId,
            acceptEvent
          ),
          input,
          messages: event._tag === "ParticipantInput" ? event.messages : [],
          promptId: staged.prompt.promptId,
          source: event.source,
          turnId:
            event._tag === "ParticipantInput" ? event.turnId : event.eventId,
        };
        const publishMessage: PublishConversationAgentMessage = (message) =>
          publish(
            ApplicationConversationMessageChunk.make({
              messageId: message.messageId,
              text: message.text,
            })
          ).pipe(
            Effect.mapError(() =>
              HandlerFailure.make({
                category: "protocol",
                noticeStyle: "generic",
                safeDetail: "Conversation message delivery failed",
              })
            )
          );
        let replies: readonly ConversationAgentReply[];
        if (staged.prompt.status === "completed") {
          replies = staged.prompt.replies;
        } else {
          yield* markConversationPromptRunning(staged.prompt.promptId);
          if (staged.isNew) {
            replies = yield* options.conversationAgent.handle(
              request,
              publishMessage
            );
          } else if (options.conversationAgent.recover !== undefined) {
            replies = yield* options.conversationAgent.recover(
              request,
              publishMessage
            );
          } else {
            return yield* HandlerFailure.make({
              category: "protocol",
              safeDetail: "Conversation prompt recovery is unavailable",
            });
          }
          yield* completeConversationPrompt(staged.prompt.promptId, replies);
        }
        yield* Effect.forEach(
          replies,
          (reply) =>
            publish(
              ApplicationPublicReply.make({
                replyId: reply.replyId,
                text: reply.text,
              })
            ),
          { discard: true }
        );
      }
    ),
  });
});

export const referenceCodingApplicationLayer: Layer.Layer<
  Application,
  HandlerFailure,
  ConversationAgent | ImplementationAgent | WorktreeManager
> = Layer.effect(
  Application,
  Effect.gen(function* () {
    const conversationAgent = yield* ConversationAgent;
    const implementationAgent = yield* ImplementationAgent;
    const worktreeManager = yield* WorktreeManager;
    return yield* makeReferenceCodingApplication({
      conversationAgent,
      implementationAgent,
      worktreeManager,
    });
  })
);
