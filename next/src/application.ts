import { isAbsolute } from "node:path";
import { Context, Effect, Layer, Schema } from "effect";
import {
  type ClaimedTurn,
  NormalizedMessage,
  PublicReplyProtocolRecord,
  ReplyId,
  ThreadId,
  TurnId,
} from "./prototype/domain.ts";
import { HandlerFailure, type StoreError } from "./prototype/errors.ts";
import {
  assertNoSymlinkPathComponents,
  canonicalDirectory,
} from "./prototype/path-safety.ts";

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
  readonly scheduling: "AlreadyDurable" | "Scheduled";
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

export type PublishApplicationReply = (
  reply: ApplicationPublicReply
) => Effect.Effect<void, HandlerFailure | StoreError>;

export interface ApplicationShape {
  readonly handle: (
    event: ApplicationEvent,
    publish: PublishApplicationReply,
    acceptEvent: AcceptApplicationEvent
  ) => Effect.Effect<void, HandlerFailure | StoreError>;
  readonly recover?: (
    acceptEvent: AcceptApplicationEvent
  ) => Effect.Effect<void, HandlerFailure | StoreError>;
}

export class Application extends Context.Service<
  Application,
  ApplicationShape
>()("@laborer/Application") {
  static layer = (application: ApplicationShape): Layer.Layer<Application> =>
    Layer.succeed(Application, application);
}

interface ConfiguredProcessHandler {
  readonly invoke: (
    turn: ClaimedTurn,
    acceptReply: (
      record: PublicReplyProtocolRecord
    ) => Effect.Effect<void, HandlerFailure | StoreError>
  ) => Effect.Effect<void, HandlerFailure | StoreError>;
}

interface ConfiguredThreadInitializer {
  readonly initialize: (
    turn: ClaimedTurn,
    acceptReply: (
      record: PublicReplyProtocolRecord
    ) => Effect.Effect<void, HandlerFailure | StoreError>
  ) => Effect.Effect<string, HandlerFailure | StoreError>;
}

interface ConfiguredProcessApplicationOptions {
  readonly completeInitialization: (
    conversationId: ThreadId,
    workingDirectory: string
  ) => Effect.Effect<void, StoreError>;
  readonly handler: ConfiguredProcessHandler;
  readonly initializer?: ConfiguredThreadInitializer;
}

const validateInitializedWorkingDirectory = (
  candidate: string
): Effect.Effect<string, HandlerFailure> =>
  Effect.tryPromise({
    try: async () => {
      if (!isAbsolute(candidate)) {
        throw new Error("working directory is not absolute");
      }
      await assertNoSymlinkPathComponents(
        candidate,
        "validate-initialized-working-directory"
      );
      const canonical = await canonicalDirectory(
        candidate,
        "validate-initialized-working-directory"
      );
      if (canonical !== candidate) {
        throw new Error("working directory is not canonical");
      }
      return canonical;
    },
    catch: () =>
      HandlerFailure.make({
        category: "protocol",
        safeDetail: "initializer returned an invalid working directory",
      }),
  });

const claimedTurnFromEvent = (
  event: ParticipantInputEvent,
  workingDirectory: string | null
): ClaimedTurn => ({
  attemptNumber: event.attemptNumber,
  channelId: event.channelId,
  context: event.context,
  id: event.turnId,
  initializationStatus: event.initializationStatus,
  messages: event.messages,
  rootTs: event.rootTs,
  threadId: event.conversationId,
  workingDirectory,
});

export const applicationFromConfiguredProcessHandler = (
  options: ConfiguredProcessApplicationOptions
): ApplicationShape =>
  Application.of({
    handle: Effect.fn("ConfiguredProcessApplication.handle")(
      function* (event, publish, _acceptEvent) {
        if (event._tag !== "ParticipantInput") {
          return yield* HandlerFailure.make({
            category: "protocol",
            safeDetail:
              "configured process handler cannot accept external events",
          });
        }
        const acceptReply = (record: PublicReplyProtocolRecord) =>
          publish(
            ApplicationPublicReply.make({
              replyId: record.replyId,
              text: record.text,
            })
          );
        let workingDirectory = event.workingDirectory;
        if (event.initializationStatus === "pending") {
          if (options.initializer === undefined) {
            return yield* HandlerFailure.make({
              category: "protocol",
              safeDetail: "thread initializer unavailable",
            });
          }
          workingDirectory = yield* options.initializer
            .initialize(
              claimedTurnFromEvent(event, workingDirectory),
              acceptReply
            )
            .pipe(Effect.flatMap(validateInitializedWorkingDirectory));
          yield* options.completeInitialization(
            event.conversationId,
            workingDirectory
          );
        }
        yield* options.handler.invoke(
          claimedTurnFromEvent(event, workingDirectory),
          acceptReply
        );
      }
    ),
  });

export const toPublicReplyProtocolRecord = (
  reply: ApplicationPublicReply
): PublicReplyProtocolRecord =>
  PublicReplyProtocolRecord.make({
    protocolVersion: 1,
    replyId: ReplyId.make(reply.replyId),
    text: reply.text,
    type: "public_reply",
  });
