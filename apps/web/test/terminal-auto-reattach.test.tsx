/**
 * What a pane owes the operator after its attach stream drops.
 *
 * A terminal pane's attach stream fails for reasons that say nothing about the
 * terminal: the daemon's per-attach queue overflows under load, a request to
 * the pty host times out, the transport errors. The pane raises a banner that
 * says it is reconnecting, so it has to actually reconnect — with a backoff,
 * because those failures mean the daemon is already shedding load.
 *
 * These tests drive the hook against a scripted daemon that can fail its
 * stream and its writes, so they fail on what the pane does next rather than
 * on a retry helper in isolation.
 *
 * @see apps/web/src/hooks/use-terminal-rpc.ts
 * @see apps/web/src/panes/terminal-pane.tsx
 */

import type { TerminalAttachEvent } from '@laborer/shared/rpc'
import { act, cleanup, renderHook } from '@testing-library/react'
import { Context, Effect, Stream } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  TERMINAL_REATTACH_DELAYS_MS,
  useTerminalRpc,
} from '@/hooks/use-terminal-rpc'
import {
  createTerminalScreen,
  type TerminalScreenCanvas,
} from '@/lib/terminal-screen'

interface AttachPayload {
  readonly cursor?: number
  readonly epoch?: string
  readonly id: string
  readonly leaseId: string
}

/** A pushable event source that can also break the way an attach stream does. */
const createFeed = () => {
  const pending: TerminalAttachEvent[] = []
  let wake: (() => void) | undefined
  let closed = false
  let failure: Error | undefined

  const iterable: AsyncIterable<TerminalAttachEvent> = {
    async *[Symbol.asyncIterator]() {
      while (!closed) {
        if (failure !== undefined) {
          throw failure
        }
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
    /** Break the stream the way an overflow or a timed-out request does. */
    fail: (reason: string) => {
      failure = new Error(reason)
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

/** A daemon whose attach stream and writes can both be made to fail. */
const createDaemon = () => {
  const attaches: AttachSession[] = []
  const writes: string[] = []
  let writeFailure: string | undefined

  const client = (tag: string, payload: unknown) => {
    if (tag === 'terminal.attach') {
      const feed = createFeed()
      attaches.push({ feed, payload: payload as AttachPayload })
      return Stream.fromAsyncIterable(
        feed.iterable,
        (error) => new Error(String(error))
      )
    }
    if (tag === 'terminal.write') {
      writes.push((payload as { readonly data: string }).data)
      if (writeFailure !== undefined) {
        return Effect.fail(new Error(writeFailure))
      }
    }
    return Effect.void
  }

  return {
    attaches,
    connect: () => {
      runtimeResultRef.current = {
        _tag: 'Success',
        value: Context.makeUnsafe(
          new Map([[TerminalServiceClient.key, client]])
        ),
      }
    },
    /** The attach the pane is currently listening to. */
    current: (): AttachSession => {
      const session = attaches.at(-1)
      if (!session) {
        throw new Error('No attach was opened')
      }
      return session
    },
    failWrites: (reason: string | undefined) => {
      writeFailure = reason
    },
    writes,
  }
}

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

/**
 * Let the attach fiber and React settle without moving the clock, so a pending
 * backoff can only fire where a test asks for it.
 */
const settle = async () => {
  await act(async () => {
    for (let turn = 0; turn < 6; turn += 1) {
      await vi.advanceTimersByTimeAsync(0)
    }
  })
}

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
  await settle()
}

const RUNNING: TerminalAttachEvent = {
  _tag: 'Meta',
  epoch: 'epoch-1',
  status: 'running',
}

describe('a pane whose attach stream drops', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    runtimeResultRef.current = undefined
  })

  /** A pane attached to a live terminal, with its first frames on screen. */
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

    return { canvas, daemon, screen, view }
  }

  it('reopens the stream after a failure and reports connected again', async () => {
    const { canvas, daemon, view } = await openPane()

    daemon.current().feed.push({
      _tag: 'Snapshot',
      cursor: 120,
      data: 'restored screen',
    })
    daemon.current().feed.push(RUNNING)
    await settle()
    act(() => {
      canvas.parseAll()
    })
    await settle()

    expect(view.result.current.status).toBe('connected')

    // The daemon sheds this attach the way it does under load.
    daemon.current().feed.fail('TERMINAL_ATTACH_OVERFLOW')
    await settle()

    expect(view.result.current.status).toBe('disconnected')
    expect(daemon.attaches).toHaveLength(1)

    await advance(TERMINAL_REATTACH_DELAYS_MS[0])

    expect(daemon.attaches).toHaveLength(2)
    // The reattach resumes what this canvas has drawn rather than replaying it.
    expect(daemon.attaches[1]?.payload).toMatchObject({
      cursor: 120,
      epoch: 'epoch-1',
      id: 'term-1',
    })

    daemon.current().feed.push(RUNNING)
    await settle()

    expect(view.result.current.status).toBe('connected')
  })

  it('escalates the backoff while failures continue and starts over once a stream delivers', async () => {
    const { daemon, view } = await openPane()

    // Each attach fails before saying anything, so the delays escalate.
    for (const [index, delay] of TERMINAL_REATTACH_DELAYS_MS.entries()) {
      daemon.current().feed.fail('TERMINAL_ATTACH_OVERFLOW')
      await settle()

      expect(view.result.current.status).toBe('disconnected')
      expect(daemon.attaches).toHaveLength(index + 1)

      await advance(delay - 1)
      expect(daemon.attaches).toHaveLength(index + 1)

      await advance(1)
      expect(daemon.attaches).toHaveLength(index + 2)
    }

    // A stream that delivers anything proves the daemon is reachable, so the
    // next failure is a fresh incident rather than the tail of this one.
    daemon.current().feed.push(RUNNING)
    await settle()
    expect(view.result.current.status).toBe('connected')

    const attachesBefore = daemon.attaches.length
    daemon.current().feed.fail('rpc transport closed')
    await settle()

    await advance(TERMINAL_REATTACH_DELAYS_MS[0])
    expect(daemon.attaches).toHaveLength(attachesBefore + 1)
  })

  it('retires a pending reattach when the pane goes away', async () => {
    const { daemon, view } = await openPane()

    daemon.current().feed.fail('TERMINAL_ATTACH_OVERFLOW')
    await settle()
    expect(daemon.attaches).toHaveLength(1)
    // A retry really is scheduled, so the assertion below is about cleanup
    // rather than about nothing having been armed.
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    view.unmount()
    await advance(60_000)

    expect(daemon.attaches).toHaveLength(1)
  })

  it('retires a pending reattach when the pane is handed another terminal', async () => {
    const { daemon, view } = await openPane()

    daemon.current().feed.fail('TERMINAL_ATTACH_OVERFLOW')
    await settle()
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    view.rerender({ terminalId: 'term-2' })
    await settle()

    expect(daemon.attaches).toHaveLength(2)
    expect(daemon.attaches[1]?.payload.id).toBe('term-2')

    // The scheduled retry belonged to term-1; nothing may reopen it.
    await advance(60_000)

    expect(daemon.attaches).toHaveLength(2)
  })

  it('drops queued input after a failed write and resyncs the pane', async () => {
    const { daemon, view } = await openPane()

    daemon.current().feed.push(RUNNING)
    await settle()
    expect(view.result.current.status).toBe('connected')

    const errors = vi.spyOn(console, 'error').mockImplementation(() => {
      // The failure is asserted, not printed.
    })
    daemon.failWrites('terminal.write timed out')

    await act(async () => {
      view.result.current.send('a')
      view.result.current.send('b')
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()

    // A failed write has ambiguous delivery, so the keystrokes behind it are
    // dropped rather than replayed into an unknown prompt.
    expect(daemon.writes).toEqual(['a'])
    // But the pane resyncs at once instead of holding the banner forever.
    expect(daemon.attaches).toHaveLength(2)

    daemon.current().feed.push(RUNNING)
    await settle()

    expect(view.result.current.status).toBe('connected')
    errors.mockRestore()
  })

  it('resyncs after refusing oversized input rather than sitting disconnected', async () => {
    const { daemon, view } = await openPane()

    daemon.current().feed.push(RUNNING)
    await settle()

    const errors = vi.spyOn(console, 'error').mockImplementation(() => {
      // The overflow report is asserted, not printed.
    })

    await act(async () => {
      view.result.current.send('x'.repeat(128 * 1024))
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()

    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining('Terminal input overflow')
    )
    expect(daemon.writes).toEqual([])
    expect(daemon.attaches).toHaveLength(2)

    daemon.current().feed.push(RUNNING)
    await settle()

    expect(view.result.current.status).toBe('connected')
    errors.mockRestore()
  })
})
