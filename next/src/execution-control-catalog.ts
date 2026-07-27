import { createHash } from "node:crypto";
import { Effect, Schema } from "effect";
import type { JsonSchema } from "effect/JsonSchema";
import {
  ACTION_PROMPT_MAX_LENGTH,
  ActionLifecycleStatus,
  canonicalCatalogJson,
  SafeWorktreeName,
} from "./action-catalog.ts";

export const EXECUTION_CONTROL_CATALOG_CONTRACT_VERSION = 1;
export const EXECUTION_CONTROL_ID_MAX_LENGTH = 160;
export const EXECUTION_INSPECTION_MAX_LIMIT = 20;

export const OpaqueExecutionId = Schema.String.check(
  Schema.isPattern(/\S/),
  Schema.isMaxLength(EXECUTION_CONTROL_ID_MAX_LENGTH)
).annotate({ description: "Opaque Laborer Execution identifier." });

export const PromptExecutionControlInput = Schema.Struct({
  executionId: OpaqueExecutionId,
  prompt: Schema.String.check(
    Schema.isPattern(/\S/),
    Schema.isMaxLength(ACTION_PROMPT_MAX_LENGTH)
  ).annotate({
    description:
      "The bounded, nonblank follow-up request. Whitespace is preserved.",
  }),
});
export type PromptExecutionControlInput =
  typeof PromptExecutionControlInput.Type;

export const PromptExecutionControlResult = Schema.Struct({
  deduplicated: Schema.Boolean,
  executionId: OpaqueExecutionId,
  status: ActionLifecycleStatus,
});
export type PromptExecutionControlResult =
  typeof PromptExecutionControlResult.Type;

export const SafeExecutionStatus = Schema.Literals([
  "starting",
  "running",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
]);

export const SafeExecutionSnapshot = Schema.Struct({
  actionName: Schema.Literals(["create-feature", "deal-with-bug"]),
  canCancel: Schema.Boolean,
  canPrompt: Schema.Boolean,
  executionId: OpaqueExecutionId,
  status: SafeExecutionStatus,
  worktreeName: SafeWorktreeName,
});
export type SafeExecutionSnapshot = typeof SafeExecutionSnapshot.Type;

export const InspectExecutionsInput = Schema.Struct({
  executionId: Schema.optional(OpaqueExecutionId),
  limit: Schema.optional(
    Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(EXECUTION_INSPECTION_MAX_LIMIT)
    )
  ),
});
export type InspectExecutionsInput = typeof InspectExecutionsInput.Type;

export const InspectExecutionsResult = Schema.Struct({
  executions: Schema.Array(SafeExecutionSnapshot).check(
    Schema.isMaxLength(EXECUTION_INSPECTION_MAX_LIMIT)
  ),
  schemaVersion: Schema.Literal(1),
  truncated: Schema.Boolean,
});
export type InspectExecutionsResult = typeof InspectExecutionsResult.Type;

export const CancelExecutionInput = Schema.Struct({
  executionId: OpaqueExecutionId,
});
export type CancelExecutionInput = typeof CancelExecutionInput.Type;

export const CancelExecutionResult = Schema.Struct({
  deduplicated: Schema.Boolean,
  execution: Schema.Struct({
    actionName: Schema.Literals(["create-feature", "deal-with-bug"]),
    canCancel: Schema.Literal(false),
    canPrompt: Schema.Literal(false),
    executionId: OpaqueExecutionId,
    status: Schema.Literal("cancelled"),
    worktreeName: SafeWorktreeName,
  }),
  schemaVersion: Schema.Literal(1),
});
export type CancelExecutionResult = typeof CancelExecutionResult.Type;

export const ExecutionControlHandlerKey = Schema.Literals([
  "cancel-execution",
  "inspect-executions",
  "prompt-execution",
]);
export type ExecutionControlHandlerKey = typeof ExecutionControlHandlerKey.Type;

export class ExecutionControlCatalogValidationError extends Schema.TaggedErrorClass<ExecutionControlCatalogValidationError>()(
  "ExecutionControlCatalogValidationError",
  { boundary: Schema.Literals(["catalog", "input", "result"]) }
) {}

const validationError = (
  boundary: ExecutionControlCatalogValidationError["boundary"]
): ExecutionControlCatalogValidationError =>
  ExecutionControlCatalogValidationError.make({ boundary });

const jsonSchemaFor = (schema: Schema.Top): JsonSchema => {
  const document = Schema.toJsonSchemaDocument(schema);
  return Object.keys(document.definitions).length === 0
    ? document.schema
    : { ...document.schema, $defs: document.definitions };
};

export interface ProductionExecutionControlDefinition<
  Name extends string = string,
> {
  readonly annotations: {
    readonly destructiveHint: boolean;
    readonly idempotentHint: boolean;
    readonly openWorldHint: boolean;
    readonly readOnlyHint: boolean;
  };
  readonly decodeInput: (
    input: unknown
  ) => Effect.Effect<unknown, ExecutionControlCatalogValidationError>;
  readonly decodeResult: (
    result: unknown
  ) => Effect.Effect<unknown, ExecutionControlCatalogValidationError>;
  readonly description: string;
  readonly encodeResult: (
    result: unknown
  ) => Effect.Effect<unknown, ExecutionControlCatalogValidationError>;
  readonly handlerKey: ExecutionControlHandlerKey;
  readonly inputJsonSchema: JsonSchema;
  readonly inputSchema: Schema.Top;
  readonly name: Name;
  readonly outputJsonSchema: JsonSchema;
  readonly resultSchema: Schema.Top;
}

const promptExecutionDefinition: ProductionExecutionControlDefinition<"prompt-execution"> =
  {
    annotations: {
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: false,
    },
    decodeInput: (input) =>
      Schema.decodeUnknownEffect(PromptExecutionControlInput, {
        onExcessProperty: "error",
      })(input).pipe(Effect.mapError(() => validationError("input"))),
    decodeResult: (result) =>
      Schema.decodeUnknownEffect(PromptExecutionControlResult, {
        onExcessProperty: "error",
      })(result).pipe(Effect.mapError(() => validationError("result"))),
    description:
      "Send one durable follow-up prompt to an owned running or completed Execution. The same Execution, implementation session, and worktree are reused.",
    encodeResult: (result) =>
      Schema.decodeUnknownEffect(PromptExecutionControlResult, {
        onExcessProperty: "error",
      })(result).pipe(
        Effect.flatMap((decoded) =>
          Schema.encodeUnknownEffect(PromptExecutionControlResult)(decoded)
        ),
        Effect.mapError(() => validationError("result"))
      ),
    handlerKey: "prompt-execution",
    inputJsonSchema: jsonSchemaFor(PromptExecutionControlInput),
    inputSchema: PromptExecutionControlInput,
    name: "prompt-execution",
    outputJsonSchema: jsonSchemaFor(PromptExecutionControlResult),
    resultSchema: PromptExecutionControlResult,
  };

const inspectExecutionsDefinition: ProductionExecutionControlDefinition<"inspect-executions"> =
  {
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
    decodeInput: (input) =>
      Schema.decodeUnknownEffect(InspectExecutionsInput, {
        onExcessProperty: "error",
      })(input).pipe(Effect.mapError(() => validationError("input"))),
    decodeResult: (result) =>
      Schema.decodeUnknownEffect(InspectExecutionsResult, {
        onExcessProperty: "error",
      })(result).pipe(Effect.mapError(() => validationError("result"))),
    description:
      "Inspect a deterministic bounded list of safe lifecycle snapshots for Executions owned by the current Conversation.",
    encodeResult: (result) =>
      Schema.decodeUnknownEffect(InspectExecutionsResult, {
        onExcessProperty: "error",
      })(result).pipe(
        Effect.flatMap((decoded) =>
          Schema.encodeUnknownEffect(InspectExecutionsResult)(decoded)
        ),
        Effect.mapError(() => validationError("result"))
      ),
    handlerKey: "inspect-executions",
    inputJsonSchema: jsonSchemaFor(InspectExecutionsInput),
    inputSchema: InspectExecutionsInput,
    name: "inspect-executions",
    outputJsonSchema: jsonSchemaFor(InspectExecutionsResult),
    resultSchema: InspectExecutionsResult,
  };

const cancelExecutionDefinition: ProductionExecutionControlDefinition<"cancel-execution"> =
  {
    annotations: {
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: false,
    },
    decodeInput: (input) =>
      Schema.decodeUnknownEffect(CancelExecutionInput, {
        onExcessProperty: "error",
      })(input).pipe(Effect.mapError(() => validationError("input"))),
    decodeResult: (result) =>
      Schema.decodeUnknownEffect(CancelExecutionResult, {
        onExcessProperty: "error",
      })(result).pipe(Effect.mapError(() => validationError("result"))),
    description:
      "Durably cancel one active Execution owned by the current Conversation while preserving its worktree.",
    encodeResult: (result) =>
      Schema.decodeUnknownEffect(CancelExecutionResult, {
        onExcessProperty: "error",
      })(result).pipe(
        Effect.flatMap((decoded) =>
          Schema.encodeUnknownEffect(CancelExecutionResult)(decoded)
        ),
        Effect.mapError(() => validationError("result"))
      ),
    handlerKey: "cancel-execution",
    inputJsonSchema: jsonSchemaFor(CancelExecutionInput),
    inputSchema: CancelExecutionInput,
    name: "cancel-execution",
    outputJsonSchema: jsonSchemaFor(CancelExecutionResult),
    resultSchema: CancelExecutionResult,
  };

const controls = [
  cancelExecutionDefinition,
  inspectExecutionsDefinition,
  promptExecutionDefinition,
] as const;
const tools = controls.map((control) => ({
  annotations: control.annotations,
  description: control.description,
  inputSchema: control.inputJsonSchema,
  name: control.name,
  outputSchema: control.outputJsonSchema,
}));

export const productionExecutionControlCatalog = {
  contractVersion: EXECUTION_CONTROL_CATALOG_CONTRACT_VERSION,
  controls,
  fingerprint: createHash("sha256")
    .update("laborer-execution-control-catalog-v1\0", "utf8")
    .update(
      canonicalCatalogJson({
        contractVersion: EXECUTION_CONTROL_CATALOG_CONTRACT_VERSION,
        routing: controls.map(({ handlerKey, name }) => ({ handlerKey, name })),
        tools,
      }),
      "utf8"
    )
    .digest("base64url"),
  tools,
} as const;

export const executionControlDefinition = (
  name: string
): ProductionExecutionControlDefinition | undefined =>
  productionExecutionControlCatalog.controls.find(
    (control) => control.name === name
  );

export const executionCancelOperationId = (scope: {
  readonly conversationId: string;
  readonly executionId: string;
  readonly workspaceId: string;
}): string =>
  `execution-cancel:${createHash("sha256")
    .update("laborer-execution-cancel-operation-v1\0", "utf8")
    .update(canonicalCatalogJson({ ...scope, control: "cancel" }), "utf8")
    .digest("base64url")}`;
