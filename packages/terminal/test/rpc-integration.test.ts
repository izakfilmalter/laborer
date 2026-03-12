/**
 * TerminalRpcs in-memory RPC integration tests.
 *
 * Tests all 8 TerminalRpcs endpoints through `RpcTest.makeClient` with
 * real `TerminalManager.layer` + `PtyHostClient.layer`. This verifies
 * the RPC handler + schema serialization/deserialization layer on top of
 * the service-level tests in `terminal-manager.test.ts`.
 *
 * Uses the same shared-scope `beforeAll`/`afterAll` pattern as
 * `terminal-manager.test.ts` because the PtyHostClient layer manages
 * a long-lived child process that cannot be scoped per-test.
 *
 * @see PRD-test-coverage.md — Issue 21
 * @see packages/server/test/rpc/test-layer.ts — Server RPC test pattern
 */

import { RpcTest } from '@effect/rpc'
import { assert, describe } from '@effect/vitest'
import { TerminalRpcs } from '@laborer/shared/rpc'
import { Effect, Either, Exit, Fiber, Layer, Scope, Stream } from 'effect'
import { afterAll, beforeAll, it } from 'vitest'

import { TerminalRpcsLive } from '../src/rpc/handlers.js'
import { PtyHostClient } from '../src/services/pty-host-client.js'
import { TerminalManager } from '../src/services/terminal-manager.js'

// ---------------------------------------------------------------------------
// Test layer construction
// ---------------------------------------------------------------------------

/**
 * Full test layer: TerminalRpcs handler + TerminalManager + PtyHostClient.
 */
const TestLayer = TerminalRpcsLive.pipe(
  Layer.provide(TerminalManager.layer),
  Layer.provideMerge(PtyHostClient.layer)
)

/**
 * The client Effect — produces an in-memory RPC client when provided with
 * the handler layer and a Scope.
 */
const TestTerminalRpcClient = RpcTest.makeClient(TerminalRpcs)

// ---------------------------------------------------------------------------
// Shared scope for the long-lived PtyHostClient layer
// ---------------------------------------------------------------------------

/**
 * Type of the RPC client returned by `RpcTest.makeClient(TerminalRpcs)`.
 * Inferred from the Effect's success type to avoid spelling complex generics.
 */
type TerminalRpcClient = Effect.Effect.Success<typeof TestTerminalRpcClient>

let layerScope: Scope.CloseableScope
let clientScope: Scope.CloseableScope
let client: TerminalRpcClient

/** Small delay to allow async PTY events to propagate through IPC. */
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Run an Effect that uses the RPC client's methods (which return Effects).
 * The RPC client methods return Effect<A, E, never>, so we can run them
 * directly via Effect.runPromise.
 */
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

const TEST_WORKSPACE_ID = 'rpc-test-workspace'
const TEST_CWD = '/tmp'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe(
  'TerminalRpcs (in-memory RPC integration)',
  { timeout: 30_000 },
  () => {
    // -----------------------------------------------------------------------
    // terminal.spawn
    // -----------------------------------------------------------------------

    it('terminal.spawn creates a terminal and returns TerminalInfo', async () => {
      const result = await run(
        client.terminal.spawn({
          command: 'echo "rpc-spawn-test"',
          cwd: TEST_CWD,
          cols: 80,
          rows: 24,
          workspaceId: TEST_WORKSPACE_ID,
        })
      )

      assert.isDefined(result.id)
      assert.strictEqual(result.workspaceId, TEST_WORKSPACE_ID)
      assert.strictEqual(result.command, 'echo "rpc-spawn-test"')
      assert.strictEqual(result.cwd, TEST_CWD)
      assert.strictEqual(result.status, 'running')
      assert.deepStrictEqual(result.args, [])
      // hasChildProcess must be a boolean in the RPC response
      assert.strictEqual(typeof result.hasChildProcess, 'boolean')

      // Wait for the short-lived echo to exit
      await delay(2000)
    })

    it('terminal.spawn with args passes them through the RPC layer', async () => {
      const result = await run(
        client.terminal.spawn({
          command: '/bin/echo',
          args: ['rpc', 'args', 'test'],
          cwd: TEST_CWD,
          cols: 80,
          rows: 24,
          workspaceId: TEST_WORKSPACE_ID,
        })
      )

      assert.strictEqual(result.command, '/bin/echo')
      assert.deepStrictEqual(result.args, ['rpc', 'args', 'test'])
      assert.strictEqual(result.status, 'running')

      await delay(2000)
    })

    // -----------------------------------------------------------------------
    // terminal.write
    // -----------------------------------------------------------------------

    it('terminal.write sends data to a running terminal without error', async () => {
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
          data: 'rpc-write-test\n',
        })
      )

      // Clean up
      await run(client.terminal.kill({ id: terminal.id }))
    })

    it('terminal.write fails for a nonexistent terminal', async () => {
      const result = await run(
        Effect.either(
          client.terminal.write({
            id: 'nonexistent-terminal-id',
            data: 'should-fail',
          })
        )
      )

      assert.isTrue(Either.isLeft(result))
    })

    // -----------------------------------------------------------------------
    // terminal.resize
    // -----------------------------------------------------------------------

    it('terminal.resize changes dimensions through the RPC layer', async () => {
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

      // Resize should succeed without error
      await run(
        client.terminal.resize({
          id: terminal.id,
          cols: 120,
          rows: 40,
        })
      )

      // Verify PTY is still alive by writing to it
      await run(
        client.terminal.write({
          id: terminal.id,
          data: 'after-rpc-resize\n',
        })
      )

      // Clean up
      await run(client.terminal.kill({ id: terminal.id }))
    })

    it('terminal.resize fails for a nonexistent terminal', async () => {
      const result = await run(
        Effect.either(
          client.terminal.resize({
            id: 'nonexistent-terminal-id',
            cols: 100,
            rows: 50,
          })
        )
      )

      assert.isTrue(Either.isLeft(result))
    })

    // -----------------------------------------------------------------------
    // terminal.kill
    // -----------------------------------------------------------------------

    it('terminal.kill marks a terminal as stopped through the RPC layer', async () => {
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

      await run(client.terminal.kill({ id: terminal.id }))
      await delay(500)

      // Verify via list that it's stopped (not removed)
      const terminals = await run(client.terminal.list())
      const found = terminals.find(
        (t: { readonly id: string }) => t.id === terminal.id
      )
      assert.isDefined(found)
      assert.strictEqual(found?.status, 'stopped')
    })

    it('terminal.kill fails for a nonexistent terminal', async () => {
      const result = await run(
        Effect.either(client.terminal.kill({ id: 'nonexistent-terminal-id' }))
      )

      assert.isTrue(Either.isLeft(result))
    })

    // -----------------------------------------------------------------------
    // terminal.remove
    // -----------------------------------------------------------------------

    it('terminal.remove fully deletes a terminal through the RPC layer', async () => {
      const terminal = await run(
        client.terminal.spawn({
          command: 'echo "to-be-removed-rpc"',
          cwd: TEST_CWD,
          cols: 80,
          rows: 24,
          workspaceId: TEST_WORKSPACE_ID,
        })
      )

      await delay(2000)

      // Terminal should be stopped after echo exits
      const beforeRemove = await run(client.terminal.list())
      assert.strictEqual(
        beforeRemove.find((t: { readonly id: string }) => t.id === terminal.id)
          ?.status,
        'stopped'
      )

      // Remove it through RPC
      await run(client.terminal.remove({ id: terminal.id }))

      // Should no longer appear in list
      const afterRemove = await run(client.terminal.list())
      assert.isUndefined(
        afterRemove.find((t: { readonly id: string }) => t.id === terminal.id)
      )
    })

    it('terminal.remove fails for a nonexistent terminal', async () => {
      const result = await run(
        Effect.either(client.terminal.remove({ id: 'nonexistent-terminal-id' }))
      )

      assert.isTrue(Either.isLeft(result))
    })

    // -----------------------------------------------------------------------
    // terminal.restart
    // -----------------------------------------------------------------------

    it('terminal.restart respawns a stopped terminal through the RPC layer', async () => {
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

      // Kill it
      await run(client.terminal.kill({ id: terminal.id }))
      await delay(500)

      // Restart through RPC
      const restarted = await run(client.terminal.restart({ id: terminal.id }))

      assert.strictEqual(restarted.id, terminal.id)
      assert.strictEqual(restarted.command, 'cat')
      assert.strictEqual(restarted.cwd, TEST_CWD)
      assert.strictEqual(restarted.status, 'running')
      assert.strictEqual(restarted.workspaceId, TEST_WORKSPACE_ID)
      assert.strictEqual(typeof restarted.hasChildProcess, 'boolean')

      // Verify it's alive by writing
      await run(
        client.terminal.write({
          id: terminal.id,
          data: 'after-rpc-restart\n',
        })
      )

      // Clean up
      await run(client.terminal.kill({ id: terminal.id }))
    })

    it('terminal.restart fails for a nonexistent terminal', async () => {
      const result = await run(
        Effect.either(
          client.terminal.restart({ id: 'nonexistent-terminal-id' })
        )
      )

      assert.isTrue(Either.isLeft(result))
    })

    // -----------------------------------------------------------------------
    // terminal.list
    // -----------------------------------------------------------------------

    it('terminal.list returns both running and stopped terminals through the RPC layer', async () => {
      const uniqueWs = `rpc-list-test-ws-${crypto.randomUUID().slice(0, 8)}`

      // Spawn a long-running terminal
      const running = await run(
        client.terminal.spawn({
          command: 'cat',
          cwd: TEST_CWD,
          cols: 80,
          rows: 24,
          workspaceId: uniqueWs,
        })
      )

      // Spawn a short-lived terminal
      const shortLived = await run(
        client.terminal.spawn({
          command: 'echo "rpc-list-done"',
          cwd: TEST_CWD,
          cols: 80,
          rows: 24,
          workspaceId: uniqueWs,
        })
      )

      await delay(2000)

      const terminals = await run(client.terminal.list())

      const runningTerminal = terminals.find(
        (t: { readonly id: string }) => t.id === running.id
      )
      const stoppedTerminal = terminals.find(
        (t: { readonly id: string }) => t.id === shortLived.id
      )

      assert.isDefined(runningTerminal)
      assert.strictEqual(runningTerminal?.status, 'running')
      assert.strictEqual(typeof runningTerminal?.hasChildProcess, 'boolean')

      assert.isDefined(stoppedTerminal)
      assert.strictEqual(stoppedTerminal?.status, 'stopped')
      // Stopped terminals always report hasChildProcess as false
      assert.strictEqual(stoppedTerminal?.hasChildProcess, false)

      // Clean up
      await run(client.terminal.kill({ id: running.id }))
    })

    // -----------------------------------------------------------------------
    // terminal.events (streaming)
    // -----------------------------------------------------------------------

    it('terminal.events streams lifecycle events through the RPC layer', async () => {
      // The streaming RPC returns a Stream; collect events by running the
      // stream with a take(N) + timeout, then checking what we got.
      const collectedEvents: Array<{
        readonly _tag: string
        readonly id?: string
        readonly command?: string
        readonly status?: string
      }> = []

      // Get the event stream from the RPC client
      const eventStream = client.terminal.events()

      // Run a collector in the background that collects a limited number
      // of events with a timeout, using Effect.runFork to avoid scope issues
      const collectFiber = Effect.runFork(
        eventStream.pipe(
          Stream.take(10),
          Stream.runForEach((event) =>
            Effect.sync(() => {
              collectedEvents.push(event)
            })
          ),
          Effect.timeout('5 seconds'),
          Effect.catchAll(() => Effect.void)
        )
      )

      // Give the subscriber time to attach
      await delay(300)

      // Spawn a terminal — should produce a Spawned event
      const terminal = await run(
        client.terminal.spawn({
          command: 'echo "rpc-events-test"',
          cwd: TEST_CWD,
          cols: 80,
          rows: 24,
          workspaceId: `rpc-events-ws-${crypto.randomUUID().slice(0, 8)}`,
        })
      )

      // Wait for the echo to exit and events to propagate
      await delay(2000)

      // Interrupt the collector
      await Effect.runPromise(Fiber.interrupt(collectFiber))

      // We should have at least a Spawned event for our terminal
      const spawnedEvent = collectedEvents.find(
        (e) => e._tag === 'Spawned' && e.id === terminal.id
      )
      assert.isDefined(spawnedEvent)

      if (spawnedEvent !== undefined && spawnedEvent._tag === 'Spawned') {
        assert.strictEqual(spawnedEvent.command, 'echo "rpc-events-test"')
        assert.strictEqual(spawnedEvent.status, 'running')
      }
    })

    // -----------------------------------------------------------------------
    // foregroundProcess in terminal.list and terminal.spawn
    // -----------------------------------------------------------------------

    it('terminal.list includes foregroundProcess field through the RPC schema', async () => {
      // Spawn 'cat' which blocks on stdin — the shell execs into cat
      const terminal = await run(
        client.terminal.spawn({
          command: 'cat',
          cwd: TEST_CWD,
          cols: 80,
          rows: 24,
          workspaceId: TEST_WORKSPACE_ID,
        })
      )

      // Give the process time to start
      await delay(1000)

      const terminals = await run(client.terminal.list())
      const found = terminals.find((t) => t.id === terminal.id)

      assert.isDefined(found)
      // foregroundProcess should be present in the schema response
      assert.isDefined(found?.foregroundProcess)
      assert.strictEqual(found?.foregroundProcess?.rawName, 'cat')
      assert.strictEqual(found?.foregroundProcess?.category, 'unknown')
      assert.strictEqual(typeof found?.foregroundProcess?.label, 'string')

      await run(client.terminal.kill({ id: terminal.id }))
    })

    it('terminal.spawn returns foregroundProcess as null initially', async () => {
      const terminal = await run(
        client.terminal.spawn({
          command: 'cat',
          cwd: TEST_CWD,
          cols: 80,
          rows: 24,
          workspaceId: TEST_WORKSPACE_ID,
        })
      )

      // spawn() returns before process tree is fully established
      assert.strictEqual(terminal.foregroundProcess, null)

      await delay(500)
      await run(client.terminal.kill({ id: terminal.id }))
    })

    it('terminal.list returns null foregroundProcess for stopped terminals', async () => {
      const terminal = await run(
        client.terminal.spawn({
          command: 'echo "rpc-fg-stopped"',
          cwd: TEST_CWD,
          cols: 80,
          rows: 24,
          workspaceId: TEST_WORKSPACE_ID,
        })
      )

      // Wait for echo to finish
      await delay(2000)

      const terminals = await run(client.terminal.list())
      const found = terminals.find((t) => t.id === terminal.id)

      assert.isDefined(found)
      assert.strictEqual(found?.status, 'stopped')
      assert.strictEqual(found?.foregroundProcess, null)

      await run(client.terminal.remove({ id: terminal.id }))
    })

    // -----------------------------------------------------------------------
    // terminal.spawn with pre-generated id
    // -----------------------------------------------------------------------

    it('terminal.spawn with id field uses the provided ID', async () => {
      const customId = 'rpc-custom-id-test-12345'
      const terminal = await run(
        client.terminal.spawn({
          command: 'cat',
          cwd: TEST_CWD,
          cols: 80,
          rows: 24,
          workspaceId: TEST_WORKSPACE_ID,
          id: customId,
        })
      )

      assert.strictEqual(terminal.id, customId)

      await run(client.terminal.kill({ id: terminal.id }))
    })
  }
)
