/**
 * MessagePort Transport Integration Tests
 *
 * Verifies that all 8 TerminalRpcs endpoints work end-to-end through
 * the actual MessagePort RPC transport (not just `RpcTest.makeClient`).
 *
 * This test creates a real `MessageChannel` from `worker_threads`,
 * wires the server-side transport (`layerProtocolMessagePort`) with
 * `TerminalRpcsLive` + `PtyDirectLayer`, and connects a client via
 * `makeClientProtocolMessagePort`. This proves the full stack:
 *
 *   Client (MessagePort) -> Server (MessagePort) -> RPC handlers
 *     -> TerminalManager -> PtyHostClient (directLayer) -> node-pty
 *
 * @see Issue #7: Terminal utility process: full RPC surface
 * @see packages/shared/src/rpc-transport-messageport.ts (server transport)
 * @see packages/shared/src/rpc-transport-messageport-client.ts (client transport)
 */

import { MessageChannel } from 'node:worker_threads'
import { assert, describe } from '@effect/vitest'
import { TerminalRpcs } from '@laborer/shared/rpc'
import type { RpcMessagePort } from '@laborer/shared/rpc-transport-messageport'
import { layerProtocolMessagePort } from '@laborer/shared/rpc-transport-messageport'
import { makeClientProtocolMessagePort } from '@laborer/shared/rpc-transport-messageport-client'
import { Effect, Exit, Fiber, Layer, Result, Scope, Stream } from 'effect'
import { RpcClient, RpcServer } from 'effect/unstable/rpc'
import { afterAll, beforeAll, it } from 'vitest'

import { TerminalRpcsLive } from '../src/rpc/handlers.js'
import { directLayer as PtyDirectLayer } from '../src/services/pty-direct.js'
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
// Test setup: real MessagePort server + client
// ---------------------------------------------------------------------------

/**
 * Server layer: TerminalRpcs over MessagePort with PtyDirectLayer.
 * This mirrors the utility-main.ts composition exactly.
 */
function buildServerLayer(port: RpcMessagePort) {
  return RpcServer.layer(TerminalRpcs).pipe(
    Layer.provide(layerProtocolMessagePort(port)),
    Layer.provide(TerminalRpcsLive),
    Layer.provide(TerminalManager.layer),
    Layer.provide(PtyDirectLayer)
  )
}

/**
 * Infer the client type from `RpcClient.make(TerminalRpcs)`.
 * This avoids `any` and provides full type safety for all RPC calls.
 */
const MakeTerminalClient = RpcClient.make(TerminalRpcs)
type TerminalRpcClient = Effect.Success<typeof MakeTerminalClient>

let serverScope: Scope.Closeable
let clientScope: Scope.Closeable
let client: TerminalRpcClient

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(effect)

const TEST_WORKSPACE_ID = 'messageport-rpc-test-workspace'
const TEST_CWD = '/tmp'

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
      Scope.provide(clientScope)
    )
  )
  client = await Effect.runPromise(
    MakeTerminalClient.pipe(
      Effect.provideService(RpcClient.Protocol, protocol),
      Scope.provide(clientScope)
    )
  )
}, 30_000)

afterAll(async () => {
  await Effect.runPromise(Scope.close(clientScope, Exit.void))
  await Effect.runPromise(Scope.close(serverScope, Exit.void))
}, 15_000)

// ---------------------------------------------------------------------------
// Tests — all 8 TerminalRpcs endpoints through MessagePort transport
// ---------------------------------------------------------------------------

describe('TerminalRpcs over MessagePort transport', { timeout: 30_000 }, () => {
  // -----------------------------------------------------------------------
  // terminal.spawn
  // -----------------------------------------------------------------------

  it('terminal.spawn creates a terminal via MessagePort', async () => {
    const result = await run(
      client['terminal.spawn']({
        command: 'echo "mp-spawn-test"',
        cwd: TEST_CWD,
        cols: 80,
        rows: 24,
        workspaceId: TEST_WORKSPACE_ID,
      })
    )

    assert.isDefined(result.id)
    assert.strictEqual(result.workspaceId, TEST_WORKSPACE_ID)
    assert.strictEqual(result.command, 'echo "mp-spawn-test"')
    assert.strictEqual(result.cwd, TEST_CWD)
    assert.strictEqual(result.status, 'running')
    assert.deepStrictEqual(result.args, [])
    assert.strictEqual(typeof result.hasChildProcess, 'boolean')

    await delay(2000)
  })

  // -----------------------------------------------------------------------
  // terminal.write
  // -----------------------------------------------------------------------

  it('terminal.write sends data via MessagePort', async () => {
    const terminal = await run(
      client['terminal.spawn']({
        command: 'cat',
        cwd: TEST_CWD,
        cols: 80,
        rows: 24,
        workspaceId: TEST_WORKSPACE_ID,
      })
    )

    await delay(500)

    await run(
      client['terminal.write']({
        id: terminal.id,
        data: 'mp-write-test\n',
      })
    )

    await run(client['terminal.kill']({ id: terminal.id }))
    await delay(500)
  })

  it('terminal.write fails for nonexistent terminal via MessagePort', async () => {
    const result = await run(
      Effect.result(
        client['terminal.write']({
          id: 'mp-nonexistent-write',
          data: 'should-fail',
        })
      )
    )

    assert.isTrue(Result.isFailure(result))
  })

  // -----------------------------------------------------------------------
  // terminal.resize
  // -----------------------------------------------------------------------

  it('terminal.resize changes dimensions via MessagePort', async () => {
    const terminal = await run(
      client['terminal.spawn']({
        command: 'cat',
        cwd: TEST_CWD,
        cols: 80,
        rows: 24,
        workspaceId: TEST_WORKSPACE_ID,
      })
    )

    await delay(500)

    await run(
      client['terminal.resize']({
        id: terminal.id,
        cols: 120,
        rows: 40,
      })
    )

    // Verify PTY is still alive by writing
    await run(
      client['terminal.write']({
        id: terminal.id,
        data: 'after-mp-resize\n',
      })
    )

    await run(client['terminal.kill']({ id: terminal.id }))
    await delay(500)
  })

  it('terminal.resize fails for nonexistent terminal via MessagePort', async () => {
    const result = await run(
      Effect.result(
        client['terminal.resize']({
          id: 'mp-nonexistent-resize',
          cols: 100,
          rows: 50,
        })
      )
    )

    assert.isTrue(Result.isFailure(result))
  })

  // -----------------------------------------------------------------------
  // terminal.kill
  // -----------------------------------------------------------------------

  it('terminal.kill stops a terminal via MessagePort', async () => {
    const terminal = await run(
      client['terminal.spawn']({
        command: 'cat',
        cwd: TEST_CWD,
        cols: 80,
        rows: 24,
        workspaceId: TEST_WORKSPACE_ID,
      })
    )

    await delay(500)

    await run(client['terminal.kill']({ id: terminal.id }))
    await delay(500)

    const terminals = await run(client['terminal.list']())
    const found = terminals.find(
      (t: { readonly id: string }) => t.id === terminal.id
    )
    assert.isDefined(found)
    assert.strictEqual(found?.status, 'stopped')
  })

  it('terminal.kill fails for nonexistent terminal via MessagePort', async () => {
    const result = await run(
      Effect.result(client['terminal.kill']({ id: 'mp-nonexistent-kill' }))
    )

    assert.isTrue(Result.isFailure(result))
  })

  // -----------------------------------------------------------------------
  // terminal.remove
  // -----------------------------------------------------------------------

  it('terminal.remove fully deletes a terminal via MessagePort', async () => {
    const terminal = await run(
      client['terminal.spawn']({
        command: 'echo "mp-to-be-removed"',
        cwd: TEST_CWD,
        cols: 80,
        rows: 24,
        workspaceId: TEST_WORKSPACE_ID,
      })
    )

    await delay(2000)

    const beforeRemove = await run(client['terminal.list']())
    assert.strictEqual(
      beforeRemove.find((t: { readonly id: string }) => t.id === terminal.id)
        ?.status,
      'stopped'
    )

    await run(client['terminal.remove']({ id: terminal.id }))

    const afterRemove = await run(client['terminal.list']())
    assert.isUndefined(
      afterRemove.find((t: { readonly id: string }) => t.id === terminal.id)
    )
  })

  it('terminal.remove fails for nonexistent terminal via MessagePort', async () => {
    const result = await run(
      Effect.result(client['terminal.remove']({ id: 'mp-nonexistent-remove' }))
    )

    assert.isTrue(Result.isFailure(result))
  })

  // -----------------------------------------------------------------------
  // terminal.restart
  // -----------------------------------------------------------------------

  it('terminal.restart respawns a stopped terminal via MessagePort', async () => {
    const terminal = await run(
      client['terminal.spawn']({
        command: 'cat',
        cwd: TEST_CWD,
        cols: 80,
        rows: 24,
        workspaceId: TEST_WORKSPACE_ID,
      })
    )

    await delay(500)

    await run(client['terminal.kill']({ id: terminal.id }))
    await delay(500)

    const restarted = await run(client['terminal.restart']({ id: terminal.id }))

    assert.strictEqual(restarted.id, terminal.id)
    assert.strictEqual(restarted.command, 'cat')
    assert.strictEqual(restarted.cwd, TEST_CWD)
    assert.strictEqual(restarted.status, 'running')
    assert.strictEqual(restarted.workspaceId, TEST_WORKSPACE_ID)
    assert.strictEqual(typeof restarted.hasChildProcess, 'boolean')

    // Verify alive
    await run(
      client['terminal.write']({
        id: terminal.id,
        data: 'after-mp-restart\n',
      })
    )

    await run(client['terminal.kill']({ id: terminal.id }))
    await delay(500)
  })

  it('terminal.restart fails for nonexistent terminal via MessagePort', async () => {
    const result = await run(
      Effect.result(
        client['terminal.restart']({ id: 'mp-nonexistent-restart' })
      )
    )

    assert.isTrue(Result.isFailure(result))
  })

  // -----------------------------------------------------------------------
  // terminal.list
  // -----------------------------------------------------------------------

  it('terminal.list returns terminals via MessagePort', async () => {
    const terminal = await run(
      client['terminal.spawn']({
        command: 'sleep 60',
        cwd: TEST_CWD,
        cols: 80,
        rows: 24,
        workspaceId: TEST_WORKSPACE_ID,
      })
    )

    await delay(500)

    const terminals = await run(client['terminal.list']())
    const found = terminals.find(
      (t: { readonly id: string }) => t.id === terminal.id
    )
    assert.isDefined(found)
    assert.strictEqual(found?.status, 'running')

    await run(client['terminal.kill']({ id: terminal.id }))
    await delay(500)
  })

  // -----------------------------------------------------------------------
  // terminal.events (streaming)
  // -----------------------------------------------------------------------

  it('terminal.events streams lifecycle events via MessagePort', async () => {
    // Start listening for events
    const eventsFiber = Effect.runFork(
      Stream.runCollect(client['terminal.events']().pipe(Stream.take(1)))
    )

    await delay(200)

    const terminal = await run(
      client['terminal.spawn']({
        command: 'echo "mp-events-test"',
        cwd: TEST_CWD,
        cols: 80,
        rows: 24,
        workspaceId: TEST_WORKSPACE_ID,
      })
    )

    const events = await Effect.runPromise(Fiber.join(eventsFiber))
    const eventArray = [...events]

    assert.strictEqual(eventArray.length, 1)
    const firstEvent = eventArray.at(0)
    assert.isDefined(firstEvent)
    if (firstEvent !== undefined && firstEvent._tag === 'Spawned') {
      assert.strictEqual(firstEvent.id, terminal.id)
      assert.strictEqual(firstEvent.workspaceId, TEST_WORKSPACE_ID)
    } else {
      assert.fail('Expected first event to be Spawned')
    }

    await delay(2000)
  })
})
