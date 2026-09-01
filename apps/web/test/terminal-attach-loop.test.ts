/**
 * The pane's attach loop against a fake surface.
 *
 * These pin what a synchronous renderer changes about our protocol: a snapshot
 * is a reset-and-replay rather than an append, an acknowledgement can be sent
 * the moment a write returns instead of waiting for a parse callback, and
 * replay is settled by `ReplayComplete` alone. The rest is protocol obligation
 * — dedupe against the cursor, batch acknowledgements so flow control releases,
 * and treat a `Reset` as invalidating every cursor learned before it.
 *
 * @see apps/web/src/lib/terminal-attach-loop.ts
 */

import type { TerminalAttachEvent } from '@laborer/shared/rpc'
import { describe, expect, it } from 'vitest'

import {
  createTerminalAttachLoop,
  TERMINAL_ACK_BATCH_CHARS,
  type TerminalAttachEffects,
  type TerminalReplayStatus,
} from '../src/lib/terminal-attach-loop'

type SurfaceCall =
  | { readonly kind: 'resetAndWrite'; readonly data: string }
  | { readonly kind: 'write'; readonly data: string }

interface HarnessOptions {
  /** Whether a surface is mounted to take the writes. */
  readonly drawing?: boolean
  readonly restoring?: boolean
  readonly resume?: { readonly cursor?: number | undefined }
}

/** Stands in for the screen: every write parses immediately, or is dropped. */
const createHarness = ({
  drawing = true,
  restoring = false,
  resume,
}: HarnessOptions = {}) => {
  const calls: SurfaceCall[] = []
  const acks: number[] = []
  const cursors: Array<number | undefined> = []
  const epochs: string[] = []
  const exits: Array<{ exitCode: number; signal: number }> = []
  const replayStatuses: TerminalReplayStatus[] = []
  const revivals: number[] = []
  const statuses: Array<'running' | 'stopped'> = []

  const effects: TerminalAttachEffects = {
    ack: (cursor) => {
      acks.push(cursor)
    },
    onCursor: (cursor) => {
      cursors.push(cursor)
    },
    onEpoch: (epoch) => {
      epochs.push(epoch)
    },
    onExit: (exit) => {
      exits.push(exit)
    },
    onReplayStatus: (status) => {
      replayStatuses.push(status)
    },
    onRevival: () => {
      revivals.push(revivals.length + 1)
    },
    onStatus: (status) => {
      statuses.push(status)
    },
  }

  const loop = createTerminalAttachLoop({
    effects,
    restoring,
    ...(resume === undefined ? {} : { resume }),
    target: {
      resetAndWrite: (data) => {
        if (!drawing) {
          return false
        }
        calls.push({ kind: 'resetAndWrite', data })
        return true
      },
      write: (data) => {
        if (!drawing) {
          return false
        }
        calls.push({ kind: 'write', data })
        return true
      },
    },
  })

  return {
    acks,
    calls,
    /** The last cursor the loop published, which a reattach would resume from. */
    cursor: () => (cursors.length === 0 ? resume?.cursor : cursors.at(-1)),
    cursors,
    epochs,
    exits,
    loop,
    replayStatuses,
    revivals,
    statuses,
  }
}

const snapshot = (cursor: number, data: string): TerminalAttachEvent => ({
  _tag: 'Snapshot',
  cursor,
  data,
})

const delta = (cursor: number, data: string): TerminalAttachEvent => ({
  _tag: 'Delta',
  cursor,
  data,
})

const replayComplete: TerminalAttachEvent = { _tag: 'ReplayComplete' }

const revivalReset: TerminalAttachEvent = {
  _tag: 'Reset',
  epoch: 'epoch-2',
  reason: 'epoch_changed',
}

describe('terminal attach loop', () => {
  it('replays a snapshot through resetAndWrite and appends deltas', () => {
    const harness = createHarness()

    harness.loop.handle(snapshot(10, 'screen'))
    harness.loop.handle(delta(14, 'more'))
    harness.loop.handle(replayComplete)

    expect(harness.calls).toEqual([
      { kind: 'resetAndWrite', data: 'screen' },
      { kind: 'write', data: 'more' },
    ])
    expect(harness.cursor()).toBe(14)
  })

  it('drops deltas the surface has already parsed', () => {
    const harness = createHarness()

    harness.loop.handle(snapshot(10, 'screen'))
    // A resumed attach may repeat the frame the cursor was taken from.
    harness.loop.handle(delta(10, 'screen'))
    harness.loop.handle(delta(9, 'older'))
    harness.loop.handle(delta(11, 'new'))

    expect(harness.calls).toEqual([
      { kind: 'resetAndWrite', data: 'screen' },
      { kind: 'write', data: 'new' },
    ])
    expect(harness.cursor()).toBe(11)
  })

  it('holds acknowledgements until the batch threshold is reached', () => {
    const harness = createHarness()
    const half = 'x'.repeat(TERMINAL_ACK_BATCH_CHARS - 1)

    harness.loop.handle(snapshot(half.length, half))
    expect(harness.acks).toEqual([])

    harness.loop.handle(delta(half.length + 1, 'y'))
    expect(harness.acks).toEqual([half.length + 1])

    // The counter restarts after a release rather than acking every frame.
    harness.loop.handle(delta(half.length + 2, 'z'))
    expect(harness.acks).toEqual([half.length + 1])
  })

  it('flushes a part-filled batch when replay ends', () => {
    const harness = createHarness()

    harness.loop.handle(snapshot(6, 'screen'))
    expect(harness.acks).toEqual([])

    harness.loop.handle(replayComplete)
    expect(harness.acks).toEqual([6])
  })

  it('does not repeat an acknowledgement nothing has advanced past', () => {
    const harness = createHarness()

    harness.loop.handle(snapshot(6, 'screen'))
    harness.loop.handle(replayComplete)
    harness.loop.handle(replayComplete)

    expect(harness.acks).toEqual([6])
  })

  it('acknowledges only up to the last frame it parsed', () => {
    const harness = createHarness()
    const big = 'x'.repeat(TERMINAL_ACK_BATCH_CHARS)

    harness.loop.handle(snapshot(4, 'boot'))
    harness.loop.handle(delta(4 + big.length, big))
    harness.loop.handle(delta(4 + big.length + 3, 'end'))
    harness.loop.handle(replayComplete)

    expect(harness.acks).toEqual([4 + big.length, 4 + big.length + 3])
  })

  it('clears the screen on Reset and refuses to resume from a stale cursor', () => {
    const harness = createHarness()

    harness.loop.handle(snapshot(10, 'screen'))
    harness.loop.handle(revivalReset)

    expect(harness.calls.at(-1)).toEqual({ kind: 'resetAndWrite', data: '' })
    expect(harness.cursor()).toBeUndefined()
    expect(harness.epochs.at(-1)).toBe('epoch-2')

    // Nothing from the retired generation may be acknowledged.
    harness.loop.handle(replayComplete)
    expect(harness.acks).toEqual([])

    // The snapshot answering the reset re-establishes the cursor.
    harness.loop.handle(snapshot(3, 'new'))
    harness.loop.handle(replayComplete)
    expect(harness.cursor()).toBe(3)
    expect(harness.acks).toEqual([3])
  })

  it('accepts a delta after a Reset that the old cursor would have dropped', () => {
    const harness = createHarness()

    harness.loop.handle(snapshot(100, 'screen'))
    harness.loop.handle(revivalReset)
    harness.loop.handle(delta(4, 'boot'))

    expect(harness.calls.at(-1)).toEqual({ kind: 'write', data: 'boot' })
    expect(harness.cursor()).toBe(4)
  })

  it('reports a revival only for a reset that replaced the process', () => {
    const revived = createHarness()
    revived.loop.handle(revivalReset)
    expect(revived.revivals).toHaveLength(1)

    const resumed = createHarness()
    resumed.loop.handle({
      _tag: 'Reset',
      epoch: 'epoch-2',
      reason: 'cursor_out_of_range',
    })
    expect(resumed.revivals).toEqual([])
  })

  it('publishes the epoch and status a reattach declares', () => {
    const harness = createHarness()

    harness.loop.handle({ _tag: 'Meta', epoch: 'epoch-1', status: 'running' })

    expect(harness.epochs).toEqual(['epoch-1'])
    expect(harness.statuses).toEqual(['running'])
  })

  it('reports an exit without disturbing the restored screen', () => {
    const harness = createHarness()

    harness.loop.handle(snapshot(6, 'screen'))
    harness.loop.handle(replayComplete)
    harness.loop.handle({ _tag: 'Exit', exitCode: 137, signal: 9 })

    expect(harness.exits).toEqual([{ exitCode: 137, signal: 9 }])
    expect(harness.calls).toEqual([{ kind: 'resetAndWrite', data: 'screen' }])
    expect(harness.acks).toEqual([6])
  })

  it('resumes from the cursor the previous attach reached', () => {
    const harness = createHarness({ resume: { cursor: 42 } })

    expect(harness.cursor()).toBe(42)

    harness.loop.handle(delta(42, 'repeat'))
    harness.loop.handle(delta(48, 'fresh'))

    expect(harness.calls).toEqual([{ kind: 'write', data: 'fresh' }])
  })

  it('does not advance past output no surface took', () => {
    const harness = createHarness({ drawing: false })

    harness.loop.handle(snapshot(10, 'screen'))
    harness.loop.handle(delta(20, 'live'))
    harness.loop.handle(replayComplete)

    // Nothing was drawn, so nothing may be resumed from or acknowledged: the
    // surface that eventually mounts is blank and needs the history again.
    expect(harness.cursor()).toBeUndefined()
    expect(harness.acks).toEqual([])
  })

  it('starts idle so a fresh pane is not mistaken for a restore', () => {
    const harness = createHarness()

    expect(harness.replayStatuses).toEqual(['idle'])

    harness.loop.handle(snapshot(6, 'screen'))
    harness.loop.handle(replayComplete)

    expect(harness.replayStatuses.at(-1)).toBe('complete')
  })

  it('covers the previous screen from the moment a reattach starts', () => {
    const harness = createHarness({ restoring: true })

    expect(harness.replayStatuses).toEqual(['replaying'])

    harness.loop.handle(replayComplete)
    expect(harness.replayStatuses.at(-1)).toBe('complete')
  })

  it('reopens replay for a revival reset over a settled screen', () => {
    const harness = createHarness()

    harness.loop.handle(snapshot(6, 'screen'))
    harness.loop.handle(replayComplete)
    expect(harness.loop.replayStatus()).toBe('complete')

    // The screen the operator is looking at has just gone stale, so this is a
    // restore rather than a fresh start — the revival marker depends on it.
    harness.loop.handle(revivalReset)
    expect(harness.loop.replayStatus()).toBe('replaying')

    harness.loop.handle(snapshot(3, 'new'))
    expect(harness.loop.replayStatus()).toBe('replaying')

    harness.loop.handle(replayComplete)
    expect(harness.loop.replayStatus()).toBe('complete')
  })

  it('keeps live output after restoration out of the replay overlay', () => {
    const harness = createHarness()

    harness.loop.handle(snapshot(6, 'screen'))
    harness.loop.handle(replayComplete)
    harness.loop.handle(delta(10, 'live'))

    expect(harness.loop.replayStatus()).toBe('complete')
  })
})
