import { createHash } from "node:crypto";
import { Effect, Schema } from "effect";
import type { JsonSchema } from "effect/JsonSchema";
import {
  canonicalBoundedActionValue,
  ACTION_CANONICAL_MAX_BYTES as SHARED_ACTION_CANONICAL_MAX_BYTES,
  ACTION_CANONICAL_MAX_DEPTH as SHARED_ACTION_CANONICAL_MAX_DEPTH,
  ACTION_CANONICAL_MAX_ITEMS as SHARED_ACTION_CANONICAL_MAX_ITEMS,
  canonicalCatalogJson as sharedCanonicalCatalogJson,
} from "./bounded-action-value.ts";
import { ActionTitle } from "./task-db/execution-task-emitter.ts";

export const ACTION_CANONICAL_MAX_BYTES = SHARED_ACTION_CANONICAL_MAX_BYTES;
export const ACTION_CANONICAL_MAX_DEPTH = SHARED_ACTION_CANONICAL_MAX_DEPTH;
export const ACTION_CANONICAL_MAX_ITEMS = SHARED_ACTION_CANONICAL_MAX_ITEMS;
export const canonicalCatalogJson = sharedCanonicalCatalogJson;

export const ACTION_PROMPT_MAX_LENGTH = 32_768;
export const ACTION_CATALOG_CONTRACT_VERSION = 1;
export const WORKTREE_NAME_MAX_LENGTH = 64;
export const SAFE_WORKTREE_NAME_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;

export const SafeWorktreeName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(WORKTREE_NAME_MAX_LENGTH),
  Schema.isPattern(SAFE_WORKTREE_NAME_PATTERN),
  Schema.makeFilter((value) => !value.includes("..")),
  Schema.makeFilter((value) => !value.toLowerCase().endsWith(".lock"))
).annotate({
  description:
    "A safe worktree name containing only letters, digits, dots, underscores, and hyphens.",
});

export const CreateFeatureActionInput = Schema.Struct({
  prompt: Schema.String.check(
    Schema.isPattern(/\S/),
    Schema.isMaxLength(ACTION_PROMPT_MAX_LENGTH)
  ).annotate({
    description:
      "The bounded, nonblank implementation request. Whitespace is preserved.",
  }),
  title: ActionTitle,
  worktreeName: SafeWorktreeName,
});
export type CreateFeatureActionInput = typeof CreateFeatureActionInput.Type;

export const DealWithBugActionInput = CreateFeatureActionInput;
export type DealWithBugActionInput = typeof DealWithBugActionInput.Type;

export const ActionLifecycleStatus = Schema.Literals([
  "starting",
  "running",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
]);
export type ActionLifecycleStatus = typeof ActionLifecycleStatus.Type;

export const CreateFeatureActionResult = Schema.Struct({
  actionName: Schema.Literal("create-feature"),
  deduplicated: Schema.Boolean,
  executionId: Schema.String.check(
    Schema.isPattern(/\S/),
    Schema.isMaxLength(160)
  ).annotate({ description: "Opaque Laborer Execution identifier." }),
  status: ActionLifecycleStatus,
});
export type CreateFeatureActionResult = typeof CreateFeatureActionResult.Type;

export const DealWithBugActionResult = Schema.Struct({
  actionName: Schema.Literal("deal-with-bug"),
  deduplicated: Schema.Boolean,
  executionId: Schema.String.check(
    Schema.isPattern(/\S/),
    Schema.isMaxLength(160)
  ).annotate({ description: "Opaque Laborer bug Execution identifier." }),
  status: ActionLifecycleStatus,
});
export type DealWithBugActionResult = typeof DealWithBugActionResult.Type;
export type ProductionActionResult =
  | CreateFeatureActionResult
  | DealWithBugActionResult;

export const ActionHandlerKey = Schema.Literals([
  "create-feature",
  "deal-with-bug",
]);
export type ActionHandlerKey = typeof ActionHandlerKey.Type;

export interface ProductionActionDefinition<Name extends string = string> {
  readonly annotations: {
    readonly destructiveHint: boolean;
    readonly idempotentHint: boolean;
    readonly openWorldHint: boolean;
    readonly readOnlyHint: boolean;
  };
  readonly decodeInput: (
    input: unknown
  ) => Effect.Effect<unknown, ActionCatalogValidationError>;
  readonly decodeResult: (
    result: unknown
  ) => Effect.Effect<unknown, ActionCatalogValidationError>;
  readonly description: string;
  readonly encodeResult: (
    result: unknown
  ) => Effect.Effect<unknown, ActionCatalogValidationError>;
  readonly handlerKey: ActionHandlerKey;
  readonly inputJsonSchema: JsonSchema;
  readonly inputSchema: Schema.Top;
  readonly name: Name;
  readonly outputJsonSchema: JsonSchema;
  readonly resultSchema: Schema.Top;
}

export class ActionCatalogValidationError extends Schema.TaggedErrorClass<ActionCatalogValidationError>()(
  "ActionCatalogValidationError",
  { boundary: Schema.Literals(["catalog", "input", "result"]) }
) {}

const validationError = (
  boundary: ActionCatalogValidationError["boundary"]
): ActionCatalogValidationError =>
  ActionCatalogValidationError.make({ boundary });

const jsonSchemaFor = (schema: Schema.Top): JsonSchema => {
  const document = Schema.toJsonSchemaDocument(schema);
  return Object.keys(document.definitions).length === 0
    ? document.schema
    : { ...document.schema, $defs: document.definitions };
};

const defineProductionAction = <
  const Name extends string,
  Input,
  Result,
>(options: {
  readonly annotations: ProductionActionDefinition["annotations"];
  readonly description: string;
  readonly handlerKey: ActionHandlerKey;
  readonly input: Schema.Codec<Input, unknown>;
  readonly name: Name;
  readonly result: Schema.Codec<Result, unknown>;
}): ProductionActionDefinition<Name> => ({
  annotations: options.annotations,
  decodeInput: (input) =>
    Schema.decodeUnknownEffect(options.input, {
      onExcessProperty: "error",
    })(input).pipe(Effect.mapError(() => validationError("input"))),
  decodeResult: (result) =>
    Schema.decodeUnknownEffect(options.result, {
      onExcessProperty: "error",
    })(result).pipe(Effect.mapError(() => validationError("result"))),
  description: options.description,
  encodeResult: (result) =>
    Schema.decodeUnknownEffect(options.result, {
      onExcessProperty: "error",
    })(result).pipe(
      Effect.flatMap((decoded) =>
        Schema.encodeUnknownEffect(options.result)(decoded)
      ),
      Effect.mapError(() => validationError("result"))
    ),
  handlerKey: options.handlerKey,
  inputJsonSchema: jsonSchemaFor(options.input),
  inputSchema: options.input,
  name: options.name,
  outputJsonSchema: jsonSchemaFor(options.result),
  resultSchema: options.result,
});

export const createFeatureAction = defineProductionAction({
  annotations: {
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: false,
  },
  description:
    "Implement a feature asynchronously in a new isolated named worktree. Returns a bounded Execution snapshot immediately; implementation output and terminal wording return through the owning Conversation.",
  handlerKey: "create-feature",
  input: CreateFeatureActionInput,
  name: "create-feature",
  result: CreateFeatureActionResult,
});

export const dealWithBugAction = defineProductionAction({
  annotations: {
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: false,
  },
  description:
    "Diagnose and fix a bug asynchronously in a new isolated named worktree. Returns a bounded bug Execution snapshot immediately; implementation output and terminal wording return through the owning Conversation.",
  handlerKey: "deal-with-bug",
  input: DealWithBugActionInput,
  name: "deal-with-bug",
  result: DealWithBugActionResult,
});

export interface ProductionActionCatalog<
  Actions extends
    readonly ProductionActionDefinition[] = readonly ProductionActionDefinition[],
> {
  readonly actions: Actions;
  readonly contractVersion: number;
  readonly fingerprint: string;
  readonly tools: readonly {
    readonly annotations: ProductionActionDefinition["annotations"];
    readonly description: string;
    readonly inputSchema: JsonSchema;
    readonly name: string;
    readonly outputSchema: JsonSchema;
  }[];
}

export const makeProductionActionCatalog = <
  const Actions extends readonly ProductionActionDefinition[],
>(
  actions: Actions,
  contractVersion = ACTION_CATALOG_CONTRACT_VERSION
): ProductionActionCatalog<Actions> => {
  if (!Number.isSafeInteger(contractVersion) || contractVersion < 1) {
    throw validationError("catalog");
  }
  const names = new Set<string>();
  const handlerKeys = new Set<string>();
  for (const action of actions) {
    if (names.has(action.name) || handlerKeys.has(action.handlerKey)) {
      throw validationError("catalog");
    }
    names.add(action.name);
    handlerKeys.add(action.handlerKey);
  }
  const tools = actions
    .map((action) => ({
      annotations: action.annotations,
      description: action.description,
      inputSchema: action.inputJsonSchema,
      name: action.name,
      outputSchema: action.outputJsonSchema,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const routing = actions
    .map(({ handlerKey, name }) => ({ handlerKey, name }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const fingerprint = createHash("sha256")
    .update("laborer-action-catalog-v1\0", "utf8")
    .update(
      canonicalCatalogJson({
        contractVersion,
        routing,
        tools,
      }),
      "utf8"
    )
    .digest("base64url");
  return { actions, contractVersion, fingerprint, tools };
};

export const productionActionCatalog = makeProductionActionCatalog([
  createFeatureAction,
  dealWithBugAction,
]);

export const actionDefinition = (
  name: string
): ProductionActionDefinition | undefined =>
  productionActionCatalog.actions.find((action) => action.name === name);

export const canonicalActionInput = (
  input: unknown
): Effect.Effect<string, ActionCatalogValidationError> =>
  Effect.try({
    try: () => canonicalBoundedActionValue(input),
    catch: () => validationError("input"),
  });

export const actionInputHash = Effect.fn("actionInputHash")(function* (
  actionName: string,
  schemaFingerprint: string,
  input: unknown
) {
  const canonical = yield* canonicalActionInput(input);
  return createHash("sha256")
    .update("laborer-action-input-v1\0", "utf8")
    .update(actionName, "utf8")
    .update("\0", "utf8")
    .update(schemaFingerprint, "utf8")
    .update("\0", "utf8")
    .update(canonical, "utf8")
    .digest("base64url");
});
