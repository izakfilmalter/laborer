/**
 * Shared utilities for sidecar RPC client connections.
 *
 * Both TerminalClient and FileWatcherClient use the same pattern for
 * connecting to their respective sidecar services: HTTP+JSON RPC with
 * exponential-backoff retry. This module extracts the shared schedule
 * and client creation logic to avoid duplication.
 *
 * In utility process mode, `createMessagePortRpcClient` provides the
 * same RPC client interface but over a MessagePort instead of HTTP.
 *
 * @see Issue #13: Server-to-terminal MessagePort channel
 */

import { FetchHttpClient } from '@effect/platform'
import type { Rpc, RpcGroup } from '@effect/rpc'
import { RpcClient, RpcSerialization } from '@effect/rpc'
import type { RpcMessagePort } from '@laborer/shared/rpc-transport-messageport'
import { makeClientProtocolMessagePort } from '@laborer/shared/rpc-transport-messageport-client'
import { Effect, Layer, Schedule, Scope } from 'effect'

/**
 * Retry schedule for initial sidecar RPC connections:
 * exponential backoff starting at 1s, capped at 30s, up to 5 attempts.
 */
export const sidecarConnectionSchedule = Schedule.exponential('1 second').pipe(
  Schedule.union(Schedule.spaced('30 seconds')),
  Schedule.compose(Schedule.recurs(5))
)

/**
 * Retry schedule for sidecar event stream reconnections (unbounded).
 * Used when a connected event stream disconnects unexpectedly.
 */
export const sidecarEventStreamSchedule = Schedule.exponential('1 second').pipe(
  Schedule.union(Schedule.spaced('30 seconds'))
)

/**
 * Create an RPC client for a sidecar service with the standard
 * HTTP+JSON transport and connection retry schedule.
 */
export const createSidecarRpcClient = <Rpcs extends Rpc.Any>(
  rpcs: RpcGroup.RpcGroup<Rpcs>,
  url: string
) =>
  RpcClient.make(rpcs).pipe(
    Effect.provide(
      RpcClient.layerProtocolHttp({ url }).pipe(
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(RpcSerialization.layerJson)
      )
    ),
    Effect.retry(sidecarConnectionSchedule)
  )

/**
 * Create an RPC client for a sidecar service over a MessagePort.
 *
 * Replaces `createSidecarRpcClient` when running inside an Electron
 * utility process with a brokered MessagePort to the target service.
 * No HTTP, no JSON serialization — MessagePort uses structured clone.
 *
 * The scope parameter ties the client protocol's lifecycle to the
 * enclosing layer scope.
 *
 * @see Issue #13: Server-to-terminal MessagePort channel
 */
export const createMessagePortRpcClient = <Rpcs extends Rpc.Any>(
  rpcs: RpcGroup.RpcGroup<Rpcs>,
  port: RpcMessagePort,
  scope: Scope.Scope
) =>
  RpcClient.make(rpcs).pipe(
    Effect.provide(
      Layer.scoped(RpcClient.Protocol, makeClientProtocolMessagePort(port))
    ),
    Effect.provideService(Scope.Scope, scope)
  )
