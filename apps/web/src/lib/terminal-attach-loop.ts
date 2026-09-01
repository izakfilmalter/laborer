/**
 * The pane's attach loop: `terminal.attach` frames in, Ghostty surface calls,
 * flow-control acknowledgements and replay progress out.
 *
 * Ghostty parses synchronously. `surface.write()` has finished parsing by the
 * time it returns, so the queued/acknowledged split the previous xterm.js pane
 * maintained — one cursor for what the write queue had taken, another for what
 * the emulator had reported parsed — has no subject here: there is one cursor,
 * and it is both.
 * For the same reason replay is settled by the daemon's `ReplayComplete` alone;
 * there is no render still owed when that frame arrives.
 *
 * The loop is a plain object rather than a hook so the frame ordering can be
 * tested without a daemon, a canvas, or a WASM module. It owns no identity: the
 * cursor it publishes is a bare offset, and the hook that drives it is what
 * remembers which terminal and which screen that offset describes.
 *
 * @see apps/web/src/hooks/use-terminal-rpc.ts — runs this against the daemon
 * @see apps/web/src/lib/terminal-screen.ts — the surface it draws through
 */

import type { TerminalAttachEvent } from '@laborer/shared/rpc'

import { isTerminalRevival } from '@/components/terminal-revival-marker'

/**
 * Characters parsed before an acknowledgement is sent. The daemon pauses the
 * PTY at roughly 100k unacknowledged characters (ADR 0002), so a pane that
 * batched more loosely would stall its own terminal.
 */
export const TERMINAL_ACK_BATCH_CHARS = 5000

/** The slice of `GhosttyTerminalSurface` this loop drives, via the screen. */
export interface TerminalAttachTarget {
  /**
   * RIS the terminal, then replay `data`. This is how a `Snapshot` lands: the
   * payload is the serialized screen, so it describes the state to be *in*,
   * not output to append. Reports whether a surface took it.
   */
  readonly resetAndWrite: (data: string) => boolean
  /** Parse live output. Synchronous. Reports whether a surface took it. */
  readonly write: (data: string) => boolean
}

/**
 * `idle` is the fresh pane: replay is still open, but there is no earlier
 * screen to restore, so the pane keeps its own startup message instead of
 * claiming to restore output nobody has seen.
 */
export type TerminalReplayStatus = 'idle' | 'replaying' | 'complete'

/** What the loop reports outwards. Every callback runs synchronously. */
export interface TerminalAttachEffects {
  /** Release flow control up to `cursor`; the caller sends `terminal.ack`. */
  readonly ack: (cursor: number) => void
  /**
   * The cursor a reattach may resume from, or `undefined` when it must ask for
   * a fresh snapshot instead. Undefined between a `Reset` and the snapshot that
   * answers it: those offsets index an output generation this screen no longer
   * shows.
   */
  readonly onCursor: (cursor: number | undefined) => void
  /** The daemon's output generation, so a reattach can declare it. */
  readonly onEpoch: (epoch: string) => void
  readonly onExit: (exit: {
    readonly exitCode: number
    readonly signal: number
  }) => void
  readonly onReplayStatus: (status: TerminalReplayStatus) => void
  /** A `Reset` whose reason means the process itself was replaced. */
  readonly onRevival: () => void
  readonly onStatus: (status: 'running' | 'stopped') => void
}

export interface TerminalAttachLoop {
  readonly handle: (event: TerminalAttachEvent) => void
  readonly replayStatus: () => TerminalReplayStatus
}

export interface TerminalAttachLoopOptions {
  readonly ackBatchChars?: number
  readonly effects: TerminalAttachEffects
  /**
   * Whether this attach reopens a screen the operator has already seen. A
   * reattach must report `replaying` before its first frame lands: otherwise
   * the previous attach's `complete` — and the revival marker it justifies —
   * keeps describing output the daemon is about to replace.
   */
  readonly restoring: boolean
  /** The cursor carried over from the attach this one replaces. */
  readonly resume?: { readonly cursor?: number | undefined }
  readonly target: TerminalAttachTarget
}

export const createTerminalAttachLoop = ({
  ackBatchChars = TERMINAL_ACK_BATCH_CHARS,
  effects,
  restoring: initiallyRestoring,
  resume,
  target,
}: TerminalAttachLoopOptions): TerminalAttachLoop => {
  let cursor: number | undefined = resume?.cursor
  let unackedChars = 0
  let ackedCursor: number | undefined
  let restoring = initiallyRestoring
  let replayComplete = false

  const replayStatus = (): TerminalReplayStatus => {
    if (replayComplete) {
      return 'complete'
    }
    return restoring ? 'replaying' : 'idle'
  }

  /**
   * A `Reset` or `Snapshot` reopens replay. Reopening a *settled* replay means
   * the screen the operator is looking at has just gone stale, so from here on
   * this attach is restoring rather than starting.
   */
  const beginReplay = (): void => {
    restoring = restoring || replayComplete
    replayComplete = false
    effects.onReplayStatus(replayStatus())
  }

  const setCursor = (next: number | undefined): void => {
    cursor = next
    effects.onCursor(next)
  }

  /**
   * Acknowledge what has been parsed. `force` is for `ReplayComplete`, which
   * ends a burst that may sit below the batch threshold: without it a replay
   * that fits in one batch would leave the daemon holding the debt for it until
   * live output happened to push the counter over.
   */
  const flushAck = (force: boolean): void => {
    if (cursor === undefined) {
      return
    }
    if (!force && unackedChars < ackBatchChars) {
      return
    }
    // A forced flush can land with nothing new parsed since the last one. The
    // daemon would accept the repeat, but sending it says something happened.
    if (unackedChars === 0 && ackedCursor === cursor) {
      return
    }
    unackedChars = 0
    ackedCursor = cursor
    effects.ack(cursor)
  }

  const handle = (event: TerminalAttachEvent): void => {
    switch (event._tag) {
      case 'Snapshot': {
        beginReplay()
        // A snapshot replaces the screen, so it also replaces whatever the
        // previous cursor described — including when no surface takes it, in
        // which case nothing was drawn and there is nothing to resume from.
        ackedCursor = undefined
        unackedChars = 0
        if (!target.resetAndWrite(event.data)) {
          setCursor(undefined)
          return
        }
        setCursor(event.cursor)
        unackedChars = event.data.length
        flushAck(false)
        return
      }
      case 'Delta': {
        // Ghostty has already parsed everything up to `cursor`, so anything at
        // or below it is a repeat the daemon sent to cover a resume.
        if (cursor !== undefined && event.cursor <= cursor) {
          return
        }
        if (!target.write(event.data)) {
          return
        }
        setCursor(event.cursor)
        unackedChars += event.data.length
        flushAck(false)
        return
      }
      case 'Meta':
        effects.onEpoch(event.epoch)
        effects.onStatus(event.status)
        return
      case 'ReplayComplete':
        replayComplete = true
        effects.onReplayStatus(replayStatus())
        flushAck(true)
        return
      case 'Reset':
        // The daemon restarted this terminal's output. Clear the screen and
        // drop the cursor: the snapshot that follows re-establishes both, and
        // acknowledging an old cursor against the new generation would release
        // flow control for output that no longer exists.
        effects.onEpoch(event.epoch)
        setCursor(undefined)
        ackedCursor = undefined
        unackedChars = 0
        // The surface has no bare reset; replaying an empty snapshot is the
        // RIS, and `resetAndWrite('')` returns once it has been performed.
        target.resetAndWrite('')
        if (isTerminalRevival(event.reason)) {
          effects.onRevival()
        }
        beginReplay()
        return
      case 'Exit':
        effects.onExit({ exitCode: event.exitCode, signal: event.signal })
        return
      default:
        event satisfies never
        return
    }
  }

  // Publish the opening status rather than waiting for the daemon to speak.
  effects.onReplayStatus(replayStatus())

  return { handle, replayStatus }
}
