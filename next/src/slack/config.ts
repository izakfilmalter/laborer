import {
  Config,
  Context,
  Effect,
  Array as EffectArray,
  Layer,
  pipe,
  Record,
  Redacted,
  Schema,
} from "effect";
import { SlackConfigValidationError } from "./errors.ts";

const APP_TOKEN_PREFIX = ["x", "app", "-"].join("");
const BOT_TOKEN_PREFIX = ["x", "oxb", "-"].join("");
const WORKSPACE_REGISTRY_VARIABLE = "LABORER_SLACK_WORKSPACES";
export const ACP_CANARY_SLACK_APP_TOKEN_VARIABLE =
  "LABORER_ACP_CANARY_SLACK_APP_TOKEN";
export const ACP_CANARY_SLACK_BOT_TOKEN_VARIABLE =
  "LABORER_ACP_CANARY_SLACK_BOT_TOKEN";
const TEAM_ID_PATTERN = /^T[A-Z0-9]+$/;
const BOT_TOKEN_REFERENCE_PATTERN = /^SLACK_BOT_TOKEN(?:_[A-Z0-9_]+)?$/;

export interface SlackConfigShape {
  readonly appToken: Redacted.Redacted<string>;
  readonly botToken: Redacted.Redacted<string>;
}

export class SlackConfig extends Context.Service<
  SlackConfig,
  SlackConfigShape
>()("@laborer/slack/SlackConfig") {}

const validateToken = (
  variable: string,
  token: Redacted.Redacted<string>,
  prefix: string
): Effect.Effect<Redacted.Redacted<string>, SlackConfigValidationError> => {
  const value = Redacted.value(token);
  if (value.trim().length === 0) {
    return SlackConfigValidationError.make({ variable, reason: "blank" });
  }
  return value.startsWith(prefix)
    ? Effect.succeed(token)
    : SlackConfigValidationError.make({
        variable,
        reason: "unexpected-token-kind",
      });
};

const SlackWorkspaceConfigFromJson = Schema.Struct({
  botTokenEnvironment: Schema.String,
  root: Schema.optional(Schema.String),
  teamId: Schema.String,
});

export interface SlackInstallationConfig {
  readonly bindingIndex: number;
  readonly botToken: Redacted.Redacted<string>;
  readonly botTokenEnvironment: string;
  readonly expectedTeamId?: string;
  readonly namespaceWorkspace: boolean;
  readonly root?: string;
  readonly tokenIsValid: boolean;
  readonly validation:
    | { readonly _tag: "Valid" }
    | { readonly _tag: "Invalid"; readonly reason: string };
}

export interface SlackDaemonConfig {
  readonly appToken: Redacted.Redacted<string>;
  readonly installations: readonly SlackInstallationConfig[];
  readonly startupMode: "legacy" | "multi-workspace";
}

const configFailure = (
  variable: string,
  reason: string
): SlackConfigValidationError =>
  SlackConfigValidationError.make({ variable, reason });

const readToken = (
  environment: NodeJS.ProcessEnv,
  variable: string,
  prefix: string
): Effect.Effect<Redacted.Redacted<string>, SlackConfigValidationError> => {
  const value = environment[variable];
  return validateToken(variable, Redacted.make(value ?? ""), prefix);
};

const matchesProductionBotToken = (
  environment: NodeJS.ProcessEnv,
  candidate: Redacted.Redacted<string>
): boolean => {
  const candidateValue = Redacted.value(candidate);
  return pipe(
    environment,
    Record.toEntries,
    EffectArray.some(
      ([name, value]) =>
        BOT_TOKEN_REFERENCE_PATTERN.test(name) && value === candidateValue
    )
  );
};

const invalidInstallation = (
  bindingIndex: number,
  reason: string
): SlackInstallationConfig => ({
  bindingIndex,
  botToken: Redacted.make(""),
  botTokenEnvironment: "",
  namespaceWorkspace: true,
  tokenIsValid: false,
  validation: { _tag: "Invalid", reason },
});

const bindingValidationReason = (
  entry: typeof SlackWorkspaceConfigFromJson.Type,
  teamIds: ReadonlySet<string>,
  tokenReferences: ReadonlySet<string>
): string | null => {
  const teamIdHasUnexpectedFormat = !TEAM_ID_PATTERN.test(entry.teamId);
  const teamIdIsDuplicated = teamIds.has(entry.teamId);
  const tokenReferenceHasUnexpectedFormat = !BOT_TOKEN_REFERENCE_PATTERN.test(
    entry.botTokenEnvironment
  );
  const tokenReferenceIsDuplicated = tokenReferences.has(
    entry.botTokenEnvironment
  );
  const rootIsBlank = entry.root?.trim().length === 0;

  if (teamIdHasUnexpectedFormat) {
    return "invalid-team-id";
  }
  if (teamIdIsDuplicated) {
    return "duplicate-team-id";
  }
  if (tokenReferenceHasUnexpectedFormat) {
    return "invalid-token-reference";
  }
  if (tokenReferenceIsDuplicated) {
    return "duplicate-token-reference";
  }
  return rootIsBlank ? "blank-root" : null;
};

export const loadSlackDaemonConfig = Effect.fn("loadSlackDaemonConfig")(
  function* (options: {
    readonly defaultRoot: string;
    readonly environment?: NodeJS.ProcessEnv;
  }) {
    const environment = options.environment ?? process.env;
    const appToken = yield* readToken(
      environment,
      "SLACK_APP_TOKEN",
      APP_TOKEN_PREFIX
    );
    const registrySource = environment[WORKSPACE_REGISTRY_VARIABLE];
    if (registrySource === undefined) {
      const botToken = yield* readToken(
        environment,
        "SLACK_BOT_TOKEN",
        BOT_TOKEN_PREFIX
      );
      return {
        appToken,
        installations: [
          {
            bindingIndex: 0,
            botToken,
            botTokenEnvironment: "SLACK_BOT_TOKEN",
            namespaceWorkspace: false,
            root: environment.LABORER_ROOT ?? options.defaultRoot,
            tokenIsValid: true,
            validation: { _tag: "Valid" },
          },
        ],
        startupMode: "legacy",
      } satisfies SlackDaemonConfig;
    }

    if (registrySource.trim().length === 0) {
      return yield* configFailure(WORKSPACE_REGISTRY_VARIABLE, "blank");
    }
    const source = yield* Effect.try({
      try: () => JSON.parse(registrySource) as unknown,
      catch: () => configFailure(WORKSPACE_REGISTRY_VARIABLE, "invalid-json"),
    });
    if (!Array.isArray(source)) {
      return yield* configFailure(
        WORKSPACE_REGISTRY_VARIABLE,
        "invalid-registry"
      );
    }
    if (source.length === 0) {
      return yield* configFailure(
        WORKSPACE_REGISTRY_VARIABLE,
        "empty-registry"
      );
    }

    const teamIds = new Set<string>();
    const tokenReferences = new Set<string>();
    const installations: SlackInstallationConfig[] = [];
    for (const [bindingIndex, rawEntry] of source.entries()) {
      const decoded = yield* Effect.result(
        Schema.decodeUnknownEffect(SlackWorkspaceConfigFromJson)(rawEntry)
      );
      if (decoded._tag === "Failure") {
        installations.push(invalidInstallation(bindingIndex, "invalid-shape"));
        continue;
      }
      const entry = decoded.success;
      const validationReason = bindingValidationReason(
        entry,
        teamIds,
        tokenReferences
      );
      if (validationReason !== null) {
        installations.push(invalidInstallation(bindingIndex, validationReason));
        continue;
      }
      teamIds.add(entry.teamId);
      tokenReferences.add(entry.botTokenEnvironment);
      const tokenValue = environment[entry.botTokenEnvironment] ?? "";
      installations.push({
        bindingIndex,
        botToken: Redacted.make(tokenValue),
        botTokenEnvironment: entry.botTokenEnvironment,
        expectedTeamId: entry.teamId,
        namespaceWorkspace: true,
        ...(entry.root === undefined ? {} : { root: entry.root }),
        tokenIsValid:
          tokenValue.trim().length > 0 &&
          tokenValue.startsWith(BOT_TOKEN_PREFIX),
        validation: { _tag: "Valid" },
      });
    }
    return {
      appToken,
      installations,
      startupMode: "multi-workspace",
    } satisfies SlackDaemonConfig;
  }
);

export const loadSlackConfig: Effect.Effect<
  SlackConfigShape,
  Config.ConfigError | SlackConfigValidationError
> = Effect.gen(function* () {
  const appToken = yield* Config.redacted("SLACK_APP_TOKEN");
  const botToken = yield* Config.redacted("SLACK_BOT_TOKEN");
  return SlackConfig.of({
    appToken: yield* validateToken(
      "SLACK_APP_TOKEN",
      appToken,
      APP_TOKEN_PREFIX
    ),
    botToken: yield* validateToken(
      "SLACK_BOT_TOKEN",
      botToken,
      BOT_TOKEN_PREFIX
    ),
  });
});

export const loadAcpCanarySlackConfig = (
  environment: NodeJS.ProcessEnv = process.env
): Effect.Effect<SlackConfigShape, SlackConfigValidationError> =>
  Effect.gen(function* () {
    const appToken = yield* readToken(
      environment,
      ACP_CANARY_SLACK_APP_TOKEN_VARIABLE,
      APP_TOKEN_PREFIX
    );
    const botToken = yield* readToken(
      environment,
      ACP_CANARY_SLACK_BOT_TOKEN_VARIABLE,
      BOT_TOKEN_PREFIX
    );
    if (Redacted.value(appToken) === environment.SLACK_APP_TOKEN) {
      return yield* configFailure(
        ACP_CANARY_SLACK_APP_TOKEN_VARIABLE,
        "matches-production-token"
      );
    }
    if (matchesProductionBotToken(environment, botToken)) {
      return yield* configFailure(
        ACP_CANARY_SLACK_BOT_TOKEN_VARIABLE,
        "matches-production-token"
      );
    }
    return SlackConfig.of({ appToken, botToken });
  });

export const slackConfigLayer: Layer.Layer<
  SlackConfig,
  Config.ConfigError | SlackConfigValidationError
> = Layer.effect(SlackConfig, loadSlackConfig);

export class SlackRuntimeIdentity extends Schema.Class<SlackRuntimeIdentity>(
  "SlackRuntimeIdentity"
)({
  botId: Schema.String,
  botUserId: Schema.String,
  teamId: Schema.String,
}) {}
