import { Deferred, Effect, Schema } from "effect";
import { canonicalActionInput } from "../action-catalog.ts";
import type {
  AcceptApplicationEvent,
  ApplicationPublicOutput,
  ApplicationShape,
  ConversationBlocked,
  PublishApplicationOutput,
} from "../application.ts";
import type { StoreError } from "../core/errors.ts";
import { HandlerFailure } from "../core/errors.ts";
import {
  ConversationOutput,
  type DurableRuntimeError,
  type RootDurableRuntimeShape,
  RUNTIME_PAYLOAD_MAX_BYTES,
} from "./root-runtime.ts";
import {
  attachConversationClientLocally,
  ROOT_RUNTIME_PROTOCOL_VERSION,
  runConversationRpcLocally,
} from "./rpc.ts";

const runtimeFailure = (_error: DurableRuntimeError): HandlerFailure =>
  HandlerFailure.make({
    category: "protocol",
    noticeStyle: "generic",
    safeDetail: "durable Conversation runtime unavailable",
  });

const invalidRuntimeOutput = (): HandlerFailure =>
  HandlerFailure.make({
    category: "protocol",
    noticeStyle: "generic",
    safeDetail: "durable Conversation output invalid",
  });

const unavailableEventAcceptance: AcceptApplicationEvent = () =>
  HandlerFailure.make({
    category: "protocol",
    noticeStyle: "generic",
    safeDetail: "durable external-event acceptance unavailable",
  });

/**
 * Routes participant turns through the root owner while retaining the existing
 * Conversation application as the only publisher. The same registered handler receives durable
 * Execution events from the root runtime; Action workers never publish.
 */
export const applicationThroughRootConversationRuntime = Effect.fn(
  "applicationThroughRootConversationRuntime"
)(function* (options: {
  readonly application: ApplicationShape;
  readonly actionCatalogFingerprint: string;
  readonly rootIdentity: string;
  readonly publishExternalOutput?: (
    conversationId: string,
    output: ApplicationPublicOutput
  ) => Effect.Effect<void, HandlerFailure | StoreError>;
  readonly routeParticipantTurnsThroughDurableRuntime?: boolean;
  readonly runtime: RootDurableRuntimeShape;
  readonly workspaceId: string;
}) {
  const eventAcceptors = new Map<string, AcceptApplicationEvent>();
  const failures = new Map<
    string,
    ConversationBlocked | HandlerFailure | StoreError
  >();
  const publishers = new Map<string, PublishApplicationOutput>();
  const handledEvents = new Set<string>();
  const runnerEventAcceptance = yield* Deferred.make<AcceptApplicationEvent>();
  const rememberRunnerEventAcceptance = (acceptEvent: AcceptApplicationEvent) =>
    Deferred.succeed(runnerEventAcceptance, acceptEvent).pipe(Effect.asVoid);
  yield* attachConversationClientLocally(
    options.runtime,
    {
      compatibility: {
        actionCatalogFingerprint: options.actionCatalogFingerprint,
      },
      protocolVersion: ROOT_RUNTIME_PROTOCOL_VERSION,
      workspaceId: options.workspaceId,
    },
    {
      handle: (event) =>
        Effect.gen(function* () {
          if (event._tag === "ExternalInput") {
            if (options.routeParticipantTurnsThroughDurableRuntime === false) {
              const outputs: ApplicationPublicOutput[] = [];
              yield* options.application.handle(
                event,
                (output) =>
                  Effect.sync(() => outputs.push(output)).pipe(
                    Effect.andThen(
                      options.publishExternalOutput?.(
                        event.conversationId,
                        output
                      ) ?? Effect.void
                    )
                  ),
                () =>
                  Effect.succeed({
                    decision: { _tag: "Accepted", eventId: event.eventId },
                    scheduling: "AlreadyDurable",
                  })
              );
              return outputs;
            }
            // The root owner makes the Action event durable before handing it
            // back to the Conversation application, which remains responsible for ordering
            // the Application invocation and publishing any resulting output.
            const acceptEvent = yield* Deferred.await(runnerEventAcceptance);
            yield* acceptEvent(event);
            return [];
          }
          const eventId = event.turnId;
          handledEvents.add(eventId);
          const outputs: ApplicationPublicOutput[] = [];
          // Account for the surrounding JSON array. Validate and bound every
          // item before it can cross the Conversation application's public-output callback.
          let encodedOutputsBytes = 2;
          yield* options.application
            .handle(
              event,
              (output) =>
                Effect.gen(function* () {
                  const validatedOutput = yield* Schema.decodeUnknownEffect(
                    ConversationOutput,
                    { onExcessProperty: "error" }
                  )(output).pipe(Effect.mapError(invalidRuntimeOutput));
                  const encodedOutput = yield* canonicalActionInput(
                    validatedOutput
                  ).pipe(Effect.mapError(invalidRuntimeOutput));
                  const nextEncodedOutputsBytes =
                    encodedOutputsBytes +
                    (outputs.length === 0 ? 0 : 1) +
                    Buffer.byteLength(encodedOutput, "utf8");
                  if (nextEncodedOutputsBytes > RUNTIME_PAYLOAD_MAX_BYTES) {
                    return yield* invalidRuntimeOutput();
                  }
                  encodedOutputsBytes = nextEncodedOutputsBytes;
                  outputs.push(validatedOutput);
                  const publish = publishers.get(eventId);
                  if (publish !== undefined) {
                    yield* publish(validatedOutput);
                  }
                }),
              eventAcceptors.get(eventId) ?? unavailableEventAcceptance
            )
            .pipe(
              Effect.tapError((failure) =>
                Effect.sync(() => {
                  failures.set(eventId, failure);
                })
              )
            );
          return outputs;
        }),
    }
  ).pipe(Effect.mapError(runtimeFailure));

  return {
    ...(options.application.decideConversationRecovery === undefined
      ? {}
      : {
          decideConversationRecovery:
            options.application.decideConversationRecovery,
        }),
    handle: (event, publish, acceptEvent) => {
      if (event._tag !== "ParticipantInput") {
        return rememberRunnerEventAcceptance(acceptEvent).pipe(
          Effect.andThen(
            options.application.handle(event, publish, acceptEvent)
          )
        );
      }
      if (options.routeParticipantTurnsThroughDurableRuntime === false) {
        return options.application.handle(event, publish, acceptEvent);
      }
      return Effect.acquireUseRelease(
        Effect.gen(function* () {
          yield* rememberRunnerEventAcceptance(acceptEvent);
          yield* Effect.sync(() => {
            eventAcceptors.set(event.turnId, acceptEvent);
            failures.delete(event.turnId);
            handledEvents.delete(event.turnId);
            publishers.set(event.turnId, publish);
          });
        }),
        () =>
          runConversationRpcLocally(options.runtime, {
            event,
            protocolVersion: ROOT_RUNTIME_PROTOCOL_VERSION,
            rootIdentity: options.rootIdentity,
            workspaceId: options.workspaceId,
          }).pipe(
            Effect.catch((error) => {
              const failure = failures.get(event.turnId);
              return failure === undefined
                ? Effect.fail(runtimeFailure(error))
                : Effect.fail(failure);
            }),
            Effect.flatMap((receipt) =>
              handledEvents.has(event.turnId)
                ? Effect.void
                : Effect.forEach(receipt.outputs, publish, { discard: true })
            )
          ),
        () =>
          Effect.sync(() => {
            eventAcceptors.delete(event.turnId);
            failures.delete(event.turnId);
            handledEvents.delete(event.turnId);
            publishers.delete(event.turnId);
          })
      );
    },
    ...(options.application.recover === undefined
      ? {}
      : {
          recover: (acceptEvent: AcceptApplicationEvent) =>
            rememberRunnerEventAcceptance(acceptEvent).pipe(
              Effect.andThen(
                options.application.recover?.(acceptEvent) ?? Effect.void
              )
            ),
        }),
    ...(options.application.unresolvedConversationForOwner === undefined
      ? {}
      : {
          unresolvedConversationForOwner:
            options.application.unresolvedConversationForOwner,
        }),
    ...(options.application.unresolvedConversations === undefined
      ? {}
      : {
          unresolvedConversations: options.application.unresolvedConversations,
        }),
  } satisfies ApplicationShape;
});
