/**
 * Flow Control Tests — consumer-scoped backpressure
 *
 * Verifies the policy from ADR 0002: PTY flow control (char counting +
 * pause at the high watermark) is only active while at least one
 * data-channel consumer is attached.
 *
 * - Detached terminals always flow, so background agents never stall on
 *   a full kernel buffer while nobody is watching.
 * - Attaching a consumer resets the unacknowledged counter and resumes
 *   a paused PTY, so ack debt never survives a reconnect (the bug that
 *   permanently froze terminals).
 * - Detaching the last consumer clears and disables flow control.
 *
 * @see packages/terminal/src/services/pty-direct.ts
 * @see docs/adr/0002-flow-control-only-while-attached.md
 */

import { Context, Effect, Exit, Layer, Scope } from 'effect'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { directLayer as PtyDirectLayer } from '../src/services/pty-direct.js'
import { PtyHostClient } from '../src/services/pty-host-client.js'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type PtyHostClientService = Context.Service.Shape<typeof PtyHostClient>

let layerScope: Scope.Closeable
let ptyHost: PtyHostClientService

beforeAll(async () => {
  layerScope = Effect.runSync(Scope.make())
  const context = await Effect.runPromise(
    Layer.buildWithScope(PtyDirectLayer, layerScope)
  )
  ptyHost = Context.get(context, PtyHostClient)
}, 30_000)

afterAll(async () => {
  await Effect.runPromise(Scope.close(layerScope, Exit.void))
}, 15_000)

/** Total chars each test terminal emits — far past the 100k watermark. */
const EMIT_CHARS = 500_000

/** High watermark from pty-direct.ts — pause threshold while attached. */
const HIGH_WATERMARK_CHARS = 100_000

/** Poll interval for waitFor. */
const POLL_MS = 50

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(
  condition: () => boolean,
  timeoutMs: number,
  label: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) {
      return
    }
    await delay(POLL_MS)
  }
  throw new Error(`Timed out waiting for: ${label}`)
}

interface EmitterState {
  exited: boolean
  received: number
}

/**
 * Spawn a PTY that emits `EMIT_CHARS` of output as fast as possible and
 * then exits. If the PTY is paused, the pipeline blocks on a full kernel
 * buffer and the process cannot finish — making pause/resume observable
 * through `received` and `exited`.
 */
function spawnEmitter(id: string): EmitterState {
  const state: EmitterState = { exited: false, received: 0 }

  ptyHost.spawn(
    {
      id,
      shell: '/bin/sh',
      args: ['-c', `head -c ${EMIT_CHARS} /dev/zero | tr '\\0' a`],
      cols: 80,
      rows: 24,
      cwd: '/tmp',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    },
    (data) => {
      state.received += data.length
    },
    () => {
      state.exited = true
    }
  )

  return state
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PTY flow control (consumer-scoped)', { timeout: 30_000 }, () => {
  it('streams freely past the high watermark when no consumer is attached', async () => {
    const state = spawnEmitter('fc-detached')

    await waitFor(() => state.exited, 15_000, 'emitter exit while detached')

    expect(state.received).toBeGreaterThanOrEqual(EMIT_CHARS)
  })

  it('pauses at the high watermark while a consumer is attached and resumes when the last consumer detaches', async () => {
    const id = 'fc-attached-pause'
    ptyHost.attachFlowControlConsumer(id)

    const state = spawnEmitter(id)

    // Output should stall once the unacknowledged count crosses the
    // high watermark (nobody is acking).
    await waitFor(
      () => state.received > HIGH_WATERMARK_CHARS,
      15_000,
      'output to reach the high watermark'
    )

    // Give the pause a moment to take effect, then confirm the stall.
    await delay(500)
    const stalled = state.received
    expect(state.exited).toBe(false)
    expect(stalled).toBeLessThan(EMIT_CHARS)

    await delay(500)
    expect(state.received).toBe(stalled)

    // Detaching the last consumer clears flow control and resumes.
    ptyHost.detachFlowControlConsumer(id)

    await waitFor(() => state.exited, 15_000, 'emitter exit after detach')
    expect(state.received).toBeGreaterThanOrEqual(EMIT_CHARS)
  })

  it('attaching a new consumer clears stale ack debt and resumes a paused PTY', async () => {
    const id = 'fc-reattach-resume'
    ptyHost.attachFlowControlConsumer(id)

    const state = spawnEmitter(id)

    await waitFor(
      () => state.received > HIGH_WATERMARK_CHARS,
      15_000,
      'output to reach the high watermark'
    )
    await delay(500)
    const stalled = state.received
    expect(state.exited).toBe(false)

    // A second consumer attaching (e.g. a remounted terminal pane)
    // must reset the counter and resume — ack debt owed by the first
    // consumer never freezes the new one.
    ptyHost.attachFlowControlConsumer(id)

    await waitFor(
      () => state.received > stalled,
      10_000,
      'output to resume after reattach'
    )

    // Let it finish: drop both consumers so flow control disengages.
    ptyHost.detachFlowControlConsumer(id)
    ptyHost.detachFlowControlConsumer(id)

    await waitFor(() => state.exited, 15_000, 'emitter exit after detach')
    expect(state.received).toBeGreaterThanOrEqual(EMIT_CHARS)
  })
})
