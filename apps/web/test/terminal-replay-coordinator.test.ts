/**
 * Replay restoration must follow the screen, not the wire.
 *
 * The backend can emit `ReplayComplete` while xterm still holds the snapshot
 * in its write queue. These tests drive the coordinator with deferred write
 * callbacks — the same shape xterm uses — so restoration is only reported once
 * the replayed chunks have been parsed.
 *
 * @see apps/web/src/hooks/use-terminal-rpc.ts
 */

import { describe, expect, it, vi } from 'vitest'

import {
  createAttachHistory,
  createReplayCoordinator,
} from '../src/hooks/use-terminal-rpc'
import {
  showTerminalRevivalMarker,
  terminalLoadingMessage,
} from '../src/panes/terminal-loading-state'

/** Stands in for xterm's write queue: parsing happens when the test says so. */
const createWriteQueue = () => {
  const parsers: Array<() => void> = []
  return {
    parseNext: () => {
      const parse = parsers.shift()
      if (!parse) {
        throw new Error('No queued write to parse')
      }
      parse()
    },
    pending: () => parsers.length,
    /** A mounted canvas takes every chunk, so the write is always accepted. */
    write: (commit: () => void) => {
      parsers.push(commit)
      return true
    },
  }
}

/** Stands in for a screen with no canvas: the chunk is dropped, never parsed. */
const dropWrite = (_commit: () => void): boolean => false

type ReplayStatus = 'idle' | 'replaying' | 'complete'

const ignoreStatus = (_status: ReplayStatus): void => undefined

/** The pane's first attach: nothing on screen to restore. */
const firstAttach = (
  onStatusChange: (status: ReplayStatus) => void = ignoreStatus
) => createReplayCoordinator({ onStatusChange, restoring: false })

/** A later attach for the same terminal: the screen is already populated. */
const reattach = (
  onStatusChange: (status: ReplayStatus) => void = ignoreStatus
) => createReplayCoordinator({ onStatusChange, restoring: true })

describe('replay coordinator', () => {
  it('starts idle so a fresh mount is not mistaken for a restore', () => {
    const coordinator = firstAttach()

    expect(coordinator.status()).toBe('idle')
  })

  it('covers the previous screen from the moment a reattach starts', () => {
    const statuses: ReplayStatus[] = []
    const coordinator = reattach((status) => {
      statuses.push(status)
    })

    // No frame has arrived yet: the backend has not even been asked.
    expect(coordinator.status()).toBe('replaying')
    expect(statuses).toEqual(['replaying'])
  })

  it('holds replay open when ReplayComplete beats the snapshot write callback', () => {
    const statuses: ReplayStatus[] = []
    const coordinator = reattach((status) => {
      statuses.push(status)
    })
    const queue = createWriteQueue()
    const commit = vi.fn()

    coordinator.beginReplay()
    coordinator.render(queue.write, commit)
    expect(coordinator.status()).toBe('replaying')

    coordinator.endBackendReplay()
    expect(coordinator.status()).toBe('replaying')
    expect(commit).not.toHaveBeenCalled()

    queue.parseNext()
    expect(coordinator.status()).toBe('complete')
    expect(commit).toHaveBeenCalledOnce()
    expect(statuses.at(-1)).toBe('complete')
    expect(statuses).not.toContain('idle')
  })

  it('waits for every replayed chunk, not just the last one', () => {
    const coordinator = reattach()
    const queue = createWriteQueue()

    coordinator.beginReplay()
    coordinator.render(queue.write, () => undefined)
    coordinator.render(queue.write, () => undefined)
    coordinator.endBackendReplay()

    queue.parseNext()
    expect(coordinator.status()).toBe('replaying')

    queue.parseNext()
    expect(coordinator.status()).toBe('complete')
  })

  it('completes immediately when the snapshot parses synchronously', () => {
    const coordinator = firstAttach()

    coordinator.beginReplay()
    coordinator.render(
      (commit) => {
        commit()
        return true
      },
      () => undefined
    )
    coordinator.endBackendReplay()

    expect(coordinator.status()).toBe('complete')
  })

  it('does not wait for a parse of output the screen dropped', () => {
    const coordinator = reattach()

    coordinator.beginReplay()
    // No canvas is mounted, so the chunk never reaches xterm and no write
    // callback will ever arrive to settle it.
    const commit = vi.fn()
    coordinator.render(dropWrite, commit)
    coordinator.endBackendReplay()

    expect(coordinator.status()).toBe('complete')
    // Nothing was drawn, so nothing may be acknowledged.
    expect(commit).not.toHaveBeenCalled()
  })

  it('keeps live output after restoration out of the replay overlay', () => {
    const statuses: ReplayStatus[] = []
    const coordinator = reattach((status) => {
      statuses.push(status)
    })
    const queue = createWriteQueue()

    coordinator.beginReplay()
    coordinator.render(queue.write, () => undefined)
    coordinator.endBackendReplay()
    queue.parseNext()
    expect(coordinator.status()).toBe('complete')

    // Every later live frame, not just the first, leaves the overlay down.
    for (const _ of [0, 1, 2]) {
      coordinator.render(queue.write, () => undefined)
      expect(coordinator.status()).toBe('complete')
    }
    while (queue.pending() > 0) {
      queue.parseNext()
      expect(coordinator.status()).toBe('complete')
    }
    expect(statuses.slice(statuses.indexOf('complete'))).toEqual(['complete'])
  })

  it('does not let a late pre-replay write settle the next replay', () => {
    const coordinator = reattach()
    const live = createWriteQueue()
    const replay = createWriteQueue()

    coordinator.beginReplay()
    coordinator.render(replay.write, () => undefined)
    coordinator.endBackendReplay()
    replay.parseNext()

    // Live output queued after restoration, still unparsed when the
    // connection drops and the terminal replays again.
    coordinator.render(live.write, () => undefined)
    coordinator.beginReplay()
    coordinator.render(replay.write, () => undefined)
    coordinator.endBackendReplay()

    live.parseNext()
    expect(coordinator.status()).toBe('replaying')

    replay.parseNext()
    expect(coordinator.status()).toBe('complete')
  })

  it('reopens replay for a revival reset until the new snapshot renders', () => {
    const coordinator = firstAttach()
    const queue = createWriteQueue()

    coordinator.beginReplay()
    coordinator.render(queue.write, () => undefined)
    coordinator.endBackendReplay()
    queue.parseNext()

    // The revival arrives mid-attach: what is on screen is now stale, so this
    // replay is a restore even though the attach itself started fresh.
    coordinator.beginReplay()
    expect(coordinator.status()).toBe('replaying')
    coordinator.render(queue.write, () => undefined)
    coordinator.endBackendReplay()
    expect(coordinator.status()).toBe('replaying')

    queue.parseNext()
    expect(coordinator.status()).toBe('complete')
  })

  it('acknowledges a replayed chunk once, when xterm parses it', () => {
    const coordinator = reattach()
    const parsers: Array<() => void> = []
    const commit = vi.fn()

    coordinator.beginReplay()
    coordinator.render((parse) => {
      parsers.push(parse)
      return true
    }, commit)
    coordinator.endBackendReplay()

    const parse = parsers[0]
    parse?.()
    parse?.()

    expect(commit).toHaveBeenCalledOnce()
    expect(coordinator.status()).toBe('complete')
  })

  it('tracks a cursor-resumed replay that arrives as deltas alone', () => {
    const coordinator = reattach()
    const queue = createWriteQueue()

    // The backend accepted the cursor, so it resumes with deltas: no Reset and
    // no Snapshot frame ever arrives.
    coordinator.render(queue.write, () => undefined)
    coordinator.render(queue.write, () => undefined)
    coordinator.endBackendReplay()
    expect(coordinator.status()).toBe('replaying')

    queue.parseNext()
    expect(coordinator.status()).toBe('replaying')

    queue.parseNext()
    expect(coordinator.status()).toBe('complete')
  })

  it('waits for a fresh attach to render its deltas before reporting complete', () => {
    const coordinator = firstAttach()
    const queue = createWriteQueue()

    coordinator.render(queue.write, () => undefined)
    coordinator.endBackendReplay()
    // Nothing to restore, so the pane keeps its startup message — but the
    // unparsed delta still holds completion back.
    expect(coordinator.status()).toBe('idle')

    queue.parseNext()
    expect(coordinator.status()).toBe('complete')
  })
})

describe('attach history', () => {
  it('treats a reconnect onto the same canvas as a restore', () => {
    const history = createAttachHistory()

    expect(history.beginAttach(1)).toBe(false)
    expect(history.beginAttach(1)).toBe(true)
    expect(history.beginAttach(1)).toBe(true)
  })

  it('starts fresh when the canvas is rebuilt', () => {
    const history = createAttachHistory()

    history.beginAttach(1)
    // A rebuilt canvas is blank whatever the previous one had drawn — the pane
    // adopting another terminal, or React remounting it.
    expect(history.beginAttach(2)).toBe(false)
    expect(history.beginAttach(2)).toBe(true)
  })

  it('never claims to restore while no canvas is mounted', () => {
    const history = createAttachHistory()

    expect(history.beginAttach(0)).toBe(false)
    expect(history.beginAttach(0)).toBe(false)
  })
})

describe('replay coordinator drives the restore UI', () => {
  it('keeps the restore overlay up and the revival marker hidden until the snapshot renders', () => {
    let replayStatus: ReplayStatus = 'idle'
    const coordinator = reattach((status) => {
      replayStatus = status
    })
    const queue = createWriteQueue()
    // A reconnect carries the previous session's output on screen.
    const hasReceivedData = true

    coordinator.beginReplay()
    coordinator.render(queue.write, () => undefined)
    coordinator.endBackendReplay()

    expect(
      terminalLoadingMessage({ hasReceivedData, isRunning: true, replayStatus })
    ).toBe('Restoring terminal...')
    expect(showTerminalRevivalMarker({ replayStatus, wasRevived: true })).toBe(
      false
    )

    queue.parseNext()

    expect(
      terminalLoadingMessage({ hasReceivedData, isRunning: true, replayStatus })
    ).toBeUndefined()
    expect(showTerminalRevivalMarker({ replayStatus, wasRevived: true })).toBe(
      true
    )
  })

  it('hides a completed restore before the next attach replays over it', () => {
    let replayStatus: ReplayStatus = 'complete'

    // The reconnect creates the next attach's coordinator; the screen is still
    // showing the previous attach's restored output and marker.
    reattach((status) => {
      replayStatus = status
    })

    expect(replayStatus).toBe('replaying')
    expect(showTerminalRevivalMarker({ replayStatus, wasRevived: true })).toBe(
      false
    )
    expect(
      terminalLoadingMessage({
        hasReceivedData: true,
        isRunning: true,
        replayStatus,
      })
    ).toBe('Restoring terminal...')
  })

  it('covers a stopped terminal while its final screen is replayed', () => {
    let replayStatus: ReplayStatus = 'idle'
    const coordinator = reattach((status) => {
      replayStatus = status
    })
    const queue = createWriteQueue()
    const stopped = { hasReceivedData: true, isRunning: false }

    coordinator.beginReplay()
    coordinator.render(queue.write, () => undefined)
    expect(terminalLoadingMessage({ ...stopped, replayStatus })).toBe(
      'Restoring terminal...'
    )

    // The snapshot parses, but the backend has not finished replaying.
    queue.parseNext()
    expect(terminalLoadingMessage({ ...stopped, replayStatus })).toBe(
      'Restoring terminal...'
    )

    coordinator.endBackendReplay()
    expect(replayStatus).toBe('complete')
    expect(terminalLoadingMessage({ ...stopped, replayStatus })).toBeUndefined()
  })

  it('leaves a fresh mount on the startup message once its empty snapshot renders', () => {
    let replayStatus: ReplayStatus = 'idle'
    const coordinator = firstAttach((status) => {
      replayStatus = status
    })
    const queue = createWriteQueue()

    coordinator.beginReplay()
    coordinator.render(queue.write, () => undefined)

    // The snapshot is in flight: a fresh pane has nothing to restore, so it
    // must not claim to be restoring.
    expect(
      terminalLoadingMessage({
        hasReceivedData: false,
        isRunning: true,
        replayStatus,
      })
    ).toBe('Starting terminal...')

    queue.parseNext()
    coordinator.endBackendReplay()

    expect(replayStatus).toBe('complete')
    expect(
      terminalLoadingMessage({
        hasReceivedData: false,
        isRunning: true,
        replayStatus,
      })
    ).toBe('Starting terminal...')
    expect(showTerminalRevivalMarker({ replayStatus, wasRevived: false })).toBe(
      false
    )
  })
})
