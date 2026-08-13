import { Effect, Schema } from 'effect'
import type { JsonSchema } from 'effect/JsonSchema'
import {
  ExecutionControlReceipt,
  type RootDurableRuntimeShape,
  RUNTIME_FOLLOW_UP_MAX_LENGTH,
  RuntimeControlId,
  RuntimeExecutionId,
} from './root-runtime.ts'

const InspectInput = Schema.Struct({
  controlId: RuntimeControlId,
  executionId: RuntimeExecutionId,
})
const FollowUpInput = Schema.Struct({
  content: Schema.String.check(
    Schema.isPattern(/\S/),
    Schema.isMaxLength(RUNTIME_FOLLOW_UP_MAX_LENGTH)
  ),
  controlId: RuntimeControlId,
  executionId: RuntimeExecutionId,
})
const CancelInput = InspectInput

const jsonSchemaFor = (schema: Schema.Top): JsonSchema => {
  const document = Schema.toJsonSchemaDocument(schema)
  return Object.keys(document.definitions).length === 0
    ? document.schema
    : { ...document.schema, $defs: document.definitions }
}

interface ExecutionControlTool {
  readonly annotations: {
    readonly destructiveHint: boolean
    readonly idempotentHint: true
    readonly openWorldHint: false
    readonly readOnlyHint: boolean
  }
  readonly description: string
  readonly inputSchema: JsonSchema
  readonly invoke: (
    input: unknown
  ) => Effect.Effect<ExecutionControlReceipt, unknown>
  readonly name:
    | 'cancel-execution'
    | 'follow-up-execution'
    | 'inspect-execution'
  readonly outputSchema: JsonSchema
}

/**
 * Builds the private, owner-bound Execution controls projected to a
 * Conversation agent. Ownership is captured here rather than accepted from
 * model-authored arguments, and no Action name participates in routing.
 */
export const makeExecutionControlSurface = (options: {
  readonly conversationId: string
  readonly runtime: RootDurableRuntimeShape
  readonly workspaceId: string
}): readonly ExecutionControlTool[] => {
  const outputSchema = jsonSchemaFor(ExecutionControlReceipt)
  return [
    {
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false,
      },
      description: 'Cancel one exact owned running Execution.',
      inputSchema: jsonSchemaFor(CancelInput),
      invoke: (input) =>
        Schema.decodeUnknownEffect(CancelInput, {
          onExcessProperty: 'error',
        })(input).pipe(
          Effect.flatMap((request) =>
            options.runtime.cancelExecution({
              ...request,
              conversationId: options.conversationId,
              workspaceId: options.workspaceId,
            })
          )
        ),
      name: 'cancel-execution',
      outputSchema,
    },
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false,
      },
      description:
        'Send one bounded durable follow-up to an exact owned Execution.',
      inputSchema: jsonSchemaFor(FollowUpInput),
      invoke: (input) =>
        Schema.decodeUnknownEffect(FollowUpInput, {
          onExcessProperty: 'error',
        })(input).pipe(
          Effect.flatMap((request) =>
            options.runtime.followUpExecution({
              ...request,
              conversationId: options.conversationId,
              workspaceId: options.workspaceId,
            })
          )
        ),
      name: 'follow-up-execution',
      outputSchema,
    },
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
      description:
        'Inspect one bounded safe snapshot of an exact owned Execution.',
      inputSchema: jsonSchemaFor(InspectInput),
      invoke: (input) =>
        Schema.decodeUnknownEffect(InspectInput, {
          onExcessProperty: 'error',
        })(input).pipe(
          Effect.flatMap((request) =>
            options.runtime.inspectExecution({
              ...request,
              conversationId: options.conversationId,
              workspaceId: options.workspaceId,
            })
          )
        ),
      name: 'inspect-execution',
      outputSchema,
    },
  ]
}
