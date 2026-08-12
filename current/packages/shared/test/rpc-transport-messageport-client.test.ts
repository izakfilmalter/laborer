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
import { Effect, Exit, Layer, Result, Schema, Scope, Stream } from 'effect'
import { Rpc, RpcClient, RpcGroup, RpcServer } from 'effect/unstable/rpc'
import { RpcClientError } from 'effect/unstable/rpc/RpcClientError'
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

class TestRpcError extends Schema.TaggedErrorClass<TestRpcError>()(
  'TestRpcError',
  {
    message: Schema.String,
  }
) {}

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

  Rpc.make('hang', {
    success: Schema.Void,
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
    hang: () => Effect.never,
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
      Scope.provide(clientScope)
    )
  )
  const client: any = await Effect.runPromise(
    RpcClient.make(TestRpcs).pipe(
      Effect.provideService(RpcClient.Protocol, protocol),
      Scope.provide(clientScope)
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
      Effect.result(client.fail({ message: 'something went wrong' }))
    )
    expect(Result.isFailure(result)).toBe(true)
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
        Scope.provide(disconnectClientScope)
      )
    )
    const disconnectClient: any = await Effect.runPromise(
      RpcClient.make(TestRpcs).pipe(
        Effect.provideService(RpcClient.Protocol, protocol),
        Scope.provide(disconnectClientScope)
      )
    )

    // Verify it works
    const result = await Effect.runPromise(
      disconnectClient.echo({ input: 'before disconnect' })
    )
    expect(result).toBe('before disconnect')

    const pendingRequest = Effect.runPromise(disconnectClient.hang())

    // Close server while a request is pending (simulating disconnection).
    await Effect.runPromise(Scope.close(disconnectServerScope, Exit.void))

    await expect(pendingRequest).rejects.toMatchObject({
      reason: { _tag: 'RpcClientDefect' },
    })

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
        Scope.provide(cleanupClientScope)
      )
    )
    const cleanupClient: any = await Effect.runPromise(
      RpcClient.make(TestRpcs).pipe(
        Effect.provideService(RpcClient.Protocol, protocol),
        Scope.provide(cleanupClientScope)
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
        Scope.provide(clientScope)
      )
    )

    const rpcClient: any = await Effect.runPromise(
      RpcClient.make(TestRpcs).pipe(
        Effect.provideService(RpcClient.Protocol, protocol),
        Scope.provide(clientScope)
      )
    )

    // Send a request — it will hang because nobody responds.
    let requestError: unknown
    const requestPromise = Effect.runPromise(
      rpcClient.echo({ input: 'will timeout' })
    ).catch((error: unknown) => {
      requestError = error
    })

    // Advance past heartbeat timeout (30s) + one interval (5s).
    await vi.advanceTimersByTimeAsync(35_000)

    // The request should have failed due to the synthetic Defect.
    await requestPromise
    expect(requestError).toBeInstanceOf(RpcClientError)
    expect(requestError).toMatchObject({
      reason: { _tag: 'RpcClientDefect' },
    })

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
    vi.useRealTimers()

    // RPC should still work.
    const result = await Effect.runPromise(
      pair.client.echo({ input: 'still alive' })
    )
    expect(result).toBe('still alive')

    await pair.cleanup()
  })

  it('survives a temporary server stall shorter than the timeout window', async () => {
    // Simulate a server that stops echoing pongs for 20s (heavy sync work)
    // then resumes. With a 30s timeout, the port should survive.
    // With the old 15s timeout, this would falsely declare the port dead.
    const { port1: serverNodePort, port2: clientNodePort } =
      new MessageChannel()

    // Track whether we're simulating a stall.
    let stalled = false

    // Build a proxy port for the server that drops pings during a stall
    // to simulate an event-loop-blocked utility process. We set up the
    // proxy BEFORE building the server so the server's transport
    // attaches its listeners to our proxy, not the raw port.
    const proxyServerPort: RpcMessagePort = {
      postMessage(value: unknown, transferList?: readonly unknown[]) {
        serverNodePort.postMessage(value, transferList as undefined)
      },
      on(event: string, listener: (...args: unknown[]) => void) {
        if (event === 'message') {
          serverNodePort.on('message', (data: unknown) => {
            // During a stall, drop ping messages to simulate
            // a blocked event loop that can't echo pongs.
            if (stalled && data === PING_MESSAGE) {
              return
            }
            listener(data)
          })
        } else {
          serverNodePort.on(event, listener)
        }
      },
      off(event: string, listener: (...args: unknown[]) => void) {
        serverNodePort.off(event, listener)
      },
      close() {
        serverNodePort.close()
      },
    }

    const serverScope = Effect.runSync(Scope.make())
    const serverLayer = RpcServer.layer(TestRpcs).pipe(
      Layer.provide(layerProtocolMessagePort(proxyServerPort)),
      Layer.provide(TestRpcsLive)
    )
    await Effect.runPromise(
      Layer.buildWithScope(serverLayer, serverScope).pipe(Effect.asVoid)
    )

    // Build client
    const clientScope = Effect.runSync(Scope.make())
    const protocol = await Effect.runPromise(
      makeClientProtocolMessagePort(toRpcPort(clientNodePort)).pipe(
        Scope.provide(clientScope)
      )
    )
    const rpcClient: any = await Effect.runPromise(
      RpcClient.make(TestRpcs).pipe(
        Effect.provideService(RpcClient.Protocol, protocol),
        Scope.provide(clientScope)
      )
    )

    // Simulate a 20s server stall (no pong echoes during this time).
    stalled = true
    await vi.advanceTimersByTimeAsync(20_000)
    stalled = false

    // After the stall ends, the next ping should get a pong and reset
    // the liveness timestamp. Advance past one more interval.
    await vi.advanceTimersByTimeAsync(5000)
    vi.useRealTimers()

    // RPC should still work — the port should NOT have been declared dead.
    const after = await Effect.runPromise(
      rpcClient.echo({ input: 'after stall' })
    )
    expect(after).toBe('after stall')

    // Cleanup
    await Effect.runPromise(Scope.close(clientScope, Exit.void)).catch(() => {
      // Scope may already be partially closed.
    })
    await Effect.runPromise(Scope.close(serverScope, Exit.void)).catch(() => {
      // Scope may already be partially closed.
    })
  })

  it('can disable the raw heartbeat for Electron-managed ports', async () => {
    const { port1: serverNodePort, port2: clientNodePort } =
      new MessageChannel()

    // Build a proxy server that intentionally drops raw heartbeat pings while
    // still serving normal RPC traffic. This mirrors the Electron service-port
    // path where regular RPC works but the transport-level ping/pong loop is
    // not a reliable liveness signal.
    const proxyServerPort: RpcMessagePort = {
      postMessage(value: unknown, transferList?: readonly unknown[]) {
        serverNodePort.postMessage(value, transferList as undefined)
      },
      on(event: string, listener: (...args: unknown[]) => void) {
        if (event === 'message') {
          serverNodePort.on('message', (data: unknown) => {
            if (data === PING_MESSAGE) {
              return
            }
            listener(data)
          })
          return
        }
        serverNodePort.on(event, listener)
      },
      off(event: string, listener: (...args: unknown[]) => void) {
        serverNodePort.off(event, listener)
      },
      close() {
        serverNodePort.close()
      },
    }

    const serverScope = Effect.runSync(Scope.make())
    const serverLayer = RpcServer.layer(TestRpcs).pipe(
      Layer.provide(layerProtocolMessagePort(proxyServerPort)),
      Layer.provide(TestRpcsLive)
    )
    await Effect.runPromise(
      Layer.buildWithScope(serverLayer, serverScope).pipe(Effect.asVoid)
    )

    const clientScope = Effect.runSync(Scope.make())
    const protocol = await Effect.runPromise(
      makeClientProtocolMessagePort(toRpcPort(clientNodePort), {
        heartbeatEnabled: false,
      }).pipe(Scope.provide(clientScope))
    )
    const rpcClient: any = await Effect.runPromise(
      RpcClient.make(TestRpcs).pipe(
        Effect.provideService(RpcClient.Protocol, protocol),
        Scope.provide(clientScope)
      )
    )

    await vi.advanceTimersByTimeAsync(35_000)
    vi.useRealTimers()

    const result = await Effect.runPromise(
      rpcClient.echo({ input: 'still alive without raw heartbeat' })
    )
    expect(result).toBe('still alive without raw heartbeat')

    await Effect.runPromise(Scope.close(clientScope, Exit.void)).catch(() => {
      // Scope may already be partially closed.
    })
    await Effect.runPromise(Scope.close(serverScope, Exit.void)).catch(() => {
      // Scope may already be partially closed.
    })
  })
})
