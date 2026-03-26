/**
 * Shared utilities for sidecar RPC client connections.
 *
 * Both TerminalClient and FileWatcherClient use MessagePort-based RPC
 * clients to communicate with their respective utility processes. The
 * main process brokers MessagePort pairs between services.
 *
 * `createMessagePortRpcClient` creates an Effect RPC client over a
 * MessagePort — no HTTP, no JSON serialization. MessagePort uses
 * structured clone natively.
 *
 * @see Issue #13: Server-to-terminal MessagePort channel
 * @see Issue #14: File-watcher as utility process
 * @see Issue #20: Build script update + port reservation removal
 */

import type { Rpc, RpcGroup } from '@effect/rpc'
import { RpcClient } from '@effect/rpc'
import type { RpcMessagePort } from '@laborer/shared/rpc-transport-messageport'
import { makeClientProtocolMessagePort } from '@laborer/shared/rpc-transport-messageport-client'
import { Effect, Layer, Schedule, Scope } from 'effect'

/**
 * Retry schedule for sidecar event stream reconnections (unbounded).
 * Used when a connected event stream disconnects unexpectedly.
 */
export const sidecarEventStreamSchedule = Schedule.exponential('1 second').pipe(
  Schedule.union(Schedule.spaced('30 seconds'))
)

/**
 * Create an RPC client for a sidecar service over a MessagePort.
 *
 * Used when running inside an Electron utility process with a brokered
 * MessagePort to the target service. No HTTP, no JSON serialization —
 * MessagePort uses structured clone.
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
