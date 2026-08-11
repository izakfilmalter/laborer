/**
 * MessagePort Transport Integration Tests — Server RPC
 *
 * Verifies that LaborerRpcs endpoints work end-to-end through the actual
 * MessagePort RPC transport (not just `RpcTest.makeClient`).
 *
 * This test creates a real `MessageChannel` from `worker_threads`,
 * wires the server-side transport (`layerProtocolMessagePort`) with
 * `LaborerRpcsLive` + deferred service stubs, and connects a client via
 * `makeClientProtocolMessagePort`. This proves the full stack:
 *
 *   Client (MessagePort) -> Server (MessagePort) -> RPC handlers
 *     -> LaborerRpcsLive -> Service implementations
 *
 * Tests cover:
 * - Core RPCs (health.check, lifecycle.initStatus)
 * - Deferred service proxy behavior (SERVICE_INITIALIZING errors)
 * - Multiple concurrent requests
 *
 * @see Issue #10: Server utility process: RPC over MessagePort
 * @see packages/shared/src/rpc-transport-messageport.ts (server transport)
 * @see packages/shared/src/rpc-transport-messageport-client.ts (client transport)
 */

import { MessageChannel } from 'node:worker_threads'

import { RpcClient, RpcServer } from '@effect/rpc'
import { assert, describe } from '@effect/vitest'
import { LaborerRpcs } from '@laborer/shared/rpc'
import type { RpcMessagePort } from '@laborer/shared/rpc-transport-messageport'
import { layerProtocolMessagePort } from '@laborer/shared/rpc-transport-messageport'
import { makeClientProtocolMessagePort } from '@laborer/shared/rpc-transport-messageport-client'
import { Effect, Exit, Layer, Option, Scope, Stream } from 'effect'
import { afterAll, beforeAll, it } from 'vitest'

import { LaborerRpcsLive } from '../../src/rpc/handlers.js'
import { ConfigService } from '../../src/services/config-service.js'
import {
  DeferredServicesReadyLayer,
  makeServiceProxy,
} from '../../src/services/deferred-service.js'
import { FileService } from '../../src/services/file-service.js'
import { LaborerDatabase } from '../../src/services/laborer-database.js'
import { PrWatcher } from '../../src/services/pr-watcher.js'
import { ProjectRegistry } from '../../src/services/project-registry.js'
import { TerminalClient } from '../../src/services/terminal-client.js'
import { WorkspaceProvider } from '../../src/services/workspace-provider.js'
import { WorkspaceSyncService } from '../../src/services/workspace-sync-service.js'

// ---------------------------------------------------------------------------
// Helper: adapt Node.js worker_threads MessagePort to RpcMessagePort
// ---------------------------------------------------------------------------

function toRpcPort(
  nodePort: import('node:worker_threads').MessagePort
): RpcMessagePort {
  return {
    postMessage(value: unknown, transferList?: readonly unknown[]) {
      nodePort.postMessage(value, transferList as undefined)
    },
    on(event: string, listener: (...args: unknown[]) => void) {
      nodePort.on(event, listener)
    },
    off(event: string, listener: (...args: unknown[]) => void) {
      nodePort.off(event, listener)
    },
    close() {
      nodePort.close()
    },
  }
}

// ---------------------------------------------------------------------------
// Deferred service stubs (same as core-layers.test.ts)
// ---------------------------------------------------------------------------

/**
 * Placeholder proxy layers for all deferred services.
 * Each proxy returns SERVICE_INITIALIZING errors for method calls.
 */
const DeferredServiceStubs = Layer.mergeAll(
  Layer.succeed(ProjectRegistry, makeServiceProxy('ProjectRegistry')),
  Layer.succeed(WorkspaceProvider, makeServiceProxy('WorkspaceProvider')),
  Layer.succeed(FileService, makeServiceProxy('FileService')),
  Layer.succeed(PrWatcher, makeServiceProxy('PrWatcher')),
  Layer.succeed(WorkspaceSyncService, makeServiceProxy('WorkspaceSyncService')),
  Layer.succeed(TerminalClient, makeServiceProxy('TerminalClient'))
)

// ---------------------------------------------------------------------------
// Test setup: real MessagePort server + client
// ---------------------------------------------------------------------------

/**
 * Server layer: LaborerRpcs over MessagePort with deferred service stubs.
 * This mirrors the utility-main.ts composition (minus real deferred services).
 */
function buildServerLayer(port: RpcMessagePort) {
  return RpcServer.layer(LaborerRpcs).pipe(
    Layer.provide(layerProtocolMessagePort(port)),
    Layer.provide(LaborerRpcsLive),
    Layer.provide(DeferredServiceStubs),
    Layer.provide(DeferredServicesReadyLayer),
    Layer.provide(ConfigService.layer),
    Layer.provide(LaborerDatabase.testLayer().pipe(Layer.orDie))
  )
}

/**
 * Infer the client type from `RpcClient.make(LaborerRpcs)`.
 */
const MakeLaborerClient = RpcClient.make(LaborerRpcs)
type LaborerRpcClient = Effect.Effect.Success<typeof MakeLaborerClient>

let serverScope: Scope.CloseableScope
let clientScope: Scope.CloseableScope
let client: LaborerRpcClient

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(effect)

beforeAll(async () => {
  const { port1, port2 } = new MessageChannel()

  // Build server on port1
  serverScope = Effect.runSync(Scope.make())
  const serverLayer = buildServerLayer(toRpcPort(port1))
  await Effect.runPromise(
    Layer.buildWithScope(serverLayer, serverScope).pipe(Effect.asVoid)
  )

  // Build client on port2
  clientScope = Effect.runSync(Scope.make())
  const protocol = await Effect.runPromise(
    makeClientProtocolMessagePort(toRpcPort(port2)).pipe(
      Scope.extend(clientScope)
    )
  )
  client = await Effect.runPromise(
    MakeLaborerClient.pipe(
      Effect.provideService(RpcClient.Protocol, protocol),
      Scope.extend(clientScope)
    )
  )
}, 30_000)

afterAll(async () => {
  await Effect.runPromise(Scope.close(clientScope, Exit.void))
  await Effect.runPromise(Scope.close(serverScope, Exit.void))
}, 15_000)

// ---------------------------------------------------------------------------
// Tests — LaborerRpcs endpoints through MessagePort transport
// ---------------------------------------------------------------------------

describe('LaborerRpcs over MessagePort transport', { timeout: 30_000 }, () => {
  // -----------------------------------------------------------------------
  // health.check — core RPC
  // -----------------------------------------------------------------------

  it('health.check returns ok via MessagePort', async () => {
    const result = await run(client.health.check())

    assert.strictEqual(result.status, 'ok')
    assert.isTrue(Number.isFinite(result.uptime))
    assert.isTrue(result.uptime >= 0)
  })

  // -----------------------------------------------------------------------
  // lifecycle.initStatus — core RPC
  // -----------------------------------------------------------------------

  it('lifecycle.initStatus stream emits ready=false via MessagePort', async () => {
    const first = await run(
      client.lifecycle
        .initStatus()
        .pipe(Stream.take(1), Stream.runHead, Effect.map(Option.getOrThrow))
    )

    // With DeferredServicesReadyLayer (not yet swapped to true),
    // initStatus stream should emit { ready: false } first.
    assert.strictEqual(first.ready, false)
  })

  // -----------------------------------------------------------------------
  // Deferred service — SERVICE_INITIALIZING errors
  // -----------------------------------------------------------------------

  it('deferred service RPC returns SERVICE_INITIALIZING via MessagePort', async () => {
    const result = await run(
      client.project.list().pipe(
        Effect.matchEffect({
          onSuccess: () => Effect.succeed('success' as const),
          onFailure: (error) => Effect.succeed(error),
        })
      )
    )

    if (result === 'success') {
      assert.fail('Expected project.list to fail with SERVICE_INITIALIZING')
    }
    // The error should be an RpcError (not RpcClientError) wrapping
    // the SERVICE_INITIALIZING error from the deferred service proxy.
    assert.strictEqual(result._tag, 'RpcError')
    assert.include(result.message, 'still initializing')
  })

  // -----------------------------------------------------------------------
  // Multiple concurrent requests
  // -----------------------------------------------------------------------

  it('handles multiple concurrent requests via MessagePort', async () => {
    const [health, initStatus] = await run(
      Effect.all([
        client.health.check(),
        client.lifecycle
          .initStatus()
          .pipe(Stream.take(1), Stream.runHead, Effect.map(Option.getOrThrow)),
      ])
    )

    assert.strictEqual(health.status, 'ok')
    assert.strictEqual(initStatus.ready, false)
  })

  // -----------------------------------------------------------------------
  // Core RPCs work regardless of deferred service state
  // -----------------------------------------------------------------------

  it('core RPCs work while deferred services return errors', async () => {
    // Verify core RPCs work even when all deferred services are
    // in the initializing state (returning SERVICE_INITIALIZING errors)
    const health = await run(client.health.check())
    assert.strictEqual(health.status, 'ok')

    // Simultaneously verify a deferred RPC fails as expected
    const projectResult = await run(
      client.project.list().pipe(
        Effect.matchEffect({
          onSuccess: () => Effect.succeed('success' as const),
          onFailure: (error) => Effect.succeed(error),
        })
      )
    )

    if (projectResult === 'success') {
      assert.fail('Expected project.list to fail')
    }
    assert.strictEqual(projectResult._tag, 'RpcError')
  })
})
