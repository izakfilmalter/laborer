import { Context, type Effect, Layer, Schema } from "effect";
import { NormalizedMessage, ThreadId, TurnId } from "./core/domain.ts";
import type { HandlerFailure, StoreError } from "./core/errors.ts";

const NonBlankString = Schema.String.check(Schema.isPattern(/\S/));

export class ParticipantInputEvent extends Schema.TaggedClass<ParticipantInputEvent>()(
  "ParticipantInput",
  {
    attemptNumber: Schema.Number,
    channelId: Schema.String,
    context: Schema.Array(NormalizedMessage),
    conversationId: ThreadId,
    initializationStatus: Schema.Literals([
      "not_applicable",
      "pending",
      "completed",
    ]),
    messages: Schema.Array(NormalizedMessage),
    rootTs: Schema.String,
    source: Schema.Literal("slack"),
    turnId: TurnId,
    workingDirectory: Schema.NullOr(Schema.String),
  }
) {}

export class ExternalInputEvent extends Schema.TaggedClass<ExternalInputEvent>()(
  "ExternalInput",
  {
    conversationId: ThreadId,
    eventId: NonBlankString,
    payload: Schema.Unknown,
    source: NonBlankString,
  }
) {}

export const ApplicationEvent = Schema.Union([
  ParticipantInputEvent,
  ExternalInputEvent,
]);
export type ApplicationEvent = typeof ApplicationEvent.Type;

export type ApplicationEventDecision =
  | { readonly _tag: "Accepted"; readonly eventId: string }
  | { readonly _tag: "Duplicate"; readonly eventId: string };

export interface ApplicationEventAcceptance {
  readonly decision: ApplicationEventDecision;
  readonly scheduling: "AlreadyDurable" | "Deferred" | "Scheduled";
}

export type AcceptApplicationEvent = (
  event: ExternalInputEvent
) => Effect.Effect<ApplicationEventAcceptance, HandlerFailure | StoreError>;

export class ApplicationPublicReply extends Schema.TaggedClass<ApplicationPublicReply>()(
  "PublicReply",
  {
    replyId: NonBlankString,
    text: NonBlankString,
  }
) {}

export class ApplicationConversationMessageChunk extends Schema.TaggedClass<ApplicationConversationMessageChunk>()(
  "ConversationMessageChunk",
  {
    messageId: NonBlankString,
    sequence: Schema.optional(Schema.Number),
    text: Schema.String,
  }
) {}

export type ApplicationPublicOutput =
  | ApplicationConversationMessageChunk
  | ApplicationPublicReply;

/**
 * A prompt crossed the ACP admission boundary but no terminal result can be
 * proved. This is a domain outcome, not a HandlerFailure: the application must keep
 * the owner and every later input durable until an operator decides what to do.
 */
export class ConversationBlocked extends Schema.TaggedErrorClass<ConversationBlocked>()(
  "ConversationBlocked",
  {
    attemptId: NonBlankString,
    bindingGeneration: Schema.NullOr(Schema.Int),
    blockedAt: Schema.Int,
    conversationId: ThreadId,
    decisionId: Schema.NullOr(NonBlankString),
    decisionKind: Schema.NullOr(Schema.Literals(["abandon", "retry"])),
    ownerId: NonBlankString,
    ownerKind: Schema.Literals(["application-event", "participant-turn"]),
    processGeneration: Schema.Int,
    promptId: NonBlankString,
    replacementAttemptId: Schema.NullOr(NonBlankString),
    sessionDisposition: Schema.NullOr(
      Schema.Literals(["replaced", "resumed-quiescent"])
    ),
    workspaceId: NonBlankString,
  }
) {}

export interface ConversationRecoveryDecisionRequest {
  readonly acknowledgeDuplicateSideEffects: boolean;
  readonly actorUid: number;
  readonly attemptId: string;
  readonly bindingGeneration: number | null;
  readonly conversationId: ThreadId;
  readonly decisionId: string;
  readonly kind: "abandon" | "retry";
  readonly ownerId: string;
  readonly ownerKind: "application-event" | "participant-turn";
  readonly processGeneration: number;
  readonly promptId: string;
  readonly timestamp: number;
  readonly workspaceId: string;
}

export interface ConversationRecoveryDecisionResult {
  readonly acknowledgeDuplicateSideEffects: boolean;
  readonly attemptId: string;
  readonly conversationId: ThreadId;
  readonly decisionId: string;
  readonly duplicate: boolean;
  readonly kind: "abandon" | "retry";
  readonly ownerId: string;
  readonly ownerKind: "application-event" | "participant-turn";
  readonly promptId: string;
  readonly replacementAttemptId: string | null;
  readonly sessionDisposition: "replaced" | "resumed-quiescent";
  readonly workspaceId: string;
}

export class ConversationRecoveryDecisionRejected extends Schema.TaggedErrorClass<ConversationRecoveryDecisionRejected>()(
  "ConversationRecoveryDecisionRejected",
  {
    reason: Schema.Literals([
      "conflict",
      "duplicate-risk-not-acknowledged",
      "invalid-identity",
      "not-unresolved",
      "stale-generation",
      "wrong-scope",
    ]),
  }
) {}

export type PublishApplicationReply = (
  reply: ApplicationPublicReply
) => Effect.Effect<void, HandlerFailure | StoreError>;

export type PublishApplicationOutput = (
  output: ApplicationPublicOutput
) => Effect.Effect<void, HandlerFailure | StoreError>;

export interface ApplicationShape {
  readonly decideConversationRecovery?: (
    request: ConversationRecoveryDecisionRequest
  ) => Effect.Effect<
    ConversationRecoveryDecisionResult,
    ConversationRecoveryDecisionRejected | HandlerFailure
  >;
  readonly handle: (
    event: ApplicationEvent,
    publish: PublishApplicationOutput,
    acceptEvent: AcceptApplicationEvent
  ) => Effect.Effect<void, ConversationBlocked | HandlerFailure | StoreError>;
  readonly recover?: (
    acceptEvent: AcceptApplicationEvent
  ) => Effect.Effect<void, HandlerFailure | StoreError>;
  readonly unresolvedConversationForOwner?: (owner: {
    readonly conversationId: ThreadId;
    readonly ownerId: string;
    readonly ownerKind: "application-event" | "participant-turn";
    readonly workspaceId: string;
  }) => Effect.Effect<ConversationBlocked | null, HandlerFailure>;
  readonly unresolvedConversations?: Effect.Effect<
    readonly ConversationBlocked[],
    HandlerFailure
  >;
}

export class Application extends Context.Service<
  Application,
  ApplicationShape
>()("@laborer/Application") {
  static layer = (application: ApplicationShape): Layer.Layer<Application> =>
    Layer.succeed(Application, application);
}
