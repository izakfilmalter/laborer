import { Schema } from 'effect'

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from './base'

export const RuntimeMode = Schema.Literal('web', 'desktop')
export type RuntimeMode = typeof RuntimeMode.Type

export const ServerConfig = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  host: TrimmedNonEmptyString,
  port: PositiveInt,
  mode: RuntimeMode,
  wsUrl: TrimmedNonEmptyString,
})
export type ServerConfig = typeof ServerConfig.Type

export const ServerConfigStreamEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal('snapshot'),
  config: ServerConfig,
})
export type ServerConfigStreamEvent = typeof ServerConfigStreamEvent.Type

export const ServerLifecycleWelcomePayload = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  projectName: TrimmedNonEmptyString,
  bootstrapProjectId: Schema.optional(ProjectId),
  bootstrapThreadId: Schema.optional(ThreadId),
})
export type ServerLifecycleWelcomePayload =
  typeof ServerLifecycleWelcomePayload.Type

export const ServerLifecycleReadyPayload = Schema.Struct({
  at: IsoDateTime,
})
export type ServerLifecycleReadyPayload =
  typeof ServerLifecycleReadyPayload.Type

export const ServerLifecycleWelcomeEvent = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeInt,
  type: Schema.Literal('welcome'),
  payload: ServerLifecycleWelcomePayload,
})
export type ServerLifecycleWelcomeEvent =
  typeof ServerLifecycleWelcomeEvent.Type

export const ServerLifecycleReadyEvent = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeInt,
  type: Schema.Literal('ready'),
  payload: ServerLifecycleReadyPayload,
})
export type ServerLifecycleReadyEvent = typeof ServerLifecycleReadyEvent.Type

export const ServerLifecycleStreamEvent = Schema.Union(
  ServerLifecycleWelcomeEvent,
  ServerLifecycleReadyEvent
)
export type ServerLifecycleStreamEvent = typeof ServerLifecycleStreamEvent.Type
