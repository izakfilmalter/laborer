import type { WebClient } from "@slack/web-api";
import { Effect, type Scope } from "effect";
import {
  type GitWorktreeManagerOptions,
  makeGitWorktreeManager,
} from "../adapters/git-worktree-manager.ts";
import {
  makeOpenCodeConversationAgent,
  makeOpenCodeImplementationAgent,
  makeOpenCodeWorkspaceSessionClient,
  type OpenCodeSessionClient,
  type OpenCodeWorkspaceSessionClientOptions,
} from "../adapters/opencode-agents.ts";
import type { ApplicationShape } from "../application.ts";
import {
  makeSlackActivationAcknowledger,
  makeSlackCompletionReactor,
} from "../prototype/emulated-slack.ts";
import type { HandlerFailure } from "../prototype/errors.ts";
import {
  makeProcessHandler,
  makeProcessInitializer,
} from "../prototype/process-handler.ts";
import type { SlackGatewayShape } from "../prototype/runtime.ts";
import { makePrototypeHarness } from "../prototype/runtime.ts";
import { makeFileStoreLayer } from "../prototype/store.ts";
import {
  makeFileApplicationRepository,
  makeReferenceCodingApplication,
  type ReferenceCodingApplicationRepository,
  type WorktreeManagerShape,
} from "../reference-coding-application.ts";
import { environmentForConfiguredHandler } from "./handler-environment.ts";
import type {
  ReferenceCodingApplicationConfig,
  WorkHandlerConfig,
} from "./laborer-config.ts";
import type { SlackRuntimePaths } from "./runtime-paths.ts";
import type { SlackWorkspaceRuntimeOptions } from "./workspace-startup.ts";

export interface ReferenceCodingWorkspaceApplicationOptions {
  readonly config: ReferenceCodingApplicationConfig;
  readonly environment: NodeJS.ProcessEnv;
  readonly paths: SlackRuntimePaths;
  readonly root: string;
}

export interface ReferenceCodingWorkspaceApplicationDependencies {
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
}

export const makeReferenceCodingWorkspaceApplication = Effect.fn(
  "makeReferenceCodingWorkspaceApplication"
)(function* (
  options: ReferenceCodingWorkspaceApplicationOptions,
  dependencies: ReferenceCodingWorkspaceApplicationDependencies = {}
): Effect.fn.Return<ApplicationShape, HandlerFailure, Scope.Scope> {
  const makeOpenCodeClient =
    dependencies.makeOpenCodeClient ?? makeOpenCodeWorkspaceSessionClient;
  const configuredModel = options.config.model;
  const modelSeparatorIndex = configuredModel?.indexOf("/") ?? -1;
  const sessionClient = yield* makeOpenCodeClient({
    ...(options.config.agent === undefined
      ? {}
      : { agent: options.config.agent }),
    environment: environmentForConfiguredHandler(
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
    workspaceDirectory: options.root,
  });
  const repository = yield* (
    dependencies.makeApplicationRepository ?? makeFileApplicationRepository
  )(options.paths.applicationState, options.paths.root);
  const worktreeManager = (
    dependencies.makeWorktreeManager ?? makeGitWorktreeManager
  )({ repository: options.root });
  return yield* makeReferenceCodingApplication({
    conversationAgent: makeOpenCodeConversationAgent({
      client: sessionClient,
      repositoryDirectory: options.root,
    }),
    implementationAgent: makeOpenCodeImplementationAgent({
      client: sessionClient,
    }),
    repository,
    worktreeManager,
  });
});

const makeConfiguredProcessRunner = Effect.fn(
  "makeConfiguredProcessWorkspaceRunner"
)(function* (
  options: SlackWorkspaceRuntimeOptions<WebClient, SlackGatewayShape>,
  workHandler: WorkHandlerConfig
) {
  const processHandler = yield* makeProcessHandler({
    args: workHandler.args,
    command: workHandler.command,
    cwd: options.laborer.root,
    environment: environmentForConfiguredHandler(
      process.env,
      workHandler.environment
    ),
    evidence: { mode: "production" },
    stateRoot: options.paths.workThreads,
    stateRootAnchor: options.paths.root,
  });
  const initializerConfig = workHandler.initialize;
  const processInitializer =
    initializerConfig === undefined
      ? undefined
      : yield* makeProcessInitializer({
          args: initializerConfig.args,
          command: initializerConfig.command,
          cwd: options.laborer.root,
          environment: environmentForConfiguredHandler(
            process.env,
            initializerConfig.environment
          ),
          evidence: { mode: "production" },
          stateRoot: options.paths.workThreads,
          stateRootAnchor: options.paths.root,
        });
  const harness = yield* makePrototypeHarness({
    activationAcknowledger: makeSlackActivationAcknowledger(options.client),
    completionReactor: makeSlackCompletionReactor(options.client),
    handler: processHandler.handler,
    ...(processInitializer === undefined
      ? {}
      : { initializer: processInitializer.initializer }),
    laborerSlackId: options.identity.botUserId,
    slack: options.gateway,
    storeLayer: makeFileStoreLayer(
      options.identity.botUserId,
      options.paths.legacyHandlerState,
      options.paths.root,
      undefined,
      { initializeNewThreads: processInitializer !== undefined }
    ),
  });
  return harness.runner;
});

export const makeSlackWorkspaceRunner = Effect.fn("makeSlackWorkspaceRunner")(
  function* (
    options: SlackWorkspaceRuntimeOptions<WebClient, SlackGatewayShape>
  ) {
    const workHandler = options.laborer.config.workHandler;
    if (workHandler !== undefined) {
      return yield* makeConfiguredProcessRunner(options, workHandler);
    }
    const applicationConfig = options.laborer.config.application;
    if (applicationConfig === undefined) {
      return yield* Effect.die(
        new Error("validated Laborer configuration has no adapter")
      );
    }
    const application = yield* makeReferenceCodingWorkspaceApplication({
      config: applicationConfig,
      environment: process.env,
      paths: options.paths,
      root: options.laborer.root,
    });
    const harness = yield* makePrototypeHarness({
      activationAcknowledger: makeSlackActivationAcknowledger(options.client),
      application,
      completionReactor: makeSlackCompletionReactor(options.client),
      laborerSlackId: options.identity.botUserId,
      slack: options.gateway,
      storeLayer: makeFileStoreLayer(
        options.identity.botUserId,
        options.paths.runnerState,
        options.paths.root,
        undefined,
        { initializeNewThreads: false }
      ),
    });
    return harness.runner;
  }
);
