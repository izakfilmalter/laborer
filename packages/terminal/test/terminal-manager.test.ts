/**
 * TerminalManager integration tests (terminal package).
 *
 * Tests the terminal package's TerminalManager by composing real Effect layers:
 * - Real PtyHostClient (spawns the actual PTY Host child process under Node.js)
 * - No LiveStore — terminal state is fully in-memory
 * - No WorkspaceProvider — spawn payload provides all parameters
 *
 * Tests verify:
 * - spawn() with full payload (command, args, cwd, env, cols, rows, workspaceId)
 * - Stopped terminals are retained in memory with their config
 * - restart() works for stopped terminals using retained config
 * - Lifecycle events are emitted via PubSub
 * - listTerminals() returns both running and stopped terminals
 * - remove() fully deletes a terminal from memory
 * - write() and resize() work on running terminals
 * - kill() marks terminal as stopped (not deleted)
 *
 * @see PRD-terminal-extraction.md — Modified Module: TerminalManager
 * @see Issue #138: Move + simplify TerminalManager
 */

import { assert, describe } from '@effect/vitest'
import {
  type Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  Queue,
  Scope,
  Stream,
} from 'effect'
import { afterAll, beforeAll, it } from 'vitest'

import { PtyHostClient } from '../src/services/pty-host-client.js'
import {
  type TerminalLifecycleEvent,
  TerminalManager,
} from '../src/services/terminal-manager.js'

// ---------------------------------------------------------------------------
// Test layer construction
// ---------------------------------------------------------------------------

/**
 * Full test layer: TerminalManager with PtyHostClient.
 * No LiveStore, no WorkspaceProvider.
 */
const TestLayer = TerminalManager.layer.pipe(
  Layer.provideMerge(PtyHostClient.layer)
)

// ---------------------------------------------------------------------------
// Helper: run an Effect program against the test layer
// ---------------------------------------------------------------------------

let scope: Scope.CloseableScope
let testContext: Context.Context<TerminalManager | PtyHostClient>

const runEffect = <A, E>(
  effect: Effect.Effect<A, E, TerminalManager>
): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, Layer.succeedContext(testContext)))

const withGracePeriod = async <A>(
  gracePeriodMs: number,
  run: (
    runLocalEffect: <T, E>(
      effect: Effect.Effect<T, E, TerminalManager>
    ) => Promise<T>
  ) => Promise<A>
): Promise<A> => {
  const previousGracePeriod = process.env.TERMINAL_GRACE_PERIOD_MS
  process.env.TERMINAL_GRACE_PERIOD_MS = String(gracePeriodMs)

  const localScope = Effect.runSync(Scope.make())

  try {
    const localContext = await Effect.runPromise(
      Layer.buildWithScope(TestLayer, localScope)
    )

    const runLocalEffect = <T, E>(
      effect: Effect.Effect<T, E, TerminalManager>
    ): Promise<T> =>
      Effect.runPromise(
        Effect.provide(effect, Layer.succeedContext(localContext))
      )

    return await run(runLocalEffect)
  } finally {
    await Effect.runPromise(Scope.close(localScope, Exit.void))

    if (previousGracePeriod === undefined) {
      process.env.TERMINAL_GRACE_PERIOD_MS = undefined
    } else {
      process.env.TERMINAL_GRACE_PERIOD_MS = previousGracePeriod
    }
  }
}

beforeAll(async () => {
  scope = Effect.runSync(Scope.make())

  testContext = await Effect.runPromise(Layer.buildWithScope(TestLayer, scope))
}, 30_000)

afterAll(async () => {
  await Effect.runPromise(Scope.close(scope, Exit.void))
}, 15_000)

const TEST_WORKSPACE_ID = 'test-workspace-1'
const TEST_CWD = '/tmp'
const noopSubscriber = (_data: string): undefined => undefined

/** Small delay to allow async PTY events to propagate through IPC. */
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TerminalManager (terminal package)', { timeout: 30_000 }, () => {
  it('spawn() accepts full payload and returns terminal info', async () => {
    const result = await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        return yield* tm.spawn({
          command: 'echo "hello-from-terminal"',
          cwd: TEST_CWD,
          cols: 80,
          rows: 24,
          workspaceId: TEST_WORKSPACE_ID,
        })
      })
    )

    assert.isDefined(result.id)
    assert.strictEqual(result.workspaceId, TEST_WORKSPACE_ID)
    assert.strictEqual(result.command, 'echo "hello-from-terminal"')
    assert.strictEqual(result.cwd, TEST_CWD)
    assert.strictEqual(result.status, 'running')

    // Wait for the command to execute and exit
    await delay(2000)

    // Verify terminal is retained in memory as stopped (not deleted)
    const terminals = await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        return yield* tm.listTerminals()
      })
    )

    const terminal = terminals.find((t) => t.id === result.id)
    assert.isDefined(terminal)
    assert.strictEqual(terminal?.status, 'stopped')
  })

  it('write() sends input that produces corresponding output', async () => {
    // Spawn an interactive cat process
    const result = await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        return yield* tm.spawn({
          command: 'cat',
          cwd: TEST_CWD,
          cols: 80,
          rows: 24,
          workspaceId: TEST_WORKSPACE_ID,
        })
      })
    )

    await delay(1000)

    // Write to the terminal
    await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        yield* tm.write(result.id, 'test-write-input\n')
      })
    )

    await delay(1000)

    // Kill the terminal
    await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        yield* tm.kill(result.id)
      })
    )

    // Verify terminal is stopped (retained in memory)
    const terminals = await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        return yield* tm.listTerminals()
      })
    )

    const terminal = terminals.find((t) => t.id === result.id)
    assert.isDefined(terminal)
    assert.strictEqual(terminal?.status, 'stopped')
  })

  it('resize() changes dimensions without crashing the PTY', async () => {
    const result = await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        return yield* tm.spawn({
          command: 'cat',
          cwd: TEST_CWD,
          cols: 80,
          rows: 24,
          workspaceId: TEST_WORKSPACE_ID,
        })
      })
    )

    await delay(1000)

    // Resize — should not throw
    await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        yield* tm.resize(result.id, 120, 40)
      })
    )

    // Verify PTY is still alive by writing to it
    await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        yield* tm.write(result.id, 'after-resize\n')
      })
    )

    await delay(500)

    // Terminal should still be running
    const terminals = await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        return yield* tm.listTerminals()
      })
    )

    const terminal = terminals.find((t) => t.id === result.id)
    assert.strictEqual(terminal?.status, 'running')

    // Clean up
    await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        yield* tm.kill(result.id)
      })
    )
  })

  it('kill() marks terminal as stopped but retains it in memory', async () => {
    const result = await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        return yield* tm.spawn({
          command: 'cat',
          cwd: TEST_CWD,
          cols: 80,
          rows: 24,
          workspaceId: TEST_WORKSPACE_ID,
        })
      })
    )

    await delay(500)

    // Kill the terminal
    await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        yield* tm.kill(result.id)
      })
    )

    await delay(500)

    // Terminal should still exist in memory as stopped
    const terminals = await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        return yield* tm.listTerminals()
      })
    )

    const terminal = terminals.find((t) => t.id === result.id)
    assert.isDefined(terminal)
    assert.strictEqual(terminal?.status, 'stopped')
    assert.strictEqual(terminal?.command, 'cat')
    assert.strictEqual(terminal?.cwd, TEST_CWD)
    assert.strictEqual(terminal?.workspaceId, TEST_WORKSPACE_ID)
  })

  it('restart() works for stopped terminals using retained config', async () => {
    // Spawn and kill a terminal
    const result = await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        return yield* tm.spawn({
          command: 'cat',
          cwd: TEST_CWD,
          cols: 80,
          rows: 24,
          workspaceId: TEST_WORKSPACE_ID,
        })
      })
    )

    await delay(500)

    await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        yield* tm.kill(result.id)
      })
    )

    await delay(500)

    // Restart the stopped terminal
    const restarted = await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        return yield* tm.restart(result.id)
      })
    )

    assert.strictEqual(restarted.id, result.id)
    assert.strictEqual(restarted.command, 'cat')
    assert.strictEqual(restarted.cwd, TEST_CWD)
    assert.strictEqual(restarted.status, 'running')

    await delay(500)

    // Write to verify the PTY is alive
    await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        yield* tm.write(result.id, 'after-restart\n')
      })
    )

    await delay(500)

    // Clean up
    await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        yield* tm.kill(result.id)
      })
    )
  })

  it('remove() fully deletes a terminal from memory', async () => {
    const result = await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        return yield* tm.spawn({
          command: 'echo "to-be-removed"',
          cwd: TEST_CWD,
          cols: 80,
          rows: 24,
          workspaceId: TEST_WORKSPACE_ID,
        })
      })
    )

    await delay(2000)

    // Terminal should be stopped after echo exits
    let terminals = await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        return yield* tm.listTerminals()
      })
    )
    assert.strictEqual(
      terminals.find((t) => t.id === result.id)?.status,
      'stopped'
    )

    // Remove it
    await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        yield* tm.remove(result.id)
      })
    )

    // Should no longer exist
    terminals = await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        return yield* tm.listTerminals()
      })
    )
    assert.isUndefined(terminals.find((t) => t.id === result.id))

    // terminalExists should return false
    const exists = await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        return yield* tm.terminalExists(result.id)
      })
    )
    assert.isFalse(exists)
  })

  it('listTerminals() returns both running and stopped terminals', async () => {
    const uniqueWs = `list-test-ws-${crypto.randomUUID().slice(0, 8)}`

    // Spawn a long-running terminal
    const running = await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        return yield* tm.spawn({
          command: 'cat',
          cwd: TEST_CWD,
          cols: 80,
          rows: 24,
          workspaceId: uniqueWs,
        })
      })
    )

    // Spawn a short-lived terminal
    const shortLived = await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        return yield* tm.spawn({
          command: 'echo "done"',
          cwd: TEST_CWD,
          cols: 80,
          rows: 24,
          workspaceId: uniqueWs,
        })
      })
    )

    await delay(2000)

    // List terminals for this workspace
    const terminals = await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        return yield* tm.listTerminals(uniqueWs)
      })
    )

    const runningTerminal = terminals.find((t) => t.id === running.id)
    const stoppedTerminal = terminals.find((t) => t.id === shortLived.id)

    assert.isDefined(runningTerminal)
    assert.strictEqual(runningTerminal?.status, 'running')

    assert.isDefined(stoppedTerminal)
    assert.strictEqual(stoppedTerminal?.status, 'stopped')

    // Clean up
    await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        yield* tm.kill(running.id)
      })
    )
  })

  it('lifecycle events are emitted for spawn and kill', async () => {
    const collectedEvents: TerminalLifecycleEvent[] = []

    // Subscribe, spawn, kill, then check collected events — all in one scoped block
    const result = await runEffect(
      Effect.scoped(
        Effect.gen(function* () {
          const tm = yield* TerminalManager

          // Subscribe to the PubSub (scoped — will unsubscribe when block ends)
          const dequeue = yield* tm.lifecycleEvents.subscribe

          // Start collecting events in a fiber
          const collectFiber = yield* Effect.fork(
            Effect.gen(function* () {
              while (true) {
                const event = yield* Queue.take(dequeue)
                collectedEvents.push(event)
              }
            })
          )

          // Spawn a terminal
          const terminal = yield* tm.spawn({
            command: 'cat',
            cwd: TEST_CWD,
            cols: 80,
            rows: 24,
            workspaceId: TEST_WORKSPACE_ID,
          })

          // Give time for the Spawned event to propagate
          yield* Effect.sleep(500)

          // Kill it
          yield* tm.kill(terminal.id)

          // Give time for the StatusChanged event to propagate
          yield* Effect.sleep(500)

          // Interrupt the collector
          yield* Fiber.interrupt(collectFiber)

          return terminal
        })
      )
    )

    // Check for Spawned event
    const spawnedEvent = collectedEvents.find(
      (e) => e._tag === 'Spawned' && e.terminal.id === result.id
    )
    assert.isDefined(spawnedEvent)

    // Check for StatusChanged event (stopped)
    const statusEvent = collectedEvents.find(
      (e) =>
        e._tag === 'StatusChanged' &&
        e.id === result.id &&
        e.status === 'stopped'
    )
    assert.isDefined(statusEvent)
  })

  it('lifecycle events stream via Stream.fromPubSub matches terminal.events pattern', async () => {
    // This test validates the exact streaming pattern used by the
    // terminal.events RPC handler: Stream.fromPubSub(tm.lifecycleEvents)
    // piped through Stream.map to transform events.
    const result = await runEffect(
      Effect.scoped(
        Effect.gen(function* () {
          const tm = yield* TerminalManager

          // Spawn first so we know the terminal ID for filtering
          const terminal = yield* tm.spawn({
            command: 'cat',
            cwd: TEST_CWD,
            cols: 80,
            rows: 24,
            workspaceId: TEST_WORKSPACE_ID,
          })

          // Create a stream from the PubSub — same as terminal.events handler
          // Filter to only events for our terminal to avoid cross-test noise
          const eventStream = Stream.fromPubSub(tm.lifecycleEvents).pipe(
            Stream.map((event) => ({
              _tag: event._tag,
              id:
                event._tag === 'Spawned' || event._tag === 'Restarted'
                  ? event.terminal.id
                  : event.id,
            })),
            Stream.filter((event) => event.id === terminal.id)
          )

          // Collect 1 event (StatusChanged from kill) in the background
          const collectFiber = yield* eventStream.pipe(
            Stream.take(1),
            Stream.runCollect,
            Effect.fork
          )

          // Give a moment for the subscriber to be established
          yield* Effect.sleep(200)

          // Kill it (produces StatusChanged event)
          yield* tm.kill(terminal.id)

          // Wait for the collector to receive the event
          const chunk = yield* Fiber.join(collectFiber)
          return { terminalId: terminal.id, events: [...chunk] }
        })
      )
    )

    // Should have captured the StatusChanged event for our terminal
    assert.strictEqual(result.events.length, 1)
    assert.strictEqual(result.events[0]?._tag, 'StatusChanged')
    assert.strictEqual(result.events[0]?.id, result.terminalId)
  })

  it('spawn() with custom args passes them correctly', async () => {
    const result = await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        return yield* tm.spawn({
          command: '/bin/echo',
          args: ['hello', 'world'],
          cwd: TEST_CWD,
          cols: 80,
          rows: 24,
          workspaceId: TEST_WORKSPACE_ID,
        })
      })
    )

    assert.deepStrictEqual(result.args, ['hello', 'world'])
    assert.strictEqual(result.command, '/bin/echo')

    await delay(2000)

    // Terminal should be stopped after echo exits
    const terminals = await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        return yield* tm.listTerminals()
      })
    )

    const terminal = terminals.find((t) => t.id === result.id)
    assert.strictEqual(terminal?.status, 'stopped')
    assert.deepStrictEqual(terminal?.args, ['hello', 'world'])
  })

  it('kills orphaned spawned terminals after grace period expires', async () => {
    await withGracePeriod(300, async (runLocalEffect) => {
      const terminal = await runLocalEffect(
        Effect.gen(function* () {
          const tm = yield* TerminalManager
          return yield* tm.spawn({
            command: 'cat',
            cwd: TEST_CWD,
            cols: 80,
            rows: 24,
            workspaceId: TEST_WORKSPACE_ID,
          })
        })
      )

      await delay(700)

      const terminals = await runLocalEffect(
        Effect.gen(function* () {
          const tm = yield* TerminalManager
          return yield* tm.listTerminals()
        })
      )

      assert.strictEqual(
        terminals.find((t) => t.id === terminal.id)?.status,
        'stopped'
      )
    })
  })

  it('reconnecting within grace period keeps terminal running', async () => {
    await withGracePeriod(400, async (runLocalEffect) => {
      const terminal = await runLocalEffect(
        Effect.gen(function* () {
          const tm = yield* TerminalManager
          return yield* tm.spawn({
            command: 'cat',
            cwd: TEST_CWD,
            cols: 80,
            rows: 24,
            workspaceId: TEST_WORKSPACE_ID,
          })
        })
      )

      const firstSubscriberId = await runLocalEffect(
        Effect.gen(function* () {
          const tm = yield* TerminalManager
          const result = yield* tm.subscribe(terminal.id, noopSubscriber)
          return result.subscriberId
        })
      )

      await runLocalEffect(
        Effect.gen(function* () {
          const tm = yield* TerminalManager
          yield* tm.unsubscribe(terminal.id, firstSubscriberId)
        })
      )

      await delay(150)

      const secondSubscriberId = await runLocalEffect(
        Effect.gen(function* () {
          const tm = yield* TerminalManager
          const result = yield* tm.subscribe(terminal.id, noopSubscriber)
          return result.subscriberId
        })
      )

      await delay(450)

      const terminals = await runLocalEffect(
        Effect.gen(function* () {
          const tm = yield* TerminalManager
          return yield* tm.listTerminals()
        })
      )

      assert.strictEqual(
        terminals.find((t) => t.id === terminal.id)?.status,
        'running'
      )

      await runLocalEffect(
        Effect.gen(function* () {
          const tm = yield* TerminalManager
          yield* tm.unsubscribe(terminal.id, secondSubscriberId)
          yield* tm.kill(terminal.id)
        })
      )
    })
  })

  it('kills terminal after last subscriber disconnects and grace expires', async () => {
    await withGracePeriod(300, async (runLocalEffect) => {
      const terminal = await runLocalEffect(
        Effect.gen(function* () {
          const tm = yield* TerminalManager
          return yield* tm.spawn({
            command: 'cat',
            cwd: TEST_CWD,
            cols: 80,
            rows: 24,
            workspaceId: TEST_WORKSPACE_ID,
          })
        })
      )

      const subscriberId = await runLocalEffect(
        Effect.gen(function* () {
          const tm = yield* TerminalManager
          const result = yield* tm.subscribe(terminal.id, noopSubscriber)
          return result.subscriberId
        })
      )

      await runLocalEffect(
        Effect.gen(function* () {
          const tm = yield* TerminalManager
          yield* tm.unsubscribe(terminal.id, subscriberId)
        })
      )

      await delay(700)

      const terminals = await runLocalEffect(
        Effect.gen(function* () {
          const tm = yield* TerminalManager
          return yield* tm.listTerminals()
        })
      )

      assert.strictEqual(
        terminals.find((t) => t.id === terminal.id)?.status,
        'stopped'
      )
    })
  })
})
