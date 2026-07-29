import {
  Deferred,
  Effect,
  Exit,
  FiberSet,
  Option,
  Ref,
  Schema,
  type Scope,
} from "effect";
import type {
  AcpPermissionInteraction,
  AcpPermissionInteractionResult,
} from "../acp-conversation-prototype/acp-permission-broker.ts";
import type { NormalizedInboundEvent } from "../prototype/domain.ts";
import type { SlackRuntimeIdentity } from "./config.ts";
import { SocketModeAdapterError } from "./errors.ts";
import { normalizeSlackEvent } from "./normalize.ts";
import type { WorkThreadActivityObservation } from "./work-thread-activity-projection.ts";

export interface SlackEventEnvelope {
  readonly ack: (response?: Readonly<Record<string, unknown>>) => Promise<void>;
  readonly body: unknown;
  readonly envelope_id?: string;
  readonly type?: string;
}

export type SlackEventListener = (envelope: SlackEventEnvelope) => void;

export interface SocketModeClientBoundary {
  readonly disconnect: () => Promise<void>;
  readonly off: (event: "slack_event", listener: SlackEventListener) => unknown;
  readonly on: (event: "slack_event", listener: SlackEventListener) => unknown;
  readonly start: () => Promise<unknown>;
}

export interface SlackEventInjector {
  readonly accept: (
    event: NormalizedInboundEvent
  ) => Effect.Effect<unknown, unknown, never>;
  readonly handleInteraction?: (
    interaction: AcpPermissionInteraction
  ) => Effect.Effect<AcpPermissionInteractionResult, unknown, never>;
  readonly health?: Effect.Effect<
    {
      readonly readiness: string;
    },
    unknown,
    never
  >;
  readonly inject: (
    event: NormalizedInboundEvent
  ) => Effect.Effect<unknown, unknown, never>;
  readonly quiesce?: Effect.Effect<void, unknown, never>;
  readonly workThreadActivity?: Effect.Effect<
    readonly WorkThreadActivityObservation[],
    unknown,
    never
  >;
}

export const SETUP_INCOMPLETE_REPLY =
  "Laborer setup is incomplete for this Slack workspace. Configure its local workspace binding, then restart the Laborer daemon.";

const MAX_IN_FLIGHT_EVENT_IDENTITIES = 1024;
const MAX_IN_FLIGHT_ACKNOWLEDGEMENTS_PER_EVENT = 64;
const INTERACTION_DURABLE_CLAIM_TIMEOUT_MILLIS = 750;

export interface SlackWorkspaceInstallation {
  readonly identity: SlackRuntimeIdentity;
  readonly namespaceWorkspace: boolean;
  readonly postSetupIncomplete?: (request: {
    readonly channelId: string;
    readonly rootTs: string;
    readonly text: string;
  }) => Effect.Effect<void, unknown, never>;
  readonly runner?: SlackEventInjector;
}

interface PendingWorkspaceRoute {
  readonly _tag: "Pending";
  readonly bindingIndex: number;
  readonly settlement: Deferred.Deferred<SettledWorkspaceRoute>;
  readonly teamId: string;
}

interface ReadyWorkspaceRoute {
  readonly _tag: "Ready";
  readonly bindingIndex: number;
  readonly installation: SlackWorkspaceInstallation;
}

interface UnavailableWorkspaceRoute {
  readonly _tag: "Unavailable";
  readonly bindingIndex: number;
  readonly installation?: SlackWorkspaceInstallation;
  readonly teamId: string;
}

interface UnknownWorkspaceRoute {
  readonly _tag: "Unknown";
  readonly teamId: string;
}

type SettledWorkspaceRoute = ReadyWorkspaceRoute | UnavailableWorkspaceRoute;

export type SlackWorkspaceRoute =
  | PendingWorkspaceRoute
  | SettledWorkspaceRoute
  | UnknownWorkspaceRoute;

export interface SlackWorkspaceRouteDirectory {
  readonly awaitAvailable: (
    teamId: string
  ) => Effect.Effect<SlackWorkspaceInstallation>;
  readonly awaitReady: (
    teamId: string
  ) => Effect.Effect<SlackWorkspaceInstallation>;
  readonly registerPending: (
    bindingIndex: number,
    teamId: string
  ) => Effect.Effect<void>;
  readonly resolve: (teamId: string) => Effect.Effect<SlackWorkspaceRoute>;
  readonly settleReady: (
    bindingIndex: number,
    installation: SlackWorkspaceInstallation
  ) => Effect.Effect<void>;
  readonly settleUnavailable: (
    bindingIndex: number,
    teamId: string,
    installation?: SlackWorkspaceInstallation
  ) => Effect.Effect<void>;
  readonly snapshot: Effect.Effect<readonly SlackWorkspaceInstallation[]>;
  readonly workspaceIds: Effect.Effect<readonly string[]>;
}

interface RouteDirectoryState {
  readonly routes: ReadonlyMap<
    string,
    Exclude<SlackWorkspaceRoute, UnknownWorkspaceRoute>
  >;
  readonly settlementWaiters: ReadonlyMap<
    string,
    readonly Deferred.Deferred<SettledWorkspaceRoute>[]
  >;
}

export const makeSlackWorkspaceRouteDirectory: Effect.Effect<SlackWorkspaceRouteDirectory> =
  Effect.gen(function* () {
    const state = yield* Ref.make<RouteDirectoryState>({
      routes: new Map(),
      settlementWaiters: new Map(),
    });
    const resolve = (teamId: string): Effect.Effect<SlackWorkspaceRoute> =>
      Ref.get(state).pipe(
        Effect.map(
          (current) =>
            current.routes.get(teamId) ?? {
              _tag: "Unknown" as const,
              teamId,
            }
        )
      );
    const awaitSettlement = (
      teamId: string
    ): Effect.Effect<SettledWorkspaceRoute> =>
      Effect.gen(function* () {
        const waiter = yield* Deferred.make<SettledWorkspaceRoute>();
        const settlement = yield* Ref.modify(state, (current) => {
          const route = current.routes.get(teamId);
          if (route?._tag === "Pending") {
            return [Deferred.await(route.settlement), current] as const;
          }
          if (route !== undefined) {
            return [Effect.succeed(route), current] as const;
          }
          const settlementWaiters = new Map(current.settlementWaiters);
          settlementWaiters.set(teamId, [
            ...(settlementWaiters.get(teamId) ?? []),
            waiter,
          ]);
          return [
            Deferred.await(waiter),
            { ...current, settlementWaiters },
          ] as const;
        });
        return yield* settlement;
      });
    const settle = (
      teamId: string,
      route: SettledWorkspaceRoute
    ): Effect.Effect<void> =>
      Ref.modify(
        state,
        (
          current
        ): readonly [
          readonly Deferred.Deferred<SettledWorkspaceRoute>[],
          RouteDirectoryState,
        ] => {
          const existing = current.routes.get(teamId);
          if (
            existing !== undefined &&
            existing.bindingIndex < route.bindingIndex
          ) {
            return [[], current] as const;
          }
          const routes = new Map(current.routes);
          routes.set(teamId, route);
          const settlementWaiters = new Map(current.settlementWaiters);
          const waiters = [
            ...(existing?._tag === "Pending" ? [existing.settlement] : []),
            ...(settlementWaiters.get(teamId) ?? []),
          ];
          settlementWaiters.delete(teamId);
          return [waiters, { routes, settlementWaiters }];
        }
      ).pipe(
        Effect.flatMap((waiters) =>
          Effect.forEach(waiters, (waiter) => Deferred.succeed(waiter, route), {
            discard: true,
          })
        )
      );
    return {
      awaitAvailable: (teamId) =>
        awaitSettlement(teamId).pipe(
          Effect.flatMap((route) =>
            route.installation === undefined
              ? Effect.never
              : Effect.succeed(route.installation)
          )
        ),
      awaitReady: (teamId) =>
        awaitSettlement(teamId).pipe(
          Effect.flatMap((route) =>
            route._tag === "Ready"
              ? Effect.succeed(route.installation)
              : Effect.never
          )
        ),
      registerPending: (bindingIndex, teamId) =>
        Effect.gen(function* () {
          const settlement = yield* Deferred.make<SettledWorkspaceRoute>();
          yield* Ref.update(state, (current) => {
            const existing = current.routes.get(teamId);
            if (
              existing !== undefined &&
              existing.bindingIndex <= bindingIndex
            ) {
              return current;
            }
            const routes = new Map(current.routes);
            routes.set(teamId, {
              _tag: "Pending",
              bindingIndex,
              settlement,
              teamId,
            });
            return { ...current, routes };
          });
        }),
      resolve,
      settleReady: (bindingIndex, installation) =>
        settle(installation.identity.teamId, {
          _tag: "Ready",
          bindingIndex,
          installation,
        }),
      settleUnavailable: (bindingIndex, teamId, installation) =>
        settle(teamId, {
          _tag: "Unavailable",
          bindingIndex,
          ...(installation === undefined ? {} : { installation }),
          teamId,
        }),
      snapshot: Ref.get(state).pipe(
        Effect.map((current) =>
          [...current.routes.values()]
            .sort((left, right) => left.bindingIndex - right.bindingIndex)
            .flatMap((route) =>
              route._tag !== "Pending" && route.installation !== undefined
                ? [route.installation]
                : []
            )
        )
      ),
      workspaceIds: Ref.get(state).pipe(
        Effect.map((current) =>
          [...current.routes.entries()]
            .sort(
              ([, left], [, right]) => left.bindingIndex - right.bindingIndex
            )
            .map(([teamId]) => teamId)
        )
      ),
    };
  });

const SlackAuthorization = Schema.Struct({
  enterprise_id: Schema.optional(Schema.NullOr(Schema.String)),
  is_enterprise_install: Schema.optional(Schema.Boolean),
  team_id: Schema.optional(Schema.String),
});

const SlackRoutingMetadata = Schema.Struct({
  authorizations: Schema.optional(Schema.Array(SlackAuthorization)),
  context_enterprise_id: Schema.optional(Schema.NullOr(Schema.String)),
  context_team_id: Schema.optional(Schema.String),
  enterprise_id: Schema.optional(Schema.NullOr(Schema.String)),
  event: Schema.Struct({
    is_ext_shared_channel: Schema.optional(Schema.Boolean),
  }),
  event_id: Schema.String,
  team_id: Schema.String,
  type: Schema.Literal("event_callback"),
});

const SlackBlockActionPayload = Schema.Struct({
  actions: Schema.Array(
    Schema.Struct({
      action_id: Schema.String,
      value: Schema.String,
    })
  ),
  channel: Schema.Struct({ id: Schema.String }),
  container: Schema.Struct({
    channel_id: Schema.optional(Schema.String),
    message_ts: Schema.String,
    thread_ts: Schema.optional(Schema.String),
  }),
  message: Schema.Struct({
    thread_ts: Schema.optional(Schema.String),
    ts: Schema.String,
  }),
  team: Schema.Struct({ id: Schema.String }),
  type: Schema.Literal("block_actions"),
  user: Schema.Struct({ id: Schema.String }),
});

const adapterFailure = (operation: string): SocketModeAdapterError =>
  SocketModeAdapterError.make({ operation, reason: "socket-mode-failed" });

type SlackAcknowledge = SlackEventEnvelope["ack"];

interface AcknowledgementTicket {
  readonly acknowledge: SlackAcknowledge;
  readonly id: number;
}

interface InFlightEnvelopeEntry {
  readonly acknowledgements: ReadonlyMap<number, AcknowledgementTicket>;
  readonly nextAcknowledgementId: number;
  readonly processingTerminal: boolean;
}

type EnvelopeSubmission =
  | { readonly _tag: "Acknowledge"; readonly ticket: AcknowledgementTicket }
  | { readonly _tag: "Joined" }
  | { readonly _tag: "Owner" }
  | { readonly _tag: "Rejected" };

interface InFlightEnvelopeCoalescer {
  readonly completeProcessing: (
    identity: EnvelopeIdentity,
    policy: "Acknowledge" | "LeaveUnacknowledged"
  ) => Effect.Effect<readonly AcknowledgementTicket[]>;
  readonly settle: (
    identity: EnvelopeIdentity,
    ticketId: number
  ) => Effect.Effect<void>;
  readonly submit: (
    identity: EnvelopeIdentity,
    acknowledge: SlackAcknowledge
  ) => Effect.Effect<EnvelopeSubmission>;
}

const UNKNOWN_INGRESS_PARTITION = Symbol("unknown-slack-ingress");
type IngressPartition = string | typeof UNKNOWN_INGRESS_PARTITION;
type InFlightEnvelopeState = ReadonlyMap<
  IngressPartition,
  ReadonlyMap<string, InFlightEnvelopeEntry>
>;

const updateEnvelopeEntry = (
  state: InFlightEnvelopeState,
  identity: EnvelopeIdentity,
  entry: InFlightEnvelopeEntry | null
): InFlightEnvelopeState => {
  const workspaceEntries = new Map(state.get(identity.partition) ?? []);
  if (entry === null) {
    workspaceEntries.delete(identity.eventId);
  } else {
    workspaceEntries.set(identity.eventId, entry);
  }
  const updated = new Map(state);
  updated.set(identity.partition, workspaceEntries);
  return updated;
};

const attachAcknowledgement = (
  state: InFlightEnvelopeState,
  identity: EnvelopeIdentity,
  existing: InFlightEnvelopeEntry,
  acknowledge: SlackAcknowledge
): readonly [EnvelopeSubmission, InFlightEnvelopeState] => {
  if (
    existing.acknowledgements.size >= MAX_IN_FLIGHT_ACKNOWLEDGEMENTS_PER_EVENT
  ) {
    return [{ _tag: "Rejected" }, state];
  }
  const ticket = {
    acknowledge,
    id: existing.nextAcknowledgementId,
  };
  const acknowledgements = new Map(existing.acknowledgements);
  acknowledgements.set(ticket.id, ticket);
  const updated = updateEnvelopeEntry(state, identity, {
    ...existing,
    acknowledgements,
    nextAcknowledgementId: ticket.id + 1,
  });
  return [
    existing.processingTerminal
      ? { _tag: "Acknowledge", ticket }
      : { _tag: "Joined" },
    updated,
  ];
};

const makeInFlightEnvelopeCoalescer = (
  workspaceIds: readonly string[]
): Effect.Effect<InFlightEnvelopeCoalescer> =>
  Effect.gen(function* () {
    const partitions: readonly IngressPartition[] = [
      UNKNOWN_INGRESS_PARTITION,
      ...workspaceIds,
    ];
    const state = yield* Ref.make<InFlightEnvelopeState>(
      new Map(
        partitions.map(
          (partition) =>
            [partition, new Map<string, InFlightEnvelopeEntry>()] as const
        )
      )
    );
    return {
      completeProcessing: (identity, policy) =>
        Ref.modify(state, (current) => {
          const existing = current
            .get(identity.partition)
            ?.get(identity.eventId);
          if (existing === undefined) {
            return [[], current] as const;
          }
          if (policy === "LeaveUnacknowledged") {
            return [[], updateEnvelopeEntry(current, identity, null)] as const;
          }
          const terminal = { ...existing, processingTerminal: true };
          return [
            [...terminal.acknowledgements.values()],
            updateEnvelopeEntry(current, identity, terminal),
          ] as const;
        }),
      settle: (identity, ticketId) =>
        Ref.update(state, (current) => {
          const existing = current
            .get(identity.partition)
            ?.get(identity.eventId);
          if (existing === undefined) {
            return current;
          }
          const acknowledgements = new Map(existing.acknowledgements);
          acknowledgements.delete(ticketId);
          return updateEnvelopeEntry(
            current,
            identity,
            existing.processingTerminal && acknowledgements.size === 0
              ? null
              : { ...existing, acknowledgements }
          );
        }),
      submit: (identity, acknowledge) =>
        Ref.modify(
          state,
          (current): readonly [EnvelopeSubmission, InFlightEnvelopeState] => {
            const workspaceEntries = current.get(identity.partition);
            if (workspaceEntries === undefined) {
              return [{ _tag: "Rejected" } as const, current] as const;
            }
            const existing = workspaceEntries.get(identity.eventId);
            if (existing !== undefined) {
              return attachAcknowledgement(
                current,
                identity,
                existing,
                acknowledge
              );
            }
            if (workspaceEntries.size >= MAX_IN_FLIGHT_EVENT_IDENTITIES) {
              return [{ _tag: "Rejected" } as const, current] as const;
            }
            const ticket = { acknowledge, id: 0 };
            return [
              { _tag: "Owner" } as const,
              updateEnvelopeEntry(current, identity, {
                acknowledgements: new Map([[ticket.id, ticket]]),
                nextAcknowledgementId: 1,
                processingTerminal: false,
              }),
            ] as const;
          }
        ),
    };
  });

const processForInstallation = (
  body: unknown,
  installation: SlackWorkspaceInstallation
): Effect.Effect<void, unknown> =>
  normalizeSlackEvent(body, installation.identity, {
    namespaceWorkspace: installation.namespaceWorkspace,
  }).pipe(
    Effect.flatMap((event) => {
      if (event === null) {
        return Effect.void;
      }
      if (installation.runner !== undefined) {
        return installation.runner.accept(event).pipe(Effect.asVoid);
      }
      const isSetupRequest =
        event.authorKind !== "laborer" &&
        event.channelKind !== "direct" &&
        event.recordKind === "message" &&
        event.text?.trim().length !== 0 &&
        event.text?.includes(`<@${installation.identity.botUserId}>`) === true;
      if (!isSetupRequest || installation.postSetupIncomplete === undefined) {
        return Effect.void;
      }
      return installation.postSetupIncomplete({
        channelId: event.channelId,
        rootTs: event.threadTs ?? event.messageTs,
        text: SETUP_INCOMPLETE_REPLY,
      });
    })
  );

const processForRoute = (
  body: unknown,
  route: SettledWorkspaceRoute | UnknownWorkspaceRoute
): Effect.Effect<void, unknown> => {
  switch (route._tag) {
    case "Ready":
      return processForInstallation(body, route.installation);
    case "Unavailable":
      return route.installation === undefined
        ? Effect.logWarning(
            "Slack event belongs to a terminally unavailable workspace installation"
          )
        : processForInstallation(body, route.installation);
    case "Unknown":
      return Effect.logWarning(
        "Slack event has no configured local workspace installation"
      );
    default:
      return Effect.void;
  }
};

const isOrdinaryWorkspaceEvent = (
  metadata: typeof SlackRoutingMetadata.Type
): boolean => {
  const authorizations = metadata.authorizations;
  if (
    metadata.enterprise_id != null ||
    metadata.context_enterprise_id != null ||
    metadata.event.is_ext_shared_channel === true ||
    (metadata.context_team_id !== undefined &&
      metadata.context_team_id !== metadata.team_id)
  ) {
    return false;
  }
  if (authorizations === undefined) {
    return true;
  }
  const authorization = authorizations[0];
  return (
    authorizations.length === 1 &&
    authorization !== undefined &&
    authorization.enterprise_id == null &&
    authorization.is_enterprise_install !== true &&
    authorization.team_id === metadata.team_id
  );
};

const acknowledge = (ack: SlackAcknowledge): Effect.Effect<void, unknown> =>
  Effect.tryPromise({
    try: () => ack(),
    catch: () => adapterFailure("ack"),
  });

const acknowledgeTicket = (
  coalescer: InFlightEnvelopeCoalescer,
  identity: EnvelopeIdentity,
  ticket: AcknowledgementTicket
): Effect.Effect<void> =>
  acknowledge(ticket.acknowledge).pipe(
    Effect.catch((error) =>
      Effect.logError("Slack envelope acknowledgement failed", error)
    ),
    Effect.ensuring(coalescer.settle(identity, ticket.id))
  );

interface EnvelopeIdentity {
  readonly eventId: string;
  readonly partition: IngressPartition;
}

interface SlackEnvelopeIdentity {
  readonly eventId: string;
  readonly teamId: string;
}

const slackEnvelopeIdentity = (body: unknown): SlackEnvelopeIdentity | null => {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const teamId = "team_id" in body ? body.team_id : null;
  const eventId = "event_id" in body ? body.event_id : null;
  return typeof teamId === "string" && typeof eventId === "string"
    ? { eventId, teamId }
    : null;
};

const makeEnvelopeIdentityClassifier = (
  configuredWorkspaces: ReadonlySet<string>
): ((body: unknown) => EnvelopeIdentity) => {
  let anonymousIdentity = 0;
  return (body) => {
    const metadata = Schema.decodeUnknownOption(SlackRoutingMetadata)(body);
    if (
      Option.isSome(metadata) &&
      isOrdinaryWorkspaceEvent(metadata.value) &&
      configuredWorkspaces.has(metadata.value.team_id)
    ) {
      return {
        eventId: metadata.value.event_id,
        partition: metadata.value.team_id,
      };
    }
    const slackIdentity = slackEnvelopeIdentity(body);
    if (slackIdentity !== null) {
      return {
        eventId: JSON.stringify([slackIdentity.teamId, slackIdentity.eventId]),
        partition: UNKNOWN_INGRESS_PARTITION,
      };
    }
    const eventId = `anonymous:${anonymousIdentity}`;
    anonymousIdentity += 1;
    return { eventId, partition: UNKNOWN_INGRESS_PARTITION };
  };
};

const processEnvelope = (
  envelope: SlackEventEnvelope,
  resolve: SlackWorkspaceRouteDirectory["resolve"],
  coalescer: InFlightEnvelopeCoalescer,
  identity: EnvelopeIdentity
): Effect.Effect<void> =>
  Schema.decodeUnknownEffect(SlackRoutingMetadata)(envelope.body).pipe(
    Effect.flatMap((metadata) => {
      if (!isOrdinaryWorkspaceEvent(metadata)) {
        return Effect.logWarning(
          "Slack event quarantined because its workspace authorization is ambiguous"
        );
      }
      return resolve(metadata.team_id).pipe(
        Effect.flatMap((route) =>
          route._tag === "Pending"
            ? Deferred.await(route.settlement).pipe(
                Effect.flatMap((settled) =>
                  processForRoute(envelope.body, settled)
                )
              )
            : processForRoute(envelope.body, route)
        )
      );
    }),
    Effect.onExit((exit) =>
      exit._tag === "Failure"
        ? coalescer
            .completeProcessing(identity, "LeaveUnacknowledged")
            .pipe(Effect.asVoid)
        : Effect.void
    ),
    Effect.exit,
    Effect.flatMap((exit) =>
      exit._tag === "Failure"
        ? Effect.logError("Slack event processing stopped safely")
        : coalescer
            .completeProcessing(identity, "Acknowledge")
            .pipe(
              Effect.flatMap((tickets) =>
                Effect.forEach(
                  tickets,
                  (ticket) => acknowledgeTicket(coalescer, identity, ticket),
                  { concurrency: "unbounded", discard: true }
                )
              )
            )
    )
  );

const decodePermissionInteraction = (
  envelope: SlackEventEnvelope
): AcpPermissionInteraction | null => {
  if (
    envelope.type !== "interactive" ||
    typeof envelope.envelope_id !== "string" ||
    envelope.envelope_id.length === 0
  ) {
    return null;
  }
  const decoded = Schema.decodeUnknownOption(SlackBlockActionPayload)(
    envelope.body
  );
  if (Option.isNone(decoded)) {
    return null;
  }
  const action = decoded.value.actions[0];
  const rootTs =
    decoded.value.container.thread_ts ?? decoded.value.message.thread_ts;
  const containerChannel = decoded.value.container.channel_id;
  if (
    action === undefined ||
    decoded.value.actions.length !== 1 ||
    rootTs === undefined ||
    decoded.value.message.ts !== decoded.value.container.message_ts ||
    (containerChannel !== undefined &&
      containerChannel !== decoded.value.channel.id)
  ) {
    return null;
  }
  return {
    actionId: action.action_id,
    capability: action.value,
    channelId: decoded.value.channel.id,
    messageTs: decoded.value.message.ts,
    rootTs,
    slackUserId: decoded.value.user.id,
    workspaceId: decoded.value.team.id,
  };
};

const processInteractiveEnvelope = (
  envelope: SlackEventEnvelope,
  resolve: SlackWorkspaceRouteDirectory["resolve"]
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const interaction = decodePermissionInteraction(envelope);
    if (interaction === null) {
      yield* acknowledge(envelope.ack).pipe(Effect.catch(() => Effect.void));
      return;
    }
    const route = yield* resolve(interaction.workspaceId);
    if (
      route._tag === "Ready" &&
      route.installation.runner?.handleInteraction !== undefined
    ) {
      const claim = yield* Effect.raceFirst(
        Effect.exit(
          route.installation.runner.handleInteraction(interaction)
        ).pipe(Effect.map((exit) => ({ _tag: "Finished" as const, exit }))),
        Effect.sleep(`${INTERACTION_DURABLE_CLAIM_TIMEOUT_MILLIS} millis`).pipe(
          Effect.as({ _tag: "TimedOut" as const })
        )
      );
      if (claim._tag === "Finished" && claim.exit._tag === "Failure") {
        yield* Effect.logWarning("Slack interaction claim stopped safely");
        return;
      }
      if (
        claim._tag === "TimedOut" ||
        (claim._tag === "Finished" &&
          Exit.isSuccess(claim.exit) &&
          claim.exit.value === "retry")
      ) {
        yield* Effect.logWarning(
          "Slack interaction claim could not be durably reconciled; leaving it unacknowledged for retry"
        );
        return;
      }
    }
    yield* acknowledge(envelope.ack).pipe(Effect.catch(() => Effect.void));
  });

type SocketModeAdapterOptions =
  | {
      readonly client: SocketModeClientBoundary;
      readonly identity: SlackRuntimeIdentity;
      readonly runner: SlackEventInjector;
    }
  | {
      readonly client: SocketModeClientBoundary;
      readonly installations: readonly SlackWorkspaceInstallation[];
    }
  | {
      readonly client: SocketModeClientBoundary;
      readonly routeDirectory: SlackWorkspaceRouteDirectory;
    };

export const startSocketModeAdapter = (
  options: SocketModeAdapterOptions
): Effect.Effect<void, SocketModeAdapterError, Scope.Scope> =>
  Effect.gen(function* () {
    const resolve: SlackWorkspaceRouteDirectory["resolve"] =
      "routeDirectory" in options
        ? options.routeDirectory.resolve
        : (teamId) => {
            const installations =
              "installations" in options
                ? options.installations
                : [
                    {
                      identity: options.identity,
                      namespaceWorkspace: false,
                      runner: options.runner,
                    },
                  ];
            const installation = installations.find(
              (candidate) => candidate.identity.teamId === teamId
            );
            return Effect.succeed<SlackWorkspaceRoute>(
              installation === undefined
                ? { _tag: "Unknown", teamId }
                : {
                    _tag: "Ready",
                    bindingIndex: 0,
                    installation,
                  }
            );
          };
    const fibers = yield* FiberSet.make<void, never>();
    const workspaceIds = yield* Effect.gen(function* () {
      if ("routeDirectory" in options) {
        return yield* options.routeDirectory.workspaceIds;
      }
      if ("installations" in options) {
        return options.installations.map(
          (installation) => installation.identity.teamId
        );
      }
      return [options.identity.teamId];
    });
    const configuredWorkspaces = new Set(workspaceIds);
    const classifyEnvelopeIdentity =
      makeEnvelopeIdentityClassifier(configuredWorkspaces);
    const coalescer = yield* makeInFlightEnvelopeCoalescer(workspaceIds);
    const runEnvelope = yield* FiberSet.runtime(fibers)();
    const listener: SlackEventListener = (envelope) => {
      if (envelope.type === "interactive") {
        runEnvelope(processInteractiveEnvelope(envelope, resolve));
        return;
      }
      const identity = classifyEnvelopeIdentity(envelope.body);
      runEnvelope(
        coalescer.submit(identity, envelope.ack).pipe(
          Effect.flatMap((submission) => {
            switch (submission._tag) {
              case "Acknowledge":
                return acknowledgeTicket(
                  coalescer,
                  identity,
                  submission.ticket
                );
              case "Owner":
                return processEnvelope(envelope, resolve, coalescer, identity);
              case "Rejected":
                return Effect.logWarning(
                  "Slack in-flight event coalescer is at capacity; leaving envelope unacknowledged"
                );
              case "Joined":
                return Effect.void;
              default:
                return Effect.void;
            }
          })
        )
      );
    };
    yield* Effect.acquireRelease(
      Effect.sync(() => options.client.on("slack_event", listener)),
      () =>
        Effect.sync(() => options.client.off("slack_event", listener)).pipe(
          Effect.asVoid
        )
    );
    yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => options.client.start(),
        catch: () => adapterFailure("start"),
      }),
      () =>
        Effect.tryPromise({
          try: () => options.client.disconnect(),
          catch: () => adapterFailure("disconnect"),
        }).pipe(Effect.orDie)
    );
  });
