import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  RENDERER_RECONNECT_DELAYS_MS,
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

  it('publishes sessions and advances generation on every reconnect', async () => {
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
      generation: 1,
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
      generation: 2,
      phase: 'connected',
      session: 2,
    })
    supervisor.stop()
  })

  it('manual reconnect interrupts backoff and resets the ladder', async () => {
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
    })
    supervisor.stop()
  })
})
