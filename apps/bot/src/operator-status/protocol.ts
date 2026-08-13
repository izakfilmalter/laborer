import { z } from 'zod'

// Version 6 establishes the post-Chat work-thread projection. Keep this local
// protocol identity stable until its schema changes deliberately again.
export const OPERATOR_PROTOCOL_VERSION = 6 as const
export const MAX_OPERATOR_RECORD_BYTES = 256 * 1024
export const MAX_OPERATOR_WORKSPACE_BINDINGS = 64
export const MAX_OPERATOR_WORK_THREADS = 512
export const MAX_OPERATOR_PENDING_EXECUTIONS = 512
const MAX_JAVASCRIPT_DATE_MILLIS = 8_640_000_000_000_000

const boundedVersion = z.string().trim().min(1).max(64)
const boundedIdentity = z.string().min(1).max(64)
const bindingIdPattern = /^binding:\d+$/
const bindingLabelPattern = /^Workspace binding [1-9]\d*$/
const teamIdPattern = /^T[A-Z0-9]+$/
const threadIdPattern =
  /^workspace:T[A-Z0-9]+:[CG][A-Z0-9]+:\d{1,16}(?:\.\d{1,9})?$/
const threadLabelPattern = /^(?:[CG][A-Z0-9]+|Slack) · \d{1,16}(?:\.\d{1,9})?$/
const isOneLineText = (value: string): boolean =>
  Array.from(value).every((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return (
      codePoint > 31 &&
      codePoint !== 127 &&
      codePoint !== 0x20_28 &&
      codePoint !== 0x20_29
    )
  })
const actionNamePattern = /^[a-zA-Z0-9](?:[a-zA-Z0-9._/-]*[a-zA-Z0-9])?$/

export const OperatorPendingExecutionSchema = z
  .object({
    actionName: z.string().min(1).max(96).regex(actionNamePattern),
    id: z.string().min(1).max(160),
    lifecycle: z.enum([
      'allocated',
      'starting',
      'implementation-ready',
      'running',
      'cancelling',
      'recovery-blocked',
    ]),
    startedAtUnixMs: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_JAVASCRIPT_DATE_MILLIS)
      .nullable(),
    workThreadId: z.string().min(1).max(256).regex(threadIdPattern),
    workspaceId: boundedIdentity,
  })
  .strict()

export type OperatorPendingExecution = z.infer<
  typeof OperatorPendingExecutionSchema
>

export const OperatorWorkThreadSchema = z
  .object({
    activity: z.enum(['in-progress', 'dormant']),
    executions: z
      .array(OperatorPendingExecutionSchema)
      .max(MAX_OPERATOR_PENDING_EXECUTIONS),
    excerpt: z.string().min(1).max(120).refine(isOneLineText),
    id: z.string().min(1).max(256).regex(threadIdPattern),
    label: z.string().min(1).max(80).regex(threadLabelPattern),
    stateChangedAtUnixMs: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_JAVASCRIPT_DATE_MILLIS),
    workspaceId: boundedIdentity,
  })
  .strict()
  .refine(
    (thread) =>
      thread.executions.every(
        (execution) =>
          execution.workspaceId === thread.workspaceId &&
          execution.workThreadId === thread.id
      ) &&
      new Set(thread.executions.map((execution) => execution.id)).size ===
        thread.executions.length,
    'pending Execution ownership is inconsistent'
  )

export type OperatorWorkThread = z.infer<typeof OperatorWorkThreadSchema>

export const OperatorBindingDetailSchema = z.enum([
  'authentication-unavailable',
  'configuration-invalid',
  'health-unavailable',
  'identity-mismatch',
  'ownership-unavailable',
  'root-unavailable',
  'runtime-unavailable',
  'setup-required',
  'startup-stopped',
])

export const OperatorWorkspaceBindingSchema = z
  .object({
    detail: OperatorBindingDetailSchema.nullable(),
    id: boundedIdentity,
    label: z.string().min(1).max(64).refine(isOneLineText),
    readiness: z.enum([
      'pending',
      'ready',
      'setup-incomplete',
      'unavailable',
      'unknown',
    ]),
    teamId: boundedIdentity.nullable(),
    threads: z.array(OperatorWorkThreadSchema).max(MAX_OPERATOR_WORK_THREADS),
  })
  .strict()
  .refine(
    (binding) =>
      binding.teamId === null
        ? bindingIdPattern.test(binding.id) &&
          bindingLabelPattern.test(binding.label)
        : (binding.id === `slack:${binding.teamId}` ||
            bindingIdPattern.test(binding.id)) &&
          isOneLineText(binding.label) &&
          teamIdPattern.test(binding.teamId),
    'workspace identity is inconsistent'
  )
  .refine(
    (binding) =>
      binding.readiness === 'ready' || binding.readiness === 'pending'
        ? binding.detail === null
        : binding.detail !== null,
    'workspace readiness detail is inconsistent'
  )
  .refine(
    (binding) =>
      binding.teamId === null
        ? binding.threads.length === 0
        : binding.threads.every(
            (thread) => thread.workspaceId === binding.teamId
          ),
    'work-thread workspace ownership is inconsistent'
  )
  .refine(
    (binding) =>
      new Set(binding.threads.map((thread) => thread.id)).size ===
        binding.threads.length &&
      binding.threads.filter((thread) => thread.activity === 'dormant')
        .length <= 4,
    'work-thread list is inconsistent'
  )

export type OperatorWorkspaceBinding = z.infer<
  typeof OperatorWorkspaceBindingSchema
>

export const OperatorSnapshotSchema = z
  .object({
    daemon: z
      .object({
        receiver: z.enum(['connecting', 'connected']),
        startedAtUnixMs: z.number().int().nonnegative(),
        version: boundedVersion,
      })
      .strict(),
    kind: z.literal('snapshot'),
    observedAtUnixMs: z.number().int().nonnegative(),
    protocolVersion: z.literal(OPERATOR_PROTOCOL_VERSION),
    sequence: z.number().int().positive(),
    workspaces: z
      .array(OperatorWorkspaceBindingSchema)
      .max(MAX_OPERATOR_WORKSPACE_BINDINGS),
  })
  .strict()
  .refine(
    (snapshot) => snapshot.observedAtUnixMs >= snapshot.daemon.startedAtUnixMs,
    'observation predates daemon start'
  )
  .refine(
    (snapshot) =>
      new Set(snapshot.workspaces.map((workspace) => workspace.id)).size ===
      snapshot.workspaces.length,
    'workspace identities are duplicated'
  )
  .refine(
    (snapshot) =>
      snapshot.workspaces.reduce(
        (count, workspace) => count + workspace.threads.length,
        0
      ) <= MAX_OPERATOR_WORK_THREADS,
    'too many work threads'
  )
  .refine(
    (snapshot) =>
      snapshot.workspaces.reduce(
        (count, workspace) =>
          count +
          workspace.threads.reduce(
            (threadCount, thread) => threadCount + thread.executions.length,
            0
          ),
        0
      ) <= MAX_OPERATOR_PENDING_EXECUTIONS,
    'too many pending Executions'
  )
  .refine((snapshot) => {
    const executionIds = snapshot.workspaces.flatMap((workspace) =>
      workspace.threads.flatMap((thread) =>
        thread.executions.map((execution) => execution.id)
      )
    )
    return new Set(executionIds).size === executionIds.length
  }, 'pending Execution identities are duplicated')
  .refine(
    (snapshot) =>
      snapshot.workspaces.every((workspace) =>
        workspace.threads.every(
          (thread) =>
            thread.stateChangedAtUnixMs <= snapshot.observedAtUnixMs &&
            thread.executions.every(
              (execution) =>
                execution.startedAtUnixMs === null ||
                execution.startedAtUnixMs <= snapshot.observedAtUnixMs
            )
        )
      ),
    'work-thread observation is in the future'
  )

export type OperatorSnapshot = z.infer<typeof OperatorSnapshotSchema>

const OperatorSubscribeSchema = z
  .object({
    kind: z.literal('subscribe'),
    protocolVersion: z.literal(OPERATOR_PROTOCOL_VERSION),
    token: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()

export type OperatorSubscribe = z.infer<typeof OperatorSubscribeSchema>

export class OperatorProtocolError extends Error {
  readonly reason: 'incompatible' | 'malformed' | 'oversized'

  constructor(reason: 'incompatible' | 'malformed' | 'oversized') {
    super(`Operator protocol record rejected: ${reason}`)
    this.name = 'OperatorProtocolError'
    this.reason = reason
  }
}

const parseBoundedJson = (source: string): unknown => {
  if (Buffer.byteLength(source, 'utf8') > MAX_OPERATOR_RECORD_BYTES) {
    throw new OperatorProtocolError('oversized')
  }
  try {
    return JSON.parse(source) as unknown
  } catch {
    throw new OperatorProtocolError('malformed')
  }
}

const hasIncompatibleVersion = (value: unknown): boolean =>
  typeof value === 'object' &&
  value !== null &&
  'protocolVersion' in value &&
  value.protocolVersion !== OPERATOR_PROTOCOL_VERSION

export const decodeOperatorSnapshot = (source: string): OperatorSnapshot => {
  const value = parseBoundedJson(source)
  if (hasIncompatibleVersion(value)) {
    throw new OperatorProtocolError('incompatible')
  }
  const result = OperatorSnapshotSchema.safeParse(value)
  if (!result.success) {
    throw new OperatorProtocolError('malformed')
  }
  return result.data
}

export const decodeOperatorSubscribe = (source: string): OperatorSubscribe => {
  const value = parseBoundedJson(source)
  if (hasIncompatibleVersion(value)) {
    throw new OperatorProtocolError('incompatible')
  }
  const result = OperatorSubscribeSchema.safeParse(value)
  if (!result.success) {
    throw new OperatorProtocolError('malformed')
  }
  return result.data
}
