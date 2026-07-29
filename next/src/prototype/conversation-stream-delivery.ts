import {
  type Cause,
  Clock,
  Effect,
  Array as EffectArray,
  Exit,
  Option,
  pipe,
  Ref,
  type Scope,
  Semaphore,
} from "effect";
import type { ApplicationConversationMessageChunk } from "../application.ts";
import type {
  ConversationStreamMode,
  ConversationStreamOperation,
  ConversationStreamOperationKind,
  ConversationStreamOwnerKind,
  ConversationStreamState,
  ThreadId,
} from "./domain.ts";
import { DeliveryError, HandlerFailure, type StoreError } from "./errors.ts";
import type { SlackGatewayShape } from "./runtime.ts";
import type { PrototypeStoreShape } from "./store.ts";

const MAX_OPERATION_ATTEMPTS = 5;

export interface ConversationStreamDeliveryPolicy {
  readonly coalesceCodePoints: number;
  readonly maxCoalesceMillis: number;
  readonly spacingMillis: Readonly<
    Record<ConversationStreamOperationKind, number>
  >;
}

export const slackConversationStreamDeliveryPolicy: ConversationStreamDeliveryPolicy =
  {
    coalesceCodePoints: 256,
    maxCoalesceMillis: 1000,
    spacingMillis: {
      "fallback-post": 1000,
      "fallback-update": 1200,
      "native-append": 1000,
      "native-start": 3000,
      "native-stop": 3000,
    },
  };

export const immediateConversationStreamDeliveryPolicy: ConversationStreamDeliveryPolicy =
  {
    ...slackConversationStreamDeliveryPolicy,
    spacingMillis: {
      "fallback-post": 0,
      "fallback-update": 0,
      "native-append": 0,
      "native-start": 0,
      "native-stop": 0,
    },
  };

export interface ConversationStreamOwner {
  readonly ownerId: string;
  readonly ownerKind: ConversationStreamOwnerKind;
  readonly threadId: ThreadId;
}

export type ConversationStreamOwnerRecoveryStatus =
  | "pending"
  | "resumed"
  | "completed"
  | "failed"
  | "non-replayable"
  | "unavailable";

export interface ConversationStreamPublisher {
  readonly finalize: (
    terminalReason: string
  ) => Effect.Effect<void, HandlerFailure | StoreError>;
  readonly publish: (
    output: ApplicationConversationMessageChunk
  ) => Effect.Effect<void, HandlerFailure | StoreError>;
}

export interface ConversationStreamDelivery {
  readonly declareOwnerRecoveryUnavailableForThread: (
    threadId: ThreadId
  ) => Effect.Effect<void, HandlerFailure | StoreError>;
  readonly publisherFor: (
    owner: ConversationStreamOwner
  ) => ConversationStreamPublisher;
  readonly recover: Effect.Effect<void, StoreError>;
  readonly signalOwnerRecovery: (
    owner: ConversationStreamOwner,
    status: Exclude<ConversationStreamOwnerRecoveryStatus, "pending">
  ) => Effect.Effect<void, HandlerFailure | StoreError>;
}

export interface ConversationStreamDeliveryTestHooks {
  readonly afterOperationInFlight?: (
    operation: ConversationStreamOperation
  ) => Effect.Effect<void>;
  readonly afterOperationPrepared?: (
    operation: ConversationStreamOperation
  ) => Effect.Effect<void>;
  readonly afterOperationSettled?: (
    operation: ConversationStreamOperation
  ) => Effect.Effect<void>;
  readonly afterRequestBeforeOutcomePersisted?: (
    operation: ConversationStreamOperation
  ) => Effect.Effect<void>;
  readonly afterScheduledDrive?: (streamId: string) => Effect.Effect<void>;
}

interface StreamSemaphoreEntry {
  readonly semaphore: Semaphore.Semaphore;
  readonly users: number;
}

interface OwnerRecoveryEntry {
  readonly owner: ConversationStreamOwner;
  readonly status: ConversationStreamOwnerRecoveryStatus;
}

const ownerRecoveryKey = (owner: ConversationStreamOwner): string =>
  `${owner.threadId}\u0000${owner.ownerKind}\u0000${owner.ownerId}`;

const deliveryFailure = (): HandlerFailure =>
  HandlerFailure.make({
    category: "protocol",
    noticeStyle: "generic",
    safeDetail: "Conversation message delivery failed",
  });

const projectConversationMessageFailure = (
  error: StoreError
): HandlerFailure | StoreError =>
  error.operation === "acceptConversationStreamChunk" &&
  error.reason === "conversation-message-too-long"
    ? deliveryFailure()
    : error;

const unavailableCapability = (): DeliveryError =>
  DeliveryError.make({
    category: "stream-capability-unavailable",
    disposition: "item-permanent",
    outcomeCertainty: "definitely-rejected",
    retryAfterMillis: 0,
  });

const codePointLength = (value: string): number => [...value].length;

const codePointSlice = (value: string, start: number): string =>
  [...value].slice(start).join("");

const activeOperation = (
  stream: ConversationStreamState
): ConversationStreamOperation | null =>
  pipe(
    stream.operations,
    EffectArray.findLast(
      (operation) =>
        operation.status === "prepared" ||
        operation.status === "in_flight" ||
        operation.status === "retry"
    ),
    Option.getOrNull
  );

const streamIsTerminal = (stream: ConversationStreamState): boolean =>
  stream.lifecycle === "stopped" || stream.lifecycle === "unresolved";

const modeFor = (slack: SlackGatewayShape): ConversationStreamMode =>
  slack.nativeStreaming === undefined ? "fallback" : "native";

const operationRequestFor = (
  stream: ConversationStreamState,
  nowMillis: number
): {
  readonly kind: ConversationStreamOperationKind;
  readonly nowMillis: number;
  readonly payloadEndOffset: number;
  readonly payloadStartOffset: number;
  readonly payloadText: string;
  readonly streamId: string;
} | null => {
  const totalOffset = codePointLength(stream.cumulativeText);
  if (stream.confirmedOffset < totalOffset) {
    if (stream.slackTs === null) {
      return {
        kind: stream.mode === "native" ? "native-start" : "fallback-post",
        nowMillis,
        payloadEndOffset: totalOffset,
        payloadStartOffset: 0,
        payloadText: stream.cumulativeText,
        streamId: stream.id,
      };
    }
    return stream.mode === "native"
      ? {
          kind: "native-append",
          nowMillis,
          payloadEndOffset: totalOffset,
          payloadStartOffset: stream.confirmedOffset,
          payloadText: codePointSlice(
            stream.cumulativeText,
            stream.confirmedOffset
          ),
          streamId: stream.id,
        }
      : {
          kind: "fallback-update",
          nowMillis,
          payloadEndOffset: totalOffset,
          payloadStartOffset: 0,
          payloadText: stream.cumulativeText,
          streamId: stream.id,
        };
  }
  if (
    stream.lifecycle === "finalizing" &&
    stream.mode === "native" &&
    stream.slackTs !== null
  ) {
    return {
      kind: "native-stop",
      nowMillis,
      payloadEndOffset: totalOffset,
      payloadStartOffset: totalOffset,
      payloadText: "",
      streamId: stream.id,
    };
  }
  return null;
};

const performOperation = (
  slack: SlackGatewayShape,
  stream: ConversationStreamState,
  operation: ConversationStreamOperation
): Effect.Effect<{ readonly slackTs: string | null }, DeliveryError> => {
  switch (operation.kind) {
    case "native-start": {
      if (
        slack.nativeStreaming === undefined ||
        stream.recipientUserId === null
      ) {
        return unavailableCapability();
      }
      return slack.nativeStreaming
        .start({
          channelId: stream.channelId,
          recipientUserId: stream.recipientUserId,
          rootTs: stream.rootTs,
          text: operation.payloadText,
        })
        .pipe(Effect.map(({ ts }) => ({ slackTs: ts })));
    }
    case "native-append": {
      if (slack.nativeStreaming === undefined || stream.slackTs === null) {
        return unavailableCapability();
      }
      return slack.nativeStreaming
        .append({
          channelId: stream.channelId,
          streamTs: stream.slackTs,
          text: operation.payloadText,
        })
        .pipe(Effect.as({ slackTs: null }));
    }
    case "native-stop": {
      if (slack.nativeStreaming === undefined || stream.slackTs === null) {
        return unavailableCapability();
      }
      return slack.nativeStreaming
        .stop({ channelId: stream.channelId, streamTs: stream.slackTs })
        .pipe(Effect.as({ slackTs: null }));
    }
    case "fallback-post":
      return slack
        .postThreadMessage({
          channelId: stream.channelId,
          rootTs: stream.rootTs,
          text: operation.payloadText,
        })
        .pipe(Effect.map(({ ts }) => ({ slackTs: ts })));
    case "fallback-update": {
      if (slack.updateThreadMessage === undefined || stream.slackTs === null) {
        return unavailableCapability();
      }
      return slack
        .updateThreadMessage({
          channelId: stream.channelId,
          messageTs: stream.slackTs,
          text: operation.payloadText,
        })
        .pipe(Effect.as({ slackTs: null }));
    }
    default:
      return unavailableCapability();
  }
};

export const makeConversationStreamDelivery = Effect.fn(
  "makeConversationStreamDelivery"
)(function* (options: {
  readonly policy?: ConversationStreamDeliveryPolicy;
  readonly slack: SlackGatewayShape;
  readonly store: PrototypeStoreShape;
  readonly testHooks?: ConversationStreamDeliveryTestHooks;
}): Effect.fn.Return<ConversationStreamDelivery, never, Scope.Scope> {
  const policy = options.policy ?? immediateConversationStreamDeliveryPolicy;
  const ownerScope = yield* Effect.scope;
  const scheduled = yield* Ref.make<ReadonlySet<string>>(new Set());
  const ownerRecoveries = yield* Ref.make<
    ReadonlyMap<string, OwnerRecoveryEntry>
  >(new Map());
  const streamSemaphores = yield* Ref.make<
    ReadonlyMap<string, StreamSemaphoreEntry>
  >(new Map());

  const retainStreamSemaphore = (streamId: string) =>
    Ref.modify(streamSemaphores, (current) => {
      const existing = current.get(streamId);
      const updated = new Map(current);
      if (existing !== undefined) {
        updated.set(streamId, { ...existing, users: existing.users + 1 });
        return [existing.semaphore, updated] as const;
      }
      const semaphore = Semaphore.makeUnsafe(1);
      updated.set(streamId, { semaphore, users: 1 });
      return [semaphore, updated] as const;
    });

  const releaseStreamSemaphore = (streamId: string) =>
    Ref.update(streamSemaphores, (current) => {
      const existing = current.get(streamId);
      if (existing === undefined) {
        return current;
      }
      const updated = new Map(current);
      if (existing.users === 1) {
        updated.delete(streamId);
      } else {
        updated.set(streamId, { ...existing, users: existing.users - 1 });
      }
      return updated;
    });

  const findStream = Effect.fnUntraced(function* (streamId: string) {
    return pipe(
      yield* options.store.conversationStreams,
      EffectArray.findFirst((stream) => stream.id === streamId),
      Option.getOrNull
    );
  });

  const settleRestartedInFlight = Effect.fnUntraced(function* (
    operation: ConversationStreamOperation
  ) {
    const now = yield* Clock.currentTimeMillis;
    if (operation.kind === "fallback-update") {
      yield* options.store.settleConversationStreamOperation({
        category: "response-outcome-unknown-after-restart",
        certainty: "unknown",
        nowMillis: now,
        operationId: operation.id,
        outcome: "retry",
        retryAtMillis: now,
        slackTs: null,
      });
      if (options.testHooks?.afterOperationSettled !== undefined) {
        yield* options.testHooks.afterOperationSettled(operation);
      }
      return;
    }
    yield* options.store.settleConversationStreamOperation({
      category: "response-outcome-unknown-after-restart",
      certainty: "unknown",
      nowMillis: now,
      operationId: operation.id,
      outcome: "unresolved",
      retryAtMillis: null,
      slackTs: null,
    });
    if (options.testHooks?.afterOperationSettled !== undefined) {
      yield* options.testHooks.afterOperationSettled(operation);
    }
  });

  const failureOutcome = (
    error: DeliveryError
  ): "rejected" | "stopped_by_user" | "unresolved" => {
    if (error.category === "stopped_by_user") {
      return "stopped_by_user";
    }
    return (error.outcomeCertainty ?? "unknown") === "unknown"
      ? "unresolved"
      : "rejected";
  };

  const afterOperationSettled = (
    operation: ConversationStreamOperation
  ): Effect.Effect<void> =>
    options.testHooks?.afterOperationSettled?.(operation) ?? Effect.void;

  const requestOperation = Effect.fnUntraced(function* (
    stream: ConversationStreamState,
    operation: ConversationStreamOperation
  ) {
    const beforeReservation = yield* Clock.currentTimeMillis;
    const slot = yield* options.store.reserveConversationStreamRateSlot({
      nowMillis: beforeReservation,
      operationId: operation.id,
      spacingMillis: policy.spacingMillis[operation.kind],
    });
    const beforeWait = yield* Clock.currentTimeMillis;
    if (slot > beforeWait) {
      yield* Effect.sleep(`${slot - beforeWait} millis`);
    }
    const requestAt = yield* Clock.currentTimeMillis;
    yield* options.store.markConversationStreamOperationInFlight(
      operation.id,
      requestAt
    );
    if (options.testHooks?.afterOperationInFlight !== undefined) {
      yield* options.testHooks.afterOperationInFlight(operation);
    }
    const result = yield* Effect.result(
      performOperation(options.slack, stream, operation)
    );
    if (options.testHooks?.afterRequestBeforeOutcomePersisted !== undefined) {
      yield* options.testHooks.afterRequestBeforeOutcomePersisted(operation);
    }
    const settledAt = yield* Clock.currentTimeMillis;
    if (result._tag === "Success") {
      yield* options.store.settleConversationStreamOperation({
        category: null,
        certainty: null,
        nowMillis: settledAt,
        operationId: operation.id,
        outcome: "acknowledged",
        retryAtMillis: null,
        slackTs: result.success.slackTs,
      });
      yield* afterOperationSettled(operation);
      return;
    }
    const error = result.failure;
    const certainty = error.outcomeCertainty ?? "unknown";
    const mayConverge = operation.kind === "fallback-update";
    const shouldRetry =
      error.disposition === "transient" &&
      (certainty === "definitely-rejected" || mayConverge) &&
      operation.attempt + 1 < MAX_OPERATION_ATTEMPTS;
    if (shouldRetry) {
      yield* options.store.settleConversationStreamOperation({
        category: error.category,
        certainty,
        nowMillis: settledAt,
        operationId: operation.id,
        outcome: "retry",
        retryAtMillis: settledAt + Math.max(1, error.retryAfterMillis),
        slackTs: null,
      });
      yield* afterOperationSettled(operation);
      return;
    }
    yield* options.store.settleConversationStreamOperation({
      category: error.category,
      certainty,
      nowMillis: settledAt,
      operationId: operation.id,
      outcome: failureOutcome(error),
      retryAtMillis: null,
      slackTs: null,
    });
    yield* afterOperationSettled(operation);
    if (
      error.category === "stopped_by_user" &&
      operation.kind === "native-stop"
    ) {
      return;
    }
    return yield* deliveryFailure();
  });

  const driveActiveOperation = Effect.fnUntraced(function* (
    stream: ConversationStreamState,
    operation: ConversationStreamOperation
  ) {
    if (operation.status === "in_flight") {
      yield* settleRestartedInFlight(operation);
      const after = yield* findStream(stream.id);
      if (after?.lifecycle === "unresolved") {
        return yield* deliveryFailure();
      }
      return;
    }
    if (operation.status === "retry" && operation.retryAtMillis !== null) {
      const now = yield* Clock.currentTimeMillis;
      if (operation.retryAtMillis > now) {
        yield* Effect.sleep(`${operation.retryAtMillis - now} millis`);
      }
    }
    yield* Effect.uninterruptible(requestOperation(stream, operation));
  });

  const completeFinalizingStream = Effect.fnUntraced(function* (
    stream: ConversationStreamState
  ) {
    if (stream.lifecycle !== "finalizing") {
      return false;
    }
    if (stream.slackTs === null && stream.cumulativeText.trim().length === 0) {
      const now = yield* Clock.currentTimeMillis;
      yield* options.store.completeConversationStreamLocally(
        stream.id,
        stream.terminalReason ?? "completed",
        now
      );
      return true;
    }
    if (
      stream.mode === "fallback" &&
      stream.confirmedOffset === codePointLength(stream.cumulativeText)
    ) {
      const now = yield* Clock.currentTimeMillis;
      yield* options.store.completeFallbackConversationStream(
        stream.id,
        stream.terminalReason ?? "completed",
        now
      );
      return true;
    }
    return false;
  });

  const rejectMissingNativeRecipient = Effect.fnUntraced(function* (
    stream: ConversationStreamState
  ) {
    const isMissing =
      stream.mode === "native" &&
      stream.slackTs === null &&
      stream.recipientUserId === null &&
      stream.cumulativeText.trim().length > 0;
    if (!isMissing) {
      return false;
    }
    const now = yield* Clock.currentTimeMillis;
    yield* options.store.markConversationStreamUnresolved(
      stream.id,
      "native-recipient-unavailable",
      now
    );
    return true;
  });

  const driveStreamStep = Effect.fnUntraced(function* (
    stream: ConversationStreamState
  ) {
    const active = activeOperation(stream);
    if (active !== null) {
      yield* driveActiveOperation(stream, active);
      return "Continue" as const;
    }
    if (yield* completeFinalizingStream(stream)) {
      return "Done" as const;
    }
    if (yield* rejectMissingNativeRecipient(stream)) {
      return yield* deliveryFailure();
    }
    const now = yield* Clock.currentTimeMillis;
    const request = operationRequestFor(stream, now);
    if (request === null) {
      return "Done" as const;
    }
    const preparation =
      yield* options.store.prepareConversationStreamOperation(request);
    if (preparation._tag === "Unresolved") {
      return yield* deliveryFailure();
    }
    const operation = preparation.operation;
    if (options.testHooks?.afterOperationPrepared !== undefined) {
      yield* options.testHooks.afterOperationPrepared(operation);
    }
    return "Continue" as const;
  });

  const driveUnserialized = Effect.fnUntraced(function* (streamId: string) {
    while (true) {
      const stream = yield* findStream(streamId);
      if (stream === null || streamIsTerminal(stream)) {
        return;
      }
      if ((yield* driveStreamStep(stream)) === "Done") {
        return;
      }
    }
  });

  const drive = (streamId: string) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const semaphore = yield* retainStreamSemaphore(streamId);
        return yield* restore(
          semaphore.withPermit(driveUnserialized(streamId))
        ).pipe(Effect.ensuring(releaseStreamSemaphore(streamId)));
      })
    );

  const signalOwnerRecovery = Effect.fnUntraced(function* (
    owner: ConversationStreamOwner,
    status: Exclude<ConversationStreamOwnerRecoveryStatus, "pending">
  ) {
    const key = ownerRecoveryKey(owner);
    const entry = (yield* Ref.get(ownerRecoveries)).get(key);
    if (entry === undefined) {
      return;
    }
    if (status === "resumed") {
      yield* Ref.update(ownerRecoveries, (current) => {
        const next = new Map(current);
        next.set(key, { owner, status });
        return next;
      });
      return;
    }
    const streamIds =
      yield* options.store.requestConversationStreamFinalization({
        ...owner,
        terminalReason: "restart",
      });
    yield* Effect.forEach(streamIds, drive, {
      concurrency: "unbounded",
      discard: true,
    });
    yield* Ref.update(ownerRecoveries, (current) => {
      const next = new Map(current);
      next.delete(key);
      return next;
    });
  });

  const declareOwnerRecoveryUnavailableForThread = Effect.fnUntraced(function* (
    threadId: ThreadId
  ) {
    const owners = pipe(
      [...(yield* Ref.get(ownerRecoveries)).values()],
      EffectArray.filter((entry) => entry.owner.threadId === threadId),
      EffectArray.map((entry) => entry.owner)
    );
    yield* Effect.forEach(
      owners,
      (owner) => signalOwnerRecovery(owner, "unavailable"),
      { concurrency: "unbounded", discard: true }
    );
  });

  const schedule: (
    streamId: string,
    flushDeadlineMillis: number
  ) => Effect.Effect<void> = Effect.fnUntraced(function* (
    streamId: string,
    flushDeadlineMillis: number
  ) {
    const shouldStart = yield* Ref.modify(scheduled, (current) => {
      if (current.has(streamId)) {
        return [false, current] as const;
      }
      const next = new Set(current);
      next.add(streamId);
      return [true, next] as const;
    });
    if (!shouldStart) {
      return;
    }
    let driveSucceeded = false;
    const scheduledDrive = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (flushDeadlineMillis > now) {
        yield* Effect.sleep(`${flushDeadlineMillis - now} millis`);
      }
      yield* drive(streamId);
      if (options.testHooks?.afterScheduledDrive !== undefined) {
        yield* options.testHooks.afterScheduledDrive(streamId);
      }
      driveSucceeded = true;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Conversation stream scheduled flush stopped", cause)
      ),
      Effect.ensuring(
        Effect.gen(function* () {
          yield* Ref.update(scheduled, (current) => {
            const next = new Set(current);
            next.delete(streamId);
            return next;
          });
          if (!driveSucceeded) {
            return;
          }
          const stream = yield* findStream(streamId);
          if (
            stream === null ||
            stream.lifecycle !== "open" ||
            stream.flushDeadlineMillis === null ||
            stream.confirmedOffset >= codePointLength(stream.cumulativeText)
          ) {
            return;
          }
          yield* schedule(streamId, stream.flushDeadlineMillis);
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logError(
              "Conversation stream scheduled flush release stopped",
              cause
            )
          )
        )
      )
    );
    yield* scheduledDrive.pipe(
      Effect.forkIn(ownerScope, { startImmediately: true })
    );
  });

  const flushOtherMessageBoundaries = Effect.fnUntraced(function* (
    owner: ConversationStreamOwner,
    messageId: string
  ) {
    const streams = pipe(
      yield* options.store.conversationStreams,
      EffectArray.filter(
        (stream) =>
          stream.threadId === owner.threadId &&
          stream.ownerKind === owner.ownerKind &&
          stream.ownerId === owner.ownerId &&
          stream.messageId !== messageId &&
          stream.lifecycle === "open" &&
          stream.confirmedOffset < codePointLength(stream.cumulativeText)
      )
    );
    yield* Effect.forEach(streams, (stream) => drive(stream.id), {
      discard: true,
    });
  });

  const publisherFor = (owner: ConversationStreamOwner) => {
    const publish = Effect.fnUntraced(function* (
      output: ApplicationConversationMessageChunk
    ) {
      yield* signalOwnerRecovery(owner, "resumed");
      yield* flushOtherMessageBoundaries(owner, output.messageId);
      const now = yield* Clock.currentTimeMillis;
      const decision = yield* options.store
        .acceptConversationStreamChunk({
          messageId: output.messageId,
          nowMillis: now,
          ownerId: owner.ownerId,
          ownerKind: owner.ownerKind,
          sequence: output.sequence ?? null,
          text: output.text,
          threadId: owner.threadId,
        })
        .pipe(Effect.mapError(projectConversationMessageFailure));
      if (decision._tag === "Duplicate") {
        return;
      }
      const stream = yield* findStream(decision.streamId);
      if (stream === null) {
        return yield* deliveryFailure();
      }
      const pendingCodePoints =
        codePointLength(stream.cumulativeText) - stream.confirmedOffset;
      const shouldFlushNow =
        stream.slackTs === null ||
        pendingCodePoints >= policy.coalesceCodePoints;
      yield* options.store.configureConversationStream({
        flushDeadlineMillis:
          pendingCodePoints === 0 ? null : now + policy.maxCoalesceMillis,
        mode: modeFor(options.slack),
        streamId: stream.id,
      });
      if (
        output.text.length === 0 ||
        stream.cumulativeText.trim().length === 0
      ) {
        return;
      }
      if (shouldFlushNow) {
        yield* drive(stream.id);
        return;
      }
      yield* schedule(stream.id, now + policy.maxCoalesceMillis);
    });
    const finalize = Effect.fnUntraced(function* (terminalReason: string) {
      yield* signalOwnerRecovery(owner, "resumed");
      const streamIds =
        yield* options.store.requestConversationStreamFinalization({
          ...owner,
          terminalReason,
        });
      let firstFailure: Cause.Cause<HandlerFailure | StoreError> | undefined;
      yield* Effect.forEach(
        streamIds,
        (streamId) =>
          Effect.exit(drive(streamId)).pipe(
            Effect.tap((exit) =>
              Effect.sync(() => {
                if (Exit.isFailure(exit)) {
                  firstFailure ??= exit.cause;
                }
              })
            )
          ),
        { discard: true }
      );
      if (firstFailure !== undefined) {
        return yield* Effect.failCause(firstFailure);
      }
      const ownerStreams = pipe(
        yield* options.store.conversationStreams,
        EffectArray.filter(
          (stream) =>
            stream.threadId === owner.threadId &&
            stream.ownerKind === owner.ownerKind &&
            stream.ownerId === owner.ownerId
        )
      );
      const ownerTombstones = pipe(
        yield* options.store.conversationStreamTombstones,
        EffectArray.filter(
          (stream) =>
            stream.threadId === owner.threadId &&
            stream.ownerKind === owner.ownerKind &&
            stream.ownerId === owner.ownerId
        )
      );
      if (
        EffectArray.some(
          [...ownerStreams, ...ownerTombstones],
          (stream) => stream.lifecycle === "unresolved"
        )
      ) {
        return yield* deliveryFailure();
      }
    });
    return { finalize, publish } satisfies ConversationStreamPublisher;
  };

  const recover = Effect.gen(function* () {
    if ((yield* options.store.conversationStreams).length === 0) {
      return;
    }
    const now = yield* Clock.currentTimeMillis;
    const streamIds =
      yield* options.store.reconcileConversationStreamsOnRestart(now);
    const streams = yield* options.store.conversationStreams;
    yield* Ref.set(
      ownerRecoveries,
      new Map(
        streams
          .filter(
            (stream) =>
              stream.lifecycle === "open" &&
              stream.replayBoundaryOffset !== null
          )
          .map((stream) => {
            const owner = {
              ownerId: stream.ownerId,
              ownerKind: stream.ownerKind,
              threadId: stream.threadId,
            } satisfies ConversationStreamOwner;
            return [
              ownerRecoveryKey(owner),
              { owner, status: "pending" as const },
            ];
          })
      )
    );
    yield* Effect.forEach(
      streams.filter((stream) => streamIds.includes(stream.id)),
      (stream) => {
        if (streamIsTerminal(stream)) {
          return Effect.void;
        }
        if (activeOperation(stream) !== null) {
          return schedule(stream.id, now);
        }
        if (stream.lifecycle === "finalizing") {
          return schedule(stream.id, now);
        }
        if (stream.replayBoundaryOffset !== null) {
          return Effect.void;
        }
        if (stream.flushDeadlineMillis === null) {
          return Effect.void;
        }
        return schedule(stream.id, Math.max(now, stream.flushDeadlineMillis));
      },
      { concurrency: "unbounded", discard: true }
    );
  });

  return {
    declareOwnerRecoveryUnavailableForThread,
    publisherFor,
    recover,
    signalOwnerRecovery,
  };
});
