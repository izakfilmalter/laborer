import { Schema } from 'effect'

import { IsoDateTime, TrimmedNonEmptyString, WorkspaceId } from './base'

export const DEFAULT_TERMINAL_ID = 'default'

export const TerminalId = TrimmedNonEmptyString
export type TerminalId = typeof TerminalId.Type

const TerminalCols = Schema.Int.pipe(
  Schema.greaterThanOrEqualTo(20),
  Schema.lessThanOrEqualTo(400)
)
const TerminalRows = Schema.Int.pipe(
  Schema.greaterThanOrEqualTo(5),
  Schema.lessThanOrEqualTo(200)
)

export const TerminalSessionStatus = Schema.Literal(
  'starting',
  'running',
  'exited',
  'error'
)
export type TerminalSessionStatus = typeof TerminalSessionStatus.Type

export const TerminalWorkspaceInput = Schema.Struct({
  workspaceId: WorkspaceId,
  terminalId: TerminalId,
})
export type TerminalWorkspaceInput = typeof TerminalWorkspaceInput.Type

export const TerminalOpenInput = Schema.Struct({
  ...TerminalWorkspaceInput.fields,
  cwd: TrimmedNonEmptyString,
  cols: Schema.optional(TerminalCols),
  rows: Schema.optional(TerminalRows),
})
export type TerminalOpenInput = typeof TerminalOpenInput.Type

export const TerminalWriteInput = Schema.Struct({
  ...TerminalWorkspaceInput.fields,
  data: Schema.String,
})
export type TerminalWriteInput = typeof TerminalWriteInput.Type

export const TerminalResizeInput = Schema.Struct({
  ...TerminalWorkspaceInput.fields,
  cols: TerminalCols,
  rows: TerminalRows,
})
export type TerminalResizeInput = typeof TerminalResizeInput.Type

export const TerminalClearInput = TerminalWorkspaceInput
export type TerminalClearInput = typeof TerminalClearInput.Type

export const TerminalRestartInput = Schema.Struct({
  ...TerminalWorkspaceInput.fields,
  cwd: TrimmedNonEmptyString,
  cols: TerminalCols,
  rows: TerminalRows,
})
export type TerminalRestartInput = typeof TerminalRestartInput.Type

export const TerminalCloseInput = TerminalWorkspaceInput
export type TerminalCloseInput = typeof TerminalCloseInput.Type

export const TerminalSessionSnapshot = Schema.Struct({
  workspaceId: WorkspaceId,
  terminalId: TerminalId,
  cwd: TrimmedNonEmptyString,
  status: TerminalSessionStatus,
  pid: Schema.NullOr(Schema.Int),
  history: Schema.String,
  exitCode: Schema.NullOr(Schema.Int),
  exitSignal: Schema.NullOr(Schema.Int),
  hasRunningSubprocess: Schema.Boolean,
  updatedAt: IsoDateTime,
})
export type TerminalSessionSnapshot = typeof TerminalSessionSnapshot.Type

const TerminalEventBase = Schema.Struct({
  workspaceId: WorkspaceId,
  terminalId: TerminalId,
  createdAt: IsoDateTime,
})

export const TerminalStartedEvent = Schema.Struct({
  ...TerminalEventBase.fields,
  type: Schema.Literal('started'),
  snapshot: TerminalSessionSnapshot,
})
export type TerminalStartedEvent = typeof TerminalStartedEvent.Type

export const TerminalOutputEvent = Schema.Struct({
  ...TerminalEventBase.fields,
  type: Schema.Literal('output'),
  data: Schema.String,
})
export type TerminalOutputEvent = typeof TerminalOutputEvent.Type

export const TerminalExitedEvent = Schema.Struct({
  ...TerminalEventBase.fields,
  type: Schema.Literal('exited'),
  exitCode: Schema.NullOr(Schema.Int),
  exitSignal: Schema.NullOr(Schema.Int),
})
export type TerminalExitedEvent = typeof TerminalExitedEvent.Type

export const TerminalErrorEvent = Schema.Struct({
  ...TerminalEventBase.fields,
  type: Schema.Literal('error'),
  message: TrimmedNonEmptyString,
})
export type TerminalErrorEvent = typeof TerminalErrorEvent.Type

export const TerminalClearedEvent = Schema.Struct({
  ...TerminalEventBase.fields,
  type: Schema.Literal('cleared'),
})
export type TerminalClearedEvent = typeof TerminalClearedEvent.Type

export const TerminalRestartedEvent = Schema.Struct({
  ...TerminalEventBase.fields,
  type: Schema.Literal('restarted'),
  snapshot: TerminalSessionSnapshot,
})
export type TerminalRestartedEvent = typeof TerminalRestartedEvent.Type

export const TerminalActivityEvent = Schema.Struct({
  ...TerminalEventBase.fields,
  type: Schema.Literal('activity'),
  hasRunningSubprocess: Schema.Boolean,
})
export type TerminalActivityEvent = typeof TerminalActivityEvent.Type

export const TerminalEvent = Schema.Union(
  TerminalStartedEvent,
  TerminalOutputEvent,
  TerminalExitedEvent,
  TerminalErrorEvent,
  TerminalClearedEvent,
  TerminalRestartedEvent,
  TerminalActivityEvent
)
export type TerminalEvent = typeof TerminalEvent.Type

export class TerminalCwdError extends Schema.TaggedError<TerminalCwdError>()(
  'TerminalCwdError',
  {
    cwd: TrimmedNonEmptyString,
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  }
) {}

export class TerminalSessionLookupError extends Schema.TaggedError<TerminalSessionLookupError>()(
  'TerminalSessionLookupError',
  {
    workspaceId: WorkspaceId,
    terminalId: TerminalId,
    message: TrimmedNonEmptyString,
  }
) {}

export class TerminalNotRunningError extends Schema.TaggedError<TerminalNotRunningError>()(
  'TerminalNotRunningError',
  {
    workspaceId: WorkspaceId,
    terminalId: TerminalId,
    message: TrimmedNonEmptyString,
  }
) {}

export const TerminalError = Schema.Union(
  TerminalCwdError,
  TerminalSessionLookupError,
  TerminalNotRunningError
)
export type TerminalError = typeof TerminalError.Type
