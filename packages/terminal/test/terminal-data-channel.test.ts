/**
 * Terminal Data Channel Integration Tests
 *
 * Verifies that per-terminal MessagePort data channels work correctly
 * for streaming PTY I/O. Tests the `attachDataChannel` function from
 * `terminal-data-channel.ts` using real `MessageChannel` from
 * `worker_threads`.
 *
 * The data channel is tested end-to-end:
 *   Renderer MessagePort -> Data Channel Handler -> TerminalManager
 *     -> PtyHostClient (directLayer) -> node-pty
 *
 * @see Issue #8: Terminal PTY I/O data channel over MessagePort
 * @see packages/terminal/src/services/terminal-data-channel.ts
 */

import { MessageChannel } from 'node:worker_threads'

import { RpcClient, RpcServer } from '@effect/rpc'
import { assert, describe } from '@effect/vitest'
import { TerminalRpcs } from '@laborer/shared/rpc'
import type { RpcMessagePort } from '@laborer/shared/rpc-transport-messageport'
import { layerProtocolMessagePort } from '@laborer/shared/rpc-transport-messageport'
import { makeClientProtocolMessagePort } from '@laborer/shared/rpc-transport-messageport-client'
import {
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Runtime,
  Scope,
} from 'effect'
import { afterAll, beforeAll, it } from 'vitest'

import { TerminalRpcsLive } from '../src/rpc/handlers.js'
import { directLayer as PtyDirectLayer } from '../src/services/pty-direct.js'
import type { PtyHostClient } from '../src/services/pty-host-client.js'
import { attachDataChannel } from '../src/services/terminal-data-channel.js'
import { TerminalManager } from '../src/services/terminal-manager.js'

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
// Test setup: shared services + RPC client for spawning terminals
// ---------------------------------------------------------------------------

const MakeTerminalClient = RpcClient.make(TerminalRpcs)
type TerminalRpcClient = Effect.Effect.Success<typeof MakeTerminalClient>

/**
 * Services layer — provides both TerminalManager and PtyHostClient.
 * Same composition as utility-main.ts.
 */
const ServicesLayer = Layer.merge(TerminalManager.layer, PtyDirectLayer).pipe(
  Layer.provide(PtyDirectLayer)
)

let clientScope: Scope.CloseableScope
let client: TerminalRpcClient
/** ManagedRuntime with shared services for data channel handlers. */
let managedRt: ManagedRuntime.ManagedRuntime<
  TerminalManager | PtyHostClient,
  never
>
let dataChannelRuntime: Runtime.Runtime<TerminalManager | PtyHostClient>

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(effect)

const TEST_WORKSPACE_ID = 'data-channel-test-workspace'
const TEST_CWD = '/tmp'

beforeAll(async () => {
  // Build RPC server that uses the same services layer.
  const { port1: rpcPort1, port2: rpcPort2 } = new MessageChannel()

  // Full layer: RPC server + services passthrough.
  // This mirrors the utility-main.ts composition.
  const RpcLive = RpcServer.layer(TerminalRpcs).pipe(
    Layer.provide(layerProtocolMessagePort(toRpcPort(rpcPort1))),
    Layer.provide(TerminalRpcsLive),
    Layer.provide(ServicesLayer)
  )

  const FullLayer = Layer.merge(RpcLive, ServicesLayer)

  // Create managed runtime — shares services between RPC and data channels.
  managedRt = ManagedRuntime.make(FullLayer)
  dataChannelRuntime = await managedRt.runtime()

  // Build RPC client.
  clientScope = Effect.runSync(Scope.make())
  const protocol = await Effect.runPromise(
    makeClientProtocolMessagePort(toRpcPort(rpcPort2)).pipe(
      Scope.extend(clientScope)
    )
  )
  client = await Effect.runPromise(
    MakeTerminalClient.pipe(
      Effect.provideService(RpcClient.Protocol, protocol),
      Scope.extend(clientScope)
    )
  )
}, 30_000)

afterAll(async () => {
  await Effect.runPromise(Scope.close(clientScope, Exit.void))
  await managedRt.dispose()
}, 15_000)

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Terminal data channel over MessagePort', { timeout: 30_000 }, () => {
  it('receives PTY output data via data channel port', async () => {
    // Spawn a terminal via RPC.
    const terminal = await run(
      client.terminal.spawn({
        command: 'echo "data-channel-output-test"',
        cwd: TEST_CWD,
        cols: 80,
        rows: 24,
        workspaceId: TEST_WORKSPACE_ID,
      })
    )

    // Create a data channel for this terminal.
    const { port1: rendererPort, port2: utilityPort } = new MessageChannel()

    const receivedMessages: unknown[] = []
    rendererPort.on('message', (data: unknown) => {
      receivedMessages.push(data)
    })

    // Attach the data channel using the shared runtime.
    const fiber = Runtime.runFork(dataChannelRuntime)(
      attachDataChannel(toRpcPort(utilityPort), terminal.id).pipe(Effect.scoped)
    )

    // Wait for output data to arrive.
    await delay(2000)

    // Should have received at least a status message and screen state.
    assert.isTrue(
      receivedMessages.length >= 2,
      `Expected at least 2 messages, got ${receivedMessages.length}: ${JSON.stringify(receivedMessages.slice(0, 3))}`
    )

    // First message should be a status control message.
    const firstMsg = receivedMessages[0]
    assert.strictEqual(typeof firstMsg, 'string')
    const parsed = JSON.parse(firstMsg as string) as Record<string, unknown>
    assert.strictEqual(parsed.type, 'status')
    assert.strictEqual(parsed.status, 'running')

    // Second message should be a screen state snapshot.
    const secondMsg = receivedMessages[1]
    assert.strictEqual(typeof secondMsg, 'string')
    const screenState = JSON.parse(secondMsg as string) as Record<
      string,
      unknown
    >
    assert.strictEqual(screenState.type, 'screenState')
    assert.strictEqual(typeof screenState.data, 'string')

    // Clean up.
    rendererPort.close()
    await Effect.runPromise(Fiber.interrupt(fiber))
  })

  it('sends input data from renderer to PTY via data channel', async () => {
    // Spawn a terminal that reads input (cat).
    const terminal = await run(
      client.terminal.spawn({
        command: '/bin/cat',
        cwd: TEST_CWD,
        cols: 80,
        rows: 24,
        workspaceId: TEST_WORKSPACE_ID,
      })
    )

    // Create a data channel.
    const { port1: rendererPort, port2: utilityPort } = new MessageChannel()

    const receivedMessages: unknown[] = []
    rendererPort.on('message', (data: unknown) => {
      receivedMessages.push(data)
    })

    const fiber = Runtime.runFork(dataChannelRuntime)(
      attachDataChannel(toRpcPort(utilityPort), terminal.id).pipe(Effect.scoped)
    )

    // Wait for the channel to be established.
    await delay(500)

    // Send input via the renderer port.
    rendererPort.postMessage('test-input\n')

    // Wait for echo from cat.
    await delay(1000)

    // Should receive the echoed input as PTY output.
    const hasEcho = receivedMessages.some((msg) => {
      if (typeof msg === 'string' && !msg.startsWith('{')) {
        return msg.includes('test-input')
      }
      // Could be an ArrayBuffer for large output.
      if (msg instanceof ArrayBuffer) {
        const text = new TextDecoder().decode(msg)
        return text.includes('test-input')
      }
      return false
    })

    assert.isTrue(hasEcho, 'Expected to receive echoed input via data channel')

    // Kill the terminal and clean up.
    await run(client.terminal.kill({ id: terminal.id }))
    rendererPort.close()
    await Effect.runPromise(Fiber.interrupt(fiber))
  })

  it('sends flow control ack from renderer to utility process', async () => {
    // Spawn a terminal.
    const terminal = await run(
      client.terminal.spawn({
        command: 'echo "ack-test"',
        cwd: TEST_CWD,
        cols: 80,
        rows: 24,
        workspaceId: TEST_WORKSPACE_ID,
      })
    )

    // Create a data channel.
    const { port1: rendererPort, port2: utilityPort } = new MessageChannel()

    const fiber = Runtime.runFork(dataChannelRuntime)(
      attachDataChannel(toRpcPort(utilityPort), terminal.id).pipe(Effect.scoped)
    )

    await delay(500)

    // Send a flow control ack — this should not crash and should be
    // processed by the ptyHostClient.ack() method.
    rendererPort.postMessage(JSON.stringify({ type: 'ack', chars: 5000 }))

    // Wait and verify no crash.
    await delay(500)

    // Clean up.
    rendererPort.close()
    await Effect.runPromise(Fiber.interrupt(fiber))
  })

  it('closes data channel port when terminal exits', async () => {
    // Spawn a short-lived terminal.
    const terminal = await run(
      client.terminal.spawn({
        command: 'echo "exit-test"',
        cwd: TEST_CWD,
        cols: 80,
        rows: 24,
        workspaceId: TEST_WORKSPACE_ID,
      })
    )

    // Create a data channel.
    const { port1: rendererPort, port2: utilityPort } = new MessageChannel()

    const receivedMessages: unknown[] = []
    rendererPort.on('message', (data: unknown) => {
      receivedMessages.push(data)
    })

    const fiber = Runtime.runFork(dataChannelRuntime)(
      attachDataChannel(toRpcPort(utilityPort), terminal.id).pipe(Effect.scoped)
    )

    // Wait for the echo to complete and the terminal to exit.
    await delay(3000)

    // Should have received a stopped status message.
    const hasStoppedStatus = receivedMessages.some((msg) => {
      if (typeof msg !== 'string') {
        return false
      }
      try {
        const parsed = JSON.parse(msg) as Record<string, unknown>
        return parsed.type === 'status' && parsed.status === 'stopped'
      } catch {
        return false
      }
    })

    assert.isTrue(
      hasStoppedStatus,
      'Expected to receive stopped status when terminal exits'
    )

    // Clean up.
    rendererPort.close()
    await Effect.runPromise(Fiber.interrupt(fiber))
  })

  it('handles data channel for non-existent terminal', async () => {
    // Create a data channel for a terminal that doesn't exist.
    const { port1: rendererPort, port2: utilityPort } = new MessageChannel()

    const receivedMessages: unknown[] = []
    rendererPort.on('message', (data: unknown) => {
      receivedMessages.push(data)
    })

    const fiber = Runtime.runFork(dataChannelRuntime)(
      attachDataChannel(toRpcPort(utilityPort), 'nonexistent-terminal-id').pipe(
        Effect.scoped
      )
    )

    // Wait for error response.
    await delay(500)

    // Should receive an error message.
    assert.isTrue(
      receivedMessages.length >= 1,
      'Expected at least 1 message for non-existent terminal'
    )

    const errorMsg = receivedMessages[0]
    assert.strictEqual(typeof errorMsg, 'string')
    const parsed = JSON.parse(errorMsg as string) as Record<string, unknown>
    assert.strictEqual(parsed.type, 'error')

    // Clean up.
    rendererPort.close()
    await Effect.runPromise(Fiber.interrupt(fiber))
  })

  it('data channel is separate from RPC channel', async () => {
    // Spawn a terminal via RPC.
    const terminal = await run(
      client.terminal.spawn({
        command: 'echo "separate-channels"',
        cwd: TEST_CWD,
        cols: 80,
        rows: 24,
        workspaceId: TEST_WORKSPACE_ID,
      })
    )

    // Create a data channel.
    const { port1: rendererPort, port2: utilityPort } = new MessageChannel()

    const dataMessages: unknown[] = []
    rendererPort.on('message', (data: unknown) => {
      dataMessages.push(data)
    })

    const fiber = Runtime.runFork(dataChannelRuntime)(
      attachDataChannel(toRpcPort(utilityPort), terminal.id).pipe(Effect.scoped)
    )

    await delay(1000)

    // Verify RPC still works independently — list terminals via RPC.
    const terminals = await run(client.terminal.list())
    assert.isTrue(
      terminals.length > 0,
      'RPC should still work while data channel is active'
    )

    // Verify data channel received data.
    assert.isTrue(
      dataMessages.length >= 2,
      'Data channel should receive status + screen state'
    )

    // Clean up.
    rendererPort.close()
    await Effect.runPromise(Fiber.interrupt(fiber))
  })
})
