import { describe, expect, it, vi } from 'vitest'
import {
  DaemonPowerStatePusher,
  powerStateFromBattery,
} from '../src/daemon-power-state.js'

const flushQueue = async (): Promise<void> => {
  // The pusher serializes sends through an internal promise chain; a few
  // microtask turns are enough to drain synchronous test senders.
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve()
  }
}

describe('powerStateFromBattery', () => {
  it('maps battery power to battery and mains to ac', () => {
    expect(powerStateFromBattery(true)).toBe('battery')
    expect(powerStateFromBattery(false)).toBe('ac')
  })
})

describe('DaemonPowerStatePusher', () => {
  it('sends the first observed power state', async () => {
    const send = vi.fn(async () => true)
    const pusher = new DaemonPowerStatePusher(send)

    pusher.update('ac')
    await flushQueue()

    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('ac')
  })

  it('dedupes repeated identical power events', async () => {
    const send = vi.fn(async () => true)
    const pusher = new DaemonPowerStatePusher(send)

    pusher.update('battery')
    await flushQueue()
    pusher.update('battery')
    pusher.update('battery')
    await flushQueue()

    expect(send).toHaveBeenCalledTimes(1)
  })

  it('sends again when the state actually changes', async () => {
    const send = vi.fn(async () => true)
    const pusher = new DaemonPowerStatePusher(send)

    pusher.update('battery')
    await flushQueue()
    pusher.update('ac')
    await flushQueue()

    expect(send.mock.calls).toEqual([['battery'], ['ac']])
  })

  it('repush resends the current state even when already delivered', async () => {
    const send = vi.fn(async () => true)
    const pusher = new DaemonPowerStatePusher(send)

    pusher.update('ac')
    await flushQueue()
    pusher.repush()
    await flushQueue()

    expect(send.mock.calls).toEqual([['ac'], ['ac']])
  })

  it('repush before any power state is known does nothing', async () => {
    const send = vi.fn(async () => true)
    const pusher = new DaemonPowerStatePusher(send)

    pusher.repush()
    await flushQueue()

    expect(send).not.toHaveBeenCalled()
  })

  it('retries after a failed send instead of deduping it away', async () => {
    const results = [false, true]
    const send = vi.fn(async () => results.shift() ?? true)
    const pusher = new DaemonPowerStatePusher(send)

    pusher.update('ac')
    await flushQueue()
    expect(send).toHaveBeenCalledTimes(1)

    // The failed delivery is not recorded, so the same state sends again.
    pusher.update('ac')
    await flushQueue()
    expect(send).toHaveBeenCalledTimes(2)

    // Once delivered, the same state dedupes again.
    pusher.update('ac')
    await flushQueue()
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('treats a throwing sender as a failed send', async () => {
    let shouldThrow = true
    const send = vi.fn((): Promise<boolean> => {
      if (shouldThrow) {
        return Promise.reject(new Error('daemon unreachable'))
      }
      return Promise.resolve(true)
    })
    const pusher = new DaemonPowerStatePusher(send)

    pusher.update('battery')
    await flushQueue()
    shouldThrow = false
    pusher.repush()
    await flushQueue()
    pusher.update('battery')
    await flushQueue()

    expect(send).toHaveBeenCalledTimes(2)
  })

  it('collapses rapid transitions to the latest state, in order', async () => {
    const sent: string[] = []
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const send = vi.fn(async (state: string) => {
      sent.push(state)
      if (sent.length === 1) {
        await gate
      }
      return true
    })
    const pusher = new DaemonPowerStatePusher(send)

    pusher.update('ac')
    await Promise.resolve()
    // While the first send is in flight, the state flips twice.
    pusher.update('battery')
    pusher.update('ac')
    release?.()
    await flushQueue()

    // The queued send reads the latest state; since 'ac' was already
    // delivered by the first send, nothing more goes out.
    expect(sent).toEqual(['ac'])

    pusher.update('battery')
    await flushQueue()
    expect(sent).toEqual(['ac', 'battery'])
  })
})
