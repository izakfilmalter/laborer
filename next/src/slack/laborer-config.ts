import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, resolve } from "node:path";
import { Effect, Array as EffectArray, Schema } from "effect";
import {
  assertNoSymlinkPathComponents,
  assertSafeFilePath,
  canonicalDirectory,
  openRegularFileNoFollow,
  retainTrustedDirectory,
  verifyRetainedDirectory,
} from "../prototype/path-safety.ts";
import { LaborerConfigError } from "./errors.ts";
import { isSlackTokenEnvironmentName } from "./secret-environment.ts";

export interface ProcessCommandConfig {
  readonly args: readonly string[];
  readonly command: string;
  readonly environment: readonly string[];
}

export interface WorkHandlerConfig extends ProcessCommandConfig {
  readonly initialize?: ProcessCommandConfig;
}

export interface ConversationApplicationConfig {
  readonly instructions: readonly string[];
  readonly operationResultInstructions: readonly string[];
}

export interface ReferenceCodingApplicationConfig {
  readonly agent?: string;
  readonly conversation?: ConversationApplicationConfig;
  readonly environment: readonly string[];
  readonly model?: string;
  readonly type: "reference-coding";
}

export type LaborerConfig = Readonly<Record<string, unknown>> &
  (
    | {
        readonly application: ReferenceCodingApplicationConfig;
        readonly workHandler?: never;
      }
    | {
        readonly application?: never;
        readonly workHandler: WorkHandlerConfig;
      }
  );

export interface LoadedLaborerConfig {
  readonly config: LaborerConfig;
  readonly root: string;
}

const configFailure = (operation: string, reason: string): LaborerConfigError =>
  LaborerConfigError.make({ operation, reason });

const HandlerCommand = Schema.Trim.check(Schema.isMinLength(1));
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const OPENCODE_MODEL_PATTERN = /^[^/\s]+\/[^/\s]+(?:\/[^/\s]+)*$/;
const OpenCodeModel = Schema.Trim.check(
  Schema.isPattern(OPENCODE_MODEL_PATTERN)
);
const ConversationInstruction = Schema.Trim.check(Schema.isMinLength(1));
const ConversationInstructions = Schema.Array(ConversationInstruction).check(
  Schema.isMinLength(1)
);
const ProcessCommandConfigFromJson = Schema.Struct({
  args: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([]))
  ),
  command: HandlerCommand,
  environment: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([]))
  ),
});

const WorkHandlerConfigFromJson = Schema.Struct({
  ...ProcessCommandConfigFromJson.fields,
  initialize: Schema.optional(ProcessCommandConfigFromJson),
});

const ConversationApplicationConfigFromJson = Schema.Struct({
  instructions: ConversationInstructions,
  operationResultInstructions: ConversationInstructions,
});

const ReferenceCodingApplicationConfigFromJson = Schema.Struct({
  agent: Schema.optional(HandlerCommand),
  conversation: Schema.optional(ConversationApplicationConfigFromJson),
  environment: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([]))
  ),
  model: Schema.optional(OpenCodeModel),
  type: Schema.Literal("reference-coding"),
});

const LaborerConfigFromJson = Schema.fromJsonString(
  Schema.StructWithRest(
    Schema.Struct({
      application: Schema.optional(ReferenceCodingApplicationConfigFromJson),
      workHandler: Schema.optional(WorkHandlerConfigFromJson),
    }),
    [Schema.Record(Schema.String, Schema.Unknown)]
  )
);

const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

const executableFile = Effect.fnUntraced(function* (path: string) {
  const fileResult = yield* Effect.result(
    Effect.tryPromise({
      try: () => openRegularFileNoFollow(path, "validate-work-handler-command"),
      catch: () => false,
    })
  );
  if (fileResult._tag === "Failure") {
    return false;
  }
  try {
    const accessResult = yield* Effect.result(
      Effect.tryPromise({
        try: () => access(path, constants.X_OK),
        catch: () => false,
      })
    );
    return accessResult._tag === "Success";
  } finally {
    yield* Effect.promise(() => fileResult.success.close());
  }
});

const validateCommand = Effect.fnUntraced(function* (
  command: string,
  root: string,
  environment: NodeJS.ProcessEnv,
  operation: string
) {
  if (command.includes("/")) {
    if (isAbsolute(command)) {
      return yield* configFailure(operation, "absolute-command");
    }
    const resolvedCommand = resolve(root, command);
    yield* Effect.tryPromise({
      try: () =>
        assertSafeFilePath({
          anchor: root,
          operation: "validate-work-handler-command",
          path: resolvedCommand,
        }),
      catch: () => configFailure(operation, "unsafe-command-path"),
    });
    if (yield* executableFile(resolvedCommand)) {
      return resolvedCommand;
    }
    return yield* configFailure(operation, "command-not-executable");
  }

  const path = environment.PATH;
  if (path === undefined) {
    return yield* configFailure(operation, "command-not-on-path");
  }
  for (const pathEntry of path.split(delimiter)) {
    const candidate = resolve(root, pathEntry, command);
    if (yield* executableFile(candidate)) {
      return candidate;
    }
  }
  return yield* configFailure(operation, "command-not-on-path");
});

const validateEnvironmentNames = (
  names: readonly string[],
  operation: string
): Effect.Effect<readonly string[], LaborerConfigError> => {
  const invalidName = EffectArray.findFirst(
    names,
    (name) =>
      !ENVIRONMENT_NAME_PATTERN.test(name) || isSlackTokenEnvironmentName(name)
  );
  if (invalidName._tag === "Some") {
    return configFailure(operation, "invalid-environment-name");
  }
  if (EffectArray.dedupe(names).length !== names.length) {
    return configFailure(operation, "duplicate-environment-name");
  }
  return Effect.succeed(names);
};

const validateProcessCommand = Effect.fnUntraced(function* (
  raw: typeof ProcessCommandConfigFromJson.Type,
  root: string,
  environment: NodeJS.ProcessEnv,
  operation: string
) {
  return {
    args: raw.args,
    command: yield* validateCommand(raw.command, root, environment, operation),
    environment: yield* validateEnvironmentNames(raw.environment, operation),
  } satisfies ProcessCommandConfig;
});

const readConfig = async (root: string): Promise<string> => {
  const path = resolve(root, "laborer.json");
  const retainedRoot = await retainTrustedDirectory(
    root,
    "read-laborer-config"
  );
  try {
    await assertSafeFilePath({
      anchor: root,
      operation: "read-laborer-config",
      path,
    });
    const file = await openRegularFileNoFollow(path, "read-laborer-config");
    try {
      const source = fatalUtf8Decoder.decode(await file.readFile());
      await verifyRetainedDirectory(retainedRoot, "read-laborer-config");
      return source;
    } finally {
      await file.close();
    }
  } finally {
    await retainedRoot.handle.close();
  }
};

export const loadLaborerConfig = Effect.fn("loadLaborerConfig")(
  function* (options: {
    readonly defaultRoot: string;
    readonly environment?: NodeJS.ProcessEnv;
  }) {
    const environment = options.environment ?? process.env;
    const configuredRoot = Object.hasOwn(environment, "LABORER_ROOT")
      ? environment.LABORER_ROOT
      : options.defaultRoot;
    if (configuredRoot === undefined || configuredRoot.trim().length === 0) {
      return yield* configFailure("resolve-root", "root-blank");
    }
    const root = yield* Effect.tryPromise({
      try: async () => {
        await assertNoSymlinkPathComponents(
          configuredRoot,
          "resolve-laborer-root"
        );
        return await canonicalDirectory(configuredRoot, "resolve-laborer-root");
      },
      catch: () => configFailure("resolve-root", "root-unsafe-or-unavailable"),
    });
    const source = yield* Effect.tryPromise({
      try: () => readConfig(root),
      catch: () => configFailure("read-config", "config-unavailable"),
    });
    const rawConfig = yield* Schema.decodeUnknownEffect(LaborerConfigFromJson, {
      onExcessProperty: "error",
    })(source).pipe(
      Effect.mapError(() => configFailure("parse-config", "invalid-config"))
    );
    const hasApplication = rawConfig.application !== undefined;
    const hasWorkHandler = rawConfig.workHandler !== undefined;
    if (hasApplication === hasWorkHandler) {
      return yield* configFailure("parse-config", "invalid-config");
    }
    if (rawConfig.application !== undefined) {
      const rawConversation = rawConfig.application.conversation;
      const conversation: ConversationApplicationConfig | undefined =
        rawConversation === undefined
          ? undefined
          : Object.freeze({
              instructions: Object.freeze([...rawConversation.instructions]),
              operationResultInstructions: Object.freeze([
                ...rawConversation.operationResultInstructions,
              ]),
            });
      const application: ReferenceCodingApplicationConfig = {
        ...(rawConfig.application.agent === undefined
          ? {}
          : { agent: rawConfig.application.agent }),
        ...(conversation === undefined ? {} : { conversation }),
        environment: yield* validateEnvironmentNames(
          rawConfig.application.environment,
          "validate-reference-coding-application"
        ),
        ...(rawConfig.application.model === undefined
          ? {}
          : { model: rawConfig.application.model }),
        type: "reference-coding",
      };
      const { workHandler: _workHandler, ...retainedConfig } = rawConfig;
      const config: LaborerConfig = {
        ...retainedConfig,
        application,
      };
      return { config, root };
    }
    const rawWorkHandler = rawConfig.workHandler;
    if (rawWorkHandler === undefined) {
      return yield* configFailure("parse-config", "invalid-config");
    }
    const validatedWorkHandler = yield* validateProcessCommand(
      rawWorkHandler,
      root,
      environment,
      "validate-work-handler"
    );
    const initialize =
      rawWorkHandler.initialize === undefined
        ? undefined
        : yield* validateProcessCommand(
            rawWorkHandler.initialize,
            root,
            environment,
            "validate-work-handler-initializer"
          );
    const workHandler = {
      ...validatedWorkHandler,
      ...(initialize === undefined ? {} : { initialize }),
    } satisfies WorkHandlerConfig;
    const { application: _application, ...retainedConfig } = rawConfig;
    const config: LaborerConfig = { ...retainedConfig, workHandler };
    return {
      config,
      root,
    };
  }
);
