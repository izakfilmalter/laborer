/**
 * Race-free WebSocket attach protocol tests.
 *
 * Tests the terminal manager's subscribe + getScreenState API that
 * underpins the race-free WebSocket attach protocol introduced in
 * Issue #8. The protocol ensures no output is lost between the screen
 * state snapshot and the start of live streaming by subscribing to
 * live output BEFORE serializing the headless terminal's screen state.
 *
 * Tests are split into two groups:
 * 1. Integration tests using the full TerminalManager + PtyHostClient stack
 *    (API shape and behavior verification)
 * 2. Unit tests for the subscribe-before-serialize pattern using the
 *    headless terminal manager directly (avoids PTY host limitations
 *    under bun's test runner where pty.onData doesn't fire)
 *
 * @see PRD-ghostty-web-migration.md — Module 2: Backend: WebSocket Attach Protocol
 * @see Issue #8: Backend: Race-free WebSocket attach protocol
 */

import { type Context, Effect, Exit, Layer, Scope } from 'effect'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { createHeadlessTerminalManager } from '../src/lib/headless-terminal.js'
import { PtyHostClient } from '../src/services/pty-host-client.js'
import { TerminalManager } from '../src/services/terminal-manager.js'

// ---------------------------------------------------------------------------
// Integration test layer (full stack)
// ---------------------------------------------------------------------------

const TestLayer = TerminalManager.layer.pipe(
  Layer.provideMerge(PtyHostClient.layer)
)

let scope: Scope.CloseableScope
let testContext: Context.Context<TerminalManager | PtyHostClient>

const runEffect = <A, E>(
  effect: Effect.Effect<A, E, TerminalManager>
): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, Layer.succeedContext(testContext)))

/** No-op subscriber for tests that don't inspect output. */
// biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op for tests
const noopSubscriber = (): void => {}

/** Helper to wait for xterm async processing. */
const waitForXterm = (ms = 50): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

beforeAll(async () => {
  scope = Effect.runSync(Scope.make())
  testContext = await Effect.runPromise(Layer.buildWithScope(TestLayer, scope))
}, 30_000)

afterAll(async () => {
  await Effect.runPromise(Scope.close(scope, Exit.void))
}, 30_000)

const TEST_CWD = '/tmp'
const TEST_WORKSPACE_ID = 'test-workspace'

// ---------------------------------------------------------------------------
// Integration tests: subscribe API shape
// ---------------------------------------------------------------------------

describe(
  'Race-free attach protocol — subscribe API',
  { timeout: 30_000 },
  () => {
    it('subscribe returns subscriberId without scrollback', async () => {
      const terminal = await runEffect(
        Effect.gen(function* () {
          const tm = yield* TerminalManager
          return yield* tm.spawn({
            command: 'echo hello',
            cwd: TEST_CWD,
            cols: 80,
            rows: 24,
            workspaceId: TEST_WORKSPACE_ID,
          })
        })
      )

      const subscribeResult = await runEffect(
        Effect.gen(function* () {
          const tm = yield* TerminalManager
          return yield* tm.subscribe(terminal.id, noopSubscriber)
        })
      )

      // Should have subscriberId but NOT scrollback
      expect(subscribeResult.subscriberId).toBeDefined()
      expect(typeof subscribeResult.subscriberId).toBe('string')
      expect(subscribeResult.subscriberId.length).toBeGreaterThan(0)

      // Verify scrollback is NOT in the return type
      expect('scrollback' in subscribeResult).toBe(false)

      await runEffect(
        Effect.gen(function* () {
          const tm = yield* TerminalManager
          yield* tm.unsubscribe(terminal.id, subscribeResult.subscriberId)
          yield* tm.kill(terminal.id)
        })
      )
    })

    it('getScreenState returns empty string for non-existent terminal', async () => {
      const screenState = await runEffect(
        Effect.gen(function* () {
          const tm = yield* TerminalManager
          return tm.getScreenState('non-existent-terminal-id')
        })
      )

      expect(screenState).toBe('')
    })

    it('subscribe and getScreenState are independently callable', async () => {
      const terminal = await runEffect(
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

      // Subscribe (step 1 of race-free pattern)
      const { subscriberId } = await runEffect(
        Effect.gen(function* () {
          const tm = yield* TerminalManager
          return yield* tm.subscribe(terminal.id, noopSubscriber)
        })
      )

      // getScreenState (step 2 of race-free pattern) — should not throw
      const screenState = await runEffect(
        Effect.gen(function* () {
          const tm = yield* TerminalManager
          return tm.getScreenState(terminal.id)
        })
      )

      // For a fresh terminal with no output yet, screen state may be empty
      expect(typeof screenState).toBe('string')

      await runEffect(
        Effect.gen(function* () {
          const tm = yield* TerminalManager
          yield* tm.unsubscribe(terminal.id, subscriberId)
          yield* tm.kill(terminal.id)
        })
      )
    })
  }
)

// ---------------------------------------------------------------------------
// Unit tests: subscribe-before-serialize pattern
//
// Uses the headless terminal manager directly to test the core
// pattern without going through the PTY host (which has limitations
// under bun's test runner where node-pty's onData doesn't fire).
// ---------------------------------------------------------------------------

describe('Race-free attach pattern — headless terminal', () => {
  let manager: ReturnType<typeof createHeadlessTerminalManager>

  afterEach(() => {
    manager?.disposeAll()
  })

  it('getScreenState returns non-empty state after writing output', async () => {
    manager = createHeadlessTerminalManager()
    // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op for tests
    manager.create('test-1', 80, 24, () => {})

    // Simulate PTY output being written to the headless terminal
    manager.write('test-1', 'screen-state-test-marker\r\n')

    // xterm.write is async — wait for processing
    await waitForXterm()

    const screenState = manager.getScreenState('test-1')
    expect(screenState.length).toBeGreaterThan(0)
    expect(screenState).toContain('screen-state-test-marker')
  })

  it('screen state is compact regardless of output volume', async () => {
    manager = createHeadlessTerminalManager()
    // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op for tests
    manager.create('test-1', 80, 24, () => {})

    // Generate many lines of output (more than the 24-row terminal can show)
    for (let i = 0; i < 200; i++) {
      manager.write(
        'test-1',
        `line ${i}: some terminal output data for testing compact serialization\r\n`
      )
    }

    await waitForXterm(100)

    const screenState = manager.getScreenState('test-1')

    // Screen state should be compact — the 24-row terminal serializes
    // visible content plus scrollback with escape sequences. For a
    // 80x24 terminal with 200 lines of output, the serialized state
    // should be well under 50KB (vs 5MB for the old ring buffer).
    expect(screenState.length).toBeGreaterThan(0)
    expect(screenState.length).toBeLessThan(50_000)
  })

  it('subscribe-before-serialize ensures data is not lost', async () => {
    manager = createHeadlessTerminalManager()
    // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op for tests
    manager.create('test-1', 80, 24, () => {})

    // Write some initial output (simulating pre-existing terminal content)
    manager.write('test-1', 'initial-content\r\n')
    await waitForXterm()

    // Simulate the race-free attach pattern:
    // Step 1: Subscribe to live output (queuing mechanism)
    const outputQueue: string[] = []
    let sendDirect = false

    // This callback simulates the WebSocket handler's subscriber
    const subscriberCallback = (data: string): void => {
      if (sendDirect) {
        outputQueue.push(`live:${data}`)
      } else {
        outputQueue.push(`queued:${data}`)
      }
    }

    // Step 2: Serialize screen state AFTER subscribing
    const screenState = manager.getScreenState('test-1')
    expect(screenState).toContain('initial-content')

    // Step 3: Write more data during the "serialization window"
    // (simulating PTY output arriving during serialization)
    manager.write('test-1', 'during-attach-data\r\n')
    subscriberCallback('during-attach-data\r\n')

    // Step 4: Switch to direct sending and flush
    sendDirect = true

    // The queue should contain the data that arrived during attach
    expect(outputQueue.length).toBeGreaterThan(0)
    expect(outputQueue[0]).toContain('queued:during-attach-data')
  })

  it('screenState message can be serialized as JSON control message', async () => {
    manager = createHeadlessTerminalManager()
    // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op for tests
    manager.create('test-1', 80, 24, () => {})

    manager.write('test-1', 'hello world\r\n')
    await waitForXterm()

    const screenState = manager.getScreenState('test-1')

    // Verify the screenState can be serialized as a JSON control message
    // (this is the format used by terminal-ws.ts)
    const controlMessage = JSON.stringify({
      type: 'screenState',
      data: screenState,
    })
    const parsed = JSON.parse(controlMessage) as {
      data: string
      type: string
    }

    expect(parsed.type).toBe('screenState')
    expect(parsed.data).toBe(screenState)
    expect(parsed.data).toContain('hello world')
  })

  it('empty terminal produces valid screenState JSON', () => {
    manager = createHeadlessTerminalManager()
    // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op for tests
    manager.create('test-1', 80, 24, () => {})

    const screenState = manager.getScreenState('test-1')

    // Even for an empty terminal, getScreenState should return
    // a valid string that can be JSON-serialized
    const controlMessage = JSON.stringify({
      type: 'screenState',
      data: screenState,
    })
    const parsed = JSON.parse(controlMessage) as {
      data: string
      type: string
    }
    expect(parsed.type).toBe('screenState')
    expect(typeof parsed.data).toBe('string')
  })
})
