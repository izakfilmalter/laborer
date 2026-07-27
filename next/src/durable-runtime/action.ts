import { createHash } from "node:crypto";
import {
  Effect,
  Array as EffectArray,
  Option,
  Order,
  pipe,
  Schema,
} from "effect";
import type { JsonSchema } from "effect/JsonSchema";

export const ACTION_NAME_MAX_LENGTH = 96;
export const ACTION_REVISION_MAX_LENGTH = 128;
export const ACTION_DESCRIPTION_MAX_LENGTH = 4096;
export const ACTION_CATALOG_MAX_SIZE = 128;
export const ACTION_SCHEMA_MAX_BYTES = 64 * 1024;
const ACTION_IDENTIFIER_PATTERN =
  /^[a-zA-Z0-9](?:[a-zA-Z0-9._/-]*[a-zA-Z0-9])?$/;

const canonicalCatalogJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (globalThis.Array.isArray(value)) {
    return `[${value.map(canonicalCatalogJson).join(",")}]`;
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => {
      if (left < right) {
        return -1;
      }
      return left > right ? 1 : 0;
    })
    .map(
      ([key, item]) => `${JSON.stringify(key)}:${canonicalCatalogJson(item)}`
    )
    .join(",")}}`;
};

export const ActionRecoveryPolicy = Schema.Literals([
  "fail-closed",
  "idempotent-retry",
]);
export type ActionRecoveryPolicy = typeof ActionRecoveryPolicy.Type;

export interface RegisteredActionAnnotations {
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
  readonly readOnlyHint: boolean;
}

export interface RegisteredActionContext {
  readonly conversationId: string;
  readonly executionId: string;
  readonly reportProgress: (payload: unknown) => Effect.Effect<void, unknown>;
  readonly rootIdentity: string;
}

export interface RegisteredAction<Name extends string = string> {
  readonly annotations: RegisteredActionAnnotations;
  readonly decodeInput: (
    input: unknown
  ) => Effect.Effect<unknown, ActionRegistrationError>;
  readonly decodeResult: (
    result: unknown
  ) => Effect.Effect<unknown, ActionRegistrationError>;
  readonly description: string;
  readonly execute: (
    input: unknown,
    context: RegisteredActionContext
  ) => Effect.Effect<unknown, unknown>;
  readonly inputJsonSchema: JsonSchema;
  readonly inputSchema: Schema.Top;
  readonly name: Name;
  readonly recoveryPolicy: ActionRecoveryPolicy;
  readonly resultJsonSchema: JsonSchema;
  readonly resultSchema: Schema.Top;
  readonly revision: string;
}

export class ActionRegistrationError extends Schema.TaggedErrorClass<ActionRegistrationError>()(
  "ActionRegistrationError",
  {
    reason: Schema.Literals([
      "catalog-too-large",
      "duplicate-name",
      "invalid-input",
      "invalid-metadata",
      "invalid-result",
      "unknown-action",
      "unavailable-revision",
    ]),
  }
) {}

const registrationError = (
  reason: ActionRegistrationError["reason"]
): ActionRegistrationError => ActionRegistrationError.make({ reason });

const jsonSchemaFor = (schema: Schema.Top): JsonSchema => {
  try {
    const document = Schema.toJsonSchemaDocument(schema);
    const jsonSchema =
      Object.keys(document.definitions).length === 0
        ? document.schema
        : { ...document.schema, $defs: document.definitions };
    if (
      Buffer.byteLength(canonicalCatalogJson(jsonSchema), "utf8") >
      ACTION_SCHEMA_MAX_BYTES
    ) {
      throw registrationError("invalid-metadata");
    }
    return jsonSchema;
  } catch (error) {
    if (error instanceof ActionRegistrationError) {
      throw error;
    }
    throw registrationError("invalid-metadata");
  }
};

interface DefineActionOptions<Name extends string, Input, Result, Error> {
  readonly annotations?: Partial<RegisteredActionAnnotations>;
  readonly description: string;
  readonly input: Schema.Codec<Input, unknown>;
  readonly name: Name;
  readonly recoveryPolicy?: ActionRecoveryPolicy;
  readonly result: Schema.Codec<Result, unknown>;
  readonly revision: string;
  readonly run: (
    input: Input,
    context: RegisteredActionContext
  ) => Effect.Effect<Result, Error>;
}

const validIdentifier = (value: unknown, maximumLength: number): boolean =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= maximumLength &&
  ACTION_IDENTIFIER_PATTERN.test(value);

export const defineAction = <const Name extends string, Input, Result, Error>(
  options: DefineActionOptions<Name, Input, Result, Error>
): RegisteredAction<Name> => {
  if (
    !(
      validIdentifier(options.name, ACTION_NAME_MAX_LENGTH) &&
      validIdentifier(options.revision, ACTION_REVISION_MAX_LENGTH)
    ) ||
    typeof options.description !== "string" ||
    options.description.trim().length === 0 ||
    options.description.length > ACTION_DESCRIPTION_MAX_LENGTH
  ) {
    throw registrationError("invalid-metadata");
  }
  const suppliedAnnotations = options.annotations;
  if (
    suppliedAnnotations !== undefined &&
    (Object.keys(suppliedAnnotations).some(
      (key) =>
        key !== "destructiveHint" &&
        key !== "idempotentHint" &&
        key !== "openWorldHint" &&
        key !== "readOnlyHint"
    ) ||
      Object.values(suppliedAnnotations).some(
        (annotation) =>
          annotation !== undefined && typeof annotation !== "boolean"
      ))
  ) {
    throw registrationError("invalid-metadata");
  }
  const annotations: RegisteredActionAnnotations = {
    destructiveHint: options.annotations?.destructiveHint ?? false,
    idempotentHint: options.annotations?.idempotentHint ?? false,
    openWorldHint: options.annotations?.openWorldHint ?? true,
    readOnlyHint: options.annotations?.readOnlyHint ?? false,
  };
  const recoveryPolicy = options.recoveryPolicy ?? "fail-closed";
  if (
    recoveryPolicy !== "fail-closed" &&
    recoveryPolicy !== "idempotent-retry"
  ) {
    throw registrationError("invalid-metadata");
  }
  if (recoveryPolicy === "idempotent-retry" && !annotations.idempotentHint) {
    throw registrationError("invalid-metadata");
  }
  return {
    annotations,
    decodeInput: (input) =>
      Schema.decodeUnknownEffect(options.input, { onExcessProperty: "error" })(
        input
      ).pipe(Effect.mapError(() => registrationError("invalid-input"))),
    decodeResult: (result) =>
      Schema.decodeUnknownEffect(options.result, { onExcessProperty: "error" })(
        result
      ).pipe(Effect.mapError(() => registrationError("invalid-result"))),
    description: options.description,
    execute: (input, context) =>
      Schema.decodeUnknownEffect(options.input, { onExcessProperty: "error" })(
        input
      ).pipe(
        Effect.mapError(() => registrationError("invalid-input")),
        Effect.flatMap((decoded) => options.run(decoded, context)),
        Effect.flatMap((result) =>
          Schema.encodeUnknownEffect(options.result)(result).pipe(
            Effect.flatMap((encoded) =>
              Schema.decodeUnknownEffect(options.result, {
                onExcessProperty: "error",
              })(encoded)
            ),
            Effect.mapError(() => registrationError("invalid-result"))
          )
        )
      ),
    inputJsonSchema: jsonSchemaFor(options.input),
    inputSchema: options.input,
    name: options.name,
    recoveryPolicy,
    resultJsonSchema: jsonSchemaFor(options.result),
    resultSchema: options.result,
    revision: options.revision,
  };
};

export interface RegisteredActionCatalog {
  readonly actions: readonly RegisteredAction[];
  readonly fingerprint: string;
  readonly get: (
    name: string,
    revision?: string
  ) => Effect.Effect<RegisteredAction, ActionRegistrationError>;
  readonly tools: readonly {
    readonly annotations: RegisteredActionAnnotations;
    readonly description: string;
    readonly inputSchema: JsonSchema;
    readonly name: string;
    readonly outputSchema: JsonSchema;
    readonly revision: string;
  }[];
}

export const makeActionCatalog = (
  actions: readonly RegisteredAction[]
): RegisteredActionCatalog => {
  if (actions.length > ACTION_CATALOG_MAX_SIZE) {
    throw registrationError("catalog-too-large");
  }
  const ordered = pipe(
    actions,
    EffectArray.sort(
      Order.mapInput(Order.String, (action: RegisteredAction) => action.name)
    )
  );
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index - 1]?.name === ordered[index]?.name) {
      throw registrationError("duplicate-name");
    }
  }
  const tools = pipe(
    ordered,
    EffectArray.map((action) => ({
      annotations: action.annotations,
      description: action.description,
      inputSchema: action.inputJsonSchema,
      name: action.name,
      outputSchema: action.resultJsonSchema,
      revision: action.revision,
    }))
  );
  const fingerprint = createHash("sha256")
    .update("laborer-registered-action-catalog-v1\0", "utf8")
    .update(
      canonicalCatalogJson(
        pipe(
          ordered,
          EffectArray.map((action) => ({
            annotations: action.annotations,
            inputSchema: action.inputJsonSchema,
            name: action.name,
            outputSchema: action.resultJsonSchema,
            recoveryPolicy: action.recoveryPolicy,
            revision: action.revision,
          }))
        )
      ),
      "utf8"
    )
    .digest("base64url");
  return {
    actions: ordered,
    fingerprint,
    get: (name, revision) =>
      pipe(
        ordered,
        EffectArray.findFirst((action) => action.name === name),
        Option.match({
          onNone: () => Effect.fail(registrationError("unknown-action")),
          onSome: (action) =>
            revision === undefined || action.revision === revision
              ? Effect.succeed(action)
              : Effect.fail(registrationError("unavailable-revision")),
        })
      ),
    tools,
  };
};

export interface LaborerApplication {
  readonly actions: RegisteredActionCatalog;
}

export const defineApplication = (options: {
  readonly actions: readonly RegisteredAction[];
}): LaborerApplication => ({ actions: makeActionCatalog(options.actions) });
