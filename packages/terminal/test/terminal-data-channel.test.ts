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

import { strict as assert } from 'node:assert/strict'
import { MessageChannel } from 'node:worker_threads'

import { RpcClient, RpcServer } from '@effect/rpc'
import { describe } from '@effect/vitest'
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
import { afterAll, beforeAll, expect, it } from 'vitest'

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

    // Should have received at least a status message and a screen-state
    // snapshot or some live PTY output.
    expect(receivedMessages.length >= 2).toBe(true)

    // First message should be a status control message.
    const firstMsg = receivedMessages[0]
    assert.strictEqual(typeof firstMsg, 'string')
    const parsed = JSON.parse(firstMsg as string) as Record<string, unknown>
    assert.strictEqual(parsed.type, 'status')
    assert.strictEqual(parsed.status, 'running')

    const hasScreenState = receivedMessages.slice(1).some((msg) => {
      if (typeof msg !== 'string') {
        return false
      }
      try {
        const parsed = JSON.parse(msg) as Record<string, unknown>
        return (
          parsed.type === 'screenState' &&
          typeof parsed.data === 'string' &&
          parsed.data.length > 0
        )
      } catch {
        return false
      }
    })

    // Remaining messages should contain a screen snapshot or raw PTY output.
    const hasOutput = receivedMessages
      .slice(1)
      .some((msg) => typeof msg === 'string' && msg.length > 0)
    expect(hasScreenState || hasOutput).toBe(true)

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

    expect(hasEcho).toBe(true)

    // Kill the terminal and clean up.
    await run(client.terminal.kill({ id: terminal.id }))
    rendererPort.close()
    await Effect.runPromise(Fiber.interrupt(fiber))
  })

  it('sends screenState before live output when attaching to an active terminal', async () => {
    const terminal = await run(
      client.terminal.spawn({
        command: 'printf "snapshot-marker\n"; exec /bin/cat',
        cwd: TEST_CWD,
        cols: 80,
        rows: 24,
        workspaceId: TEST_WORKSPACE_ID,
      })
    )

    await delay(500)

    const { port1: rendererPort, port2: utilityPort } = new MessageChannel()

    const receivedMessages: unknown[] = []
    rendererPort.on('message', (data: unknown) => {
      receivedMessages.push(data)
    })

    const fiber = Runtime.runFork(dataChannelRuntime)(
      attachDataChannel(toRpcPort(utilityPort), terminal.id).pipe(Effect.scoped)
    )

    await delay(1000)

    expect(receivedMessages.length >= 2).toBe(true)

    const statusMessage = JSON.parse(receivedMessages[0] as string) as {
      status: string
      type: string
    }
    assert.strictEqual(statusMessage.type, 'status')
    assert.strictEqual(statusMessage.status, 'running')

    const screenStateMessage = JSON.parse(receivedMessages[1] as string) as {
      data: string
      type: string
    }
    assert.strictEqual(screenStateMessage.type, 'screenState')
    expect(screenStateMessage.data).toContain('snapshot-marker')

    await run(client.terminal.kill({ id: terminal.id }))
    rendererPort.close()
    await Effect.runPromise(Fiber.interrupt(fiber))
  })

  it('sends replay payload and replayComplete when attaching to a revived terminal', async () => {
    const terminal = await run(
      client.terminal.spawn({
        command: 'printf "live-process\n"; exec /bin/cat',
        cwd: TEST_CWD,
        cols: 80,
        rows: 24,
        workspaceId: TEST_WORKSPACE_ID,
      })
    )

    await Runtime.runPromise(dataChannelRuntime)(
      Effect.gen(function* () {
        const terminalManager = yield* TerminalManager
        yield* terminalManager.setRevivedReplayEvent(terminal.id, {
          commands: {
            isWindowsPty: false,
            hasRichCommandDetection: true,
            promptInputModel: undefined,
            commands: [
              {
                command: 'ls',
                commandLineConfidence: 'high',
                isTrusted: true,
                timestamp: 123,
                duration: 45,
                id: 'command-1',
                cwd: '/tmp',
                exitCode: 0,
                commandStartLineContent: '$ ls',
                markProperties: undefined,
                executedX: 0,
                startX: 0,
                startLine: 1,
                promptStartLine: 1,
                endLine: 2,
                executedLine: 1,
              },
            ],
          },
          events: [
            {
              cols: 91,
              rows: 27,
              data: 'revived-output\r\n',
            },
            {
              cols: 120,
              rows: 40,
              data: '$ ',
            },
          ],
        })
      })
    )

    const { port1: rendererPort, port2: utilityPort } = new MessageChannel()

    const receivedMessages: unknown[] = []
    rendererPort.on('message', (data: unknown) => {
      receivedMessages.push(data)
    })

    const fiber = Runtime.runFork(dataChannelRuntime)(
      attachDataChannel(toRpcPort(utilityPort), terminal.id).pipe(Effect.scoped)
    )

    await delay(1000)

    expect(receivedMessages.length >= 3).toBe(true)

    const statusMessage = JSON.parse(receivedMessages[0] as string) as {
      status: string
      type: string
    }
    assert.strictEqual(statusMessage.type, 'status')
    assert.strictEqual(statusMessage.status, 'running')

    const replayMessage = JSON.parse(receivedMessages[1] as string) as {
      commands?: {
        commands: Array<{ command: string; cwd?: string; exitCode?: number }>
        hasRichCommandDetection: boolean
        isWindowsPty: boolean
      }
      events: Array<{ cols: number; data: string; rows: number }>
      type: string
    }
    assert.strictEqual(replayMessage.type, 'replay')
    assert.deepEqual(replayMessage.events, [
      {
        cols: 91,
        rows: 27,
        data: 'revived-output\r\n',
      },
      {
        cols: 120,
        rows: 40,
        data: '$ ',
      },
    ])
    assert.deepEqual(replayMessage.commands, {
      isWindowsPty: false,
      hasRichCommandDetection: true,
      commands: [
        {
          command: 'ls',
          commandLineConfidence: 'high',
          isTrusted: true,
          timestamp: 123,
          duration: 45,
          id: 'command-1',
          cwd: '/tmp',
          exitCode: 0,
          commandStartLineContent: '$ ls',
          executedX: 0,
          startX: 0,
          startLine: 1,
          promptStartLine: 1,
          endLine: 2,
          executedLine: 1,
        },
      ],
    })

    const replayCompleteMessage = JSON.parse(receivedMessages[2] as string) as {
      type: string
    }
    assert.strictEqual(replayCompleteMessage.type, 'replayComplete')

    await run(client.terminal.kill({ id: terminal.id }))
    rendererPort.close()
    await Effect.runPromise(Fiber.interrupt(fiber))
  })

  it('sends partial command replay state when attaching to a revived terminal', async () => {
    const terminal = await run(
      client.terminal.spawn({
        command: 'printf "live-process\n"; exec /bin/cat',
        cwd: TEST_CWD,
        cols: 80,
        rows: 24,
        workspaceId: TEST_WORKSPACE_ID,
      })
    )

    await Runtime.runPromise(dataChannelRuntime)(
      Effect.gen(function* () {
        const terminalManager = yield* TerminalManager
        yield* terminalManager.setRevivedReplayEvent(terminal.id, {
          commands: {
            isWindowsPty: false,
            hasRichCommandDetection: false,
            promptInputModel: {
              commandStartX: 0,
              cursorIndex: 10,
              ghostTextIndex: -1,
              lastUserInput: '',
              value: 'git status',
            },
            commands: [
              {
                command: 'git status',
                commandLineConfidence: 'high',
                isTrusted: false,
                timestamp: 123,
                duration: 0,
                cwd: '/tmp/repo',
              },
            ],
          },
          events: [
            {
              cols: 80,
              rows: 24,
              data: '$ git status',
            },
          ],
        })
      })
    )

    const { port1: rendererPort, port2: utilityPort } = new MessageChannel()

    const receivedMessages: unknown[] = []
    rendererPort.on('message', (data: unknown) => {
      receivedMessages.push(data)
    })

    const fiber = Runtime.runFork(dataChannelRuntime)(
      attachDataChannel(toRpcPort(utilityPort), terminal.id).pipe(Effect.scoped)
    )

    await delay(1000)

    expect(receivedMessages.length >= 3).toBe(true)

    const replayMessage = JSON.parse(receivedMessages[1] as string) as {
      commands?: {
        commands: Array<{
          command: string
          commandLineConfidence: string
          cwd?: string
          duration: number
          isTrusted: boolean
          timestamp: number
        }>
        hasRichCommandDetection: boolean
        isWindowsPty: boolean
        promptInputModel?: {
          commandStartX: number
          cursorIndex: number
          ghostTextIndex: number
          lastUserInput: string
          value: string
        }
      }
      events: Array<{ cols: number; data: string; rows: number }>
      type: string
    }

    assert.strictEqual(replayMessage.type, 'replay')
    assert.deepEqual(replayMessage.events, [
      {
        cols: 80,
        rows: 24,
        data: '$ git status',
      },
    ])
    assert.deepEqual(replayMessage.commands, {
      isWindowsPty: false,
      hasRichCommandDetection: false,
      promptInputModel: {
        commandStartX: 0,
        cursorIndex: 10,
        ghostTextIndex: -1,
        lastUserInput: '',
        value: 'git status',
      },
      commands: [
        {
          command: 'git status',
          commandLineConfidence: 'high',
          isTrusted: false,
          timestamp: 123,
          duration: 0,
          cwd: '/tmp/repo',
        },
      ],
    })

    const replayCompleteMessage = JSON.parse(receivedMessages[2] as string) as {
      type: string
    }
    assert.strictEqual(replayCompleteMessage.type, 'replayComplete')

    await run(client.terminal.kill({ id: terminal.id }))
    rendererPort.close()
    await Effect.runPromise(Fiber.interrupt(fiber))
  })

  it('sends trusted runtime command state in replay payloads for revived terminals', async () => {
    const terminal = await run(
      client.terminal.spawn({
        command:
          'printf \'\\033]633;P;Cwd=/tmp\\007\\033]633;B\\007\\033]633;E;git\\x20status;%s\\007\\033]633;C\\007\\033]633;D;0\\007\' "$VSCODE_NONCE"; sleep 5',
        cwd: TEST_CWD,
        cols: 80,
        rows: 24,
        workspaceId: TEST_WORKSPACE_ID,
      })
    )

    await Runtime.runPromise(dataChannelRuntime)(
      Effect.gen(function* () {
        const terminalManager = yield* TerminalManager

        yield* Effect.sleep('1 second')

        const commandState = terminalManager.getCommandDetectionState(
          terminal.id
        )
        expect(commandState).toBeDefined()

        yield* terminalManager.setRevivedReplayEvent(terminal.id, {
          commands: commandState,
          events: [
            {
              cols: 80,
              rows: 24,
              data: terminalManager.getScreenState(terminal.id),
            },
          ],
        })
      })
    )

    const { port1: rendererPort, port2: utilityPort } = new MessageChannel()

    const receivedMessages: unknown[] = []
    rendererPort.on('message', (data: unknown) => {
      receivedMessages.push(data)
    })

    const fiber = Runtime.runFork(dataChannelRuntime)(
      attachDataChannel(toRpcPort(utilityPort), terminal.id).pipe(Effect.scoped)
    )

    await delay(1000)

    expect(receivedMessages.length >= 3).toBe(true)

    const replayMessage = JSON.parse(receivedMessages[1] as string) as {
      commands?: {
        commands: Array<{
          command: string
          commandLineConfidence: string
          cwd?: string
          exitCode?: number
          isTrusted: boolean
        }>
        hasRichCommandDetection: boolean
        isWindowsPty: boolean
        promptInputModel?: {
          commandStartX: number
          cursorIndex: number
          ghostTextIndex: number
          lastUserInput: string
          value: string
        }
      }
      events: Array<{ cols: number; data: string; rows: number }>
      type: string
    }

    assert.strictEqual(replayMessage.type, 'replay')
    assert.strictEqual(replayMessage.commands?.isWindowsPty, false)
    assert.strictEqual(replayMessage.commands?.hasRichCommandDetection, false)
    assert.strictEqual(
      typeof replayMessage.commands?.promptInputModel?.commandStartX,
      'number'
    )
    assert.strictEqual(
      replayMessage.commands?.promptInputModel?.cursorIndex,
      10
    )
    assert.strictEqual(
      replayMessage.commands?.promptInputModel?.ghostTextIndex,
      -1
    )
    assert.strictEqual(
      replayMessage.commands?.promptInputModel?.lastUserInput,
      'git status'
    )
    assert.strictEqual(
      replayMessage.commands?.promptInputModel?.value,
      'git status'
    )
    expect(replayMessage.commands?.commands).toEqual([
      expect.objectContaining({
        command: 'git status',
        commandLineConfidence: 'high',
        cwd: '/tmp',
        exitCode: 0,
        isTrusted: true,
      }),
    ])

    await run(client.terminal.kill({ id: terminal.id }))
    rendererPort.close()
    await Effect.runPromise(Fiber.interrupt(fiber))
  })

  it('sends replay and replayComplete in correct order for revived terminals with input guard', async () => {
    // This test verifies that the replay input guard infrastructure is
    // in place: the data channel sets `isReplayingToRenderer = true`
    // during the replay window and clears it after `replayComplete`.
    // The guard drops any incoming renderer messages during this window.
    //
    // Because MessagePort delivery is asynchronous, the replay window
    // (which is synchronous on the server) completes before any renderer
    // messages arrive. The primary input guard defense is client-side
    // (send() no-ops during replay) — the server-side guard protects
    // against edge cases with slow serialization.
    const terminal = await run(
      client.terminal.spawn({
        command: '/bin/cat',
        cwd: TEST_CWD,
        cols: 80,
        rows: 24,
        workspaceId: TEST_WORKSPACE_ID,
      })
    )

    await Runtime.runPromise(dataChannelRuntime)(
      Effect.gen(function* () {
        const terminalManager = yield* TerminalManager
        yield* terminalManager.setRevivedReplayEvent(terminal.id, {
          events: [{ cols: 80, rows: 24, data: 'replay-content\r\n' }],
        })
      })
    )

    const { port1: rendererPort, port2: utilityPort } = new MessageChannel()

    const receivedMessages: unknown[] = []
    rendererPort.on('message', (data: unknown) => {
      receivedMessages.push(data)
    })

    const fiber = Runtime.runFork(dataChannelRuntime)(
      attachDataChannel(toRpcPort(utilityPort), terminal.id).pipe(Effect.scoped)
    )

    await delay(1000)

    // Verify the replay + replayComplete sequence was sent correctly.
    expect(receivedMessages.length >= 3).toBe(true)

    const statusMsg = JSON.parse(receivedMessages[0] as string) as Record<
      string,
      unknown
    >
    expect(statusMsg.type).toBe('status')
    expect(statusMsg.status).toBe('running')

    const replayMsg = JSON.parse(receivedMessages[1] as string) as Record<
      string,
      unknown
    >
    expect(replayMsg.type).toBe('replay')

    const replayCompleteMsg = JSON.parse(
      receivedMessages[2] as string
    ) as Record<string, unknown>
    expect(replayCompleteMsg.type).toBe('replayComplete')

    // Verify input still works after replay completes.
    rendererPort.postMessage('post-replay-test\n')
    await delay(1000)

    const hasEcho = receivedMessages.some((msg) => {
      if (typeof msg === 'string' && !msg.startsWith('{')) {
        return msg.includes('post-replay-test')
      }
      if (msg instanceof ArrayBuffer) {
        return new TextDecoder().decode(msg).includes('post-replay-test')
      }
      return false
    })
    expect(hasEcho).toBe(true)

    await run(client.terminal.kill({ id: terminal.id }))
    rendererPort.close()
    await Effect.runPromise(Fiber.interrupt(fiber))
  })

  it('resumes accepting input after replayComplete', async () => {
    // Spawn cat so we can verify input echo.
    const terminal = await run(
      client.terminal.spawn({
        command: '/bin/cat',
        cwd: TEST_CWD,
        cols: 80,
        rows: 24,
        workspaceId: TEST_WORKSPACE_ID,
      })
    )

    // Set a revived replay event.
    await Runtime.runPromise(dataChannelRuntime)(
      Effect.gen(function* () {
        const terminalManager = yield* TerminalManager
        yield* terminalManager.setRevivedReplayEvent(terminal.id, {
          events: [{ cols: 80, rows: 24, data: '$ ' }],
        })
      })
    )

    const { port1: rendererPort, port2: utilityPort } = new MessageChannel()

    const receivedMessages: unknown[] = []
    rendererPort.on('message', (data: unknown) => {
      receivedMessages.push(data)
    })

    const fiber = Runtime.runFork(dataChannelRuntime)(
      attachDataChannel(toRpcPort(utilityPort), terminal.id).pipe(Effect.scoped)
    )

    // Wait for replay to complete (the server sends replay + replayComplete
    // synchronously, so by the time we can send, replay is done).
    await delay(500)

    // Send input AFTER replay has completed — this should be accepted.
    rendererPort.postMessage('post-replay-input\n')

    await delay(1000)

    // cat should echo our input.
    const hasPostReplayEcho = receivedMessages.some((msg) => {
      if (typeof msg === 'string' && !msg.startsWith('{')) {
        return msg.includes('post-replay-input')
      }
      if (msg instanceof ArrayBuffer) {
        return new TextDecoder().decode(msg).includes('post-replay-input')
      }
      return false
    })

    expect(hasPostReplayEcho).toBe(true)

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

    expect(hasStoppedStatus).toBe(true)

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
    expect(receivedMessages.length >= 1).toBe(true)

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
    expect(terminals.length > 0).toBe(true)

    // Verify data channel received data.
    expect(dataMessages.length >= 2).toBe(true)

    // Clean up.
    rendererPort.close()
    await Effect.runPromise(Fiber.interrupt(fiber))
  })
})
