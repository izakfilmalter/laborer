/**
 * What a pane may carry from one attach into the next.
 *
 * Three things can change underneath a terminal pane, and only one of them
 * leaves the screen intact:
 *
 * - the daemon connection drops and returns, with the same canvas still on
 *   screen — the pane resumes from the cursor it has drawn to, and the daemon
 *   sends only what it missed;
 * - React rebuilds the canvas (StrictMode's double invoke, a remount) — the
 *   new canvas is blank, so resuming would leave the operator with deltas and
 *   no history underneath them;
 * - the pane is handed a different terminal — the cursor indexes another
 *   journal, the epoch would read as a revival, and the status, replay and
 *   revival state all describe a screen the pane no longer shows.
 *
 * These tests drive the hook against a scripted daemon and a real screen, so
 * they fail on the wire payload and the reported state rather than on a helper
 * in isolation.
 *
 * @see apps/web/src/hooks/use-terminal-rpc.ts
 * @see apps/web/src/lib/terminal-screen.ts
 */

import type { TerminalAttachEvent } from '@laborer/shared/rpc'
import { act, cleanup, renderHook } from '@testing-library/react'
import { Context, Effect, Stream } from 'effect'
import { useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { runtimeResultRef, useAtomMountMock } = vi.hoisted(() => ({
  runtimeResultRef: { current: undefined as unknown },
  useAtomMountMock: vi.fn(),
}))

vi.mock('@effect/atom-react/Hooks', () => ({
  useAtomMount: useAtomMountMock,
  useAtomValue: () => runtimeResultRef.current,
}))

vi.mock('@/atoms/terminal-service-client', async () => {
  const { Context: EffectContext } = await import('effect')
  return {
    TerminalServiceClient: EffectContext.Service<
      { readonly TerminalServiceClient: unknown },
      unknown
    >('test/TerminalServiceClient'),
  }
})

import { TerminalServiceClient } from '@/atoms/terminal-service-client'
import {
  declarableEpoch,
  resumableCursor,
  useTerminalRpc,
} from '@/hooks/use-terminal-rpc'
import {
  createTerminalScreen,
  type TerminalScreen,
  type TerminalScreenCanvas,
} from '@/lib/terminal-screen'

interface AttachPayload {
  readonly cursor?: number
  readonly epoch?: string
  readonly id: string
  readonly leaseId: string
}

interface AckPayload {
  readonly cursor: number
  readonly id: string
}

/** A pushable event source shaped like the daemon's attach stream. */
const createFeed = () => {
  const pending: TerminalAttachEvent[] = []
  let wake: (() => void) | undefined
  let closed = false

  const iterable: AsyncIterable<TerminalAttachEvent> = {
    async *[Symbol.asyncIterator]() {
      while (!closed) {
        const next = pending.shift()
        if (next !== undefined) {
          yield next
          continue
        }
        await new Promise<void>((resolve) => {
          wake = resolve
        })
      }
    },
  }

  return {
    close: () => {
      closed = true
      wake?.()
      wake = undefined
    },
    iterable,
    push: (event: TerminalAttachEvent) => {
      pending.push(event)
      wake?.()
      wake = undefined
    },
  }
}

interface AttachSession {
  readonly feed: ReturnType<typeof createFeed>
  readonly payload: AttachPayload
}

/** A daemon that records what each attach asked for and replies on demand. */
const createDaemon = () => {
  const acks: AckPayload[] = []
  const attaches: AttachSession[] = []

  const client = (tag: string, payload: unknown) => {
    if (tag === 'terminal.attach') {
      const feed = createFeed()
      attaches.push({ feed, payload: payload as AttachPayload })
      return Stream.fromAsyncIterable(
        feed.iterable,
        (error) => new Error(String(error))
      )
    }
    if (tag === 'terminal.ack') {
      acks.push(payload as AckPayload)
    }
    return Effect.void
  }

  return {
    acks,
    attaches,
    /** The attach the pane is currently listening to. */
    current: (): AttachSession => {
      const session = attaches.at(-1)
      if (!session) {
        throw new Error('No attach was opened')
      }
      return session
    },
    /** A distinct runtime value stands in for a reconnected transport. */
    connect: () => {
      runtimeResultRef.current = {
        _tag: 'Success',
        value: Context.makeUnsafe(
          new Map([[TerminalServiceClient.key, client]])
        ),
      }
    },
  }
}

/** A canvas that records what was drawn and parses when the test says so. */
const createCanvas = () => {
  const drawn: string[] = []
  const parsers: Array<() => void> = []
  const canvas: TerminalScreenCanvas = {
    reset: () => {
      drawn.length = 0
    },
    write: (data, commit) => {
      drawn.push(data)
      parsers.push(commit)
    },
  }
  return {
    canvas,
    drawn,
    parseAll: () => {
      for (const parse of parsers.splice(0)) {
        parse()
      }
    },
  }
}

/** Let the attach fiber run and React settle around it. */
const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })
  })
}

const REPLAYED: readonly TerminalAttachEvent[] = [
  { _tag: 'Snapshot', cursor: 120, data: 'restored screen' },
  { _tag: 'Meta', epoch: 'epoch-1', status: 'running' },
  { _tag: 'ReplayComplete' },
]

/**
 * The hook clears its per-terminal state as the new id arrives, but the
 * outgoing attach is only interrupted afterwards. Naming the terminal inside
 * the fact keeps a frame landing in that window from re-establishing a resume
 * point behind the reset, rather than leaving the two orderings to agree.
 */
describe('what a resume point describes', () => {
  const drawn = { cursor: 120, generation: 3, terminalId: 'term-1' }

  it('resumes only the canvas and terminal it was drawn for', () => {
    expect(
      resumableCursor(drawn, { generation: 3, terminalId: 'term-1' })
    ).toBe(120)
    expect(
      resumableCursor(drawn, { generation: 4, terminalId: 'term-1' })
    ).toBeUndefined()
    expect(
      resumableCursor(drawn, { generation: 3, terminalId: 'term-2' })
    ).toBeUndefined()
  })

  it('has nothing to resume before anything is drawn', () => {
    expect(
      resumableCursor(undefined, { generation: 3, terminalId: 'term-1' })
    ).toBeUndefined()
    // Generation 0 is "no canvas mounted": there is no screen to continue.
    expect(
      resumableCursor(
        { cursor: 120, generation: 0, terminalId: 'term-1' },
        { generation: 0, terminalId: 'term-1' }
      )
    ).toBeUndefined()
  })

  it('declares an epoch only to the terminal that announced it', () => {
    const known = { epoch: 'epoch-1', terminalId: 'term-1' }

    expect(declarableEpoch(known, 'term-1')).toBe('epoch-1')
    // Another terminal's epoch would read as a revision of this one and raise
    // the revival marker over output nothing touched.
    expect(declarableEpoch(known, 'term-2')).toBeUndefined()
    expect(declarableEpoch(undefined, 'term-1')).toBeUndefined()
  })
})

describe('terminal attach identity', () => {
  afterEach(() => {
    cleanup()
    runtimeResultRef.current = undefined
  })

  /** Bring a pane to the state it holds after a first successful replay. */
  const openPane = async (terminalId = 'term-1') => {
    const daemon = createDaemon()
    const screen = createTerminalScreen()
    const canvas = createCanvas()
    screen.mount(canvas.canvas)
    daemon.connect()

    const view = renderHook(
      (props: { readonly terminalId: string }) =>
        useTerminalRpc({ screen, terminalId: props.terminalId }),
      { initialProps: { terminalId } }
    )
    await settle()

    for (const event of REPLAYED) {
      daemon.current().feed.push(event)
    }
    await settle()
    act(() => {
      canvas.parseAll()
    })
    await settle()

    return { canvas, daemon, screen, view }
  }

  it('resumes from the drawn cursor when the daemon reconnects under the same canvas', async () => {
    const { daemon, view } = await openPane()

    expect(daemon.attaches).toHaveLength(1)
    expect(daemon.attaches[0]?.payload.cursor).toBeUndefined()
    expect(view.result.current.replayStatus).toBe('complete')

    // The transport is replaced while the canvas stays exactly as drawn.
    daemon.connect()
    view.rerender({ terminalId: 'term-1' })
    await settle()

    expect(daemon.attaches).toHaveLength(2)
    expect(daemon.attaches[1]?.payload).toMatchObject({
      cursor: 120,
      epoch: 'epoch-1',
      id: 'term-1',
    })
    // The screen is populated, so the reconnect is a restore from the outset.
    expect(view.result.current.replayStatus).toBe('replaying')
  })

  it('resumes from output the canvas has taken, not from what xterm has parsed', async () => {
    const { canvas, daemon, view } = await openPane()

    // Live output handed to xterm and still sitting in its write queue: the
    // canvas has taken it, but no write callback has arrived for it yet.
    daemon.current().feed.push({ _tag: 'Delta', cursor: 200, data: 'queued' })
    await settle()

    expect(canvas.drawn).toEqual(['restored screen', 'queued'])
    expect(daemon.acks.some((ack) => ack.cursor === 200)).toBe(false)

    // The transport drops and returns with the delta still unparsed.
    daemon.connect()
    view.rerender({ terminalId: 'term-1' })
    await settle()

    expect(daemon.attaches).toHaveLength(2)
    // Asking from the parsed cursor would have the daemon send `queued` again.
    expect(daemon.attaches[1]?.payload.cursor).toBe(200)

    // A daemon that replays it anyway must not put it on screen twice.
    daemon.current().feed.push({ _tag: 'Delta', cursor: 200, data: 'queued' })
    daemon.current().feed.push({ _tag: 'Delta', cursor: 260, data: 'fresh' })
    await settle()

    expect(canvas.drawn).toEqual(['restored screen', 'queued', 'fresh'])

    // The queued chunk is still acknowledged exactly once, when xterm parses
    // it: flow control follows the renderer, not the write queue.
    act(() => {
      canvas.parseAll()
    })
    await settle()
    daemon.current().feed.push({ _tag: 'ReplayComplete' })
    await settle()

    expect(daemon.acks.filter((ack) => ack.cursor === 260)).toHaveLength(1)
  })

  it('asks for a snapshot when the canvas is rebuilt under a live attach', async () => {
    const { daemon, screen, canvas } = await openPane()
    const rebuilt = createCanvas()

    await act(async () => {
      screen.unmount(canvas.canvas)
      screen.mount(rebuilt.canvas)
      await Promise.resolve()
    })
    await settle()

    expect(daemon.attaches).toHaveLength(2)
    // A blank canvas cannot be continued from a cursor it never drew.
    expect(daemon.attaches[1]?.payload.cursor).toBeUndefined()
    // The epoch survives: the process did not change, only the canvas did.
    expect(daemon.attaches[1]?.payload.epoch).toBe('epoch-1')
  })

  it('draws the replacement snapshot onto the rebuilt canvas alone', async () => {
    const { daemon, screen, canvas } = await openPane()
    const rebuilt = createCanvas()

    await act(async () => {
      screen.unmount(canvas.canvas)
      screen.mount(rebuilt.canvas)
      await Promise.resolve()
    })
    await settle()

    canvas.drawn.length = 0
    daemon
      .current()
      .feed.push({ _tag: 'Snapshot', cursor: 120, data: 'restored screen' })
    await settle()

    expect(rebuilt.drawn).toEqual(['restored screen'])
    expect(canvas.drawn).toEqual([])
  })

  it('carries nothing from the terminal a pane stops showing', async () => {
    const { daemon, view } = await openPane()

    // The pane's own terminal is revived and then exits, so every piece of
    // per-terminal state is set before it is handed a different one.
    daemon.current().feed.push({
      _tag: 'Reset',
      epoch: 'epoch-2',
      reason: 'epoch_changed',
    })
    daemon.current().feed.push({ _tag: 'Exit', exitCode: 0, signal: 0 })
    await settle()

    expect(view.result.current.wasRevived).toBe(true)
    expect(view.result.current.terminalStatus).toBe('stopped')

    view.rerender({ terminalId: 'term-2' })
    await settle()

    expect(daemon.attaches).toHaveLength(2)
    expect(daemon.attaches[1]?.payload.id).toBe('term-2')
    expect(daemon.attaches[1]?.payload.cursor).toBeUndefined()
    expect(daemon.attaches[1]?.payload.epoch).toBeUndefined()
    expect(view.result.current.terminalStatus).toBe('running')
    expect(view.result.current.wasRevived).toBe(false)
    expect(view.result.current.replayStatus).toBe('idle')
    expect(daemon.acks.every((ack) => ack.id === 'term-1')).toBe(true)
  })

  it('never lets the outgoing terminal acknowledge its way into the next attach', async () => {
    const { canvas, daemon, view } = await openPane()

    // Live output for the old terminal is still in xterm's write queue when
    // the pane is handed a new one.
    daemon.current().feed.push({ _tag: 'Delta', cursor: 260, data: 'late' })
    await settle()

    view.rerender({ terminalId: 'term-2' })
    await settle()
    act(() => {
      canvas.parseAll()
    })
    await settle()

    daemon.connect()
    view.rerender({ terminalId: 'term-2' })
    await settle()

    expect(daemon.attaches).toHaveLength(3)
    expect(daemon.attaches[2]?.payload).toMatchObject({ id: 'term-2' })
    expect(daemon.attaches[2]?.payload.cursor).toBeUndefined()
    expect(daemon.acks.some((ack) => ack.cursor === 260)).toBe(false)
  })
})

type TerminalStatus = 'running' | 'stopped' | 'restarted'

interface PaneState {
  current: ReturnType<typeof useTerminalRpc> | undefined
}

/**
 * A pane that hands the test the moment React has committed a terminal and
 * has yet to run the effect cleanup that interrupts the previous one.
 *
 * The hook's own layout effect is registered first, so by the time `onCommit`
 * runs the pane has taken on the new terminal — but the outgoing attach is
 * still open, still streaming and still able to report.
 */
function Pane({
  onCommit,
  onStatus,
  screen,
  state,
  terminalId,
}: {
  readonly onCommit?: (() => void) | undefined
  readonly onStatus?:
    | ((status: TerminalStatus, exitCode?: number) => void)
    | undefined
  readonly screen: TerminalScreen
  readonly state: PaneState
  readonly terminalId: string
}) {
  state.current = useTerminalRpc({ onStatus, screen, terminalId })
  useLayoutEffect(() => {
    onCommit?.()
  })
  return null
}

/** Let React's scheduler, the attach fiber and the microtask queue all run. */
const flushTasks = async () => {
  for (let turn = 0; turn < 8; turn += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })
  }
}

/**
 * The pane adopts a terminal one render before the previous attach is torn
 * down. Everything the outgoing attach can still do in that window — deliver a
 * frame, report an exit, announce a revival, acknowledge a parse — describes a
 * terminal the pane has stopped showing.
 *
 * `act` would flush the commit and the passive cleanup together and close the
 * window by accident, so this drives a real root and lets React schedule its
 * own work.
 */
describe('the window between adopting a terminal and dropping the last one', () => {
  it('ignores what the outgoing attach reports after the pane has moved on', async () => {
    const daemon = createDaemon()
    const screen = createTerminalScreen()
    const canvas = createCanvas()
    const state: PaneState = { current: undefined }
    const reported: TerminalStatus[] = []
    const onStatus = (status: TerminalStatus) => {
      reported.push(status)
    }
    screen.mount(canvas.canvas)
    daemon.connect()

    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const actEnvironment = Reflect.get(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', false)

    try {
      root.render(
        <Pane
          onStatus={onStatus}
          screen={screen}
          state={state}
          terminalId="term-1"
        />
      )
      await flushTasks()
      for (const event of REPLAYED) {
        daemon.current().feed.push(event)
      }
      await flushTasks()
      canvas.parseAll()
      await flushTasks()

      expect(state.current?.terminalStatus).toBe('running')
      expect(reported).toEqual(['running'])

      // Output for term-1 large enough to be acknowledged on its own, still
      // unparsed when the pane is handed a different terminal.
      const outgoing = daemon.current().feed
      outgoing.push({ _tag: 'Delta', cursor: 200, data: 'x'.repeat(6000) })
      await flushTasks()

      root.render(
        <Pane
          onCommit={() => {
            outgoing.push({ _tag: 'Exit', exitCode: 1, signal: 0 })
            outgoing.push({
              _tag: 'Reset',
              epoch: 'epoch-9',
              reason: 'epoch_changed',
            })
            outgoing.push({ _tag: 'Delta', cursor: 260, data: 'late output' })
            outgoing.push({ _tag: 'Meta', epoch: 'epoch-9', status: 'stopped' })
            // xterm reports term-1's queued output parsed in the same window.
            canvas.parseAll()
          }}
          onStatus={onStatus}
          screen={screen}
          state={state}
          terminalId="term-2"
        />
      )
      await flushTasks()

      // None of it describes term-2, so none of it may reach the pane.
      expect(state.current?.terminalStatus).toBe('running')
      expect(state.current?.wasRevived).toBe(false)
      expect(reported).toEqual(['running'])
      expect(canvas.drawn).not.toContain('late output')
      expect(daemon.acks.some((ack) => ack.cursor === 200)).toBe(false)

      // And the attach that replaces it starts from nothing the old terminal
      // established.
      expect(daemon.attaches).toHaveLength(2)
      expect(daemon.attaches[1]?.payload.id).toBe('term-2')
      expect(daemon.attaches[1]?.payload.cursor).toBeUndefined()
      expect(daemon.attaches[1]?.payload.epoch).toBeUndefined()
    } finally {
      root.unmount()
      container.remove()
      Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', actEnvironment)
    }
  })
})
