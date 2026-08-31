import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  RENDERER_RECONNECT_DELAYS_MS,
  RendererConnectionBlockedError,
  type RendererConnectionLease,
  RendererConnectionSupervisor,
} from '../src/atoms/renderer-connection'

const deferredLease = () => {
  let close!: () => void
  const closed = new Promise<void>((resolve) => {
    close = resolve
  })
  return { closed, close } satisfies RendererConnectionLease
}

const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

describe('RendererConnectionSupervisor', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('owns the named 3/4/8/16 second unbounded retry ladder', async () => {
    const connect = vi.fn(() => Promise.reject(new Error('offline')))
    const supervisor = new RendererConnectionSupervisor(connect, () =>
      Date.now()
    )
    supervisor.start()
    await flush()

    for (const [index, delay] of RENDERER_RECONNECT_DELAYS_MS.entries()) {
      expect(supervisor.getSnapshot()).toMatchObject({
        attempt: index + 1,
        phase: 'backoff',
      })
      await vi.advanceTimersByTimeAsync(delay)
      await flush()
    }

    expect(connect).toHaveBeenCalledTimes(5)
    expect(supervisor.getSnapshot()).toMatchObject({
      attempt: 5,
      phase: 'backoff',
    })
    await vi.advanceTimersByTimeAsync(16_000)
    expect(connect).toHaveBeenCalledTimes(6)
    supervisor.stop()
  })

  it('keeps the initial runtime and advances generation on reconnect', async () => {
    const first = deferredLease()
    const second = deferredLease()
    const connect = vi
      .fn<() => Promise<RendererConnectionLease>>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
    const supervisor = new RendererConnectionSupervisor(connect, () =>
      Date.now()
    )
    supervisor.start()
    await flush()
    expect(supervisor.getSnapshot()).toMatchObject({
      generation: 0,
      phase: 'connected',
      session: 1,
    })

    first.close()
    await flush()
    expect(supervisor.getSnapshot()).toMatchObject({
      phase: 'backoff',
      session: null,
    })
    await vi.advanceTimersByTimeAsync(3000)
    await flush()
    expect(supervisor.getSnapshot()).toMatchObject({
      generation: 1,
      phase: 'connected',
      session: 2,
    })
    supervisor.stop()
  })

  it('advances generation when the initial connection succeeds after automatic retry', async () => {
    const first = deferredLease()
    const second = deferredLease()
    const connect = vi
      .fn<() => Promise<RendererConnectionLease>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
    const supervisor = new RendererConnectionSupervisor(connect, () =>
      Date.now()
    )
    supervisor.start()
    await flush()

    expect(supervisor.getSnapshot().phase).toBe('backoff')
    await vi.advanceTimersByTimeAsync(3000)
    await flush()

    expect(supervisor.getSnapshot()).toMatchObject({
      generation: 1,
      phase: 'connected',
      session: 1,
    })

    first.close()
    await flush()
    await vi.advanceTimersByTimeAsync(4000)
    await flush()
    expect(supervisor.getSnapshot()).toMatchObject({
      generation: 2,
      phase: 'connected',
      session: 2,
    })
    supervisor.stop()
  })

  it('advances generation when manual retry recovers the initial connection', async () => {
    const lease = deferredLease()
    const connect = vi
      .fn<() => Promise<RendererConnectionLease>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(lease)
    const supervisor = new RendererConnectionSupervisor(connect, () =>
      Date.now()
    )
    supervisor.start()
    await flush()
    expect(supervisor.getSnapshot().phase).toBe('backoff')

    supervisor.retryNow()
    await flush()
    expect(connect).toHaveBeenCalledTimes(2)
    expect(supervisor.getSnapshot()).toMatchObject({
      attempt: 1,
      generation: 1,
      phase: 'connected',
      session: 1,
    })
    supervisor.stop()
  })

  it('recycles the connection when a transport reports its own death', async () => {
    const first = deferredLease()
    const second = deferredLease()
    const closeFirst = vi.fn(first.close)
    const connect = vi
      .fn<() => Promise<RendererConnectionLease>>()
      .mockResolvedValueOnce({ closed: first.closed, close: closeFirst })
      .mockResolvedValueOnce(second)
    const supervisor = new RendererConnectionSupervisor(connect, () =>
      Date.now()
    )
    supervisor.start()
    await flush()
    expect(supervisor.getSnapshot()).toMatchObject({
      generation: 0,
      phase: 'connected',
      session: 1,
    })

    supervisor.notifyTransportFailure()
    await flush()

    expect(closeFirst).toHaveBeenCalledTimes(1)
    // A dead transport is a lost connection, not a manual retry: it waits out
    // the backoff ladder rather than reconnecting immediately.
    expect(supervisor.getSnapshot()).toMatchObject({
      phase: 'backoff',
      session: null,
    })
    expect(connect).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(RENDERER_RECONNECT_DELAYS_MS[0])
    await flush()
    expect(connect).toHaveBeenCalledTimes(2)
    expect(supervisor.getSnapshot()).toMatchObject({
      generation: 1,
      phase: 'connected',
      session: 2,
    })
    supervisor.stop()
  })

  it('ignores repeated transport failure reports for one lease', async () => {
    const first = deferredLease()
    const closeFirst = vi.fn(first.close)
    const connect = vi
      .fn<() => Promise<RendererConnectionLease>>()
      .mockResolvedValueOnce({ closed: first.closed, close: closeFirst })
      .mockResolvedValue(deferredLease())
    const supervisor = new RendererConnectionSupervisor(connect, () =>
      Date.now()
    )
    supervisor.start()
    await flush()

    supervisor.notifyTransportFailure()
    supervisor.notifyTransportFailure()
    await flush()
    // Reported again while the supervisor is already backing off, as a stale
    // protocol layer does while it is torn down.
    supervisor.notifyTransportFailure()
    await flush()

    expect(closeFirst).toHaveBeenCalledTimes(1)
    expect(supervisor.getSnapshot()).toMatchObject({ phase: 'backoff' })
    expect(connect).toHaveBeenCalledTimes(1)
    supervisor.stop()
  })

  it('ignores a transport failure report while an attempt is in flight', async () => {
    let resolveConnect!: (lease: RendererConnectionLease) => void
    const connect = vi.fn<() => Promise<RendererConnectionLease>>(
      () =>
        new Promise<RendererConnectionLease>((resolve) => {
          resolveConnect = resolve
        })
    )
    const supervisor = new RendererConnectionSupervisor(connect, () =>
      Date.now()
    )
    supervisor.start()
    await flush()
    expect(supervisor.getSnapshot()).toMatchObject({ phase: 'connecting' })

    supervisor.notifyTransportFailure()
    await flush()
    expect(supervisor.getSnapshot()).toMatchObject({ phase: 'connecting' })

    const lease = deferredLease()
    resolveConnect(lease)
    await flush()
    expect(supervisor.getSnapshot()).toMatchObject({
      generation: 0,
      phase: 'connected',
      session: 1,
    })
    expect(connect).toHaveBeenCalledTimes(1)
    supervisor.stop()
  })

  it('keeps manual retry immediate after a transport failure', async () => {
    const first = deferredLease()
    const second = deferredLease()
    const connect = vi
      .fn<() => Promise<RendererConnectionLease>>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
    const supervisor = new RendererConnectionSupervisor(connect, () =>
      Date.now()
    )
    supervisor.start()
    await flush()

    supervisor.notifyTransportFailure()
    await flush()
    expect(supervisor.getSnapshot()).toMatchObject({ phase: 'backoff' })

    supervisor.retryNow()
    await flush()
    expect(connect).toHaveBeenCalledTimes(2)
    expect(supervisor.getSnapshot()).toMatchObject({
      attempt: 1,
      generation: 1,
      phase: 'connected',
      session: 2,
    })
    supervisor.stop()
  })

  it('enters a terminal blocked state when production ensure is exhausted', async () => {
    const supervisor = new RendererConnectionSupervisor(() =>
      Promise.reject(new RendererConnectionBlockedError())
    )
    supervisor.start()
    await flush()

    expect(supervisor.getSnapshot()).toMatchObject({
      phase: 'blocked',
      retryAt: null,
    })
  })
})
