import { createHash } from "node:crypto";
import { Effect, Schema } from "effect";
import type { JsonSchema } from "effect/JsonSchema";
import {
  canonicalBoundedActionValue,
  canonicalCatalogJson,
} from "../bounded-action-value.ts";

export const REGISTERED_ACTION_CATALOG_VERSION = 1;
export const MAX_REGISTERED_ACTIONS = 64;
export const MAX_ACTION_DESCRIPTION_BYTES = 4096;
export const MAX_ACTION_SCHEMA_BYTES = 64 * 1024;

const ACTION_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MAX_ACTION_NAME_LENGTH = 64;
const MAX_ACTION_REVISION_LENGTH = 128;
const ANNOTATION_KEYS = [
  "destructiveHint",
  "idempotentHint",
  "openWorldHint",
  "readOnlyHint",
] as const;

export interface RegisteredActionAnnotations {
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
  readonly readOnlyHint: boolean;
}

export interface RegisteredActionProgress {
  readonly details?: unknown;
  readonly message: string;
}

export interface RegisteredActionContext {
  readonly actionName: string;
  readonly actionRevision: string;
  readonly catalogFingerprint: string;
  readonly conversationId: string;
  readonly executionId: string;
  readonly reportProgress: (
    progress: RegisteredActionProgress
  ) => Effect.Effect<void, RegisteredActionBoundaryError>;
}

export class RegisteredActionCatalogError extends Schema.TaggedErrorClass<RegisteredActionCatalogError>()(
  "RegisteredActionCatalogError",
  { reason: Schema.Literals(["duplicate", "invalid", "schema"]) }
) {}

export class RegisteredActionBoundaryError extends Schema.TaggedErrorClass<RegisteredActionBoundaryError>()(
  "RegisteredActionBoundaryError",
  { boundary: Schema.Literals(["input", "progress", "result"]) }
) {}

const catalogError = (
  reason: RegisteredActionCatalogError["reason"]
): RegisteredActionCatalogError =>
  RegisteredActionCatalogError.make({ reason });

const boundaryError = (
  boundary: RegisteredActionBoundaryError["boundary"]
): RegisteredActionBoundaryError =>
  RegisteredActionBoundaryError.make({ boundary });

const schemaProjection = (schema: Schema.Top): JsonSchema => {
  try {
    const document = Schema.toJsonSchemaDocument(schema);
    const projected =
      Object.keys(document.definitions).length === 0
        ? document.schema
        : { ...document.schema, $defs: document.definitions };
    const record = projected as Record<string, unknown>;
    if (
      record.type !== "object" ||
      record.additionalProperties !== false ||
      Buffer.byteLength(canonicalCatalogJson(projected), "utf8") >
        MAX_ACTION_SCHEMA_BYTES
    ) {
      throw new Error("Action schemas must project to bounded closed objects");
    }
    return projected;
  } catch {
    throw catalogError("schema");
  }
};

const assertBoundedMetadata = (options: {
  readonly annotations: RegisteredActionAnnotations;
  readonly description: string;
  readonly name: string;
  readonly revision: string;
}): void => {
  const annotationKeys = Object.keys(options.annotations).sort();
  if (
    !ACTION_NAME_PATTERN.test(options.name) ||
    options.name.length > MAX_ACTION_NAME_LENGTH ||
    options.description.trim().length === 0 ||
    Buffer.byteLength(options.description, "utf8") >
      MAX_ACTION_DESCRIPTION_BYTES ||
    options.revision.trim().length === 0 ||
    Buffer.byteLength(options.revision, "utf8") > MAX_ACTION_REVISION_LENGTH ||
    annotationKeys.length !== ANNOTATION_KEYS.length ||
    annotationKeys.some((key, index) => key !== ANNOTATION_KEYS[index]) ||
    Object.values(options.annotations).some(
      (value) => typeof value !== "boolean"
    )
  ) {
    throw catalogError("invalid");
  }
};

export interface RegisteredActionDefinition<Name extends string = string> {
  readonly annotations: RegisteredActionAnnotations;
  readonly decodeInput: (
    input: unknown
  ) => Effect.Effect<unknown, RegisteredActionBoundaryError>;
  readonly description: string;
  readonly execute: (
    input: unknown,
    context: RegisteredActionContext
  ) => Effect.Effect<unknown, unknown>;
  readonly inputJsonSchema: JsonSchema;
  readonly inputSchema: Schema.Top;
  readonly name: Name;
  readonly prepareInput: (
    input: unknown
  ) => Effect.Effect<unknown, RegisteredActionBoundaryError>;
  readonly resultJsonSchema: JsonSchema;
  readonly resultSchema: Schema.Top;
  readonly revision: string;
}

export const defineRegisteredAction = <
  const Name extends string,
  Input,
  Result,
  Error,
>(options: {
  readonly annotations: RegisteredActionAnnotations;
  readonly description: string;
  readonly input: Schema.Codec<Input, unknown>;
  readonly name: Name;
  readonly result: Schema.Codec<Result, unknown>;
  readonly revision: string;
  readonly run: (
    input: Input,
    context: RegisteredActionContext
  ) => Effect.Effect<Result, Error>;
}): RegisteredActionDefinition<Name> => {
  assertBoundedMetadata(options);
  const inputJsonSchema = schemaProjection(options.input);
  const resultJsonSchema = schemaProjection(options.result);
  const decodeInput = (input: unknown) =>
    Schema.decodeUnknownEffect(options.input, {
      onExcessProperty: "error",
    })(input).pipe(Effect.mapError(() => boundaryError("input")));
  const prepareInput = (input: unknown) =>
    decodeInput(input).pipe(
      Effect.flatMap((decoded) =>
        Schema.encodeUnknownEffect(options.input)(decoded)
      ),
      Effect.mapError(() => boundaryError("input"))
    );

  return {
    annotations: { ...options.annotations },
    decodeInput,
    description: options.description,
    execute: (input, context) =>
      Effect.gen(function* () {
        const decoded = yield* decodeInput(input);
        const result = yield* options.run(decoded, context);
        const validated = yield* Schema.decodeUnknownEffect(options.result, {
          onExcessProperty: "error",
        })(result).pipe(Effect.mapError(() => boundaryError("result")));
        return yield* Schema.encodeUnknownEffect(options.result)(
          validated
        ).pipe(Effect.mapError(() => boundaryError("result")));
      }),
    inputJsonSchema,
    inputSchema: options.input,
    name: options.name,
    prepareInput,
    resultJsonSchema,
    resultSchema: options.result,
    revision: options.revision,
  };
};

export interface RegisteredActionCatalog {
  readonly actions: readonly RegisteredActionDefinition[];
  readonly fingerprint: string;
  readonly modelTools: RegisteredActionCatalog["privateTools"];
  readonly privateTools: readonly {
    readonly annotations: RegisteredActionAnnotations;
    readonly description: string;
    readonly inputSchema: JsonSchema;
    readonly name: string;
    readonly outputSchema: JsonSchema;
  }[];
  readonly require: (
    name: string,
    revision?: string
  ) => Effect.Effect<RegisteredActionDefinition, RegisteredActionCatalogError>;
}

export const makeRegisteredActionCatalog = (
  actions: readonly RegisteredActionDefinition[]
): RegisteredActionCatalog => {
  if (actions.length === 0 || actions.length > MAX_REGISTERED_ACTIONS) {
    throw catalogError("invalid");
  }
  const byName = new Map<string, RegisteredActionDefinition>();
  const schemasByName = new Map<
    string,
    { readonly input: JsonSchema; readonly result: JsonSchema }
  >();
  for (const action of actions) {
    assertBoundedMetadata(action);
    if (
      typeof action.decodeInput !== "function" ||
      typeof action.execute !== "function" ||
      typeof action.prepareInput !== "function"
    ) {
      throw catalogError("invalid");
    }
    if (byName.has(action.name)) {
      throw catalogError("duplicate");
    }
    byName.set(action.name, action);
    schemasByName.set(action.name, {
      input: schemaProjection(action.inputSchema),
      result: schemaProjection(action.resultSchema),
    });
  }
  const registrations = [...actions]
    .map((action) => {
      const schemas = schemasByName.get(action.name);
      if (schemas === undefined) {
        throw catalogError("schema");
      }
      return {
        annotations: action.annotations,
        description: action.description,
        inputSchema: schemas.input,
        name: action.name,
        outputSchema: schemas.result,
        revision: action.revision,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  const fingerprint = createHash("sha256")
    .update("laborer-registered-action-catalog-v1\0", "utf8")
    .update(
      canonicalCatalogJson({
        registrations: registrations.map(
          ({ annotations, inputSchema, name, outputSchema, revision }) => ({
            annotations,
            inputSchema,
            name,
            outputSchema,
            revision,
          })
        ),
        version: REGISTERED_ACTION_CATALOG_VERSION,
      }),
      "utf8"
    )
    .digest("base64url");
  const privateTools = registrations.map(
    ({ annotations, description, inputSchema, name, outputSchema }) => ({
      annotations,
      description,
      inputSchema,
      name,
      outputSchema,
    })
  );

  return {
    actions: [...actions],
    fingerprint,
    modelTools: privateTools,
    privateTools,
    require: (name, revision) => {
      const action = byName.get(name);
      return action !== undefined &&
        (revision === undefined || revision === action.revision)
        ? Effect.succeed(action)
        : Effect.fail(catalogError("invalid"));
    },
  };
};

export const validateDurableActionValue = (
  value: unknown,
  boundary: RegisteredActionBoundaryError["boundary"]
): Effect.Effect<string, RegisteredActionBoundaryError> =>
  Effect.try({
    try: () => canonicalBoundedActionValue(value),
    catch: () => boundaryError(boundary),
  });
