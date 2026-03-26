/**
 * Direct PTY Client Tests
 *
 * Verifies that the `directLayer` PtyHostClient implementation (which uses
 * node-pty directly without a child process) works correctly with
 * TerminalManager and the RPC handlers.
 *
 * These tests validate Issue #6: Terminal utility process: basic PTY spawn
 * via MessagePort RPC. They prove the flattened architecture works:
 *   RPC handler -> TerminalManager -> PtyHostClient (directLayer) -> node-pty
 *
 * The test uses `RpcTest.makeClient` for in-memory RPC (same pattern as
 * `rpc-integration.test.ts`), but swaps `PtyHostClient.layer` for
 * `PtyDirectLayer` to verify the direct node-pty implementation.
 *
 * The MessagePort transport itself is already tested in the shared package
 * (issues #3 and #4). This test validates the service layer composition.
 *
 * @see packages/terminal/src/services/pty-direct.ts
 * @see Issue #6: Terminal utility process: basic PTY spawn via MessagePort RPC
 */

import { RpcTest } from '@effect/rpc'
import { assert, describe } from '@effect/vitest'
import { TerminalRpcs } from '@laborer/shared/rpc'
import { Effect, Exit, Fiber, Layer, Scope, Stream } from 'effect'
import { afterAll, beforeAll, it } from 'vitest'

import { TerminalRpcsLive } from '../src/rpc/handlers.js'
import { directLayer as PtyDirectLayer } from '../src/services/pty-direct.js'
import { TerminalManager } from '../src/services/terminal-manager.js'

// ---------------------------------------------------------------------------
// Test layer construction
// ---------------------------------------------------------------------------

/**
 * Test layer: TerminalRpcs handler + TerminalManager + PtyDirectLayer.
 *
 * This mirrors the utility-main.ts composition but substitutes PtyDirectLayer
 * for PtyHostClient.layer, proving the direct node-pty implementation works
 * as a drop-in replacement.
 */
const TestLayer = TerminalRpcsLive.pipe(
  Layer.provide(TerminalManager.layer),
  Layer.provideMerge(PtyDirectLayer)
)

/**
 * The client Effect — produces an in-memory RPC client when provided with
 * the handler layer and a Scope.
 */
const TestTerminalRpcClient = RpcTest.makeClient(TerminalRpcs)

// ---------------------------------------------------------------------------
// Shared scope for the long-lived PtyDirectLayer
// ---------------------------------------------------------------------------

type TerminalRpcClient = Effect.Effect.Success<typeof TestTerminalRpcClient>

let layerScope: Scope.CloseableScope
let clientScope: Scope.CloseableScope
let client: TerminalRpcClient

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(effect)

beforeAll(async () => {
  layerScope = Effect.runSync(Scope.make())
  clientScope = Effect.runSync(Scope.make())
  const context = await Effect.runPromise(
    Layer.buildWithScope(TestLayer, layerScope)
  )

  client = await Effect.runPromise(
    TestTerminalRpcClient.pipe(
      Effect.provide(Layer.succeedContext(context)),
      Scope.extend(clientScope)
    )
  )
}, 30_000)

afterAll(async () => {
  await Effect.runPromise(Scope.close(clientScope, Exit.void))
  await Effect.runPromise(Scope.close(layerScope, Exit.void))
}, 15_000)

const TEST_WORKSPACE_ID = 'pty-direct-test-workspace'
const TEST_CWD = '/tmp'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe(
  'Terminal with direct PTY (flattened architecture)',
  { timeout: 30_000 },
  () => {
    // -----------------------------------------------------------------------
    // terminal.spawn — validates node-pty works directly (no child process)
    // -----------------------------------------------------------------------

    it('terminal.spawn creates a terminal and returns TerminalInfo', async () => {
      const result = await run(
        client.terminal.spawn({
          command: 'echo "direct-spawn-test"',
          cwd: TEST_CWD,
          cols: 80,
          rows: 24,
          workspaceId: TEST_WORKSPACE_ID,
        })
      )

      assert.isDefined(result.id)
      assert.strictEqual(result.workspaceId, TEST_WORKSPACE_ID)
      assert.strictEqual(result.command, 'echo "direct-spawn-test"')
      assert.strictEqual(result.cwd, TEST_CWD)
      assert.strictEqual(result.status, 'running')
      assert.deepStrictEqual(result.args, [])
      assert.strictEqual(typeof result.hasChildProcess, 'boolean')

      // Wait for the short-lived echo to exit
      await delay(2000)
    })

    it('terminal.spawn with args passes them correctly', async () => {
      const result = await run(
        client.terminal.spawn({
          command: '/bin/echo',
          args: ['direct', 'args', 'test'],
          cwd: TEST_CWD,
          cols: 80,
          rows: 24,
          workspaceId: TEST_WORKSPACE_ID,
        })
      )

      assert.strictEqual(result.command, '/bin/echo')
      assert.deepStrictEqual(result.args, ['direct', 'args', 'test'])
      assert.strictEqual(result.status, 'running')

      await delay(2000)
    })

    // -----------------------------------------------------------------------
    // terminal.kill — validates PTY process termination
    // -----------------------------------------------------------------------

    it('terminal.kill stops a running terminal', async () => {
      const terminal = await run(
        client.terminal.spawn({
          command: 'cat',
          cwd: TEST_CWD,
          cols: 80,
          rows: 24,
          workspaceId: TEST_WORKSPACE_ID,
        })
      )

      assert.strictEqual(terminal.status, 'running')
      await delay(500)

      // Kill it
      await run(client.terminal.kill({ id: terminal.id }))

      // Wait for exit to propagate
      await delay(1000)

      // Verify it shows as stopped in the list
      const terminals = await run(client.terminal.list())
      const found = terminals.find((t) => t.id === terminal.id)
      assert.isDefined(found)
      assert.strictEqual(found?.status, 'stopped')
    })

    // -----------------------------------------------------------------------
    // PTY output — validates node-pty is producing data
    // -----------------------------------------------------------------------

    it('terminal.events emits Spawned event when a terminal is created', async () => {
      // Start listening for events
      const eventsFiber = Effect.runFork(
        Stream.runCollect(client.terminal.events().pipe(Stream.take(1)))
      )

      // Small delay to ensure subscription is active
      await delay(200)

      const terminal = await run(
        client.terminal.spawn({
          command: 'echo "output-test"',
          cwd: TEST_CWD,
          cols: 80,
          rows: 24,
          workspaceId: TEST_WORKSPACE_ID,
        })
      )

      // Wait for the Spawned event
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

    // -----------------------------------------------------------------------
    // terminal.list — validates terminal registry
    // -----------------------------------------------------------------------

    it('terminal.list returns spawned terminals', async () => {
      const terminal = await run(
        client.terminal.spawn({
          command: 'sleep 60',
          cwd: TEST_CWD,
          cols: 80,
          rows: 24,
          workspaceId: TEST_WORKSPACE_ID,
        })
      )

      await delay(500)

      const terminals = await run(client.terminal.list())
      const found = terminals.find((t) => t.id === terminal.id)
      assert.isDefined(found)
      assert.strictEqual(found?.status, 'running')

      // Clean up
      await run(client.terminal.kill({ id: terminal.id }))
      await delay(500)
    })

    // -----------------------------------------------------------------------
    // Error case
    // -----------------------------------------------------------------------

    it('terminal.kill returns error for non-existent terminal', async () => {
      const result = await run(
        Effect.either(client.terminal.kill({ id: 'non-existent-id-direct' }))
      )

      assert.isTrue(result._tag === 'Left')
    })

    // -----------------------------------------------------------------------
    // terminal.write — validates input works with direct PTY
    // -----------------------------------------------------------------------

    it('terminal.write sends data to a running terminal', async () => {
      const terminal = await run(
        client.terminal.spawn({
          command: 'cat',
          cwd: TEST_CWD,
          cols: 80,
          rows: 24,
          workspaceId: TEST_WORKSPACE_ID,
        })
      )

      await delay(500)

      // Write should succeed without error
      await run(
        client.terminal.write({
          id: terminal.id,
          data: 'direct-write-test\n',
        })
      )

      // Clean up
      await run(client.terminal.kill({ id: terminal.id }))
      await delay(500)
    })
  }
)
