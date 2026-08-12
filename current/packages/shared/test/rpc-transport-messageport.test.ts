/**
 * Tests for the MessagePort RPC Server Transport.
 *
 * Verifies that `layerProtocolMessagePort` correctly serves Effect RPC
 * handlers over a MessagePort. Uses Node.js `MessageChannel` from
 * `worker_threads` to create port pairs (no Electron dependency).
 *
 * @see packages/shared/src/rpc-transport-messageport.ts
 * @see Issue #3: MessagePort Effect RPC transport (server side)
 */

import { MessageChannel } from 'node:worker_threads'
import { Effect, Exit, Layer, Schema, Scope, Stream } from 'effect'
import { Rpc, RpcGroup, RpcServer } from 'effect/unstable/rpc'
import type {
  FromClientEncoded,
  FromServerEncoded,
  ResponseChunkEncoded,
  ResponseExitEncoded,
} from 'effect/unstable/rpc/RpcMessage'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RpcMessagePort } from '../src/rpc-transport-messageport.js'
import { layerProtocolMessagePort } from '../src/rpc-transport-messageport.js'

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
// Helper: send a raw RPC request and collect responses
// ---------------------------------------------------------------------------

function collectResponses(
  clientPort: import('node:worker_threads').MessagePort,
  request: FromClientEncoded,
  requestId: string
): Promise<FromServerEncoded[]> {
  return new Promise<FromServerEncoded[]>((resolve, reject) => {
    const messages: FromServerEncoded[] = []
    const timeout = setTimeout(() => {
      clientPort.off('message', handler)
      reject(
        new Error(`Timed out waiting for response to request ${requestId}`)
      )
    }, 5000)

    const handler = (data: unknown): void => {
      const msg = data as FromServerEncoded
      messages.push(msg)

      if (
        (msg._tag === 'Exit' && msg.requestId === requestId) ||
        msg._tag === 'Defect'
      ) {
        clearTimeout(timeout)
        clientPort.off('message', handler)
        resolve(messages)
      }
    }

    clientPort.on('message', handler)
    clientPort.postMessage(request)
  })
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

describe('layerProtocolMessagePort', () => {
  let channel: MessageChannel
  let serverPort: import('node:worker_threads').MessagePort
  let clientPort: import('node:worker_threads').MessagePort
  let scope: Scope.Closeable
  let requestCounter: number

  beforeEach(async () => {
    channel = new MessageChannel()
    serverPort = channel.port1
    clientPort = channel.port2
    requestCounter = 0

    const rpcServerPort = toRpcPort(serverPort)
    const TestServerLayer = RpcServer.layer(TestRpcs).pipe(
      Layer.provide(layerProtocolMessagePort(rpcServerPort)),
      Layer.provide(TestRpcsLive)
    )

    scope = Effect.runSync(Scope.make())
    await Effect.runPromise(
      Layer.buildWithScope(TestServerLayer, scope).pipe(Effect.asVoid)
    )
  })

  afterEach(async () => {
    await Effect.runPromise(Scope.close(scope, Exit.void))
    clientPort.close()
  })

  function nextRequestId(): string {
    return String(++requestCounter)
  }

  // -----------------------------------------------------------------------
  // Request/response
  // -----------------------------------------------------------------------

  it('handles echo request/response', async () => {
    const id = nextRequestId()
    const msgs = await collectResponses(
      clientPort,
      {
        _tag: 'Request',
        id,
        tag: 'echo',
        payload: { input: 'hello world' },
        headers: [],
      },
      id
    )

    const exit = msgs.find(
      (m): m is ResponseExitEncoded => m._tag === 'Exit' && m.requestId === id
    )
    expect(exit).toBeDefined()
    expect(exit?.exit._tag).toBe('Success')
    if (exit?.exit._tag === 'Success') {
      expect(exit.exit.value).toBe('hello world')
    }
  })

  it('handles add request/response', async () => {
    const id = nextRequestId()
    const msgs = await collectResponses(
      clientPort,
      {
        _tag: 'Request',
        id,
        tag: 'add',
        payload: { a: 3, b: 7 },
        headers: [],
      },
      id
    )

    const exit = msgs.find(
      (m): m is ResponseExitEncoded => m._tag === 'Exit' && m.requestId === id
    )
    expect(exit).toBeDefined()
    expect(exit?.exit._tag).toBe('Success')
    if (exit?.exit._tag === 'Success') {
      expect(exit.exit.value).toBe(10)
    }
  })

  // -----------------------------------------------------------------------
  // Error propagation
  // -----------------------------------------------------------------------

  it('propagates RPC errors', async () => {
    const id = nextRequestId()
    const msgs = await collectResponses(
      clientPort,
      {
        _tag: 'Request',
        id,
        tag: 'fail',
        payload: { message: 'something went wrong' },
        headers: [],
      },
      id
    )

    const exit = msgs.find(
      (m): m is ResponseExitEncoded => m._tag === 'Exit' && m.requestId === id
    )
    expect(exit).toBeDefined()
    expect(exit?.exit._tag).toBe('Failure')
  })

  // -----------------------------------------------------------------------
  // Streaming
  // -----------------------------------------------------------------------

  it('handles streaming RPC', async () => {
    const id = nextRequestId()
    const msgs = await collectResponses(
      clientPort,
      {
        _tag: 'Request',
        id,
        tag: 'count',
        payload: { count: 5 },
        headers: [],
      },
      id
    )

    const chunks = msgs.filter(
      (m): m is ResponseChunkEncoded => m._tag === 'Chunk' && m.requestId === id
    )
    const exit = msgs.find(
      (m): m is ResponseExitEncoded => m._tag === 'Exit' && m.requestId === id
    )

    const values = chunks.flatMap((c) => [...c.values] as number[])
    expect(values).toEqual([0, 1, 2, 3, 4])
    expect(exit).toBeDefined()
    expect(exit?.exit._tag).toBe('Success')
  })

  // -----------------------------------------------------------------------
  // Multiple concurrent requests
  // -----------------------------------------------------------------------

  it('handles multiple concurrent requests', async () => {
    const id1 = nextRequestId()
    const id2 = nextRequestId()
    const id3 = nextRequestId()

    const [r1, r2, r3] = await Promise.all([
      collectResponses(
        clientPort,
        {
          _tag: 'Request',
          id: id1,
          tag: 'echo',
          payload: { input: 'first' },
          headers: [],
        },
        id1
      ),
      collectResponses(
        clientPort,
        {
          _tag: 'Request',
          id: id2,
          tag: 'add',
          payload: { a: 10, b: 20 },
          headers: [],
        },
        id2
      ),
      collectResponses(
        clientPort,
        {
          _tag: 'Request',
          id: id3,
          tag: 'echo',
          payload: { input: 'third' },
          headers: [],
        },
        id3
      ),
    ])

    const exit1 = r1.find(
      (m): m is ResponseExitEncoded => m._tag === 'Exit' && m.requestId === id1
    )
    const exit2 = r2.find(
      (m): m is ResponseExitEncoded => m._tag === 'Exit' && m.requestId === id2
    )
    const exit3 = r3.find(
      (m): m is ResponseExitEncoded => m._tag === 'Exit' && m.requestId === id3
    )

    expect(exit1).toBeDefined()
    expect(exit2).toBeDefined()
    expect(exit3).toBeDefined()

    if (exit1?.exit._tag === 'Success') {
      expect(exit1.exit.value).toBe('first')
    }
    if (exit2?.exit._tag === 'Success') {
      expect(exit2.exit.value).toBe(30)
    }
    if (exit3?.exit._tag === 'Success') {
      expect(exit3.exit.value).toBe('third')
    }
  })

  // -----------------------------------------------------------------------
  // Unknown RPC tag
  // -----------------------------------------------------------------------

  it('handles unknown RPC tag', async () => {
    const id = nextRequestId()
    const msgs = await collectResponses(
      clientPort,
      {
        _tag: 'Request',
        id,
        tag: 'nonexistent',
        payload: {},
        headers: [],
      },
      id
    )

    // Should get a Defect or an Exit with failure for an unknown tag
    const defectOrExit = msgs.find(
      (m) => m._tag === 'Defect' || m._tag === 'Exit'
    )
    expect(defectOrExit).toBeDefined()
  })

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  it('cleans up when scope is closed', async () => {
    // Verify server works
    const id = nextRequestId()
    const msgs = await collectResponses(
      clientPort,
      {
        _tag: 'Request',
        id,
        tag: 'echo',
        payload: { input: 'before close' },
        headers: [],
      },
      id
    )
    expect(msgs.length).toBeGreaterThan(0)

    // Close the scope — should clean up the server
    await Effect.runPromise(Scope.close(scope, Exit.void))

    // Create a new scope so afterEach doesn't double-close
    scope = Effect.runSync(Scope.make())
  })
})
