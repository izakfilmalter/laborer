import { Deferred, Effect, Exit, Redacted, Ref, Result, Scope } from "effect";
import type {
  SlackDaemonConfig,
  SlackInstallationConfig,
  SlackRuntimeIdentity,
} from "./config.ts";
import { SlackStartupError } from "./errors.ts";
import type { LoadedLaborerConfig } from "./laborer-config.ts";
import { loadLaborerConfig } from "./laborer-config.ts";
import { acquireRunnerLock } from "./runner-lock.ts";
import type { SlackRuntimePaths } from "./runtime-paths.ts";
import { prepareSlackRuntimePaths } from "./runtime-paths.ts";
import type {
  SlackEventInjector,
  SlackWorkspaceInstallation,
  SlackWorkspaceRouteDirectory,
} from "./socket-mode.ts";
import { makeSlackWorkspaceRouteDirectory } from "./socket-mode.ts";

export interface PreparedSlackWorkspaceRoot {
  readonly laborer: LoadedLaborerConfig;
  readonly paths: SlackRuntimePaths;
}

export type PrepareSlackWorkspaceRoot = (
  config: SlackInstallationConfig,
  environment: NodeJS.ProcessEnv
) => Effect.Effect<PreparedSlackWorkspaceRoot, unknown, never>;

export type AcquireSlackRootLock = (
  paths: SlackRuntimePaths
) => Effect.Effect<boolean, never, Scope.Scope>;

export interface SlackWorkspaceRuntimeOptions<Client, Gateway> {
  readonly client: Client;
  readonly gateway: Gateway;
  readonly identity: SlackRuntimeIdentity;
  readonly laborer: LoadedLaborerConfig;
  readonly paths: SlackRuntimePaths;
}

export interface SlackWorkspaceStartupAdapter<Client, Gateway> {
  readonly authenticate: (
    client: Client
  ) => Effect.Effect<SlackRuntimeIdentity, unknown, never>;
  readonly makeClient: (botToken: string) => Client;
  readonly makeGateway: (options: {
    readonly client: Client;
    readonly identity: SlackRuntimeIdentity;
    readonly namespaceWorkspace: boolean;
  }) => Gateway;
  readonly makeRunner: (
    options: SlackWorkspaceRuntimeOptions<Client, Gateway>
  ) => Effect.Effect<SlackEventInjector, unknown, Scope.Scope>;
  readonly makeSetupIncompleteResponder: (
    gateway: Gateway
  ) => NonNullable<SlackWorkspaceInstallation["postSetupIncomplete"]>;
}

export interface SlackWorkspacePreflightReport {
  readonly bindingIndex: number;
  readonly reasonCode: string;
  readonly status:
    | "ready"
    | "setup-incomplete"
    | "config-incompatible"
    | "quarantined"
    | "circuit-open";
}

type ObserveSlackWorkspacePreflight = (
  report: SlackWorkspacePreflightReport
) => void;

const reportPreflight = (
  observe: ObserveSlackWorkspacePreflight | undefined,
  report: SlackWorkspacePreflightReport
): Effect.Effect<void> =>
  Effect.logInfo("Slack workspace startup preflight", report).pipe(
    Effect.andThen(Effect.sync(() => observe?.(report)))
  );

const preparedFailureIsConfigIncompatible = (
  prepared: PreparedRootResult
): boolean => {
  if (prepared === null || prepared._tag !== "Failure") {
    return false;
  }
  const failure = prepared.failure;
  return (
    typeof failure === "object" &&
    failure !== null &&
    "_tag" in failure &&
    failure._tag === "LaborerConfigError"
  );
};

const unavailablePreparedReport = (
  bindingIndex: number,
  prepared: PreparedRootResult
): SlackWorkspacePreflightReport => {
  const incompatible = preparedFailureIsConfigIncompatible(prepared);
  return {
    bindingIndex,
    reasonCode: incompatible
      ? "laborer-config-incompatible"
      : "workspace-root-unavailable",
    status: incompatible ? "config-incompatible" : "setup-incomplete",
  };
};

const preflightStatusForReadiness = (
  readiness: string
): SlackWorkspacePreflightReport["status"] => {
  const known = [
    "ready",
    "setup-incomplete",
    "config-incompatible",
    "quarantined",
    "circuit-open",
  ] as const;
  return known.find((status) => status === readiness) ?? "ready";
};

export const prepareSlackWorkspaceRoot = Effect.fn("prepareSlackWorkspaceRoot")(
  function* (config: SlackInstallationConfig, environment: NodeJS.ProcessEnv) {
    if (config.root === undefined) {
      return yield* Effect.die(new Error("workspace root is missing"));
    }
    const laborer = yield* loadLaborerConfig({
      defaultRoot: config.root,
      environment: { ...environment, LABORER_ROOT: config.root },
    });
    const paths = yield* prepareSlackRuntimePaths(
      laborer.root,
      config.namespaceWorkspace ? config.expectedTeamId : undefined
    );
    return { laborer, paths } satisfies PreparedSlackWorkspaceRoot;
  }
);

const acquireSlackRootLock: AcquireSlackRootLock = (paths) =>
  Effect.result(acquireRunnerLock(paths.root, paths.lock)).pipe(
    Effect.map((result) => result._tag === "Success")
  );

interface RootLockDirectory {
  readonly acquire: (
    paths: SlackRuntimePaths
  ) => Effect.Effect<boolean, never, Scope.Scope>;
}

const makeRootLockDirectory = (
  acquireRootLock: AcquireSlackRootLock
): Effect.Effect<RootLockDirectory> =>
  Effect.gen(function* () {
    const locks = yield* Ref.make<
      ReadonlyMap<string, Deferred.Deferred<boolean>>
    >(new Map());
    return {
      acquire: (paths) =>
        Effect.gen(function* () {
          const candidate = yield* Deferred.make<boolean>();
          const [lock, isOwner] = yield* Ref.modify(
            locks,
            (
              current
            ): readonly [
              readonly [Deferred.Deferred<boolean>, boolean],
              ReadonlyMap<string, Deferred.Deferred<boolean>>,
            ] => {
              const existing = current.get(paths.root);
              if (existing !== undefined) {
                return [[existing, false], current];
              }
              const updated = new Map(current);
              updated.set(paths.root, candidate);
              return [[candidate, true], updated];
            }
          );
          if (isOwner) {
            const exit = yield* Effect.exit(acquireRootLock(paths));
            yield* Deferred.succeed(
              lock,
              exit._tag === "Success" && exit.value
            );
          }
          return yield* Deferred.await(lock);
        }),
    };
  });

const authenticateInstallation = <Client, Gateway>(
  config: SlackInstallationConfig,
  adapter: SlackWorkspaceStartupAdapter<Client, Gateway>
): Effect.Effect<readonly [Client, SlackRuntimeIdentity] | null> => {
  if (config.validation._tag === "Invalid" || !config.tokenIsValid) {
    return config.validation._tag === "Invalid"
      ? Effect.logError("Slack workspace registry binding is invalid", {
          bindingIndex: config.bindingIndex,
          reason: config.validation.reason,
        }).pipe(Effect.as(null))
      : Effect.logError("Slack workspace token is missing or invalid", {
          bindingIndex: config.bindingIndex,
          expectedTeamId: config.expectedTeamId,
        }).pipe(Effect.as(null));
  }
  const client = adapter.makeClient(Redacted.value(config.botToken));
  return Effect.result(adapter.authenticate(client)).pipe(
    Effect.flatMap((result) =>
      result._tag === "Success"
        ? Effect.succeed([client, result.success] as const)
        : Effect.logError(
            "Slack workspace installation authentication failed",
            {
              bindingIndex: config.bindingIndex,
              expectedTeamId:
                config.expectedTeamId ?? "derived-at-authentication",
            }
          ).pipe(Effect.as(null))
    )
  );
};

type PreparedRootResult = Result.Result<
  PreparedSlackWorkspaceRoot,
  unknown
> | null;

const prepareBindingRoot = (
  config: SlackInstallationConfig,
  environment: NodeJS.ProcessEnv,
  prepareRoot: PrepareSlackWorkspaceRoot
): Effect.Effect<PreparedRootResult> =>
  config.validation._tag === "Valid" && config.root !== undefined
    ? Effect.result(prepareRoot(config, environment))
    : Effect.succeed(null);

const settleConfiguredUnavailable = (
  config: SlackInstallationConfig,
  routes: SlackWorkspaceRouteDirectory
): Effect.Effect<void> =>
  config.expectedTeamId === undefined
    ? Effect.void
    : routes.settleUnavailable(config.bindingIndex, config.expectedTeamId);

const initializeAuthenticatedBinding = <Client, Gateway>(options: {
  readonly adapter: SlackWorkspaceStartupAdapter<Client, Gateway>;
  readonly authenticated: readonly [Client, SlackRuntimeIdentity];
  readonly config: SlackInstallationConfig;
  readonly locks: RootLockDirectory;
  readonly prepared: PreparedRootResult;
  readonly observePreflight?: ObserveSlackWorkspacePreflight;
  readonly rootLockAcquired?: boolean;
  readonly routes: SlackWorkspaceRouteDirectory;
}): Effect.Effect<void, never, Scope.Scope> =>
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: linear startup state machine keeps every binding failure isolated and reported
  Effect.gen(function* () {
    const { config, prepared } = options;
    const [client, identity] = options.authenticated;
    if (
      config.expectedTeamId !== undefined &&
      config.expectedTeamId !== identity.teamId
    ) {
      yield* Effect.logError(
        "Slack token authenticated to a different workspace than configured",
        {
          authenticatedTeamId: identity.teamId,
          bindingIndex: config.bindingIndex,
          expectedTeamId: config.expectedTeamId,
        }
      );
      yield* settleConfiguredUnavailable(config, options.routes);
      yield* reportPreflight(options.observePreflight, {
        bindingIndex: config.bindingIndex,
        reasonCode: "workspace-identity-mismatch",
        status: "setup-incomplete",
      });
      return;
    }
    if (config.expectedTeamId === undefined) {
      yield* options.routes.registerPending(
        config.bindingIndex,
        identity.teamId
      );
    }
    const gateway = options.adapter.makeGateway({
      client,
      identity,
      namespaceWorkspace: config.namespaceWorkspace,
    });
    const unavailableInstallation: SlackWorkspaceInstallation = {
      identity,
      namespaceWorkspace: config.namespaceWorkspace,
      postSetupIncomplete:
        options.adapter.makeSetupIncompleteResponder(gateway),
    };
    if (config.root === undefined) {
      yield* Effect.logError("Slack workspace has no configured local root", {
        bindingIndex: config.bindingIndex,
        teamId: identity.teamId,
      });
      yield* options.routes.settleUnavailable(
        config.bindingIndex,
        identity.teamId,
        unavailableInstallation
      );
      yield* reportPreflight(options.observePreflight, {
        bindingIndex: config.bindingIndex,
        reasonCode: "workspace-root-missing",
        status: "setup-incomplete",
      });
      return;
    }
    if (prepared === null || prepared._tag === "Failure") {
      yield* Effect.logError("Slack workspace root preparation failed", {
        bindingIndex: config.bindingIndex,
        teamId: identity.teamId,
      });
      yield* options.routes.settleUnavailable(
        config.bindingIndex,
        identity.teamId,
        unavailableInstallation
      );
      yield* reportPreflight(
        options.observePreflight,
        unavailablePreparedReport(config.bindingIndex, prepared)
      );
      return;
    }
    const hasLock =
      options.rootLockAcquired === true
        ? true
        : yield* options.locks.acquire(prepared.success.paths);
    if (!hasLock) {
      yield* Effect.logError("Slack workspace root lock is unavailable", {
        bindingIndex: config.bindingIndex,
        teamId: identity.teamId,
      });
      yield* options.routes.settleUnavailable(
        config.bindingIndex,
        identity.teamId,
        unavailableInstallation
      );
      yield* reportPreflight(options.observePreflight, {
        bindingIndex: config.bindingIndex,
        reasonCode: "workspace-root-lock-unavailable",
        status: "setup-incomplete",
      });
      return;
    }
    const ownerScope = yield* Effect.scope;
    const runner = yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const bindingScope = yield* Scope.make();
        const constructionExit = yield* Effect.exit(
          restore(
            options.adapter
              .makeRunner({
                client,
                gateway,
                identity,
                laborer: prepared.success.laborer,
                paths: prepared.success.paths,
              })
              .pipe(Effect.provideService(Scope.Scope, bindingScope))
          )
        );
        if (Exit.isFailure(constructionExit)) {
          yield* Scope.close(bindingScope, constructionExit);
          return constructionExit;
        }
        yield* Scope.addFinalizerExit(ownerScope, (ownerExit) =>
          Scope.close(bindingScope, ownerExit)
        );
        return constructionExit;
      })
    );
    if (Exit.isFailure(runner)) {
      yield* Effect.logError("Slack workspace Runner failed to start", {
        bindingIndex: config.bindingIndex,
        teamId: identity.teamId,
      });
      yield* options.routes.settleUnavailable(
        config.bindingIndex,
        identity.teamId,
        unavailableInstallation
      );
      yield* reportPreflight(options.observePreflight, {
        bindingIndex: config.bindingIndex,
        reasonCode: "acp-runner-quarantined",
        status: "quarantined",
      });
      return;
    }
    const runtimeHealth =
      runner.value.health === undefined
        ? null
        : yield* Effect.result(runner.value.health);
    const readiness =
      runtimeHealth?._tag === "Success"
        ? runtimeHealth.success.readiness
        : "ready";
    const preflightStatus = preflightStatusForReadiness(readiness);
    yield* reportPreflight(options.observePreflight, {
      bindingIndex: config.bindingIndex,
      reasonCode:
        preflightStatus === "ready"
          ? "acp-workspace-ready"
          : `acp-workspace-${preflightStatus}`,
      status: preflightStatus,
    });
    yield* options.routes.settleReady(config.bindingIndex, {
      ...unavailableInstallation,
      runner: runner.value,
    });
  });

const initializeBinding = <Client, Gateway>(options: {
  readonly adapter: SlackWorkspaceStartupAdapter<Client, Gateway>;
  readonly config: SlackInstallationConfig;
  readonly environment: NodeJS.ProcessEnv;
  readonly locks: RootLockDirectory;
  readonly observePreflight?: ObserveSlackWorkspacePreflight;
  readonly prepareRoot: PrepareSlackWorkspaceRoot;
  readonly routes: SlackWorkspaceRouteDirectory;
}): Effect.Effect<void, never, Scope.Scope> => {
  const initialize = Effect.gen(function* () {
    const { config } = options;
    const prepared = yield* prepareBindingRoot(
      config,
      options.environment,
      options.prepareRoot
    );
    const authenticated = yield* authenticateInstallation(
      config,
      options.adapter
    );
    if (authenticated === null) {
      yield* settleConfiguredUnavailable(config, options.routes);
      yield* reportPreflight(options.observePreflight, {
        bindingIndex: config.bindingIndex,
        reasonCode: "workspace-authentication-unavailable",
        status: "setup-incomplete",
      });
      return;
    }
    yield* initializeAuthenticatedBinding({
      adapter: options.adapter,
      authenticated,
      config,
      locks: options.locks,
      ...(options.observePreflight === undefined
        ? {}
        : { observePreflight: options.observePreflight }),
      prepared,
      routes: options.routes,
    });
  });
  return initialize.pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        yield* settleConfiguredUnavailable(options.config, options.routes);
        yield* reportPreflight(options.observePreflight, {
          bindingIndex: options.config.bindingIndex,
          reasonCode: "workspace-initialization-stopped",
          status: "setup-incomplete",
        });
        yield* Effect.logError(
          "Slack workspace binding initialization stopped",
          {
            bindingIndex: options.config.bindingIndex,
            cause: String(cause),
          }
        );
      })
    )
  );
};

const startLegacyWorkspaceDirectory = <Client, Gateway>(options: {
  readonly adapter: SlackWorkspaceStartupAdapter<Client, Gateway>;
  readonly config: SlackInstallationConfig;
  readonly environment: NodeJS.ProcessEnv;
  readonly locks: RootLockDirectory;
  readonly prepareRoot: PrepareSlackWorkspaceRoot;
  readonly routes: SlackWorkspaceRouteDirectory;
}): Effect.Effect<SlackWorkspaceRouteDirectory, unknown, Scope.Scope> =>
  Effect.gen(function* () {
    const prepared = yield* options.prepareRoot(
      options.config,
      options.environment
    );
    const hasLock = yield* options.locks.acquire(prepared.paths);
    if (!hasLock) {
      return yield* SlackStartupError.make({
        operation: "acquire-runner-lock",
        reason: "already-held",
      });
    }
    const authenticated = yield* authenticateInstallation(
      options.config,
      options.adapter
    );
    if (authenticated === null) {
      return yield* SlackStartupError.make({
        operation: "authenticate-installation",
        reason: "authentication-failed",
      });
    }
    yield* options.routes.registerPending(
      options.config.bindingIndex,
      authenticated[1].teamId
    );
    yield* initializeAuthenticatedBinding({
      adapter: options.adapter,
      authenticated,
      config: options.config,
      locks: options.locks,
      prepared: Result.succeed(prepared),
      rootLockAcquired: true,
      routes: options.routes,
    });
    const route = yield* options.routes.resolve(authenticated[1].teamId);
    if (route._tag !== "Ready") {
      return yield* SlackStartupError.make({
        operation: "start-installation",
        reason: "runner-unavailable",
      });
    }
    return options.routes;
  });

export const startSlackWorkspaceDirectory = <Client, Gateway>(options: {
  readonly acquireRootLock?: AcquireSlackRootLock;
  readonly adapter: SlackWorkspaceStartupAdapter<Client, Gateway>;
  readonly config: SlackDaemonConfig;
  readonly environment?: NodeJS.ProcessEnv;
  readonly observePreflight?: ObserveSlackWorkspacePreflight;
  readonly prepareRoot?: PrepareSlackWorkspaceRoot;
}): Effect.Effect<SlackWorkspaceRouteDirectory, unknown, Scope.Scope> =>
  Effect.gen(function* () {
    const routes = yield* makeSlackWorkspaceRouteDirectory;
    const locks = yield* makeRootLockDirectory(
      options.acquireRootLock ?? acquireSlackRootLock
    );
    const environment = options.environment ?? process.env;
    const prepareRoot = options.prepareRoot ?? prepareSlackWorkspaceRoot;
    if (options.config.startupMode === "legacy") {
      const legacyConfig = options.config.installations[0];
      if (legacyConfig === undefined) {
        return yield* SlackStartupError.make({
          operation: "load-installation",
          reason: "missing-installation",
        });
      }
      return yield* startLegacyWorkspaceDirectory({
        adapter: options.adapter,
        config: legacyConfig,
        environment,
        locks,
        prepareRoot,
        routes,
      });
    }
    yield* Effect.forEach(
      options.config.installations,
      (config) =>
        config.validation._tag === "Valid" &&
        config.expectedTeamId !== undefined
          ? routes.registerPending(config.bindingIndex, config.expectedTeamId)
          : Effect.void,
      { discard: true }
    );
    yield* Effect.forEach(
      options.config.installations,
      (config) =>
        initializeBinding({
          adapter: options.adapter,
          config,
          environment,
          locks,
          ...(options.observePreflight === undefined
            ? {}
            : { observePreflight: options.observePreflight }),
          prepareRoot,
          routes,
        }).pipe(Effect.forkScoped),
      { discard: true }
    );
    return routes;
  });
