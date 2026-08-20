/**
 * TerminalManager integration tests (terminal package).
 *
 * Tests the terminal package's TerminalManager by composing real Effect layers:
 * - Real PtyHostClient (spawns the actual PTY Host child process under Node.js)
 * - Terminal state is fully in-memory
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
  PubSub,
  Result,
  Scope,
  Stream,
} from 'effect'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'

import { directLayer } from '../src/services/pty-direct.js'
import type { PtyHostClient } from '../src/services/pty-host-client.js'
import {
  type TerminalLifecycleEvent,
  TerminalManager,
} from '../src/services/terminal-manager.js'

// ---------------------------------------------------------------------------
// Test layer construction
// ---------------------------------------------------------------------------

/**
 * Full test layer: TerminalManager with direct PtyHostClient (node-pty).
 * No workspace persistence or WorkspaceProvider.
 */
const TestLayer = TerminalManager.layer.pipe(Layer.provideMerge(directLayer))

// ---------------------------------------------------------------------------
// Helper: run an Effect program against the test layer
// ---------------------------------------------------------------------------

let scope: Scope.Closeable
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
const noopSubscriber = (): boolean => true

/** Small delay to allow async PTY events to propagate through IPC. */
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TerminalManager (terminal package)', { timeout: 30_000 }, () => {
  it('holds flow-control commits at the slowest attached lease', async () => {
    const result = await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        const terminal = yield* tm.spawn({
          command: 'cat',
          cwd: TEST_CWD,
          cols: 80,
          rows: 24,
          workspaceId: TEST_WORKSPACE_ID,
        })
        let firstCursor = 0
        let secondCursor = 0
        yield* tm.attach(terminal.id, { leaseId: 'first-lease' }, (event) => {
          if (event._tag === 'Delta') {
            firstCursor = event.cursor
          }
          return true
        })
        yield* tm.attach(terminal.id, { leaseId: 'second-lease' }, (event) => {
          if (event._tag === 'Delta') {
            secondCursor = event.cursor
          }
          return true
        })
        yield* tm.write(terminal.id, 'lease-test\n')
        for (
          let attempt = 0;
          attempt < 200 && (firstCursor === 0 || secondCursor === 0);
          attempt += 1
        ) {
          yield* Effect.sleep('10 millis')
        }
        if (firstCursor === 0 || secondCursor === 0) {
          throw new Error('Timed out waiting for terminal lease output')
        }

        yield* tm.acknowledge(terminal.id, 'first-lease', firstCursor)
        const held = yield* tm.transportMetrics(terminal.id)
        yield* tm.acknowledge(terminal.id, 'second-lease', secondCursor)
        const committed = yield* tm.transportMetrics(terminal.id)
        yield* tm.kill(terminal.id)
        return { committed, held }
      })
    )

    expect(result.held.backlogBytes).toBeGreaterThan(0)
    expect(result.committed.backlogBytes).toBe(0)
  })

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

  it('uses the runtime shell integration nonce to trust matching command lines', async () => {
    const result = await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        return yield* tm.spawn({
          command:
            'printf \'\\033]633;P;Cwd=/tmp\\007\\033]633;B\\007\\033]633;E;git\\x20status;%s\\007\\033]633;C\\007\\033]633;D;0\\007\' "$VSCODE_NONCE"',
          cwd: TEST_CWD,
          cols: 80,
          rows: 24,
          workspaceId: TEST_WORKSPACE_ID,
        })
      })
    )

    await delay(1000)

    const commandState = await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        return tm.getCommandDetectionState(result.id)
      })
    )

    assert.isDefined(commandState)
    assert.strictEqual(commandState?.isWindowsPty, false)
    assert.strictEqual(commandState?.hasRichCommandDetection, false)
    assert.deepStrictEqual(commandState?.promptInputModel, {
      value: 'git status',
      cursorIndex: 10,
    })
    assert.strictEqual(commandState?.commands.length, 1)
    assert.strictEqual(commandState?.commands[0]?.command, 'git status')
    assert.strictEqual(commandState?.commands[0]?.commandLineConfidence, 'high')
    assert.strictEqual(commandState?.commands[0]?.cwd, '/tmp')
    assert.strictEqual(commandState?.commands[0]?.exitCode, 0)
    assert.strictEqual(commandState?.commands[0]?.isTrusted, true)
    assert.isNumber(commandState?.commands[0]?.timestamp)
    assert.isNumber(commandState?.commands[0]?.duration)
  })

  it('preserves trusted command detection after restart()', async () => {
    const result = await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        return yield* tm.spawn({
          command:
            'printf \'\\033]633;P;Cwd=/tmp\\007\\033]633;B\\007\\033]633;E;git\\x20status;%s\\007\\033]633;C\\007\\033]633;D;0\\007\' "$VSCODE_NONCE"',
          cwd: TEST_CWD,
          cols: 80,
          rows: 24,
          workspaceId: TEST_WORKSPACE_ID,
        })
      })
    )

    await delay(1000)

    const restarted = await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        return yield* tm.restart(result.id)
      })
    )

    assert.strictEqual(restarted.id, result.id)

    await delay(1000)

    const commandState = await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        return tm.getCommandDetectionState(result.id)
      })
    )

    assert.isDefined(commandState)
    assert.strictEqual(commandState?.commands.length, 1)
    assert.strictEqual(commandState?.commands[0]?.command, 'git status')
    assert.strictEqual(commandState?.commands[0]?.commandLineConfidence, 'high')
    assert.strictEqual(commandState?.commands[0]?.cwd, '/tmp')
    assert.strictEqual(commandState?.commands[0]?.exitCode, 0)
    assert.strictEqual(commandState?.commands[0]?.isTrusted, true)
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
          const dequeue = yield* PubSub.subscribe(tm.lifecycleEvents)

          // Start collecting events in a fiber
          const collectFiber = yield* Effect.forkChild(
            Effect.gen(function* () {
              while (true) {
                const event = yield* PubSub.take(dequeue)
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

          // Create a stream from the PubSub — same as terminal.events handler.
          // Filter to our terminal and exclude ProcessChanged events from the
          // background detection fiber so we capture the expected lifecycle event.
          const eventStream = Stream.fromPubSub(tm.lifecycleEvents).pipe(
            Stream.filter((event) => event._tag !== 'ProcessChanged'),
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
            Effect.forkChild
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

  it('kills never-claimed spawned terminals after the orphan grace period expires', async () => {
    // NOTE: the orphan countdown is process-time based with 1s resolution,
    // so a 300ms grace rounds up to one 1s tick.
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

      await delay(1600)

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

  it('does not reap restored terminals even when never re-claimed (ADR 0003)', async () => {
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
            restored: true,
          })
        })
      )

      // Far past the grace window — a restored terminal must stay alive
      // while it waits to be re-adopted by the renderer.
      await delay(1600)

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
          yield* tm.kill(terminal.id)
        })
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
          const result = yield* tm.attach(
            terminal.id,
            { leaseId: 'first-reconnect' },
            noopSubscriber
          )
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
          const result = yield* tm.attach(
            terminal.id,
            { leaseId: 'second-reconnect' },
            noopSubscriber
          )
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

  it('keeps a claimed terminal running after the last subscriber disconnects (detached terminals are never reaped)', async () => {
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
          const result = yield* tm.attach(
            terminal.id,
            { leaseId: 'claimed-terminal' },
            noopSubscriber
          )
          return result.subscriberId
        })
      )

      await runLocalEffect(
        Effect.gen(function* () {
          const tm = yield* TerminalManager
          yield* tm.unsubscribe(terminal.id, subscriberId)
        })
      )

      // Far past the grace window. The terminal was claimed once, so it
      // is detached — not orphaned — and must keep running (ADR 0003).
      await delay(1600)

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
          yield* tm.kill(terminal.id)
        })
      )
    })
  })

  it('listTerminals() reports hasChildProcess true when a child process is running', async () => {
    // Spawn an interactive shell that then has a child process.
    // Using `/bin/sh -c 'sleep 999 & wait'` keeps the shell alive with
    // `sleep` as a backgrounded child. The `& wait` prevents sh from
    // exec-replacing itself with sleep (which would make sleep the PID
    // itself instead of a child).
    const result = await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        return yield* tm.spawn({
          command: '/bin/sh',
          args: ['-c', 'sleep 999 & wait'],
          cwd: TEST_CWD,
          cols: 80,
          rows: 24,
          workspaceId: TEST_WORKSPACE_ID,
        })
      })
    )

    // Give time for the PTY to start and the spawned event to set shellPid
    await delay(1500)

    const terminals = await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        return yield* tm.listTerminals()
      })
    )

    const terminal = terminals.find((t) => t.id === result.id)
    assert.isDefined(terminal)
    assert.strictEqual(terminal?.status, 'running')
    assert.strictEqual(terminal?.hasChildProcess, true)

    // Clean up
    await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        yield* tm.kill(result.id)
      })
    )
  })

  it('listTerminals() reports hasChildProcess false for an idle shell', async () => {
    // Spawn an interactive shell — no child process, just sitting at a prompt.
    // `cat` is a good stand-in: it reads stdin but doesn't fork children.
    // However, `cat` IS the shell process itself, so shellPid points at it.
    // A better test: spawn `/bin/sh` interactively (no `-c`). The shell
    // process itself won't have any children until the user runs something.
    const result = await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        return yield* tm.spawn({
          command: '/bin/sh',
          args: ['-i'],
          cwd: TEST_CWD,
          cols: 80,
          rows: 24,
          workspaceId: TEST_WORKSPACE_ID,
        })
      })
    )

    // Give time for the PTY to start and the spawned event to set shellPid
    await delay(1500)

    const terminals = await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        return yield* tm.listTerminals()
      })
    )

    const terminal = terminals.find((t) => t.id === result.id)
    assert.isDefined(terminal)
    assert.strictEqual(terminal?.status, 'running')
    assert.strictEqual(terminal?.hasChildProcess, false)

    // Clean up
    await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        yield* tm.kill(result.id)
      })
    )
  })

  it('listTerminals() reports hasChildProcess true when the shell exec-replaces into a running command', async () => {
    // `defaultShell -c "sleep 999"` commonly exec-replaces the shell with
    // `sleep`, so the original shell PID becomes the running process itself
    // with no child process under it. We still need to treat that terminal as
    // active so close confirmation appears reliably.
    const result = await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        return yield* tm.spawn({
          command: 'sleep 999',
          cwd: TEST_CWD,
          cols: 80,
          rows: 24,
          workspaceId: TEST_WORKSPACE_ID,
        })
      })
    )

    await delay(1000)

    const terminals = await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        return yield* tm.listTerminals()
      })
    )

    const terminal = terminals.find((t) => t.id === result.id)
    assert.isDefined(terminal)
    assert.strictEqual(terminal?.status, 'running')
    assert.strictEqual(terminal?.hasChildProcess, true)
    assert.isDefined(terminal?.foregroundProcess)

    await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        yield* tm.kill(result.id)
      })
    )
  })

  // -------------------------------------------------------------------------
  // Foreground process detection
  // -------------------------------------------------------------------------

  it('listTerminals() detects foregroundProcess for a running child process', async () => {
    // Spawn 'cat' which blocks on stdin — it becomes the foreground process.
    // The shell runs 'cat' via `sh -c cat`, so the process tree is:
    // sh -> cat
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

    // Give cat time to start and shell PID to be set
    await delay(1000)

    const terminals = await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        return yield* tm.listTerminals()
      })
    )

    const terminal = terminals.find((t) => t.id === result.id)
    assert.isDefined(terminal)
    assert.isDefined(terminal?.foregroundProcess)
    // cat is not in our known processes list, so it should be 'unknown'
    assert.strictEqual(terminal?.foregroundProcess?.category, 'unknown')
    assert.strictEqual(terminal?.foregroundProcess?.rawName, 'cat')

    await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        yield* tm.kill(result.id)
      })
    )
  })

  it('listTerminals() returns null foregroundProcess for stopped terminals', async () => {
    const result = await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        return yield* tm.spawn({
          command: 'echo "done"',
          cwd: TEST_CWD,
          cols: 80,
          rows: 24,
          workspaceId: TEST_WORKSPACE_ID,
        })
      })
    )

    // Wait for the echo to finish and terminal to stop
    await delay(2000)

    const terminals = await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        return yield* tm.listTerminals()
      })
    )

    const terminal = terminals.find((t) => t.id === result.id)
    assert.isDefined(terminal)
    assert.strictEqual(terminal?.status, 'stopped')
    assert.strictEqual(terminal?.foregroundProcess, null)

    await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        yield* tm.remove(result.id)
      })
    )
  })

  it('spawn() returns foregroundProcess as null initially', async () => {
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

    // spawn() returns immediately before the process tree is established
    assert.strictEqual(result.foregroundProcess, null)

    await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        yield* tm.kill(result.id)
      })
    )
  })

  // -------------------------------------------------------------------------
  // Agent status tracking
  // -------------------------------------------------------------------------

  it('spawn() returns agentStatus as null initially', async () => {
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

    assert.strictEqual(result.agentStatus, null)

    await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        yield* tm.kill(result.id)
      })
    )
  })

  it('listTerminals() returns null agentStatus for non-agent processes', async () => {
    // Spawn 'cat' — not an agent
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

    const terminals = await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        return yield* tm.listTerminals()
      })
    )

    const terminal = terminals.find((t) => t.id === result.id)
    assert.isDefined(terminal)
    assert.strictEqual(terminal?.agentStatus, null)

    await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        yield* tm.kill(result.id)
      })
    )
  })

  it('listTerminals() returns null agentStatus for stopped terminals', async () => {
    const result = await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        return yield* tm.spawn({
          command: 'echo "done"',
          cwd: TEST_CWD,
          cols: 80,
          rows: 24,
          workspaceId: TEST_WORKSPACE_ID,
        })
      })
    )

    await delay(2000)

    const terminals = await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        return yield* tm.listTerminals()
      })
    )

    const terminal = terminals.find((t) => t.id === result.id)
    assert.isDefined(terminal)
    assert.strictEqual(terminal?.status, 'stopped')
    assert.strictEqual(terminal?.agentStatus, null)
    assert.strictEqual(terminal?.hasChildProcess, false)

    await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        yield* tm.remove(result.id)
      })
    )
  })

  it('keeps an unseen completion for a naturally exited one-shot agent', async () => {
    const result = await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        const terminal = yield* tm.spawn({
          command: 'sleep',
          args: ['0.05'],
          cwd: TEST_CWD,
          cols: 80,
          rows: 24,
          workspaceId: TEST_WORKSPACE_ID,
        })
        yield* tm.setAgentStatusFromHook(terminal.id, {
          status: 'working',
          sequence: 1,
        })
        return terminal
      })
    )

    await delay(500)

    const terminal = await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        const terminals = yield* tm.listTerminals()
        return terminals.find(({ id }) => id === result.id)
      })
    )

    assert.isDefined(terminal)
    assert.strictEqual(terminal?.status, 'stopped')
    assert.deepInclude(terminal?.agentStatus, {
      status: 'idle',
      seen: false,
    })

    await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        yield* tm.remove(result.id)
      })
    )
  })

  it('does not project an explicit terminal kill as agent completion', async () => {
    const result = await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        const terminal = yield* tm.spawn({
          command: 'cat',
          cwd: TEST_CWD,
          cols: 80,
          rows: 24,
          workspaceId: TEST_WORKSPACE_ID,
        })
        yield* tm.setAgentStatusFromHook(terminal.id, {
          status: 'working',
          sequence: 1,
        })
        yield* tm.kill(terminal.id)
        return terminal
      })
    )

    await delay(100)

    const terminal = await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        const terminals = yield* tm.listTerminals()
        return terminals.find(({ id }) => id === result.id)
      })
    )

    assert.isDefined(terminal)
    assert.strictEqual(terminal?.status, 'stopped')
    assert.strictEqual(terminal?.agentStatus, null)

    await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        yield* tm.remove(result.id)
      })
    )
  })

  // -------------------------------------------------------------------------
  // Hook-based agent status overrides
  // -------------------------------------------------------------------------

  it('setAgentStatusFromHook("active") makes listTerminals return agentStatus "active"', async () => {
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

    await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        yield* tm.setAgentStatusFromHook(result.id, {
          status: 'working',
          sequence: 1,
        })
      })
    )

    const terminals = await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        return yield* tm.listTerminals()
      })
    )

    const terminal = terminals.find((t) => t.id === result.id)
    assert.isDefined(terminal)
    assert.strictEqual(terminal?.agentStatus?.status, 'working')

    await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        yield* tm.kill(result.id)
      })
    )
  })

  it('setAgentStatusFromHook("needs_input") makes listTerminals return agentStatus "needs_input"', async () => {
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

    await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        yield* tm.setAgentStatusFromHook(result.id, {
          status: 'needs_input',
          sequence: 1,
        })
      })
    )

    const terminals = await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        return yield* tm.listTerminals()
      })
    )

    const terminal = terminals.find((t) => t.id === result.id)
    assert.isDefined(terminal)
    assert.strictEqual(terminal?.agentStatus?.status, 'needs_input')

    await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        yield* tm.kill(result.id)
      })
    )
  })

  it('setAgentStatusFromHook rejects an out-of-order report', async () => {
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

    // Set a hook override, then clear it
    await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        yield* tm.setAgentStatusFromHook(result.id, {
          status: 'working',
          sequence: 1,
        })
        yield* tm.setAgentStatusFromHook(result.id, {
          status: 'idle',
          sequence: 0,
        })
      })
    )

    const terminals = await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        return yield* tm.listTerminals()
      })
    )

    // After clearing, ps-based detection takes over. The agentStatusMap
    // was synced to 'active' by the hook, but the foreground process is
    // `cat` (category 'unknown' — not a shell and not an agent). The
    // ps-based state machine sees "previous=active, non-shell foreground
    // process running" and treats it as "a non-agent command took over",
    // clearing agent status to null.
    const terminal = terminals.find((t) => t.id === result.id)
    assert.isDefined(terminal)
    assert.strictEqual(terminal?.agentStatus?.status, 'working')

    await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        yield* tm.kill(result.id)
      })
    )
  })

  it('rejects hook evidence after ps confirms there is no agent', async () => {
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

    // Without a hook, 'cat' has null agentStatus (not an agent)
    const beforeHook = await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        return yield* tm.listTerminals()
      })
    )
    const beforeTerminal = beforeHook.find((t) => t.id === result.id)
    assert.isDefined(beforeTerminal)
    assert.strictEqual(beforeTerminal?.agentStatus, null)

    // A hook callback arriving after successful no-agent detection belongs to
    // an exited generation and must not revive status.
    await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        yield* tm.setAgentStatusFromHook(result.id, {
          status: 'needs_input',
          sequence: 1,
        })
      })
    )

    const afterHook = await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        return yield* tm.listTerminals()
      })
    )
    const afterTerminal = afterHook.find((t) => t.id === result.id)
    assert.isDefined(afterTerminal)
    assert.strictEqual(afterTerminal?.agentStatus, null)

    await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        yield* tm.kill(result.id)
      })
    )
  })

  it('setAgentStatusFromHook on non-existent terminal returns error', async () => {
    const result = await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        return yield* Effect.result(
          tm.setAgentStatusFromHook('non-existent-terminal-id', {
            status: 'working',
            sequence: 1,
          })
        )
      })
    )

    assert.isTrue(Result.isFailure(result))
  })

  it('remove() clears hook status override', async () => {
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

    // Set a hook override, then remove the terminal
    await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        yield* tm.setAgentStatusFromHook(result.id, {
          status: 'working',
          sequence: 1,
        })
        yield* tm.remove(result.id)
      })
    )

    // Respawn with the same workspace — the old hook status should not leak
    const respawned = await runEffect(
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

    const terminals = await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        return yield* tm.listTerminals()
      })
    )

    const terminal = terminals.find((t) => t.id === respawned.id)
    assert.isDefined(terminal)
    assert.strictEqual(terminal?.agentStatus, null)

    await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        yield* tm.kill(respawned.id)
      })
    )
  })

  it('restart() clears hook status override', async () => {
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

    // Set a hook override, then restart the terminal
    await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        yield* tm.setAgentStatusFromHook(result.id, {
          status: 'working',
          sequence: 1,
        })
      })
    )

    const restarted = await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        return yield* tm.restart(result.id)
      })
    )

    const terminals = await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        return yield* tm.listTerminals()
      })
    )

    const terminal = terminals.find((t) => t.id === restarted.id)
    assert.isDefined(terminal)
    assert.strictEqual(terminal?.agentStatus, null)

    await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        yield* tm.kill(restarted.id)
      })
    )
  })

  it('restart() does not log PTY reuse warnings while replacing the previous process', async () => {
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)

    try {
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
          yield* tm.restart(result.id)
        })
      )

      await delay(500)

      expect(
        consoleErrorSpy.mock.calls.some(([message]) =>
          String(message).includes('already exists')
        )
      ).toBe(false)

      await runEffect(
        Effect.gen(function* () {
          const tm = yield* TerminalManager
          yield* tm.kill(result.id)
        })
      )
    } finally {
      consoleErrorSpy.mockRestore()
    }
  })

  it('spawn() with pre-generated id uses that ID', async () => {
    const customId = 'custom-test-terminal-id-12345'
    const result = await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        return yield* tm.spawn({
          command: 'cat',
          cwd: TEST_CWD,
          cols: 80,
          rows: 24,
          workspaceId: TEST_WORKSPACE_ID,
          id: customId,
        })
      })
    )

    assert.strictEqual(result.id, customId)

    await runEffect(
      Effect.gen(function* () {
        const tm = yield* TerminalManager
        yield* tm.kill(result.id)
      })
    )
  })

  // -------------------------------------------------------------------------
  // Background detection fiber — ProcessChanged events
  // -------------------------------------------------------------------------

  it('background detection fiber emits ProcessChanged when process state changes', async () => {
    // Spawn a shell, then run a child process. The background detection
    // fiber (200ms interval) should notice the process tree changed and
    // emit a ProcessChanged event with the updated TerminalRecord.
    //
    // We use withGracePeriod to get a fresh TerminalManager so we can
    // control the lifecycle cleanly.
    await withGracePeriod(60_000, async (runLocalEffect) => {
      const collectedEvents: TerminalLifecycleEvent[] = []

      const terminalId = await runLocalEffect(
        Effect.scoped(
          Effect.gen(function* () {
            const tm = yield* TerminalManager

            // Subscribe to lifecycle events
            const dequeue = yield* PubSub.subscribe(tm.lifecycleEvents)

            const collectFiber = yield* Effect.forkChild(
              Effect.gen(function* () {
                while (true) {
                  const event = yield* PubSub.take(dequeue)
                  collectedEvents.push(event)
                }
              })
            )

            // Spawn an interactive shell
            const terminal = yield* tm.spawn({
              command: '/bin/sh',
              cwd: TEST_CWD,
              cols: 80,
              rows: 24,
              workspaceId: TEST_WORKSPACE_ID,
            })

            // Wait for the detection fiber to establish a baseline snapshot
            yield* Effect.sleep(500)

            // Run a child process — this changes the process tree
            yield* tm.write(terminal.id, 'cat\n')

            // Wait for the detection fiber to pick up the change (~200ms per tick)
            yield* Effect.sleep(1000)

            yield* Fiber.interrupt(collectFiber)
            return terminal.id
          })
        )
      )

      // Filter for ProcessChanged events for our terminal
      const processChangedEvents = collectedEvents.filter(
        (e) => e._tag === 'ProcessChanged' && e.terminal.id === terminalId
      )

      // Should have at least one ProcessChanged — the detection fiber
      // noticed the process tree changed when 'cat' became the foreground process.
      assert.isTrue(
        processChangedEvents.length >= 1,
        `Expected at least 1 ProcessChanged event, got ${processChangedEvents.length}`
      )

      // The most recent ProcessChanged should have the cat foreground process
      const lastEvent = processChangedEvents.at(-1)
      assert.isDefined(lastEvent)
      if (lastEvent?._tag === 'ProcessChanged') {
        assert.isDefined(lastEvent.terminal.foregroundProcess)
      }

      // Clean up
      await runLocalEffect(
        Effect.gen(function* () {
          const tm = yield* TerminalManager
          yield* tm.kill(terminalId)
        })
      )
    })
  })

  it('detection fiber does not emit duplicate ProcessChanged for unchanged state', async () => {
    // Spawn a shell and let it idle. After an initial ProcessChanged
    // establishes the snapshot, subsequent ticks should NOT emit more
    // ProcessChanged events because the state hasn't changed.
    await withGracePeriod(60_000, async (runLocalEffect) => {
      const collectedEvents: TerminalLifecycleEvent[] = []

      const terminalId = await runLocalEffect(
        Effect.scoped(
          Effect.gen(function* () {
            const tm = yield* TerminalManager

            const dequeue = yield* PubSub.subscribe(tm.lifecycleEvents)

            const collectFiber = yield* Effect.forkChild(
              Effect.gen(function* () {
                while (true) {
                  const event = yield* PubSub.take(dequeue)
                  collectedEvents.push(event)
                }
              })
            )

            // Spawn an idle shell — no child processes
            const terminal = yield* tm.spawn({
              command: '/bin/sh',
              cwd: TEST_CWD,
              cols: 80,
              rows: 24,
              workspaceId: TEST_WORKSPACE_ID,
            })

            // Wait for the detection fiber to establish the initial snapshot.
            // This may emit 1-2 ProcessChanged events as the snapshot stabilises.
            yield* Effect.sleep(1000)

            // Clear collected events — now we measure from a stable state
            collectedEvents.length = 0

            // Wait another full second (5× the 200ms interval). No process
            // state change should occur → no new ProcessChanged events.
            yield* Effect.sleep(1000)

            yield* Fiber.interrupt(collectFiber)
            return terminal.id
          })
        )
      )

      const duplicateEvents = collectedEvents.filter(
        (e) => e._tag === 'ProcessChanged' && e.terminal.id === terminalId
      )

      // After the snapshot stabilised, we should have zero ProcessChanged
      // events because nothing changed in the idle shell.
      assert.strictEqual(
        duplicateEvents.length,
        0,
        `Expected 0 duplicate ProcessChanged events, got ${duplicateEvents.length}`
      )

      // Clean up
      await runLocalEffect(
        Effect.gen(function* () {
          const tm = yield* TerminalManager
          yield* tm.kill(terminalId)
        })
      )
    })
  })

  // -------------------------------------------------------------------------
  // OSC title should not downgrade hasChildProcess
  // -------------------------------------------------------------------------

  it('OSC idle title must not emit ProcessChanged with hasChildProcess=false while process runs', async () => {
    // This is the core bug: a process like opencode sets the terminal title
    // to a path (e.g. ~/projects/foo) via OSC 0. The isIdleTitle() heuristic
    // classifies paths as "idle" and emitTitleBasedProcessChanged immediately
    // emits a ProcessChanged event with hasChildProcess=false. The frontend
    // uses these events (not listTerminals) for close confirmation gating.
    //
    // The fix: OSC-based detection should never downgrade hasChildProcess
    // from true to false. Only ps-based detection should do that.
    await withGracePeriod(60_000, async (runLocalEffect) => {
      const collectedEvents: TerminalLifecycleEvent[] = []

      const terminalId = await runLocalEffect(
        Effect.scoped(
          Effect.gen(function* () {
            const tm = yield* TerminalManager

            const dequeue = yield* PubSub.subscribe(tm.lifecycleEvents)

            const collectFiber = yield* Effect.forkChild(
              Effect.gen(function* () {
                while (true) {
                  const event = yield* PubSub.take(dequeue)
                  collectedEvents.push(event)
                }
              })
            )

            // Spawn an interactive shell that runs a long-lived child
            // process and then emits an idle-looking OSC title.
            // This simulates what programs like opencode do: they run
            // as a child of the shell but set the terminal title to
            // the cwd (a path starting with ~ or /).
            //
            // The script:
            // 1. Starts 'sleep 999' in the background (child process)
            // 2. Emits an OSC 0 title that looks idle (a path)
            // 3. Waits (keeps the shell and sleep alive)
            const terminal = yield* tm.spawn({
              command: '/bin/sh',
              args: [
                '-c',
                'sleep 999 & printf "\\033]0;~/projects/my-app\\007"; wait',
              ],
              cwd: TEST_CWD,
              cols: 80,
              rows: 24,
              workspaceId: TEST_WORKSPACE_ID,
            })

            // Wait for shellPid to be set, the detection fiber to
            // establish hasChildProcess=true, AND the OSC title to be
            // processed by the headless terminal.
            yield* Effect.sleep(2000)

            yield* Fiber.interrupt(collectFiber)
            return terminal.id
          })
        )
      )

      // First verify that ps-based detection saw the child process.
      // ProcessChanged events should include at least one with
      // hasChildProcess=true (from the ps detection seeing 'sleep').
      const goodEvents = collectedEvents.filter(
        (e) =>
          e._tag === 'ProcessChanged' &&
          e.terminal.id === terminalId &&
          e.terminal.hasChildProcess === true
      )
      assert.isTrue(
        goodEvents.length >= 1,
        `Expected at least 1 ProcessChanged with hasChildProcess=true, got ${goodEvents.length}`
      )

      // The critical assertion: no ProcessChanged event should have
      // set hasChildProcess=false while the process is still running.
      // The frontend reads these events to gate close confirmation.
      //
      // With the bug, the OSC title "~/projects/my-app" triggers
      // emitTitleBasedProcessChanged which classifies it as idle and
      // emits ProcessChanged with hasChildProcess=false.
      const badEvents = collectedEvents.filter(
        (e) =>
          e._tag === 'ProcessChanged' &&
          e.terminal.id === terminalId &&
          e.terminal.hasChildProcess === false &&
          e.terminal.status === 'running'
      )
      assert.strictEqual(
        badEvents.length,
        0,
        `Expected zero ProcessChanged events with hasChildProcess=false while sleep is running, got ${badEvents.length}`
      )

      // Clean up
      await runLocalEffect(
        Effect.gen(function* () {
          const tm = yield* TerminalManager
          yield* tm.kill(terminalId)
        })
      )
    })
  })

  it('repeated idle-looking OSC titles never cause hasChildProcess=false while process runs', async () => {
    // Simulate an opencode-like scenario: a long-running process that
    // periodically sets the terminal title to the cwd, a shell name,
    // or other idle-looking strings. Each title change should NOT
    // cause hasChildProcess to become false.
    await withGracePeriod(60_000, async (runLocalEffect) => {
      const collectedEvents: TerminalLifecycleEvent[] = []

      const terminalId = await runLocalEffect(
        Effect.scoped(
          Effect.gen(function* () {
            const tm = yield* TerminalManager

            const dequeue = yield* PubSub.subscribe(tm.lifecycleEvents)

            const collectFiber = yield* Effect.forkChild(
              Effect.gen(function* () {
                while (true) {
                  const event = yield* PubSub.take(dequeue)
                  collectedEvents.push(event)
                }
              })
            )

            // Spawn an interactive shell, then write commands to it.
            // This ensures sh is the parent and sleep is a child.
            const terminal = yield* tm.spawn({
              command: '/bin/sh',
              cwd: TEST_CWD,
              cols: 80,
              rows: 24,
              workspaceId: TEST_WORKSPACE_ID,
            })

            // Wait for shell to start
            yield* Effect.sleep(500)

            // Background a long-lived process
            yield* tm.write(terminal.id, 'sleep 999 &\n')

            // Wait for ps to detect the child process
            yield* Effect.sleep(1000)

            // Clear events — we only care about what happens AFTER
            // the baseline with hasChildProcess=true is established.
            collectedEvents.length = 0

            // Emit several idle-looking OSC titles in sequence.
            // These go through the shell to stdout → headless terminal
            // → title callback → emitTitleBasedProcessChanged.
            yield* tm.write(
              terminal.id,
              'printf "\\033]0;~/projects/my-app\\007"\n'
            )
            yield* Effect.sleep(300)
            yield* tm.write(terminal.id, 'printf "\\033]0;zsh\\007"\n')
            yield* Effect.sleep(300)
            yield* tm.write(
              terminal.id,
              'printf "\\033]0;/Users/dev/code\\007"\n'
            )
            yield* Effect.sleep(300)
            yield* tm.write(
              terminal.id,
              'printf "\\033]0;user@host:/tmp\\007"\n'
            )

            // Wait for all titles to be processed + ps ticks
            yield* Effect.sleep(1000)

            yield* Fiber.interrupt(collectFiber)
            return terminal.id
          })
        )
      )

      // ZERO ProcessChanged events should have hasChildProcess=false
      // while the background process is still running. After we cleared
      // events, any new events from the title changes + ps ticks should
      // all maintain hasChildProcess=true.
      const badEvents = collectedEvents.filter(
        (e) =>
          e._tag === 'ProcessChanged' &&
          e.terminal.id === terminalId &&
          e.terminal.hasChildProcess === false &&
          e.terminal.status === 'running'
      )
      assert.strictEqual(
        badEvents.length,
        0,
        `Expected zero ProcessChanged with hasChildProcess=false during rapid title changes, got ${badEvents.length}`
      )

      // Also verify via listTerminals that hasChildProcess is still true
      const terminals = await runLocalEffect(
        Effect.gen(function* () {
          const tm = yield* TerminalManager
          return yield* tm.listTerminals()
        })
      )
      const terminal = terminals.find((t) => t.id === terminalId)
      assert.isDefined(terminal)
      assert.strictEqual(
        terminal?.hasChildProcess,
        true,
        'hasChildProcess must still be true after rapid idle title changes'
      )

      // Clean up
      await runLocalEffect(
        Effect.gen(function* () {
          const tm = yield* TerminalManager
          yield* tm.kill(terminalId)
        })
      )
    })
  })

  it('ps-based detection correctly transitions hasChildProcess to false when process exits', async () => {
    // Complementary test: when a child process genuinely exits, the ps
    // detection fiber must transition hasChildProcess from true to false.
    // This ensures the fix (preserving hasChildProcess on OSC idle) does
    // not prevent legitimate idle detection by the ps fiber.
    await withGracePeriod(60_000, async (runLocalEffect) => {
      const collectedEvents: TerminalLifecycleEvent[] = []

      const terminalId = await runLocalEffect(
        Effect.scoped(
          Effect.gen(function* () {
            const tm = yield* TerminalManager

            const dequeue = yield* PubSub.subscribe(tm.lifecycleEvents)

            const collectFiber = yield* Effect.forkChild(
              Effect.gen(function* () {
                while (true) {
                  const event = yield* PubSub.take(dequeue)
                  collectedEvents.push(event)
                }
              })
            )

            // Spawn a shell that runs a short-lived child process.
            // 'sleep 1' runs for 1 second then exits, leaving the shell
            // idle at its prompt.
            const terminal = yield* tm.spawn({
              command: '/bin/sh',
              args: ['-c', 'sleep 1 & wait'],
              cwd: TEST_CWD,
              cols: 80,
              rows: 24,
              workspaceId: TEST_WORKSPACE_ID,
            })

            // Wait for ps detection to see the child process
            yield* Effect.sleep(500)

            // Verify hasChildProcess is true while sleep is running
            const duringTerminals = yield* tm.listTerminals()
            const during = duringTerminals.find((t) => t.id === terminal.id)
            assert.strictEqual(
              during?.hasChildProcess,
              true,
              'Expected hasChildProcess=true while sleep is running'
            )

            // Wait for sleep to exit and the detection fiber to notice
            yield* Effect.sleep(2000)

            yield* Fiber.interrupt(collectFiber)
            return terminal.id
          })
        )
      )

      // After sleep exits, listTerminals should report hasChildProcess=false
      const afterTerminals = await runLocalEffect(
        Effect.gen(function* () {
          const tm = yield* TerminalManager
          return yield* tm.listTerminals()
        })
      )

      const terminal = afterTerminals.find((t) => t.id === terminalId)
      // Terminal may have stopped (sh exits after wait completes), or
      // if still running, hasChildProcess should be false.
      if (terminal !== undefined && terminal.status === 'running') {
        assert.strictEqual(
          terminal.hasChildProcess,
          false,
          'hasChildProcess must be false after sleep exits'
        )
      }

      // Also check events: process disappearance is represented either by a
      // final process snapshot or by the explicit terminal stop event when
      // the shell exits immediately after its child.
      const transitionEvents = collectedEvents.filter(
        (e) =>
          e._tag === 'ProcessChanged' &&
          e.terminal.id === terminalId &&
          e.terminal.hasChildProcess === false
      )
      const stoppedEvents = collectedEvents.filter(
        (event) =>
          event._tag === 'StatusChanged' &&
          event.id === terminalId &&
          event.status === 'stopped'
      )
      assert.isTrue(transitionEvents.length >= 1 || stoppedEvents.length >= 1)

      // Clean up — terminal may already be stopped after sleep/sh exit
      await runLocalEffect(
        Effect.gen(function* () {
          const tm = yield* TerminalManager
          yield* tm.remove(terminalId)
        })
      )
    })
  })

  it('non-OSC fallback timer must not clear hasChildProcess while process runs', async () => {
    // For shells that don't emit OSC sequences, a fallback timer resets
    // the terminal to "idle" after 10 seconds. This calls
    // emitTitleBasedProcessChanged(id, '') which should NOT set
    // hasChildProcess=false if a child process is still running.
    //
    // We use a shorter fallback (set via env) to avoid a 10s test wait.
    // Actually the fallback is hardcoded to 10s, so we write to the
    // terminal to trigger it, then wait. The test verifies that after
    // the fallback fires, the close confirmation gate is still correct.
    await withGracePeriod(60_000, async (runLocalEffect) => {
      const collectedEvents: TerminalLifecycleEvent[] = []

      const terminalId = await runLocalEffect(
        Effect.scoped(
          Effect.gen(function* () {
            const tm = yield* TerminalManager

            const dequeue = yield* PubSub.subscribe(tm.lifecycleEvents)

            const collectFiber = yield* Effect.forkChild(
              Effect.gen(function* () {
                while (true) {
                  const event = yield* PubSub.take(dequeue)
                  collectedEvents.push(event)
                }
              })
            )

            // Spawn an interactive shell with a backgrounded child.
            // Using /bin/sh directly (not via -c) so the shell is
            // interactive. This shell won't emit OSC sequences.
            const terminal = yield* tm.spawn({
              command: '/bin/sh',
              cwd: TEST_CWD,
              cols: 80,
              rows: 24,
              workspaceId: TEST_WORKSPACE_ID,
            })

            // Wait for baseline ps detection
            yield* Effect.sleep(1500)

            // Background a process and send a newline to trigger
            // the non-OSC fallback timer (fires after 10 seconds).
            yield* tm.write(terminal.id, 'sleep 999 &\n')

            // Wait for the fallback timer to fire (10 seconds) plus
            // a buffer for ps detection ticks.
            yield* Effect.sleep(11_000)

            yield* Fiber.interrupt(collectFiber)
            return terminal.id
          })
        )
      )

      // Verify ps detection found the child process at some point.
      const goodEvents = collectedEvents.filter(
        (e) =>
          e._tag === 'ProcessChanged' &&
          e.terminal.id === terminalId &&
          e.terminal.hasChildProcess === true
      )
      assert.isTrue(
        goodEvents.length >= 1,
        `Expected at least 1 ProcessChanged with hasChildProcess=true, got ${goodEvents.length}`
      )

      // Also verify via listTerminals that hasChildProcess is still true.
      const terminals = await runLocalEffect(
        Effect.gen(function* () {
          const tm = yield* TerminalManager
          return yield* tm.listTerminals()
        })
      )

      const terminal = terminals.find((t) => t.id === terminalId)
      assert.isDefined(terminal)
      assert.strictEqual(
        terminal?.hasChildProcess,
        true,
        'hasChildProcess must be true — sleep is still running after fallback timer fired'
      )

      // Clean up
      await runLocalEffect(
        Effect.gen(function* () {
          const tm = yield* TerminalManager
          yield* tm.kill(terminalId)
        })
      )
    })
  })

  it('OSC 133 prompt-idle must not emit ProcessChanged with hasChildProcess=false while background process runs', async () => {
    // When a shell emits OSC 133 "A" (returned to prompt), the handler
    // calls emitTitleBasedProcessChanged('') which is idle. But if a
    // background process (like sleep 999 &) is still running, the ps
    // detection correctly has hasChildProcess=true.
    //
    // The fix ensures emitTitleBasedProcessChanged preserves the
    // ps-based hasChildProcess even when OSC 133 says "idle".
    await withGracePeriod(60_000, async (runLocalEffect) => {
      const collectedEvents: TerminalLifecycleEvent[] = []

      const terminalId = await runLocalEffect(
        Effect.scoped(
          Effect.gen(function* () {
            const tm = yield* TerminalManager

            const dequeue = yield* PubSub.subscribe(tm.lifecycleEvents)

            const collectFiber = yield* Effect.forkChild(
              Effect.gen(function* () {
                while (true) {
                  const event = yield* PubSub.take(dequeue)
                  collectedEvents.push(event)
                }
              })
            )

            // Spawn a shell that:
            // 1. Backgrounds a long-lived process (sleep 999)
            // 2. Emits OSC 133 "A" (prompt marker = idle)
            // 3. Waits to keep everything alive
            //
            // This simulates a shell returning to its prompt while a
            // background job is still running.
            const terminal = yield* tm.spawn({
              command: '/bin/sh',
              args: ['-c', 'sleep 999 & printf "\\033]133;A\\007"; wait'],
              cwd: TEST_CWD,
              cols: 80,
              rows: 24,
              workspaceId: TEST_WORKSPACE_ID,
            })

            // Wait for ps detection to establish hasChildProcess=true
            // and for the OSC 133 marker to be processed.
            yield* Effect.sleep(2000)

            yield* Fiber.interrupt(collectFiber)
            return terminal.id
          })
        )
      )

      // Verify ps detection found the child process at some point.
      const goodEvents = collectedEvents.filter(
        (e) =>
          e._tag === 'ProcessChanged' &&
          e.terminal.id === terminalId &&
          e.terminal.hasChildProcess === true
      )
      assert.isTrue(
        goodEvents.length >= 1,
        `Expected at least 1 ProcessChanged with hasChildProcess=true, got ${goodEvents.length}`
      )

      // No ProcessChanged should have hasChildProcess=false while
      // the background process is still running.
      const badEvents = collectedEvents.filter(
        (e) =>
          e._tag === 'ProcessChanged' &&
          e.terminal.id === terminalId &&
          e.terminal.hasChildProcess === false &&
          e.terminal.status === 'running'
      )
      assert.strictEqual(
        badEvents.length,
        0,
        `Expected zero ProcessChanged with hasChildProcess=false while background process runs, got ${badEvents.length}`
      )

      // Clean up
      await runLocalEffect(
        Effect.gen(function* () {
          const tm = yield* TerminalManager
          yield* tm.kill(terminalId)
        })
      )
    })
  })

  // -------------------------------------------------------------------------
  // Agent session title tracking
  // -------------------------------------------------------------------------

  it('tracks the focused agent session title across session switches', async () => {
    // OpenCode's TUI renames the terminal (OSC 0) to "OC | <session title>"
    // and rewrites it whenever the operator switches session tabs. The
    // sidebar names each row after the session it is showing, so the manager
    // must follow the latest title rather than keeping the first one.
    await withGracePeriod(60_000, async (runLocalEffect) => {
      const observed = await runLocalEffect(
        Effect.scoped(
          Effect.gen(function* () {
            const tm = yield* TerminalManager

            // Emit a session title, then a second one (a tab switch), then
            // the bare title OpenCode uses for screens with no session.
            // `sleep` keeps a child process alive throughout so the
            // terminal stays in the running, agent-occupied state.
            const terminal = yield* tm.spawn({
              command: '/bin/sh',
              args: [
                '-c',
                'sleep 999 & printf "\\033]0;OC | Mirror church-work create task\\007"; sleep 1; printf "\\033]0;OC | Fix the flaky spawn test\\007"; sleep 1; printf "\\033]0;OpenCode\\007"; wait',
              ],
              cwd: TEST_CWD,
              cols: 80,
              rows: 24,
              workspaceId: TEST_WORKSPACE_ID,
            })

            // After the first title lands, the row is named for that session.
            yield* Effect.sleep(600)
            const afterFirstTitle = (yield* tm.listTerminals()).find(
              ({ id }) => id === terminal.id
            )?.sessionTitle

            // After the switch, the row follows to the newly focused session.
            yield* Effect.sleep(1000)
            const afterSwitch = (yield* tm.listTerminals()).find(
              ({ id }) => id === terminal.id
            )?.sessionTitle

            // A title carrying no session identity clears the stale name.
            yield* Effect.sleep(1000)
            const afterSessionless = (yield* tm.listTerminals()).find(
              ({ id }) => id === terminal.id
            )?.sessionTitle

            yield* tm.kill(terminal.id)

            // A stopped terminal displays nothing, so it names no session.
            const afterKill = (yield* tm.listTerminals()).find(
              ({ id }) => id === terminal.id
            )?.sessionTitle

            return {
              afterFirstTitle,
              afterSwitch,
              afterSessionless,
              afterKill,
            }
          })
        )
      )

      assert.strictEqual(
        observed.afterFirstTitle,
        'Mirror church-work create task'
      )
      assert.strictEqual(observed.afterSwitch, 'Fix the flaky spawn test')
      assert.strictEqual(observed.afterSessionless, null)
      assert.strictEqual(observed.afterKill, null)
    })
  })

  it('setAgentStatusFromHook emits ProcessChanged immediately', async () => {
    // When a hook sets the agent status, a ProcessChanged event should
    // be published before the hook update completes.
    await runEffect(
      Effect.scoped(
        Effect.gen(function* () {
          const tm = yield* TerminalManager

          // Spawn a terminal
          const terminal = yield* tm.spawn({
            command: 'cat',
            cwd: TEST_CWD,
            cols: 80,
            rows: 24,
            workspaceId: TEST_WORKSPACE_ID,
          })

          // Subscribe to lifecycle events
          const dequeue = yield* PubSub.subscribe(tm.lifecycleEvents)

          // Set agent status via hook — should emit ProcessChanged immediately
          yield* tm.setAgentStatusFromHook(terminal.id, {
            status: 'working',
            sequence: 1,
          })

          // The hook update does not return until its event is published, so
          // draining the subscription is deterministic even under suite load.
          const hookEvents = (yield* PubSub.takeAll(dequeue)).filter(
            (event) =>
              event._tag === 'ProcessChanged' &&
              event.terminal.id === terminal.id &&
              event.terminal.agentStatus?.status === 'working'
          )

          assert.isTrue(
            hookEvents.length >= 1,
            `Expected at least 1 ProcessChanged from hook, got ${hookEvents.length}`
          )

          // Clean up
          yield* tm.kill(terminal.id)
        })
      )
    )
  })
})
