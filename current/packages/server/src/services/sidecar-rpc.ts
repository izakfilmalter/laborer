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

import type { RpcMessagePort } from '@laborer/shared/rpc-transport-messageport'
import { makeClientProtocolMessagePort } from '@laborer/shared/rpc-transport-messageport-client'
import { Effect, Layer, Schedule, Scope } from 'effect'
import type { Rpc, RpcGroup } from 'effect/unstable/rpc'
import { RpcClient } from 'effect/unstable/rpc'

/**
 * Retry schedule for sidecar event stream reconnections (unbounded).
 * Used when a connected event stream disconnects unexpectedly.
 */
export const sidecarEventStreamSchedule = Schedule.min([
  Schedule.exponential('1 second'),
  Schedule.spaced('30 seconds'),
])

/**
 * Create an RPC client for a sidecar service over a MessagePort.
 *
 * Used when running inside an Electron utility process with a brokered
 * MessagePort to the target service. No HTTP, no JSON serialization —
 * MessagePort uses structured clone.
 *
 * The scope parameter ties the client protocol's lifecycle to the
 * enclosing layer scope. The Protocol layer is built into this scope
 * via `Layer.buildWithScope` so that listeners and the queue drain
 * fiber survive for the lifetime of the scope (instead of being torn
 * down when `RpcClient.make` returns, which is what happens with
 * `Effect.provide(Layer.effect(...))`).
 *
 * @see Issue #13: Server-to-terminal MessagePort channel
 */
export const createMessagePortRpcClient = <Rpcs extends Rpc.Any>(
  rpcs: RpcGroup.RpcGroup<Rpcs>,
  port: RpcMessagePort,
  scope: Scope.Scope
) =>
  Effect.flatMap(
    Layer.buildWithScope(
      Layer.effect(RpcClient.Protocol, makeClientProtocolMessagePort(port)),
      scope
    ),
    (context) =>
      RpcClient.make(rpcs).pipe(
        Effect.provide(context),
        Effect.provideService(Scope.Scope, scope)
      )
  )
