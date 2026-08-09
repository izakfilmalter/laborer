import { Effect, Schema, type Scope } from "effect";
import type { ApplicationShape } from "../application.ts";
import type { HandlerFailure, StoreError } from "../core/errors.ts";
import { applicationThroughRootConversationRuntime } from "../durable-runtime/conversation-application.ts";
import { conversationCapabilitiesForRootRuntime } from "../durable-runtime/reference-coding-application.ts";
import type { RootDurableRuntimeShape } from "../durable-runtime/root-runtime.ts";
import { productionGeneratedMutationCatalog } from "../generated-mutation-catalog.ts";
import type { ConversationAgentShape } from "../reference-coding-application.ts";
import type { SlackRuntimePaths } from "../slack/runtime-paths.ts";
import {
  makeReferenceCodingWorkspaceApplicationWithConversationAgent,
  type ReferenceCodingWorkspaceApplicationDependencies,
} from "../slack/workspace-application.ts";
import {
  type AcpAuthorityRepository,
  makeAcpAuthorityRepository,
} from "./acp-authority.ts";
import { preflightReservedMcpNames } from "./acp-config-source-inventory.ts";
import {
  type AcpConversationAgentOptions,
  type AcpConversationProcessHealth,
  makeAcpConversationAgent,
} from "./acp-conversation-agent.ts";
import {
  type AcpPermissionBroker,
  type AcpPermissionPresenter,
  makeAcpPermissionBroker,
} from "./acp-permission-broker.ts";
import { makeAcpProcessStateRepository } from "./acp-process-state.ts";
import {
  type AcpProcessSupervisorTestHooks,
  type AcpWorkspaceSupervisorHealthSnapshot,
  makeAcpConversationProcessSupervisor,
} from "./acp-process-supervisor.ts";
import {
  laborerActionMcpServerName,
  makeLaborerActionMcpBridge,
} from "./action-mcp.ts";
import { prepareAcpAgentContextSources } from "./agent-context.ts";
import { environmentForAcpConversation } from "./child-environment.ts";
import {
  laborerMemoryOpenCodePermission,
  makeLaborerMemoryMcpServerConfiguration,
} from "./memory-mcp.ts";
import {
  OPEN_CODE_COMMAND,
  openCodeAcpProcessOptions,
} from "./open-code-acp-process.ts";
import { preflightEffectiveOpenCodeMcpNames } from "./opencode-config-preflight.ts";
import type { SlackParticipantLookupShape } from "./slack-participant-lookup.ts";

export class AcpWorkspaceStartupError extends Schema.TaggedErrorClass<AcpWorkspaceStartupError>()(
  "AcpWorkspaceStartupError",
  {
    reason: Schema.Literals([
      "acp-child-incompatible-or-unavailable",
      "acp-composition-incompatible",
    ]),
    workspaceId: Schema.String,
  }
) {}

export interface AcpWorkspaceHealth
  extends AcpWorkspaceSupervisorHealthSnapshot {
  readonly status: AcpConversationProcessHealth["status"];
  readonly workspaceId: string;
}

const supervisorHealthForProcessStatus = (
  status: AcpConversationProcessHealth["status"]
): AcpWorkspaceHealth["health"] => {
  if (status === "ready") {
    return "ready";
  }
  if (status === "starting") {
    return "starting";
  }
  return status === "quarantined" ? "quarantined" : "stopped";
};

const processStatusForSupervisorHealth = (
  health: AcpWorkspaceSupervisorHealthSnapshot["health"]
): AcpConversationProcessHealth["status"] => {
  if (health === "ready") {
    return "ready";
  }
  if (health === "quarantined" || health === "circuit_open") {
    return "quarantined";
  }
  if (health === "stopped" || health === "draining") {
    return "closed";
  }
  return "starting";
};

export interface ProductionAcpWorkspaceApplicationOptions {
  readonly applicationConfig: import("../slack/laborer-config.ts").ReferenceCodingApplicationConfig;
  readonly environment: NodeJS.ProcessEnv;
  readonly laborerSlackId: string;
  readonly paths: SlackRuntimePaths;
  readonly root: string;
  readonly rootRuntime?: RootDurableRuntimeShape;
  readonly workspaceId: string;
}

type ProductionProcessOverrides = Partial<
  Omit<
    AcpConversationAgentOptions,
    | "agentContext"
    | "actionMcpBridge"
    | "cwd"
    | "durableSessionMode"
    | "environment"
    | "laborerSlackId"
    | "memoryMcpServer"
    | "participantLookup"
    | "processGeneration"
    | "processCleanupObserver"
    | "processExitObserver"
    | "processFailureObserver"
    | "processHealthObserver"
    | "requireDurableCapabilitiesAtStartup"
  >
>;

export interface ProductionAcpWorkspaceApplicationDependencies
  extends ReferenceCodingWorkspaceApplicationDependencies {
  readonly environment?: NodeJS.ProcessEnv;
  readonly makeAuthorityRepository?: (
    options: ProductionAcpWorkspaceApplicationOptions
  ) => Effect.Effect<AcpAuthorityRepository, HandlerFailure>;
  readonly makeConversationAgent?: (
    options: AcpConversationAgentOptions
  ) => Effect.Effect<ConversationAgentShape, HandlerFailure, Scope.Scope>;
  readonly observeHealth?: (health: AcpWorkspaceHealth) => void;
  readonly observePermissionBroker?: (broker: AcpPermissionBroker) => void;
  readonly participantLookup?: SlackParticipantLookupShape;
  readonly permissionBrokerTestHooks?: {
    readonly afterTerminalPublishBeforeLiveCompletion?: () => Effect.Effect<void>;
  };
  /** Chat-owned, best-effort permission presentation. Supplying this disables
   * the legacy durable Slack permission UI outbox. */
  readonly permissionPresenter?: AcpPermissionPresenter;
  readonly permissionTimeoutMillis?: number;
  readonly process?: ProductionProcessOverrides;
  readonly processSupervisorTestHooks?: AcpProcessSupervisorTestHooks;
  readonly publishExternalOutput?: (
    conversationId: string,
    output: import("../application.ts").ApplicationPublicOutput
  ) => Effect.Effect<void, HandlerFailure | StoreError>;
}

export interface ProductionAcpWorkspaceApplication {
  readonly application: ApplicationShape;
  readonly health: Effect.Effect<AcpWorkspaceHealth>;
  readonly permissionBroker: AcpPermissionBroker;
}

export const makeProductionAcpWorkspaceApplication = Effect.fn(
  "makeProductionAcpWorkspaceApplication"
)(function* (
  options: ProductionAcpWorkspaceApplicationOptions,
  dependencies: ProductionAcpWorkspaceApplicationDependencies = {}
): Effect.fn.Return<
  ProductionAcpWorkspaceApplication,
  AcpWorkspaceStartupError | HandlerFailure,
  Scope.Scope
> {
  let currentHealth: AcpWorkspaceHealth = {
    activePrompts: 0,
    activeSessions: 0,
    circuitCooldownMillis: 5 * 60 * 1000,
    circuitOpenedAt: null,
    generation: null,
    health: "starting",
    lastStop: null,
    queuedConversations: 0,
    readySince: null,
    restartEpisodeStartedAt: null,
    status: "starting",
    workspaceId: options.workspaceId,
  };
  const observePreflightQuarantine = (): void => {
    currentHealth = {
      ...currentHealth,
      generation: null,
      health: "quarantined",
      status: "quarantined",
    };
    dependencies.observeHealth?.(currentHealth);
  };
  const observeHealth = (health: AcpConversationProcessHealth): void => {
    if (currentHealth.status === health.status) {
      currentHealth = { ...currentHealth, generation: health.generation };
      return;
    }
    currentHealth = {
      ...currentHealth,
      generation: health.generation,
      health: supervisorHealthForProcessStatus(health.status),
      status: health.status,
      workspaceId: options.workspaceId,
    };
    dependencies.observeHealth?.(currentHealth);
  };
  dependencies.observeHealth?.(currentHealth);

  const agentContext = yield* prepareAcpAgentContextSources({
    root: options.root,
    workspaceId: options.workspaceId,
  });
  const childEnvironment = environmentForAcpConversation(
    options.environment,
    options.applicationConfig.environment
  );
  const baseProcess = openCodeAcpProcessOptions({
    ...(dependencies.process?.command === undefined
      ? {}
      : { command: dependencies.process.command }),
    cwd: options.root,
    environment: childEnvironment,
  });
  const memoryMcpServer = makeLaborerMemoryMcpServerConfiguration(agentContext);
  const actionMcpServerName = laborerActionMcpServerName(
    options.root,
    options.workspaceId
  );
  const reservedMcpNames = [
    memoryMcpServer.name,
    laborerMemoryOpenCodePermission(memoryMcpServer.name),
    actionMcpServerName,
    ...productionGeneratedMutationCatalog.tools.map(
      (tool) => `${actionMcpServerName}_${tool.name}`
    ),
  ];
  yield* preflightReservedMcpNames({
    environment: childEnvironment,
    names: reservedMcpNames,
    projectRoot: options.root,
  }).pipe(
    Effect.mapError(() =>
      AcpWorkspaceStartupError.make({
        reason: "acp-child-incompatible-or-unavailable",
        workspaceId: options.workspaceId,
      })
    ),
    Effect.tapError(() => Effect.sync(observePreflightQuarantine))
  );
  yield* preflightEffectiveOpenCodeMcpNames({
    command: dependencies.process?.command ?? OPEN_CODE_COMMAND,
    cwd: options.root,
    environment: childEnvironment,
    reservedNames: reservedMcpNames,
  }).pipe(
    Effect.mapError(() =>
      AcpWorkspaceStartupError.make({
        reason: "acp-child-incompatible-or-unavailable",
        workspaceId: options.workspaceId,
      })
    ),
    Effect.tapError(() => Effect.sync(observePreflightQuarantine))
  );
  const authorityRepository = yield* dependencies.makeAuthorityRepository ===
  undefined
    ? makeAcpAuthorityRepository({
        keyPath: options.paths.acpAuthorityKey,
        statePath: options.paths.acpAuthorityState,
        trustedRoot: options.paths.root,
      })
    : dependencies.makeAuthorityRepository(options);
  const permissionPresenter = dependencies.permissionPresenter;
  if (permissionPresenter === undefined) {
    return yield* AcpWorkspaceStartupError.make({
      reason: "acp-composition-incompatible",
      workspaceId: options.workspaceId,
    });
  }
  const permissionBroker = yield* makeAcpPermissionBroker({
    presenter: permissionPresenter,
    repository: authorityRepository,
    ...(dependencies.permissionBrokerTestHooks === undefined
      ? {}
      : { testHooks: dependencies.permissionBrokerTestHooks }),
    ...(dependencies.permissionTimeoutMillis === undefined
      ? {}
      : { timeoutMillis: dependencies.permissionTimeoutMillis }),
  });
  dependencies.observePermissionBroker?.(permissionBroker);
  const makeConversationAgent =
    dependencies.makeConversationAgent ?? makeAcpConversationAgent;
  const processStateRepository = yield* makeAcpProcessStateRepository({
    path: options.paths.acpProcessState,
    trustedRoot: options.paths.root,
  }).pipe(
    Effect.mapError(() =>
      AcpWorkspaceStartupError.make({
        reason: "acp-child-incompatible-or-unavailable",
        workspaceId: options.workspaceId,
      })
    )
  );
  const supervisor = yield* makeAcpConversationProcessSupervisor({
    makeGeneration: (generationContext) =>
      Effect.gen(function* () {
        const actionMcpBridge = yield* makeLaborerActionMcpBridge({
          // The two reference coding Actions retain their established facade;
          // every user catalog outside that exact compatibility pair is
          // projected directly from its validated registrations.
          ...(options.rootRuntime === undefined ||
          options.rootRuntime.actions.actions.length === 0 ||
          (options.rootRuntime.actions.actions.length === 2 &&
            options.rootRuntime.actions.actions.every(
              ({ name, revision }) =>
                (name === "create-feature" || name === "deal-with-bug") &&
                revision === `reference-coding/${name}/cluster-v1`
            ))
            ? {}
            : { actionCatalog: options.rootRuntime.actions }),
          authorityRepository,
          bootstrapPath: options.paths.acpActionBootstrap,
          processGeneration: generationContext.generation,
          root: options.root,
          rootAuthority: `${agentContext.root}:${agentContext.rootDirectoryIdentity.device}:${agentContext.rootDirectoryIdentity.inode}`,
          statePath: options.paths.acpActionAuthorityState,
          trustedRuntimeRoot: options.paths.root,
          workspaceId: options.workspaceId,
        });
        return yield* makeConversationAgent({
          ...baseProcess,
          ...dependencies.process,
          actionMcpBridge,
          agentContext,
          authorityRepository,
          cwd: options.root,
          durableSessionMode: true,
          environment: childEnvironment,
          laborerSlackId: options.laborerSlackId,
          imageStorageRoot: options.paths.attachments,
          memoryMcpServer,
          participantLookup: dependencies.participantLookup ?? {
            lookupVisibleName: (slackUserId) => Effect.succeed(slackUserId),
          },
          permissionBroker,
          processCleanupObserver: generationContext.observeCleanup,
          processExitObserver: (code, signal) =>
            generationContext.observeExit({ code, signal }),
          processFailureObserver:
            generationContext.observeFailureClassification,
          processGeneration: generationContext.generation,
          processHealthObserver: (health) => {
            generationContext.observeHealth(health);
            observeHealth(health);
          },
          requireDurableCapabilitiesAtStartup: true,
        });
      }),
    repository: processStateRepository,
    ...(dependencies.processSupervisorTestHooks === undefined
      ? {}
      : { testHooks: dependencies.processSupervisorTestHooks }),
    workspaceId: options.workspaceId,
  });
  const initialSupervisorHealth = yield* supervisor.health;
  if (
    initialSupervisorHealth.health !== "ready" &&
    initialSupervisorHealth.health !== "circuit_open"
  ) {
    return yield* AcpWorkspaceStartupError.make({
      reason: "acp-child-incompatible-or-unavailable",
      workspaceId: options.workspaceId,
    });
  }
  const conversationAgent = supervisor.agent;
  const application =
    yield* makeReferenceCodingWorkspaceApplicationWithConversationAgent(
      {
        config: options.applicationConfig,
        environment: options.environment,
        paths: options.paths,
        root: options.root,
      },
      conversationAgent,
      {
        ...dependencies,
        ...(options.rootRuntime === undefined ||
        options.rootRuntime.actions.actions.length === 0
          ? {}
          : {
              rootRuntimeCapabilities: conversationCapabilitiesForRootRuntime({
                rootIdentity: options.root,
                runtime: options.rootRuntime,
                workspaceId: options.workspaceId,
              }),
            }),
      }
    );
  const durableApplication =
    options.rootRuntime === undefined
      ? application
      : yield* applicationThroughRootConversationRuntime({
          actionCatalogFingerprint: options.rootRuntime.actions.fingerprint,
          application,
          ...(dependencies.publishExternalOutput === undefined
            ? {}
            : { publishExternalOutput: dependencies.publishExternalOutput }),
          rootIdentity: options.root,
          routeParticipantTurnsThroughDurableRuntime: false,
          runtime: options.rootRuntime,
          workspaceId: options.workspaceId,
        });
  // `applicationConfig.implementation` is consumed only if the separate lazy
  // implementation runtime is acquired. The ACP Conversation child receives
  // no Laborer agent, model, or protocol override.
  return {
    application: durableApplication,
    health: supervisor.health.pipe(
      Effect.map((health) => {
        const status = processStatusForSupervisorHealth(health.health);
        currentHealth = { ...health, status };
        return currentHealth;
      })
    ),
    permissionBroker,
  };
});
