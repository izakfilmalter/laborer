/**
 * Tests for the MessagePort RPC Client Transport.
 *
 * Verifies that `makeClientProtocolMessagePort` / `layerClientProtocolMessagePort`
 * correctly sends RPC requests and receives responses over a MessagePort.
 * Uses Node.js `MessageChannel` from `worker_threads` to create port pairs
 * (no Electron dependency).
 *
 * Each test sets up a full client + server pair: the server uses
 * `layerProtocolMessagePort` from issue #3, and the client uses
 * `makeClientProtocolMessagePort` from issue #4. This proves end-to-end
 * RPC over MessagePort.
 *
 * @see packages/shared/src/rpc-transport-messageport-client.ts
 * @see Issue #4: MessagePort Effect RPC transport (client side)
 */

import { MessageChannel } from 'node:worker_threads'

import { Rpc, RpcClient, RpcGroup, RpcServer } from '@effect/rpc'
import { Effect, Exit, Layer, Schema, Scope, Stream } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  layerProtocolMessagePort,
  PING_MESSAGE,
  PONG_MESSAGE,
  type RpcMessagePort,
} from '../src/rpc-transport-messageport.js'
import { makeClientProtocolMessagePort } from '../src/rpc-transport-messageport-client.js'

// ---------------------------------------------------------------------------
// Test RPC definitions
// ---------------------------------------------------------------------------

class TestRpcError extends Schema.TaggedError<TestRpcError>()('TestRpcError', {
  message: Schema.String,
}) {}

const TestRpcs = RpcGroup.make(
  Rpc.make('echo', {
    success: Schema.String,
    payload: { input: Schema.String },
  }),

  Rpc.make('add', {
    success: Schema.Number,
    payload: { a: Schema.Number, b: Schema.Number },
  }),

  Rpc.make('fail', {
    success: Schema.Void,
    error: TestRpcError,
    payload: { message: Schema.String },
  }),

  Rpc.make('count', {
    success: Schema.Number,
    stream: true,
    payload: { count: Schema.Number },
  })
)

const TestRpcsLive = TestRpcs.toLayer(
  Effect.succeed({
    echo: ({ input }) => Effect.succeed(input),
    add: ({ a, b }) => Effect.succeed(a + b),
    fail: ({ message }) => Effect.fail(new TestRpcError({ message })),
    count: ({ count }) => Stream.range(0, count - 1).pipe(Stream.map((n) => n)),
  })
)

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
// Helper: build a server + client pair with managed scopes
// ---------------------------------------------------------------------------

async function buildServerAndClient() {
  const { port1, port2 } = new MessageChannel()

  // Build server
  const serverScope = Effect.runSync(Scope.make())
  const serverLayer = RpcServer.layer(TestRpcs).pipe(
    Layer.provide(layerProtocolMessagePort(toRpcPort(port1))),
    Layer.provide(TestRpcsLive)
  )
  await Effect.runPromise(
    Layer.buildWithScope(serverLayer, serverScope).pipe(Effect.asVoid)
  )

  // Build client protocol and RPC client in a shared scope
  const clientScope = Effect.runSync(Scope.make())
  const protocol = await Effect.runPromise(
    makeClientProtocolMessagePort(toRpcPort(port2)).pipe(
      Scope.extend(clientScope)
    )
  )
  const client: any = await Effect.runPromise(
    RpcClient.make(TestRpcs).pipe(
      Effect.provideService(RpcClient.Protocol, protocol),
      Scope.extend(clientScope)
    )
  )

  return {
    client,
    async cleanup() {
      await Effect.runPromise(Scope.close(clientScope, Exit.void))
      await Effect.runPromise(Scope.close(serverScope, Exit.void))
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('makeClientProtocolMessagePort', () => {
  let client: any
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    const pair = await buildServerAndClient()
    client = pair.client
    cleanup = pair.cleanup
  })

  afterEach(async () => {
    await cleanup()
  })

  // -----------------------------------------------------------------------
  // Request/response
  // -----------------------------------------------------------------------

  it('handles echo request/response', async () => {
    const result = await Effect.runPromise(
      client.echo({ input: 'hello world' })
    )
    expect(result).toBe('hello world')
  })

  it('handles add request/response', async () => {
    const result = await Effect.runPromise(client.add({ a: 3, b: 7 }))
    expect(result).toBe(10)
  })

  // -----------------------------------------------------------------------
  // Error propagation
  // -----------------------------------------------------------------------

  it('propagates RPC errors', async () => {
    const result = await Effect.runPromise(
      Effect.either(client.fail({ message: 'something went wrong' }))
    )
    expect(result._tag).toBe('Left')
  })

  // -----------------------------------------------------------------------
  // Streaming
  // -----------------------------------------------------------------------

  it('handles streaming RPC', async () => {
    const result = await Effect.runPromise(
      Stream.runCollect(client.count({ count: 5 }))
    )
    const values = Array.from(result)
    expect(values).toEqual([0, 1, 2, 3, 4])
  })

  // -----------------------------------------------------------------------
  // Multiple concurrent requests
  // -----------------------------------------------------------------------

  it('handles multiple concurrent requests', async () => {
    const [r1, r2, r3] = await Promise.all([
      Effect.runPromise(client.echo({ input: 'first' })),
      Effect.runPromise(client.add({ a: 10, b: 20 })),
      Effect.runPromise(client.echo({ input: 'third' })),
    ])
    expect(r1).toBe('first')
    expect(r2).toBe(30)
    expect(r3).toBe('third')
  })

  // -----------------------------------------------------------------------
  // Port disconnection
  // -----------------------------------------------------------------------

  it('handles port disconnection gracefully', async () => {
    const { port1, port2 } = new MessageChannel()

    const disconnectServerScope = Effect.runSync(Scope.make())
    const serverLayer = RpcServer.layer(TestRpcs).pipe(
      Layer.provide(layerProtocolMessagePort(toRpcPort(port1))),
      Layer.provide(TestRpcsLive)
    )
    await Effect.runPromise(
      Layer.buildWithScope(serverLayer, disconnectServerScope).pipe(
        Effect.asVoid
      )
    )

    const disconnectClientScope = Effect.runSync(Scope.make())
    const protocol = await Effect.runPromise(
      makeClientProtocolMessagePort(toRpcPort(port2)).pipe(
        Scope.extend(disconnectClientScope)
      )
    )
    const disconnectClient: any = await Effect.runPromise(
      RpcClient.make(TestRpcs).pipe(
        Effect.provideService(RpcClient.Protocol, protocol),
        Scope.extend(disconnectClientScope)
      )
    )

    // Verify it works
    const result = await Effect.runPromise(
      disconnectClient.echo({ input: 'before disconnect' })
    )
    expect(result).toBe('before disconnect')

    // Close server (simulating disconnection)
    await Effect.runPromise(Scope.close(disconnectServerScope, Exit.void))

    // Clean up client
    await Effect.runPromise(Scope.close(disconnectClientScope, Exit.void))
  })

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  it('cleans up when scope is closed', async () => {
    const { port1, port2 } = new MessageChannel()

    const cleanupServerScope = Effect.runSync(Scope.make())
    const serverLayer = RpcServer.layer(TestRpcs).pipe(
      Layer.provide(layerProtocolMessagePort(toRpcPort(port1))),
      Layer.provide(TestRpcsLive)
    )
    await Effect.runPromise(
      Layer.buildWithScope(serverLayer, cleanupServerScope).pipe(Effect.asVoid)
    )

    const cleanupClientScope = Effect.runSync(Scope.make())
    const protocol = await Effect.runPromise(
      makeClientProtocolMessagePort(toRpcPort(port2)).pipe(
        Scope.extend(cleanupClientScope)
      )
    )
    const cleanupClient: any = await Effect.runPromise(
      RpcClient.make(TestRpcs).pipe(
        Effect.provideService(RpcClient.Protocol, protocol),
        Scope.extend(cleanupClientScope)
      )
    )

    // Verify it works
    const result = await Effect.runPromise(
      cleanupClient.echo({ input: 'before cleanup' })
    )
    expect(result).toBe('before cleanup')

    // Close client scope — should clean up the client transport
    await Effect.runPromise(Scope.close(cleanupClientScope, Exit.void))

    // Close server scope
    await Effect.runPromise(Scope.close(cleanupServerScope, Exit.void))
  })
})

// ---------------------------------------------------------------------------
// Heartbeat protocol tests
// ---------------------------------------------------------------------------

describe('heartbeat ping/pong protocol', () => {
  it('server echoes ping messages as pong', async () => {
    const { port1: serverNodePort, port2: clientNodePort } =
      new MessageChannel()

    // Build the server — the server transport should echo pings.
    const serverScope = Effect.runSync(Scope.make())
    const serverLayer = RpcServer.layer(TestRpcs).pipe(
      Layer.provide(layerProtocolMessagePort(toRpcPort(serverNodePort))),
      Layer.provide(TestRpcsLive)
    )
    await Effect.runPromise(
      Layer.buildWithScope(serverLayer, serverScope).pipe(Effect.asVoid)
    )

    // Send a raw ping on the client port and expect pong back.
    const pongReceived = new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        clientNodePort.off('message', handler)
        resolve(false)
      }, 2000)

      const handler = (data: unknown): void => {
        if (data === PONG_MESSAGE) {
          clearTimeout(timeout)
          clientNodePort.off('message', handler)
          resolve(true)
        }
      }

      clientNodePort.on('message', handler)
    })

    clientNodePort.postMessage(PING_MESSAGE)
    const gotPong = await pongReceived

    expect(gotPong).toBe(true)

    await Effect.runPromise(Scope.close(serverScope, Exit.void))
    clientNodePort.close()
  })

  it('ping messages are not forwarded to the RPC handler', async () => {
    const { port1: serverNodePort, port2: clientNodePort } =
      new MessageChannel()

    const serverScope = Effect.runSync(Scope.make())
    const serverLayer = RpcServer.layer(TestRpcs).pipe(
      Layer.provide(layerProtocolMessagePort(toRpcPort(serverNodePort))),
      Layer.provide(TestRpcsLive)
    )
    await Effect.runPromise(
      Layer.buildWithScope(serverLayer, serverScope).pipe(Effect.asVoid)
    )

    // Send a ping — should get a pong but NOT an RPC error/defect.
    const messages: unknown[] = []
    const collectPromise = new Promise<void>((resolve) => {
      const timeout = setTimeout(() => resolve(), 500)
      clientNodePort.on('message', (data: unknown) => {
        messages.push(data)
        // Reset timeout on each message.
        clearTimeout(timeout)
        setTimeout(() => resolve(), 200)
      })
    })

    clientNodePort.postMessage(PING_MESSAGE)
    await collectPromise

    // Should have exactly one pong and no RPC error responses.
    expect(messages).toEqual([PONG_MESSAGE])

    await Effect.runPromise(Scope.close(serverScope, Exit.void))
    clientNodePort.close()
  })

  it('RPC still works alongside heartbeat pings', async () => {
    const pair = await buildServerAndClient()

    // Normal RPC should work fine — heartbeat is transparent.
    const result = await Effect.runPromise(
      pair.client.echo({ input: 'heartbeat test' })
    )
    expect(result).toBe('heartbeat test')

    await pair.cleanup()
  })
})

// ---------------------------------------------------------------------------
// Heartbeat timeout detection tests
// ---------------------------------------------------------------------------

describe('heartbeat timeout detection', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('detects dead port when no pong arrives within timeout', async () => {
    // Create a "deaf" port pair where the server side never responds.
    // Simulate by just creating raw ports with no server.
    const { port1: serverNodePort, port2: clientNodePort } =
      new MessageChannel()

    // Swallow messages on server side (no echo, no pong).
    serverNodePort.on('message', () => {
      // intentionally ignore — simulating a dead channel
    })

    const clientScope = Effect.runSync(Scope.make())
    const protocol = await Effect.runPromise(
      makeClientProtocolMessagePort(toRpcPort(clientNodePort)).pipe(
        Scope.extend(clientScope)
      )
    )

    const rpcClient: any = await Effect.runPromise(
      RpcClient.make(TestRpcs).pipe(
        Effect.provideService(RpcClient.Protocol, protocol),
        Scope.extend(clientScope)
      )
    )

    // Send a request — it will hang because nobody responds.
    let requestFailed = false
    const requestPromise = Effect.runPromise(
      rpcClient.echo({ input: 'will timeout' })
    ).catch(() => {
      requestFailed = true
    })

    // Advance past heartbeat timeout (15s) + one interval (5s).
    await vi.advanceTimersByTimeAsync(20_000)

    // The request should have failed due to the synthetic Defect.
    await requestPromise
    expect(requestFailed).toBe(true)

    // Cleanup
    await Effect.runPromise(Scope.close(clientScope, Exit.void)).catch(() => {
      // Scope may already be partially closed.
    })
    serverNodePort.close()
  })

  it('does not trigger timeout when server responds to pings', async () => {
    const pair = await buildServerAndClient()

    // Advance time well past timeout — with a real server, pongs
    // keep the heartbeat alive.
    await vi.advanceTimersByTimeAsync(30_000)

    // RPC should still work.
    const result = await Effect.runPromise(
      pair.client.echo({ input: 'still alive' })
    )
    expect(result).toBe('still alive')

    await pair.cleanup()
  })
})
