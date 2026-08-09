import { Deferred, Effect, Exit, Ref, Scope } from "effect";
import { environmentForAcpConversation } from "../acp-runtime/child-environment.ts";
import {
  type GitWorktreeManagerOptions,
  makeGitWorktreeManager,
} from "../adapters/git-worktree-manager.ts";
import {
  makeOpenCodeImplementationAgent,
  makeOpenCodeWorkspaceSessionClient,
  type OpenCodeSessionClient,
  type OpenCodeWorkspaceSessionClientOptions,
} from "../adapters/opencode-agents.ts";
import type { ApplicationShape } from "../application.ts";
import { HandlerFailure } from "../core/errors.ts";
import {
  type ConversationAgentShape,
  type ImplementationAgentShape,
  makeFileApplicationRepository,
  makeReferenceCodingApplication,
  type ReferenceCodingApplicationRepository,
  type WorktreeManagerShape,
} from "../reference-coding-application.ts";
import type { ConversationAdoptionHistoryGateway } from "./conversation-adoption-history.ts";
import type { ReferenceCodingApplicationConfig } from "./laborer-config.ts";
import type { SlackRuntimePaths } from "./runtime-paths.ts";

export interface ReferenceCodingWorkspaceApplicationOptions {
  readonly config: ReferenceCodingApplicationConfig;
  readonly environment: NodeJS.ProcessEnv;
  readonly paths: SlackRuntimePaths;
  readonly root: string;
}

export interface ReferenceCodingWorkspaceApplicationDependencies {
  readonly afterImplementationClientAcquired?: () => Effect.Effect<void>;
  readonly afterImplementationFinalizerRegistered?: () => Effect.Effect<void>;
  readonly conversationAdoptionHistory?: ConversationAdoptionHistoryGateway;
  readonly makeApplicationRepository?: (
    path: string,
    trustedRoot: string
  ) => Effect.Effect<ReferenceCodingApplicationRepository, HandlerFailure>;
  readonly makeOpenCodeClient?: (
    options: OpenCodeWorkspaceSessionClientOptions
  ) => Effect.Effect<OpenCodeSessionClient, HandlerFailure, Scope.Scope>;
  readonly makeWorktreeManager?: (
    options: GitWorktreeManagerOptions
  ) => WorktreeManagerShape;
  readonly observeImplementationAgent?: (
    implementationAgent: ImplementationAgentShape
  ) => void;
  readonly rootRuntimeCapabilities?: {
    readonly actionsFor: (
      conversationId: string
    ) => readonly import("../reference-coding-application.ts").ConversationAction[];
    readonly controlsFor: (
      conversationId: string
    ) => readonly import("../reference-coding-application.ts").ConversationExecutionControl[];
  };
}

interface ReferenceCodingWorkspaceInfrastructure {
  readonly repository: ReferenceCodingApplicationRepository;
  readonly worktreeManager: WorktreeManagerShape;
}

type LazyImplementationState =
  | {
      readonly _tag: "Acquiring";
      readonly gate: Deferred.Deferred<
        ImplementationAgentShape,
        HandlerFailure
      >;
    }
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Ready"; readonly agent: ImplementationAgentShape };

type LazyImplementationDecision =
  | {
      readonly _tag: "Await" | "Start";
      readonly gate: Deferred.Deferred<
        ImplementationAgentShape,
        HandlerFailure
      >;
    }
  | { readonly _tag: "Ready"; readonly agent: ImplementationAgentShape };

const openCodeClientOptions = (
  options: ReferenceCodingWorkspaceApplicationOptions
): OpenCodeWorkspaceSessionClientOptions => {
  const configuredModel = options.config.implementation?.model;
  const modelSeparatorIndex = configuredModel?.indexOf("/") ?? -1;
  return {
    ...(options.config.implementation?.agent === undefined
      ? {}
      : { agent: options.config.implementation.agent }),
    environment: environmentForAcpConversation(
      options.environment,
      options.config.environment
    ),
    ...(configuredModel === undefined
      ? {}
      : {
          model: {
            modelID: configuredModel.slice(modelSeparatorIndex + 1),
            providerID: configuredModel.slice(0, modelSeparatorIndex),
          },
        }),
    promptIsolation: false,
    workspaceDirectory: options.root,
  };
};

const makeReferenceCodingWorkspaceInfrastructure = Effect.fn(
  "makeReferenceCodingWorkspaceInfrastructure"
)(function* (
  options: ReferenceCodingWorkspaceApplicationOptions,
  dependencies: ReferenceCodingWorkspaceApplicationDependencies = {}
): Effect.fn.Return<
  ReferenceCodingWorkspaceInfrastructure,
  HandlerFailure,
  Scope.Scope
> {
  const repository = yield* (
    dependencies.makeApplicationRepository ?? makeFileApplicationRepository
  )(options.paths.applicationState, options.paths.root);
  const worktreeManager = (
    dependencies.makeWorktreeManager ?? makeGitWorktreeManager
  )({ repository: options.root });
  return { repository, worktreeManager };
});

export const makeLazyOpenCodeImplementationAgent = Effect.fn(
  "makeLazyOpenCodeImplementationAgent"
)(function* (
  options: ReferenceCodingWorkspaceApplicationOptions,
  dependencies: ReferenceCodingWorkspaceApplicationDependencies = {}
): Effect.fn.Return<ImplementationAgentShape, never, Scope.Scope> {
  const ownerScope = yield* Effect.scope;
  const state = yield* Ref.make<LazyImplementationState>({ _tag: "Idle" });
  const runAcquisition = (
    gate: Deferred.Deferred<ImplementationAgentShape, HandlerFailure>
  ): Effect.Effect<void> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const resourceScope = yield* Scope.make();
        const makeOpenCodeClient =
          dependencies.makeOpenCodeClient ?? makeOpenCodeWorkspaceSessionClient;
        const acquisitionExit = yield* Effect.exit(
          restore(
            makeOpenCodeClient(openCodeClientOptions(options)).pipe(
              Effect.provideService(Scope.Scope, resourceScope)
            )
          )
        );
        if (Exit.isFailure(acquisitionExit)) {
          yield* Scope.close(resourceScope, acquisitionExit);
          yield* Ref.update(
            state,
            (current): LazyImplementationState =>
              current._tag === "Acquiring" && current.gate === gate
                ? { _tag: "Idle" }
                : current
          );
          yield* Deferred.failCause(gate, acquisitionExit.cause);
          return;
        }
        if (dependencies.afterImplementationClientAcquired !== undefined) {
          yield* dependencies.afterImplementationClientAcquired();
        }
        const implementationAgent = makeOpenCodeImplementationAgent({
          client: acquisitionExit.value,
        });
        yield* Scope.addFinalizerExit(ownerScope, (ownerExit) =>
          Scope.close(resourceScope, ownerExit)
        );
        if (dependencies.afterImplementationFinalizerRegistered !== undefined) {
          yield* dependencies.afterImplementationFinalizerRegistered();
        }
        yield* Ref.set(state, {
          _tag: "Ready",
          agent: implementationAgent,
        });
        yield* Deferred.succeed(gate, implementationAgent);
      })
    );
  const acquire = Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const candidate = yield* Deferred.make<
        ImplementationAgentShape,
        HandlerFailure
      >();
      const decision = yield* Ref.modify(
        state,
        (
          current
        ): readonly [LazyImplementationDecision, LazyImplementationState] => {
          if (current._tag === "Ready") {
            return [{ _tag: "Ready", agent: current.agent }, current];
          }
          if (current._tag === "Acquiring") {
            return [{ _tag: "Await", gate: current.gate }, current];
          }
          const acquiring: LazyImplementationState = {
            _tag: "Acquiring",
            gate: candidate,
          };
          return [{ _tag: "Start", gate: candidate }, acquiring];
        }
      );
      if (decision._tag === "Ready") {
        return decision.agent;
      }
      if (decision._tag === "Start") {
        yield* runAcquisition(decision.gate).pipe(
          Effect.forkIn(ownerScope, { startImmediately: true })
        );
      }
      return yield* restore(Deferred.await(decision.gate));
    })
  );
  return {
    inspect: (request) =>
      acquire.pipe(
        Effect.flatMap(
          (implementationAgent) =>
            implementationAgent.inspect?.(request) ??
            Effect.succeed({
              certainty: "unknown" as const,
              evidence: "inspection-unavailable" as const,
              status: "ambiguous" as const,
            })
        ),
        Effect.catch(() =>
          Effect.succeed({
            certainty: "unknown" as const,
            evidence: "provider-inspection-failed" as const,
            status: "ambiguous" as const,
          })
        )
      ),
    recover: (request, acceptResponse) =>
      acquire.pipe(
        Effect.flatMap((implementationAgent) => {
          if (implementationAgent.recover === undefined) {
            return HandlerFailure.make({
              category: "protocol",
              safeDetail: "implementation recovery is unavailable",
            });
          }
          return implementationAgent.recover(request, acceptResponse);
        })
      ),
    start: (request, acceptResponse) =>
      acquire.pipe(
        Effect.flatMap((implementationAgent) =>
          implementationAgent.start(request, acceptResponse)
        )
      ),
  };
});

export const makeReferenceCodingWorkspaceApplicationWithConversationAgent =
  Effect.fn("makeReferenceCodingWorkspaceApplicationWithConversationAgent")(
    function* (
      options: ReferenceCodingWorkspaceApplicationOptions,
      conversationAgent: ConversationAgentShape,
      dependencies: ReferenceCodingWorkspaceApplicationDependencies = {}
    ): Effect.fn.Return<ApplicationShape, HandlerFailure, Scope.Scope> {
      const infrastructure = yield* makeReferenceCodingWorkspaceInfrastructure(
        options,
        dependencies
      );
      const implementationAgent = yield* makeLazyOpenCodeImplementationAgent(
        options,
        dependencies
      );
      dependencies.observeImplementationAgent?.(implementationAgent);
      return yield* makeReferenceCodingApplication({
        ...(dependencies.conversationAdoptionHistory === undefined
          ? {}
          : {
              conversationAdoptionHistory:
                dependencies.conversationAdoptionHistory,
            }),
        conversationAgent,
        implementationAgent,
        repository: infrastructure.repository,
        ...(dependencies.rootRuntimeCapabilities === undefined
          ? {}
          : {
              rootRuntimeCapabilities: dependencies.rootRuntimeCapabilities,
            }),
        worktreeManager: infrastructure.worktreeManager,
      });
    }
  );
