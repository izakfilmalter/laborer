import { randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Effect, Array as EffectArray, Ref, Schema, Semaphore } from "effect";
import {
  assertSafeFilePath,
  openRegularFileNoFollowNonBlocking,
  retainTrustedDirectory,
  verifyRetainedDirectory,
} from "../prototype/path-safety.ts";
import {
  type AcpAgentContextSources,
  verifyAcpAgentContextSources,
} from "./agent-context.ts";

const MAX_STATE_BYTES = 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 4096;
const MAX_CONVERSATIONS = 4096;
const MAX_INTRODUCED_PARTICIPANTS = 1024;
const MAX_IDENTIFIER_CHARACTERS = 4096;
const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });
const DIAGNOSTIC_LINE_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z (?:resume-failed|state-corrupt|storage-unavailable)$/;

const PersistedConversation = Schema.Struct({
  conversationId: Schema.NonEmptyString,
  cwd: Schema.NonEmptyString,
  inFlightPromptId: Schema.NullOr(Schema.NonEmptyString),
  initialContextSubmitted: Schema.Boolean,
  introducedParticipantIds: Schema.Array(Schema.String),
  sessionId: Schema.NonEmptyString,
  suppressedPromptId: Schema.NullOr(Schema.NonEmptyString),
});
type PersistedConversation = typeof PersistedConversation.Type;

const PersistedConversationState = Schema.Struct({
  conversations: Schema.Array(PersistedConversation),
  schemaVersion: Schema.Literal(1),
});
type PersistedConversationState = typeof PersistedConversationState.Type;

const initialState: PersistedConversationState = {
  conversations: [],
  schemaVersion: 1,
};

export class ConversationSessionStoreError extends Schema.TaggedErrorClass<ConversationSessionStoreError>()(
  "ConversationSessionStoreError",
  {
    reason: Schema.Literals([
      "ambiguous-prompt",
      "conflict",
      "state-corrupt",
      "storage-unavailable",
    ]),
  }
) {}

export interface PersistedConversationSession {
  readonly conversationId: string;
  readonly cwd: string;
  readonly inFlightPromptId: string | null;
  readonly initialContextSubmitted: boolean;
  readonly introducedParticipantIds: readonly string[];
  readonly sessionId: string;
  readonly suppressedPromptId: string | null;
}

export interface ConversationSessionStore {
  readonly completePrompt: (options: {
    readonly conversationId: string;
    readonly promptId: string;
    readonly sessionId: string;
  }) => Effect.Effect<void, ConversationSessionStoreError>;
  readonly get: (
    conversationId: string
  ) => Effect.Effect<
    PersistedConversationSession | null,
    ConversationSessionStoreError
  >;
  readonly markPromptSubmitted: (options: {
    readonly conversationId: string;
    readonly introducedParticipantIds: readonly string[];
    readonly promptId: string;
    readonly sessionId: string;
  }) => Effect.Effect<void, ConversationSessionStoreError>;
  readonly replaceSession: (options: {
    readonly conversationId: string;
    readonly cwd: string;
    readonly sessionId: string;
  }) => Effect.Effect<void, ConversationSessionStoreError>;
  readonly suppressInFlightPrompt: (options: {
    readonly conversationId: string;
    readonly promptId: string;
    readonly sessionId: string;
  }) => Effect.Effect<void, ConversationSessionStoreError>;
}

const storeFailure = (
  reason: ConversationSessionStoreError["reason"]
): ConversationSessionStoreError =>
  ConversationSessionStoreError.make({ reason });

const isMissing = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ENOENT";

const cloneConversation = (
  conversation: PersistedConversation
): PersistedConversationSession => ({
  ...conversation,
  introducedParticipantIds: [...conversation.introducedParticipantIds],
});

const validateBoundedState = (state: PersistedConversationState): void => {
  if (state.conversations.length > MAX_CONVERSATIONS) {
    throw storeFailure("state-corrupt");
  }
  const conversationIds = new Set<string>();
  const sessionIds = new Set<string>();
  for (const conversation of state.conversations) {
    if (
      conversationIds.has(conversation.conversationId) ||
      sessionIds.has(conversation.sessionId) ||
      conversation.conversationId.length > MAX_IDENTIFIER_CHARACTERS ||
      conversation.sessionId.length > MAX_IDENTIFIER_CHARACTERS ||
      (conversation.inFlightPromptId?.length ?? 0) >
        MAX_IDENTIFIER_CHARACTERS ||
      (conversation.suppressedPromptId?.length ?? 0) >
        MAX_IDENTIFIER_CHARACTERS ||
      (conversation.inFlightPromptId !== null &&
        conversation.suppressedPromptId !== null) ||
      (!conversation.initialContextSubmitted &&
        (conversation.introducedParticipantIds.length > 0 ||
          conversation.inFlightPromptId !== null ||
          conversation.suppressedPromptId !== null)) ||
      !conversation.cwd.startsWith("/") ||
      conversation.introducedParticipantIds.length > MAX_INTRODUCED_PARTICIPANTS
    ) {
      throw storeFailure("state-corrupt");
    }
    conversationIds.add(conversation.conversationId);
    sessionIds.add(conversation.sessionId);
    const participantIds = new Set<string>();
    for (const participantId of conversation.introducedParticipantIds) {
      if (
        participantId.length === 0 ||
        participantId.length > MAX_IDENTIFIER_CHARACTERS ||
        participantIds.has(participantId)
      ) {
        throw storeFailure("state-corrupt");
      }
      participantIds.add(participantId);
    }
  }
};

const publishAtomically = async (options: {
  readonly afterRename?: (() => Promise<void>) | undefined;
  readonly beforeRename?: (() => Promise<void>) | undefined;
  readonly content: string;
  readonly path: string;
  readonly sources: AcpAgentContextSources;
}): Promise<"published" | "published-with-error"> => {
  await verifyAcpAgentContextSources(
    options.sources,
    "persist-acp-conversation-state"
  );
  const directory = await retainTrustedDirectory(
    dirname(options.path),
    "persist-acp-conversation-state"
  );
  const temporaryPath = `${options.path}.${randomUUID()}.tmp`;
  let temporaryFile: Awaited<ReturnType<typeof open>> | undefined;
  let failure: unknown;
  let published = false;
  try {
    await assertSafeFilePath({
      anchor: options.sources.workspaceDirectory,
      operation: "persist-acp-conversation-state",
      path: options.path,
    });
    temporaryFile = await open(temporaryPath, "wx", 0o600);
    await temporaryFile.writeFile(options.content, "utf8");
    await temporaryFile.sync();
    await temporaryFile.close();
    temporaryFile = undefined;
    await verifyRetainedDirectory(directory, "persist-acp-conversation-state");
    await options.beforeRename?.();
    await rename(temporaryPath, options.path);
    published = true;
    await options.afterRename?.();
    await verifyRetainedDirectory(directory, "persist-acp-conversation-state");
    await directory.handle.sync();
  } catch (error) {
    failure = error;
  }
  try {
    await temporaryFile?.close();
  } catch (error) {
    failure ??= error;
  }
  if (!published) {
    try {
      await rm(temporaryPath, { force: true });
    } catch (error) {
      failure ??= error;
    }
  }
  try {
    await directory.handle.close();
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined && !published) {
    throw failure;
  }
  return failure === undefined ? "published" : "published-with-error";
};

const readBoundedFile = async (
  sources: AcpAgentContextSources,
  path: string,
  maximumBytes: number
): Promise<string> => {
  await verifyAcpAgentContextSources(sources, "load-acp-conversation-state");
  await assertSafeFilePath({
    anchor: sources.workspaceDirectory,
    operation: "load-acp-conversation-state",
    path,
  });
  const file = await openRegularFileNoFollowNonBlocking(
    path,
    "load-acp-conversation-state"
  );
  try {
    const metadata = await file.stat();
    if (metadata.size > maximumBytes) {
      throw storeFailure("state-corrupt");
    }
    const content = await file.readFile();
    if (content.byteLength > maximumBytes) {
      throw storeFailure("state-corrupt");
    }
    await verifyAcpAgentContextSources(sources, "load-acp-conversation-state");
    try {
      return fatalUtf8Decoder.decode(content);
    } catch {
      throw storeFailure("state-corrupt");
    }
  } finally {
    await file.close();
  }
};

const recordDiagnostic = async (
  sources: AcpAgentContextSources,
  code: "resume-failed" | "state-corrupt" | "storage-unavailable"
): Promise<void> => {
  let lines: string[] = [];
  try {
    lines = (
      await readBoundedFile(
        sources,
        sources.acpConversationDiagnosticsPath,
        MAX_DIAGNOSTIC_BYTES
      )
    )
      .split("\n")
      .filter((line) => DIAGNOSTIC_LINE_PATTERN.test(line));
  } catch {
    // Missing or invalid diagnostics are replaced by the bounded sink.
  }
  lines.push(`${new Date().toISOString()} ${code}`);
  while (
    lines.length > 1 &&
    new TextEncoder().encode(`${lines.join("\n")}\n`).byteLength >
      MAX_DIAGNOSTIC_BYTES
  ) {
    lines.shift();
  }
  await publishAtomically({
    content: `${lines.join("\n")}\n`,
    path: sources.acpConversationDiagnosticsPath,
    sources,
  });
};

export const recordConversationSessionDiagnostic = Effect.fn(
  "recordConversationSessionDiagnostic"
)(function* (
  sources: AcpAgentContextSources,
  code: "resume-failed" | "state-corrupt" | "storage-unavailable"
) {
  yield* Effect.tryPromise({
    try: () => recordDiagnostic(sources, code),
    catch: () => storeFailure("storage-unavailable"),
  }).pipe(Effect.ignore);
});

const loadState = Effect.fn("ConversationSessionStore.loadState")(function* (
  sources: AcpAgentContextSources
): Effect.fn.Return<PersistedConversationState, ConversationSessionStoreError> {
  const result = yield* Effect.result(
    Effect.tryPromise({
      try: async () => {
        try {
          return await readBoundedFile(
            sources,
            sources.acpConversationStatePath,
            MAX_STATE_BYTES
          );
        } catch (error) {
          if (isMissing(error)) {
            return null;
          }
          throw error;
        }
      },
      catch: (error) =>
        error instanceof ConversationSessionStoreError
          ? error
          : storeFailure("storage-unavailable"),
    })
  );
  if (result._tag === "Failure") {
    return yield* result.failure;
  }
  const source = result.success;
  if (source === null) {
    yield* Effect.tryPromise({
      try: () =>
        publishAtomically({
          content: JSON.stringify(initialState),
          path: sources.acpConversationStatePath,
          sources,
        }),
      catch: () => storeFailure("storage-unavailable"),
    });
    return initialState;
  }
  const decoded = yield* Schema.decodeUnknownEffect(PersistedConversationState)(
    yield* Effect.try({
      try: () => JSON.parse(source) as unknown,
      catch: () => storeFailure("state-corrupt"),
    }),
    { onExcessProperty: "error" }
  ).pipe(Effect.mapError(() => storeFailure("state-corrupt")));
  yield* Effect.try({
    try: () => validateBoundedState(decoded),
    catch: () => storeFailure("state-corrupt"),
  });
  return decoded;
});

const mergeIntroducedParticipantIds = (
  current: readonly string[],
  submitted: readonly string[]
): readonly string[] | ConversationSessionStoreError => {
  const merged = [...current];
  for (const participantId of submitted) {
    const alreadyIntroduced = merged.includes(participantId);
    if (
      participantId.length === 0 ||
      participantId.length > MAX_IDENTIFIER_CHARACTERS ||
      (!alreadyIntroduced && merged.length >= MAX_INTRODUCED_PARTICIPANTS)
    ) {
      return storeFailure("conflict");
    }
    if (!alreadyIntroduced) {
      merged.push(participantId);
    }
  }
  return merged;
};

const markSubmittedConversation = (options: {
  readonly conversation: PersistedConversation;
  readonly introducedParticipantIds: readonly string[];
  readonly promptId: string;
}):
  | readonly [undefined, PersistedConversation]
  | ConversationSessionStoreError => {
  if (options.conversation.inFlightPromptId !== null) {
    return storeFailure(
      options.conversation.inFlightPromptId === options.promptId
        ? "ambiguous-prompt"
        : "conflict"
    );
  }
  const introducedParticipantIds = mergeIntroducedParticipantIds(
    options.conversation.introducedParticipantIds,
    options.introducedParticipantIds
  );
  if (introducedParticipantIds instanceof ConversationSessionStoreError) {
    return introducedParticipantIds;
  }
  return [
    undefined,
    {
      ...options.conversation,
      inFlightPromptId: options.promptId,
      initialContextSubmitted: true,
      introducedParticipantIds,
      suppressedPromptId: null,
    },
  ];
};

export const makeConversationSessionStore = Effect.fn(
  "makeConversationSessionStore"
)(function* (options: {
  readonly expectedCwd: string;
  readonly sources: AcpAgentContextSources;
  readonly testHooks?: {
    readonly afterRename?: (() => Promise<void>) | undefined;
    readonly beforeRename?: (() => Promise<void>) | undefined;
  };
}): Effect.fn.Return<ConversationSessionStore, ConversationSessionStoreError> {
  const { expectedCwd, sources } = options;
  const initial = yield* loadState(sources).pipe(
    Effect.tapError((error) =>
      recordConversationSessionDiagnostic(
        sources,
        error.reason === "storage-unavailable"
          ? "storage-unavailable"
          : "state-corrupt"
      )
    )
  );
  yield* Effect.try({
    try: () => {
      for (const conversation of initial.conversations) {
        if (conversation.cwd !== options.expectedCwd) {
          throw storeFailure("state-corrupt");
        }
      }
    },
    catch: () => storeFailure("state-corrupt"),
  }).pipe(
    Effect.tapError(() =>
      recordConversationSessionDiagnostic(sources, "state-corrupt")
    )
  );
  const stateRef = yield* Ref.make(initial);
  const gate = yield* Semaphore.make(1);

  const transition = <A>(
    update: (
      state: PersistedConversationState
    ) =>
      | readonly [A, PersistedConversationState]
      | ConversationSessionStoreError
  ): Effect.Effect<A, ConversationSessionStoreError> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const acquired = yield* restore(gate.take(1));
        return yield* Effect.gen(function* () {
          const state = yield* Ref.get(stateRef);
          const result = update(state);
          if (result instanceof ConversationSessionStoreError) {
            return yield* result;
          }
          const [value, next] = result;
          const content = yield* Effect.try({
            try: () => {
              validateBoundedState(next);
              const encoded = JSON.stringify(next);
              if (
                new TextEncoder().encode(encoded).byteLength > MAX_STATE_BYTES
              ) {
                throw storeFailure("conflict");
              }
              return encoded;
            },
            catch: (error) =>
              error instanceof ConversationSessionStoreError
                ? error
                : storeFailure("conflict"),
          });
          const publication = yield* Effect.tryPromise({
            try: () =>
              publishAtomically({
                ...options.testHooks,
                content,
                path: sources.acpConversationStatePath,
                sources,
              }),
            catch: () => storeFailure("storage-unavailable"),
          }).pipe(
            Effect.tapError(() =>
              recordConversationSessionDiagnostic(
                sources,
                "storage-unavailable"
              )
            )
          );
          yield* Ref.set(stateRef, next);
          if (publication === "published-with-error") {
            yield* Effect.logWarning(
              "ACP conversation state was published with an ancillary durability failure"
            );
            yield* recordConversationSessionDiagnostic(
              sources,
              "storage-unavailable"
            );
          }
          return value;
        }).pipe(Effect.ensuring(gate.release(acquired)));
      })
    );

  const replaceConversation = (
    state: PersistedConversationState,
    conversation: PersistedConversation
  ): PersistedConversationState => {
    const existingIndex = state.conversations.findIndex(
      (candidate) => candidate.conversationId === conversation.conversationId
    );
    return {
      ...state,
      conversations:
        existingIndex === -1
          ? EffectArray.append(state.conversations, conversation)
          : state.conversations.map((candidate, index) =>
              index === existingIndex ? conversation : candidate
            ),
    };
  };

  const updateExisting = <A>(
    state: PersistedConversationState,
    conversationId: string,
    sessionId: string,
    update: (
      conversation: PersistedConversation
    ) => readonly [A, PersistedConversation] | ConversationSessionStoreError
  ):
    | readonly [A, PersistedConversationState]
    | ConversationSessionStoreError => {
    const conversation = state.conversations.find(
      (candidate) => candidate.conversationId === conversationId
    );
    if (conversation === undefined || conversation.sessionId !== sessionId) {
      return storeFailure("conflict");
    }
    const result = update(conversation);
    if (result instanceof ConversationSessionStoreError) {
      return result;
    }
    return [result[0], replaceConversation(state, result[1])];
  };

  return {
    get: (conversationId) =>
      Ref.get(stateRef).pipe(
        Effect.map(
          (state) =>
            state.conversations.find(
              (candidate) => candidate.conversationId === conversationId
            ) ?? null
        ),
        Effect.map((conversation) =>
          conversation === null ? null : cloneConversation(conversation)
        )
      ),
    replaceSession: (options) =>
      transition((state) => {
        if (
          options.cwd !== expectedCwd ||
          options.conversationId.length === 0 ||
          options.conversationId.length > MAX_IDENTIFIER_CHARACTERS ||
          options.sessionId.length === 0 ||
          options.sessionId.length > MAX_IDENTIFIER_CHARACTERS
        ) {
          return storeFailure("conflict");
        }
        const sessionOwner = state.conversations.find(
          (conversation) => conversation.sessionId === options.sessionId
        );
        if (
          sessionOwner !== undefined &&
          sessionOwner.conversationId !== options.conversationId
        ) {
          return storeFailure("conflict");
        }
        return [
          undefined,
          replaceConversation(state, {
            conversationId: options.conversationId,
            cwd: options.cwd,
            inFlightPromptId: null,
            initialContextSubmitted: false,
            introducedParticipantIds: [],
            sessionId: options.sessionId,
            suppressedPromptId: null,
          }),
        ];
      }),
    markPromptSubmitted: (options) =>
      transition((state) =>
        updateExisting(
          state,
          options.conversationId,
          options.sessionId,
          (conversation) =>
            markSubmittedConversation({
              conversation,
              introducedParticipantIds: options.introducedParticipantIds,
              promptId: options.promptId,
            })
        )
      ),
    completePrompt: (options) =>
      transition((state) =>
        updateExisting(
          state,
          options.conversationId,
          options.sessionId,
          (conversation) =>
            conversation.inFlightPromptId !== options.promptId
              ? storeFailure("conflict")
              : [undefined, { ...conversation, inFlightPromptId: null }]
        )
      ),
    suppressInFlightPrompt: (options) =>
      transition((state) =>
        updateExisting(
          state,
          options.conversationId,
          options.sessionId,
          (conversation) =>
            conversation.inFlightPromptId !== options.promptId
              ? storeFailure("conflict")
              : [
                  undefined,
                  {
                    ...conversation,
                    inFlightPromptId: null,
                    suppressedPromptId: options.promptId,
                  },
                ]
        )
      ),
  };
});
