/**
 * What the pane tells the operator while a terminal is being restored.
 *
 * Two facts decide it. `createAttachHistory` says whether this attach reopens a
 * screen the operator can already see, and the attach loop says how far the
 * daemon's replay has got. Together they choose between the startup message a
 * fresh pane shows, the restore overlay that covers stale output, and the
 * revival marker that labels history belonging to a process that was replaced.
 *
 * With a synchronous renderer there is no third fact: `ReplayComplete` arrives
 * only after every replayed frame has been parsed onto the screen, so nothing
 * has to wait for a render callback that no longer exists.
 *
 * @see apps/web/src/hooks/use-terminal-rpc.ts — createAttachHistory
 * @see apps/web/src/lib/terminal-attach-loop.ts — the replay status
 * @see apps/web/src/panes/terminal-loading-state.ts — the derivation under test
 */

import type { TerminalAttachEvent } from '@laborer/shared/rpc'
import { describe, expect, it } from 'vitest'

import { createAttachHistory } from '../src/hooks/use-terminal-rpc'
import {
  createTerminalAttachLoop,
  type TerminalReplayStatus,
} from '../src/lib/terminal-attach-loop'
import {
  showTerminalRevivalMarker,
  terminalLoadingMessage,
} from '../src/panes/terminal-loading-state'

/** An attach whose frames land on a screen that takes everything. */
const openAttach = (restoring: boolean) => {
  let replayStatus: TerminalReplayStatus = 'idle'
  const loop = createTerminalAttachLoop({
    effects: {
      ack: () => undefined,
      onCursor: () => undefined,
      onEpoch: () => undefined,
      onExit: () => undefined,
      onReplayStatus: (status) => {
        replayStatus = status
      },
      onRevival: () => undefined,
      onStatus: () => undefined,
    },
    restoring,
    target: { resetAndWrite: () => true, write: () => true },
  })
  return {
    handle: (event: TerminalAttachEvent) => loop.handle(event),
    status: () => replayStatus,
  }
}

const snapshot: TerminalAttachEvent = {
  _tag: 'Snapshot',
  cursor: 6,
  data: 'screen',
}
const replayComplete: TerminalAttachEvent = { _tag: 'ReplayComplete' }
const revivalReset: TerminalAttachEvent = {
  _tag: 'Reset',
  epoch: 'epoch-2',
  reason: 'epoch_changed',
}

describe('attach history', () => {
  it('treats a reconnect onto the same surface as a restore', () => {
    const history = createAttachHistory()

    expect(history.beginAttach(1)).toBe(false)
    expect(history.beginAttach(1)).toBe(true)
    expect(history.beginAttach(1)).toBe(true)
  })

  it('starts fresh when the surface is rebuilt', () => {
    const history = createAttachHistory()

    history.beginAttach(1)
    // A rebuilt surface is blank whatever the previous one had drawn — the pane
    // adopting another terminal, or React remounting it.
    expect(history.beginAttach(2)).toBe(false)
    expect(history.beginAttach(2)).toBe(true)
  })

  it('never claims to restore while no surface is mounted', () => {
    const history = createAttachHistory()

    // Ghostty's surface is built asynchronously, so every pane passes through
    // this state before it has a screen at all.
    expect(history.beginAttach(0)).toBe(false)
    expect(history.beginAttach(0)).toBe(false)
  })
})

describe('replay status drives the restore UI', () => {
  it('covers the previous screen and hides the marker until the replay lands', () => {
    const attach = openAttach(true)

    // The reattach announces its restore before the daemon has said anything,
    // so the previous attach's completed state cannot linger over stale output.
    expect(
      terminalLoadingMessage({ isRunning: true, replayStatus: attach.status() })
    ).toBe('Restoring terminal...')
    expect(
      showTerminalRevivalMarker({
        replayStatus: attach.status(),
        wasRevived: true,
      })
    ).toBe(false)

    attach.handle(snapshot)
    expect(
      terminalLoadingMessage({ isRunning: true, replayStatus: attach.status() })
    ).toBe('Restoring terminal...')

    attach.handle(replayComplete)
    expect(
      terminalLoadingMessage({ isRunning: true, replayStatus: attach.status() })
    ).toBeUndefined()
    expect(
      showTerminalRevivalMarker({
        replayStatus: attach.status(),
        wasRevived: true,
      })
    ).toBe(true)
  })

  it('covers a stopped terminal while its final screen is replayed', () => {
    const attach = openAttach(true)

    attach.handle(snapshot)
    expect(
      terminalLoadingMessage({
        isRunning: false,
        replayStatus: attach.status(),
      })
    ).toBe('Restoring terminal...')

    attach.handle(replayComplete)
    expect(
      terminalLoadingMessage({
        isRunning: false,
        replayStatus: attach.status(),
      })
    ).toBeUndefined()
  })

  it('shows startup for a fresh pane, never a restore it has nothing for', () => {
    const attach = openAttach(false)

    attach.handle(snapshot)
    expect(
      terminalLoadingMessage({ isRunning: true, replayStatus: attach.status() })
    ).toBe('Starting terminal...')

    // The daemon has replayed everything, and with a synchronous renderer that
    // means it is on screen: the overlay has nothing left to hide.
    attach.handle(replayComplete)
    expect(
      terminalLoadingMessage({ isRunning: true, replayStatus: attach.status() })
    ).toBeUndefined()
    expect(
      showTerminalRevivalMarker({
        replayStatus: attach.status(),
        wasRevived: false,
      })
    ).toBe(false)
  })

  it('reopens the restore overlay when a revival replaces a settled screen', () => {
    const attach = openAttach(false)

    attach.handle(snapshot)
    attach.handle(replayComplete)

    attach.handle(revivalReset)
    expect(
      terminalLoadingMessage({ isRunning: true, replayStatus: attach.status() })
    ).toBe('Restoring terminal...')
    // The marker would otherwise label output the daemon is about to replace.
    expect(
      showTerminalRevivalMarker({
        replayStatus: attach.status(),
        wasRevived: true,
      })
    ).toBe(false)

    attach.handle(snapshot)
    attach.handle(replayComplete)
    expect(
      showTerminalRevivalMarker({
        replayStatus: attach.status(),
        wasRevived: true,
      })
    ).toBe(true)
  })

  it('keeps live output after restoration out of the overlay', () => {
    const attach = openAttach(true)

    attach.handle(snapshot)
    attach.handle(replayComplete)
    attach.handle({ _tag: 'Delta', cursor: 12, data: 'live' })

    expect(
      terminalLoadingMessage({ isRunning: true, replayStatus: attach.status() })
    ).toBeUndefined()
  })
})
