import type { WebClient } from "@slack/web-api";
import { Effect, Result, Schema } from "effect";
import {
  ACP_PERMISSION_ALLOW_ACTION_ID,
  ACP_PERMISSION_REJECT_ACTION_ID,
  type AcpPermissionCategory,
  type AcpPermissionPresenter,
} from "../acp-runtime/acp-permission-broker.ts";
import { HandlerFailure } from "../prototype/errors.ts";
import {
  ACP_PERMISSION_UI_DIAGNOSTIC_RETENTION_MILLIS,
  ACP_PERMISSION_UI_OUTBOX_CAPACITY_DETAIL,
  ACP_PERMISSION_UI_OUTBOX_MAX_UNRESOLVED_ENTRIES,
  type AcpPermissionTerminalOutbox,
  AcpPermissionTerminalUpdate,
  makePresentationIntent,
} from "./acp-permission-ui-outbox.ts";

const PRESENTER_SHUTDOWN_DRAIN_MILLIS = 1000;
const TERMINAL_UPDATE_ATTEMPTS = 5;
const TERMINAL_UPDATE_DEADLINE_MILLIS = 30_000;
const TERMINAL_UPDATE_INITIAL_BACKOFF_MILLIS = 100;
const TERMINAL_UPDATE_MAX_BACKOFF_MILLIS = 2000;
const PRESENTATION_METADATA_EVENT_TYPE = "laborer_permission_presentation_v1";
const RECONCILIATION_MAX_PAGES = 3;
const RECONCILIATION_PAGE_SIZE = 100;

export const acpPermissionFallbackText = (options: {
  readonly authorizedSlackUserId: string;
  readonly category: AcpPermissionCategory;
}): string =>
  `<@${options.authorizedSlackUserId}>: permission required for one ${options.category} operation. Arguments are hidden. Choices: Allow once or Reject.`.slice(
    0,
    300
  );

class AcpPermissionPresentationError extends Schema.TaggedErrorClass<AcpPermissionPresentationError>()(
  "AcpPermissionPresentationError",
  {}
) {}

type PresentationState = "allowed" | "cancelled" | "expired" | "rejected";

interface PresentationEntry {
  readonly authorizedSlackUserId: string;
  readonly capability: string;
  readonly category: AcpPermissionCategory;
  readonly channelId: string;
  intent: AcpPermissionTerminalUpdate;
  messageTs: string | null;
  readonly post: Promise<{ readonly messageTs: string }>;
  readonly rootTs: string;
  terminalState: PresentationState | null;
  readonly workspaceId: string;
}

export const acpPermissionBlocks = (options: {
  readonly authorizedSlackUserId: string;
  readonly capability: string;
  readonly category: AcpPermissionCategory;
}) => [
  {
    type: "section" as const,
    text: {
      type: "mrkdwn" as const,
      text: `<@${options.authorizedSlackUserId}>: allow one *${options.category}* operation? Tool arguments are hidden for safety.`,
    },
  },
  {
    type: "actions" as const,
    elements: [
      {
        accessibility_label: `Allow this ${options.category} operation once`,
        action_id: ACP_PERMISSION_ALLOW_ACTION_ID,
        style: "primary" as const,
        text: { emoji: true, text: "Allow once", type: "plain_text" as const },
        type: "button" as const,
        value: options.capability,
      },
      {
        accessibility_label: `Reject this ${options.category} operation`,
        action_id: ACP_PERMISSION_REJECT_ACTION_ID,
        style: "danger" as const,
        text: { emoji: true, text: "Reject", type: "plain_text" as const },
        type: "button" as const,
        value: options.capability,
      },
    ],
  },
];

const settledText = (
  category: AcpPermissionCategory,
  state: PresentationState
): string => {
  switch (state) {
    case "allowed":
      return `Allowed one ${category} operation.`;
    case "rejected":
      return `Rejected one ${category} operation.`;
    case "expired":
      return `The ${category} permission request expired.`;
    default:
      return `The ${category} permission request was cancelled.`;
  }
};

const errorCode = (cause: unknown): string | null => {
  if (typeof cause !== "object" || cause === null) {
    return null;
  }
  if (
    "data" in cause &&
    typeof cause.data === "object" &&
    cause.data !== null &&
    "error" in cause.data &&
    typeof cause.data.error === "string"
  ) {
    return cause.data.error;
  }
  if ("code" in cause && typeof cause.code === "string") {
    return cause.code;
  }
  return null;
};

const retryAfterMillis = (cause: unknown): number | null => {
  if (typeof cause !== "object" || cause === null) {
    return null;
  }
  let retryAfter: number | null = null;
  if ("retryAfter" in cause && typeof cause.retryAfter === "number") {
    retryAfter = cause.retryAfter;
  } else if ("retry_after" in cause && typeof cause.retry_after === "number") {
    retryAfter = cause.retry_after;
  }
  return retryAfter === null || !Number.isFinite(retryAfter)
    ? null
    : Math.max(0, retryAfter * 1000);
};

const isTransientUpdateFailure = (cause: unknown): boolean => {
  const code = errorCode(cause);
  const serverError =
    typeof cause === "object" &&
    cause !== null &&
    "statusCode" in cause &&
    typeof cause.statusCode === "number" &&
    cause.statusCode >= 500;
  return (
    serverError ||
    retryAfterMillis(cause) !== null ||
    code === "slack_webapi_rate_limited_error" ||
    code === "ratelimited" ||
    code === "internal_error" ||
    code === "service_unavailable" ||
    code === "slack_webapi_request_error" ||
    code === "ETIMEDOUT" ||
    code === "ECONNRESET" ||
    code === "EAI_AGAIN" ||
    code === "ENETUNREACH"
  );
};

const presentationMarkerFromMessage = (message: unknown): string | null => {
  if (
    typeof message !== "object" ||
    message === null ||
    !("metadata" in message)
  ) {
    return null;
  }
  const metadata = message.metadata;
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    !("event_type" in metadata) ||
    metadata.event_type !== PRESENTATION_METADATA_EVENT_TYPE ||
    !("event_payload" in metadata) ||
    typeof metadata.event_payload !== "object" ||
    metadata.event_payload === null ||
    !("presentation_marker" in metadata.event_payload) ||
    typeof metadata.event_payload.presentation_marker !== "string"
  ) {
    return null;
  }
  return metadata.event_payload.presentation_marker;
};

const cancellableDelay = (
  milliseconds: number,
  signal: AbortSignal
): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

export const makeSlackAcpPermissionPresenter = (
  client: WebClient,
  options: {
    readonly botUserId?: string;
    readonly outbox?: AcpPermissionTerminalOutbox;
    readonly retry?: {
      readonly attempts?: number;
      readonly deadlineMillis?: number;
      readonly initialBackoffMillis?: number;
      readonly maxBackoffMillis?: number;
    };
    readonly testHooks?: {
      readonly onRuntimeEntryCountChanged?: (count: number) => void;
    };
    readonly workspaceId?: string;
  } = {}
): AcpPermissionPresenter => {
  const entries = new Map<string, PresentationEntry>();
  const localOutbox = new Map<string, AcpPermissionTerminalUpdate>();
  const tasks = new Set<Promise<unknown>>();
  const drivers = new Map<
    string,
    { readonly abort: AbortController; readonly task: Promise<void> }
  >();
  const attemptsLimit = options.retry?.attempts ?? TERMINAL_UPDATE_ATTEMPTS;
  const deadlineMillis =
    options.retry?.deadlineMillis ?? TERMINAL_UPDATE_DEADLINE_MILLIS;
  const initialBackoffMillis =
    options.retry?.initialBackoffMillis ??
    TERMINAL_UPDATE_INITIAL_BACKOFF_MILLIS;
  const maxBackoffMillis =
    options.retry?.maxBackoffMillis ?? TERMINAL_UPDATE_MAX_BACKOFF_MILLIS;
  const reportRuntimeEntryCount = (): void =>
    options.testHooks?.onRuntimeEntryCountChanged?.(entries.size);

  const removeRuntimeEntry = (entry: PresentationEntry): void => {
    if (entries.get(entry.capability) === entry) {
      entries.delete(entry.capability);
      reportRuntimeEntryCount();
    }
  };

  const track = <A>(task: Promise<A>): Promise<A> => {
    let tracked: Promise<A>;
    tracked = task.finally(() => {
      tasks.delete(tracked);
    });
    tasks.add(tracked);
    tracked.catch(() => undefined);
    return tracked;
  };

  const persist = async (
    entry: AcpPermissionTerminalUpdate,
    signal?: AbortSignal
  ): Promise<void> => {
    const existing = localOutbox.get(entry.id);
    const unresolvedWithoutCurrent = [...localOutbox.values()].filter(
      (candidate) =>
        candidate.id !== entry.id && candidate.status !== "permanent-failure"
    ).length;
    const addsUnresolved =
      entry.status !== "permanent-failure" &&
      (existing === undefined || existing.status === "permanent-failure");
    if (
      addsUnresolved &&
      unresolvedWithoutCurrent >=
        ACP_PERMISSION_UI_OUTBOX_MAX_UNRESOLVED_ENTRIES
    ) {
      throw HandlerFailure.make({
        category: "protocol",
        safeDetail: ACP_PERMISSION_UI_OUTBOX_CAPACITY_DETAIL,
      });
    }
    if (options.outbox !== undefined) {
      const persisted = await Effect.runPromise(
        Effect.result(options.outbox.upsert(entry)),
        signal === undefined ? undefined : { signal }
      );
      if (Result.isFailure(persisted)) {
        throw persisted.failure;
      }
    }
    localOutbox.set(entry.id, entry);
  };

  const remove = async (id: string): Promise<void> => {
    localOutbox.delete(id);
    if (options.outbox !== undefined) {
      await Effect.runPromise(options.outbox.remove(id));
    }
  };

  const updateSlack = async (
    entry: AcpPermissionTerminalUpdate
  ): Promise<void> => {
    if (entry.state === null || entry.messageTs === null) {
      throw new Error("terminal permission update is not reconciled");
    }
    const text = settledText(entry.category, entry.state);
    await client.chat.update({
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `<@${entry.authorizedSlackUserId}>: ${text}`,
          },
        },
      ],
      channel: entry.channelId,
      text,
      ts: entry.messageTs,
    });
  };

  const permanentlyDiagnose = (
    entry: AcpPermissionTerminalUpdate,
    diagnostic: string,
    attempts = entry.attempts
  ): AcpPermissionTerminalUpdate =>
    AcpPermissionTerminalUpdate.make({
      ...entry,
      attempts,
      diagnostic,
      retentionExpiresAt: Math.max(
        entry.retentionExpiresAt,
        Date.now() + ACP_PERMISSION_UI_DIAGNOSTIC_RETENTION_MILLIS
      ),
      status: "permanent-failure",
    });

  const startDriver = (initial: AcpPermissionTerminalUpdate): void => {
    if (initial.status !== "pending" || drivers.has(initial.id)) {
      return;
    }
    const abort = new AbortController();
    const driver = track(
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Retry classification and durable state transitions must stay ordered in one driver.
      (async () => {
        let current = initial;
        while (!abort.signal.aborted && current.status === "pending") {
          const now = Date.now();
          if (current.attempts >= attemptsLimit || now >= current.deadlineAt) {
            current = permanentlyDiagnose(current, "retry-budget-exhausted");
            await persist(current);
            return;
          }
          if (current.nextAttemptAt > now) {
            await cancellableDelay(current.nextAttemptAt - now, abort.signal);
          }
          try {
            await updateSlack(current);
            await remove(current.id);
            return;
          } catch (cause) {
            const attempts = current.attempts + 1;
            const transient = isTransientUpdateFailure(cause);
            if (
              !transient ||
              attempts >= attemptsLimit ||
              Date.now() >= current.deadlineAt
            ) {
              current = permanentlyDiagnose(
                current,
                transient
                  ? "retry-budget-exhausted"
                  : "permanent-slack-update-failure",
                attempts
              );
              await persist(current);
              return;
            }
            const exponential = Math.min(
              maxBackoffMillis,
              initialBackoffMillis * 2 ** Math.max(0, attempts - 1)
            );
            current = AcpPermissionTerminalUpdate.make({
              ...current,
              attempts,
              nextAttemptAt:
                Date.now() + (retryAfterMillis(cause) ?? exponential),
            });
            await persist(current);
          }
        }
      })().finally(() => {
        drivers.delete(initial.id);
      })
    );
    drivers.set(initial.id, { abort, task: driver });
  };

  const enqueueTerminal = async (entry: PresentationEntry): Promise<void> => {
    if (entry.terminalState === null) {
      return;
    }
    if (entry.intent.status === "permanent-failure") {
      entry.intent = AcpPermissionTerminalUpdate.make({
        ...entry.intent,
        state: entry.terminalState,
      });
      await persist(entry.intent);
      removeRuntimeEntry(entry);
      return;
    }
    const intent = AcpPermissionTerminalUpdate.make({
      ...entry.intent,
      messageTs: entry.messageTs,
      state: entry.terminalState,
      status: entry.messageTs === null ? "posting-ambiguous" : "pending",
    });
    entry.intent = intent;
    await persist(intent);
    if (intent.status === "pending") {
      removeRuntimeEntry(entry);
      startDriver(intent);
    }
  };

  const findMessageByMarker = async (
    intent: AcpPermissionTerminalUpdate
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Exact-scope marker reconciliation intentionally keeps all rejection predicates together.
  ): Promise<"duplicate" | string | null> => {
    let cursor: string | undefined;
    const matches: string[] = [];
    for (let page = 0; page < RECONCILIATION_MAX_PAGES; page += 1) {
      const response = await client.conversations.replies({
        channel: intent.channelId,
        ...(cursor === undefined ? {} : { cursor }),
        include_all_metadata: true,
        limit: RECONCILIATION_PAGE_SIZE,
        ts: intent.rootTs,
      });
      for (const message of response.messages ?? []) {
        if (
          message.thread_ts === intent.rootTs &&
          (options.botUserId === undefined ||
            message.user === options.botUserId) &&
          presentationMarkerFromMessage(message) ===
            intent.presentationMarker &&
          typeof message.ts === "string"
        ) {
          matches.push(message.ts);
        }
      }
      cursor = response.response_metadata?.next_cursor || undefined;
      if (cursor === undefined) {
        break;
      }
    }
    const unique = [...new Set(matches)];
    if (unique.length > 1) {
      return "duplicate";
    }
    return unique[0] ?? null;
  };

  const startReconciliationDriver = (
    initial: AcpPermissionTerminalUpdate
  ): void => {
    if (drivers.has(initial.id) || initial.state === null) {
      return;
    }
    const abort = new AbortController();
    const driver = track(
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This is one bounded durable reconciliation state machine.
      (async () => {
        let current = initial;
        let attemptedLookup = false;
        while (!abort.signal.aborted) {
          if (
            attemptedLookup &&
            (current.attempts >= attemptsLimit ||
              Date.now() >= current.deadlineAt)
          ) {
            await persist(
              AcpPermissionTerminalUpdate.make({
                ...current,
                diagnostic: "live-reconciliation-budget-exhausted",
                status: "posting-ambiguous",
              })
            );
            return;
          }
          if (current.nextAttemptAt > Date.now()) {
            await cancellableDelay(
              current.nextAttemptAt - Date.now(),
              abort.signal
            );
          }
          let found: "duplicate" | string | null;
          try {
            found = await findMessageByMarker(current);
            attemptedLookup = true;
          } catch (cause) {
            attemptedLookup = true;
            const attempts = current.attempts + 1;
            if (!isTransientUpdateFailure(cause)) {
              await persist(
                permanentlyDiagnose(
                  current,
                  "permission-message-lookup-failed",
                  attempts
                )
              );
              return;
            }
            current = AcpPermissionTerminalUpdate.make({
              ...current,
              attempts,
              nextAttemptAt:
                Date.now() + (retryAfterMillis(cause) ?? initialBackoffMillis),
            });
            await persist(current);
            continue;
          }
          if (found === "duplicate") {
            await persist(
              permanentlyDiagnose(current, "duplicate-presentation-marker")
            );
            return;
          }
          if (found !== null) {
            const reconciled = AcpPermissionTerminalUpdate.make({
              ...current,
              messageTs: found,
              status: "pending",
            });
            await persist(reconciled);
            drivers.delete(initial.id);
            startDriver(reconciled);
            return;
          }
          const attempts = current.attempts + 1;
          current = AcpPermissionTerminalUpdate.make({
            ...current,
            attempts,
            nextAttemptAt:
              Date.now() +
              Math.min(
                maxBackoffMillis,
                initialBackoffMillis * 2 ** Math.max(0, attempts - 1)
              ),
          });
          await persist(current);
        }
      })().finally(() => {
        if (drivers.get(initial.id)?.abort === abort) {
          drivers.delete(initial.id);
        }
      })
    );
    drivers.set(initial.id, { abort, task: driver });
  };

  const post: AcpPermissionPresenter["post"] = (request) =>
    Effect.suspend(() => {
      const existing = entries.get(request.capability);
      if (existing !== undefined) {
        return Effect.tryPromise({
          try: () => existing.post,
          catch: () => AcpPermissionPresentationError.make(),
        });
      }
      let entry: PresentationEntry;
      const intent = makePresentationIntent({
        authorizedSlackUserId: request.authorizedSlackUserId,
        category: request.category,
        channelId: request.channelId,
        deadlineAt: Date.now() + deadlineMillis,
        permissionExpiresAt: request.expiresAt,
        presentationMarker: request.presentationMarker,
        rootTs: request.rootTs,
        workspaceId: request.workspaceId,
      });
      let intentPersisted = false;
      const admissionAbort = new AbortController();
      const postTask = track(
        persist(intent, admissionAbort.signal)
          .then(() => {
            intentPersisted = true;
            return client.chat.postMessage({
              blocks: acpPermissionBlocks(request),
              channel: request.channelId,
              metadata: {
                event_payload: {
                  presentation_marker: request.presentationMarker,
                },
                event_type: PRESENTATION_METADATA_EVENT_TYPE,
              },
              text: acpPermissionFallbackText(request),
              thread_ts: request.rootTs,
            });
          })
          .then((response) => {
            if (response.ts === undefined) {
              throw AcpPermissionPresentationError.make();
            }
            entry.messageTs = response.ts;
            entry.intent = AcpPermissionTerminalUpdate.make({
              ...entry.intent,
              messageTs: response.ts,
            });
            return persist(entry.intent)
              .then(() => enqueueTerminal(entry))
              .then(() => ({ messageTs: response.ts as string }));
          })
          .catch(async (cause) => {
            const capacityExceeded =
              cause instanceof HandlerFailure &&
              cause.safeDetail === ACP_PERMISSION_UI_OUTBOX_CAPACITY_DETAIL;
            if (!intentPersisted) {
              removeRuntimeEntry(entry);
              throw cause;
            }
            const transient = isTransientUpdateFailure(cause);
            const current = transient
              ? AcpPermissionTerminalUpdate.make({
                  ...entry.intent,
                  diagnostic: null,
                  status: "posting-ambiguous",
                })
              : permanentlyDiagnose(
                  entry.intent,
                  capacityExceeded
                    ? "outbox-capacity-exceeded"
                    : "permanent-slack-post-failure"
                );
            entry.intent = current;
            await persist(current);
            throw cause;
          })
      );
      entry = {
        authorizedSlackUserId: request.authorizedSlackUserId,
        capability: request.capability,
        category: request.category,
        channelId: request.channelId,
        intent,
        messageTs: null,
        post: postTask,
        rootTs: request.rootTs,
        terminalState: null,
        workspaceId: request.workspaceId,
      };
      entries.set(request.capability, entry);
      reportRuntimeEntryCount();
      return Effect.tryPromise({
        try: (signal) => {
          const abortAdmission = (): void =>
            admissionAbort.abort(signal.reason);
          if (signal.aborted) {
            abortAdmission();
          } else {
            signal.addEventListener("abort", abortAdmission, { once: true });
          }
          return postTask.finally(() => {
            signal.removeEventListener("abort", abortAdmission);
          });
        },
        catch: () => AcpPermissionPresentationError.make(),
      });
    });

  const settle: AcpPermissionPresenter["settle"] = (request) =>
    Effect.promise(async () => {
      const entry = entries.get(request.capability);
      if (entry === undefined) {
        return;
      }
      entry.terminalState ??= request.state;
      entry.messageTs ??= request.messageTs;
      try {
        await enqueueTerminal(entry);
      } catch {
        // Authority is already terminal. Keep the runtime entry for shutdown
        // diagnostics rather than re-enabling its controls or failing the turn.
      }
    });

  const recover: NonNullable<AcpPermissionPresenter["recover"]> = (
    resolveState
  ) =>
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Startup recovery explicitly classifies every persisted presentation state.
    Effect.promise(async () => {
      const recovered =
        options.outbox === undefined
          ? [...localOutbox.values()]
          : await Effect.runPromise(options.outbox.load).catch(() => []);
      for (const intent of recovered) {
        localOutbox.set(intent.id, intent);
        if (intent.status === "permanent-failure") {
          if (Date.now() >= intent.retentionExpiresAt) {
            await remove(intent.id);
          }
          continue;
        }
        if (Date.now() >= intent.reconciliationExpiresAt) {
          await persist(
            permanentlyDiagnose(intent, "reconciliation-retention-expired")
          );
          continue;
        }
        if (
          options.workspaceId !== undefined &&
          intent.workspaceId !== options.workspaceId
        ) {
          await persist(
            permanentlyDiagnose(intent, "workspace-scope-mismatch")
          );
          continue;
        }
        const state =
          intent.state ??
          (await Effect.runPromise(resolveState(intent.presentationMarker)));
        if (state === null) {
          await persist(
            permanentlyDiagnose(intent, "terminal-authority-not-found")
          );
          continue;
        }
        const terminal = AcpPermissionTerminalUpdate.make({
          ...intent,
          attempts: 0,
          deadlineAt: Date.now() + deadlineMillis,
          diagnostic: null,
          nextAttemptAt: Date.now(),
          state,
          status: intent.messageTs === null ? "posting-ambiguous" : "pending",
        });
        await persist(terminal);
        if (terminal.messageTs === null) {
          startReconciliationDriver(terminal);
        } else {
          startDriver(terminal);
        }
      }
    });

  const drain = Effect.promise(async () => {
    const deadline = Date.now() + PRESENTER_SHUTDOWN_DRAIN_MILLIS;
    while (tasks.size > 0 && Date.now() < deadline) {
      const remaining = deadline - Date.now();
      await Promise.race([
        Promise.allSettled([...tasks]),
        new Promise<void>((resolve) => setTimeout(resolve, remaining)),
      ]);
    }
    for (const { abort } of drivers.values()) {
      abort.abort(new Error("permission UI outbox shutdown"));
    }
  });

  return { drain, post, recover, settle };
};
