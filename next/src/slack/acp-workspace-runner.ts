import { dirname } from "node:path";
import type { WebClient } from "@slack/web-api";
import { Effect, type Layer, Schema, type Scope } from "effect";
import {
  type AcpAuthorityRepository,
  makeAcpAuthorityRepository,
} from "../acp-conversation-prototype/acp-authority.ts";
import { preflightReservedMcpNames } from "../acp-conversation-prototype/acp-config-source-inventory.ts";
import {
  type AcpConversationAgentOptions,
  type AcpConversationProcessHealth,
  makeAcpConversationAgent,
} from "../acp-conversation-prototype/acp-conversation-agent.ts";
import {
  type AcpPermissionBroker,
  makeAcpPermissionBroker,
} from "../acp-conversation-prototype/acp-permission-broker.ts";
import { makeAcpProcessStateRepository } from "../acp-conversation-prototype/acp-process-state.ts";
import {
  type AcpProcessSupervisorTestHooks,
  type AcpWorkspaceSupervisorHealthSnapshot,
  makeAcpConversationProcessSupervisor,
} from "../acp-conversation-prototype/acp-process-supervisor.ts";
import {
  laborerActionMcpServerName,
  makeLaborerActionMcpBridge,
} from "../acp-conversation-prototype/action-mcp.ts";
import { prepareAcpAgentContextSources } from "../acp-conversation-prototype/agent-context.ts";
import {
  laborerMemoryOpenCodePermission,
  makeLaborerMemoryMcpServerConfiguration,
} from "../acp-conversation-prototype/memory-mcp.ts";
import { openCodeAcpProcessOptions } from "../acp-conversation-prototype/open-code-acp-process.ts";
import { preflightEffectiveOpenCodeMcpNames } from "../acp-conversation-prototype/opencode-config-preflight.ts";
import {
  makeSlackParticipantLookup,
  type SlackParticipantLookupShape,
} from "../acp-conversation-prototype/slack-participant-lookup.ts";
import type { ApplicationShape } from "../application.ts";
import { applicationThroughRootConversationRuntime } from "../durable-runtime/conversation-application.ts";
import { conversationCapabilitiesForRootRuntime } from "../durable-runtime/reference-coding-application.ts";
import type { RootDurableRuntimeShape } from "../durable-runtime/root-runtime.ts";
import { productionGeneratedMutationCatalog } from "../generated-mutation-catalog.ts";
import {
  makeSlackActivationAcknowledger,
  makeSlackCompletionReactor,
} from "../prototype/emulated-slack.ts";
import type { HandlerFailure, StoreError } from "../prototype/errors.ts";
import type {
  PrototypeHarness,
  SlackGatewayShape,
} from "../prototype/runtime.ts";
import { makePrototypeHarness } from "../prototype/runtime.ts";
import { makeFileStoreLayer, type PrototypeStore } from "../prototype/store.ts";
import type { ConversationAgentShape } from "../reference-coding-application.ts";
import { makeSlackAcpPermissionPresenter } from "./acp-permission-presenter.ts";
import { makeAcpPermissionTerminalOutbox } from "./acp-permission-ui-outbox.ts";
import {
  makeAcpRecoveryService,
  startAcpRecoverySocket,
} from "./acp-recovery.ts";
import { makeSlackConversationAdoptionHistoryGateway } from "./conversation-adoption-history.ts";
import { environmentForAcpConversation } from "./handler-environment.ts";
import type { SlackRuntimePaths } from "./runtime-paths.ts";
import { observePrototypeWorkThreads } from "./work-thread-activity-projection.ts";
import {
  makeReferenceCodingWorkspaceApplicationWithConversationAgent,
  type ReferenceCodingWorkspaceApplicationDependencies,
} from "./workspace-runner.ts";
import type { SlackWorkspaceRuntimeOptions } from "./workspace-startup.ts";

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
  readonly applicationConfig: NonNullable<
    SlackWorkspaceRuntimeOptions<
      WebClient,
      SlackGatewayShape
    >["laborer"]["config"]["application"]
  >;
  readonly client: WebClient;
  readonly environment: NodeJS.ProcessEnv;
  readonly laborerBotId?: string;
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
  readonly permissionTimeoutMillis?: number;
  readonly process?: ProductionProcessOverrides;
  readonly processSupervisorTestHooks?: AcpProcessSupervisorTestHooks;
  readonly storeLayer?: Layer.Layer<PrototypeStore, StoreError>;
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
    command: dependencies.process?.command ?? baseProcess.command,
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
  const permissionUiOutbox = yield* makeAcpPermissionTerminalOutbox({
    path: options.paths.acpPermissionUiOutbox,
    trustedRoot: options.paths.root,
  });
  const permissionBroker = yield* makeAcpPermissionBroker({
    presenter: makeSlackAcpPermissionPresenter(options.client, {
      botUserId: options.laborerSlackId,
      outbox: permissionUiOutbox,
      workspaceId: options.workspaceId,
    }),
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
          imageStorageRoot: options.paths.root,
          memoryMcpServer,
          participantLookup:
            dependencies.participantLookup ??
            makeSlackParticipantLookup(options.client),
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
        conversationAdoptionHistory:
          dependencies.conversationAdoptionHistory ??
          makeSlackConversationAdoptionHistoryGateway({
            botId: options.laborerBotId ?? "",
            botUserId: options.laborerSlackId,
            client: options.client,
            workspaceId: options.workspaceId,
          }),
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
          rootIdentity: options.root,
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

export interface ProductionAcpSlackWorkspaceRuntime
  extends ProductionAcpWorkspaceApplication {
  readonly harness: PrototypeHarness;
}

export const makeProductionAcpSlackWorkspaceRuntime = Effect.fn(
  "makeProductionAcpSlackWorkspaceRuntime"
)(function* (
  options: SlackWorkspaceRuntimeOptions<WebClient, SlackGatewayShape>,
  dependencies: ProductionAcpWorkspaceApplicationDependencies = {}
): Effect.fn.Return<
  ProductionAcpSlackWorkspaceRuntime,
  AcpWorkspaceStartupError | HandlerFailure | StoreError,
  Scope.Scope
> {
  const applicationConfig = options.laborer.config.application;
  if (applicationConfig === undefined) {
    return yield* AcpWorkspaceStartupError.make({
      reason: "acp-composition-incompatible",
      workspaceId: options.identity.teamId,
    });
  }
  const workspace = yield* makeProductionAcpWorkspaceApplication(
    {
      applicationConfig,
      client: options.client,
      environment: dependencies.environment ?? process.env,
      laborerBotId: options.identity.botId,
      laborerSlackId: options.identity.botUserId,
      paths: options.paths,
      root: options.laborer.root,
      ...(options.rootRuntime === undefined
        ? {}
        : { rootRuntime: options.rootRuntime }),
      workspaceId: options.identity.teamId,
    },
    dependencies
  );
  const harness = yield* makePrototypeHarness({
    activationAcknowledger: makeSlackActivationAcknowledger(options.client),
    application: workspace.application,
    completionReactor: makeSlackCompletionReactor(options.client),
    laborerSlackId: options.identity.botUserId,
    slack: options.gateway,
    storeLayer:
      dependencies.storeLayer ??
      makeFileStoreLayer(
        options.identity.botUserId,
        options.paths.runnerState,
        options.paths.root,
        undefined,
        { initializeNewThreads: false }
      ),
  });
  return { ...workspace, harness };
});

export const makeAcpSlackWorkspaceRunner = Effect.fn(
  "makeAcpSlackWorkspaceRunner"
)(function* (
  options: SlackWorkspaceRuntimeOptions<WebClient, SlackGatewayShape>,
  dependencies: ProductionAcpWorkspaceApplicationDependencies = {}
) {
  const runtime = yield* makeProductionAcpSlackWorkspaceRuntime(
    options,
    dependencies
  );
  const recovery = makeAcpRecoveryService({
    paths: options.paths,
    runner: runtime.harness.runner,
    supervisorHealth: runtime.health,
    workspaceId: options.identity.teamId,
  });
  yield* startAcpRecoverySocket({
    path: options.paths.recoverySocket,
    service: recovery,
    trustedRoot: dirname(options.paths.recoverySocket),
  });
  return {
    ...runtime.harness.runner,
    handleInteraction: runtime.permissionBroker.handleInteraction,
    health: recovery.health,
    recovery,
    workThreadActivity: Effect.all({
      executions:
        options.rootRuntime?.nonterminalExecutionActivity?.(
          options.identity.teamId
        ) ?? Effect.succeed([]),
      state: runtime.harness.store.snapshot,
    }).pipe(
      Effect.map(({ executions, state }) =>
        observePrototypeWorkThreads(state, options.identity.teamId, executions)
      )
    ),
  };
});
